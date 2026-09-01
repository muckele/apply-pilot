import type { ApplicationAnswerProposal } from "@/lib/application-runs/answer-packet-domain";
import type { ApplicationFormFieldType } from "@/lib/application-runs/form-inspection";

export const FILL_LEASE_MS = 600_000;

export const FILL_ELIGIBLE_FIELD_TYPES = [
  "TEXT",
  "EMAIL",
  "TEL",
  "URL",
  "TEXTAREA",
  "SELECT_ONE",
  "RADIO_GROUP",
  "CHECKBOX_BOOLEAN"
] as const satisfies readonly ApplicationFormFieldType[];

export const FILL_STEP_RESULTS = [
  "FILLED",
  "PRESERVED_EXISTING",
  "MANUAL",
  "FAILED",
  "NOT_ATTEMPTED"
] as const;

export const FILL_ATTEMPT_OUTCOMES = ["COMPLETED", "STOPPED_EARLY", "RECOVERED_AFTER_LOSS"] as const;

export const FILL_ERROR_CODES = [
  "FILL_POLICY_DENIED",
  "FILL_REVIEW_REQUIRED",
  "FILL_ALREADY_IN_PROGRESS",
  "FILL_NO_ELIGIBLE_FIELDS",
  "FILL_STALE",
  "FILL_TARGET_TRUST_LOST",
  "FILL_UNEXPECTED_MUTATION",
  "FILL_WRITE_FAILED",
  "FILL_INTERNAL"
] as const;

export const STOPPED_EARLY_FILL_ERRORS = [
  "FILL_POLICY_DENIED",
  "FILL_TARGET_TRUST_LOST",
  "FILL_UNEXPECTED_MUTATION",
  "FILL_WRITE_FAILED",
  "FILL_INTERNAL"
] as const satisfies readonly FillErrorCode[];

export type FillEligibleFieldType = (typeof FILL_ELIGIBLE_FIELD_TYPES)[number];
export type FillStepResult = (typeof FILL_STEP_RESULTS)[number];
export type FillAttemptOutcome = (typeof FILL_ATTEMPT_OUTCOMES)[number];
export type FillErrorCode = (typeof FILL_ERROR_CODES)[number];
export type StoppedEarlyFillError = (typeof STOPPED_EARLY_FILL_ERRORS)[number];

const eligibleFieldTypes = new Set<string>(FILL_ELIGIBLE_FIELD_TYPES);
const fillStepResults = new Set<string>(FILL_STEP_RESULTS);
const fillErrorCodes = new Set<string>(FILL_ERROR_CODES);
const stoppedEarlyFillErrors = new Set<string>(STOPPED_EARLY_FILL_ERRORS);
const successfulFillStepResults = new Set<FillStepResult>([
  "FILLED",
  "PRESERVED_EXISTING",
  "MANUAL"
]);
const FIELD_KEY_PATTERN = /^[a-f0-9]{64}$/;

export class FillAttemptDomainError extends Error {
  readonly code = "FILL_INTERNAL" as const;

  constructor() {
    super("Fill attempt persistence is invalid.");
    this.name = "FillAttemptDomainError";
  }
}

