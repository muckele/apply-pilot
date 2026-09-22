import type { ApplicationRunState } from "@prisma/client";

import {
  FILL_ATTEMPT_OUTCOMES,
  FILL_ERROR_CODES,
  FILL_STEP_RESULTS,
  STOPPED_EARLY_FILL_ERRORS,
  type FillAttemptOutcome,
  type FillErrorCode,
  type FillStepResult
} from "@/lib/application-runs/fill-attempt-domain";

const MAX_FILL_STATUS_STEPS = 200;

export type BrowserFillStepResult = Readonly<{
  stepKey: string;
  result: FillStepResult;
  errorCode: FillErrorCode | null;
}>;

export type BrowserFillAttemptStatus = Readonly<{
  state: ApplicationRunState;
  stateVersion: number;
  fillAttemptId: string | null;
  fillLeaseExpiresAt: string | null;
  leaseLive: boolean;
  expiredRecoveryRequired: boolean;
  fieldOperationAllowed: boolean;
  outcome: FillAttemptOutcome | null;
  errorCode: FillErrorCode | null;
  steps: readonly BrowserFillStepResult[];
}>;

export type FillStatusDisplayCategory =
  | "NO_ATTEMPT"
  | "FILLING"
  | "RECOVERY_PENDING"
  | "COMPLETED"
  | "STOPPED_EARLY"
  | "RECOVERED_AFTER_LOSS"
  | "CANCELLED"
  | "ATTEMPT_CONSUMED"
  | "UNAVAILABLE";

export type FillResultCounts = Readonly<{
  filled: number;
  preservedExisting: number;
  runtimeManual: number;
  failed: number;
  notAttempted: number;
}>;

export type FillStatusPresentation = Readonly<{
  category: FillStatusDisplayCategory;
  tone: "INFO" | "SUCCESS" | "WARNING" | "ERROR";
  title: string;
  text: string;
  allowRecoveryMutation: false;
  counts: FillResultCounts;
}>;

export type FillStatusSnapshotReconciliation = Readonly<{
  status: BrowserFillAttemptStatus;
  verified: boolean;
  decision:
    | "ACCEPTED_INITIAL"
    | "ACCEPTED_NEWER"
    | "ACCEPTED_UNAVAILABLE"
    | "UNCHANGED"
    | "IGNORED_OLDER"
    | "CONTRADICTION";
}>;

const APPLICATION_RUN_STATES = new Set<string>([
  "DRAFT",
  "PREPARING",
  "READY",
  "FILLING",
  "REVIEW_REQUIRED",
  "READY_FOR_USER_SUBMISSION",
  "COMPLETED_BY_USER",
  "BLOCKED",
  "FAILED",
  "CANCELLED"
]);
const FILL_ATTEMPT_OUTCOME_SET = new Set<string>(FILL_ATTEMPT_OUTCOMES);
const FILL_ERROR_CODE_SET = new Set<string>(FILL_ERROR_CODES);
const FILL_STEP_RESULT_SET = new Set<string>(FILL_STEP_RESULTS);
const STOPPED_EARLY_ERROR_SET = new Set<string>(STOPPED_EARLY_FILL_ERRORS);
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index]);
}

function isKnownRunState(value: unknown): value is ApplicationRunState {
  return typeof value === "string" && APPLICATION_RUN_STATES.has(value);
}

function isSafeNonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function isCanonicalIsoDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

function isFillAttemptOutcome(value: unknown): value is FillAttemptOutcome {
  return typeof value === "string" && FILL_ATTEMPT_OUTCOME_SET.has(value);
}

function isFillErrorCode(value: unknown): value is FillErrorCode {
  return typeof value === "string" && FILL_ERROR_CODE_SET.has(value);
}

function isFillStepResult(value: unknown): value is FillStepResult {
  return typeof value === "string" && FILL_STEP_RESULT_SET.has(value);
}

function invalidFillStatusResponse(): never {
  throw new Error("Invalid Fill status response.");
}

