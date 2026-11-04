import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";

import { planApplication } from "@/lib/ai/application-plan";
import { prisma } from "@/lib/prisma";

const fixture = {
  job: {
    title: "Synthetic Engineer",
    company: "Synthetic Co",
    description: "Build verified TypeScript services.",
    requirements: ["TypeScript"]
  },
  resume: { skills: ["TypeScript"] }
};

function setEnv(t: TestContext, changes: Record<string, string | undefined>) {
  for (const [name, value] of Object.entries(changes)) {
    const previous = process.env[name];
    t.after(() => { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; });
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
}

function stub(t: TestContext, owner: object, name: string, replacement: unknown) {
  const methods = owner as Record<string, unknown>;
  const original = methods[name];
  methods[name] = replacement;
  t.after(() => { methods[name] = original; });
}

function forbidProviderAndBudget(t: TestContext) {
  const counts = { providerCalls: 0, budgetReads: 0 };
  stub(t, globalThis, "fetch", async () => {
    counts.providerCalls++;
    throw new Error("No provider may be called for local rule-based planning");
  });
  stub(t, prisma.aISettings, "upsert", async () => {
    counts.budgetReads++;
    throw new Error("Local rule-based planning must not read the AI budget");
  });
  return counts;
}

test("without Gemini, planning is local, free, and ignores a stored OpenAI key", async (t) => {
  setEnv(t, {
    AI_ENABLED: "false",
    AI_MOCK_MODE: "false",
    AI_PROVIDER: undefined,
    GEMINI_API_KEY: undefined,
    OPENAI_API_KEY: "synthetic-never-call",
    OPENAI_MOCK_MODE: "false"
  });
  const counts = forbidProviderAndBudget(t);

  const plan = await planApplication(fixture, "synthetic-user", { automation: true });

  assert.equal(plan.provider, "local");
  assert.equal(plan.model, "heuristic-local");
  assert.equal(plan.usage.estimatedCostMicros, 0);
  assert.deepEqual(counts, { providerCalls: 0, budgetReads: 0 });
});

test("retired provider selections cannot route planning to OpenAI or Kimi", async (t) => {
  setEnv(t, {
    AI_ENABLED: "true",
    AI_MOCK_MODE: "false",
    AI_PROVIDER: "openai",
    AI_PROVIDER_OVERRIDES: "APPLICATION_PLAN:kimi",
    GEMINI_API_KEY: undefined,
    OPENAI_API_KEY: "synthetic-never-call",
    MOONSHOT_API_KEY: "synthetic-never-call"
  });
  const counts = forbidProviderAndBudget(t);

  const plan = await planApplication(fixture, "synthetic-user", { automation: true });

  assert.equal(plan.provider, "local");
  assert.deepEqual(counts, { providerCalls: 0, budgetReads: 0 });
});
