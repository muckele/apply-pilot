import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildPreparationAcquireData,
  buildPreparationBlockedData,
  buildPreparationCommitData,
  buildPreparationFailedData,
  canCommitPreparation,
  classifyPreparationAcquisition,
  dailyCapWindowStart,
  evaluatePreparationGates,
  isDailyCapReached,
  isExpiredPrepareLease,
  isLivePrepareLease,
  PREPARE_LEASE_MS,
  type PreparationCommitInput,
  type PreparationRunFence
} from "@/lib/application-runs/preparation";
import { buildCancelRunData } from "@/lib/application-runs/state-machine";

const NOW = new Date("2026-08-16T12:00:00.000Z");

function fence(overrides: Partial<PreparationRunFence> = {}): PreparationRunFence {
  return {
    state: "DRAFT",
    stateVersion: 0,
    prepareAttemptId: null,
    prepareLeaseExpiresAt: null,
    firstPreparingAt: null,
    ...overrides
  };
}

function fullCommitInput(overrides: Partial<PreparationCommitInput> = {}): PreparationCommitInput {
  return {
    policySnapshot: { version: 1 },
    policyHash: "policy-hash",
    fitScoreSnapshot: 88,
    matchConfidenceScoreSnapshot: 88,
    plannerConfidenceScoreSnapshot: 92,
    resumeVersionId: "resume-1",
    resumeContentHash: "resume-hash",
    coverLetterVersionId: null,
    coverLetterContentHash: null,
    applicationPlanSnapshot: { plan: true },
    requirementCatalogSnapshot: { requirements: [] },
    evidenceCatalogSnapshot: { evidence: [] },
    plannerProvider: "kimi",
    plannerModel: "k3",
    plannerPromptVersion: "v1",
    plannerRequestHash: "request-hash",
    reviewReasons: [],
    ...overrides
  };
}

test("first acquisition applies to DRAFT, BLOCKED, and FAILED when no slot was consumed", () => {
  assert.deepEqual(classifyPreparationAcquisition(fence(), NOW), { kind: "first-acquire" });
  assert.deepEqual(classifyPreparationAcquisition(fence({ state: "BLOCKED" }), NOW), { kind: "first-acquire" });
  assert.deepEqual(classifyPreparationAcquisition(fence({ state: "FAILED" }), NOW), { kind: "first-acquire" });
});

test("retry acquisition whenever firstPreparingAt exists, with no new cap slot", () => {
  const consumed = new Date("2026-08-16T10:00:00.000Z");
  assert.deepEqual(classifyPreparationAcquisition(fence({ state: "FAILED", firstPreparingAt: consumed }), NOW), {
    kind: "retry-acquire"
  });
  assert.deepEqual(classifyPreparationAcquisition(fence({ state: "BLOCKED", firstPreparingAt: consumed }), NOW), {
    kind: "retry-acquire"
  });
});

test("a live PREPARING lease is a conflict and is never a retry", () => {
  const liveLease = new Date(NOW.getTime() + 60_000);
  const run = fence({ state: "PREPARING", prepareAttemptId: "attempt-1", prepareLeaseExpiresAt: liveLease, firstPreparingAt: NOW });
  assert.equal(isLivePrepareLease(run, NOW), true);
  assert.equal(isExpiredPrepareLease(run, NOW), false);
  assert.deepEqual(classifyPreparationAcquisition(run, NOW), { kind: "conflict-live-lease" });
});

test("an expired PREPARING lease is reclaimed as a retry when a slot was consumed", () => {
  const expiredLease = new Date(NOW.getTime() - 1);
  const consumed = new Date("2026-08-16T09:00:00.000Z");
  const run = fence({ state: "PREPARING", prepareAttemptId: "attempt-1", prepareLeaseExpiresAt: expiredLease, firstPreparingAt: consumed });
  assert.equal(isLivePrepareLease(run, NOW), false);
  assert.equal(isExpiredPrepareLease(run, NOW), true);
  assert.deepEqual(classifyPreparationAcquisition(run, NOW), { kind: "retry-acquire" });
});

test("lease boundary: an expiring-at-now lease is expired, not live", () => {
  const run = fence({ state: "PREPARING", prepareAttemptId: "attempt-1", prepareLeaseExpiresAt: NOW, firstPreparingAt: NOW });
  assert.equal(isLivePrepareLease(run, NOW), false);
  assert.equal(isExpiredPrepareLease(run, NOW), true);
});

