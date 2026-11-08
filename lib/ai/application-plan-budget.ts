import { createHash } from "node:crypto";

import { Prisma } from "@prisma/client";

import {
  DEFAULT_AUTOMATION_BUDGET_CENTS,
  DEFAULT_MAX_ANALYSES_PER_SYNC,
  DEFAULT_MONTHLY_BUDGET_CENTS
} from "@/lib/ai/budget-defaults";
import { getAiFinancialPolicy } from "@/lib/ai/config";
import { PublicApiError } from "@/lib/api-errors";
import { createOrReadExisting, isUniqueConstraintViolation } from "@/lib/create-or-read-existing";
export { hashAiInput } from "@/lib/ai/input-hash";
import { prisma } from "@/lib/prisma";

export function monthWindow(now = new Date()) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start, end };
}

// A new user's first page load can ask for these settings more than once at the same time; the
// slower request returns the row the first one created, never overwriting it.
export async function getOrCreateAiSettings(userId: string) {
  return createOrReadExisting(
    () =>
      prisma.aISettings.upsert({
        where: { userId },
        create: {
          userId,
          monthlyBudgetCents: DEFAULT_MONTHLY_BUDGET_CENTS,
          automationBudgetCents: DEFAULT_AUTOMATION_BUDGET_CENTS,
          maxAnalysesPerSync: DEFAULT_MAX_ANALYSES_PER_SYNC
        },
        update: {}
      }),
    () => prisma.aISettings.findUniqueOrThrow({ where: { userId } })
  );
}

function effectiveBudgetMicros(settings: {
  monthlyBudgetCents: number;
  automationBudgetCents: number;
}) {
  const policy = getAiFinancialPolicy();
  const budgetCents = Math.min(settings.monthlyBudgetCents, policy.hardCapCents);
  const automationBudgetCents = Math.min(
    settings.automationBudgetCents,
    budgetCents,
    policy.automationCapCents
  );
  return {
    budgetMicros: budgetCents * 10_000,
    automationBudgetMicros: automationBudgetCents * 10_000
  };
}

async function ensureMonthlyLedger(userId: string, now = new Date()) {
  const settings = await getOrCreateAiSettings(userId);
  const { start } = monthWindow(now);
  const limits = effectiveBudgetMicros(settings);
  const where = { userId_monthStart: { userId, monthStart: start } };
  const ledger = await createOrReadExisting(
    () =>
      prisma.aIBudgetLedger.upsert({
        where,
        create: {
          userId,
          monthStart: start,
          ...limits,
          remainingMicros: limits.budgetMicros,
          automationRemainingMicros: limits.automationBudgetMicros
        },
        update: {}
      }),
    () => prisma.aIBudgetLedger.findUniqueOrThrow({ where })
  );

  return { ledger, settings, limits };
}

export async function getMonthlyAiUsage(userId: string, now = new Date()) {
  await reconcileStaleAiReservations(userId, now);
  const { start, end } = monthWindow(now);
  const [{ ledger, settings, limits }, aggregate, requestCount] = await Promise.all([
    ensureMonthlyLedger(userId, now),
    prisma.aIUsageEvent.aggregate({
      where: { userId, createdAt: { gte: start, lt: end } },
      _sum: { inputTokens: true, outputTokens: true, cachedInputTokens: true }
    }),
    prisma.aIUsageEvent.count({ where: { userId, createdAt: { gte: start, lt: end } } })
  ]);
  const percentUsed = limits.budgetMicros
    ? Math.min(100, Math.round((ledger.spentMicros / limits.budgetMicros) * 100))
    : 100;
  const warningLevel = percentUsed >= 90 ? 90 : percentUsed >= 75 ? 75 : percentUsed >= 50 ? 50 : null;
  const remainingMicros = Math.max(0, limits.budgetMicros - ledger.spentMicros - ledger.reservedMicros);
  const automationRemainingMicros = Math.max(
    0,
    limits.automationBudgetMicros - ledger.automationSpentMicros - ledger.automationReservedMicros
  );

  return {
    start,
    end,
    requestCount,
    inputTokens: aggregate._sum.inputTokens ?? 0,
    outputTokens: aggregate._sum.outputTokens ?? 0,
    cachedInputTokens: aggregate._sum.cachedInputTokens ?? 0,
    estimatedCostMicros: ledger.spentMicros,
    reservedMicros: ledger.reservedMicros,
    remainingMicros,
    budgetMicros: limits.budgetMicros,
    automationSpentMicros: ledger.automationSpentMicros,
    automationReservedMicros: ledger.automationReservedMicros,
    automationRemainingMicros,
    automationBudgetMicros: limits.automationBudgetMicros,
    percentUsed,
    warningLevel,
    settings
  };
}

