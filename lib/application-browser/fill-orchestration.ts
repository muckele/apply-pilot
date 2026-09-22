import {
  ApplicationFormInspectionControllerError,
  type AcquiredFillAuthority
} from "@/lib/application-browser/form-inspection-controller";
import {
  SameOriginClientError,
  type BrowserFillAcquisition,
  type BrowserFillAttemptStatus,
  type BrowserFillFinalizeInput,
  type BrowserFillStepResult,
  type SameOriginClient,
  type SameOriginFillClient
} from "@/lib/application-browser/same-origin-client";
import { parseApplicationAnswerProposal } from "@/lib/application-runs/answer-packet-domain";
import type {
  ProtectedCandidateFieldWriteRequest,
  ProtectedCandidateFieldWriteResult
} from "@/lib/application-browser/protected-browser-session";
import {
  reconcileFillFinalization,
  type FillErrorCode,
  type StoppedEarlyFillError
} from "@/lib/application-runs/fill-attempt-domain";
import { MAX_FIELDS_TOTAL } from "@/lib/application-runs/form-inspection";
import {
  isHostAllowedForExecution,
  parseExecutionTargetUrl,
  type ExecutionTarget
} from "@/lib/application-runs/host-policy";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const WRITABLE_FIELD_TYPES = new Set(["TEXT", "EMAIL", "TEL", "URL", "TEXTAREA", "SELECT_ONE"]);
const DEFINITIVE_ACQUISITION_REJECTIONS = new Set<FillErrorCode>([
  "FILL_POLICY_DENIED",
  "FILL_REVIEW_REQUIRED",
  "FILL_ALREADY_IN_PROGRESS",
  "FILL_NO_ELIGIBLE_FIELDS",
  "FILL_STALE"
]);

export type GuardedFillControllerPort = Readonly<{
  currentTargetUrl(): string | null;
  assertCurrent(generationId: symbol): Promise<Readonly<{ generationId: symbol }>>;
  assertAcquiredFillAuthority(generationId: symbol, authority: AcquiredFillAuthority): void;
  writeApprovedField(
    generationId: symbol,
    request: ProtectedCandidateFieldWriteRequest
  ): Promise<ProtectedCandidateFieldWriteResult>;
}>;

export type GuardedFillExecutionInput = Readonly<{
  runId: string;
  generationId: symbol;
  formInspectionVersion: number;
  answerPacketVersion: number;
  frozenTargetUrl: string;
  assertActive(): void;
}>;

export type GuardedFillOrchestrationResult = Readonly<{
  disposition: "FINALIZED" | "RECOVERY_PENDING" | "CANCELLED";
  status: BrowserFillAttemptStatus;
}>;

export class GuardedFillOrchestrationError extends Error {
  readonly code: FillErrorCode;

  constructor(code: FillErrorCode) {
    super(`Guarded Fill orchestration stopped safely: ${code}`);
    this.name = "GuardedFillOrchestrationError";
    this.code = code;
  }
}

type FillClient = SameOriginClient & SameOriginFillClient;

type Dependencies = Readonly<{
  client: FillClient;
  controller: GuardedFillControllerPort;
  now?: () => number;
  onAcquisitionUncertain?: () => void;
}>;

type FrozenAcquisition = BrowserFillAcquisition;

function failure(code: FillErrorCode): GuardedFillOrchestrationError {
  return new GuardedFillOrchestrationError(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index]);
}

function isSafePositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isSafeNonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isCanonicalIsoDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

function freezeProposal(
  value: unknown,
  fieldType: string
): ProtectedCandidateFieldWriteRequest["proposal"] {
  if (!isRecord(value)) throw failure("FILL_INTERNAL");
  let parsed;
  try {
    parsed = parseApplicationAnswerProposal(value);
  } catch {
    throw failure("FILL_INTERNAL");
  }
  if (fieldType === "SELECT_ONE") {
    if (
      !hasExactKeys(value, ["kind", "optionKeys"]) ||
      parsed.kind !== "OPTIONS" ||
      parsed.optionKeys.length !== 1 ||
      !SHA256_PATTERN.test(parsed.optionKeys[0])
    ) {
      throw failure("FILL_INTERNAL");
    }
    return Object.freeze({
      kind: "OPTIONS" as const,
      optionKeys: Object.freeze([parsed.optionKeys[0]]) as readonly [string]
    });
  }
  if (
    !hasExactKeys(value, ["kind", "value"]) ||
    parsed.kind !== "SCALAR"
  ) {
    throw failure("FILL_INTERNAL");
  }
  return Object.freeze({ kind: "SCALAR" as const, value: parsed.value });
}

