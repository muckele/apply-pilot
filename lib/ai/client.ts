import type { z } from "zod";

import {
  getAiFinancialPolicy,
  getAiModel,
  getAiRuntimeMode,
  getAllowedAiModels,
  getAllowedOpenAIModels,
  getOpenAIModel
} from "@/lib/ai/config";
import { assertAiInputWithinLimits, isAiFeature, type AiFeature } from "@/lib/ai/policy";
import { estimateAiCostMicros, getModelPricing } from "@/lib/ai/pricing";
import { callJsonProvider } from "@/lib/ai/providers";
import {
  findCachedAiResponse,
  getOrCreateAiSettings,
  hashAiInput,
  reconcileAiReservation,
  reserveAiBudget
} from "@/lib/ai/usage";
import { PublicApiError } from "@/lib/api-errors";

export { getAllowedAiModels, getAllowedOpenAIModels, getOpenAIModel };

export type AiCallContext = {
  userId: string;
  feature: AiFeature;
  promptVersion?: string;
  automation?: boolean;
  highCostConfirmed?: boolean;
};

export type AiInvocationOptions = Pick<AiCallContext, "automation" | "highCostConfirmed">;

export type GeneratedJsonResult<T> = {
  data: T;
  meta: {
    provider: "gemini" | "openai" | "local";
    model: string;
    promptVersion: string;
    requestHash: string;
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    estimatedCostMicros: number;
    maximumCostMicros: number;
    mocked: boolean;
    cacheHit: boolean;
  };
};

type GenerateJsonInput<T> = {
  promptName: string;
  systemPrompt: string;
  payload: unknown;
  fallback: T;
  schema?: z.ZodType<T, z.ZodTypeDef, unknown>;
  context?: AiCallContext;
};

class GeneratedSchemaError extends Error {
  constructor(promptName: string, cause?: unknown) {
    super(`${promptName} returned JSON that did not match the expected schema.`, { cause });
    this.name = "GeneratedSchemaError";
  }
}