test("READY, REVIEW_REQUIRED, and forward-only states cannot be (re)prepared", () => {
  assert.deepEqual(classifyPreparationAcquisition(fence({ state: "READY" }), NOW), { kind: "invalid-state" });
  assert.deepEqual(classifyPreparationAcquisition(fence({ state: "REVIEW_REQUIRED" }), NOW), { kind: "invalid-state" });
  assert.deepEqual(classifyPreparationAcquisition(fence({ state: "FILLING" }), NOW), { kind: "invalid-state" });
  assert.deepEqual(classifyPreparationAcquisition(fence({ state: "CANCELLED" }), NOW), { kind: "terminal" });
});

test("commit fencing requires PREPARING plus exact attempt and version", () => {
  const run = fence({ state: "PREPARING", prepareAttemptId: "attempt-1", stateVersion: 3 });
  const attempt = { prepareAttemptId: "attempt-1", stateVersion: 3 };

  assert.equal(canCommitPreparation(run, attempt), true);
  assert.equal(canCommitPreparation(run, { prepareAttemptId: "attempt-2", stateVersion: 3 }), false);
  assert.equal(canCommitPreparation(run, { prepareAttemptId: "attempt-1", stateVersion: 4 }), false);
  assert.equal(canCommitPreparation(fence({ state: "READY", prepareAttemptId: "attempt-1", stateVersion: 3 }), attempt), false);
  assert.equal(canCommitPreparation(fence({ state: "PREPARING", prepareAttemptId: null, stateVersion: 3 }), attempt), false);
});

test("cancellation invalidates a captured provider attempt so it cannot commit later", () => {
  const attempt = { prepareAttemptId: "attempt-1", stateVersion: 3 };
  const preparing = fence({
    state: "PREPARING",
    prepareAttemptId: attempt.prepareAttemptId,
    stateVersion: attempt.stateVersion,
    prepareLeaseExpiresAt: new Date(NOW.getTime() + 60_000),
    firstPreparingAt: NOW
  });
  const cancellation = buildCancelRunData(NOW);
  const cancelled = fence({
    ...preparing,
    state: cancellation.state,
    stateVersion: preparing.stateVersion + cancellation.stateVersion.increment,
    prepareAttemptId: cancellation.prepareAttemptId,
    prepareLeaseExpiresAt: cancellation.prepareLeaseExpiresAt
  });

  assert.equal(canCommitPreparation(preparing, attempt), true);
  assert.equal(canCommitPreparation(cancelled, attempt), false);
});

test("the preparation lease is exactly ten minutes", () => {
  assert.equal(PREPARE_LEASE_MS, 600_000);
});

test("the rolling daily-cap window starts exactly 24 hours before now with >= boundary semantics", () => {
  assert.equal(dailyCapWindowStart(NOW).toISOString(), "2026-08-15T12:00:00.000Z");
});

test("daily-cap boundary: below cap is allowed, at cap is reached", () => {
  assert.equal(isDailyCapReached(4, 5), false);
  assert.equal(isDailyCapReached(5, 5), true);
  assert.equal(isDailyCapReached(6, 5), true);
  assert.equal(isDailyCapReached(0, 0), true);
});


test("acquisition data installs a fresh attempt, a 10-minute lease, and writes firstPreparingAt once", () => {
  const first = buildPreparationAcquireData(fence(), NOW, "attempt-new");
  assert.equal(first.state, "PREPARING");
  assert.equal(first.prepareAttemptId, "attempt-new");
  assert.equal(first.prepareLeaseExpiresAt?.toISOString(), "2026-08-16T12:10:00.000Z");
  assert.deepEqual(first.stateVersion, { increment: 1 });
  assert.equal((first as { firstPreparingAt?: Date }).firstPreparingAt, NOW);
  assert.equal(first.blockingReason, null);
  assert.equal(first.errorCategory, null);

  // Retry acquisition preserves the original firstPreparingAt (no new slot).
  const consumed = new Date("2026-08-15T20:00:00.000Z");
  const retry = buildPreparationAcquireData(fence({ firstPreparingAt: consumed }), NOW, "attempt-2");
  assert.equal("firstPreparingAt" in retry, false);
});

