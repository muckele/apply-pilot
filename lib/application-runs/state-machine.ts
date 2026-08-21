import { ApplicationRunState } from "@prisma/client";

import { PublicApiError } from "@/lib/api-errors";

// The complete approved transition map for this milestone. Anything not listed here is
// invalid by construction (fail closed). FILLING, READY_FOR_USER_SUBMISSION, and
// COMPLETED_BY_USER exist in the Prisma enum for forward compatibility but have no
// inbound edges — no executable path may enter them in this milestone. There is no
// SUBMITTING or SUBMITTED state anywhere in this system.
export const ALLOWED_RUN_TRANSITIONS: Record<ApplicationRunState, readonly ApplicationRunState[]> = {
  DRAFT: ["PREPARING", "BLOCKED", "CANCELLED"],
  PREPARING: ["READY", "REVIEW_REQUIRED", "BLOCKED", "FAILED", "CANCELLED"],
  READY: ["REVIEW_REQUIRED", "CANCELLED"],
  REVIEW_REQUIRED: ["READY", "CANCELLED"],
  // BLOCKED -> BLOCKED is a gate re-evaluation that refreshes blockingReason, not a no-op.
  BLOCKED: ["PREPARING", "BLOCKED", "CANCELLED"],
  FAILED: ["PREPARING", "BLOCKED", "CANCELLED"],
  FILLING: [],
  READY_FOR_USER_SUBMISSION: [],
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
    prepareLeaseExpiresAt: null
  };
}

// Deterministic human-review acknowledgment update. The persisted reasons remain
// immutable attempt provenance; acknowledging them only records the timestamp and
// advances the already-approved REVIEW_REQUIRED -> READY transition fence.
export function buildResolveRunReviewData(now: Date) {
  return {
    state: "READY" as ApplicationRunState,
    stateVersion: { increment: 1 },
    reviewAcknowledgedAt: now
  };
}
