import assert from "node:assert/strict";
import { after, test, type TestContext } from "node:test";

import { Prisma } from "@prisma/client";

// A new user's first page load can create the same per-user row twice at once (the AI settings
// page alone asks for AI settings twice in parallel). Prisma's upsert is a read then a create, so
// the slower create fails with a unique-constraint error (P2002). These tests fake that loss and
// check that the loser reads the winner's row instead of failing, and never overwrites it.

const priorDatabaseUrl = process.env.DATABASE_URL;
const priorDirectUrl = process.env.DIRECT_URL;
process.env.DATABASE_URL = "postgresql://invalid:invalid@127.0.0.1:1/invalid";
process.env.DIRECT_URL = "postgresql://invalid:invalid@127.0.0.1:1/invalid";
after(() => {
  if (priorDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = priorDatabaseUrl;
  if (priorDirectUrl === undefined) delete process.env.DIRECT_URL;
  else process.env.DIRECT_URL = priorDirectUrl;
});

const userId = "synthetic-first-visit-user";

function prismaError(code: string) {
  return new Prisma.PrismaClientKnownRequestError("synthetic", {
    code,
    clientVersion: Prisma.prismaVersion.client
  });
}

function stub(t: TestContext, owner: object, name: string, replacement: unknown) {
  const methods = owner as Record<string, unknown>;
  const original = methods[name];
  methods[name] = replacement;
  t.after(() => {
    methods[name] = original;
  });
}

const existingSettings = {
  id: "settings-winner",
  userId,
  monthlyBudgetCents: 1234,
  automationBudgetCents: 100,
  maxAnalysesPerSync: 3,
  aiDiscoveryEnabled: true,
  modelOverride: null
};

test("a second first visit returns the AI settings the first visit created instead of failing", async (t) => {
  const { prisma } = await import("@/lib/prisma");
  const { getOrCreateAiSettings } = await import("@/lib/ai/application-plan-budget");
  const upserts: Array<{ update: unknown }> = [];
  const reads: unknown[] = [];
  let updates = 0;
  stub(t, prisma.aISettings, "upsert", async (args: { update: unknown }) => {
    upserts.push(args);
    throw prismaError("P2002");
  });
  stub(t, prisma.aISettings, "findUniqueOrThrow", async (args: unknown) => {
    reads.push(args);
    return existingSettings;
  });
  stub(t, prisma.aISettings, "update", async () => {
    updates += 1;
    return existingSettings;
  });

  const settings = await getOrCreateAiSettings(userId);

  assert.deepEqual(settings, existingSettings);
  assert.deepEqual(reads, [{ where: { userId } }]);
  // The user's chosen budget survives: the create never updates, and the fallback only reads.
  assert.deepEqual(upserts.map((args) => args.update), [{}]);
  assert.equal(updates, 0);
});

test("other database errors from AI settings creation still surface", async (t) => {
  const { prisma } = await import("@/lib/prisma");
  const { getOrCreateAiSettings } = await import("@/lib/ai/application-plan-budget");
  const unavailable = prismaError("P1001");
  let reads = 0;
  stub(t, prisma.aISettings, "upsert", async () => {
    throw unavailable;
  });
  stub(t, prisma.aISettings, "findUniqueOrThrow", async () => {
    reads += 1;
    return existingSettings;
  });

  await assert.rejects(getOrCreateAiSettings(userId), (error) => error === unavailable);
  assert.equal(reads, 0);
});

test("a second first visit in a month reads the budget ledger the first visit created instead of failing", async (t) => {
  const { prisma } = await import("@/lib/prisma");
  const { getMonthlyAiUsage, monthWindow } = await import("@/lib/ai/application-plan-budget");
  const now = new Date("2026-11-07T12:00:00.000Z");
  const { start } = monthWindow(now);
  const existingLedger = {
    id: "ledger-winner",
    userId,
    monthStart: start,
    budgetMicros: 5_000_000,
    remainingMicros: 4_000_000,
    spentMicros: 1_000_000,
    reservedMicros: 0,
    automationBudgetMicros: 1_000_000,
    automationRemainingMicros: 1_000_000,
    automationSpentMicros: 0,
    automationReservedMicros: 0
  };
  const ledgerReads: unknown[] = [];
  stub(t, prisma.aIBudgetReservation, "findMany", async () => []);
  stub(t, prisma.aISettings, "upsert", async () => existingSettings);
  stub(t, prisma.aIBudgetLedger, "upsert", async () => {
    throw prismaError("P2002");
  });
  stub(t, prisma.aIBudgetLedger, "findUniqueOrThrow", async (args: unknown) => {
    ledgerReads.push(args);
    return existingLedger;
  });
  stub(t, prisma.aIUsageEvent, "aggregate", async () => ({
    _sum: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 }
  }));
  stub(t, prisma.aIUsageEvent, "count", async () => 0);

  const usage = await getMonthlyAiUsage(userId, now);

  assert.equal(usage.estimatedCostMicros, existingLedger.spentMicros);
  assert.deepEqual(ledgerReads, [{ where: { userId_monthStart: { userId, monthStart: start } } }]);
});

