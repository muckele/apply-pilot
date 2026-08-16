import { PublicApiError } from "@/lib/api-errors";

export type AiProviderName = "gemini" | "openai";

export type ModelPricing = {
  provider: AiProviderName;
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  cachedInputUsdPerMillion?: number;
};

// Keep this registry explicit. Paid calls fail closed when a selected model is absent.
// Standard, real-time Gemini prices: https://ai.google.dev/gemini-api/docs/pricing
// Do not use lower batch or flex prices for synchronous application requests.
export const MODEL_PRICING_REGISTRY: Record<string, ModelPricing> = {
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
  }
};

export function getModelPricing(model: string) {
  const pricing = MODEL_PRICING_REGISTRY[model];
  if (!pricing) {
    throw new PublicApiError(
      `AI pricing is not registered for model ${model}. Paid requests are disabled for unrecognized models.`,
      503,
      { code: "AI_MODEL_PRICING_UNKNOWN" }
    );
  }
  return pricing;
}

export function estimateAiCostMicros({
  model,
  inputTokens,
  outputTokens,
  cachedInputTokens = 0
}: {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
}) {
  const pricing = getModelPricing(model);
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
