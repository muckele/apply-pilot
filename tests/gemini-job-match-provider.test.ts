import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildGeminiJsonRequest,
  callGeminiJsonProvider,
  GeminiProviderError,
  readGeminiUsage
} from "@/lib/ai/gemini";

const responseSchema = {
  type: "object",
  additionalProperties: false,
  properties: { value: { type: "string" } },
  required: ["value"]
};

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

function assertOnlyDocumentedSchemaKeywords(value: unknown, path = "responseJsonSchema") {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  for (const [key, entry] of Object.entries(value)) {
    assert.ok(documentedGeminiSchemaKeywords.has(key), `undocumented schema keyword at ${path}.${key}`);
    if (key === "properties" && entry && typeof entry === "object" && !Array.isArray(entry)) {
      for (const [propertyName, propertySchema] of Object.entries(entry)) {
        assertOnlyDocumentedSchemaKeywords(propertySchema, `${path}.properties.${propertyName}`);
      }
      continue;
    }
    if (key === "items" || key === "additionalProperties") {
      assertOnlyDocumentedSchemaKeywords(entry, `${path}.${key}`);
      continue;
    }
    if (key === "prefixItems" && Array.isArray(entry)) {
      entry.forEach((item, index) => assertOnlyDocumentedSchemaKeywords(item, `${path}.prefixItems[${index}]`));
    }
    if (key === "anyOf" && Array.isArray(entry)) {
      entry.forEach((item, index) => assertOnlyDocumentedSchemaKeywords(item, `${path}.anyOf[${index}]`));
    }
  }
}

test("Gemini JOB_MATCH request pins medium thinking, structured JSON and the priced output ceiling", () => {
  const request = buildGeminiJsonRequest({
    systemPrompt: "Use only submitted evidence.",
    payload: { job: "synthetic" },
    responseJsonSchema: responseSchema,
    maxOutputTokens: 8_192,
    thinkingLevel: "MEDIUM"
  });

  assert.deepEqual(request, {
    systemInstruction: { parts: [{ text: "Use only submitted evidence." }] },
    contents: [{ role: "user", parts: [{ text: '{"job":"synthetic"}' }] }],
    generationConfig: {
      thinkingConfig: { thinkingLevel: "MEDIUM" },
      maxOutputTokens: 8_192,
      responseMimeType: "application/json",
      responseJsonSchema: responseSchema
    }
  });
});

test("Gemini wire schema removes local-only string constraints at every nested level", () => {
  const localSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
      label: { type: "string", maxLength: 100, pattern: "^[A-Z]+$" },
      groups: {
        type: "array",
        minItems: 1,
        maxItems: 3,
        items: {
          type: "object",
          properties: {
            score: { type: "number", minimum: 0, maximum: 1 },
            value: { type: ["string", "null"], maxLength: 2_000 }
          },
          required: ["score", "value"]
        }
      }
    },
    required: ["label", "groups"]
  };

  const request = buildGeminiJsonRequest({
    systemPrompt: "Use only submitted evidence.",
    payload: { job: "synthetic" },
    responseJsonSchema: localSchema,
    maxOutputTokens: 8_192,
    thinkingLevel: "MEDIUM"
  });
  const wireSchema = request.generationConfig.responseJsonSchema;

  assertOnlyDocumentedSchemaKeywords(wireSchema);
  assert.equal("maxLength" in localSchema.properties.label, true);
  assert.equal("pattern" in localSchema.properties.label, true);
  assert.deepEqual(wireSchema, {
    type: "object",
    additionalProperties: false,
    properties: {
      label: { type: "string" },
      groups: {
        type: "array",
        minItems: 1,
        maxItems: 3,
        items: {
          type: "object",
          properties: {
            score: { type: "number", minimum: 0, maximum: 1 },
            value: { type: ["string", "null"] }
          },
          required: ["score", "value"]
        }
      }
    },
    required: ["label", "groups"]
  });
});

