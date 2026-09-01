import assert from "node:assert/strict";
import { test } from "node:test";

import { ApplicationRunState } from "@prisma/client";

import {
  ALLOWED_RUN_TRANSITIONS,
  assertRunTransition,
  buildAcquireRunFillData,
  buildCancelRunData,
  buildFinalizeRunFillData,
  buildRecoverExpiredRunFillData,
  buildResolveRunReviewData,
  isTerminalRunState,
  RunTransitionError
} from "@/lib/application-runs/state-machine";
import { PublicApiError } from "@/lib/api-errors";

const APPROVED_TRANSITIONS: Array<[ApplicationRunState, ApplicationRunState]> = [
  ["DRAFT", "PREPARING"],
  ["DRAFT", "BLOCKED"],
  ["DRAFT", "CANCELLED"],
  ["BLOCKED", "PREPARING"],
  ["BLOCKED", "BLOCKED"],
  ["BLOCKED", "CANCELLED"],
  ["FAILED", "PREPARING"],
  ["FAILED", "BLOCKED"],
  ["FAILED", "CANCELLED"],
  ["PREPARING", "READY"],
  ["PREPARING", "REVIEW_REQUIRED"],
  ["PREPARING", "BLOCKED"],
  ["PREPARING", "FAILED"],
  ["PREPARING", "CANCELLED"],
  ["REVIEW_REQUIRED", "READY"],
  ["REVIEW_REQUIRED", "READY_FOR_USER_SUBMISSION"],
  ["REVIEW_REQUIRED", "CANCELLED"],
  ["READY", "FILLING"],
  ["READY", "COMPLETED_BY_USER"],
  ["READY", "REVIEW_REQUIRED"],
  ["READY", "CANCELLED"],
  ["FILLING", "READY_FOR_USER_SUBMISSION"],
  ["FILLING", "CANCELLED"],
  ["READY_FOR_USER_SUBMISSION", "REVIEW_REQUIRED"],
  ["READY_FOR_USER_SUBMISSION", "COMPLETED_BY_USER"],
  ["READY_FOR_USER_SUBMISSION", "CANCELLED"]
];

test("every approved transition succeeds", () => {
  for (const [from, to] of APPROVED_TRANSITIONS) {
    assert.doesNotThrow(() => assertRunTransition(from, to), `expected ${from} -> ${to} to be allowed`);
  }
});

test("forbidden transitions fail closed with RUN_INVALID_STATE", () => {
  const forbidden: Array<[ApplicationRunState, ApplicationRunState]> = [
    ["DRAFT", "READY"],
    ["DRAFT", "FILLING"],
    ["PREPARING", "DRAFT"],
    ["READY", "PREPARING"],
    ["BLOCKED", "READY"],
    ["FAILED", "READY"],
    ["REVIEW_REQUIRED", "DRAFT"],
    ["FILLING", "READY"],
    ["READY_FOR_USER_SUBMISSION", "READY"],
    ["FILLING", "COMPLETED_BY_USER"],
    ["REVIEW_REQUIRED", "FILLING"]
  ];
  for (const [from, to] of forbidden) {
    assert.throws(
      () => assertRunTransition(from, to),
      (error) =>
        error instanceof RunTransitionError &&
        error instanceof PublicApiError &&
        error.status === 409 &&
        error.details?.code === "RUN_INVALID_STATE",
      `expected ${from} -> ${to} to be rejected`
    );
  }
});

test("the central state map represents the exact frozen Fill and architectural completion edges", () => {
  assert.deepEqual(ALLOWED_RUN_TRANSITIONS.READY, [
    "REVIEW_REQUIRED",
    "FILLING",
    "COMPLETED_BY_USER",
    "CANCELLED"
  ]);
  assert.deepEqual(ALLOWED_RUN_TRANSITIONS.FILLING, ["READY_FOR_USER_SUBMISSION", "CANCELLED"]);
  assert.deepEqual(ALLOWED_RUN_TRANSITIONS.READY_FOR_USER_SUBMISSION, [
    "REVIEW_REQUIRED",
    "COMPLETED_BY_USER",
    "CANCELLED"
  ]);
  assert.deepEqual(ALLOWED_RUN_TRANSITIONS.REVIEW_REQUIRED, [
    "READY",
    "READY_FOR_USER_SUBMISSION",
    "CANCELLED"
  ]);
});

test("CANCELLED and COMPLETED_BY_USER are terminal with no outgoing transitions", () => {
  assert.deepEqual(ALLOWED_RUN_TRANSITIONS.CANCELLED, []);
  assert.deepEqual(ALLOWED_RUN_TRANSITIONS.COMPLETED_BY_USER, []);
  assert.equal(isTerminalRunState("CANCELLED"), true);
  assert.equal(isTerminalRunState("COMPLETED_BY_USER"), true);
  assert.equal(isTerminalRunState("DRAFT"), false);
  assert.equal(isTerminalRunState("PREPARING"), false);
  for (const target of Object.keys(ALLOWED_RUN_TRANSITIONS) as ApplicationRunState[]) {
    assert.throws(() => assertRunTransition("CANCELLED", target));
    assert.throws(() => assertRunTransition("COMPLETED_BY_USER", target));
  }
});

