import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import type { z } from "zod";
import { PublicApiError } from "@/lib/api-errors";
import { getAiFinancialPolicy } from "@/lib/ai/config";
import { assertAiInputWithinLimits } from "@/lib/ai/policy";
import { estimateAiCostMicros as estimatePricedCost, getModelPricing } from "@/lib/ai/pricing";
import {
  findCachedAiResponse,
  reconcileAiReservation,
  reserveAiBudget
} from "@/lib/ai/application-plan-budget";

import {
  assertAiBudgetAvailable,
  estimateAiCostMicros,
  hashAiInput,
  recordAiUsage
} from "@/lib/ai/usage";

let openai: OpenAI | null = null;

export class LocalAiUnavailableError extends PublicApiError {
  constructor() {
    super("This AI feature is unavailable in local mode.", 503);
    this.name = "LocalAiUnavailableError";
  }
}

export function getOpenAIClient() {
  if (!process.env.OPENAI_API_KEY) {
    return null;
  }

  openai ??= new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return openai;
}

export function getOpenAIModel(modelOverride?: string | null) {
  const fallback = process.env.OPENAI_MODEL || "gpt-4o-mini";
  const requested = modelOverride?.trim();
  return requested && getAllowedOpenAIModels().includes(requested) ? requested : fallback;
}

export function getAllowedOpenAIModels() {
  const fallback = process.env.OPENAI_MODEL || "gpt-4o-mini";
  const configured = process.env.OPENAI_ALLOWED_MODELS
    ?.split(",")
    .map((model) => model.trim())
    .filter(Boolean) ?? [];
  return [...new Set([fallback, ...configured])];
}

export type AiCallContext = {
  userId: string;
  feature: string;
  promptVersion?: string;
  automation?: boolean;
  highCostConfirmed?: boolean;
};

export type AiInvocationOptions = Pick<AiCallContext, "automation" | "highCostConfirmed">;

export type GeneratedJsonResult<T> = {
  data: T;
  meta: {
    provider: "openai" | "local";
    model: string;
    promptVersion: string;
    requestHash: string;
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    estimatedCostMicros: number | null;
    mocked: boolean;
  };
};

type GenerateJsonInput<T> = {
  promptName: string;
  systemPrompt: string;
  payload: unknown;
  fallback?: T;
  schema?: z.ZodType<T, z.ZodTypeDef, unknown>;
  context?: AiCallContext;
};

export async function generateJson<T>({
  promptName,
  systemPrompt,
  payload,
  fallback,
  schema,
  context
}: GenerateJsonInput<T>): Promise<GeneratedJsonResult<T>> {
  if (context?.feature === "APPLICATION_PLAN") {
    return generateApplicationPlanJson({ promptName, systemPrompt, payload, fallback, schema, context });
  }

  const client = getOpenAIClient();
  const promptVersion = context?.promptVersion ?? "1";
  const requestHash = hashAiInput(promptName, promptVersion, payload);

  if (!client || process.env.OPENAI_MOCK_MODE === "true") {
    if (fallback === undefined) {
      throw new LocalAiUnavailableError();
    }
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
        mocked: true
      }
    };
  }

  const budget = context ? await assertAiBudgetAvailable(context.userId) : null;
  const model = getOpenAIModel(budget?.settings.modelOverride);
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens = 0;
  let estimatedCostMicros: number | null = null;
  let usageRecorded = false;

  try {
    const response = await client.chat.completions.create({
      model,
      temperature: 0.2,
      response_format: schema
        ? zodResponseFormat(schema, promptName.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64))
        : { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: JSON.stringify(payload) }
      ]
    });

    const content = response.choices[0]?.message.content;

    if (!content) {
      throw new Error(`${promptName} returned an empty response.`);
    }

    inputTokens = response.usage?.prompt_tokens ?? 0;
    outputTokens = response.usage?.completion_tokens ?? 0;
    cachedInputTokens = response.usage?.prompt_tokens_details?.cached_tokens ?? 0;
    estimatedCostMicros = estimateAiCostMicros({ inputTokens, outputTokens, cachedInputTokens });
    const data = validateGeneratedJson(JSON.parse(content), schema, promptName);

    if (context) {
      await recordAiUsage({
        userId: context.userId,
        feature: context.feature,
        model,
        promptName,
        promptVersion,
        inputTokens,
        outputTokens,
        cachedInputTokens,
        estimatedCostMicros,
        requestHash,
        status: "SUCCEEDED"
      });
      usageRecorded = true;
    }

    return {
      data,
      meta: {
        provider: "openai",
        model,
        promptVersion,
        requestHash,
        inputTokens,
        outputTokens,
        cachedInputTokens,
        estimatedCostMicros,
        mocked: false
      }
    };
  } catch (error) {
    if (context && !usageRecorded) {
      await recordAiUsage({
        userId: context.userId,
        feature: context.feature,
        model,
        promptName,
        promptVersion,
        inputTokens,
        outputTokens,
        cachedInputTokens,
        estimatedCostMicros,
        requestHash,
        status: "FAILED",
        errorCode: error instanceof Error ? error.name : "UnknownError"
      }).catch(() => undefined);
    }

    throw error;
  }
}

