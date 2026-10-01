import assert from "node:assert/strict";
import { test } from "node:test";

import { formatDiscoveryScoringSummary } from "@/lib/job-sources/scoring-presentation";

test("discovery scoring presentation reports counts and cache usage without changing import success", () => {
  assert.equal(
    formatDiscoveryScoringSummary({
      eligible: 7,
      attempted: 5,
      cached: 2,
      scored: 4,
      failed: 1,
      stopReason: null
    }),
    "AI scoring: 7 eligible, 5 attempted, 4 scored (2 cached), 1 failed."
  );
});

test("discovery scoring presentation explains disabled and systemic stop reasons", () => {
  assert.equal(
    formatDiscoveryScoringSummary({
      eligible: 3,
      attempted: 0,
      cached: 0,
      scored: 0,
      failed: 0,
      stopReason: "DISABLED_BY_POLICY"
    }),
    "AI scoring: 3 eligible, 0 attempted, 0 scored, 0 failed. Scoring is disabled by your AI discovery settings."
  );
  assert.equal(
    formatDiscoveryScoringSummary({
      eligible: 5,
      attempted: 1,
      cached: 0,
      scored: 0,
      failed: 1,
      stopReason: "AI_BUDGET_EXCEEDED"
    }),
    "AI scoring: 5 eligible, 1 attempted, 0 scored, 1 failed. Remaining attempts stopped because the automation budget was exhausted."
  );
});
