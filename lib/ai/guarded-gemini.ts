import type { z } from "zod";

import { PublicApiError } from "@/lib/api-errors";
import {
  findCachedAiResponse,
  reconcileAiReservation,
  reconcileStaleAiReservations,
  reserveAiBudget
} from "@/lib/ai/application-plan-budget";
import { getAiFinancialPolicy, isGeminiConfigured } from "@/lib/ai/config";
import { AI_FEATURE_REGISTRY, type AiFeatureRegistration } from "@/lib/ai/feature-registry";
import {
  buildGeminiJsonRequest,
  callGeminiJsonProvider,
  countGeminiRequestTokens,
  GeminiProviderError,
  type GeminiThinkingLevel,
  type GeminiUsage
} from "@/lib/ai/gemini";
import { hashAiInput } from "@/lib/ai/input-hash";
import { AI_FEATURE_POLICIES, assertAiInputWithinLimits, type AiFeature } from "@/lib/ai/policy";
import { estimateAiCostMicros, getModelPricing } from "@/lib/ai/pricing";
import { logger } from "@/lib/monitoring/logger";
import { prisma } from "@/lib/prisma";

// The one shared product path for Gemini JSON features. Every call: bounds its input,
// requires Gemini (no template fallback), prices against the registered price, checks
// the per-request ceiling, consults the response cache, requires confirmation, reserves
// against the hard monthly ledger, dispatches once, and reconciles the reservation.
export const GUARDED_GEMINI_MODEL = "gemini-3.8-flash" as const;
export const GUARDED_GEMINI_THINKING_LEVEL: GeminiThinkingLevel = "LOW";

export class LocalAiUnavailableError extends PublicApiError {
  constructor() {
    super("This AI feature is unavailable in local mode. Gemini is not configured on this server.", 503, {
      code: "AI_UNAVAILABLE",
      retryable: false
    });
    this.name = "LocalAiUnavailableError";
  }
}

export type AiInvocationOptions = {
  automation?: boolean;
  highCostConfirmed?: boolean;
  dataSharingConfirmed?: boolean;
};

export type GeneratedJsonMeta = {
  provider: "gemini" | "local";
  model: string;
  promptVersion: string;
  requestHash: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  estimatedCostMicros: number | null;
  mocked: boolean;
};

export type GeneratedJsonResult<T> = {
  data: T;
  meta: GeneratedJsonMeta;
};

export type GuardedGeminiJsonInput<T> = {
  feature: AiFeature;
  userId: string | null | undefined;
  promptName: string;
  promptVersion: string;
  systemPrompt: string;
  payload: unknown;
  responseJsonSchema: Record<string, unknown> | undefined;
  schema?: z.ZodType<T, z.ZodTypeDef, unknown>;
  providerSchema?: z.ZodType<unknown, z.ZodTypeDef, unknown>;
  decodeProvider?: (value: unknown) => T;
  validate?: (value: T) => T;
  options?: AiInvocationOptions;
  model?: string;
  thinkingLevel?: GeminiThinkingLevel;
};

type ProviderUsage = Pick<GeminiUsage, "inputTokens" | "outputTokens" | "cachedInputTokens">;
type BillingDisposition = "known" | "not_charged" | "uncertain";

export class GuardedGeminiOutputError extends Error {
  usage: ProviderUsage | null;
  billingDisposition: BillingDisposition;

  constructor(message: string, options: { usage?: ProviderUsage | null; billingDisposition?: BillingDisposition } = {}) {
    super(message);
    this.name = "GuardedGeminiOutputError";
    this.usage = options.usage ?? null;
    this.billingDisposition = options.billingDisposition ?? (this.usage ? "known" : "uncertain");
  }
}

export class GeneratedSchemaError extends Error {
  constructor(promptName: string) {
    super(`${promptName} returned JSON that did not match the expected schema.`);
    this.name = "GeneratedSchemaError";
  }
}

