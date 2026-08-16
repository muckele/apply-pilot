import { ApplicationRunState, Prisma } from "@prisma/client";

import { PublicApiError } from "@/lib/api-errors";

export const PREPARE_LEASE_MS = 600_000; // exactly 10 minutes
export const DAILY_CAP_WINDOW_MS = 24 * 60 * 60 * 1_000; // rolling 24 hours (UTC; no tz abstraction exists)

// The fencing fields read from an ApplicationRun row for pure decision-making.
export type PreparationRunFence = {
  state: ApplicationRunState;
  stateVersion: number;
  prepareAttemptId: string | null;
  prepareLeaseExpiresAt: Date | null;
  firstPreparingAt: Date | null;
};

export function isLivePrepareLease(
  run: Pick<PreparationRunFence, "state" | "prepareLeaseExpiresAt">,
  now: Date
): boolean {
  return (
    run.state === "PREPARING" &&
    run.prepareLeaseExpiresAt !== null &&
    run.prepareLeaseExpiresAt.getTime() > now.getTime()
  );
}

export function isExpiredPrepareLease(
  run: Pick<PreparationRunFence, "state" | "prepareLeaseExpiresAt">,
  now: Date
): boolean {
  return run.state === "PREPARING" && !isLivePrepareLease(run, now);
}

export type PreparationAcquisition =
  | { kind: "first-acquire" } // first real planner attempt — consumes the lifetime daily-cap slot
  | { kind: "retry-acquire" } // firstPreparingAt already set — never consumes another slot
  | { kind: "conflict-live-lease" }
  | { kind: "invalid-state" }
  | { kind: "terminal" };

// Pure acquisition classifier. CRITICAL INVARIANT: a live PREPARING lease always wins —
// gate re-evaluation must never overwrite a live PREPARING owner. firstPreparingAt
// distinguishes first acquisition (cap-sensitive) from retry acquisition (never
// cap-consuming), including stale-lease reclaim from expired PREPARING.
export function classifyPreparationAcquisition(run: PreparationRunFence, now: Date): PreparationAcquisition {
  if (run.state === "CANCELLED" || run.state === "COMPLETED_BY_USER") {
    return { kind: "terminal" };
  }
  if (run.state === "PREPARING") {
    if (isLivePrepareLease(run, now)) {
      return { kind: "conflict-live-lease" };
    }
    // Expired or missing lease: reclaimable. An existing firstPreparingAt means this
    // run already consumed its lifetime slot, so reclaim is a retry acquisition.
    return run.firstPreparingAt ? { kind: "retry-acquire" } : { kind: "first-acquire" };
  }
  if (run.state === "DRAFT" || run.state === "BLOCKED" || run.state === "FAILED") {
    return run.firstPreparingAt ? { kind: "retry-acquire" } : { kind: "first-acquire" };
  }
  // READY / REVIEW_REQUIRED / FILLING / READY_FOR_USER_SUBMISSION cannot be (re)prepared.
  return { kind: "invalid-state" };
}

export class PreparationConflictError extends PublicApiError {
  constructor(kind: "conflict-live-lease" | "invalid-state" | "terminal") {
    super(
      kind === "conflict-live-lease"
        ? "This application run is already being prepared."
        : kind === "terminal"
          ? "A terminal application run cannot be prepared."
          : "This application run cannot be prepared from its current state.",
      409,
      { code: kind === "conflict-live-lease" ? "RUN_PREPARATION_IN_PROGRESS" : "RUN_INVALID_STATE" }
    );
    this.name = "PreparationConflictError";
  }
}

export function assertPreparationAcquirable(
  acquisition: PreparationAcquisition
): asserts acquisition is { kind: "first-acquire" } | { kind: "retry-acquire" } {
  if (acquisition.kind !== "first-acquire" && acquisition.kind !== "retry-acquire") {
    throw new PreparationConflictError(acquisition.kind);
  }
}

export type PreparationAttempt = {
  prepareAttemptId: string;
  stateVersion: number;
};

// Commit fencing: an old provider attempt may commit only while the run is still
// PREPARING with the exact same attempt ID and state version. Anything else means the
// attempt was superseded, retried, or cancelled and its result must be discarded.
export function canCommitPreparation(run: PreparationRunFence, attempt: PreparationAttempt): boolean {
  return (
    run.state === "PREPARING" &&
    run.prepareAttemptId !== null &&
    run.prepareAttemptId === attempt.prepareAttemptId &&
    run.stateVersion === attempt.stateVersion
  );
}