test("the runtime Prisma enum has exactly the approved states and no submission states", () => {
  const states = Object.keys(ApplicationRunState).sort();
  assert.deepEqual(states, [
    "BLOCKED",
    "CANCELLED",
    "COMPLETED_BY_USER",
    "DRAFT",
    "FAILED",
    "FILLING",
    "PREPARING",
    "READY",
    "READY_FOR_USER_SUBMISSION",
    "REVIEW_REQUIRED"
  ]);
  assert.ok(!("SUBMITTING" in ApplicationRunState));
  assert.ok(!("SUBMITTED" in ApplicationRunState));
});

test("cancellation clears preparation ownership and the Fill lease while retaining the permanent Fill fence", () => {
  const now = new Date("2026-08-16T12:00:00.000Z");
  const data = buildCancelRunData(now);

  assert.equal(data.state, "CANCELLED");
  assert.equal(data.cancelledAt, now);
  assert.equal(data.activeRunKey, null);
  assert.equal(data.prepareAttemptId, null);
  assert.equal(data.prepareLeaseExpiresAt, null);
  assert.equal(data.fillLeaseExpiresAt, null);
  assert.equal("fillAttemptId" in data, false);
  assert.deepEqual(data.stateVersion, { increment: 1 });
});

test("Fill state builders use only supplied authority and retain the permanent attempt fence by omission", () => {
  const fillAttemptId = "550e8400-e29b-41d4-a716-446655440000";
  const fillLeaseExpiresAt = new Date("2026-08-16T12:10:00.000Z");

  assert.deepEqual(buildAcquireRunFillData({ fillAttemptId, fillLeaseExpiresAt }), {
    state: "FILLING",
    stateVersion: { increment: 1 },
    fillAttemptId,
    fillLeaseExpiresAt,
    errorCategory: null
  });

  for (const errorCategory of [
    null,
    "FILL_POLICY_DENIED",
    "FILL_TARGET_TRUST_LOST",
    "FILL_UNEXPECTED_MUTATION",
    "FILL_WRITE_FAILED",
    "FILL_INTERNAL"
  ] as const) {
    const finalized = buildFinalizeRunFillData({ errorCategory });
    assert.deepEqual(finalized, {
      state: "READY_FOR_USER_SUBMISSION",
      stateVersion: { increment: 1 },
      fillLeaseExpiresAt: null,
      errorCategory
    });
    assert.equal("fillAttemptId" in finalized, false);
  }

  assert.throws(() => buildFinalizeRunFillData({ errorCategory: "FILL_STALE" as never }));
  assert.throws(() => buildFinalizeRunFillData({ errorCategory: "free-form" as never }));

  const recovered = buildRecoverExpiredRunFillData();
  assert.deepEqual(recovered, {
    state: "READY_FOR_USER_SUBMISSION",
    stateVersion: { increment: 1 },
    fillLeaseExpiresAt: null,
    errorCategory: "FILL_STALE"
  });
  assert.equal("fillAttemptId" in recovered, false);
});

test("review-resolution data records a new planner acknowledgment when requested", () => {
  const now = new Date("2026-08-16T12:00:00.000Z");

  assert.deepEqual(buildResolveRunReviewData(now, { acknowledgePlannerReview: true }), {
    state: "READY",
    stateVersion: { increment: 1 },
    reviewAcknowledgedAt: now
  });
});

test("review-resolution data preserves an existing planner acknowledgment by omitting the field", () => {
  const now = new Date("2026-08-16T12:00:00.000Z");
  const data = buildResolveRunReviewData(now, { acknowledgePlannerReview: false });

  assert.deepEqual(data, {
    state: "READY",
    stateVersion: { increment: 1 }
  });
  assert.equal("reviewAcknowledgedAt" in data, false);
});

test("review-resolution data does not fabricate a planner acknowledgment when reasons are empty", () => {
  const now = new Date("2026-08-16T12:00:00.000Z");
  const acknowledgePlannerReview = ([] as string[]).length > 0 && null === null;
  const data = buildResolveRunReviewData(now, { acknowledgePlannerReview });

  assert.equal("reviewAcknowledgedAt" in data, false);
});

test("review resolution chooses the frozen destination from explicit Fill history without restoring Fill eligibility", () => {
  const now = new Date("2026-08-16T12:00:00.000Z");

  assert.deepEqual(
    buildResolveRunReviewData(now, { acknowledgePlannerReview: false, fillAttemptId: null }),
    { state: "READY", stateVersion: { increment: 1 } }
  );
  assert.deepEqual(
    buildResolveRunReviewData(now, {
      acknowledgePlannerReview: true,
      fillAttemptId: "550e8400-e29b-41d4-a716-446655440000"
    }),
    {
      state: "READY_FOR_USER_SUBMISSION",
      stateVersion: { increment: 1 },
      reviewAcknowledgedAt: now
    }
  );
});