test("Gemini wire schema rejects undocumented keywords instead of silently broadening them", () => {
  assert.throws(() => buildGeminiJsonRequest({
    systemPrompt: "Use only submitted evidence.",
    payload: { job: "synthetic" },
    responseJsonSchema: {
      type: "object",
      properties: { value: { type: "string", minLength: 1 } },
      required: ["value"]
    },
    maxOutputTokens: 8_192,
    thinkingLevel: "MEDIUM"
  }), /unsupported Gemini response schema keyword.*minLength/i);
});

test("Gemini wire schema preserves documented anyOf branches and adapts them recursively", () => {
  const request = buildGeminiJsonRequest({
    systemPrompt: "Use only submitted evidence.",
    payload: { job: "synthetic" },
    responseJsonSchema: {
      anyOf: [
        { type: "string", maxLength: 100 },
        {
          type: "object",
          properties: { label: { type: "string", pattern: "^[A-Z]+$" } },
          required: ["label"]
        }
      ]
    },
    maxOutputTokens: 8_192,
    thinkingLevel: "MEDIUM"
  });

  assert.deepEqual(request.generationConfig.responseJsonSchema, {
    anyOf: [
      { type: "string" },
      {
        type: "object",
        properties: { label: { type: "string" } },
        required: ["label"]
      }
    ]
  });
});

test("Gemini schema preflight failures remain definitely uncharged without transport", async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    return new Response("{}", { status: 200 });
  };

  await assert.rejects(callGeminiJsonProvider({
    apiKey: "synthetic-secret",
    model: "gemini-3.5-flash-lite",
    systemPrompt: "test",
    payload: { resumeText: "synthetic" },
    responseJsonSchema: {
      type: "object",
      properties: { value: { type: "string", minLength: 1 } },
      required: ["value"]
    },
    maxOutputTokens: 16_000,
    thinkingLevel: "LOW",
    fetchImpl
  }), (error: unknown) => {
    assert.ok(error instanceof GeminiProviderError);
    assert.equal(error.providerResponded, false);
    assert.equal(error.billingDisposition, "not_charged");
    assert.equal(error.providerCode, "UNSUPPORTED_RESPONSE_SCHEMA");
    return true;
  });
  assert.equal(calls, 0);
});

test("Gemini usage bills visible and thinking tokens without double-counting cached input", () => {
  assert.deepEqual(readGeminiUsage({
    promptTokenCount: 1_000,
    cachedContentTokenCount: 300,
    candidatesTokenCount: 400,
    thoughtsTokenCount: 600,
    totalTokenCount: 2_000
  }), {
    inputTokens: 1_000,
    outputTokens: 1_000,
    cachedInputTokens: 300,
    visibleOutputTokens: 400,
    thinkingTokens: 600
  });

  assert.deepEqual(readGeminiUsage({
    promptTokenCount: 1_000,
    candidatesTokenCount: 400,
    totalTokenCount: 1_650
  }), {
    inputTokens: 1_000,
    outputTokens: 650,
    cachedInputTokens: 0,
    visibleOutputTokens: 400,
    thinkingTokens: 0
  });
});