export function validateGeneratedJson<T>(
  value: unknown,
  schema: z.ZodType<T, z.ZodTypeDef, unknown> | undefined,
  promptName: string,
  validate?: (value: T) => T
) {
  if (!schema) {
    const data = value as T;
    return validate ? validate(data) : data;
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new GeneratedSchemaError(promptName);
  return validate ? validate(parsed.data) : parsed.data;
}

function capitalize(value: string) {
  return value ? value[0].toUpperCase() + value.slice(1) : value;
}

export function assertConservativeGeminiWireBound(
  feature: AiFeature,
  maxInputTokens: number,
  requestBody: unknown
) {
  const conservativeInputTokens = Buffer.byteLength(JSON.stringify(requestBody), "utf8") + 1_024;
  if (conservativeInputTokens > maxInputTokens) {
    throw new PublicApiError(
      `This ${feature.toLowerCase().replaceAll("_", " ")} request exceeds its conservative Gemini input bound.`,
      413,
      { code: "AI_INPUT_TOO_LARGE" }
    );
  }
}

// The byte bound treats every byte as a token, so a real résumé plus job description
// can exceed it while being far smaller in tokens. Before refusing, ask Gemini for the
// exact count; the request is admitted only if that count is within maxInputTokens, so
// the reservation (priced at maxInputTokens) still bounds the cost.
export async function assertGeminiInputWithinBound(
  feature: AiFeature,
  maxInputTokens: number,
  requestBody: object,
  { apiKey, model }: { apiKey: string; model: string }
) {
  try {
    assertConservativeGeminiWireBound(feature, maxInputTokens, requestBody);
    return;
  } catch (error) {
    if (!(error instanceof PublicApiError) || error.status !== 413) throw error;
    const counted = await countGeminiRequestTokens({ apiKey, model, requestBody });
    if (counted !== null && counted <= maxInputTokens) {
      logger.info("ai.gemini.input_bound_counted", { feature, countedTokens: counted, maxInputTokens });
      return;
    }
    throw error;
  }
}

export function guardedGeminiMaximumCostMicros(feature: AiFeature, model: string = GUARDED_GEMINI_MODEL) {
  const policy = AI_FEATURE_POLICIES[feature];
  return estimateAiCostMicros({
    model,
    inputTokens: policy.maxInputTokens,
    outputTokens: policy.maxOutputTokens
  });
}

function publicProviderError(
  error: unknown,
  registration: AiFeatureRegistration,
  billingStatus: BillingDisposition,
  actualCostMicros: number | null
) {
  const { feature, errorCodePrefix: prefix, label, outputNoun } = registration;
  if (error instanceof PublicApiError) {
    return new PublicApiError(error.message, error.status, {
      ...error.details,
      feature,
      provider: "gemini",
      billingStatus,
      actualCostMicros
    });
  }
  const invalid = () => new PublicApiError(`Gemini returned ${outputNoun} that could not be accepted.`, 502, {
    code: `${prefix}_PROVIDER_INVALID`,
    feature,
    provider: "gemini",
    billingStatus,
    actualCostMicros,
    retryable: false
  });
  if (!(error instanceof GuardedGeminiOutputError) && !(error instanceof GeminiProviderError)) return invalid();
  if (billingStatus === "not_charged") {
    return new PublicApiError(`Gemini rejected ${label.toLowerCase()} before completion.`, 502, {
      code: `${prefix}_PROVIDER_REJECTED`,
      feature,
      provider: "gemini",
      billingStatus,
      actualCostMicros: 0,
      retryable: true
    });
  }
  if (billingStatus === "uncertain") {
    return new PublicApiError(
      `${label} reached Gemini, but the outcome is uncertain. Review AI usage instead of retrying.`,
      503,
      {
        code: `${prefix}_PROVIDER_UNCERTAIN`,
        feature,
        provider: "gemini",
        billingStatus,
        actualCostMicros: null,
        retryable: false
      }
    );
  }
  return invalid();
}

export async function generateGuardedGeminiJson<T>(input: GuardedGeminiJsonInput<T>): Promise<GeneratedJsonResult<T>> {
  const {
    feature,
    userId,
    promptName,
    promptVersion,
    systemPrompt,
    payload,
    responseJsonSchema,
    schema,
    providerSchema,
    decodeProvider,
    validate,
    options = {}
  } = input;
  const registration = AI_FEATURE_REGISTRY[feature];
  const { errorCodePrefix: prefix, requestNoun, label } = registration;
  if (registration.status !== "active") {
    throw new PublicApiError(`${label} has no registered AI entry point.`, 503, {
      code: "AI_FEATURE_UNREGISTERED",
      feature
    });
  }
  if (!responseJsonSchema) {
    throw new PublicApiError(`${capitalize(requestNoun)} Gemini schema is missing.`, 503, {
      code: `${prefix}_SCHEMA_MISSING`,
      feature
    });
  }
  const { policy } = assertAiInputWithinLimits(feature, systemPrompt, { payload, responseJsonSchema });
  const requestHash = hashAiInput(promptName, promptVersion, payload);
  if (!isGeminiConfigured()) throw new LocalAiUnavailableError();
  const apiKey = process.env.GEMINI_API_KEY!.trim();
  if (!userId) {
    throw new PublicApiError(`${label} requires an authenticated budget owner.`, 503, {
      code: "AI_BUDGET_OWNER_REQUIRED",
      feature
    });
  }
  const model = input.model ?? GUARDED_GEMINI_MODEL;
  const thinkingLevel = input.thinkingLevel ?? GUARDED_GEMINI_THINKING_LEVEL;
  if (getModelPricing(model).provider !== "gemini") {
    throw new PublicApiError(`${label} requires registered Gemini pricing.`, 503, {
      code: "AI_MODEL_PRICING_UNKNOWN"
    });
  }
  const maximumCostMicros = guardedGeminiMaximumCostMicros(feature, model);
  const financial = getAiFinancialPolicy();
  if (maximumCostMicros > financial.maximumRequestCents * 10_000) {
    throw new PublicApiError("This request exceeds the configured per-request AI limit.", 429, {
      code: "AI_REQUEST_COST_LIMIT",
      maximumCostMicros
    });
  }
  const requestBody = buildGeminiJsonRequest({
    systemPrompt,
    payload,
    responseJsonSchema,
    maxOutputTokens: policy.maxOutputTokens,
    thinkingLevel
  });
  await assertGeminiInputWithinBound(feature, policy.maxInputTokens, requestBody, { apiKey, model });

  const cached = await findCachedAiResponse({ userId, provider: "gemini", model, promptName, promptVersion, requestHash });
  if (cached) {
    return {
      data: validateGeneratedJson(cached.output, schema, promptName, validate),
      meta: {
        provider: "gemini",
        model,
        promptVersion,
        requestHash,
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        estimatedCostMicros: 0,
        mocked: false
      }
    };
  }

  const confirmationRequired = registration.confirmation === "data_and_cost"
    ? !options.highCostConfirmed || !options.dataSharingConfirmed
    : !options.automation &&
      maximumCostMicros > financial.confirmationThresholdCents * 10_000 &&
      !options.highCostConfirmed;
  if (confirmationRequired) {
    throw new PublicApiError(registration.confirmationMessage, 428, {
      code: "AI_COST_CONFIRMATION_REQUIRED",
      maximumCostMicros,
      provider: "gemini",
      dataType: registration.dataType,
      feature,
      model,
      promptVersion
    });
  }

  await reconcileStaleAiReservations(userId);
  const activePriorAttempt = await prisma.aIBudgetReservation.findFirst({
    where: {
      userId,
      provider: "gemini",
      model,
      feature,
      promptName,
      promptVersion,
      requestHash,
      status: { in: ["RESERVED", "UNCERTAIN"] }
    },
    select: { id: true, status: true }
  });
  if (activePriorAttempt?.status === "UNCERTAIN") {
    throw new PublicApiError(
      `An identical ${requestNoun} request already reached Gemini with an uncertain outcome. Review AI usage instead of retrying.`,
      409,
      { code: `${prefix}_PRIOR_OUTCOME_UNCERTAIN`, retryable: false }
    );
  }
  if (activePriorAttempt) {
    throw new PublicApiError(
      `An identical ${requestNoun} request is still reserved or running. No second provider call was started.`,
      409,
      { code: "AI_DUPLICATE_IN_PROGRESS", retryable: true }
    );
  }

  const reservation = await reserveAiBudget({
    userId,
    provider: "gemini",
    model,
    feature,
    promptName,
    promptVersion,
    requestHash,
    maximumCostMicros,
    automation: options.automation ?? false
  });
  let usage: GeminiUsage | null = null;
  let requestDispatched = false;
  let reconciled = false;

  try {
    requestDispatched = true;
    const response = await callGeminiJsonProvider({
      apiKey,
      model,
      systemPrompt,
      payload,
      responseJsonSchema,
      maxOutputTokens: policy.maxOutputTokens,
      thinkingLevel
    });
    usage = response.usage;
    const actualCostMicros = estimateAiCostMicros({ model, ...usage });
    if (
      usage.inputTokens > policy.maxInputTokens ||
      usage.outputTokens > policy.maxOutputTokens ||
      actualCostMicros > reservation.maximumCostMicros
    ) {
      throw new GeminiProviderError(`Gemini usage exceeded the reserved ${requestNoun} bounds.`, {
        providerResponded: true,
        usage
      });
    }
    let data: T;
    try {
      const providerValue = providerSchema
        ? validateGeneratedJson(response.value, providerSchema, promptName)
        : response.value;
      const decoded = decodeProvider ? decodeProvider(providerValue) : providerValue as T;
      data = validateGeneratedJson(decoded, schema, promptName, validate);
    } catch (error) {
      if (error instanceof PublicApiError) throw error;
      throw new GuardedGeminiOutputError(`Gemini returned an unsupported ${requestNoun} result.`, {
        usage,
        billingDisposition: "known"
      });
    }
    await reconcileAiReservation({
      reservationId: reservation.id,
      status: "SUCCEEDED",
      actualCostMicros,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cachedInputTokens: usage.cachedInputTokens,
      cacheOutput: data
    });
    reconciled = true;
    return {
      data,
      meta: {
        provider: "gemini",
        model,
        promptVersion,
        requestHash,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cachedInputTokens: usage.cachedInputTokens,
        estimatedCostMicros: actualCostMicros,
        mocked: false
      }
    };
  } catch (error) {
    const providerUsage = error instanceof GeminiProviderError || error instanceof GuardedGeminiOutputError
      ? error.usage
      : usage;
    const providerDisposition: BillingDisposition =
      error instanceof GeminiProviderError || error instanceof GuardedGeminiOutputError
        ? error.billingDisposition
        : providerUsage ? "known" : "uncertain";
    const knownCost = providerUsage ? estimateAiCostMicros({ model, ...providerUsage }) : undefined;
    const billingStatus: BillingDisposition = requestDispatched && (
      providerDisposition === "uncertain" ||
      (knownCost !== undefined && knownCost > reservation.maximumCostMicros)
    ) ? "uncertain" : providerDisposition;
    if (!reconciled) {
      try {
        await reconcileAiReservation({
          reservationId: reservation.id,
          status: billingStatus === "uncertain" ? "UNCERTAIN" : "FAILED",
          actualCostMicros: billingStatus === "not_charged" ? 0 : billingStatus === "known" ? knownCost : undefined,
          inputTokens: providerUsage?.inputTokens,
          outputTokens: providerUsage?.outputTokens,
          cachedInputTokens: providerUsage?.cachedInputTokens,
          errorCode: error instanceof Error ? error.name : "UnknownError"
        });
      } catch {
        throw new PublicApiError(
          `${capitalize(requestNoun)} billing reconciliation did not complete. Review AI usage instead of retrying.`,
          503,
          {
            code: `${prefix}_RECONCILIATION_UNCERTAIN`,
            feature,
            provider: "gemini",
            billingStatus: "uncertain",
            actualCostMicros: knownCost ?? null,
            retryable: false
          }
        );
      }
    }
    throw publicProviderError(error, registration, billingStatus, billingStatus === "not_charged" ? 0 : knownCost ?? null);
  }
}
