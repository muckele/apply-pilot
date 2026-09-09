import {
  ApplicationFormCorrelationError,
  correlateProtectedApplicationFormExtraction,
  type CorrelatedProtectedApplicationFormExtraction
} from "@/lib/application-browser/form-inspection-correlation";
import {
  ProtectedApplicationFormExtractionError,
  ProtectedBrowserSessionError,
  type BrowserDocumentFence,
  type ProtectedApplicationFormExtraction,
  type ProtectedApplicationBrowserSession,
  type ProtectedCandidateVerification,
  type ProtectedSessionLifecycleCode
} from "@/lib/application-browser/protected-browser-session";
import {
  buildNormalizedApplicationFormInspection,
  canonicalJson,
  FormInspectionDomainError,
  type ApplicationFormInspectionReport
} from "@/lib/application-runs/form-inspection";

export const RELEVANT_MUTATION_QUIET_MS = 500;
export const SEMANTIC_EXTRACTION_GAP_MS = 250;
export const MAX_STABILIZATION_MS = 10_000;

export const APPLICATION_FORM_INSPECTION_CONTROLLER_ERROR_CODES = [
  "FORM_STABILITY_TIMEOUT",
  "FORM_CORRELATION_INVALID",
  "FORM_INSPECTION_IN_PROGRESS",
  "FORM_INSPECTION_CANCELLED",
  "FORM_GENERATION_INVALIDATED",
  "FORM_INSPECTION_REQUEST_TOO_LARGE"
] as const;

export type ApplicationFormInspectionControllerErrorCode =
  (typeof APPLICATION_FORM_INSPECTION_CONTROLLER_ERROR_CODES)[number];

export class ApplicationFormInspectionControllerError extends Error {
  readonly code: ApplicationFormInspectionControllerErrorCode;

  constructor(code: ApplicationFormInspectionControllerErrorCode) {
    super(`Application form inspection controller failed: ${code}`);
    this.name = "ApplicationFormInspectionControllerError";
    this.code = code;
  }
}

export type ApplicationFormInspectionInvalidationCode =
  | "REINSPECTION_REQUIRED"
  | "TARGET_NAVIGATED"
  | "PROTECTED_SESSION_LOST"
  | "PAGE_CLOSED";

export type ProtectedFormInspectionAuthority = Readonly<
  Pick<
    ProtectedApplicationBrowserSession,
    | "waitUntilReady"
    | "extractApplicationForm"
    | "verifyCandidate"
    | "snapshot"
    | "waitForChange"
    | "subscribe"
  >
>;

export type ProtectedFormInspectionTarget = Readonly<{
  authority: ProtectedFormInspectionAuthority;
  currentTargetUrl(): string | null;
  subscribeMainFrameNavigation(listener: () => void): () => void;
}>;

export type ApplicationFormInspectionControllerRuntime = Readonly<{
  now(): number;
  setTimer(callback: () => void, delayMs: number): unknown;
  clearTimer(timer: unknown): void;
}>;

export type TransientInspectionGeneration = Readonly<{
  generationId: symbol;
  readonly inspectionReport: ApplicationFormInspectionReport;
  dispose(): Promise<void>;
}>;

export type ApplicationFormInspectionController = Readonly<{
  inspect(options?: Readonly<{ signal?: AbortSignal }>): Promise<TransientInspectionGeneration>;
  current(): TransientInspectionGeneration | null;
  assertCurrent(
    generationId: symbol,
    options?: Readonly<{ signal?: AbortSignal }>
  ): Promise<TransientInspectionGeneration>;
  close(): Promise<void>;
}>;

type AcceptedGeneration = {
  readonly generationId: symbol;
  readonly correlated: CorrelatedProtectedApplicationFormExtraction;
  readonly privateReportCanonical: string;
  readonly privateNormalizedCanonical: string;
  readonly privateFormFingerprint: string;
  readonly privateFieldCount: number;
  readonly privateRequiredFieldCount: number;
  readonly facade: TransientInspectionGeneration;
  latestVerifiedReport: ApplicationFormInspectionReport;
  active: boolean;
  invalidationEmitted: boolean;
  disposePromise: Promise<void> | null;
};