function validateAndFreezeAcquisition(value: unknown): FrozenAcquisition {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "attemptId",
      "runStateVersion",
      "leaseExpiresAt",
      "formInspectionVersion",
      "answerPacketVersion",
      "packetHash",
      "formFingerprint",
      "eligibleFields"
    ]) ||
    typeof value.attemptId !== "string" ||
    !UUID_PATTERN.test(value.attemptId) ||
    !isSafeNonnegativeInteger(value.runStateVersion) ||
    !isCanonicalIsoDate(value.leaseExpiresAt) ||
    !isSafePositiveInteger(value.formInspectionVersion) ||
    !isSafePositiveInteger(value.answerPacketVersion) ||
    typeof value.packetHash !== "string" ||
    !SHA256_PATTERN.test(value.packetHash) ||
    typeof value.formFingerprint !== "string" ||
    !SHA256_PATTERN.test(value.formFingerprint) ||
    !Array.isArray(value.eligibleFields) ||
    value.eligibleFields.length < 1 ||
    value.eligibleFields.length > MAX_FIELDS_TOTAL
  ) {
    throw failure("FILL_INTERNAL");
  }

  const fieldKeys = new Set<string>();
  const stepKeys = new Set<string>();
  const eligibleFields = value.eligibleFields.map((candidate) => {
    if (
      !isRecord(candidate) ||
      !hasExactKeys(candidate, [
        "stepKey",
        "normalizedFieldKey",
        "fieldFingerprint",
        "fieldType",
        "proposal"
      ]) ||
      typeof candidate.stepKey !== "string" ||
      typeof candidate.normalizedFieldKey !== "string" ||
      !SHA256_PATTERN.test(candidate.normalizedFieldKey) ||
      typeof candidate.fieldFingerprint !== "string" ||
      !SHA256_PATTERN.test(candidate.fieldFingerprint) ||
      typeof candidate.fieldType !== "string" ||
      !WRITABLE_FIELD_TYPES.has(candidate.fieldType) ||
      candidate.stepKey !== `fill:${value.attemptId}:${candidate.normalizedFieldKey}` ||
      fieldKeys.has(candidate.normalizedFieldKey) ||
      stepKeys.has(candidate.stepKey)
    ) {
      throw failure("FILL_INTERNAL");
    }
    fieldKeys.add(candidate.normalizedFieldKey);
    stepKeys.add(candidate.stepKey);
    return Object.freeze({
      stepKey: candidate.stepKey,
      normalizedFieldKey: candidate.normalizedFieldKey,
      fieldFingerprint: candidate.fieldFingerprint,
      fieldType: candidate.fieldType as ProtectedCandidateFieldWriteRequest["fieldType"],
      proposal: freezeProposal(candidate.proposal, candidate.fieldType)
    });
  });

  return Object.freeze({
    attemptId: value.attemptId,
    runStateVersion: value.runStateVersion,
    leaseExpiresAt: value.leaseExpiresAt,
    formInspectionVersion: value.formInspectionVersion,
    answerPacketVersion: value.answerPacketVersion,
    packetHash: value.packetHash,
    formFingerprint: value.formFingerprint,
    eligibleFields: Object.freeze(eligibleFields)
  });
}

function canonicalTarget(value: string): ExecutionTarget | null {
  const target = parseExecutionTargetUrl(value);
  if (!target) return null;
  target.url.hash = "";
  return target;
}

function sameTarget(left: ExecutionTarget, right: ExecutionTarget): boolean {
  return left.host === right.host && left.url.toString() === right.url.toString();
}

function result(
  disposition: GuardedFillOrchestrationResult["disposition"],
  status: BrowserFillAttemptStatus
): GuardedFillOrchestrationResult {
  return Object.freeze({ disposition, status });
}

function safeCode(error: unknown): string {
  return error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : "FILL_INTERNAL";
}