// Rolling 24-hour window boundary. The future daily-cap query must use
// firstPreparingAt >= dailyCapWindowStart(now) — the >= boundary is deliberate.
export function dailyCapWindowStart(now: Date): Date {
  return new Date(now.getTime() - DAILY_CAP_WINDOW_MS);
}

export function isDailyCapReached(recentCount: number, cap: number): boolean {
  return recentCount >= cap;
}

// ---------------------------------------------------------------------------
// Deterministic pre-provider gates
// ---------------------------------------------------------------------------

export const PREPARATION_GATE_BLOCKERS = [
  "host_blocked",
  "fit_below_threshold",
  "match_confidence_below_threshold",
  "resume_required",
  "cover_letter_required"
] as const;
export type PreparationGateBlocker = (typeof PREPARATION_GATE_BLOCKERS)[number];

export type PreparationGateInput = {
  hostBlocked: boolean;
  fitScore: number | null;           // job-match fit used for pre-provider eligibility
  matchConfidence: number | null;    // job-match confidence used for pre-provider eligibility
  minimumFitScore: number;
  minimumConfidenceScore: number;
  // Whether the explicit Application.resumeVersionId assignment is satisfiable.
  // The future orchestration validates the assignment (ownership, relationship, and
  // document type) and never selects the "latest" résumé here.
  resumeSelectable: boolean;
  coverLetterRequired: boolean;
  // Whether the explicit Application.coverLetterVersionId assignment is satisfiable.
  // The future orchestration validates the assignment and never selects the "latest"
  // cover letter here.
  coverLetterSelectable: boolean;
};

// Stable evaluation order: host_blocked → fit → match confidence → resume → cover letter.
// Null required scores fail closed. Returns a deterministic blocker identifier.
export function evaluatePreparationGates(input: PreparationGateInput): PreparationGateBlocker | null {
  if (input.hostBlocked) return "host_blocked";
  if (input.fitScore === null || input.fitScore < input.minimumFitScore) return "fit_below_threshold";
  if (input.matchConfidence === null || input.matchConfidence < input.minimumConfidenceScore) {
    return "match_confidence_below_threshold";
  }
  if (!input.resumeSelectable) return "resume_required";
  if (input.coverLetterRequired && !input.coverLetterSelectable) return "cover_letter_required";
  return null;
}

// ---------------------------------------------------------------------------
// Update-data builders (pure; callers own the database mutation)
// ---------------------------------------------------------------------------

// Acquisition into PREPARING. Increments stateVersion, installs a fresh attempt ID and
// 10-minute lease, and writes firstPreparingAt only when this run has never consumed
// its lifetime daily-cap slot (retry acquisitions preserve the original value).
export function buildPreparationAcquireData(run: PreparationRunFence, now: Date, attemptId: string) {
  return {
    state: "PREPARING" as ApplicationRunState,
    stateVersion: { increment: 1 },
    prepareAttemptId: attemptId,
    prepareLeaseExpiresAt: new Date(now.getTime() + PREPARE_LEASE_MS),
    ...(run.firstPreparingAt ? {} : { firstPreparingAt: now }),
    blockingReason: null,
    errorCategory: null
  };
}

// Leaving PREPARING always clears the lease and attempt ownership. READY /
// REVIEW_REQUIRED / BLOCKED / FAILED remain the same active historical run, so
// activeRunKey is deliberately NOT cleared here (only CANCELLED clears it, via
// buildCancelRunData in lib/application-runs/state-machine.ts).
export function buildPreparationExitData(fields: { blockingReason?: string; errorCategory?: string } = {}) {
  return {
    prepareAttemptId: null,
    prepareLeaseExpiresAt: null,
    ...fields
  };
}