test("Gemini provider makes one request, never retries, and accepts only STOP with usage", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    requests.push({ url: String(url), init });
    return new Response(JSON.stringify({
      candidates: [{
        finishReason: "STOP",
        content: { parts: [{ text: '{"value":"ok"}' }] }
      }],
      usageMetadata: {
        promptTokenCount: 100,
        candidatesTokenCount: 20,
        thoughtsTokenCount: 30,
        totalTokenCount: 150
      }
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  const result = await callGeminiJsonProvider({
    apiKey: "synthetic-secret",
    model: "gemini-3.8-flash",
    systemPrompt: "Use only submitted evidence.",
    payload: { job: "synthetic" },
    responseJsonSchema: responseSchema,
    maxOutputTokens: 8_192,
    thinkingLevel: "MEDIUM",
    fetchImpl
  });

  assert.deepEqual(result.value, { value: "ok" });
  assert.equal(result.finishReason, "STOP");
  assert.equal(result.usage.outputTokens, 50);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url,
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent");
  assert.equal(new Headers(requests[0].init?.headers).get("x-goog-api-key"), "synthetic-secret");
  assert.doesNotMatch(requests[0].url, /synthetic-secret/);
});

test("Gemini provider fails closed on truncation, missing usage and HTTP errors without retry", async () => {
  for (const response of [
    new Response(JSON.stringify({
      candidates: [{ finishReason: "MAX_TOKENS", content: { parts: [{ text: "{}" }] } }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 10, totalTokenCount: 20 }
    }), { status: 200 }),
    new Response(JSON.stringify({
      candidates: [{ finishReason: "STOP", content: { parts: [{ text: "{}" }] } }]
    }), { status: 200 }),
    new Response(JSON.stringify({ error: { message: "private provider detail" } }), { status: 503 })
  ]) {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      return response;
    };
    await assert.rejects(callGeminiJsonProvider({
      apiKey: "synthetic-secret",
      model: "gemini-3.8-flash",
      systemPrompt: "test",
      payload: {},
      responseJsonSchema: responseSchema,
      maxOutputTokens: 8_192,
      thinkingLevel: "MEDIUM",
      fetchImpl
    }), /Gemini/);
    assert.equal(calls, 1);
  }
});

test("a non-JSON Gemini HTTP rejection is definitely not charged and never retried", async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    return new Response("upstream unavailable", { status: 503 });
  };

  await assert.rejects(callGeminiJsonProvider({
    apiKey: "synthetic-secret",
    model: "gemini-3.8-flash",
    systemPrompt: "test",
    payload: {},
    responseJsonSchema: responseSchema,
    maxOutputTokens: 8_192,
    thinkingLevel: "MEDIUM",
    fetchImpl
  }), (error: unknown) => {
    assert.ok(error instanceof GeminiProviderError);
    assert.equal(error.billingDisposition, "not_charged");
    assert.equal(error.usage, null);
    assert.match(error.message, /HTTP 503/);
    return true;
  });
  assert.equal(calls, 1);
});

test("Gemini HTTP rejection retains only bounded status, code, and request ID diagnostics", async () => {
  const privateDetail = "private resume content and synthetic-secret";
  const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({
    error: {
      code: 400,
      status: "INVALID_ARGUMENT",
      message: privateDetail
    }
  }), {
    status: 400,
    headers: { "x-goog-request-id": "request_ABC-123" }
  });

  await assert.rejects(callGeminiJsonProvider({
    apiKey: "synthetic-secret",
    model: "gemini-3.5-flash-lite",
    systemPrompt: "test",
    payload: { resumeText: privateDetail },
    responseJsonSchema: responseSchema,
    maxOutputTokens: 16_000,
    thinkingLevel: "LOW",
    fetchImpl
  }), (error: unknown) => {
    assert.ok(error instanceof GeminiProviderError);
    assert.equal(error.httpStatus, 400);
    assert.equal(error.providerCode, "INVALID_ARGUMENT");
    assert.equal(error.requestId, "request_ABC-123");
    assert.doesNotMatch(error.message, /private resume content|synthetic-secret/);
    return true;
  });
});

test("Gemini rejection diagnostics cancel an oversized body instead of buffering it", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("x".repeat(10_001)));
      setTimeout(() => {
        if (!cancelled) controller.close();
      }, 25);
    },
    cancel() {
      cancelled = true;
    }
  });
  const fetchImpl: typeof fetch = async () => new Response(body, {
    status: 400,
    headers: { "x-goog-request-id": "request_ABC-123" }
  });

  await assert.rejects(callGeminiJsonProvider({
    apiKey: "synthetic-secret",
    model: "gemini-3.5-flash-lite",
    systemPrompt: "test",
    payload: { resumeText: "synthetic" },
    responseJsonSchema: responseSchema,
    maxOutputTokens: 16_000,
    thinkingLevel: "LOW",
    fetchImpl
  }), (error: unknown) => {
    assert.ok(error instanceof GeminiProviderError);
    assert.equal(error.providerCode, null);
    assert.equal(error.requestId, "request_ABC-123");
    return true;
  });
  assert.equal(cancelled, true);
});
