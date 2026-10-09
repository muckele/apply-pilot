import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import type { z } from "zod";
import { PublicApiError } from "@/lib/api-errors";
import {
  getAiFinancialPolicy,
  getAiProviderForFeature,
  getAiRuntimeMode
} from "@/lib/ai/config";
import {
  APPLICATION_DOCUMENT_MODEL,
  APPLICATION_DOCUMENT_THINKING_LEVEL
} from "@/lib/ai/application-document-version";
import {
  buildGeminiJsonRequest,
  callGeminiJsonProvider,
  GeminiProviderError,
  type GeminiUsage
} from "@/lib/ai/gemini";
import { AI_FEATURE_POLICIES, assertAiInputWithinLimits } from "@/lib/ai/policy";
import { estimateAiCostMicros as estimatePricedCost, getModelPricing } from "@/lib/ai/pricing";
import {
  findCachedAiResponse,
  reconcileAiReservation,
  reconcileStaleAiReservations,
  reserveAiBudget
} from "@/lib/ai/application-plan-budget";

import {
  assertAiBudgetAvailable,
  estimateAiCostMicros,
  hashAiInput,
  recordAiUsage
} from "@/lib/ai/usage";
import { prisma } from "@/lib/prisma";

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
  dataSharingConfirmed?: boolean;
};

export type AiInvocationOptions = Pick<AiCallContext, "automation" | "highCostConfirmed"> & {
  dataSharingConfirmed?: boolean;
};

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
  responseJsonSchema?: Record<string, unknown>;
  context?: AiCallContext;
  validate?: (value: T) => T;
};

const GUARDED_APPLICATION_DOCUMENT_FEATURES = ["RESUME_TAILOR", "COVER_LETTER"] as const;
type GuardedApplicationDocumentFeature = (typeof GUARDED_APPLICATION_DOCUMENT_FEATURES)[number];

function isGuardedApplicationDocumentFeature(feature: string): feature is GuardedApplicationDocumentFeature {
  return GUARDED_APPLICATION_DOCUMENT_FEATURES.includes(feature as GuardedApplicationDocumentFeature);
}