export function parseFillStatusResponse(value: unknown): BrowserFillAttemptStatus {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "state",
      "stateVersion",
      "fillAttemptId",
      "fillLeaseExpiresAt",
      "leaseLive",
      "expiredRecoveryRequired",
      "fieldOperationAllowed",
      "outcome",
      "errorCode",
      "steps"
    ]) ||
    !isKnownRunState(value.state) ||
    !isSafeNonnegativeInteger(value.stateVersion) ||
    !(value.fillAttemptId === null || isUuid(value.fillAttemptId)) ||
    !(value.fillLeaseExpiresAt === null || isCanonicalIsoDate(value.fillLeaseExpiresAt)) ||
    typeof value.leaseLive !== "boolean" ||
    typeof value.expiredRecoveryRequired !== "boolean" ||
    typeof value.fieldOperationAllowed !== "boolean" ||
    !(value.outcome === null || isFillAttemptOutcome(value.outcome)) ||
    !(value.errorCode === null || isFillErrorCode(value.errorCode)) ||
    !Array.isArray(value.steps) ||
    value.steps.length > MAX_FILL_STATUS_STEPS
  ) {
    invalidFillStatusResponse();
  }

  const stepKeys = new Set<string>();
  const steps = value.steps.map((candidate): BrowserFillStepResult => {
    if (
      !isRecord(candidate) ||
      !hasExactKeys(candidate, ["stepKey", "result", "errorCode"]) ||
      typeof candidate.stepKey !== "string" ||
      !isFillStepResult(candidate.result) ||
      !(candidate.errorCode === null || isFillErrorCode(candidate.errorCode)) ||
      (candidate.result === "FAILED") !== (candidate.errorCode !== null) ||
      stepKeys.has(candidate.stepKey) ||
      (value.fillAttemptId !== null &&
        (!candidate.stepKey.startsWith(`fill:${value.fillAttemptId}:`) ||
          !SHA256_PATTERN.test(candidate.stepKey.slice(`fill:${value.fillAttemptId}:`.length))))
    ) {
      invalidFillStatusResponse();
    }
    stepKeys.add(candidate.stepKey);
    return Object.freeze({
      stepKey: candidate.stepKey,
      result: candidate.result,
      errorCode: candidate.errorCode
    });
  });

  if (steps.length > 0 && value.fillAttemptId === null) invalidFillStatusResponse();

  return Object.freeze({
    state: value.state,
    stateVersion: value.stateVersion,
    fillAttemptId: value.fillAttemptId,
    fillLeaseExpiresAt: value.fillLeaseExpiresAt,
    leaseLive: value.leaseLive,
    expiredRecoveryRequired: value.expiredRecoveryRequired,
    fieldOperationAllowed: value.fieldOperationAllowed,
    outcome: value.outcome,
    errorCode: value.errorCode,
    steps: Object.freeze(steps)
  });
}

function hasInactiveLease(status: BrowserFillAttemptStatus): boolean {
  return status.fillLeaseExpiresAt === null &&
    !status.leaseLive &&
    !status.expiredRecoveryRequired &&
    !status.fieldOperationAllowed;
}

function hasNoTerminalResult(status: BrowserFillAttemptStatus): boolean {
  return status.outcome === null && status.errorCode === null && status.steps.length === 0;
}

function validCompletedSteps(steps: readonly BrowserFillStepResult[]): boolean {
  return steps.length > 0 && steps.every((step) =>
    step.errorCode === null &&
    (step.result === "FILLED" || step.result === "PRESERVED_EXISTING" || step.result === "MANUAL")
  );
}

function validStoppedEarlySteps(
  steps: readonly BrowserFillStepResult[],
  errorCode: FillErrorCode
): boolean {
  let tailStarted = false;
  let failedCount = 0;
  for (const step of steps) {
    if (step.result === "FILLED" || step.result === "PRESERVED_EXISTING" || step.result === "MANUAL") {
      if (tailStarted || step.errorCode !== null) return false;
      continue;
    }
    if (step.result === "FAILED") {
      if (tailStarted || step.errorCode !== errorCode) return false;
      tailStarted = true;
      failedCount += 1;
      continue;
    }
    if (step.result === "NOT_ATTEMPTED") {
      if (step.errorCode !== null) return false;
      tailStarted = true;
      continue;
    }
    return false;
  }
  return tailStarted && failedCount <= 1;
}

function validRecoveredSteps(steps: readonly BrowserFillStepResult[]): boolean {
  let recoveredTailStarted = false;
  for (const step of steps) {
    if (step.result === "FILLED" || step.result === "PRESERVED_EXISTING" || step.result === "MANUAL") {
      if (recoveredTailStarted || step.errorCode !== null) return false;
      continue;
    }
    if (step.result !== "FAILED" || step.errorCode !== "FILL_STALE") return false;
    recoveredTailStarted = true;
  }
  return recoveredTailStarted;
}