export async function findCachedAiResponse(input: {
  userId: string;
  provider: string;
  model: string;
  promptName: string;
  promptVersion: string;
  requestHash: string;
}) {
  return prisma.aIResponseCache.findFirst({
    where: {
      ...input,
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }]
    }
  });
}

export type AiBudgetReservationInput = {
  userId: string;
  provider: string;
  model: string;
  feature: string;
  promptName: string;
  promptVersion: string;
  requestHash: string;
  maximumCostMicros: number;
  automation: boolean;
};

// A simultaneous request created this month's ledger first. PostgreSQL has aborted the
// reservation transaction by then, so the reservation runs again and finds that ledger.
class LedgerCreatedConcurrently extends Error {}

export async function reserveAiBudget(input: AiBudgetReservationInput) {
  await reconcileStaleAiReservations(input.userId);
  const settings = await getOrCreateAiSettings(input.userId);
  const limits = effectiveBudgetMicros(settings);
  const { start } = monthWindow();
  const dedupeKey = createHash("sha256")
    .update(
      `${input.userId}:${input.provider}:${input.model}:${input.promptName}:${input.promptVersion}:${input.requestHash}`
    )
    .digest("hex");

  const reserve = () =>
    prisma.$transaction(async (tx) => {
      const ledger = await tx.aIBudgetLedger
        .upsert({
          where: { userId_monthStart: { userId: input.userId, monthStart: start } },
          create: {
            userId: input.userId,
            monthStart: start,
            ...limits,
            remainingMicros: limits.budgetMicros,
            automationRemainingMicros: limits.automationBudgetMicros
          },
          update: {}
        })
        .catch((error: unknown) => {
          throw isUniqueConstraintViolation(error) ? new LedgerCreatedConcurrently() : error;
        });

      await tx.$executeRaw(Prisma.sql`
        UPDATE "AIBudgetLedger"
        SET "budgetMicros" = ${limits.budgetMicros},
            "remainingMicros" = GREATEST(0, ${limits.budgetMicros} - "spentMicros" - "reservedMicros"),
            "automationBudgetMicros" = ${limits.automationBudgetMicros},
            "automationRemainingMicros" = GREATEST(
              0,
              ${limits.automationBudgetMicros} - "automationSpentMicros" - "automationReservedMicros"
            ),
            "updatedAt" = CURRENT_TIMESTAMP
        WHERE "id" = ${ledger.id}
      `);

      const reserved = await tx.aIBudgetLedger.updateMany({
        where: {
          id: ledger.id,
          remainingMicros: { gte: input.maximumCostMicros },
          ...(input.automation
            ? { automationRemainingMicros: { gte: input.maximumCostMicros } }
            : {})
        },
        data: {
          remainingMicros: { decrement: input.maximumCostMicros },
          reservedMicros: { increment: input.maximumCostMicros },
          ...(input.automation
            ? {
                automationRemainingMicros: { decrement: input.maximumCostMicros },
                automationReservedMicros: { increment: input.maximumCostMicros }
              }
            : {})
        }
      });

      if (reserved.count !== 1) {
        throw new PublicApiError(
          input.automation
            ? "This automated analysis would exceed the monthly automation AI allowance."
            : "This request would exceed your monthly AI budget.",
          429,
          { code: "AI_BUDGET_EXCEEDED" }
        );
      }

      return tx.aIBudgetReservation.create({
        data: {
          ...input,
          ledgerId: ledger.id,
          dedupeKey,
          status: "RESERVED"
        }
      });
    });

  try {
    return await reserve().catch((error: unknown) => {
      if (error instanceof LedgerCreatedConcurrently) return reserve();
      throw error;
    });
  } catch (error) {
    // The reservation's dedupe key: the same request is already reserved and running.
    if (isUniqueConstraintViolation(error)) {
      throw new PublicApiError("An identical AI request is already running. Wait for it to finish and try again.", 409, {
        code: "AI_DUPLICATE_IN_PROGRESS"
      });
    }
    throw error;
  }
}

