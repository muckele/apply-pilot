import type { AISettings } from "@prisma/client";

import { AI_FEATURE_POLICIES, isAiFeature, type AiFeature } from "@/lib/ai/policy";
import { AI_PROVIDER_NAMES, MODEL_PRICING_REGISTRY, type AiProviderName } from "@/lib/ai/pricing";
import { PublicApiError } from "@/lib/api-errors";

const DEFAULT_FAST_MODEL = "gemini-3.5-flash-lite";
const DEFAULT_QUALITY_MODEL = "gemini-3.5-flash-lite";
const DEFAULT_KIMI_MODEL = "kimi-k3";

export const KIMI_REASONING_EFFORTS = ["low", "high", "max"] as const;
export type KimiReasoningEffort = (typeof KIMI_REASONING_EFFORTS)[number];

// Feature-level provider overrides are deliberately limited to advisory application
// planning in this slice. Routing any other feature requires an intentional code change.
export const PROVIDER_OVERRIDE_ELIGIBLE_FEATURES: readonly AiFeature[] = ["APPLICATION_PLAN"];

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

  // The global provider remains gemini/openai only. Kimi is reachable solely through
  // feature-level overrides, so AI_PROVIDER=kimi fails closed here.
  if (provider !== "gemini" && provider !== "openai") {
    throw new PublicApiError(`Unsupported AI provider: ${provider}.`, 503, {
      code: "AI_PROVIDER_UNKNOWN"
    });
  }

  return provider;
}

// Parses AI_PROVIDER_OVERRIDES entries of the form "FEATURE:provider".
// Malformed entries, duplicates, ineligible features, and unknown providers all fail closed.
export function parseAiProviderOverrides(raw: string | undefined): Partial<Record<AiFeature, AiProviderName>> {
  const overrides: Partial<Record<AiFeature, AiProviderName>> = {};
  for (const token of (raw ?? "").split(",").map((entry) => entry.trim()).filter(Boolean)) {
    const parts = token.split(":").map((part) => part.trim());
    const [feature, provider] = parts;
    const invalid =
      parts.length !== 2 ||
      !feature ||
      !provider ||
      !isAiFeature(feature) ||
      !PROVIDER_OVERRIDE_ELIGIBLE_FEATURES.includes(feature) ||
      !AI_PROVIDER_NAMES.includes(provider as AiProviderName) ||
      overrides[feature] !== undefined;
    if (invalid) {
      throw new PublicApiError(
        `Invalid AI provider override: ${token}. Only ${PROVIDER_OVERRIDE_ELIGIBLE_FEATURES.join(", ")} may be routed, and only to a registered provider.`,
        503,
        { code: "AI_PROVIDER_OVERRIDE_INVALID" }
      );
    }
    overrides[feature] = provider as AiProviderName;
  }
  return overrides;
}

export function getAiProviderForFeature(feature: AiFeature): AiProviderName {
  return parseAiProviderOverrides(process.env.AI_PROVIDER_OVERRIDES)[feature] ?? getAiProviderName();
}

export function getKimiReasoningEffort(): KimiReasoningEffort {
  const effort = process.env.KIMI_REASONING_EFFORT?.trim() || "low";
  if (!KIMI_REASONING_EFFORTS.includes(effort as KimiReasoningEffort)) {
    throw new PublicApiError("KIMI_REASONING_EFFORT must be one of low, high, or max.", 503, {
      code: "AI_REASONING_EFFORT_INVALID"
    });
  }
  return effort as KimiReasoningEffort;
}

// MOONSHOT_API_KEY is the only Kimi credential. No alias exists, and the
// coding-assistant credential is development-time only and is never read here.
export function resolveKimiApiKey() {
  return process.env.MOONSHOT_API_KEY?.trim() || null;
}

function defaultModelForTier(tier: "fast" | "quality", provider: AiProviderName = getAiProviderName()) {
  if (provider === "kimi") {
    return process.env.KIMI_MODEL?.trim() || DEFAULT_KIMI_MODEL;
  }
  if (provider === "openai") {
    return process.env.OPENAI_MODEL?.trim() || "gpt-4o-mini";
  }
  return tier === "fast"
    ? process.env.GEMINI_FAST_MODEL?.trim() || DEFAULT_FAST_MODEL
    : process.env.GEMINI_QUALITY_MODEL?.trim() || DEFAULT_QUALITY_MODEL;
}

function getActiveAiProviders(): AiProviderName[] {
  return [...new Set<AiProviderName>([
    getAiProviderName(),
    ...Object.values(parseAiProviderOverrides(process.env.AI_PROVIDER_OVERRIDES))
  ])];
}

export function getAllowedAiModels() {
  const providers = new Set(getActiveAiProviders());
  const configured = (process.env.AI_ALLOWED_MODELS ?? process.env.OPENAI_ALLOWED_MODELS ?? "")
    .split(",")
    .map((model) => model.trim())
    .filter(Boolean);
  const defaults = getActiveAiProviders().flatMap((provider) => [
    defaultModelForTier("fast", provider),
    defaultModelForTier("quality", provider)
  ]);

  return [...new Set([...defaults, ...configured])].filter((model) => {
    const pricing = MODEL_PRICING_REGISTRY[model];
    return pricing !== undefined && providers.has(pricing.provider);
  });
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
  return defaultModelForTier(AI_FEATURE_POLICIES[feature].modelTier, provider);
}

export function getAiRuntimeMode(provider = getAiProviderName()) {
  if (
    process.env.AI_ENABLED !== "true" ||
    process.env.AI_MOCK_MODE === "true" ||
    (provider === "openai" && process.env.OPENAI_MOCK_MODE === "true")
  ) {
    return "local" as const;
  }

  const hasKey =
    provider === "gemini"
      ? Boolean(process.env.GEMINI_API_KEY?.trim())
      : provider === "kimi"
        ? Boolean(resolveKimiApiKey())
        : Boolean(process.env.OPENAI_API_KEY?.trim());
  return hasKey ? provider : ("local" as const);
}

// Compatibility exports for existing callers while the UI moves to provider-neutral names.
export const getAllowedOpenAIModels = getAllowedAiModels;
export function getOpenAIModel(modelOverride?: string | null) {
  return modelOverride && getAllowedAiModels().includes(modelOverride)
    ? modelOverride
    : defaultModelForTier("fast");
}