test("leaving PREPARING clears lease and attempt but keeps the active run key", () => {
  const exit = buildPreparationBlockedData("daily_application_cap_reached");
  assert.equal(exit.prepareAttemptId, null);
  assert.equal(exit.prepareLeaseExpiresAt, null);
  assert.equal(exit.blockingReason, "daily_application_cap_reached");
  assert.ok(!("activeRunKey" in exit));

  const commit = buildPreparationCommitData("READY", NOW, fullCommitInput({ reviewReasons: [] }));
  assert.equal(commit.state, "READY");
  assert.equal(commit.preparedAt, NOW);
  assert.equal(commit.prepareAttemptId, null);
  assert.equal(commit.prepareLeaseExpiresAt, null);
  assert.deepEqual(commit.stateVersion, { increment: 1 });
  assert.ok(!("activeRunKey" in commit));
  assert.deepEqual(commit.reviewReasons, []);
});

test("BLOCKED and FAILED builders own every preparation-exit lifecycle field", () => {
  const blocked = buildPreparationBlockedData("daily_application_cap_reached");
  assert.deepEqual(blocked, {
    state: "BLOCKED",
    stateVersion: { increment: 1 },
    prepareAttemptId: null,
    prepareLeaseExpiresAt: null,
    blockingReason: "daily_application_cap_reached",
    errorCategory: null
  });

  const failed = buildPreparationFailedData("planner_output_invalid");
  assert.deepEqual(failed, {
    state: "FAILED",
    stateVersion: { increment: 1 },
    prepareAttemptId: null,
    prepareLeaseExpiresAt: null,
    blockingReason: null,
    errorCategory: "planner_output_invalid"
  });
  assert.ok(!("firstPreparingAt" in blocked));
  assert.ok(!("activeRunKey" in blocked));
  assert.ok(!("firstPreparingAt" in failed));
  assert.ok(!("activeRunKey" in failed));
});

test("preparation exit builders ignore hostile runtime lifecycle overrides", () => {
  const hostileBlocked = {
    valueOf: () => "host_blocked",
    state: "FILLING",
    stateVersion: 500,
    prepareAttemptId: "hijacked",
    prepareLeaseExpiresAt: NOW,
    firstPreparingAt: NOW,
    activeRunKey: null
  } as unknown as "host_blocked";
  const blocked = buildPreparationBlockedData(hostileBlocked);
  assert.equal(blocked.state, "BLOCKED");
  assert.deepEqual(blocked.stateVersion, { increment: 1 });
  assert.equal(blocked.prepareAttemptId, null);
  assert.equal(blocked.prepareLeaseExpiresAt, null);
  assert.ok(!("firstPreparingAt" in blocked));
  assert.ok(!("activeRunKey" in blocked));

  const hostileFailed = Object.assign(new String("planner_provider_failure"), {
    state: "READY_FOR_USER_SUBMISSION",
    stateVersion: 999,
    firstPreparingAt: null,
    activeRunKey: null
  }) as unknown as "planner_provider_failure";
  const failed = buildPreparationFailedData(hostileFailed);
  assert.equal(failed.state, "FAILED");
  assert.deepEqual(failed.stateVersion, { increment: 1 });
  assert.ok(!("firstPreparingAt" in failed));
  assert.ok(!("activeRunKey" in failed));
});

test("successful preparation preserves all approved snapshot fields and reviewReasons", () => {
  const commit = buildPreparationCommitData(
    "REVIEW_REQUIRED",
    NOW,
    fullCommitInput({
      reviewReasons: ["unknown_requirement_ids"],
      coverLetterVersionId: "cover-1",
      coverLetterContentHash: "cover-hash"
    })
  );
  assert.equal(commit.state, "REVIEW_REQUIRED");
  assert.equal(commit.preparedAt, NOW);
  assert.equal(commit.prepareAttemptId, null);
  assert.equal(commit.prepareLeaseExpiresAt, null);
  assert.deepEqual(commit.reviewReasons, ["unknown_requirement_ids"]);
  assert.deepEqual(commit.policySnapshot, { version: 1 });
  assert.equal(commit.policyHash, "policy-hash");
  assert.equal(commit.fitScoreSnapshot, 88);
  assert.equal(commit.matchConfidenceScoreSnapshot, 88);
  assert.equal(commit.plannerConfidenceScoreSnapshot, 92);
  assert.equal(commit.resumeVersionId, "resume-1");
  assert.equal(commit.resumeContentHash, "resume-hash");
  assert.equal(commit.coverLetterVersionId, "cover-1");
  assert.equal(commit.coverLetterContentHash, "cover-hash");
  assert.deepEqual(commit.applicationPlanSnapshot, { plan: true });
  assert.deepEqual(commit.requirementCatalogSnapshot, { requirements: [] });
  assert.deepEqual(commit.evidenceCatalogSnapshot, { evidence: [] });
  assert.equal(commit.plannerProvider, "kimi");
  assert.equal(commit.plannerModel, "k3");
  assert.equal(commit.plannerPromptVersion, "v1");
  assert.equal(commit.plannerRequestHash, "request-hash");
});