// Guarded commit out of PREPARING with the successful attempt's snapshots.
// reviewReasons is a named, required field: the deterministic review evidence is
// persisted as historical record and is never cleared by later acknowledgement.
// Remaining keys carry the definitive attempt-captured values (policySnapshot/policyHash,
// score snapshots, document IDs + content hashes, plan/catalog snapshots, planner
// identity) assembled by the future orchestration from THIS attempt.
//
// This is a fail-closed allowlist: callers may NOT pass state, stateVersion,
// preparedAt, prepareAttemptId, prepareLeaseExpiresAt, or activeRunKey; those are
// authoritatively produced by the builder. Extra runtime properties are ignored.
// Snapshot fields are non-null at this successful-commit boundary: a usable plan
// implies them, so only the cover-letter fields may remain null when optional.
export type PreparationCommitInput = {
  policySnapshot: Prisma.InputJsonValue;
  policyHash: string;
  fitScoreSnapshot: number;
  matchConfidenceScoreSnapshot: number;
  plannerConfidenceScoreSnapshot: number;
  resumeVersionId: string;
  resumeContentHash: string;
  coverLetterVersionId: string | null;
  coverLetterContentHash: string | null;
  applicationPlanSnapshot: Prisma.InputJsonValue;
  requirementCatalogSnapshot: Prisma.InputJsonValue;
  evidenceCatalogSnapshot: Prisma.InputJsonValue;
  plannerProvider: string;
  plannerModel: string;
  plannerPromptVersion: string;
  plannerRequestHash: string;
  reviewReasons: string[];
};

export function buildPreparationCommitData(
  targetState: "READY" | "REVIEW_REQUIRED",
  now: Date,
  commit: PreparationCommitInput
) {
  return {
    state: targetState as ApplicationRunState,
    stateVersion: { increment: 1 },
    preparedAt: now,
    prepareAttemptId: null,
    prepareLeaseExpiresAt: null,
    reviewReasons: commit.reviewReasons,
    policySnapshot: commit.policySnapshot,
    policyHash: commit.policyHash,
    fitScoreSnapshot: commit.fitScoreSnapshot,
    matchConfidenceScoreSnapshot: commit.matchConfidenceScoreSnapshot,
    plannerConfidenceScoreSnapshot: commit.plannerConfidenceScoreSnapshot,
    resumeVersionId: commit.resumeVersionId,
    resumeContentHash: commit.resumeContentHash,
    coverLetterVersionId: commit.coverLetterVersionId,
    coverLetterContentHash: commit.coverLetterContentHash,
    applicationPlanSnapshot: commit.applicationPlanSnapshot,
    requirementCatalogSnapshot: commit.requirementCatalogSnapshot,
    evidenceCatalogSnapshot: commit.evidenceCatalogSnapshot,
    plannerProvider: commit.plannerProvider,
    plannerModel: commit.plannerModel,
    plannerPromptVersion: commit.plannerPromptVersion,
    plannerRequestHash: commit.plannerRequestHash
  };
}
// ---------------------------------------------------------------------------
// Future transaction contract (implemented in the later ApplicationRun API commit;
// documented here so the boundary is unambiguous):
//
// TX1 (short interactive transaction):
//
//   1. Load the ownership-scoped run and get-or-create the user's policy.
//
//   2. Check the initially loaded run for a live PREPARING lease.
//      A live lease fails fast with conflict and must never be overwritten by gate
//      evaluation.
//
//   3. Acquire the per-user ApplicationAutomationPolicy row lock using minimal,
//     parameterized Prisma tagged-template SQL:
//       tx.$queryRaw`SELECT "id" FROM "ApplicationAutomationPolicy" WHERE "userId" = ${userId} FOR UPDATE`
//
//   4. After the lock, re-read the authoritative:
//        - policy;
//        - run state / version / lease;
//        - current job fit score;
//        - current job-match confidence;
//        - explicit resume assignment / selectability;
//        - explicit cover-letter assignment / selectability;
//        - blocked-host status.
//
//   5. Re-check the live PREPARING lease and classify acquisition using the
//      authoritative run state.
//
//   6. Evaluate the global capability flag and the locked/current policy.
//
//   7. Evaluate all deterministic preparation gates using the authoritative
//      post-lock values.
//
//   8. If a gate fails:
//        - perform a guarded BLOCKED transition;
//        - do not set firstPreparingAt;
//        - do not consume a daily-cap slot.
//
//   9. Only for first-acquire:
//        count runs where firstPreparingAt >= dailyCapWindowStart(now)
//        and enforce the rolling cap.
//
//   10. CAS acquire PREPARING with the expected state/version, fresh attempt ID,
//       ten-minute lease, incremented stateVersion, and firstPreparingAt written
//       only when currently null.
//
// COMMIT TX1.
// Provider call (Kimi/Gemini) happens with NO transaction open.
// TX2 (short): guarded updateMany { id, state: PREPARING, prepareAttemptId, stateVersion }
//   with buildPreparationCommitData(); count ≠ 1 ⇒ discard the provider result.
// ---------------------------------------------------------------------------
