import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { z } from "zod";

import { PublicApiError } from "@/lib/api-errors";
import {
  buildKimiChatRequest,
  callKimiJsonProvider,
  KimiApiError,
  KimiInvalidUsageError,
  KimiTruncatedOutputError,
  normalizeKimiChatResponse,
  type KimiChatRequest
} from "@/lib/ai/providers/kimi";

const trackedEnvironment = ["KIMI_REASONING_EFFORT", "MOONSHOT_API_KEY"] as const;
const originalEnvironment = Object.fromEntries(trackedEnvironment.map((name) => [name, process.env[name]]));

afterEach(() => {
  for (const name of trackedEnvironment) {
    const original = originalEnvironment[name];
    if (original === undefined) delete process.env[name];
    else process.env[name] = original;
  }
});

const testSchema = z.object({ summary: z.string(), score: z.number() });

const baseInput = {
  model: "kimi-k3",
  promptName: "applicationPlanPrompt",
  systemPrompt: "Plan honestly.",
  payload: { job: "Example job", evidence: ["SQL"] },
  schema: testSchema,
  maxOutputTokens: 4_000
};

function validKimiResponse() {
  return {
    choices: [
      {
        index: 0,
        finish_reason: "stop",
        message: {
          role: "assistant",
          content: "{\"summary\":\"ok\",\"score\":1}",
          reasoning_content: "hidden chain of thought"
        }
      }
    ],
    usage: { prompt_tokens: 1_000, completion_tokens: 200, total_tokens: 1_200, cached_tokens: 300 }
  };
}

test("the request matches the exact K3 contract", () => {
  delete process.env.KIMI_REASONING_EFFORT;

  const request = buildKimiChatRequest(baseInput);
  const keys = Object.keys(request).sort();
  assert.deepEqual(keys, ["max_completion_tokens", "messages", "model", "reasoning_effort", "response_format"]);

  assert.equal(request.model, "kimi-k3");
  assert.equal(request.max_completion_tokens, 4_000);
  assert.equal(request.reasoning_effort, "low");
  assert.deepEqual(request.messages[0], { role: "system", content: "Plan honestly." });
  assert.equal(request.messages[1]?.role, "user");

  const forbidden = [
    "max_tokens",
    "temperature",
    "top_p",
    "n",
    "presence_penalty",
    "frequency_penalty",
    "thinking",
    "tools"
  ] as const;
  const asRecord = request as Record<string, unknown>;
  for (const field of forbidden) {
    assert.ok(!(field in asRecord), `forbidden field present in request: ${field}`);
  }
});

test("the request uses strict JSON Schema structured output", () => {
  const request = buildKimiChatRequest(baseInput);

  assert.equal(request.response_format.type, "json_schema");
  if (request.response_format.type !== "json_schema") return;
  assert.equal(request.response_format.json_schema.strict, true);
  assert.equal(request.response_format.json_schema.name, "applicationPlanPrompt");
  assert.ok(!("$schema" in request.response_format.json_schema.schema));
  assert.equal(request.response_format.json_schema.schema.type, "object");
});

test("reasoning effort honors low, high, and max and rejects everything else", () => {
  for (const effort of ["low", "high", "max"] as const) {
    process.env.KIMI_REASONING_EFFORT = effort;
    assert.equal(buildKimiChatRequest(baseInput).reasoning_effort, effort);
  }

  process.env.KIMI_REASONING_EFFORT = "turbo";
  assert.throws(
    () => buildKimiChatRequest(baseInput),
    (error) => error instanceof PublicApiError && error.details?.code === "AI_REASONING_EFFORT_INVALID"
  );
});

function normalizeForTest(response: unknown) {
  return normalizeKimiChatResponse(response, "applicationPlanPrompt");
}

test("finish_reason stop returns only the final message content", () => {
  const result = normalizeForTest(validKimiResponse());

  assert.equal(result.content, "{\"summary\":\"ok\",\"score\":1}");
  assert.equal(result.usageReported, true);
  assert.ok(!("reasoning_content" in result));
  assert.ok(!JSON.stringify(result).includes("hidden chain of thought"));
});

test("finish_reason length is rejected as truncated and never accepts partial content", () => {
  const response = validKimiResponse();
  response.choices[0]!.finish_reason = "length";
  response.choices[0]!.message.content = "{\"summary\":\"partial";

  assert.throws(
    () => normalizeForTest(response),
    (error) => error instanceof KimiTruncatedOutputError && error.code === "AI_KIMI_TRUNCATED_OUTPUT"
  );
});

test("tool_calls, missing, null, and unknown finish reasons are rejected", () => {
  const cases: Array<unknown> = ["tool_calls", "content_filter", null, undefined, "stop "];
  for (const finishReason of cases) {
    const response = validKimiResponse();
    if (finishReason === undefined) {
      delete (response.choices[0] as unknown as Record<string, unknown>).finish_reason;
    } else {
      response.choices[0]!.finish_reason = finishReason as string;
    }
    assert.throws(
      () => normalizeForTest(response),
      (error) => error instanceof KimiApiError && error.code === "AI_KIMI_UNEXPECTED_FINISH_REASON",
      `expected rejection for finish_reason: ${String(finishReason)}`
    );
  }

  assert.throws(
    () => normalizeForTest({ choices: [], usage: validKimiResponse().usage }),
    (error) => error instanceof KimiApiError && error.code === "AI_KIMI_UNEXPECTED_FINISH_REASON"
  );
});

