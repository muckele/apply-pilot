import { PublicApiError } from "@/lib/api-errors";

export type AiProviderName = "gemini" | "openai" | "kimi";

export const AI_PROVIDER_NAMES: readonly AiProviderName[] = ["gemini", "openai", "kimi"];

export type ModelPricing = {
  provider: AiProviderName;
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  cachedInputUsdPerMillion?: number;
  validFrom?: string;
  validUntil?: string;
};

// Keep this registry explicit. Paid calls fail closed when a selected model is absent.
// Standard, real-time Gemini prices: https://ai.google.dev/gemini-api/docs/pricing
// Do not use lower batch or flex prices for synchronous application requests.
// Kimi K3 standard real-time prices: https://platform.kimi.ai/docs/pricing (verified 2026-08-15).
// Kimi output billing includes reasoning tokens. Never register deprecated K2 preview models.
// Pricing changes require an intentional code update here; environment variables cannot raise them.
export const MODEL_PRICING_REGISTRY: Record<string, ModelPricing> = {
  "gemini-3.8-flash": {
    provider: "gemini",
    inputUsdPerMillion: 0.75,
    outputUsdPerMillion: 3.75,
    cachedInputUsdPerMillion: 0.075,
    validFrom: "2026-10-01T00:00:00.000Z",
    validUntil: "2027-01-01T00:00:00.000Z"
  },
  "gemini-3.1-flash-lite": {
    provider: "gemini",
    inputUsdPerMillion: 0.25,
    outputUsdPerMillion: 1.5
  },
  "gemini-3.5-flash-lite": {
    provider: "gemini",
    inputUsdPerMillion: 0.3,
    outputUsdPerMillion: 2.5
  },
  "gemini-3.5-flash": {
    provider: "gemini",
    inputUsdPerMillion: 1.5,
    outputUsdPerMillion: 9,
    cachedInputUsdPerMillion: 0.15
  },
  "gpt-4o-mini": {
    provider: "openai",
    inputUsdPerMillion: 0.15,
    outputUsdPerMillion: 0.6,
    cachedInputUsdPerMillion: 0.075
  },
  "kimi-k3": {
    provider: "kimi",
    inputUsdPerMillion: 3,
    cachedInputUsdPerMillion: 0.3,
    outputUsdPerMillion: 15
  }
};

export function getModelPricing(model: string, now = new Date()) {
  const pricing = MODEL_PRICING_REGISTRY[model];
  if (!pricing) {
    throw new PublicApiError(
      `AI pricing is not registered for model ${model}. Paid requests are disabled for unrecognized models.`,
      503,
      { code: "AI_MODEL_PRICING_UNKNOWN" }
    );
  }
  if (pricing.validFrom && now < new Date(pricing.validFrom)) {
    throw new PublicApiError(
      `AI pricing for model ${model} is not yet effective. Paid requests are disabled.`,
      503,
      { code: "AI_MODEL_PRICING_NOT_EFFECTIVE" }
    );
  }
  if (pricing.validUntil && now >= new Date(pricing.validUntil)) {
    throw new PublicApiError(
      `AI pricing for model ${model} has expired. Paid requests are disabled until pricing is reviewed.`,
      503,
      { code: "AI_MODEL_PRICING_EXPIRED" }
    );
  }
  return pricing;
}

export function estimateAiCostMicros({
  model,
  inputTokens,
  outputTokens,
  cachedInputTokens = 0,
  now
}: {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  now?: Date;
}) {
  const pricing = getModelPricing(model, now);
  const cachedTokens = Math.min(inputTokens, Math.max(0, cachedInputTokens));
  const uncachedTokens = Math.max(0, inputTokens - cachedTokens);
  const cachedPrice = pricing.cachedInputUsdPerMillion ?? pricing.inputUsdPerMillion;

  // A token at a per-million-token USD price is the same numeric number of microdollars.
  return Math.max(
    0,
    Math.ceil(
      uncachedTokens * pricing.inputUsdPerMillion +
        cachedTokens * cachedPrice +
        outputTokens * pricing.outputUsdPerMillion
    )
  );
}