function stoppingCode(error: unknown): StoppedEarlyFillError {
  const code = safeCode(error);
  if (code === "FILL_POLICY_DENIED" || code === "AUTOMATION_DISABLED" || code === "RUN_HOST_NOT_ALLOWED") {
    return "FILL_POLICY_DENIED";
  }
  if (
    code === "FILL_TARGET_TRUST_LOST" ||
    code === "FORM_GENERATION_INVALIDATED" ||
    code === "FORM_INSPECTION_CANCELLED" ||
    code === "RUN_TARGET_INVALID" ||
    code === "RUN_TARGET_STALE" ||
    code === "TARGET_NAVIGATION_BLOCKED" ||
    code === "TARGET_PAGE_CLOSED" ||
    code === "BROWSER_WORKFLOW_FAILED"
  ) {
    return "FILL_TARGET_TRUST_LOST";
  }
  if (code === "FILL_UNEXPECTED_MUTATION") return "FILL_UNEXPECTED_MUTATION";
  if (code === "FILL_WRITE_FAILED") return "FILL_WRITE_FAILED";
  return "FILL_INTERNAL";
}

function mapWriterResult(value: ProtectedCandidateFieldWriteResult): Readonly<{
  result: "FILLED" | "PRESERVED_EXISTING" | "MANUAL" | "FAILED";
  errorCode: StoppedEarlyFillError | null;
}> {
  if (value.status === "FILLED") return { result: "FILLED", errorCode: null };
  if (value.status === "PRESERVED_EXISTING") {
    return { result: "PRESERVED_EXISTING", errorCode: null };
  }
  if (value.status === "MANUAL" && value.reason === "UNWRITABLE") {
    return { result: "MANUAL", errorCode: null };
  }
  if (value.status === "FAILED") {
    if (value.reason === "CANDIDATE_INVALID" || value.reason === "TARGET_INVALID") {
      return { result: "FAILED", errorCode: "FILL_TARGET_TRUST_LOST" };
    }
    if (value.reason === "UNEXPECTED_ACTIVITY") {
      return { result: "FAILED", errorCode: "FILL_UNEXPECTED_MUTATION" };
    }
    if (value.reason === "WRITE_FAILED") {
      return { result: "FAILED", errorCode: "FILL_WRITE_FAILED" };
    }
  }
  return { result: "FAILED", errorCode: "FILL_INTERNAL" };
}

function stepsEqual(
  left: readonly BrowserFillStepResult[],
  right: readonly BrowserFillStepResult[]
): boolean {
  return left.length === right.length && left.every((step, index) => {
    const expected = right[index];
    return step.stepKey === expected.stepKey &&
      step.result === expected.result &&
      step.errorCode === expected.errorCode;
  });
}

function exactTerminalStatus(
  status: BrowserFillAttemptStatus,
  assertion: BrowserFillFinalizeInput
): boolean {
  return status.state === "READY_FOR_USER_SUBMISSION" &&
    status.stateVersion === assertion.expectedStateVersion + 1 &&
    status.fillAttemptId === assertion.fillAttemptId &&
    status.fillLeaseExpiresAt === null &&
    !status.leaseLive &&
    !status.expiredRecoveryRequired &&
    !status.fieldOperationAllowed &&
    status.outcome === assertion.outcome &&
    status.errorCode === assertion.errorCode &&
    stepsEqual(status.steps, assertion.steps);
}

function validCancelledStatus(status: BrowserFillAttemptStatus): boolean {
  return status.state === "CANCELLED" &&
    isSafeNonnegativeInteger(status.stateVersion) &&
    (status.fillAttemptId === null || UUID_PATTERN.test(status.fillAttemptId)) &&
    status.fillLeaseExpiresAt === null &&
    !status.leaseLive &&
    !status.expiredRecoveryRequired &&
    !status.fieldOperationAllowed &&
    status.outcome === null &&
    status.errorCode === null &&
    status.steps.length === 0;
}

function validKnownCancelledStatus(
  status: BrowserFillAttemptStatus,
  acquired: Pick<FrozenAcquisition, "attemptId" | "runStateVersion">
): boolean {
  return validCancelledStatus(status) &&
    status.fillAttemptId === acquired.attemptId &&
    status.stateVersion > acquired.runStateVersion;
}

