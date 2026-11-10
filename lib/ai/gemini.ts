import { logger } from "@/lib/monitoring/logger";

type JsonSchema = Record<string, unknown>;

export type GeminiThinkingLevel = "LOW" | "MEDIUM" | "HIGH";

type GeminiJsonRequestInput = {
  systemPrompt: string;
  payload: unknown;
  responseJsonSchema: JsonSchema;
  maxOutputTokens: number;
  thinkingLevel: GeminiThinkingLevel;
};

type GeminiUsageMetadata = {
  promptTokenCount?: unknown;
  cachedContentTokenCount?: unknown;
  candidatesTokenCount?: unknown;
  thoughtsTokenCount?: unknown;
  totalTokenCount?: unknown;
};

export type GeminiUsage = {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  visibleOutputTokens: number;
  thinkingTokens: number;
};

export type GeminiBillingDisposition = "known" | "not_charged" | "uncertain";

export class GeminiProviderError extends Error {
  providerResponded: boolean;
  usage: GeminiUsage | null;
  billingDisposition: GeminiBillingDisposition;
  httpStatus: number | null;
  providerCode: string | null;
  providerReason: GeminiRejectionReason | null;
  requestId: string | null;

  constructor(message: string, options: {
    providerResponded: boolean;
    usage?: GeminiUsage | null;
    billingDisposition?: GeminiBillingDisposition;
    httpStatus?: number | null;
    providerCode?: string | null;
    providerReason?: GeminiRejectionReason | null;
    requestId?: string | null;
  }) {
    super(message);
    this.name = "GeminiProviderError";
    this.providerResponded = options.providerResponded;
    this.usage = options.usage ?? null;
    this.billingDisposition = options.billingDisposition ?? (this.usage ? "known" : "uncertain");
    this.httpStatus = options.httpStatus ?? null;
    this.providerCode = options.providerCode ?? null;
    this.providerReason = options.providerReason ?? null;
    this.requestId = options.requestId ?? null;
  }
}

// A fixed vocabulary for why Gemini rejected a request. Provider message text can echo
// request content, so it is never retained or logged; only these labels are.
export type GeminiRejectionReason = "SCHEMA_TOO_COMPLEX" | "SCHEMA_REJECTED";

function classifyGeminiRejection(message: unknown): GeminiRejectionReason | null {
  if (typeof message !== "string") return null;
  if (/too many states/i.test(message)) return "SCHEMA_TOO_COMPLEX";
  if (/response_?schema|responseJsonSchema|response_json_schema/i.test(message)) return "SCHEMA_REJECTED";
  return null;
}

const documentedGeminiSchemaKeywords = new Set([
  "type",
  "title",
  "description",
  "enum",
  "format",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "prefixItems",
  "minItems",
  "maxItems",
  "minimum",
  "maximum",
  "$ref",
  "anyOf"
]);

const localOnlySchemaKeywords = new Set(["maxLength", "pattern"]);

function geminiResponseJsonSchema(schema: JsonSchema, path = "responseJsonSchema"): JsonSchema {
  const compatible: JsonSchema = {};
  for (const [keyword, value] of Object.entries(schema)) {
    if (localOnlySchemaKeywords.has(keyword)) continue;
    if (!documentedGeminiSchemaKeywords.has(keyword)) {
      throw new GeminiProviderError(
        `Unsupported Gemini response schema keyword at ${path}.${keyword}.`,
        {
          providerResponded: false,
          billingDisposition: "not_charged",
          providerCode: "UNSUPPORTED_RESPONSE_SCHEMA"
        }
      );
    }
    if (keyword === "properties") {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        compatible[keyword] = value;
        continue;
      }
      compatible[keyword] = Object.fromEntries(
        Object.entries(value).map(([propertyName, propertySchema]) => [
          propertyName,
          propertySchema && typeof propertySchema === "object" && !Array.isArray(propertySchema)
            ? geminiResponseJsonSchema(propertySchema as JsonSchema, `${path}.properties.${propertyName}`)
            : propertySchema
        ])
      );
      continue;
    }
    if (
      (keyword === "items" || keyword === "additionalProperties") &&
      value &&
      typeof value === "object" &&
      !Array.isArray(value)
    ) {
      compatible[keyword] = geminiResponseJsonSchema(value as JsonSchema, `${path}.${keyword}`);
      continue;
    }
    if ((keyword === "prefixItems" || keyword === "anyOf") && Array.isArray(value)) {
      compatible[keyword] = value.map((item, index) =>
        item && typeof item === "object" && !Array.isArray(item)
          ? geminiResponseJsonSchema(item as JsonSchema, `${path}.${keyword}[${index}]`)
          : item
      );
      continue;
    }
    compatible[keyword] = value;
  }
  return compatible;
}

