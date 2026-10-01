import assert from "node:assert/strict";
import { test } from "node:test";

import { estimateAiCostMicros, getModelPricing } from "@/lib/ai/pricing";
import { AI_FEATURE_POLICIES } from "@/lib/ai/policy";

test("Gemini 3.8 Flash pricing is date-bounded and reserves the exact JOB_MATCH worst case", () => {
  const pricing = getModelPricing("gemini-3.8-flash", new Date("2026-10-01T00:00:00Z"));
  assert.equal(pricing.provider, "gemini");
  assert.equal(pricing.inputUsdPerMillion, 0.75);
  assert.equal(pricing.outputUsdPerMillion, 3.75);
  assert.equal(pricing.cachedInputUsdPerMillion, 0.075);
  assert.equal(AI_FEATURE_POLICIES.JOB_MATCH.maxInputTokens, 56_000);
  assert.equal(AI_FEATURE_POLICIES.JOB_MATCH.maxOutputTokens, 8_192);
  assert.equal(estimateAiCostMicros({
    model: "gemini-3.8-flash",
    inputTokens: AI_FEATURE_POLICIES.JOB_MATCH.maxInputTokens,
    outputTokens: AI_FEATURE_POLICIES.JOB_MATCH.maxOutputTokens,
    now: new Date("2026-10-01T00:00:00Z")
  }), 72_720);
});

test("Gemini 3.8 Flash pricing fails closed outside its verified period", () => {
  assert.throws(
    () => getModelPricing("gemini-3.8-flash", new Date("2027-01-01T00:00:00Z")),
    (error: unknown) => error instanceof Error && /expired/i.test(error.message)
  );
});