// Application planning is the new paid AI surface. It retains main's OpenAI routing
// while applying the accepted engine's input, price, confirmation, and reservation fences.
async function generateApplicationPlanJson<T>({
  promptName,
  systemPrompt,
  payload,
  fallback,
  schema,
  context
}: GenerateJsonInput<T> & { context: AiCallContext }): Promise<GeneratedJsonResult<T>> {
  const { policy } = assertAiInputWithinLimits("APPLICATION_PLAN", systemPrompt, payload);
  const promptVersion = context.promptVersion ?? "1";
  const requestHash = hashAiInput(promptName, promptVersion, payload);
  const client = getOpenAIClient();

  if (!client || process.env.OPENAI_MOCK_MODE === "true") {
    if (fallback === undefined) throw new LocalAiUnavailableError();
    return {
      data: validateGeneratedJson(fallback, schema, promptName),
      meta: {
        provider: "local", model: "heuristic-local", promptVersion, requestHash,
        inputTokens: 0, outputTokens: 0, cachedInputTokens: 0,
        estimatedCostMicros: 0, mocked: true
      }
    };
  }

  const budget = await assertAiBudgetAvailable(context.userId);
  const model = getOpenAIModel(budget.settings.modelOverride);
  if (getModelPricing(model).provider !== "openai") {
    throw new PublicApiError("Application planning requires a registered OpenAI model.", 503, {
      code: "AI_MODEL_PRICING_UNKNOWN"
    });
  }
  const financial = getAiFinancialPolicy();
  const maximumCostMicros = estimatePricedCost({
    model, inputTokens: policy.maxInputTokens, outputTokens: policy.maxOutputTokens
  });
  const maximumRequestMicros = financial.maximumRequestCents * 10_000;
  if (maximumCostMicros > maximumRequestMicros) {
    throw new PublicApiError("This request exceeds the configured per-request AI limit.", 429, {
      code: "AI_REQUEST_COST_LIMIT", maximumCostMicros
    });
  }

  const cached = await findCachedAiResponse({
    userId: context.userId, provider: "openai", model, promptName, promptVersion, requestHash
  });
  if (cached) {
    return {
      data: validateGeneratedJson(cached.output, schema, promptName),
      meta: {
        provider: "openai", model, promptVersion, requestHash,
        inputTokens: 0, outputTokens: 0, cachedInputTokens: 0,
        estimatedCostMicros: 0, mocked: false
      }
    };
  }

  if (maximumCostMicros > financial.confirmationThresholdCents * 10_000 && !context.highCostConfirmed) {
    throw new PublicApiError("Confirm this AI request's maximum cost before continuing.", 428, {
      code: "AI_COST_CONFIRMATION_REQUIRED", maximumCostMicros
    });
  }

  const reservation = await reserveAiBudget({
    userId: context.userId, provider: "openai", model, feature: "APPLICATION_PLAN",
    promptName, promptVersion, requestHash, maximumCostMicros: maximumRequestMicros,
    automation: context.automation ?? false
  });
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens = 0;
  let actualCostMicros: number | undefined;
  let providerReturned = false;
  let reconciled = false;

  try {
    const response = await client.chat.completions.create({
      model,
      temperature: 0.2,
      response_format: schema
        ? zodResponseFormat(schema, promptName.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64))
        : { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: JSON.stringify(payload) }
      ]
    });
    providerReturned = true;
    inputTokens = response.usage?.prompt_tokens ?? 0;
    outputTokens = response.usage?.completion_tokens ?? 0;
    cachedInputTokens = response.usage?.prompt_tokens_details?.cached_tokens ?? 0;
    actualCostMicros = response.usage
      ? estimatePricedCost({ model, inputTokens, outputTokens, cachedInputTokens })
      : reservation.maximumCostMicros;
    const content = response.choices[0]?.message.content;
    if (!content) throw new Error(`${promptName} returned an empty response.`);
    const data = validateGeneratedJson<T>(JSON.parse(content), schema, promptName);
    await reconcileAiReservation({
      reservationId: reservation.id, status: "SUCCEEDED", actualCostMicros,
      inputTokens, outputTokens, cachedInputTokens, cacheOutput: data
    });
    reconciled = true;
    return {
      data,
      meta: {
        provider: "openai", model, promptVersion, requestHash,
        inputTokens, outputTokens, cachedInputTokens,
        estimatedCostMicros: actualCostMicros, mocked: false
      }
    };
  } catch (error) {
    if (!reconciled) {
      await reconcileAiReservation({
        reservationId: reservation.id,
        status: providerReturned ? "FAILED" : "UNCERTAIN",
        actualCostMicros,
        inputTokens, outputTokens, cachedInputTokens,
        errorCode: error instanceof Error ? error.name : "UnknownError"
      }).catch(() => undefined);
    }
    throw error;
  }
}

function validateGeneratedJson<T>(
  value: unknown,
  schema: z.ZodType<T, z.ZodTypeDef, unknown> | undefined,
  promptName: string
) {
  if (!schema) {
    return value as T;
  }

  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`${promptName} returned JSON that did not match the expected schema.`);
  }

  return parsed.data;
}