export async function generateJson<T>({
  promptName,
  systemPrompt,
  payload,
  fallback,
  schema,
  context
}: GenerateJsonInput<T>): Promise<GeneratedJsonResult<T>> {
  if (context && !isAiFeature(context.feature)) {
    throw new PublicApiError(`AI feature policy is missing for ${context.feature}.`, 503, {
      code: "AI_FEATURE_POLICY_UNKNOWN"
    });
  }
  const feature = context?.feature ?? "JOB_PARSE";
  const { policy } = assertAiInputWithinLimits(feature, systemPrompt, payload);
  const promptVersion = context?.promptVersion ?? "1";
  const requestHash = hashAiInput(promptName, promptVersion, payload);
  const settings = context ? await getOrCreateAiSettings(context.userId) : null;
  const model = getAiModel(feature, settings, !context?.automation);
  const pricing = getModelPricing(model);
  const runtimeMode = getAiRuntimeMode(pricing.provider);

  if (runtimeMode === "local") {
    return {
      data: validateGeneratedJson(fallback, schema, promptName),
      meta: {
        provider: "local",
        model: "heuristic-local",
        promptVersion,
        requestHash,
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        estimatedCostMicros: 0,
        maximumCostMicros: 0,
        mocked: true,
        cacheHit: false
      }
    };
  }

  if (!context) {
    throw new PublicApiError("Paid AI requests require an authenticated budget owner.", 403, {
      code: "AI_BUDGET_OWNER_REQUIRED"
    });
  }

  const cached = await findCachedAiResponse({
    userId: context.userId,
    provider: pricing.provider,
    model,
    promptName,
    promptVersion,
    requestHash
  });
  if (cached) {
    return {
      data: validateGeneratedJson(cached.output, schema, promptName),
      meta: {
        provider: pricing.provider,
        model,
        promptVersion,
        requestHash,
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        estimatedCostMicros: 0,
        maximumCostMicros: 0,
        mocked: false,
        cacheHit: true
      }
    };
  }

  const maximumCostMicros = estimateAiCostMicros({
    model,
    inputTokens: policy.maxInputTokens,
    outputTokens: policy.maxOutputTokens
  });
  const financialPolicy = getAiFinancialPolicy();
  const maximumRequestMicros = financialPolicy.maximumRequestCents * 10_000;
  const confirmationThresholdMicros = financialPolicy.confirmationThresholdCents * 10_000;

  if (maximumCostMicros > maximumRequestMicros) {
    throw new PublicApiError("This request exceeds the configured ten-cent per-request AI limit.", 429, {
      code: "AI_REQUEST_COST_LIMIT",
      maximumCostMicros
    });
  }
  if (maximumCostMicros > confirmationThresholdMicros && !context.highCostConfirmed) {
    throw new PublicApiError(
      `This request could cost up to $${(maximumCostMicros / 1_000_000).toFixed(3)}. Confirm before continuing.`,
      428,
      { code: "AI_COST_CONFIRMATION_REQUIRED", maximumCostMicros }
    );
  }

  // A schema retry is allowed only when both attempts still fit the endpoint's total cost ceiling.
  const maximumAttempts = maximumCostMicros * 2 <= maximumRequestMicros ? 2 : 1;
  let lastSchemaError: Error | null = null;

  for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
    // Reserve the entire per-request ceiling. Gemini can report billed thinking
    // tokens separately, so reserving only the expected visible output would
    // leave a concurrency window where the monthly hard cap could be exceeded.
    const reservation = await reserveAiBudget({
      userId: context.userId,
      provider: pricing.provider,
      model,
      feature,
      promptName,
      promptVersion,
      requestHash,
      maximumCostMicros: maximumRequestMicros,
      automation: context.automation ?? false
    });

    let providerResult;
    try {
      providerResult = await callJsonProvider({
        provider: pricing.provider,
        model,
        promptName,
        systemPrompt,
        payload,
        schema,
        maxOutputTokens: policy.maxOutputTokens
      });
    } catch (error) {
      await reconcileAiReservation({
        reservationId: reservation.id,
        status: "UNCERTAIN",
        errorCode: error instanceof Error ? error.name : "UnknownProviderError"
      }).catch(() => undefined);
      throw error;
    }

    const actualCostMicros = providerResult.usageReported
      ? estimateAiCostMicros({
          model,
          inputTokens: providerResult.inputTokens,
          outputTokens: providerResult.outputTokens,
          cachedInputTokens: providerResult.cachedInputTokens
        })
      : reservation.maximumCostMicros;

    if (actualCostMicros > reservation.maximumCostMicros) {
      await reconcileAiReservation({
        reservationId: reservation.id,
        status: "UNCERTAIN",
        inputTokens: providerResult.inputTokens,
        outputTokens: providerResult.outputTokens,
        cachedInputTokens: providerResult.cachedInputTokens,
        errorCode: "AI_PROVIDER_USAGE_EXCEEDED_RESERVATION"
      });
      throw new PublicApiError(
        "The AI provider reported usage above the preauthorized request limit. Paid AI has been stopped for this request.",
        503,
        { code: "AI_PROVIDER_USAGE_EXCEEDED_RESERVATION" }
      );
    }

    let data: T;
    try {
      const value = JSON.parse(providerResult.content) as unknown;
      data = validateGeneratedJson(value, schema, promptName);
    } catch (error) {
      lastSchemaError = error instanceof GeneratedSchemaError
        ? error
        : new GeneratedSchemaError(promptName, error);
      await reconcileAiReservation({
        reservationId: reservation.id,
        actualCostMicros,
        inputTokens: providerResult.inputTokens,
        outputTokens: providerResult.outputTokens,
        cachedInputTokens: providerResult.cachedInputTokens,
        status: "FAILED",
        errorCode: lastSchemaError.name
      });
      continue;
    }

    // Reconciliation failures must never be classified as schema failures or retried.
    await reconcileAiReservation({
      reservationId: reservation.id,
      actualCostMicros,
      inputTokens: providerResult.inputTokens,
      outputTokens: providerResult.outputTokens,
      cachedInputTokens: providerResult.cachedInputTokens,
      status: "SUCCEEDED",
      errorCode: providerResult.usageReported ? undefined : "USAGE_UNREPORTED",
      cacheOutput: data
    });

    return {
      data,
      meta: {
        provider: pricing.provider,
        model,
        promptVersion,
        requestHash,
        inputTokens: providerResult.inputTokens,
        outputTokens: providerResult.outputTokens,
        cachedInputTokens: providerResult.cachedInputTokens,
        estimatedCostMicros: actualCostMicros,
        maximumCostMicros,
        mocked: false,
        cacheHit: false
      }
    };
  }

  throw lastSchemaError ?? new GeneratedSchemaError(promptName);
}

function validateGeneratedJson<T>(
  value: unknown,
  schema: z.ZodType<T, z.ZodTypeDef, unknown> | undefined,
  promptName: string
) {
  if (!schema) return value as T;
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new GeneratedSchemaError(promptName, parsed.error);
  return parsed.data;
}