function reservationTransactionFake(options: { ledgerConflicts: number; reservationConflict?: boolean }) {
  let ledgerConflictsLeft = options.ledgerConflicts;
  let transactions = 0;
  const tx = {
    aIBudgetLedger: {
      upsert: async () => {
        if (ledgerConflictsLeft > 0) {
          ledgerConflictsLeft -= 1;
          throw prismaError("P2002");
        }
        return { id: "ledger-winner" };
      },
      updateMany: async () => ({ count: 1 })
    },
    aIBudgetReservation: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        if (options.reservationConflict) throw prismaError("P2002");
        return { id: "reservation-1", status: "RESERVED", ...data };
      }
    },
    $executeRaw: async () => 1
  };
  return {
    transaction: async (callback: (transaction: typeof tx) => unknown) => {
      transactions += 1;
      return callback(tx);
    },
    transactions: () => transactions
  };
}

const reservationInput = {
  userId,
  provider: "gemini",
  model: "gemini-synthetic",
  feature: "JOB_MATCH",
  promptName: "synthetic-prompt",
  promptVersion: "v1",
  requestHash: "synthetic-request-hash",
  maximumCostMicros: 10_000,
  automation: false
};

test("two first AI requests in a month both reserve instead of one being told an identical request is running", async (t) => {
  const { prisma } = await import("@/lib/prisma");
  const { reserveAiBudget } = await import("@/lib/ai/application-plan-budget");
  const fake = reservationTransactionFake({ ledgerConflicts: 1 });
  stub(t, prisma.aIBudgetReservation, "findMany", async () => []);
  stub(t, prisma.aISettings, "upsert", async () => existingSettings);
  stub(t, prisma, "$transaction", fake.transaction);

  const reservation = await reserveAiBudget(reservationInput);

  assert.equal(reservation.ledgerId, "ledger-winner");
  assert.equal(reservation.status, "RESERVED");
  // PostgreSQL aborts the whole transaction on the lost create, so the reservation runs again.
  assert.equal(fake.transactions(), 2);
});

test("an identical AI request already in flight is still refused, without a retry", async (t) => {
  const { prisma } = await import("@/lib/prisma");
  const { reserveAiBudget } = await import("@/lib/ai/application-plan-budget");
  const fake = reservationTransactionFake({ ledgerConflicts: 0, reservationConflict: true });
  stub(t, prisma.aIBudgetReservation, "findMany", async () => []);
  stub(t, prisma.aISettings, "upsert", async () => existingSettings);
  stub(t, prisma, "$transaction", fake.transaction);

  await assert.rejects(
    reserveAiBudget(reservationInput),
    (error: unknown) =>
      error instanceof Error &&
      (error as { status?: unknown }).status === 409 &&
      (error as { details?: { code?: unknown } }).details?.code === "AI_DUPLICATE_IN_PROGRESS"
  );
  assert.equal(fake.transactions(), 1);
});
