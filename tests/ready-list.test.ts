import assert from "node:assert/strict";
import test from "node:test";

import { PREPARATION_GATE_BLOCKERS, type PreparationBlockingReason } from "@/lib/application-runs/preparation";
import { PREPARE_BLOCKER_COPY } from "@/lib/application-runs/blocker-copy";
import { buildReadyList } from "@/lib/apply-page/ready-list";

const ALL_REASONS: PreparationBlockingReason[] = [
  ...PREPARATION_GATE_BLOCKERS,
  "automation_disabled", "automation_disabled_during_preparation", "daily_application_cap_reached",
  "ai_budget_exceeded", "ai_request_cost_limit", "ai_cost_confirmation_required", "ai_duplicate_in_progress"
];

const base = {
  fitScore: 88, confidenceScore: 90, hasCurrentMatch: true, resumeAttached: true,
  coverAttached: true, coverRequired: true, fillMode: "PREPARE_ONLY" as const, hostBlocked: false,
  details: { confirmed: 5, total: 5, missing: [] as string[] }
};

test("every blocking reason has copy", () => {
  assert.equal(ALL_REASONS.length, 12);
  assert.deepEqual(Object.keys(PREPARE_BLOCKER_COPY).sort(), [...ALL_REASONS].sort());
  for (const reason of ALL_REASONS) assert.ok(PREPARE_BLOCKER_COPY[reason].text.length > 0);
});

test("everything in order is ready", () => {
  const lines = buildReadyList(base);
  assert.deepEqual(lines.map((l) => l.key), [
    "fit_below_threshold", "match_confidence_below_threshold", "resume_required",
    "cover_letter_required", "host_blocked", "application_details"
  ]);
  assert.ok(lines.every((l) => l.ok && !l.blocking));
  assert.equal(lines[0].text, "Fit 88 (needs 85)");
});

test("fit 84 blocks with a step-1 fix", () => {
  const line = buildReadyList({ ...base, fitScore: 84 })[0];
  assert.equal(line.ok, false);
  assert.equal(line.blocking, true);
  assert.equal(line.fix?.target, "step-1");
});

test("no current match blocks fit and confidence", () => {
  const lines = buildReadyList({ ...base, hasCurrentMatch: false });
  assert.deepEqual(lines.slice(0, 2).map((l) => [l.ok, l.fix?.target]), [[false, "step-1"], [false, "step-1"]]);
});

test("cover letter line only when required; missing sends to step 3", () => {
  assert.equal(buildReadyList({ ...base, coverRequired: false }).some((l) => l.key === "cover_letter_required"), false);
  const line = buildReadyList({ ...base, coverAttached: false }).find((l) => l.key === "cover_letter_required");
  assert.equal(line?.blocking, true);
  assert.equal(line?.fix?.target, "step-3");
});

test("Fill on is a blocking fill_on line", () => {
  const lines = buildReadyList({ ...base, fillMode: "FILL_AND_REVIEW" });
  const line = lines.find((l) => l.key === "fill_on");
  assert.equal(line?.blocking, true);
  assert.equal(line?.ok, false);
  assert.deepEqual(line?.fix, { label: "Turn off", target: "turn-off-fill" });
  assert.equal(buildReadyList(base).some((l) => l.key === "fill_on"), false);
});

test("blocked host is a blocking line without a fix", () => {
  const line = buildReadyList({ ...base, hostBlocked: true }).find((l) => l.key === "host_blocked");
  assert.equal(line?.blocking, true);
  assert.equal(line?.fix, null);
});

test("missing details are named and never block", () => {
  const lines = buildReadyList({ ...base, details: { confirmed: 3, total: 5, missing: ["phone number", "city"] } });
  const line = lines[lines.length - 1];
  assert.equal(line.key, "application_details");
  assert.equal(line.blocking, false);
  assert.match(line.text, /phone number/);
  assert.match(line.text, /city/);
  assert.match(line.text, /Your application details/);
});
