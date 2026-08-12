import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import type { z } from "zod";

import {
  assertAiBudgetAvailable,
  estimateAiCostMicros,
  hashAiInput,
  recordAiUsage
} from "@/lib/ai/usage";

let openai: OpenAI | null = null;

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
};

export type GeneratedJsonResult<T> = {
  data: T;
  meta: {
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
  fallback: T;
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
  const client = getOpenAIClient();
  const promptVersion = context?.promptVersion ?? "1";
  const requestHash = hashAiInput(promptName, promptVersion, payload);

  if (!client || process.env.OPENAI_MOCK_MODE === "true") {
    return {
      data: validateGeneratedJson(fallback, schema, promptName),
      meta: {
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