type AttemptTerminalCode = "FORM_STABILITY_TIMEOUT" | "FORM_INSPECTION_CANCELLED";

type ControllerAttempt = {
  readonly deadline: number;
  readonly navigationEpoch: number;
  terminalCode: AttemptTerminalCode | null;
  readonly terminalPromise: Promise<never>;
  readonly rejectTerminal: (error: ApplicationFormInspectionControllerError) => void;
  timer: unknown;
  quarantineCount: number;
  finished: boolean;
  completionResolved: boolean;
  readonly completion: Promise<void>;
  readonly resolveCompletion: () => void;
};

class ProtectedInspectionIntegrityError extends Error {
  readonly code = "BROWSER_WORKFLOW_FAILED";

  constructor() {
    super("Protected form inspection authority failed safely.");
    this.name = "ProtectedInspectionIntegrityError";
  }
}

const PRODUCTION_RUNTIME: ApplicationFormInspectionControllerRuntime = {
  now: () => performance.now(),
  setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>)
};

function controllerError(
  code: ApplicationFormInspectionControllerErrorCode
): ApplicationFormInspectionControllerError {
  return new ApplicationFormInspectionControllerError(code);
}

function integrityError(): ProtectedInspectionIntegrityError {
  return new ProtectedInspectionIntegrityError();
}

function fencesEqual(left: BrowserDocumentFence, right: BrowserDocumentFence): boolean {
  return left.documentEpoch === right.documentEpoch &&
    left.semanticRevision === right.semanticRevision &&
    left.applicantStateEpoch === right.applicantStateEpoch;
}

function cloneReport(report: ApplicationFormInspectionReport): ApplicationFormInspectionReport {
  return structuredClone(report);
}