function invalidFillDomain(): never {
  throw new FillAttemptDomainError();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isFillStepResult(value: unknown): value is FillStepResult {
  return typeof value === "string" && fillStepResults.has(value);
}

function isFillErrorCode(value: unknown): value is FillErrorCode {
  return typeof value === "string" && fillErrorCodes.has(value);
}

export function isStoppedEarlyFillError(value: unknown): value is StoppedEarlyFillError {
  return typeof value === "string" && stoppedEarlyFillErrors.has(value);
}

function isAttemptStepKey(stepKey: string, fillAttemptId: string): boolean {
  const prefix = `fill:${fillAttemptId}:`;
  return stepKey.startsWith(prefix) && FIELD_KEY_PATTERN.test(stepKey.slice(prefix.length));
}

export type VerifiedFillCandidate = Readonly<{
  normalizedFieldKey: string;
  fieldFingerprint: string;
  fieldType: ApplicationFormFieldType;
  proposal: ApplicationAnswerProposal | null;
}>;

export type FillEligibleField = Readonly<{
  normalizedFieldKey: string;
  fieldFingerprint: string;
  fieldType: FillEligibleFieldType;
  proposal: ApplicationAnswerProposal;
}>;

export function projectVerifiedFillCandidates(
  candidates: readonly VerifiedFillCandidate[]
): FillEligibleField[] {
  return candidates.filter(
    (candidate): candidate is FillEligibleField =>
      candidate.proposal !== null && eligibleFieldTypes.has(candidate.fieldType)
  );
}

export type FillStepPersistence = Readonly<{
  status: "SUCCEEDED" | "SKIPPED" | "FAILED";
  redactedValueSummary: FillStepResult;
  errorCategory: FillErrorCode | null;
}>;

export function mapFillStepResultToPersistence(input: {
  result: unknown;
  errorCode: unknown;
}): FillStepPersistence {
  if (!isFillStepResult(input.result)) invalidFillDomain();

  if (input.result === "FAILED") {
    if (!isFillErrorCode(input.errorCode)) invalidFillDomain();
    return {
      status: "FAILED",
      redactedValueSummary: "FAILED",
      errorCategory: input.errorCode
    };
  }

  if (input.errorCode !== null) invalidFillDomain();
  return {
    status: input.result === "FILLED" ? "SUCCEEDED" : "SKIPPED",
    redactedValueSummary: input.result,
    errorCategory: null
  };
}

export type PersistedFillStepIdentity = Readonly<{
  fillAttemptId: string;
  stepKey: string;
}>;

export type FillFinalizationStepAssertion = Readonly<{
  stepKey: string;
  result: FillStepResult;
  errorCode: FillErrorCode | null;
}>;

export type FillFinalizationAssertion = Readonly<{
  fillAttemptId: string;
  outcome: "COMPLETED" | "STOPPED_EARLY";
  errorCode: StoppedEarlyFillError | null;
  steps: readonly FillFinalizationStepAssertion[];
}>;

export type FillFinalizationReconciliation = Readonly<{
  outcome: "COMPLETED" | "STOPPED_EARLY";
  errorCategory: StoppedEarlyFillError | null;
  steps: readonly (FillStepPersistence & { stepKey: string })[];
}>;

function parseFinalizationAssertion(value: unknown): FillFinalizationAssertion {
  if (!isRecord(value) || !hasExactKeys(value, ["fillAttemptId", "outcome", "errorCode", "steps"])) {
    invalidFillDomain();
  }
  if (
    typeof value.fillAttemptId !== "string" ||
    (value.outcome !== "COMPLETED" && value.outcome !== "STOPPED_EARLY") ||
    !Array.isArray(value.steps)
  ) {
    invalidFillDomain();
  }

  const steps = value.steps.map((step): FillFinalizationStepAssertion => {
    if (!isRecord(step) || !hasExactKeys(step, ["stepKey", "result", "errorCode"])) {
      invalidFillDomain();
    }
    if (
      typeof step.stepKey !== "string" ||
      !isFillStepResult(step.result) ||
      (step.errorCode !== null && !isFillErrorCode(step.errorCode))
    ) {
      invalidFillDomain();
    }
    return {
      stepKey: step.stepKey,
      result: step.result,
      errorCode: step.errorCode
    };
  });

  if (
    (value.outcome === "COMPLETED" && value.errorCode !== null) ||
    (value.outcome === "STOPPED_EARLY" && !isStoppedEarlyFillError(value.errorCode))
  ) {
    invalidFillDomain();
  }

  return {
    fillAttemptId: value.fillAttemptId,
    outcome: value.outcome,
    errorCode: value.errorCode as StoppedEarlyFillError | null,
    steps
  };
}

function hasUniqueValues(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

function isValidStoppedStepPattern(
  steps: readonly FillFinalizationStepAssertion[],
  stoppingError: StoppedEarlyFillError
): boolean {
  let tailStarted = false;
  let failedCount = 0;

  for (const step of steps) {
    if (successfulFillStepResults.has(step.result)) {
      if (tailStarted || step.errorCode !== null) return false;
      continue;
    }
    if (step.result === "FAILED") {
      if (tailStarted || step.errorCode !== stoppingError) return false;
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

  return failedCount <= 1;
}

export function reconcileFillFinalization(input: {
  fillAttemptId: string;
  persistedSteps: readonly PersistedFillStepIdentity[];
  assertion: unknown;
}): FillFinalizationReconciliation {
  const assertion = parseFinalizationAssertion(input.assertion);
  if (
    typeof input.fillAttemptId !== "string" ||
    assertion.fillAttemptId !== input.fillAttemptId ||
    input.persistedSteps.length === 0 ||
    assertion.steps.length !== input.persistedSteps.length
  ) {
    invalidFillDomain();
  }

  const persistedKeys = input.persistedSteps.map((step) => step.stepKey);
  const clientKeys = assertion.steps.map((step) => step.stepKey);
  if (!hasUniqueValues(persistedKeys) || !hasUniqueValues(clientKeys)) invalidFillDomain();

  for (let index = 0; index < input.persistedSteps.length; index += 1) {
    const persisted = input.persistedSteps[index];
    if (
      persisted.fillAttemptId !== input.fillAttemptId ||
      !isAttemptStepKey(persisted.stepKey, input.fillAttemptId) ||
      clientKeys[index] !== persisted.stepKey
    ) {
      invalidFillDomain();
    }
  }

  if (
    assertion.outcome === "COMPLETED"
      ? assertion.steps.some(
          (step) => !successfulFillStepResults.has(step.result) || step.errorCode !== null
        )
      : !isValidStoppedStepPattern(assertion.steps, assertion.errorCode as StoppedEarlyFillError)
  ) {
    invalidFillDomain();
  }

  return {
    outcome: assertion.outcome,
    errorCategory: assertion.errorCode,
    steps: assertion.steps.map((step) => ({
      stepKey: step.stepKey,
      ...mapFillStepResultToPersistence({ result: step.result, errorCode: step.errorCode })
    }))
  };
}

export type TerminalFillAttemptOutcome = Readonly<{
  outcome: FillAttemptOutcome | null;
  errorCode: FillErrorCode | null;
}>;

type PersistedFillStepFact = Readonly<{
  stepKey: string;
  status: string;
  redactedValueSummary: FillStepResult;
  errorCategory: FillErrorCode | null;
}>;

function unavailableOutcome(): TerminalFillAttemptOutcome {
  return { outcome: null, errorCode: "FILL_INTERNAL" };
}

function parsePersistedStepFact(value: unknown): PersistedFillStepFact & { result: FillStepResult } {
  if (
    !isRecord(value) ||
    typeof value.stepKey !== "string" ||
    typeof value.status !== "string" ||
    !isFillStepResult(value.redactedValueSummary) ||
    (value.errorCategory !== null && !isFillErrorCode(value.errorCategory))
  ) {
    invalidFillDomain();
  }
  const expected = mapFillStepResultToPersistence({
    result: value.redactedValueSummary,
    errorCode: value.errorCategory
  });
  if (
    value.status !== expected.status ||
    value.redactedValueSummary !== expected.redactedValueSummary ||
    value.errorCategory !== expected.errorCategory
  ) {
    invalidFillDomain();
  }
  return {
    stepKey: value.stepKey,
    status: value.status,
    redactedValueSummary: value.redactedValueSummary,
    errorCategory: value.errorCategory,
    result: value.redactedValueSummary
  };
}

function isRecoveryConsistent(
  steps: readonly (PersistedFillStepFact & { result: FillStepResult })[]
): boolean {
  let unresolvedStarted = false;
  let unresolvedCount = 0;
  for (const step of steps) {
    if (successfulFillStepResults.has(step.result)) {
      if (unresolvedStarted || step.errorCategory !== null) return false;
      continue;
    }
    if (step.result !== "FAILED" || step.errorCategory !== "FILL_STALE") return false;
    unresolvedStarted = true;
    unresolvedCount += 1;
  }
  return unresolvedCount > 0;
}

export function deriveTerminalFillAttemptOutcome(input: unknown): TerminalFillAttemptOutcome {
  if (isRecord(input) && input.state === "CANCELLED") {
    return { outcome: null, errorCode: null };
  }

  try {
    if (
      !isRecord(input) ||
      input.state !== "READY_FOR_USER_SUBMISSION" ||
      typeof input.fillAttemptId !== "string" ||
      input.fillAttemptId.length === 0 ||
      !Array.isArray(input.canonicalStepKeys) ||
      !Array.isArray(input.steps) ||
      input.canonicalStepKeys.length === 0 ||
      input.canonicalStepKeys.length !== input.steps.length
    ) {
      return unavailableOutcome();
    }

    const canonicalStepKeys = input.canonicalStepKeys;
    if (
      canonicalStepKeys.some((key) => typeof key !== "string") ||
      !hasUniqueValues(canonicalStepKeys as string[]) ||
      (canonicalStepKeys as string[]).some((key) => !isAttemptStepKey(key, input.fillAttemptId as string))
    ) {
      return unavailableOutcome();
    }

    const steps = input.steps.map(parsePersistedStepFact);
    if (
      !hasUniqueValues(steps.map((step) => step.stepKey)) ||
      steps.some((step, index) => step.stepKey !== canonicalStepKeys[index])
    ) {
      return unavailableOutcome();
    }

    if (input.errorCategory === null) {
      return steps.every(
        (step) => successfulFillStepResults.has(step.result) && step.errorCategory === null
      )
        ? { outcome: "COMPLETED", errorCode: null }
        : unavailableOutcome();
    }

    if (isStoppedEarlyFillError(input.errorCategory)) {
      const assertions = steps.map((step) => ({
        stepKey: step.stepKey,
        result: step.result,
        errorCode: step.errorCategory
      }));
      return isValidStoppedStepPattern(assertions, input.errorCategory)
        ? { outcome: "STOPPED_EARLY", errorCode: input.errorCategory }
        : unavailableOutcome();
    }

    if (input.errorCategory === "FILL_STALE") {
      return isRecoveryConsistent(steps)
        ? { outcome: "RECOVERED_AFTER_LOSS", errorCode: "FILL_STALE" }
        : unavailableOutcome();
    }

    return unavailableOutcome();
  } catch {
    return unavailableOutcome();
  }
}