export function buildGeminiJsonRequest({
  systemPrompt,
  payload,
  responseJsonSchema,
  maxOutputTokens,
  thinkingLevel
}: GeminiJsonRequestInput) {
  return {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: "user", parts: [{ text: JSON.stringify(payload) }] }],
    generationConfig: {
      thinkingConfig: { thinkingLevel },
      maxOutputTokens,
      responseMimeType: "application/json",
      responseJsonSchema: geminiResponseJsonSchema(responseJsonSchema)
    }
  };
}

function nonnegativeInteger(value: unknown, field: string, optional = false) {
  if (optional && value === undefined) return 0;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new GeminiProviderError(`Gemini returned invalid ${field} usage.`, {
      providerResponded: true
    });
  }
  return value as number;
}

export function readGeminiUsage(metadata: GeminiUsageMetadata | undefined): GeminiUsage {
  if (!metadata) {
    throw new GeminiProviderError("Gemini returned no usage metadata.", { providerResponded: true });
  }
  const inputTokens = nonnegativeInteger(metadata.promptTokenCount, "input token");
  const cachedInputTokens = nonnegativeInteger(metadata.cachedContentTokenCount, "cached input token", true);
  const visibleOutputTokens = nonnegativeInteger(metadata.candidatesTokenCount, "candidate token");
  const thinkingTokens = nonnegativeInteger(metadata.thoughtsTokenCount, "thinking token", true);
  const totalTokenCount = nonnegativeInteger(metadata.totalTokenCount, "total token");
  if (cachedInputTokens > inputTokens || totalTokenCount < inputTokens) {
    throw new GeminiProviderError("Gemini returned inconsistent usage metadata.", {
      providerResponded: true
    });
  }

  return {
    inputTokens,
    // Gemini bills thoughts at the output rate. totalTokenCount is retained as a
    // conservative cross-check in case the provider reports additional output.
    outputTokens: Math.max(visibleOutputTokens + thinkingTokens, totalTokenCount - inputTokens),
    cachedInputTokens,
    visibleOutputTokens,
    thinkingTokens
  };
}

type GeminiJsonProviderInput = GeminiJsonRequestInput & {
  apiKey: string;
  model: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxResponseBytes?: number;
};

type GeminiResponseBody = {
  candidates?: Array<{
    finishReason?: unknown;
    content?: { parts?: Array<{ text?: unknown; thought?: unknown }> };
  }>;
  usageMetadata?: GeminiUsageMetadata;
};

function boundedProviderDiagnostic(value: unknown) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return /^[A-Za-z0-9._~:/+=-]{1,200}$/u.test(normalized) ? normalized : null;
}

function responseRequestId(response: Response) {
  return ["x-goog-request-id", "x-request-id", "x-guploader-uploadid"]
    .map((name) => boundedProviderDiagnostic(response.headers.get(name)))
    .find((value): value is string => value !== null) ?? null;
}

async function readBoundedResponseText(response: Response, maxResponseBytes: number) {
  const reader = response.body?.getReader();
  if (!reader) return { text: "", responseBytes: 0 };
  const decoder = new TextDecoder();
  let text = "";
  let responseBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        text += decoder.decode();
        return { text, responseBytes };
      }
      responseBytes += value.byteLength;
      if (responseBytes > maxResponseBytes) {
        await reader.cancel().catch(() => undefined);
        throw new GeminiProviderError("Gemini response exceeded the configured body limit.", {
          providerResponded: true,
          httpStatus: response.status,
          requestId: responseRequestId(response)
        });
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

async function readGeminiRejectionDiagnostics(response: Response) {
  const requestId = responseRequestId(response);
  let providerCode: string | null = null;
  let providerReason: GeminiRejectionReason | null = null;
  try {
    const reader = response.body?.getReader();
    let rawBody: string | null = "";
    if (reader) {
      const decoder = new TextDecoder();
      let receivedBytes = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            rawBody += decoder.decode();
            break;
          }
          receivedBytes += value.byteLength;
          if (receivedBytes > 10_000) {
            rawBody = null;
            await reader.cancel().catch(() => undefined);
            break;
          }
          rawBody += decoder.decode(value, { stream: true });
        }
      } finally {
        reader.releaseLock();
      }
    }
    if (rawBody !== null) {
      const body = JSON.parse(rawBody) as { error?: { status?: unknown; code?: unknown; message?: unknown } };
      providerCode = boundedProviderDiagnostic(body.error?.status) ??
        boundedProviderDiagnostic(body.error?.code);
      providerReason = classifyGeminiRejection(body.error?.message);
    }
  } catch {
    // Provider response bodies are never retained or surfaced; diagnostics remain optional.
  }
  return { providerCode, providerReason, requestId };
}