export function classifyFillStatus(status: BrowserFillAttemptStatus): FillStatusDisplayCategory {
  if (status.state === "CANCELLED") {
    return hasInactiveLease(status) && hasNoTerminalResult(status) ? "CANCELLED" : "UNAVAILABLE";
  }

  if (status.fillAttemptId === null) {
    if (
      hasInactiveLease(status) &&
      hasNoTerminalResult(status) &&
      status.state !== "FILLING" &&
      status.state !== "READY_FOR_USER_SUBMISSION"
    ) {
      return "NO_ATTEMPT";
    }
    return "UNAVAILABLE";
  }

  if (status.state === "FILLING") {
    if (
      status.fillLeaseExpiresAt === null ||
      status.outcome !== null ||
      status.errorCode !== null ||
      status.steps.length !== 0
    ) {
      return "UNAVAILABLE";
    }
    if (status.leaseLive && !status.expiredRecoveryRequired) return "FILLING";
    if (!status.leaseLive && status.expiredRecoveryRequired && !status.fieldOperationAllowed) {
      return "RECOVERY_PENDING";
    }
    return "UNAVAILABLE";
  }

  if (status.state === "READY_FOR_USER_SUBMISSION") {
    if (!hasInactiveLease(status) || status.outcome === null || status.steps.length === 0) {
      return "UNAVAILABLE";
    }
    if (status.outcome === "COMPLETED") {
      return status.errorCode === null && validCompletedSteps(status.steps)
        ? "COMPLETED"
        : "UNAVAILABLE";
    }
    if (status.outcome === "STOPPED_EARLY") {
      return status.errorCode !== null &&
        STOPPED_EARLY_ERROR_SET.has(status.errorCode) &&
        validStoppedEarlySteps(status.steps, status.errorCode)
        ? "STOPPED_EARLY"
        : "UNAVAILABLE";
    }
    return status.errorCode === "FILL_STALE" && validRecoveredSteps(status.steps)
      ? "RECOVERED_AFTER_LOSS"
      : "UNAVAILABLE";
  }

  if (
    (status.state === "REVIEW_REQUIRED" || status.state === "COMPLETED_BY_USER") &&
    hasInactiveLease(status) &&
    hasNoTerminalResult(status)
  ) {
    return "ATTEMPT_CONSUMED";
  }

  return "UNAVAILABLE";
}

function sameFillStatus(
  left: BrowserFillAttemptStatus,
  right: BrowserFillAttemptStatus
): boolean {
  if (
    left.state !== right.state ||
    left.stateVersion !== right.stateVersion ||
    left.fillAttemptId !== right.fillAttemptId ||
    left.fillLeaseExpiresAt !== right.fillLeaseExpiresAt ||
    left.leaseLive !== right.leaseLive ||
    left.expiredRecoveryRequired !== right.expiredRecoveryRequired ||
    left.fieldOperationAllowed !== right.fieldOperationAllowed ||
    left.outcome !== right.outcome ||
    left.errorCode !== right.errorCode ||
    left.steps.length !== right.steps.length
  ) {
    return false;
  }
  return left.steps.every((step, index) => {
    const other = right.steps[index];
    return step.stepKey === other.stepKey &&
      step.result === other.result &&
      step.errorCode === other.errorCode;
  });
}

export function reconcileFillStatusSnapshot(input: Readonly<{
  current: BrowserFillAttemptStatus | null;
  currentVerified: boolean;
  incoming: BrowserFillAttemptStatus;
}>): FillStatusSnapshotReconciliation {
  if (input.current === null) {
    const verified = classifyFillStatus(input.incoming) !== "UNAVAILABLE";
    return Object.freeze({
      status: input.incoming,
      verified,
      decision: verified ? "ACCEPTED_INITIAL" : "ACCEPTED_UNAVAILABLE"
    });
  }
  if (input.incoming.stateVersion < input.current.stateVersion) {
    return Object.freeze({
      status: input.current,
      verified: input.currentVerified,
      decision: "IGNORED_OLDER"
    });
  }
  if (input.incoming.stateVersion === input.current.stateVersion) {
    if (sameFillStatus(input.current, input.incoming)) {
      return Object.freeze({
        status: input.current,
        verified: input.currentVerified,
        decision: "UNCHANGED"
      });
    }
    return Object.freeze({
      status: input.current,
      verified: false,
      decision: "CONTRADICTION"
    });
  }
  const verified = classifyFillStatus(input.incoming) !== "UNAVAILABLE";
  return Object.freeze({
    status: input.incoming,
    verified,
    decision: verified ? "ACCEPTED_NEWER" : "ACCEPTED_UNAVAILABLE"
  });
}

export function aggregateFillResults(
  steps: readonly BrowserFillStepResult[]
): FillResultCounts {
  const counts = {
    filled: 0,
    preservedExisting: 0,
    runtimeManual: 0,
    failed: 0,
    notAttempted: 0
  };
  for (const step of steps) {
    if (step.result === "FILLED") counts.filled += 1;
    else if (step.result === "PRESERVED_EXISTING") counts.preservedExisting += 1;
    else if (step.result === "MANUAL") counts.runtimeManual += 1;
    else if (step.result === "FAILED") counts.failed += 1;
    else counts.notAttempted += 1;
  }
  return Object.freeze(counts);
}

