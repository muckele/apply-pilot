import type { AISettings } from "@prisma/client";

import { AI_FEATURE_POLICIES, type AiFeature } from "@/lib/ai/policy";
import { MODEL_PRICING_REGISTRY, type AiProviderName } from "@/lib/ai/pricing";
import { PublicApiError } from "@/lib/api-errors";

const DEFAULT_FAST_MODEL = "gemini-3.5-flash-lite";
const DEFAULT_QUALITY_MODEL = "gemini-3.5-flash-lite";

// Compiled ceilings. Environment variables may lower these values but never raise them.
export const AI_HARD_CAP_CENTS = 500;
export const AI_AUTOMATION_CAP_CENTS = 150;
export const AI_MAX_REQUEST_COST_CENTS = 10;
export const AI_CONFIRMATION_THRESHOLD_CENTS = 5;

function readPositiveInteger(name: string, fallback: number) {
  const parsed = Number(process.env[name]);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function getAiFinancialPolicy() {
  return {
    hardCapCents: Math.min(AI_HARD_CAP_CENTS, readPositiveInteger("AI_HARD_CAP_CENTS", AI_HARD_CAP_CENTS)),
    automationCapCents: Math.min(
      AI_AUTOMATION_CAP_CENTS,
      readPositiveInteger("AI_AUTOMATION_CAP_CENTS", AI_AUTOMATION_CAP_CENTS)
    ),
    maximumRequestCents: Math.min(
      AI_MAX_REQUEST_COST_CENTS,
      readPositiveInteger("AI_MAX_REQUEST_COST_CENTS", AI_MAX_REQUEST_COST_CENTS)
    ),
    confirmationThresholdCents: Math.min(
      AI_CONFIRMATION_THRESHOLD_CENTS,
      readPositiveInteger("AI_CONFIRMATION_THRESHOLD_CENTS", AI_CONFIRMATION_THRESHOLD_CENTS)
    )
  };
}

// Gemini is the single MVP AI provider (decision D029). AI_PROVIDER may be unset or
// "gemini"; any other value, including the retired "openai" and "kimi", fails closed.
export function getAiProviderName(): AiProviderName {
  const provider = process.env.AI_PROVIDER?.trim() || "gemini";
  if (provider !== "gemini") {
    throw new PublicApiError(`Unsupported AI provider: ${provider}. Gemini is the only supported AI provider.`, 503, {
      code: "AI_PROVIDER_UNSUPPORTED"
    });
  }
  return provider;
}

// Retained so existing callers keep one call shape; every feature uses the global provider.
export function getAiProviderForFeature(feature: AiFeature): AiProviderName {
  void feature;
  return getAiProviderName();
}

function defaultModelForTier(tier: "fast" | "quality") {
  return tier === "fast"
    ? process.env.GEMINI_FAST_MODEL?.trim() || DEFAULT_FAST_MODEL
    : process.env.GEMINI_QUALITY_MODEL?.trim() || DEFAULT_QUALITY_MODEL;
}

export function getAllowedAiModels() {
  const provider: AiProviderName = "gemini";
  const configured = (process.env.AI_ALLOWED_MODELS ?? "")
    .split(",")
    .map((model) => model.trim())
    .filter(Boolean);
  const defaults = [defaultModelForTier("fast"), defaultModelForTier("quality")];

  return [...new Set([...defaults, ...configured])].filter((model) =>
    MODEL_PRICING_REGISTRY[model]?.provider === provider);
}

export function getAiModel(
  feature: AiFeature,
  settings?: Pick<AISettings, "modelOverride"> | null,
  allowOverride = true
) {
  const provider = getAiProviderForFeature(feature);
  const override = settings?.modelOverride?.trim();
  if (
    allowOverride &&
    override &&
    getAllowedAiModels().includes(override) &&
    MODEL_PRICING_REGISTRY[override]?.provider === provider
  ) {
    return override;
  }
  return defaultModelForTier(AI_FEATURE_POLICIES[feature].modelTier);
}

function selectsSupportedProvider() {
  return (process.env.AI_PROVIDER?.trim() || "gemini") === "gemini";
}

// "local" means AI is unavailable. A retired global AI_PROVIDER value disables every
// feature, including those pinned to Gemini, so the selection can never be ambiguous.
export function getAiRuntimeMode(provider: AiProviderName = "gemini") {
  if (
    process.env.AI_ENABLED !== "true" ||
    process.env.AI_MOCK_MODE === "true" ||
    !selectsSupportedProvider()
  ) {
    return "local" as const;
  }
  return provider === "gemini" && Boolean(process.env.GEMINI_API_KEY?.trim())
    ? provider
    : ("local" as const);
}

// True only when AI_ENABLED=true, AI mock mode is off, AI_PROVIDER selects Gemini (or is
// unset), and GEMINI_API_KEY is present. Presence is not proof of provider reachability.
export function isGeminiConfigured() {
  return getAiRuntimeMode("gemini") === "gemini";
}

export type AiAvailability =
  | { available: true; provider: "gemini" }
  | { available: false; reason: "disabled" | "not_configured" | "unsupported_provider" };

export function getAiAvailability(): AiAvailability {
  if (!selectsSupportedProvider()) return { available: false, reason: "unsupported_provider" };
  if (process.env.AI_ENABLED !== "true" || process.env.AI_MOCK_MODE === "true") {
    return { available: false, reason: "disabled" };
  }
  return isGeminiConfigured()
    ? { available: true, provider: "gemini" }
    : { available: false, reason: "not_configured" };
}