export async function reconcileAiReservation(input: {
  reservationId: string;
  actualCostMicros?: number;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  status: "SUCCEEDED" | "FAILED" | "UNCERTAIN";
  errorCode?: string;
  cacheOutput?: unknown;
}) {
  return prisma.$transaction(async (tx) => {
    const reservation = await tx.aIBudgetReservation.findUniqueOrThrow({
      where: { id: input.reservationId }
    });
    if (reservation.status !== "RESERVED") return reservation;

    if (
      input.status !== "UNCERTAIN" &&
      Math.max(0, input.actualCostMicros ?? 0) > reservation.maximumCostMicros
    ) {
      throw new PublicApiError("Reported AI usage exceeds the amount reserved for this request.", 503, {
        code: "AI_PROVIDER_USAGE_EXCEEDED_RESERVATION"
      });
    }

    const actualCostMicros =
      input.status === "UNCERTAIN"
        ? reservation.maximumCostMicros
        : Math.max(0, input.actualCostMicros ?? 0);
    const refundMicros = reservation.maximumCostMicros - actualCostMicros;
    const automationUpdate = reservation.automation
      ? Prisma.sql`,
          "automationReservedMicros" = GREATEST(0, "automationReservedMicros" - ${reservation.maximumCostMicros}),
          "automationSpentMicros" = "automationSpentMicros" + ${actualCostMicros},
          "automationRemainingMicros" = GREATEST(0, "automationRemainingMicros" + ${refundMicros})`
      : Prisma.empty;

    await tx.$executeRaw(Prisma.sql`
      UPDATE "AIBudgetLedger"
      SET "reservedMicros" = GREATEST(0, "reservedMicros" - ${reservation.maximumCostMicros}),
          "spentMicros" = "spentMicros" + ${actualCostMicros},
          "remainingMicros" = GREATEST(0, "remainingMicros" + ${refundMicros})
          ${automationUpdate},
          "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = ${reservation.ledgerId}
    `);

    const reconciled = await tx.aIBudgetReservation.update({
      where: { id: reservation.id },
      data: {
        actualCostMicros,
        status: input.status,
        errorCode: input.errorCode,
        dedupeKey: null,
        reconciledAt: new Date()
      }
    });

    await tx.aIUsageEvent.create({
      data: {
        userId: reservation.userId,
        reservationId: reservation.id,
        provider: reservation.provider,
        feature: reservation.feature,
        model: reservation.model,
        promptName: reservation.promptName,
        promptVersion: reservation.promptVersion,
        inputTokens: input.inputTokens ?? 0,
        outputTokens: input.outputTokens ?? 0,
        cachedInputTokens: input.cachedInputTokens ?? 0,
        estimatedCostMicros: actualCostMicros,
        requestHash: reservation.requestHash,
        status: input.status,
        automation: reservation.automation,
        errorCode: input.errorCode
      }
    });

    if (input.status === "SUCCEEDED" && input.cacheOutput !== undefined) {
      await tx.aIResponseCache.upsert({
        where: {
          userId_provider_model_promptName_promptVersion_requestHash: {
            userId: reservation.userId,
            provider: reservation.provider,
            model: reservation.model,
            promptName: reservation.promptName,
            promptVersion: reservation.promptVersion,
            requestHash: reservation.requestHash
          }
        },
        create: {
          userId: reservation.userId,
          provider: reservation.provider,
          model: reservation.model,
          promptName: reservation.promptName,
          promptVersion: reservation.promptVersion,
          requestHash: reservation.requestHash,
          output: input.cacheOutput as Prisma.InputJsonValue
        },
        update: {
          output: input.cacheOutput as Prisma.InputJsonValue,
          expiresAt: null
        }
      });
    }

    return reconciled;
  });
}

export async function reconcileStaleAiReservations(userId: string, now = new Date()) {
  const staleBefore = new Date(now.getTime() - 15 * 60_000);
  const stale = await prisma.aIBudgetReservation.findMany({
    where: { userId, status: "RESERVED", createdAt: { lt: staleBefore } },
    select: { id: true }
  });

  for (const reservation of stale) {
    await reconcileAiReservation({
      reservationId: reservation.id,
      status: "UNCERTAIN",
      errorCode: "STALE_RESERVATION"
    });
  }

  return stale.length;
}