test("empty final content is rejected", () => {
  const response = validKimiResponse();
  response.choices[0]!.message.content = "";
  assert.throws(
    () => normalizeForTest(response),
    (error) => error instanceof KimiApiError && error.code === "AI_KIMI_UNEXPECTED_FINISH_REASON"
  );
});


test("top-level cached_tokens is the primary cached-input source", () => {
  const response = validKimiResponse();
  (response.usage as Record<string, unknown>).prompt_tokens_details = { cached_tokens: 999 };
  const result = normalizeForTest(response);
  assert.equal(result.cachedInputTokens, 300);
  assert.equal(result.inputTokens, 1_000);
  assert.equal(result.outputTokens, 200);
});

test("OpenAI-style prompt_tokens_details.cached_tokens is the secondary fallback", () => {
  const response = validKimiResponse();
  delete (response.usage as Record<string, unknown>).cached_tokens;
  (response.usage as Record<string, unknown>).prompt_tokens_details = { cached_tokens: 450 };
  assert.equal(normalizeForTest(response).cachedInputTokens, 450);
});

test("missing cached-token fields default to zero", () => {
  const response = validKimiResponse();
  delete (response.usage as Record<string, unknown>).cached_tokens;
  assert.equal(normalizeForTest(response).cachedInputTokens, 0);
});

test("cached tokens greater than prompt tokens are rejected as invalid usage", () => {
  const response = validKimiResponse();
  response.usage.prompt_tokens = 100;
  response.usage.cached_tokens = 300;
  assert.throws(
    () => normalizeForTest(response),
    (error) => error instanceof KimiInvalidUsageError && error.code === "AI_KIMI_INVALID_USAGE"
  );
});

test("malformed usage values are never treated as valid reported usage", () => {
  const malformedValues: Array<unknown> = [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "100", null];

  for (const bad of malformedValues) {
    const badPrompt = validKimiResponse();
    badPrompt.usage.prompt_tokens = bad as number;
    assert.throws(
      () => normalizeForTest(badPrompt),
      (error) => error instanceof KimiInvalidUsageError && error.code === "AI_KIMI_INVALID_USAGE",
      `expected invalid usage for prompt_tokens=${String(bad)}`
    );

    const badCompletion = validKimiResponse();
    badCompletion.usage.completion_tokens = bad as number;
    assert.throws(
      () => normalizeForTest(badCompletion),
      (error) => error instanceof KimiInvalidUsageError && error.code === "AI_KIMI_INVALID_USAGE",
      `expected invalid usage for completion_tokens=${String(bad)}`
    );
  }

  const missingFields = validKimiResponse();
  delete (missingFields.usage as Record<string, unknown>).prompt_tokens;
  assert.throws(
    () => normalizeForTest(missingFields),
    (error) => error instanceof KimiInvalidUsageError && error.code === "AI_KIMI_INVALID_USAGE"
  );

  const badCached = validKimiResponse();
  badCached.usage.cached_tokens = "300" as unknown as number;
  assert.throws(
    () => normalizeForTest(badCached),
    (error) => error instanceof KimiInvalidUsageError && error.code === "AI_KIMI_INVALID_USAGE"
  );
});

test("a missing usage object is reported as unreported with zero placeholders", () => {
  const response = validKimiResponse();
  delete (response as Record<string, unknown>).usage;

  const result = normalizeForTest(response);
  assert.equal(result.usageReported, false);
  assert.deepEqual([result.inputTokens, result.outputTokens, result.cachedInputTokens], [0, 0, 0]);
});

test("a fake transport exercises the provider with zero network activity and no API key", async () => {
  delete process.env.MOONSHOT_API_KEY;
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    throw new Error("network access is forbidden in tests");
  }) as typeof fetch;

  try {
    const capturedRequests: KimiChatRequest[] = [];
    const result = await callKimiJsonProvider(baseInput, async (request) => {
      capturedRequests.push(request);
      return validKimiResponse();
    });

    assert.equal(fetchCalls, 0);
    assert.equal(capturedRequests.length, 1);
    const captured = capturedRequests[0];
    assert.ok(captured);
    assert.equal(captured.max_completion_tokens, 4_000);
    assert.equal(captured.reasoning_effort, "low");
    assert.equal(result.content, "{\"summary\":\"ok\",\"score\":1}");
    assert.equal(result.cachedInputTokens, 300);
    assert.equal(result.usageReported, true);

    // The existing Zod validation layer continues to validate the final parsed content.
    assert.deepEqual(testSchema.parse(JSON.parse(result.content)), { summary: "ok", score: 1 });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("the default transport fails closed when MOONSHOT_API_KEY is unset", async () => {
  delete process.env.MOONSHOT_API_KEY;
  await assert.rejects(() => callKimiJsonProvider(baseInput), /API key is unavailable/);
});

