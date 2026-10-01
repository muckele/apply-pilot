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

  constructor(message: string, options: {
    providerResponded: boolean;
    usage?: GeminiUsage | null;
    billingDisposition?: GeminiBillingDisposition;
  }) {
    super(message);
    this.name = "GeminiProviderError";
    this.providerResponded = options.providerResponded;
    this.usage = options.usage ?? null;
    this.billingDisposition = options.billingDisposition ?? (this.usage ? "known" : "uncertain");
  }
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
      responseJsonSchema
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
  timeoutMs?: number;
};

type GeminiResponseBody = {
  candidates?: Array<{
    finishReason?: unknown;
    content?: { parts?: Array<{ text?: unknown; thought?: unknown }> };
  }>;
  usageMetadata?: GeminiUsageMetadata;
};

export async function callGeminiJsonProvider({
  apiKey,
  model,
  fetchImpl = fetch,
  timeoutMs = 180_000,
  ...requestInput
}: GeminiJsonProviderInput) {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": apiKey
      },
      body: JSON.stringify(buildGeminiJsonRequest(requestInput)),
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch {
    throw new GeminiProviderError("Gemini request outcome is uncertain.", {
      providerResponded: false
    });
  }

  if (!response.ok) {
    throw new GeminiProviderError(`Gemini request failed with HTTP ${response.status}.`, {
      providerResponded: true,
      billingDisposition: "not_charged"
    });
  }

  let body: GeminiResponseBody;
  try {
    body = await response.json() as GeminiResponseBody;
  } catch {
    throw new GeminiProviderError("Gemini returned an invalid response envelope.", {
      providerResponded: true
    });
  }

  const usage = readGeminiUsage(body.usageMetadata);
  const candidate = body.candidates?.[0];
  if (candidate?.finishReason !== "STOP") {
    throw new GeminiProviderError(
      `Gemini did not complete the structured response (finish reason: ${String(candidate?.finishReason ?? "missing")}).`,
      { providerResponded: true, usage }
    );
  }
  const text = candidate.content?.parts
    ?.filter((part) => part.thought !== true)
    .map((part) => typeof part.text === "string" ? part.text : "")
    .join("") ?? "";
  if (!text) {
    throw new GeminiProviderError("Gemini returned an empty structured response.", {
      providerResponded: true,
      usage
    });
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new GeminiProviderError("Gemini returned invalid structured JSON.", {
      providerResponded: true,
      usage
    });
  }

  return { value, usage, finishReason: "STOP" as const };
}
