import { createHash } from "node:crypto";

import { PublicApiError } from "@/lib/api-errors";
import { prisma } from "@/lib/prisma";

const DEFAULT_MONTHLY_BUDGET_CENTS = 1000;
const DEFAULT_MAX_ANALYSES_PER_SYNC = 5;

function monthWindow(now = new Date()) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start, end };
}

function readNonNegativeNumber(name: string) {
  const value = process.env[name];
  if (!value) return null;

  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export function hashAiInput(promptName: string, promptVersion: string, payload: unknown) {
  return createHash("sha256")
    .update(`${promptName}:${promptVersion}:${JSON.stringify(payload)}`)
    .digest("hex");
}

export function estimateAiCostMicros({
  inputTokens,
  outputTokens,
  cachedInputTokens
}: {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
}) {
  const inputPrice = readNonNegativeNumber("OPENAI_INPUT_COST_PER_1M_USD");
  const outputPrice = readNonNegativeNumber("OPENAI_OUTPUT_COST_PER_1M_USD");
  const cachedInputPrice = readNonNegativeNumber("OPENAI_CACHED_INPUT_COST_PER_1M_USD");

  if (inputPrice === null || outputPrice === null) {
    return null;
  }

  const cachedTokens = Math.min(inputTokens, Math.max(0, cachedInputTokens));
  const uncachedTokens = Math.max(0, inputTokens - cachedTokens);
  const cachedPrice = cachedInputPrice ?? inputPrice;

  // One token at a per-million-token USD price equals that many microdollars.
  return Math.max(
    0,
    Math.round(uncachedTokens * inputPrice + cachedTokens * cachedPrice + outputTokens * outputPrice)
  );
}

export async function getOrCreateAiSettings(userId: string) {
  return prisma.aISettings.upsert({
    where: { userId },
    create: {
      userId,
      monthlyBudgetCents: DEFAULT_MONTHLY_BUDGET_CENTS,
      maxAnalysesPerSync: DEFAULT_MAX_ANALYSES_PER_SYNC
    },
    update: {}
  });
}

export async function getMonthlyAiUsage(userId: string, now = new Date()) {
  const { start, end } = monthWindow(now);
  const [aggregate, requestCount] = await Promise.all([
    prisma.aIUsageEvent.aggregate({
      where: {
        userId,
        createdAt: { gte: start, lt: end }
      },
      _sum: {
        inputTokens: true,
        outputTokens: true,
        cachedInputTokens: true,
        estimatedCostMicros: true
      }
    }),
    prisma.aIUsageEvent.count({
      where: {
        userId,
        createdAt: { gte: start, lt: end }
      }
    })
  ]);

  return {
    start,
    end,
    requestCount,
    inputTokens: aggregate._sum.inputTokens ?? 0,
    outputTokens: aggregate._sum.outputTokens ?? 0,
    cachedInputTokens: aggregate._sum.cachedInputTokens ?? 0,
    estimatedCostMicros: aggregate._sum.estimatedCostMicros ?? null
  };
}

export async function assertAiBudgetAvailable(userId: string) {
  const [settings, usage] = await Promise.all([getOrCreateAiSettings(userId), getMonthlyAiUsage(userId)]);
  const budgetMicros = settings.monthlyBudgetCents * 10_000;

  if (usage.estimatedCostMicros !== null && usage.estimatedCostMicros >= budgetMicros) {
    throw new PublicApiError(
      "Your monthly AI budget has been reached. Increase it in AI settings or wait until next month.",
      429
    );
  }

  return { settings, usage };
}

export async function recordAiUsage(input: {
  userId: string;
  feature: string;
  model: string;
  promptName: string;
  promptVersion: string;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  estimatedCostMicros?: number | null;
  requestHash?: string;
  status: "SUCCEEDED" | "FAILED";
  errorCode?: string;
}) {
  return prisma.aIUsageEvent.create({
    data: {
      userId: input.userId,
      feature: input.feature,
      model: input.model,
      promptName: input.promptName,
      promptVersion: input.promptVersion,
      inputTokens: input.inputTokens ?? 0,
      outputTokens: input.outputTokens ?? 0,
      cachedInputTokens: input.cachedInputTokens ?? 0,
      estimatedCostMicros: input.estimatedCostMicros,
      requestHash: input.requestHash,
      status: input.status,
      errorCode: input.errorCode
    }
  });
}