// Exact input-token count from Gemini's countTokens method, which is free and runs no
// generation. Returns null if the count is unavailable, so callers can fail closed.
export async function countGeminiRequestTokens({
  apiKey,
  model,
  requestBody,
  fetchImpl = fetch,
  timeoutMs = 20_000
}: {
  apiKey: string;
  model: string;
  requestBody: object;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<number | null> {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:countTokens`;
  try {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({ generateContentRequest: { model: `models/${model}`, ...requestBody } }),
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!response.ok) return null;
    const json = (await response.json().catch(() => null)) as { totalTokens?: unknown } | null;
    return typeof json?.totalTokens === "number" && Number.isSafeInteger(json.totalTokens) && json.totalTokens >= 0
      ? json.totalTokens
      : null;
  } catch {
    return null;
  }
}

export async function callGeminiJsonProvider({
  apiKey,
  model,
  fetchImpl = fetch,
  signal,
  timeoutMs = 180_000,
  maxResponseBytes = 1_000_000,
  ...requestInput
}: GeminiJsonProviderInput) {
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes <= 0) {
    throw new GeminiProviderError("Gemini response body limit is invalid.", {
      providerResponded: false,
      billingDisposition: "not_charged",
      providerCode: "INVALID_RESPONSE_BODY_LIMIT"
    });
  }
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const requestBody = JSON.stringify(buildGeminiJsonRequest(requestInput));
  const startedAt = Date.now();
  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": apiKey
      },
      body: requestBody,
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
        : AbortSignal.timeout(timeoutMs)
    });
  } catch {
    throw new GeminiProviderError("Gemini request outcome is uncertain.", {
      providerResponded: false
    });
  }

  if (!response.ok) {
    const diagnostics = await readGeminiRejectionDiagnostics(response);
    logger.warn("ai.gemini.request_rejected", {
      httpStatus: response.status,
      providerCode: diagnostics.providerCode,
      providerReason: diagnostics.providerReason,
      requestId: diagnostics.requestId
    });
    throw new GeminiProviderError(`Gemini request failed with HTTP ${response.status}.`, {
      providerResponded: true,
      billingDisposition: "not_charged",
      httpStatus: response.status,
      ...diagnostics
    });
  }

  let body: GeminiResponseBody;
  let responseBytes = 0;
  try {
    const bounded = await readBoundedResponseText(response, maxResponseBytes);
    responseBytes = bounded.responseBytes;
    body = JSON.parse(bounded.text) as GeminiResponseBody;
  } catch (error) {
    if (error instanceof GeminiProviderError) throw error;
    throw new GeminiProviderError("Gemini returned an invalid response envelope.", {
      providerResponded: true,
      httpStatus: response.status,
      requestId: responseRequestId(response)
    });
  }

  let usage: GeminiUsage;
  try {
    usage = readGeminiUsage(body.usageMetadata);
  } catch (error) {
    if (error instanceof GeminiProviderError) {
      throw new GeminiProviderError(error.message, {
        providerResponded: error.providerResponded,
        usage: error.usage,
        billingDisposition: error.billingDisposition,
        httpStatus: response.status,
        providerCode: error.providerCode,
        requestId: responseRequestId(response)
      });
    }
    throw error;
  }
  const candidate = body.candidates?.[0];
  if (candidate?.finishReason !== "STOP") {
    throw new GeminiProviderError(
      `Gemini did not complete the structured response (finish reason: ${String(candidate?.finishReason ?? "missing")}).`,
      { providerResponded: true, usage, httpStatus: response.status, requestId: responseRequestId(response) }
    );
  }
  const text = candidate.content?.parts
    ?.filter((part) => part.thought !== true)
    .map((part) => typeof part.text === "string" ? part.text : "")
    .join("") ?? "";
  if (!text) {
    throw new GeminiProviderError("Gemini returned an empty structured response.", {
      providerResponded: true,
      usage,
      httpStatus: response.status,
      requestId: responseRequestId(response)
    });
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new GeminiProviderError("Gemini returned invalid structured JSON.", {
      providerResponded: true,
      usage,
      httpStatus: response.status,
      requestId: responseRequestId(response)
    });
  }

  return {
    value,
    usage,
    finishReason: "STOP" as const,
    responseBytes,
    elapsedMs: Date.now() - startedAt,
    requestId: responseRequestId(response)
  };
}
