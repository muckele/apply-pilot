import assert from "node:assert/strict";
import { test } from "node:test";

import { estimateAiCostMicros, getModelPricing, MODEL_PRICING_REGISTRY } from "@/lib/ai/pricing";
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

test("Gemini 3.8 Flash switches to Google's published January 2027 price at the window boundary", () => {
  const lastIntroductory = getModelPricing("gemini-3.8-flash", new Date("2026-12-31T23:59:59.999Z"));
  assert.deepEqual(lastIntroductory, {
    provider: "gemini",
    inputUsdPerMillion: 0.75,
    outputUsdPerMillion: 3.75,
    cachedInputUsdPerMillion: 0.075,
    validFrom: "2026-10-01T00:00:00.000Z",
    validUntil: "2027-01-01T00:00:00.000Z"
  });

  const january = getModelPricing("gemini-3.8-flash", new Date("2027-01-01T00:00:00Z"));
  assert.deepEqual(january, {
    provider: "gemini",
    inputUsdPerMillion: 1.5,
    outputUsdPerMillion: 7.5,
    cachedInputUsdPerMillion: 0.15,
    validFrom: "2027-01-01T00:00:00.000Z",
    validUntil: "2027-04-01T00:00:00.000Z"
  });
  assert.equal(estimateAiCostMicros({
    model: "gemini-3.8-flash",
    inputTokens: AI_FEATURE_POLICIES.JOB_MATCH.maxInputTokens,
    outputTokens: AI_FEATURE_POLICIES.JOB_MATCH.maxOutputTokens,
    now: new Date("2027-01-01T00:00:00Z")
  }), 145_440);
});

test("Gemini 3.8 Flash pricing fails closed outside its verified period", () => {
  assert.throws(
    () => getModelPricing("gemini-3.8-flash", new Date("2026-09-30T23:59:59.999Z")),
    (error: unknown) => error instanceof Error && /not yet effective/i.test(error.message)
  );
  assert.equal(getModelPricing("gemini-3.8-flash", new Date("2027-03-31T23:59:59.999Z")).inputUsdPerMillion, 1.5);
  assert.throws(
    () => getModelPricing("gemini-3.8-flash", new Date("2027-04-01T00:00:00Z")),
    (error: unknown) => error instanceof Error && /expired/i.test(error.message)
  );
});

test("every registered model has ordered, contiguous price windows", () => {
  for (const [model, registered] of Object.entries(MODEL_PRICING_REGISTRY)) {
    assert.ok(registered.prices.length > 0, `${model} has at least one price window`);
    registered.prices.forEach((window, index) => {
      if (window.validFrom && window.validUntil) {
        assert.ok(new Date(window.validFrom) < new Date(window.validUntil), `${model} window ${index} is not empty`);
      }
      if (index > 0) {
        assert.ok(window.validFrom, `${model} window ${index} has a start`);
        assert.equal(window.validFrom, registered.prices[index - 1].validUntil, `${model} window ${index} follows the previous window`);
      }
      if (index < registered.prices.length - 1) {
        assert.ok(window.validUntil, `${model} window ${index} ends before the next window`);
      }
    });
  }
});
