import { PublicApiError } from "@/lib/api-errors";

// Gemini is the single MVP AI provider (decision D029). OpenAI and Kimi are retired.
export type AiProviderName = "gemini";

export const AI_PROVIDER_NAMES: readonly AiProviderName[] = ["gemini"];

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

export const AI_PRICING_EXPIRY_WARNING_DAYS = 60;

export type AiPricingStatus = {
  model: string;
  provider: AiProviderName;
  validFrom: string | null;
  validUntil: string | null;
  status: "current" | "expiring_soon" | "expired" | "not_yet_effective" | "open_ended";
  daysRemaining: number | null;
};

const DAY_MS = 24 * 60 * 60 * 1000;

// Reports registered price windows so the expiry is visible before paid requests fail
// closed. It never extends a window; changing a price requires an intentional code update.
export function getAiPricingStatus(now = new Date()): AiPricingStatus[] {
  return Object.entries(MODEL_PRICING_REGISTRY).map(([model, pricing]) => {
    const validFrom = pricing.validFrom ?? null;
    const validUntil = pricing.validUntil ?? null;
    if (validFrom && now < new Date(validFrom)) {
      return { model, provider: pricing.provider, validFrom, validUntil, status: "not_yet_effective", daysRemaining: null };
    }
    if (!validUntil) {
      return { model, provider: pricing.provider, validFrom, validUntil, status: "open_ended", daysRemaining: null };
    }
    const daysRemaining = Math.max(0, Math.ceil((new Date(validUntil).getTime() - now.getTime()) / DAY_MS));
    const status = now >= new Date(validUntil)
      ? "expired"
      : daysRemaining <= AI_PRICING_EXPIRY_WARNING_DAYS ? "expiring_soon" : "current";
    return { model, provider: pricing.provider, validFrom, validUntil, status, daysRemaining };
  });
}
