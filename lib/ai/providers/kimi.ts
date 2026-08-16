import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import type { z } from "zod";

import { getKimiReasoningEffort, resolveKimiApiKey, type KimiReasoningEffort } from "@/lib/ai/config";
import type { ProviderJsonResult } from "@/lib/ai/providers";

// Official Kimi (Moonshot) OpenAI-compatible endpoint. Hardcoded by policy: the
// production endpoint is not configurable, and no NEXT_PUBLIC_ variable may carry it.
const KIMI_BASE_URL = "https://api.moonshot.ai/v1";

export class KimiApiError extends Error {
  code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = "KimiApiError";
    this.code = code;
  }
}

// finish_reason "length": the response was cut off. Partial content must never be
// parsed or accepted, so this is raised before message.content is read.
export class KimiTruncatedOutputError extends KimiApiError {
  constructor(promptName: string) {
    super(
      `${promptName} was truncated by Kimi (finish_reason "length"). The partial response was discarded.`,
      "AI_KIMI_TRUNCATED_OUTPUT"
    );
    this.name = "KimiTruncatedOutputError";
  }
}

// A malformed usage object must never be reconciled as zero cost. Throwing here routes
// the reservation through the existing UNCERTAIN path, which treats it as fully spent.
export class KimiInvalidUsageError extends KimiApiError {
  constructor(detail: string) {
    super(
      `Kimi reported malformed usage (${detail}). The reservation is treated as fully spent.`,
      "AI_KIMI_INVALID_USAGE"
    );
    this.name = "KimiInvalidUsageError";
  }
}

type KimiJsonSchemaFormat = {
  type: "json_schema";
  json_schema: { name: string; strict: true; schema: Record<string, unknown> };
};

// The exact K3 request contract. Only these fields may be sent: model, messages,
// max_completion_tokens, reasoning_effort, response_format. Forbidden fields
// (max_tokens, temperature, top_p, n, presence_penalty, frequency_penalty, thinking,
// tools) are absent by construction and asserted absent by tests.
export type KimiChatRequest = {
  model: string;
  messages: Array<{ role: "system" | "user"; content: string }>;
  max_completion_tokens: number;
  reasoning_effort: KimiReasoningEffort;
  response_format: KimiJsonSchemaFormat | { type: "json_object" };
};

type KimiChatRequestInput<T> = {
  model: string;
  promptName: string;
  systemPrompt: string;
  payload: unknown;
  schema?: z.ZodType<T, z.ZodTypeDef, unknown>;
  maxOutputTokens: number;
};

function sanitizeSchemaName(promptName: string) {
  return promptName.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

function kimiResponseFormat<T>(
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  promptName: string
): KimiJsonSchemaFormat {
  const name = sanitizeSchemaName(promptName);
  const format = zodResponseFormat(schema, name);
  const jsonSchema = { ...(format.json_schema.schema as Record<string, unknown>) };
  delete jsonSchema.$schema;
  return { type: "json_schema", json_schema: { name, strict: true, schema: jsonSchema } };
}

export function buildKimiChatRequest<T>({
  model,
  promptName,
  systemPrompt,
  payload,
  schema,
  maxOutputTokens
}: KimiChatRequestInput<T>): KimiChatRequest {
  return {
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: JSON.stringify(payload) }
    ],
    max_completion_tokens: maxOutputTokens,
    reasoning_effort: getKimiReasoningEffort(),
    response_format: schema ? kimiResponseFormat(schema, promptName) : { type: "json_object" }
  };
}

type KimiUsageShape = {
  prompt_tokens?: unknown;
  completion_tokens?: unknown;
  total_tokens?: unknown;
  cached_tokens?: unknown;
  prompt_tokens_details?: { cached_tokens?: unknown } | null;
};

type KimiChatResponseShape = {
  choices?: Array<{
    finish_reason?: unknown;
    message?: { content?: unknown } | null;
  }> | null;
  usage?: KimiUsageShape | null;
};

function isValidTokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

export function normalizeKimiChatResponse(response: unknown, promptName: string): ProviderJsonResult {
  const root = (response ?? {}) as KimiChatResponseShape;
  const choice = root.choices?.[0];
  if (!choice) {
    throw new KimiApiError(`${promptName} returned no choices.`, "AI_KIMI_UNEXPECTED_FINISH_REASON");
  }

  // Only finish_reason "stop" is accepted. "length" is a dedicated truncation error;
  // tool_calls, missing/null, and unknown values are all rejected before any content
  // is read, so partial output can never be accepted.
  const finishReason = choice.finish_reason;
  if (finishReason !== "stop") {
    if (finishReason === "length") {
      throw new KimiTruncatedOutputError(promptName);
    }
    throw new KimiApiError(
      `${promptName} ended with unsupported finish_reason ${JSON.stringify(finishReason ?? null)}.`,
      "AI_KIMI_UNEXPECTED_FINISH_REASON"
    );
  }

  // Only the final message content is read. reasoning_content is never parsed,
  // returned, logged, cached, or persisted.
  const content = choice.message?.content;
  if (typeof content !== "string" || !content) {
    throw new KimiApiError(`${promptName} returned an empty response.`, "AI_KIMI_UNEXPECTED_FINISH_REASON");
  }

  // Usage accounting fails closed. Absent usage marks the call as unreported so the
  // existing client path charges the full reservation. Malformed usage throws
  // AI_KIMI_INVALID_USAGE, which the client reconciles as UNCERTAIN (fully spent).
  const usage = root.usage;
  if (usage == null) {
    return { content, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, usageReported: false };
  }
  if (!isValidTokenCount(usage.prompt_tokens) || !isValidTokenCount(usage.completion_tokens)) {
    throw new KimiInvalidUsageError("prompt_tokens and completion_tokens must be nonnegative integers");
  }

  // usage.cached_tokens is the primary source; prompt_tokens_details.cached_tokens is
  // the secondary compatibility fallback only when the top-level field is absent.
  let cachedRaw: unknown = 0;
  if (usage.cached_tokens !== undefined && usage.cached_tokens !== null) {
    cachedRaw = usage.cached_tokens;
  } else if (usage.prompt_tokens_details?.cached_tokens !== undefined && usage.prompt_tokens_details.cached_tokens !== null) {
    cachedRaw = usage.prompt_tokens_details.cached_tokens;
  }
  if (!isValidTokenCount(cachedRaw)) {
    throw new KimiInvalidUsageError("cached_tokens must be a nonnegative integer");
  }
  if (cachedRaw > usage.prompt_tokens) {
    throw new KimiInvalidUsageError("cached_tokens exceeds prompt_tokens");
  }

  return {
    content,
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
    cachedInputTokens: cachedRaw,
    usageReported: true
  };
}

export type KimiTransport = (request: KimiChatRequest) => Promise<unknown>;

let kimiClient: OpenAI | null = null;

function getKimiClient() {
  const apiKey = resolveKimiApiKey();
  if (!apiKey) return null;
  kimiClient ??= new OpenAI({ apiKey, baseURL: KIMI_BASE_URL, maxRetries: 0, timeout: 60_000 });
  return kimiClient;
}

const sdkTransport: KimiTransport = async (request) => {
  const client = getKimiClient();
  if (!client) throw new Error("kimi is enabled but its API key is unavailable.");
  return client.chat.completions.create(
    request as unknown as Parameters<typeof client.chat.completions.create>[0]
  );
};

// The transport seam keeps tests fully offline: a fake transport exercises the
// provider without any network activity or API key.
export async function callKimiJsonProvider<T>(
  input: KimiChatRequestInput<T>,
  transport: KimiTransport = sdkTransport
): Promise<ProviderJsonResult> {
  const response = await transport(buildKimiChatRequest(input));
  return normalizeKimiChatResponse(response, input.promptName);
}