const EMPTY_COUNTS = Object.freeze({
  filled: 0,
  preservedExisting: 0,
  runtimeManual: 0,
  failed: 0,
  notAttempted: 0
});

function copyForCategory(category: FillStatusDisplayCategory): Pick<FillStatusPresentation, "tone" | "title" | "text"> {
  if (category === "NO_ATTEMPT") {
    return {
      tone: "INFO",
      title: "Fill has not started",
      text: "No Fill attempt has been consumed. Fill is available only after the reviewed packet and browser authority are verified. Apply Pilot has not submitted this application."
    };
  }
  if (category === "FILLING") {
    return {
      tone: "INFO",
      title: "Fill is in progress",
      text: "Approved supported fields are being processed. Do not start Fill again. Apply Pilot has not submitted this application."
    };
  }
  if (category === "RECOVERY_PENDING") {
    return {
      tone: "WARNING",
      title: "Fill recovery is pending",
      text: "Fill recovery is pending. Do not start Fill again. Use Refresh Fill status for a read-only update. Review the employer form manually while the outcome remains uncertain. Apply Pilot has not submitted this application."
    };
  }
  if (category === "COMPLETED") {
    return {
      tone: "SUCCESS",
      title: "Automated Fill attempt finished",
      text: "Approved supported fields were processed. Apply Pilot has finished its automated Fill attempt. Review the employer form carefully. Complete every remaining manual field. Confirm that preserved existing values are correct. Then personally use the employer site's Submit button. Apply Pilot has not submitted this application."
    };
  }
  if (category === "STOPPED_EARLY") {
    return {
      tone: "WARNING",
      title: "Fill stopped early",
      text: "Fill stopped early. Some approved fields may have been filled or preserved before the safe stop. Review every employer field and complete all remaining work manually. Do not run Fill again. Apply Pilot has not submitted this application."
    };
  }
  if (category === "RECOVERED_AFTER_LOSS") {
    return {
      tone: "WARNING",
      title: "Fill outcome could not be fully verified",
      text: "Fill outcome could not be fully verified after browser loss. Some earlier fields may have been handled, but Apply Pilot cannot attest to the complete outcome. Review every employer field manually before submission. Do not run Fill again. Apply Pilot has not submitted this application."
    };
  }
  if (category === "CANCELLED") {
    return {
      tone: "WARNING",
      title: "Application run cancelled",
      text: "Fill is unavailable for this cancelled run. Complete any remaining employer-form work manually. Apply Pilot has not submitted this application."
    };
  }
  if (category === "ATTEMPT_CONSUMED") {
    return {
      tone: "WARNING",
      title: "Fill attempt already consumed",
      text: "This run has already consumed its one Fill attempt. Review and complete the employer form manually. Do not run Fill again. Apply Pilot has not submitted this application."
    };
  }
  return {
    tone: "ERROR",
    title: "Fill status unavailable",
    text: "Apply Pilot could not safely verify the Fill status. Do not start or repeat Fill. Refresh Fill status for a read-only update and review the employer form manually. Apply Pilot has not submitted this application."
  };
}

export function fillStatusPresentation(status: BrowserFillAttemptStatus): FillStatusPresentation {
  const category = classifyFillStatus(status);
  const copy = copyForCategory(category);
  return Object.freeze({
    category,
    ...copy,
    allowRecoveryMutation: false,
    counts: status.steps.length === 0 ? EMPTY_COUNTS : aggregateFillResults(status.steps)
  });
}

const STOPPED_ERROR_DESCRIPTIONS: Readonly<Partial<Record<FillErrorCode, string>>> = Object.freeze({
  FILL_POLICY_DENIED: "Fill stopped because the current automation policy does not permit it.",
  FILL_TARGET_TRUST_LOST: "Fill stopped because trust in the employer page was lost.",
  FILL_UNEXPECTED_MUTATION: "Fill stopped because the employer field changed unexpectedly.",
  FILL_WRITE_FAILED: "Fill stopped because a protected field write could not be completed safely.",
  FILL_INTERNAL: "Fill stopped because Apply Pilot could not verify its internal Fill state."
});

export function stoppedFillErrorDescription(errorCode: FillErrorCode | null): string | null {
  if (errorCode === null) return null;
  return STOPPED_ERROR_DESCRIPTIONS[errorCode] ?? null;
}
