import assert from "node:assert/strict";
import { test } from "node:test";

import type OpenAI from "openai";

import { callApplicationPlanProvider, generateJson } from "@/lib/ai/client";
import { AI_FEATURE_POLICIES } from "@/lib/ai/policy";

const controlledKeys = [
  "AI_ENABLED",
  "AI_MOCK_MODE",
  "AI_PROVIDER",
  "AI_PROVIDER_OVERRIDES",
  "OPENAI_API_KEY",
  "OPENAI_MOCK_MODE"
] as const;

test("a stored key cannot activate paid application planning while AI is local", async () => {
  const previous = Object.fromEntries(controlledKeys.map((key) => [key, process.env[key]]));
  try {
    process.env.AI_PROVIDER = "openai";
    process.env.AI_PROVIDER_OVERRIDES = "";
    process.env.OPENAI_API_KEY = "synthetic-never-call";
    process.env.OPENAI_MOCK_MODE = "false";

    for (const [enabled, mock] of [
      ["false", "false"],
      ["true", "true"]
    ] as const) {
      process.env.AI_ENABLED = enabled;
      process.env.AI_MOCK_MODE = mock;
      const result = await generateJson({
        promptName: "applicationPlanPrompt",
        systemPrompt: "Return only supported evidence.",
        payload: { job: "synthetic" },
        fallback: { safe: true },
        context: { userId: "synthetic-user", feature: "APPLICATION_PLAN" }
      });
      assert.deepEqual(result.data, { safe: true });
      assert.equal(result.meta.provider, "local");
      assert.equal(result.meta.mocked, true);
    }

    delete process.env.AI_PROVIDER;
    process.env.AI_ENABLED = "true";
    process.env.AI_MOCK_MODE = "false";
    const noProviderOptIn = await generateJson({
      promptName: "applicationPlanPrompt",
      systemPrompt: "Return only supported evidence.",
      payload: { job: "synthetic" },
      fallback: { safe: true },
      context: { userId: "synthetic-user", feature: "APPLICATION_PLAN" }
    });
    assert.equal(noProviderOptIn.meta.provider, "local");
  } finally {
    for (const key of controlledKeys) {
      const value = previous[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("the mocked planner client receives the priced output-token cap", async () => {
  let sent: unknown;
  const mockClient = {
    chat: {
      completions: {
        create: async (request: unknown) => {
          sent = request;
          return { choices: [] };
        }
      }
    }
  } as unknown as Pick<OpenAI, "chat">;

  await callApplicationPlanProvider(mockClient, {
    model: "gpt-4o-mini",
    promptName: "applicationPlanPrompt",
    systemPrompt: "Return an evidence-backed plan.",
    payload: { job: "synthetic" },
    maxOutputTokens: AI_FEATURE_POLICIES.APPLICATION_PLAN.maxOutputTokens
  });

  const request = sent as {
    model: string;
    max_tokens: number;
    messages: Array<{ role: string; content: string }>;
  };
  assert.equal(request.model, "gpt-4o-mini");
  assert.equal(request.max_tokens, 4_000);
  assert.equal(request.messages[1]?.role, "user");
  assert.equal(request.messages[1]?.content, '{"job":"synthetic"}');
});
