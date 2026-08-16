import type { AISettings } from "@prisma/client";

import { AI_FEATURE_POLICIES, type AiFeature } from "@/lib/ai/policy";
import { MODEL_PRICING_REGISTRY, type AiProviderName } from "@/lib/ai/pricing";
import { PublicApiError } from "@/lib/api-errors";

const DEFAULT_FAST_MODEL = "gemini-3.5-flash-lite";
const DEFAULT_QUALITY_MODEL = "gemini-3.5-flash-lite";

function readPositiveInteger(name: string, fallback: number) {
  const parsed = Number(process.env[name]);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function getAiFinancialPolicy() {
  return {
    hardCapCents: Math.min(500, readPositiveInteger("AI_HARD_CAP_CENTS", 500)),
    automationCapCents: Math.min(150, readPositiveInteger("AI_AUTOMATION_CAP_CENTS", 150)),
    maximumRequestCents: Math.min(10, readPositiveInteger("AI_MAX_REQUEST_COST_CENTS", 10)),
    confirmationThresholdCents: Math.min(5, readPositiveInteger("AI_CONFIRMATION_THRESHOLD_CENTS", 5))
  };
}

export function getAiProviderName(): AiProviderName {
  const provider = process.env.AI_PROVIDER?.trim() || "gemini";
  if (provider !== "gemini" && provider !== "openai") {
    throw new PublicApiError(`Unsupported AI provider: ${provider}.`, 503, {
      code: "AI_PROVIDER_UNKNOWN"
    });
  }
  return provider;
}

function defaultModelForTier(tier: "fast" | "quality", provider = getAiProviderName()) {
  if (provider === "openai") {
    return process.env.OPENAI_MODEL?.trim() || "gpt-4o-mini";
  }
  return tier === "fast"
    ? process.env.GEMINI_FAST_MODEL?.trim() || DEFAULT_FAST_MODEL
    : process.env.GEMINI_QUALITY_MODEL?.trim() || DEFAULT_QUALITY_MODEL;
}

export function getAllowedAiModels() {
  const provider = getAiProviderName();
  const configured = (process.env.AI_ALLOWED_MODELS ?? process.env.OPENAI_ALLOWED_MODELS ?? "")
    .split(",")
    .map((model) => model.trim())
    .filter(Boolean);
  const defaults = [defaultModelForTier("fast", provider), defaultModelForTier("quality", provider)];

  return [...new Set([...defaults, ...configured])].filter(
    (model) => MODEL_PRICING_REGISTRY[model]?.provider === provider
  );
}

export function getAiModel(
  feature: AiFeature,
  settings?: Pick<AISettings, "modelOverride"> | null,
  allowOverride = true
) {
  const override = settings?.modelOverride?.trim();
  if (allowOverride && override && getAllowedAiModels().includes(override)) return override;
  return defaultModelForTier(AI_FEATURE_POLICIES[feature].modelTier);
}

export function getAiRuntimeMode(provider = getAiProviderName()) {
  if (
    process.env.AI_ENABLED !== "true" ||
    process.env.AI_MOCK_MODE === "true" ||
    (provider === "openai" && process.env.OPENAI_MOCK_MODE === "true")
  ) {
    return "local" as const;
  }

  const hasKey = provider === "gemini" ? Boolean(process.env.GEMINI_API_KEY?.trim()) : Boolean(process.env.OPENAI_API_KEY?.trim());
  return hasKey ? provider : ("local" as const);
}

// Compatibility exports for existing callers while the UI moves to provider-neutral names.
export const getAllowedOpenAIModels = getAllowedAiModels;
export function getOpenAIModel(modelOverride?: string | null) {
  return modelOverride && getAllowedAiModels().includes(modelOverride)
    ? modelOverride
    : defaultModelForTier("fast");
}