function validUnknownTerminalStatus(status: BrowserFillAttemptStatus): boolean {
  if (
    status.state !== "READY_FOR_USER_SUBMISSION" ||
    !isSafeNonnegativeInteger(status.stateVersion) ||
    typeof status.fillAttemptId !== "string" ||
    !UUID_PATTERN.test(status.fillAttemptId) ||
    status.fillLeaseExpiresAt !== null ||
    status.leaseLive ||
    status.expiredRecoveryRequired ||
    status.fieldOperationAllowed ||
    status.outcome === null ||
    status.steps.length < 1 ||
    status.steps.length > MAX_FIELDS_TOTAL
  ) {
    return false;
  }
  const prefix = `fill:${status.fillAttemptId}:`;
  if (
    new Set(status.steps.map((step) => step.stepKey)).size !== status.steps.length ||
    status.steps.some((step) =>
      !step.stepKey.startsWith(prefix) || !SHA256_PATTERN.test(step.stepKey.slice(prefix.length))
    )
  ) {
    return false;
  }
  if (status.outcome === "COMPLETED" || status.outcome === "STOPPED_EARLY") {
    try {
      reconcileFillFinalization({
        fillAttemptId: status.fillAttemptId,
        persistedSteps: status.steps.map((step) => ({
          fillAttemptId: status.fillAttemptId as string,
          stepKey: step.stepKey
        })),
        assertion: {
          fillAttemptId: status.fillAttemptId,
          outcome: status.outcome,
          errorCode: status.errorCode,
          steps: status.steps
        }
      });
      return true;
    } catch {
      return false;
    }
  }
  if (status.outcome !== "RECOVERED_AFTER_LOSS" || status.errorCode !== "FILL_STALE") {
    return false;
  }
  let recoveryTail = false;
  let recoveredSteps = 0;
  for (const step of status.steps) {
    if (
      step.result === "FILLED" ||
      step.result === "PRESERVED_EXISTING" ||
      step.result === "MANUAL"
    ) {
      if (recoveryTail || step.errorCode !== null) return false;
      continue;
    }
    if (step.result !== "FAILED" || step.errorCode !== "FILL_STALE") return false;
    recoveryTail = true;
    recoveredSteps += 1;
  }
  return recoveredSteps > 0;
}

type ActiveStatus =
  | Readonly<{ kind: "LIVE" }>
  | Readonly<{ kind: "LOCAL_DEADLINE" }>
  | Readonly<{ kind: "EXPIRED" }>
  | Readonly<{ kind: "CANCELLED" }>
  | Readonly<{ kind: "POLICY_DENIED" }>;

function classifyKnownActiveStatus(
  status: BrowserFillAttemptStatus,
  acquired: FrozenAcquisition,
  now: number,
  requireFieldPermission: boolean
): ActiveStatus {
  if (status.state === "CANCELLED") {
    if (!validKnownCancelledStatus(status, acquired)) throw failure("FILL_INTERNAL");
    return { kind: "CANCELLED" };
  }
  if (
    status.state !== "FILLING" ||
    status.stateVersion !== acquired.runStateVersion ||
    status.fillAttemptId !== acquired.attemptId ||
    status.fillLeaseExpiresAt !== acquired.leaseExpiresAt ||
    status.outcome !== null ||
    status.errorCode !== null ||
    status.steps.length !== 0
  ) {
    throw failure("FILL_INTERNAL");
  }
  if (
    !status.leaseLive &&
    status.expiredRecoveryRequired &&
    !status.fieldOperationAllowed
  ) {
    return { kind: "EXPIRED" };
  }
  if (!status.leaseLive || status.expiredRecoveryRequired) throw failure("FILL_INTERNAL");
  if (now >= Date.parse(acquired.leaseExpiresAt)) return { kind: "LOCAL_DEADLINE" };
  if (requireFieldPermission && !status.fieldOperationAllowed) return { kind: "POLICY_DENIED" };
  return { kind: "LIVE" };
}

