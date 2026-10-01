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