export function createApplicationFormInspectionControllerWithRuntime(
  input: Readonly<{
    target: ProtectedFormInspectionTarget;
    authoritativeApplyHost: string;
    onInvalidated?: (code: ApplicationFormInspectionInvalidationCode) => void;
  }>,
  runtime: ApplicationFormInspectionControllerRuntime
): ApplicationFormInspectionController {
  const authority = input.target.authority;
  let closed = false;
  let terminalUnavailable = false;
  let closePromise: Promise<void> | null = null;
  let currentRecord: AcceptedGeneration | null = null;
  let activeAttempt: ControllerAttempt | null = null;
  const pendingDisposals = new Set<Promise<void>>();
  let navigationEpoch = 0;
  let recoverableInvalidationAnnounced = false;
  let terminalInvalidationAnnounced = false;
  let subscriptionsRemoved = false;

  const emitInvalidation = (code: ApplicationFormInspectionInvalidationCode): void => {
    try {
      input.onInvalidated?.(code);
    } catch {
      // Notification cannot interrupt synchronous authority revocation or cleanup.
    }
  };

  const maybeResolveAttempt = (attempt: ControllerAttempt): void => {
    if (!attempt.finished || attempt.quarantineCount !== 0 || attempt.completionResolved) return;
    attempt.completionResolved = true;
    if (activeAttempt === attempt) activeAttempt = null;
    attempt.resolveCompletion();
  };

  const makeAttempt = (): ControllerAttempt => {
    let rejectTerminal!: (error: ApplicationFormInspectionControllerError) => void;
    const terminalPromise = new Promise<never>((_resolve, reject) => {
      rejectTerminal = reject;
    });
    // The rejection is also consumed by every raced protected operation. This
    // observer covers a cancellation that lands in a synchronous controller gap.
    void terminalPromise.catch(() => undefined);
    let resolveCompletion!: () => void;
    const completion = new Promise<void>((resolve) => {
      resolveCompletion = resolve;
    });
    const attempt: ControllerAttempt = {
      deadline: runtime.now() + MAX_STABILIZATION_MS,
      navigationEpoch,
      terminalCode: null,
      terminalPromise,
      rejectTerminal,
      timer: undefined,
      quarantineCount: 0,
      finished: false,
      completionResolved: false,
      completion,
      resolveCompletion
    };
    attempt.timer = runtime.setTimer(() => {
      if (attempt.terminalCode) return;
      attempt.terminalCode = "FORM_STABILITY_TIMEOUT";
      attempt.rejectTerminal(controllerError("FORM_STABILITY_TIMEOUT"));
    }, MAX_STABILIZATION_MS);
    return attempt;
  };

  const terminateAttempt = (
    attempt: ControllerAttempt,
    code: AttemptTerminalCode
  ): void => {
    if (attempt.terminalCode) return;
    attempt.terminalCode = code;
    runtime.clearTimer(attempt.timer);
    attempt.rejectTerminal(controllerError(code));
  };

  const finishAttempt = (attempt: ControllerAttempt): void => {
    runtime.clearTimer(attempt.timer);
    attempt.finished = true;
    maybeResolveAttempt(attempt);
  };

  const quarantine = <T>(
    attempt: ControllerAttempt,
    pending: Promise<T>,
    onLateSuccess?: (value: T) => void | Promise<void>
  ): void => {
    attempt.quarantineCount += 1;
    void pending.then(
      async (value) => {
        try {
          await onLateSuccess?.(value);
        } catch {
          // Late authority-reducing cleanup is best effort and never resumes work.
        }
      },
      () => undefined
    ).finally(() => {
      attempt.quarantineCount -= 1;
      maybeResolveAttempt(attempt);
    });
  };

  const raceAttempt = async <T>(
    attempt: ControllerAttempt,
    pending: Promise<T>,
    onLateSuccess?: (value: T) => void | Promise<void>
  ): Promise<T> => {
    const protectedOutcome = pending.then(
      (value) => ({ kind: "value" as const, value }),
      (error: unknown) => ({ kind: "error" as const, error })
    );
    try {
      const outcome = await Promise.race([protectedOutcome, attempt.terminalPromise]);
      if (outcome.kind === "error") throw outcome.error;
      return outcome.value;
    } catch (error) {
      if (attempt.terminalCode) quarantine(attempt, pending, onLateSuccess);
      throw error;
    }
  };

  const assertAttemptActive = (attempt: ControllerAttempt): void => {
    if (attempt.terminalCode) throw controllerError(attempt.terminalCode);
    if (
      closed ||
      terminalUnavailable ||
      navigationEpoch !== attempt.navigationEpoch ||
      input.target.currentTargetUrl() === null
    ) {
      throw controllerError("FORM_INSPECTION_CANCELLED");
    }
    if (runtime.now() >= attempt.deadline) {
      terminateAttempt(attempt, "FORM_STABILITY_TIMEOUT");
      throw controllerError("FORM_STABILITY_TIMEOUT");
    }
  };

  const remainingWait = (attempt: ControllerAttempt, desiredMs: number): number =>
    Math.max(0, Math.min(desiredMs, Math.floor(attempt.deadline - runtime.now())));

  const disposeCorrelated = async (
    correlated: CorrelatedProtectedApplicationFormExtraction | null
  ): Promise<void> => {
    if (!correlated) return;
    try {
      await correlated.dispose();
    } catch {
      // Cleanup failure cannot replace the primary bounded controller result.
    }
  };

  const disposeExtraction = async (
    extraction: ProtectedApplicationFormExtraction
  ): Promise<void> => {
    try {
      await extraction.dispose();
    } catch {
      // Cleanup failure cannot replace the primary bounded controller result.
    }
  };

  const disposeAccepted = (record: AcceptedGeneration): Promise<void> => {
    if (currentRecord === record) currentRecord = null;
    record.active = false;
    if (!record.disposePromise) {
      const disposal = disposeCorrelated(record.correlated);
      record.disposePromise = disposal;
      pendingDisposals.add(disposal);
      void disposal.finally(() => pendingDisposals.delete(disposal));
    }
    return record.disposePromise;
  };

  const announceRecoverable = (code: ApplicationFormInspectionInvalidationCode): void => {
    if (recoverableInvalidationAnnounced || terminalInvalidationAnnounced || closed) return;
    recoverableInvalidationAnnounced = true;
    emitInvalidation(code);
  };

  const invalidateAccepted = (
    record: AcceptedGeneration,
    code: ApplicationFormInspectionInvalidationCode,
    emit = true
  ): Promise<void> => {
    const wasActive = record.active && currentRecord === record;
    if (currentRecord === record) currentRecord = null;
    record.active = false;
    if (emit && wasActive && !record.invalidationEmitted) {
      record.invalidationEmitted = true;
      announceRecoverable(code);
    }
    return disposeAccepted(record);
  };

  const buildAccepted = (
    correlated: CorrelatedProtectedApplicationFormExtraction,
    freshReport: ApplicationFormInspectionReport
  ): AcceptedGeneration => {
    const generationId = Symbol("protected-form-inspection-generation");
    const facade = Object.freeze({
      generationId,
      get inspectionReport(): ApplicationFormInspectionReport {
        return cloneReport(record.latestVerifiedReport);
      },
      dispose(): Promise<void> {
        return disposeAccepted(record);
      }
    });
    const record: AcceptedGeneration = {
      generationId,
      correlated,
      privateReportCanonical: canonicalJson(correlated.inspectionReport),
      privateNormalizedCanonical: canonicalJson(correlated.normalizedSnapshot),
      privateFormFingerprint: correlated.formFingerprint,
      privateFieldCount: correlated.fieldCount,
      privateRequiredFieldCount: correlated.requiredFieldCount,
      facade,
      latestVerifiedReport: cloneReport(freshReport),
      active: true,
      invalidationEmitted: false,
      disposePromise: null
    };
    return record;
  };

  const freshVerificationMatches = (
    candidate: Readonly<{
      privateReportCanonical: string;
      privateNormalizedCanonical: string;
      privateFormFingerprint: string;
      privateFieldCount: number;
      privateRequiredFieldCount: number;
    }>,
    report: ApplicationFormInspectionReport
  ): boolean => {
    try {
      if (canonicalJson(report) !== candidate.privateReportCanonical) return false;
      const rebuilt = buildNormalizedApplicationFormInspection({
        authoritativeApplyHost: input.authoritativeApplyHost,
        report
      });
      return rebuilt.formFingerprint === candidate.privateFormFingerprint &&
        rebuilt.fieldCount === candidate.privateFieldCount &&
        rebuilt.requiredFieldCount === candidate.privateRequiredFieldCount &&
        canonicalJson(rebuilt.snapshot) === candidate.privateNormalizedCanonical;
    } catch {
      return false;
    }
  };

  const correlatedContract = (
    correlated: CorrelatedProtectedApplicationFormExtraction
  ) => ({
    privateReportCanonical: canonicalJson(correlated.inspectionReport),
    privateNormalizedCanonical: canonicalJson(correlated.normalizedSnapshot),
    privateFormFingerprint: correlated.formFingerprint,
    privateFieldCount: correlated.fieldCount,
    privateRequiredFieldCount: correlated.requiredFieldCount
  });

  const establishTerminalAuthorityLoss = (): void => {
    terminalUnavailable = true;
    navigationEpoch += 1;
    const accepted = currentRecord;
    if (accepted) {
      currentRecord = null;
      accepted.active = false;
    }
    if (!terminalInvalidationAnnounced && !closed) {
      terminalInvalidationAnnounced = true;
      emitInvalidation("PROTECTED_SESSION_LOST");
    }
    if (accepted) void disposeAccepted(accepted);
  };

  const mapProtectedFailure = (error: unknown): Error => {
    if (error instanceof ApplicationFormInspectionControllerError) return error;
    if (
      error instanceof FormInspectionDomainError &&
      error.code === "AMBIGUOUS_DUPLICATE_FIELD"
    ) {
      return error;
    }
    if (error instanceof ApplicationFormCorrelationError) {
      return controllerError("FORM_CORRELATION_INVALID");
    }
    if (error instanceof ProtectedApplicationFormExtractionError) {
      if (error.code === "FORM_INSPECTION_OVERSIZE") {
        return controllerError("FORM_INSPECTION_REQUEST_TOO_LARGE");
      }
      if (error.code === "EMPLOYER_AUTH_REQUIRED_UNSUPPORTED") return error;
      return controllerError("FORM_CORRELATION_INVALID");
    }
    if (error instanceof ProtectedBrowserSessionError) {
      if (error.code === "PROTECTED_SESSION_BUSY") {
        return controllerError("FORM_INSPECTION_IN_PROGRESS");
      }
      if (
        error.code === "PROTECTED_SESSION_SETUP_FAILED" ||
        error.code === "PROTECTED_SESSION_CLOSED" ||
        error.code === "PROTECTED_SESSION_INVALID_RESPONSE" ||
        error.code === "PROTECTED_CANDIDATE_INVALID"
      ) {
        establishTerminalAuthorityLoss();
        return integrityError();
      }
    }
    establishTerminalAuthorityLoss();
    return integrityError();
  };

  const retryableProtectedFailure = (error: unknown): boolean =>
    error instanceof ProtectedBrowserSessionError && (
      error.code === "PROTECTED_SESSION_NOT_READY" ||
      error.code === "PROTECTED_SESSION_READINESS_TIMEOUT" ||
      error.code === "PROTECTED_SESSION_STALE_RESPONSE"
    );

  const inspect = async (
    options: Readonly<{ signal?: AbortSignal }> = {}
  ): Promise<TransientInspectionGeneration> => {
    if (
      closed ||
      terminalUnavailable ||
      input.target.currentTargetUrl() === null ||
      options.signal?.aborted
    ) {
      throw controllerError("FORM_INSPECTION_CANCELLED");
    }
    if (activeAttempt) throw controllerError("FORM_INSPECTION_IN_PROGRESS");

    const predecessor = currentRecord;
    const precedingDisposals = [...pendingDisposals];
    recoverableInvalidationAnnounced = false;
    const attempt = makeAttempt();
    activeAttempt = attempt;
    const onAbort = () => terminateAttempt(attempt, "FORM_INSPECTION_CANCELLED");
    options.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      if (precedingDisposals.length > 0) {
        await raceAttempt(attempt, Promise.all(precedingDisposals));
        assertAttemptActive(attempt);
      }
      while (true) {
        assertAttemptActive(attempt);
        let extraction: ProtectedApplicationFormExtraction | null = null;
        let correlated: CorrelatedProtectedApplicationFormExtraction | null = null;
        let replacementCommitted = false;
        try {
          await raceAttempt(attempt, authority.waitUntilReady());
          assertAttemptActive(attempt);
          const quietStart = await raceAttempt(attempt, authority.snapshot());
          assertAttemptActive(attempt);
          const quietEnd = await raceAttempt(
            attempt,
            authority.waitForChange(
              quietStart,
              remainingWait(attempt, RELEVANT_MUTATION_QUIET_MS)
            )
          );
          assertAttemptActive(attempt);
          if (!fencesEqual(quietStart, quietEnd)) continue;

          extraction = await raceAttempt(
            attempt,
            authority.extractApplicationForm(),
            (late) => late.dispose()
          );
          assertAttemptActive(attempt);
          const transferredExtraction = extraction;
          extraction = null;
          correlated = await raceAttempt(
            attempt,
            correlateProtectedApplicationFormExtraction({
              extraction: transferredExtraction,
              authoritativeApplyHost: input.authoritativeApplyHost
            }),
            (late) => late.dispose()
          );
          assertAttemptActive(attempt);

          const gapEnd = await raceAttempt(
            attempt,
            authority.waitForChange(
              quietEnd,
              remainingWait(attempt, SEMANTIC_EXTRACTION_GAP_MS)
            )
          );
          assertAttemptActive(attempt);
          if (!fencesEqual(quietEnd, gapEnd)) continue;

          const contract = correlatedContract(correlated);
          const verified = await raceAttempt(
            attempt,
            authority.verifyCandidate(correlated.candidate)
          );
          assertAttemptActive(attempt);
          if (verified.status === "INVALID") continue;
          if (!freshVerificationMatches(contract, verified.report)) throw integrityError();

          const previous = predecessor;
          if (previous) {
            if (currentRecord !== previous && currentRecord !== null) throw integrityError();
            if (currentRecord === previous) currentRecord = null;
            previous.active = false;
            replacementCommitted = true;
            await raceAttempt(attempt, disposeAccepted(previous));
            assertAttemptActive(attempt);
            const reverified = await raceAttempt(
              attempt,
              authority.verifyCandidate(correlated.candidate)
            );
            assertAttemptActive(attempt);
            if (reverified.status === "INVALID") {
              throw controllerError("FORM_GENERATION_INVALIDATED");
            }
            if (!freshVerificationMatches(contract, reverified.report)) throw integrityError();
            const accepted = buildAccepted(correlated, reverified.report);
            assertAttemptActive(attempt);
            currentRecord = accepted;
            recoverableInvalidationAnnounced = false;
            correlated = null;
            return accepted.facade;
          }

          const accepted = buildAccepted(correlated, verified.report);
          assertAttemptActive(attempt);
          currentRecord = accepted;
          recoverableInvalidationAnnounced = false;
          correlated = null;
          return accepted.facade;
        } catch (error) {
          if (replacementCommitted) {
            if (retryableProtectedFailure(error)) {
              throw controllerError("FORM_GENERATION_INVALIDATED");
            }
            throw mapProtectedFailure(error);
          }
          if (retryableProtectedFailure(error)) {
            assertAttemptActive(attempt);
            continue;
          }
          throw mapProtectedFailure(error);
        } finally {
          if (extraction) {
            await raceAttempt(attempt, disposeExtraction(extraction));
          }
          if (correlated) {
            await raceAttempt(attempt, disposeCorrelated(correlated));
          }
        }
      }
    } finally {
      options.signal?.removeEventListener("abort", onAbort);
      finishAttempt(attempt);
    }
  };

  const assertCurrent = async (
    generationId: symbol,
    options: Readonly<{ signal?: AbortSignal }> = {}
  ): Promise<TransientInspectionGeneration> => {
    if (
      closed ||
      terminalUnavailable ||
      input.target.currentTargetUrl() === null ||
      options.signal?.aborted
    ) {
      throw controllerError("FORM_INSPECTION_CANCELLED");
    }
    const record = currentRecord;
    if (!record || !record.active || record.generationId !== generationId) {
      throw controllerError("FORM_GENERATION_INVALIDATED");
    }
    if (activeAttempt) throw controllerError("FORM_INSPECTION_IN_PROGRESS");

    const attempt = makeAttempt();
    activeAttempt = attempt;
    const onAbort = () => terminateAttempt(attempt, "FORM_INSPECTION_CANCELLED");
    options.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      assertAttemptActive(attempt);
      let verified: ProtectedCandidateVerification;
      try {
        verified = await raceAttempt(
          attempt,
          authority.verifyCandidate(record.correlated.candidate)
        );
      } catch (error) {
        if (retryableProtectedFailure(error)) {
          await raceAttempt(
            attempt,
            invalidateAccepted(record, "REINSPECTION_REQUIRED")
          );
          throw controllerError("FORM_GENERATION_INVALIDATED");
        }
        if (
          error instanceof ProtectedBrowserSessionError &&
          error.code === "PROTECTED_SESSION_BUSY"
        ) {
          throw controllerError("FORM_INSPECTION_IN_PROGRESS");
        }
        if (
          error instanceof ProtectedBrowserSessionError && (
            error.code === "PROTECTED_SESSION_SETUP_FAILED" ||
            error.code === "PROTECTED_SESSION_CLOSED" ||
            error.code === "PROTECTED_SESSION_INVALID_RESPONSE" ||
            error.code === "PROTECTED_CANDIDATE_INVALID"
          )
        ) {
          establishTerminalAuthorityLoss();
          throw integrityError();
        }
        throw mapProtectedFailure(error);
      }
      assertAttemptActive(attempt);
      if (!record.active || currentRecord !== record) {
        throw controllerError("FORM_GENERATION_INVALIDATED");
      }
      if (verified.status === "INVALID") {
        await raceAttempt(
          attempt,
          invalidateAccepted(record, "REINSPECTION_REQUIRED")
        );
        throw controllerError("FORM_GENERATION_INVALIDATED");
      }
      if (!freshVerificationMatches(record, verified.report)) {
        await raceAttempt(
          attempt,
          invalidateAccepted(record, "REINSPECTION_REQUIRED")
        );
        throw controllerError("FORM_GENERATION_INVALIDATED");
      }
      if (!record.active || currentRecord !== record) {
        throw controllerError("FORM_GENERATION_INVALIDATED");
      }
      const latestVerifiedReport = cloneReport(verified.report);
      assertAttemptActive(attempt);
      record.latestVerifiedReport = latestVerifiedReport;
      return record.facade;
    } finally {
      options.signal?.removeEventListener("abort", onAbort);
      finishAttempt(attempt);
    }
  };

  const terminateAndRevoke = (
    code: ApplicationFormInspectionInvalidationCode,
    terminal: boolean
  ): void => {
    if (closed) return;
    navigationEpoch += 1;
    const attempt = activeAttempt;
    if (attempt) terminateAttempt(attempt, "FORM_INSPECTION_CANCELLED");
    const accepted = currentRecord;
    if (accepted) {
      currentRecord = null;
      accepted.active = false;
    }

    if (terminal) {
      terminalUnavailable = true;
      if (!terminalInvalidationAnnounced) {
        terminalInvalidationAnnounced = true;
        emitInvalidation(code);
      }
    } else if (accepted || attempt) {
      announceRecoverable(code);
    }

    if (accepted) void disposeAccepted(accepted);
  };

  const onLifecycle = (code: ProtectedSessionLifecycleCode): void => {
    if (code === "DOCUMENT_CHANGED") {
      terminateAndRevoke("TARGET_NAVIGATED", false);
      return;
    }
    if (code === "EXECUTION_CONTEXT_DESTROYED") {
      terminateAndRevoke("REINSPECTION_REQUIRED", false);
      return;
    }
    if (code === "PAGE_CLOSED") {
      terminateAndRevoke("PAGE_CLOSED", true);
      return;
    }
    terminateAndRevoke("PROTECTED_SESSION_LOST", true);
  };

  const onMainFrameNavigation = (): void => {
    terminateAndRevoke("TARGET_NAVIGATED", false);
  };

  const unsubscribeLifecycle = authority.subscribe(onLifecycle);
  const unsubscribeNavigation = input.target.subscribeMainFrameNavigation(onMainFrameNavigation);

  const removeSubscriptions = (): void => {
    if (subscriptionsRemoved) return;
    subscriptionsRemoved = true;
    try {
      unsubscribeLifecycle();
    } catch {
      // Subscription removal is best effort after authority has been revoked.
    }
    try {
      unsubscribeNavigation();
    } catch {
      // Subscription removal is best effort after authority has been revoked.
    }
  };

  const close = (): Promise<void> => {
    if (closePromise) return closePromise;
    closed = true;
    removeSubscriptions();
    navigationEpoch += 1;
    const attempt = activeAttempt;
    if (attempt) terminateAttempt(attempt, "FORM_INSPECTION_CANCELLED");
    const attemptCompletion = attempt?.completion ?? Promise.resolve();
    const accepted = currentRecord;
    currentRecord = null;
    if (accepted) accepted.active = false;
    const acceptedDisposal = accepted ? disposeAccepted(accepted) : Promise.resolve();
    closePromise = Promise.all([attemptCompletion, acceptedDisposal])
      .then(() => Promise.all([...pendingDisposals]))
      .then(() => undefined);
    return closePromise;
  };

  return Object.freeze({
    inspect,
    current: () => currentRecord?.facade ?? null,
    assertCurrent,
    close
  });
}

export function createApplicationFormInspectionController(input: Readonly<{
  target: ProtectedFormInspectionTarget;
  authoritativeApplyHost: string;
  onInvalidated?: (code: ApplicationFormInspectionInvalidationCode) => void;
}>): ApplicationFormInspectionController {
  return createApplicationFormInspectionControllerWithRuntime(input, PRODUCTION_RUNTIME);
}