function classifyUnknownActiveStatus(
  status: BrowserFillAttemptStatus,
  now: number
): "LIVE" | "LOCAL_DEADLINE" | "EXPIRED" | "CANCELLED" | "TERMINAL" {
  if (status.state === "CANCELLED") {
    if (!validCancelledStatus(status)) throw failure("FILL_INTERNAL");
    return "CANCELLED";
  }
  if (validUnknownTerminalStatus(status)) return "TERMINAL";
  if (
    status.state !== "FILLING" ||
    typeof status.fillAttemptId !== "string" ||
    !UUID_PATTERN.test(status.fillAttemptId) ||
    status.fillLeaseExpiresAt === null ||
    !isCanonicalIsoDate(status.fillLeaseExpiresAt) ||
    status.outcome !== null ||
    status.errorCode !== null ||
    status.steps.length !== 0
  ) {
    throw failure("FILL_INTERNAL");
  }
  if (!status.leaseLive && status.expiredRecoveryRequired && !status.fieldOperationAllowed) {
    return "EXPIRED";
  }
  if (!status.leaseLive || status.expiredRecoveryRequired) throw failure("FILL_INTERNAL");
  if (now >= Date.parse(status.fillLeaseExpiresAt)) return "LOCAL_DEADLINE";
  return "LIVE";
}

function dispatchState(error: unknown): "NOT_DISPATCHED" | "MAY_HAVE_DISPATCHED" | null {
  return error instanceof SameOriginClientError ? error.dispatchState : null;
}

