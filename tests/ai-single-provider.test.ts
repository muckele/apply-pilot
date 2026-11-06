import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test, type TestContext } from "node:test";

import { PublicApiError } from "@/lib/api-errors";
import * as config from "@/lib/ai/config";
import { getAiPricingStatus, MODEL_PRICING_REGISTRY } from "@/lib/ai/pricing";
import { aiSettingsUpdateSchema, effectiveMonthlyBudgetCents } from "@/lib/ai/settings";
import * as usage from "@/lib/ai/usage";
import * as ledger from "@/lib/ai/application-plan-budget";
import { prisma } from "@/lib/prisma";

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

test("Gemini is the default and only global AI provider", (t) => {
  setEnv(t, { AI_PROVIDER: undefined });
  assert.equal(config.getAiProviderName(), "gemini");
  process.env.AI_PROVIDER = "gemini";
  assert.equal(config.getAiProviderName(), "gemini");
  for (const retired of ["openai", "kimi", "typo"]) {
    process.env.AI_PROVIDER = retired;
    assert.throws(
      () => config.getAiProviderName(),
      (error: unknown) => error instanceof PublicApiError && error.status === 503 &&
        error.details?.code === "AI_PROVIDER_UNSUPPORTED",
      retired
    );
  }
});

test("Kimi and OpenAI configuration is retired from config and pricing", () => {
  const exported = Object.keys(config);
  for (const retired of ["getKimiReasoningEffort", "resolveKimiApiKey", "KIMI_REASONING_EFFORTS", "getOpenAIModel", "getAllowedOpenAIModels", "parseAiProviderOverrides"]) {
    assert.ok(!exported.includes(retired), `${retired} must not be exported`);
  }
  for (const [model, pricing] of Object.entries(MODEL_PRICING_REGISTRY)) {
    assert.equal(pricing.provider, "gemini", model);
  }
});

test("allowed model overrides are Gemini-only and ignore the legacy OpenAI allowlist", (t) => {
  setEnv(t, {
    AI_PROVIDER: undefined,
    AI_ALLOWED_MODELS: "gemini-3.5-flash,gpt-4o-mini,kimi-k3",
    OPENAI_ALLOWED_MODELS: "gpt-4o-mini",
    GEMINI_FAST_MODEL: undefined,
    GEMINI_QUALITY_MODEL: undefined
  });
  const models = config.getAllowedAiModels();
  assert.ok(models.includes("gemini-3.5-flash"));
  assert.ok(models.every((model) => model.startsWith("gemini-")));
  process.env.AI_ALLOWED_MODELS = "";
  assert.ok(!config.getAllowedAiModels().includes("gpt-4o-mini"));
});

test("pricing expiry is reported for every registered Gemini model without extending it", () => {
  const current = getAiPricingStatus(new Date("2026-10-15T00:00:00.000Z"));
  const flash = current.find((entry) => entry.model === "gemini-3.8-flash");
  assert.ok(flash);
  assert.equal(flash.validFrom, "2026-10-01T00:00:00.000Z");
  assert.equal(flash.validUntil, "2027-04-01T00:00:00.000Z");
  assert.equal(flash.status, "current");
  assert.equal(flash.daysRemaining, 168);

  // A registered price change is not an expiry: coverage runs to the last window's end.
  const priceChange = getAiPricingStatus(new Date("2027-01-01T00:00:00.000Z"))
    .find((entry) => entry.model === "gemini-3.8-flash");
  assert.equal(priceChange?.status, "current");
  assert.equal(priceChange?.validUntil, "2027-04-01T00:00:00.000Z");
  assert.equal(priceChange?.daysRemaining, 90);

  const soon = getAiPricingStatus(new Date("2027-02-01T00:00:00.000Z"))
    .find((entry) => entry.model === "gemini-3.8-flash");
  assert.equal(soon?.status, "expiring_soon");
  assert.equal(soon?.daysRemaining, 59);

  const expired = getAiPricingStatus(new Date("2027-04-01T00:00:00.000Z"))
    .find((entry) => entry.model === "gemini-3.8-flash");
  assert.equal(expired?.status, "expired");
  assert.equal(expired?.daysRemaining, 0);
  assert.equal(MODEL_PRICING_REGISTRY["gemini-3.8-flash"].prices.at(-1)?.validUntil, "2027-04-01T00:00:00.000Z");
});