export async function generateJson<T>({
  promptName,
  systemPrompt,
  payload,
  fallback,
  schema,
  responseJsonSchema,
  context,
  validate
}: GenerateJsonInput<T>): Promise<GeneratedJsonResult<T>> {
  if (context?.feature === "APPLICATION_PLAN") {
    return generateApplicationPlanJson({ promptName, systemPrompt, payload, fallback, schema, context, validate });
  }
  if (context && isGuardedApplicationDocumentFeature(context.feature)) {
    const documentContext = { ...context, feature: context.feature };
    return generateGuardedApplicationDocumentJson({
      promptName, systemPrompt, payload, fallback, schema, responseJsonSchema,
      context: documentContext, validate
    });
  }

  const client = getOpenAIClient();
  const promptVersion = context?.promptVersion ?? "1";
  const requestHash = hashAiInput(promptName, promptVersion, payload);

  if (!client || process.env.OPENAI_MOCK_MODE === "true") {
    if (fallback === undefined) {
      throw new LocalAiUnavailableError();
    }
    return {
      data: validateGeneratedJson(fallback, schema, promptName, validate),
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
    const data = validateGeneratedJson(JSON.parse(content), schema, promptName, validate);

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

type ApplicationDocumentUsage = {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
};

class ApplicationDocumentProviderError extends Error {
  usage: ApplicationDocumentUsage | null;
  billingDisposition: "known" | "not_charged" | "uncertain";

  constructor(
    message: string,
    options: {
      usage?: ApplicationDocumentUsage | null;
      billingDisposition?: "known" | "not_charged" | "uncertain";
    } = {}
  ) {
    super(message);
    this.name = "ApplicationDocumentProviderError";
    this.usage = options.usage ?? null;
    this.billingDisposition = options.billingDisposition ?? (this.usage ? "known" : "uncertain");
  }
}

function applicationDocumentMaximumCost(model: string, feature: GuardedApplicationDocumentFeature) {
  const policy = AI_FEATURE_POLICIES[feature];
  return estimatePricedCost({
    model,
    inputTokens: policy.maxInputTokens,
    outputTokens: policy.maxOutputTokens
  });
}

export function assertConservativeApplicationDocumentWireBound(
  feature: GuardedApplicationDocumentFeature,
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

function applicationDocumentPublicError(
  error: unknown,
  feature: GuardedApplicationDocumentFeature,
  billingStatus: "known" | "not_charged" | "uncertain",
  actualCostMicros: number | null
) {
  if (error instanceof PublicApiError) {
    return new PublicApiError(error.message, error.status, {
      ...error.details,
      feature,
      provider: "gemini",
      billingStatus,
      actualCostMicros
    });
  }
  if (!(error instanceof ApplicationDocumentProviderError) && !(error instanceof GeminiProviderError)) {
    return new PublicApiError("Gemini returned an application document that could not be accepted.", 502, {
      code: "APPLICATION_DOCUMENT_PROVIDER_INVALID",
      feature,
      provider: "gemini",
      billingStatus,
      actualCostMicros,
      retryable: false
    });
  }
  if (billingStatus === "not_charged") {
    return new PublicApiError("Gemini rejected application-document generation before completion.", 502, {
      code: "APPLICATION_DOCUMENT_PROVIDER_REJECTED",
      feature,
      provider: "gemini",
      billingStatus,
      actualCostMicros: 0,
      retryable: true
    });
  }
  if (billingStatus === "uncertain") {
    return new PublicApiError(
      "Application-document generation reached Gemini, but the outcome is uncertain. Review AI usage instead of retrying.",
      503,
      {
        code: "APPLICATION_DOCUMENT_PROVIDER_UNCERTAIN",
        feature,
        provider: "gemini",
        billingStatus,
        actualCostMicros: null,
        retryable: false
      }
    );
  }
  return new PublicApiError("Gemini returned an application document that could not be accepted.", 502, {
    code: "APPLICATION_DOCUMENT_PROVIDER_INVALID",
    feature,
    provider: "gemini",
    billingStatus,
    actualCostMicros,
    retryable: false
  });
}

async function generateGuardedApplicationDocumentJson<T>({
  promptName,
  systemPrompt,
  payload,
  schema,
  responseJsonSchema,
  context,
  validate
}: GenerateJsonInput<T> & { context: AiCallContext & { feature: GuardedApplicationDocumentFeature } }) {
  const feature = context.feature;
  if (!responseJsonSchema) {
    throw new PublicApiError("Application-document Gemini schema is missing.", 503, {
      code: "APPLICATION_DOCUMENT_SCHEMA_MISSING",
      feature
    });
  }
  const { policy } = assertAiInputWithinLimits(feature, systemPrompt, {
    payload,
    responseJsonSchema
  });
  const promptVersion = context.promptVersion ?? "1";
  const requestHash = hashAiInput(promptName, promptVersion, payload);
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (getAiRuntimeMode("gemini") !== "gemini" || !apiKey) {
    throw new LocalAiUnavailableError();
  }
  const model = APPLICATION_DOCUMENT_MODEL;
  if (getModelPricing(model).provider !== "gemini") {
    throw new PublicApiError("Application-document generation requires registered Gemini pricing.", 503, {
      code: "AI_MODEL_PRICING_UNKNOWN"
    });
  }
  const maximumCostMicros = applicationDocumentMaximumCost(model, feature);
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
    thinkingLevel: APPLICATION_DOCUMENT_THINKING_LEVEL
  });
  assertConservativeApplicationDocumentWireBound(feature, policy.maxInputTokens, requestBody);

  const cached = await findCachedAiResponse({
    userId: context.userId,
    provider: "gemini",
    model,
    promptName,
    promptVersion,
    requestHash
  });
  if (cached) {
    return {
      data: validateGeneratedJson(cached.output, schema, promptName, validate),
      meta: {
        provider: "gemini" as const,
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

  if (!context.highCostConfirmed || !context.dataSharingConfirmed) {
    throw new PublicApiError(
      "Confirm sending the projected job, resume, and profile data and this AI request's maximum cost before continuing.",
      428,
      {
        code: "AI_COST_CONFIRMATION_REQUIRED",
        maximumCostMicros,
        provider: "gemini",
        dataType: "application_packet",
        feature,
        model,
        promptVersion
      }
    );
  }

  await reconcileStaleAiReservations(context.userId);
  const activePriorAttempt = await prisma.aIBudgetReservation.findFirst({
    where: {
      userId: context.userId,
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
      "An identical application-document request already reached Gemini with an uncertain outcome. Review AI usage instead of retrying.",
      409,
      { code: "APPLICATION_DOCUMENT_PRIOR_OUTCOME_UNCERTAIN", retryable: false }
    );
  }
  if (activePriorAttempt) {
    throw new PublicApiError(
      "An identical application-document request is still reserved or running. No second provider call was started.",
      409,
      { code: "AI_DUPLICATE_IN_PROGRESS", retryable: true }
    );
  }

  const reservation = await reserveAiBudget({
    userId: context.userId,
    provider: "gemini",
    model,
    feature,
    promptName,
    promptVersion,
    requestHash,
    maximumCostMicros,
    automation: context.automation ?? false
  });
  let usage: GeminiUsage | null = null;
  let actualCostMicros: number | undefined;
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
      thinkingLevel: APPLICATION_DOCUMENT_THINKING_LEVEL
    });
    usage = response.usage;
    actualCostMicros = estimatePricedCost({ model, ...usage });
    if (
      usage.inputTokens > policy.maxInputTokens ||
      usage.outputTokens > policy.maxOutputTokens ||
      actualCostMicros > reservation.maximumCostMicros
    ) {
      throw new GeminiProviderError("Gemini usage exceeded the reserved document bounds.", {
        providerResponded: true,
        usage
      });
    }
    let data: T;
    try {
      data = validateGeneratedJson(response.value, schema, promptName, validate);
    } catch (error) {
      if (error instanceof PublicApiError) throw error;
      throw new ApplicationDocumentProviderError("Gemini returned an unsupported application document.", {
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
        provider: "gemini" as const,
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
    const providerUsage = error instanceof GeminiProviderError
      ? error.usage
      : error instanceof ApplicationDocumentProviderError ? error.usage : usage;
    const providerDisposition = error instanceof GeminiProviderError
      ? error.billingDisposition
      : error instanceof ApplicationDocumentProviderError
        ? error.billingDisposition
        : providerUsage ? "known" as const : "uncertain" as const;
    const knownCost = providerUsage ? estimatePricedCost({ model, ...providerUsage }) : undefined;
    const billingStatus = requestDispatched && (
      providerDisposition === "uncertain" ||
      (knownCost !== undefined && knownCost > reservation.maximumCostMicros)
    ) ? "uncertain" as const : providerDisposition;
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
          "Application-document billing reconciliation did not complete. Review AI usage instead of retrying.",
          503,
          {
            code: "APPLICATION_DOCUMENT_RECONCILIATION_UNCERTAIN",
            feature,
            provider: "gemini",
            billingStatus: "uncertain",
            actualCostMicros: knownCost ?? null,
            retryable: false
          }
        );
      }
    }
    throw applicationDocumentPublicError(
      error,
      feature,
      billingStatus,
      billingStatus === "not_charged" ? 0 : knownCost ?? null
    );
  }
}

// Kept separate so the priced maximum output is verifiably present in the
// exact payload sent to OpenAI.
type ApplicationPlanChatRequestInput<T> = {
  model: string;
  promptName: string;
  systemPrompt: string;
  payload: unknown;
  schema?: z.ZodType<T, z.ZodTypeDef, unknown>;
  maxOutputTokens: number;
};

export function buildApplicationPlanChatRequest<T>({
  model,
  promptName,
  systemPrompt,
  payload,
  schema,
  maxOutputTokens
}: ApplicationPlanChatRequestInput<T>) {
  return {
    model,
    temperature: 0.2,
    max_tokens: maxOutputTokens,
    response_format: schema
      ? zodResponseFormat(schema, promptName.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64))
      : { type: "json_object" as const },
    messages: [
      { role: "system" as const, content: systemPrompt },
      { role: "user" as const, content: JSON.stringify(payload) }
    ]
  };
}

export function callApplicationPlanProvider<T>(
  client: Pick<OpenAI, "chat">,
  input: ApplicationPlanChatRequestInput<T>
) {
  return client.chat.completions.create(buildApplicationPlanChatRequest(input));
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
  // The new planner requires explicit provider opt-in as well as the accepted
  // AI_ENABLED/mock gates; a stored key alone must never start a paid call.
  const plannerProvider = getAiProviderForFeature("APPLICATION_PLAN");
  const client = plannerProvider === "openai" && getAiRuntimeMode("openai") === "openai"
    ? getOpenAIClient()
    : null;

  if (!client) {
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
    const response = await callApplicationPlanProvider(client, {
      model, promptName, systemPrompt, payload, schema, maxOutputTokens: policy.maxOutputTokens
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
  promptName: string,
  validate?: (value: T) => T
) {
  if (!schema) {
    const data = value as T;
    return validate ? validate(data) : data;
  }

  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`${promptName} returned JSON that did not match the expected schema.`);
  }

  return validate ? validate(parsed.data) : parsed.data;
}
