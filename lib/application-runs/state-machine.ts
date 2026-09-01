import { ApplicationRunState } from "@prisma/client";

import { PublicApiError } from "@/lib/api-errors";
import {
  FillAttemptDomainError,
  isStoppedEarlyFillError,
  type StoppedEarlyFillError
} from "@/lib/application-runs/fill-attempt-domain";

// The complete approved transition map. Anything not listed here is invalid by
// construction (fail closed). Fill and human-completion edges are represented in one
// central authority, but this module creates no executable Fill service, route, browser
// command, arbitrary-state mutation API, or completion path. There is no SUBMITTING or
// SUBMITTED state anywhere in this system.
export const ALLOWED_RUN_TRANSITIONS: Record<ApplicationRunState, readonly ApplicationRunState[]> = {
  DRAFT: ["PREPARING", "BLOCKED", "CANCELLED"],
  PREPARING: ["READY", "REVIEW_REQUIRED", "BLOCKED", "FAILED", "CANCELLED"],
  READY: ["REVIEW_REQUIRED", "FILLING", "COMPLETED_BY_USER", "CANCELLED"],
  REVIEW_REQUIRED: ["READY", "READY_FOR_USER_SUBMISSION", "CANCELLED"],
  // BLOCKED -> BLOCKED is a gate re-evaluation that refreshes blockingReason, not a no-op.
  BLOCKED: ["PREPARING", "BLOCKED", "CANCELLED"],
  FAILED: ["PREPARING", "BLOCKED", "CANCELLED"],
  FILLING: ["READY_FOR_USER_SUBMISSION", "CANCELLED"],
  READY_FOR_USER_SUBMISSION: ["REVIEW_REQUIRED", "COMPLETED_BY_USER", "CANCELLED"],
  COMPLETED_BY_USER: [],
  CANCELLED: []
};

export class RunTransitionError extends PublicApiError {
  constructor(from: ApplicationRunState, to: ApplicationRunState) {
    super(`An application run in ${from} cannot transition to ${to}.`, 409, {
      code: "RUN_INVALID_STATE",
      from,
      to
    });
    this.name = "RunTransitionError";
  }
}

export function assertRunTransition(from: ApplicationRunState, to: ApplicationRunState): void {
  if (!ALLOWED_RUN_TRANSITIONS[from].includes(to)) {
    throw new RunTransitionError(from, to);
  }
}

export const TERMINAL_RUN_STATES: readonly ApplicationRunState[] = ["CANCELLED", "COMPLETED_BY_USER"];

export function isTerminalRunState(state: ApplicationRunState): boolean {
  return TERMINAL_RUN_STATES.includes(state);
}

// Deterministic cancellation update data. Pure builder: callers perform the actual
// database mutation (and token revocation) inside their own transaction.
// Terminal semantics: clears activeRunKey so a future run may exist for the same
// Application, and clears any preparation lease/attempt ownership fencing.
export function buildCancelRunData(now: Date) {
  return {
    state: "CANCELLED" as ApplicationRunState,
    stateVersion: { increment: 1 },
    cancelledAt: now,
    activeRunKey: null,
    prepareAttemptId: null,
    prepareLeaseExpiresAt: null,
    fillLeaseExpiresAt: null
  };
}

// These builders consume caller-supplied authority facts only. They do not generate
// attempt IDs, read a clock/database, or decide whether acquisition/finalization is
// authorized. Future services must call assertRunTransition around their mutations.
export function buildAcquireRunFillData(input: {
  fillAttemptId: string;
  fillLeaseExpiresAt: Date;
}) {
  return {
    state: "FILLING" as ApplicationRunState,
    stateVersion: { increment: 1 },
    fillAttemptId: input.fillAttemptId,
    fillLeaseExpiresAt: input.fillLeaseExpiresAt,
    errorCategory: null
  };
}

export function buildFinalizeRunFillData(input: {
  errorCategory: StoppedEarlyFillError | null;
}) {
  if (input.errorCategory !== null && !isStoppedEarlyFillError(input.errorCategory)) {
    throw new FillAttemptDomainError();
  }
  return {
    state: "READY_FOR_USER_SUBMISSION" as ApplicationRunState,
    stateVersion: { increment: 1 },
    fillLeaseExpiresAt: null,
    errorCategory: input.errorCategory
  };
}

export function buildRecoverExpiredRunFillData() {
  return {
    state: "READY_FOR_USER_SUBMISSION" as ApplicationRunState,
    stateVersion: { increment: 1 },
    fillLeaseExpiresAt: null,
    errorCategory: "FILL_STALE" as const
  };
}

// Deterministic human-review acknowledgment update. The persisted reasons remain
// immutable attempt provenance; acknowledging them only records the timestamp and
// advances the already-approved REVIEW_REQUIRED -> READY transition fence.
export function buildResolveRunReviewData(
  now: Date,
  input: { acknowledgePlannerReview: boolean; fillAttemptId?: string | null }
) {
  return {
    // Commit 5 must pass the locked persisted fillAttemptId before any post-fill
    // review-resolution path becomes executable. Omission preserves the currently
    // reachable pre-fill service behavior while Commit 2 remains independently safe.
    state: (input.fillAttemptId == null ? "READY" : "READY_FOR_USER_SUBMISSION") as ApplicationRunState,
    stateVersion: { increment: 1 },
    ...(input.acknowledgePlannerReview ? { reviewAcknowledgedAt: now } : {})
  };
}