test("the legacy soft budget check is gone and settings share the hard-ledger defaults", () => {
  assert.ok(!Object.keys(usage).includes("assertAiBudgetAvailable"));
  assert.ok(!Object.keys(usage).includes("recordAiUsage"));
  assert.ok(!Object.keys(usage).includes("estimateAiCostMicros"));
  assert.equal(usage.getOrCreateAiSettings, ledger.getOrCreateAiSettings);
  assert.equal(usage.getMonthlyAiUsage, ledger.getMonthlyAiUsage);
});

test("a stored monthly budget above the hard cap is clamped, and the settings API refuses it", (t) => {
  setEnv(t, { AI_HARD_CAP_CENTS: undefined });
  assert.equal(effectiveMonthlyBudgetCents(100_000), 500);
  assert.equal(effectiveMonthlyBudgetCents(300), 300);
  assert.equal(aiSettingsUpdateSchema().safeParse({ monthlyBudgetCents: 100_000 }).success, false);
  assert.equal(aiSettingsUpdateSchema().safeParse({ monthlyBudgetCents: 501 }).success, false);
  assert.equal(aiSettingsUpdateSchema().safeParse({ monthlyBudgetCents: 500 }).success, true);
  // Environment variables can lower but never raise the compiled hard cap.
  process.env.AI_HARD_CAP_CENTS = "100000";
  assert.equal(effectiveMonthlyBudgetCents(100_000), 500);
});

test("resume and cover-letter generation have no no-user fallback", async (t) => {
  setEnv(t, { AI_ENABLED: "true", AI_MOCK_MODE: "false", AI_PROVIDER: undefined, GEMINI_API_KEY: "synthetic-never-log" });
  let calls = 0;
  stub(t, globalThis, "fetch", async () => { calls += 1; throw new Error("must not call"); });
  stub(t, prisma.aIResponseCache, "findFirst", async () => { throw new Error("must not read cache"); });
  const { tailorResume } = await import("@/lib/ai/resume");
  const { draftCoverLetter } = await import("@/lib/ai/documents");
  const payload = { job: { title: "Engineer", company: "Acme" }, resume: { skills: ["TypeScript"] } };
  const ownerRequired = (error: unknown) => error instanceof PublicApiError &&
    error.details?.code === "AI_BUDGET_OWNER_REQUIRED";

  await assert.rejects(tailorResume(payload, "", undefined as unknown as string), ownerRequired);
  await assert.rejects(draftCoverLetter(payload, undefined as unknown as string), ownerRequired);
  assert.equal(calls, 0);

  const documents = readFileSync(new URL("../lib/ai/documents.ts", import.meta.url), "utf8");
  assert.doesNotMatch(documents, /fallback|Dear \$\{company\} Hiring Team/u);
});

test("a retired global AI_PROVIDER disables even Gemini-pinned features instead of being ignored", async (t) => {
  setEnv(t, { AI_ENABLED: "true", AI_MOCK_MODE: "false", AI_PROVIDER: "openai", GEMINI_API_KEY: "synthetic-never-log" });
  let calls = 0;
  stub(t, globalThis, "fetch", async () => { calls += 1; throw new Error("must not call"); });
  assert.equal(config.getAiRuntimeMode(), "local");
  assert.equal(config.isGeminiConfigured(), false);
  assert.deepEqual(config.getAiAvailability(), { available: false, reason: "unsupported_provider" });
  const { scoreJobMatch } = await import("@/lib/ai/job-match");
  await assert.rejects(
    scoreJobMatch(
      { job: { title: "Engineer", company: "Acme", description: "TypeScript" } },
      "user-1",
      { highCostConfirmed: true }
    ),
    /unavailable in local mode/u
  );
  assert.equal(calls, 0);
  process.env.AI_PROVIDER = "gemini";
  assert.deepEqual(config.getAiAvailability(), { available: true, provider: "gemini" });
});