export function createGuardedFillOrchestrationService(dependencies: Dependencies) {
  const now = dependencies.now ?? Date.now;

  const readStatus = async (runId: string): Promise<BrowserFillAttemptStatus> => {
    try {
      return await dependencies.client.getFillAttemptStatus(runId);
    } catch {
      throw failure("FILL_INTERNAL");
    }
  };

  const recoverExpired = async (
    input: GuardedFillExecutionInput,
    status: BrowserFillAttemptStatus,
    expectedStepKeys?: readonly string[]
  ): Promise<GuardedFillOrchestrationResult> => {
    if (
      status.state !== "FILLING" ||
      typeof status.fillAttemptId !== "string" ||
      status.fillLeaseExpiresAt === null ||
      status.leaseLive ||
      !status.expiredRecoveryRequired ||
      status.fieldOperationAllowed
    ) {
      throw failure("FILL_INTERNAL");
    }
    const recoverInput = Object.freeze({
      runId: input.runId,
      fillAttemptId: status.fillAttemptId,
      expectedStateVersion: status.stateVersion
    });
    let recovered: BrowserFillAttemptStatus;
    try {
      recovered = await dependencies.client.recoverExpiredFillAttempt(
        recoverInput,
        input.assertActive
      );
    } catch {
      recovered = await readStatus(input.runId);
      if (recovered.state === "CANCELLED") {
        if (!validKnownCancelledStatus(recovered, {
          attemptId: status.fillAttemptId,
          runStateVersion: status.stateVersion
        })) {
          throw failure("FILL_INTERNAL");
        }
        return result("CANCELLED", recovered);
      }
      if (
        recovered.state === "FILLING" &&
        recovered.fillAttemptId === status.fillAttemptId &&
        recovered.stateVersion === status.stateVersion &&
        recovered.fillLeaseExpiresAt === status.fillLeaseExpiresAt &&
        !recovered.leaseLive &&
        recovered.expiredRecoveryRequired &&
        !recovered.fieldOperationAllowed &&
        recovered.outcome === null &&
        recovered.errorCode === null &&
        recovered.steps.length === 0
      ) {
        return result("RECOVERY_PENDING", recovered);
      }
    }
    if (
      !validUnknownTerminalStatus(recovered) ||
      recovered.stateVersion !== status.stateVersion + 1 ||
      recovered.fillAttemptId !== status.fillAttemptId ||
      recovered.outcome !== "RECOVERED_AFTER_LOSS" ||
      recovered.errorCode !== "FILL_STALE" ||
      (expectedStepKeys !== undefined && (
        recovered.steps.length !== expectedStepKeys.length ||
        recovered.steps.some((step, index) => step.stepKey !== expectedStepKeys[index])
      ))
    ) {
      throw failure("FILL_INTERNAL");
    }
    return result("FINALIZED", recovered);
  };

  const reconcileUnknownAcquisition = async (
    input: GuardedFillExecutionInput
  ): Promise<GuardedFillOrchestrationResult> => {
    const status = await readStatus(input.runId);
    const classification = classifyUnknownActiveStatus(status, now());
    if (classification === "CANCELLED") return result("CANCELLED", status);
    if (classification === "TERMINAL") return result("FINALIZED", status);
    if (classification === "EXPIRED") return recoverExpired(input, status);
    return result("RECOVERY_PENDING", status);
  };

  const reconcileFinalization = async (
    input: GuardedFillExecutionInput,
    acquired: FrozenAcquisition,
    assertion: BrowserFillFinalizeInput
  ): Promise<GuardedFillOrchestrationResult> => {
    const status = await readStatus(input.runId);
    if (exactTerminalStatus(status, assertion)) return result("FINALIZED", status);
    const classification = classifyKnownActiveStatus(status, acquired, now(), false);
    if (classification.kind === "CANCELLED") return result("CANCELLED", status);
    if (classification.kind === "EXPIRED") {
      return result("RECOVERY_PENDING", status);
    }
    return result("RECOVERY_PENDING", status);
  };

  const finalize = async (
    input: GuardedFillExecutionInput,
    acquired: FrozenAcquisition,
    assertion: BrowserFillFinalizeInput
  ): Promise<GuardedFillOrchestrationResult> => {
    const preFinalizeStatus = await readStatus(input.runId);
    if (exactTerminalStatus(preFinalizeStatus, assertion)) {
      return result("FINALIZED", preFinalizeStatus);
    }
    const classification = classifyKnownActiveStatus(preFinalizeStatus, acquired, now(), false);
    if (classification.kind === "CANCELLED") {
      return result("CANCELLED", preFinalizeStatus);
    }
    if (classification.kind === "EXPIRED") {
      return recoverExpired(
        input,
        preFinalizeStatus,
        acquired.eligibleFields.map((field) => field.stepKey)
      );
    }
    if (classification.kind === "LOCAL_DEADLINE") {
      return result("RECOVERY_PENDING", preFinalizeStatus);
    }

    let finalized: BrowserFillAttemptStatus;
    try {
      finalized = await dependencies.client.finalizeFillAttempt(assertion, input.assertActive);
    } catch (error) {
      if (dispatchState(error) !== "NOT_DISPATCHED") {
        return reconcileFinalization(input, acquired, assertion);
      }
      const retryStatus = await readStatus(input.runId);
      if (exactTerminalStatus(retryStatus, assertion)) return result("FINALIZED", retryStatus);
      const retryClassification = classifyKnownActiveStatus(retryStatus, acquired, now(), false);
      if (retryClassification.kind === "CANCELLED") {
        return result("CANCELLED", retryStatus);
      }
      if (retryClassification.kind === "EXPIRED") {
        return recoverExpired(
          input,
          retryStatus,
          acquired.eligibleFields.map((field) => field.stepKey)
        );
      }
      if (retryClassification.kind === "LOCAL_DEADLINE") {
        return result("RECOVERY_PENDING", retryStatus);
      }
      try {
        finalized = await dependencies.client.finalizeFillAttempt(assertion, input.assertActive);
      } catch {
        return reconcileFinalization(input, acquired, assertion);
      }
    }
    return exactTerminalStatus(finalized, assertion)
      ? result("FINALIZED", finalized)
      : reconcileFinalization(input, acquired, assertion);
  };

  const stoppedAssertion = (
    input: GuardedFillExecutionInput,
    acquired: FrozenAcquisition,
    steps: readonly BrowserFillStepResult[],
    errorCode: StoppedEarlyFillError
  ): BrowserFillFinalizeInput => Object.freeze({
    runId: input.runId,
    fillAttemptId: acquired.attemptId,
    expectedStateVersion: acquired.runStateVersion,
    outcome: "STOPPED_EARLY" as const,
    errorCode,
    steps: Object.freeze(steps.map((step) => Object.freeze({ ...step })))
  });

  const execute = async (
    input: GuardedFillExecutionInput
  ): Promise<GuardedFillOrchestrationResult> => {
    const frozenTarget = canonicalTarget(input.frozenTargetUrl);
    if (
      !frozenTarget ||
      !isSafePositiveInteger(input.formInspectionVersion) ||
      !isSafePositiveInteger(input.answerPacketVersion)
    ) {
      throw failure("FILL_INTERNAL");
    }
    const assertTarget = (): void => {
      let current: ExecutionTarget | null = null;
      const currentUrl = dependencies.controller.currentTargetUrl();
      if (currentUrl) current = canonicalTarget(currentUrl);
      if (!current || !sameTarget(current, frozenTarget)) {
        throw failure("FILL_TARGET_TRUST_LOST");
      }
    };
    const assertActiveTarget = (): void => {
      input.assertActive();
      assertTarget();
    };

    try {
      assertActiveTarget();
      const run = await dependencies.client.getApplicationRun(input.runId);
      assertActiveTarget();
      const runTarget = canonicalTarget(run.applyUrlSnapshot);
      if (
        run.id !== input.runId ||
        run.state !== "READY" ||
        !runTarget ||
        run.applyHost !== frozenTarget.host ||
        !sameTarget(runTarget, frozenTarget)
      ) {
        throw failure("FILL_TARGET_TRUST_LOST");
      }
      const policy = await dependencies.client.getAutomationPolicy();
      assertActiveTarget();
      if (
        !policy.effectiveEnabled ||
        !isHostAllowedForExecution(frozenTarget.host, {
          allowedHosts: [...policy.allowedHosts],
          blockedHosts: [...policy.blockedHosts]
        })
      ) {
        throw failure("FILL_POLICY_DENIED");
      }
      const packet = await dependencies.client.getCurrentAnswerPacket(input.runId);
      assertActiveTarget();
      if (
        packet.runId !== input.runId ||
        packet.current?.inspectionVersion !== input.formInspectionVersion ||
        packet.current.answerPacketVersion !== input.answerPacketVersion
      ) {
        throw failure("FILL_TARGET_TRUST_LOST");
      }
      const current = await dependencies.controller.assertCurrent(input.generationId);
      assertActiveTarget();
      if (current.generationId !== input.generationId) {
        throw failure("FILL_TARGET_TRUST_LOST");
      }

      let rawAcquisition: BrowserFillAcquisition;
      try {
        rawAcquisition = await dependencies.client.acquireFillAttempt({
          runId: input.runId,
          expectedStateVersion: run.stateVersion
        }, assertActiveTarget);
      } catch (error) {
        const code = safeCode(error);
        if (
          error instanceof SameOriginClientError &&
          error.responseReceived &&
          DEFINITIVE_ACQUISITION_REJECTIONS.has(code as FillErrorCode)
        ) {
          throw failure(code as FillErrorCode);
        }
        if (dispatchState(error) === "MAY_HAVE_DISPATCHED") {
          dependencies.onAcquisitionUncertain?.();
          return reconcileUnknownAcquisition(input);
        }
        throw failure(
          code === "FILL_POLICY_DENIED"
            ? "FILL_POLICY_DENIED"
            : code === "FILL_NO_ELIGIBLE_FIELDS"
              ? "FILL_NO_ELIGIBLE_FIELDS"
              : code === "FILL_REVIEW_REQUIRED"
                ? "FILL_REVIEW_REQUIRED"
                : code === "FILL_ALREADY_IN_PROGRESS"
                  ? "FILL_ALREADY_IN_PROGRESS"
                  : "FILL_INTERNAL"
        );
      }

      let acquired: FrozenAcquisition;
      try {
        acquired = validateAndFreezeAcquisition(rawAcquisition);
      } catch {
        dependencies.onAcquisitionUncertain?.();
        return reconcileUnknownAcquisition(input);
      }
      if (acquired.runStateVersion !== run.stateVersion + 1) {
        dependencies.onAcquisitionUncertain?.();
        return reconcileUnknownAcquisition(input);
      }
      if (
        acquired.formInspectionVersion !== input.formInspectionVersion ||
        acquired.answerPacketVersion !== input.answerPacketVersion
      ) {
        const steps = acquired.eligibleFields.map((field) => Object.freeze({
          stepKey: field.stepKey,
          result: "NOT_ATTEMPTED" as const,
          errorCode: null
        }));
        return finalize(
          input,
          acquired,
          stoppedAssertion(input, acquired, steps, "FILL_TARGET_TRUST_LOST")
        );
      }

      const writeRequests = acquired.eligibleFields.map((field) => Object.freeze({
        normalizedFieldKey: field.normalizedFieldKey,
        fieldFingerprint: field.fieldFingerprint,
        fieldType: field.fieldType,
        proposal: field.proposal
      }));
      try {
        dependencies.controller.assertAcquiredFillAuthority(input.generationId, {
          formFingerprint: acquired.formFingerprint,
          fields: Object.freeze(writeRequests)
        });
      } catch (error) {
        const steps = acquired.eligibleFields.map((field) => Object.freeze({
          stepKey: field.stepKey,
          result: "NOT_ATTEMPTED" as const,
          errorCode: null
        }));
        return finalize(
          input,
          acquired,
          stoppedAssertion(input, acquired, steps, stoppingCode(error))
        );
      }

      const steps: BrowserFillStepResult[] = acquired.eligibleFields.map((field) => ({
        stepKey: field.stepKey,
        result: "NOT_ATTEMPTED",
        errorCode: null
      }));

      for (let index = 0; index < writeRequests.length; index += 1) {
        let preFieldError: StoppedEarlyFillError | null = null;
        try {
          assertActiveTarget();
          const currentGeneration = await dependencies.controller.assertCurrent(input.generationId);
          assertActiveTarget();
          if (currentGeneration.generationId !== input.generationId) {
            throw failure("FILL_TARGET_TRUST_LOST");
          }

          const status = await readStatus(input.runId);
          const statusClassification = classifyKnownActiveStatus(status, acquired, now(), true);
          if (statusClassification.kind === "CANCELLED") return result("CANCELLED", status);
          if (statusClassification.kind === "EXPIRED") {
            return recoverExpired(
              input,
              status,
              acquired.eligibleFields.map((field) => field.stepKey)
            );
          }
          if (statusClassification.kind === "LOCAL_DEADLINE") {
            return result("RECOVERY_PENDING", status);
          }
          assertActiveTarget();
          if (statusClassification.kind === "POLICY_DENIED") {
            preFieldError = "FILL_POLICY_DENIED";
          } else if (now() >= Date.parse(acquired.leaseExpiresAt)) {
            return result("RECOVERY_PENDING", status);
          }
        } catch (error) {
          if (error instanceof GuardedFillOrchestrationError && error.code === "FILL_INTERNAL") {
            throw error;
          }
          preFieldError = stoppingCode(error);
        }
        if (preFieldError !== null) {
          return finalize(
            input,
            acquired,
            stoppedAssertion(input, acquired, steps, preFieldError)
          );
        }

        let mapped: ReturnType<typeof mapWriterResult>;
        try {
          const writePromise = dependencies.controller.writeApprovedField(
            input.generationId,
            writeRequests[index]
          );
          mapped = mapWriterResult(
            await writePromise
          );
        } catch (error) {
          mapped = { result: "FAILED", errorCode: stoppingCode(error) };
        }
        steps[index] = {
          stepKey: acquired.eligibleFields[index].stepKey,
          result: mapped.result,
          errorCode: mapped.errorCode
        };
        if (mapped.result === "FAILED") {
          return finalize(
            input,
            acquired,
            stoppedAssertion(
              input,
              acquired,
              steps,
              mapped.errorCode ?? "FILL_INTERNAL"
            )
          );
        }
      }

      const assertion: BrowserFillFinalizeInput = Object.freeze({
        runId: input.runId,
        fillAttemptId: acquired.attemptId,
        expectedStateVersion: acquired.runStateVersion,
        outcome: "COMPLETED" as const,
        errorCode: null,
        steps: Object.freeze(steps.map((step) => Object.freeze({ ...step })))
      });
      return finalize(input, acquired, assertion);
    } catch (error) {
      if (error instanceof GuardedFillOrchestrationError) throw error;
      if (error instanceof ApplicationFormInspectionControllerError) {
        throw failure(stoppingCode(error));
      }
      throw failure("FILL_INTERNAL");
    }
  };

  return Object.freeze({
    execute,
    reconcileAcquisitionUncertainty: reconcileUnknownAcquisition
  });
}