test("lifecycle fields are authoritatively produced and cannot be overridden by caller input", () => {
  const hostile = {
    ...fullCommitInput({ reviewReasons: ["evidence_gaps_present"] }),
    state: "BLOCKED" as const,
    stateVersion: 999,
    preparedAt: new Date("2020-01-01T00:00:00.000Z"),
    prepareAttemptId: "hijacked",
    prepareLeaseExpiresAt: new Date("2020-01-01T00:00:00.000Z"),
    activeRunKey: "hijacked-key"
  } as unknown as PreparationCommitInput;

  const commit = buildPreparationCommitData("READY", NOW, hostile);
  assert.equal(commit.state, "READY");
  assert.deepEqual(commit.stateVersion, { increment: 1 });
  assert.equal(commit.preparedAt, NOW);
  assert.equal(commit.prepareAttemptId, null);
  assert.equal(commit.prepareLeaseExpiresAt, null);
  assert.ok(!("activeRunKey" in commit));
  assert.deepEqual(commit.reviewReasons, ["evidence_gaps_present"]);
});

test("gate evaluation uses stable order and fails closed on null scores", () => {
  const base = {
    hostBlocked: false,
    fitScore: 90,
    matchConfidence: 90,
    minimumFitScore: 85,
    minimumConfidenceScore: 85,
    resumeSelectable: true,
    coverLetterRequired: true,
    coverLetterSelectable: true
  };
  assert.equal(evaluatePreparationGates(base), null);
  assert.equal(evaluatePreparationGates({ ...base, fitScore: 85 }), null); // threshold is inclusive

  assert.equal(evaluatePreparationGates({ ...base, hostBlocked: true, fitScore: null }), "host_blocked");
  assert.equal(evaluatePreparationGates({ ...base, fitScore: 84 }), "fit_below_threshold");
  assert.equal(evaluatePreparationGates({ ...base, fitScore: null }), "fit_below_threshold");
  assert.equal(evaluatePreparationGates({ ...base, matchConfidence: null }), "match_confidence_below_threshold");
  assert.equal(evaluatePreparationGates({ ...base, matchConfidence: 84 }), "match_confidence_below_threshold");
  assert.equal(evaluatePreparationGates({ ...base, resumeSelectable: false }), "resume_required");
  assert.equal(evaluatePreparationGates({ ...base, coverLetterSelectable: false }), "cover_letter_required");
  assert.equal(
    evaluatePreparationGates({ ...base, coverLetterRequired: false, coverLetterSelectable: false }),
    null
  );
});

test("resume is checked before cover letter and blocks even when cover letter is optional", () => {
  const base = {
    hostBlocked: false,
    fitScore: 90,
    matchConfidence: 90,
    minimumFitScore: 85,
    minimumConfidenceScore: 85,
    resumeSelectable: true,
    coverLetterRequired: false,
    coverLetterSelectable: false
  };
  assert.equal(evaluatePreparationGates({ ...base, resumeSelectable: false }), "resume_required");
  assert.equal(evaluatePreparationGates(base), null);
});

test("missing resume still blocks when a required cover letter is also missing", () => {
  const base = {
    hostBlocked: false,
    fitScore: 90,
    matchConfidence: 90,
    minimumFitScore: 85,
    minimumConfidenceScore: 85,
    resumeSelectable: false,
    coverLetterRequired: true,
    coverLetterSelectable: false
  };
  assert.equal(evaluatePreparationGates(base), "resume_required");
});

test("null scores fail closed before document prerequisite gates", () => {
  const base = {
    hostBlocked: false,
    fitScore: 90,
    matchConfidence: 90,
    minimumFitScore: 85,
    minimumConfidenceScore: 85,
    resumeSelectable: false,
    coverLetterRequired: true,
    coverLetterSelectable: false
  };
  assert.equal(evaluatePreparationGates({ ...base, fitScore: null }), "fit_below_threshold");
  assert.equal(evaluatePreparationGates({ ...base, matchConfidence: null }), "match_confidence_below_threshold");
});
