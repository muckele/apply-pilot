import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";

import { generateJson, getOpenAIClient } from "@/lib/ai/client";
import { planApplication } from "@/lib/ai/application-plan";
import { prisma } from "@/lib/prisma";

const controlledKeys = [
  "AI_ENABLED",
  "AI_MOCK_MODE",
  "AI_PROVIDER",
  "AI_PROVIDER_OVERRIDES",
  "OPENAI_API_KEY",
  "OPENAI_MOCK_MODE"
] as const;

function stub(t: TestContext, owner: object, name: string, replacement: unknown) {
  const methods = owner as Record<string, unknown>;
  const original = methods[name];
  methods[name] = replacement;
  t.after(() => { methods[name] = original; });
}

test("application planning stays local even when provider overrides and a key are configured", async (t) => {
  const previous = Object.fromEntries(controlledKeys.map((key) => [key, process.env[key]]));
  try {
    process.env.AI_PROVIDER = "openai";
    process.env.AI_PROVIDER_OVERRIDES = "APPLICATION_PLAN:openai";
    process.env.OPENAI_API_KEY = "synthetic-never-call";
    process.env.OPENAI_MOCK_MODE = "false";
    process.env.AI_ENABLED = "true";
    process.env.AI_MOCK_MODE = "false";
    const client = getOpenAIClient();
    assert.ok(client);
    let providerCalls = 0;
    let budgetReads = 0;
    stub(t, client.chat.completions, "create", async () => {
      providerCalls++;
      throw new Error("OpenAI must not be called for local rule-based planning");
    });
    stub(t, prisma.aISettings, "upsert", async () => {
      budgetReads++;
      throw new Error("Local rule-based planning must not read the AI budget");
    });

    const result = await generateJson({
      promptName: "applicationPlanPrompt",
      systemPrompt: "Return only supported evidence.",
      payload: { job: "synthetic" },
      fallback: { safe: true },
      context: { userId: "synthetic-user", feature: "APPLICATION_PLAN" }
    });
    assert.deepEqual(result.data, { safe: true });
    assert.equal(result.meta.provider, "local");
    assert.equal(result.meta.model, "heuristic-local");
    assert.equal(result.meta.mocked, true);

    const plan = await planApplication({
      job: {
        title: "Synthetic Engineer",
        company: "Synthetic Co",
        description: "Build verified TypeScript services.",
        requirements: ["TypeScript"]
      },
      resume: { skills: ["TypeScript"] }
    });
    assert.equal(plan.provider, "local");
    assert.equal(plan.model, "heuristic-local");
    assert.deepEqual({ providerCalls, budgetReads }, { providerCalls: 0, budgetReads: 0 });
  } finally {
    for (const key of controlledKeys) {
      const value = previous[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
