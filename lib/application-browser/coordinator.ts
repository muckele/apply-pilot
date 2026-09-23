import type { BrowserContext, CDPSession, Page, Request, Route } from "playwright";

import {
  createGuardedFillOrchestrationService,
  GuardedFillOrchestrationError,
  type GuardedFillControllerPort,
  type GuardedFillOrchestrationResult
} from "@/lib/application-browser/fill-orchestration";
import {
  createProtectedApplicationBrowserSession,
  type ProtectedApplicationBrowserSession
} from "@/lib/application-browser/protected-browser-session";

import {
  isHostAllowedForExecution,
  parseExecutionTargetUrl,
  type ExecutionTarget
} from "@/lib/application-runs/host-policy";
import type {
  BrowserApplicationRun,
  BrowserAutomationPolicy,
  SameOriginClient,
  SameOriginFillClient
} from "@/lib/application-browser/same-origin-client";
import type {
  ApplicationFormInspectionInvalidationCode,
  ProtectedFormInspectionAuthority,
  ProtectedFormInspectionTarget
} from "@/lib/application-browser/form-inspection-controller";
import type { ApplicationFormInspectionReport } from "@/lib/application-runs/form-inspection";
import {
  BROWSER_INSPECTION_RECOVERABLE_CODES,
  B3_FILL_COMMAND_REJECTION_CODES,
  type B1Command,
  type B1Status,
  type B1WorkflowState,
  type B2InspectionCommandStatus,
  type B3FillCommandStatus,
  type B3FillCommandRejectionCode,
  type BrowserInspectionRecoverableCode
} from "@/lib/application-browser/types";

export class ApplicationBrowserError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = "ApplicationBrowserError";
    this.code = code;
  }
}

type TargetOpenInput = {
  target: ExecutionTarget;
  policy: BrowserAutomationPolicy;
};

export type CoordinatorInspectionGeneration = Readonly<{
  generationId: symbol;
  inspectionReport: ApplicationFormInspectionReport;
}>;

export type FormInspectionPort = Readonly<{
  inspect(): Promise<CoordinatorInspectionGeneration>;
  assertCurrent(generationId: symbol): Promise<CoordinatorInspectionGeneration>;
  currentTargetUrl(): string | null;
  assertAcquiredFillAuthority?: GuardedFillControllerPort["assertAcquiredFillAuthority"];
  writeApprovedField?: GuardedFillControllerPort["writeApprovedField"];
}>;

type CoordinatorInput = {
  configuredApplyPilotOrigin: string;
  immutableRunId: string;
  client: SameOriginClient;
  openTarget(input: TargetOpenInput, assertActive: () => void): Promise<{ finalUrl: string }>;
  initializeFormInspectionController?(input: Readonly<{ authoritativeApplyHost: string }>): void;
  getFormInspectionPort?(): FormInspectionPort | null;
  retireForHuman?(assertActive: () => void): Promise<void>;
  closeResources(): Promise<void>;
  onClosed?(): void;
  now?(): number;
  schedule?(callback: () => void, delayMs: number): unknown;
  cancel?(timer: unknown): void;
};

const HUMAN_SESSION_LIFETIME_MS = 60 * 60 * 1000;

function canonicalWithoutFragment(url: URL): string {
  const copy = new URL(url.toString());
  copy.hash = "";
  return copy.toString();
}

function errorCode(error: unknown): string {
  return error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : "BROWSER_WORKFLOW_FAILED";
}

const RECOVERABLE_INSPECTION_CODES = new Set<string>(BROWSER_INSPECTION_RECOVERABLE_CODES);
const FILL_COMMAND_REJECTION_CODES = new Set<string>(B3_FILL_COMMAND_REJECTION_CODES);
const TERMINAL_INSPECTION_CODES = new Set([
  "APPLY_PILOT_AUTH_REQUIRED",
  "EMPLOYER_AUTH_REQUIRED_UNSUPPORTED",
  "AUTOMATION_DISABLED",
  "RUN_NOT_FOUND",
  "RUN_IDENTITY_MISMATCH",
  "RUN_INVALID_STATE",
  "RUN_TARGET_INVALID",
  "RUN_TARGET_STALE",
  "RUN_HOST_NOT_ALLOWED",
  "RUN_INSPECTION_STALE",
  "RUN_INSPECTION_INVALID",
  "RUN_PACKET_INVALID",
  "RUN_ANSWER_SOURCE_SET_TOO_LARGE",
  "REQUEST_BODY_TOO_LARGE",
  "INVALID_CONTENT_LENGTH",
  "INVALID_JSON",
  "INVALID_REQUEST_BODY",
  "UNSUPPORTED_MEDIA_TYPE",
  "SAME_ORIGIN_REDIRECT_REJECTED",
  "SAME_ORIGIN_RESPONSE_MISMATCH",
  "SAME_ORIGIN_UNEXPECTED_CLIENT_ERROR",
  "INVALID_RUN_RESPONSE",
  "INVALID_POLICY_RESPONSE",
  "INVALID_ANSWER_PACKET_RESPONSE",
  "INVALID_FORM_INSPECTION_RESPONSE",
  "TARGET_NAVIGATION_BLOCKED",
  "TARGET_PAGE_CLOSED",
  "UNEXPECTED_POPUP",
  "BROWSER_WORKFLOW_FAILED"
]);

function recoverableInspectionCode(error: unknown): BrowserInspectionRecoverableCode | null {
  const code = errorCode(error);
  return RECOVERABLE_INSPECTION_CODES.has(code)
    ? code as BrowserInspectionRecoverableCode
    : null;
}

function terminalInspectionCode(error: unknown): string {
  const code = errorCode(error);
  return TERMINAL_INSPECTION_CODES.has(code) ? code : "BROWSER_WORKFLOW_FAILED";
}

export class ApplicationBrowserCoordinator {
  readonly configuredApplyPilotOrigin: string;
  readonly immutableRunId: string;
  readonly identity: Readonly<{ configuredApplyPilotOrigin: string; immutableRunId: string }>;
  private readonly input: CoordinatorInput;
  private workflowState: B1WorkflowState = "STARTING";
  private targetHost: string | undefined;
  private workflowErrorCode: string | undefined;
  private openedTarget: ExecutionTarget | null = null;
  private inspectionInFlight = false;
  private fillInFlight = false;
  private activeFillOperation: symbol | null = null;
  private acquisitionMayHaveDispatchedForRun = false;
  private inspectionStatus: B2InspectionCommandStatus | undefined;
  private fillCommandStatus: B3FillCommandStatus | undefined;
  private publishedFillAuthority: Readonly<{
    generationId: symbol;
    formInspectionVersion: number;
    answerPacketVersion: number;
    frozenTargetUrl: string;
  }> | null = null;
  private cleanupPromise: Promise<void> | null = null;
  private humanSessionExpiresAtMs: number | null = null;
  private humanSessionTimer: unknown = null;
  private humanSessionClosingPromise: Promise<B1Status> | null = null;

  constructor(input: CoordinatorInput) {
    this.input = input;
    this.configuredApplyPilotOrigin = input.configuredApplyPilotOrigin;
    this.immutableRunId = input.immutableRunId;
    this.identity = Object.freeze({
      configuredApplyPilotOrigin: input.configuredApplyPilotOrigin,
      immutableRunId: input.immutableRunId
    });
  }

  status(): B1Status {
    return {
      state: this.workflowState,
      runId: this.immutableRunId,
      ...(this.targetHost ? { targetHost: this.targetHost } : {}),
      ...(this.workflowErrorCode ? { errorCode: this.workflowErrorCode } : {}),
      ...(this.workflowState === "TARGET_OPEN" && this.inspectionStatus
        ? { inspection: this.inspectionStatus }
        : {}),
      ...(this.fillCommandStatus ? { fillCommand: this.fillCommandStatus } : {}),
      ...(this.workflowState === "HUMAN_ONLY" && this.humanSessionExpiresAtMs !== null
        ? { humanSession: { expiresAtMs: this.humanSessionExpiresAtMs } }
        : {})
    };
  }

  state(): B1WorkflowState {
    return this.workflowState;
  }

  markApplyPilotAuthRequired(): void {
    if (this.workflowState === "STARTING") this.workflowState = "APPLY_PILOT_AUTH_REQUIRED";
  }

  markControlReady(): void {
    if (this.workflowState !== "STARTING" && this.workflowState !== "APPLY_PILOT_AUTH_REQUIRED") {
      throw new ApplicationBrowserError("The control page cannot become ready in this state.", "CONTROL_STATE_INVALID");
    }
    this.workflowState = "CONTROL_READY";
  }

  async handleCommand(command: B1Command, assertActive: () => void): Promise<B1Status> {
    assertActive();
    if (command.type === "GET_STATUS") return this.status();
    if (command.type === "CLOSE_WORKFLOW") {
      await this.close();
      return this.status();
    }
    if (command.type === "HANDOFF_TO_HUMAN") return this.handoffToHuman(assertActive);
    if (command.type === "END_HUMAN_SESSION") return this.endHumanSession();
    if (command.type === "INSPECT_FORM") return this.inspectForm(assertActive);
    if (command.type === "FILL_APPROVED_FIELDS") {
      return this.activateApprovedFields(assertActive);
    }
    return this.openTarget(assertActive);
  }

  private requireState(expected: B1WorkflowState): void {
    if (this.workflowState === expected) return;
    throw new ApplicationBrowserError(
      "The browser workflow changed while an operation was in progress.",
      this.workflowErrorCode ?? "BROWSER_WORKFLOW_FAILED"
    );
  }

  private establishError(code: string): void {
    if (this.workflowState === "CLOSED" || this.workflowState === "ERROR") return;
    this.workflowState = "ERROR";
    this.workflowErrorCode = code;
  }

  private validateRun(run: BrowserApplicationRun): ExecutionTarget {
    if (run.id !== this.immutableRunId) {
      throw new ApplicationBrowserError("The run identity changed.", "RUN_IDENTITY_MISMATCH");
    }
    if (run.state !== "READY" && run.state !== "REVIEW_REQUIRED") {
      throw new ApplicationBrowserError("The application run is not ready.", "RUN_INVALID_STATE");
    }
    if (!Number.isSafeInteger(run.stateVersion) || run.stateVersion < 0) {
      throw new ApplicationBrowserError("The application run version is invalid.", "INVALID_RUN_RESPONSE");
    }
    const target = parseExecutionTargetUrl(run.applyUrlSnapshot);
    if (!target || !run.applyHost || target.host !== run.applyHost) {
      throw new ApplicationBrowserError("The frozen application target is invalid.", "RUN_TARGET_INVALID");
    }
    return target;
  }

  private validatePolicy(policy: BrowserAutomationPolicy, target: ExecutionTarget): void {
    if (!policy.effectiveEnabled) {
      throw new ApplicationBrowserError("Application automation is disabled.", "AUTOMATION_DISABLED");
    }
    if (!isHostAllowedForExecution(target.host, {
      allowedHosts: [...policy.allowedHosts],
      blockedHosts: [...policy.blockedHosts]
    })) {
      throw new ApplicationBrowserError("The frozen application host is not allowed.", "RUN_HOST_NOT_ALLOWED");
    }
  }

  private sameCanonicalTarget(left: ExecutionTarget, right: ExecutionTarget): boolean {
    return left.host === right.host && canonicalWithoutFragment(left.url) === canonicalWithoutFragment(right.url);
  }

  private requireCurrentTarget(
    port: FormInspectionPort,
    freshTarget: ExecutionTarget = this.openedTarget as ExecutionTarget
  ): string {
    const original = this.openedTarget;
    const currentUrl = port.currentTargetUrl();
    const current = currentUrl ? parseExecutionTargetUrl(currentUrl) : null;
    if (
      !original ||
      !current ||
      !this.sameCanonicalTarget(current, original) ||
      !this.sameCanonicalTarget(current, freshTarget) ||
      !this.sameCanonicalTarget(freshTarget, original)
    ) {
      throw new ApplicationBrowserError("Employer target authority was lost.", "RUN_TARGET_STALE");
    }
    return currentUrl as string;
  }

  private async openTarget(assertActive: () => void): Promise<B1Status> {
    if (this.workflowState !== "CONTROL_READY") {
      throw new ApplicationBrowserError("OPEN_TARGET is not allowed in this state.", "COMMAND_NOT_ALLOWED");
    }

    this.workflowState = "OPENING_TARGET";
    try {
      assertActive();
      const run = await this.input.client.getApplicationRun(this.immutableRunId);
      assertActive();
      this.requireState("OPENING_TARGET");
      const target = this.validateRun(run);

      const policy = await this.input.client.getAutomationPolicy();
      assertActive();
      this.requireState("OPENING_TARGET");
      this.validatePolicy(policy, target);

      const opened = await this.input.openTarget({ target, policy }, assertActive);
      assertActive();
      this.requireState("OPENING_TARGET");
      const finalTarget = parseExecutionTargetUrl(opened.finalUrl);
      if (
        !finalTarget ||
        finalTarget.host !== target.host ||
        canonicalWithoutFragment(finalTarget.url) !== canonicalWithoutFragment(target.url)
      ) {
        throw new ApplicationBrowserError(
          "The anonymous employer target could not be reached exactly.",
          "EMPLOYER_AUTH_REQUIRED_UNSUPPORTED"
        );
      }
      this.requireState("OPENING_TARGET");
      this.input.initializeFormInspectionController?.({ authoritativeApplyHost: target.host });
      this.requireState("OPENING_TARGET");
      this.openedTarget = target;
      this.targetHost = target.host;
      this.workflowState = "TARGET_OPEN";
      return this.status();
    } catch (error) {
      this.establishError(errorCode(error));
      throw error;
    }
  }

  private ephemeralInspection(inspection: B2InspectionCommandStatus): B1Status {
    return { ...this.status(), inspection };
  }

  private persistInspection(inspection: B2InspectionCommandStatus): void {
    if (this.workflowState === "TARGET_OPEN") this.inspectionStatus = inspection;
  }

  private async inspectForm(assertActive: () => void): Promise<B1Status> {
    if (this.workflowState !== "TARGET_OPEN") {
      throw new ApplicationBrowserError("INSPECT_FORM is not allowed in this state.", "COMMAND_NOT_ALLOWED");
    }
    if (this.inspectionInFlight || this.fillInFlight) {
      return this.ephemeralInspection({
        outcome: "FAILED",
        errorCode: "FORM_INSPECTION_IN_PROGRESS",
        retryAllowed: true
      });
    }
    const port = this.input.getFormInspectionPort?.() ?? null;
    if (!port) {
      const unavailable = new ApplicationBrowserError(
        "The form inspection controller is unavailable.",
        "BROWSER_WORKFLOW_FAILED"
      );
      await this.safeStop(unavailable.code);
      throw unavailable;
    }
    try {
      this.requireCurrentTarget(port);
    } catch (error) {
      const code = terminalInspectionCode(error);
      await this.safeStop(code);
      throw new ApplicationBrowserError("The form inspection command failed safely.", code);
    }
    this.inspectionInFlight = true;
    this.publishedFillAuthority = null;
    this.inspectionStatus = { outcome: "IN_PROGRESS" };

    try {
      assertActive();
      this.requireState("TARGET_OPEN");
      const preRun = await this.input.client.getApplicationRun(this.immutableRunId);
      assertActive();
      this.requireState("TARGET_OPEN");
      const preTarget = this.validateRun(preRun);
      this.requireCurrentTarget(port, preTarget);
      const prePolicy = await this.input.client.getAutomationPolicy();
      assertActive();
      this.requireState("TARGET_OPEN");
      this.validatePolicy(prePolicy, preTarget);

      const inspected = await port.inspect();
      assertActive();
      this.requireState("TARGET_OPEN");

      const postRun = await this.input.client.getApplicationRun(this.immutableRunId);
      assertActive();
      this.requireState("TARGET_OPEN");
      const postTarget = this.validateRun(postRun);
      this.requireCurrentTarget(port, postTarget);
      const packet = await this.input.client.getCurrentAnswerPacket(this.immutableRunId);
      assertActive();
      this.requireState("TARGET_OPEN");
      if (packet.runId !== this.immutableRunId) {
        throw new ApplicationBrowserError("The answer packet run identity changed.", "RUN_IDENTITY_MISMATCH");
      }
      const postPolicy = await this.input.client.getAutomationPolicy();
      assertActive();
      this.requireState("TARGET_OPEN");
      this.validatePolicy(postPolicy, postTarget);

      const current = await port.assertCurrent(inspected.generationId);
      if (current.generationId !== inspected.generationId) {
        throw new ApplicationBrowserError(
          "The inspected form generation was inconsistent.",
          "BROWSER_WORKFLOW_FAILED"
        );
      }

      assertActive();
      this.requireState("TARGET_OPEN");
      const observedUrl = this.requireCurrentTarget(port, postTarget);
      const freshRunState = postRun.state === "READY" ? "READY" : "REVIEW_REQUIRED";
      const publicationPromise = this.input.client.publishFormInspection({
        runId: this.immutableRunId,
        freshRunState,
        expectedStateVersion: postRun.stateVersion,
        expectedFormInspectionVersion: packet.current?.inspectionVersion ?? 0,
        expectedAnswerPacketVersion: packet.current?.answerPacketVersion ?? 0,
        observedUrl,
        inspectionReport: current.inspectionReport
      }, () => {
        assertActive();
        this.requireState("TARGET_OPEN");
        this.requireCurrentTarget(port, postTarget);
      });
      const published = await publicationPromise;
      assertActive();
      this.requireState("TARGET_OPEN");
      this.requireCurrentTarget(port, postTarget);

      const reinspectionRequired = (
        this.inspectionStatus as B2InspectionCommandStatus | undefined
      )?.outcome === "REINSPECTION_REQUIRED";
      const success: B2InspectionCommandStatus = {
        outcome: "SUCCEEDED",
        replayed: published.replayed,
        inspectionVersion: published.current.inspectionVersion,
        answerPacketVersion: published.current.answerPacketVersion,
        reinspectionRequired
      };
      if (!reinspectionRequired && this.inspectionStatus?.outcome === "IN_PROGRESS") {
        this.fillCommandStatus = undefined;
        this.publishedFillAuthority = Object.freeze({
          generationId: current.generationId,
          formInspectionVersion: published.current.inspectionVersion,
          answerPacketVersion: published.current.answerPacketVersion,
          frozenTargetUrl: (this.openedTarget as ExecutionTarget).url.toString()
        });
      }
      if (this.inspectionStatus?.outcome === "IN_PROGRESS") this.persistInspection(success);
      return this.ephemeralInspection(success);
    } catch (error) {
      const recoverable = recoverableInspectionCode(error);
      let authorityActive = this.workflowState === "TARGET_OPEN";
      if (authorityActive && recoverable === "FORM_INSPECTION_CANCELLED") {
        try {
          assertActive();
          this.requireCurrentTarget(port);
        } catch {
          authorityActive = false;
        }
      }
      if (recoverable && authorityActive) {
        const result: B2InspectionCommandStatus = recoverable === "FORM_GENERATION_INVALIDATED"
          ? { outcome: "REINSPECTION_REQUIRED", errorCode: recoverable, retryAllowed: true }
          : { outcome: "FAILED", errorCode: recoverable, retryAllowed: true };
        if (this.inspectionStatus?.outcome === "IN_PROGRESS") this.persistInspection(result);
        return this.ephemeralInspection(result);
      }
      const code = this.workflowErrorCode ?? terminalInspectionCode(error);
      await this.safeStop(code);
      throw new ApplicationBrowserError("The form inspection command failed safely.", code);
    } finally {
      this.inspectionInFlight = false;
    }
  }

  async fillApprovedFields(
    assertActive: () => void
  ): Promise<GuardedFillOrchestrationResult> {
    if (this.workflowState !== "TARGET_OPEN") {
      throw new ApplicationBrowserError(
        "Guarded Fill is not available in this workflow state.",
        "FILL_INTERNAL"
      );
    }
    if (this.inspectionInFlight || this.fillInFlight) {
      throw new ApplicationBrowserError(
        "A protected browser operation is already active.",
        "FILL_INTERNAL"
      );
    }
    const port = this.input.getFormInspectionPort?.() ?? null;
    const published = this.publishedFillAuthority;
    const fillClient = this.input.client as SameOriginClient & Partial<SameOriginFillClient>;
    if (
      !port ||
      !published ||
      typeof port.assertAcquiredFillAuthority !== "function" ||
      typeof port.writeApprovedField !== "function" ||
      typeof fillClient.acquireFillAttempt !== "function" ||
      typeof fillClient.getFillAttemptStatus !== "function" ||
      typeof fillClient.finalizeFillAttempt !== "function" ||
      typeof fillClient.recoverExpiredFillAttempt !== "function"
    ) {
      throw new ApplicationBrowserError(
        "No published protected generation is available for Fill.",
        "FILL_INTERNAL"
      );
    }

    const fillOperation = Symbol("guarded-fill-operation");
    this.fillInFlight = true;
    this.activeFillOperation = fillOperation;
    this.publishedFillAuthority = null;
    try {
      const orchestration = createGuardedFillOrchestrationService({
        client: fillClient as SameOriginClient & SameOriginFillClient,
        controller: port as GuardedFillControllerPort,
        onAcquisitionUncertain: () => {
          this.acquisitionMayHaveDispatchedForRun = true;
        }
      });
      const execution = {
        runId: this.immutableRunId,
        generationId: published.generationId,
        formInspectionVersion: published.formInspectionVersion,
        answerPacketVersion: published.answerPacketVersion,
        frozenTargetUrl: published.frozenTargetUrl,
        assertActive: () => {
          assertActive();
          if (
            this.workflowState !== "TARGET_OPEN" ||
            !this.fillInFlight ||
            this.activeFillOperation !== fillOperation
          ) {
            throw new ApplicationBrowserError(
              "The guarded Fill operation is no longer active.",
              "BROWSER_WORKFLOW_FAILED"
            );
          }
        }
      };
      return await (this.acquisitionMayHaveDispatchedForRun
        ? orchestration.reconcileAcquisitionUncertainty(execution)
        : orchestration.execute(execution));
    } finally {
      if (this.activeFillOperation === fillOperation) this.activeFillOperation = null;
      this.fillInFlight = false;
    }
  }

  private async activateApprovedFields(assertActive: () => void): Promise<B1Status> {
    if (this.workflowState !== "TARGET_OPEN") {
      throw new ApplicationBrowserError(
        "FILL_APPROVED_FIELDS is not allowed in this state.",
        "COMMAND_NOT_ALLOWED"
      );
    }
    if (this.fillCommandStatus !== undefined) return this.status();
    if (this.publishedFillAuthority === null) {
      throw new ApplicationBrowserError(
        "No published protected generation is available for Fill.",
        "FILL_INTERNAL"
      );
    }

    this.fillCommandStatus = Object.freeze({ outcome: "IN_PROGRESS" });
    try {
      const result = await this.fillApprovedFields(assertActive);
      assertActive();
      this.requireState("TARGET_OPEN");
      this.fillCommandStatus = Object.freeze({ outcome: result.disposition });
      return this.status();
    } catch (error) {
      if (
        error instanceof GuardedFillOrchestrationError &&
        FILL_COMMAND_REJECTION_CODES.has(error.code)
      ) {
        assertActive();
        this.requireState("TARGET_OPEN");
        this.fillCommandStatus = Object.freeze({
          outcome: "REJECTED",
          errorCode: error.code as B3FillCommandRejectionCode
        });
        return this.status();
      }
      throw error;
    }
  }

  handleFormInspectionInvalidation(code: ApplicationFormInspectionInvalidationCode): void | Promise<void> {
    this.publishedFillAuthority = null;
    this.activeFillOperation = null;
    if (code === "PAGE_CLOSED") return this.safeStop("TARGET_PAGE_CLOSED");
    if (code === "PROTECTED_SESSION_LOST") return this.safeStop("BROWSER_WORKFLOW_FAILED");
    if (this.workflowState !== "TARGET_OPEN") return;
    this.inspectionStatus = {
      outcome: "REINSPECTION_REQUIRED",
      errorCode: "FORM_GENERATION_INVALIDATED",
      retryAllowed: true
    };
  }

  private closeResourcesOnce(): Promise<void> {
    if (this.cleanupPromise) return this.cleanupPromise;
    this.cleanupPromise = (async () => {
      try {
        await this.input.closeResources();
      } finally {
        this.input.onClosed?.();
      }
    })();
    return this.cleanupPromise;
  }

  private clearHumanSessionTimer(): void {
    if (this.humanSessionTimer === null) return;
    (this.input.cancel ?? clearTimeout)(this.humanSessionTimer as ReturnType<typeof setTimeout>);
    this.humanSessionTimer = null;
  }

  private async handoffToHuman(assertActive: () => void): Promise<B1Status> {
    if (this.humanSessionClosingPromise) return this.humanSessionClosingPromise;
    if (this.workflowState === "HUMAN_ONLY") return this.status();
    if (this.workflowState !== "TARGET_OPEN") {
      throw new ApplicationBrowserError("Human handoff is unavailable in this state.", "COMMAND_NOT_ALLOWED");
    }
    if (
      this.inspectionInFlight || this.fillInFlight || this.activeFillOperation !== null ||
      this.inspectionStatus?.outcome === "IN_PROGRESS" ||
      this.fillCommandStatus?.outcome === "IN_PROGRESS" ||
      this.fillCommandStatus?.outcome === "RECOVERY_PENDING"
    ) {
      throw new ApplicationBrowserError("A protected operation is not settled.", "HANDOFF_NOT_QUIESCENT");
    }
    if (!this.input.retireForHuman) {
      throw new ApplicationBrowserError("Human handoff retirement is unavailable.", "HANDOFF_RETIREMENT_FAILED");
    }
    this.workflowState = "HANDOFF_PENDING";
    this.publishedFillAuthority = null;
    try {
      assertActive();
      await this.input.retireForHuman(assertActive);
      assertActive();
      this.requireState("HANDOFF_PENDING");
      this.workflowState = "HUMAN_ONLY";
      this.humanSessionExpiresAtMs = (this.input.now ?? Date.now)() + HUMAN_SESSION_LIFETIME_MS;
      this.humanSessionTimer = (this.input.schedule ?? setTimeout)(() => {
        void this.endHumanSession();
      }, HUMAN_SESSION_LIFETIME_MS);
      return this.status();
    } catch (error) {
      await this.safeStop("HANDOFF_RETIREMENT_FAILED");
      throw error;
    }
  }

  private endHumanSession(): Promise<B1Status> {
    if (this.humanSessionClosingPromise) return this.humanSessionClosingPromise;
    if (this.workflowState === "CLOSED" || this.workflowState === "ERROR") return Promise.resolve(this.status());
    if (this.workflowState !== "HUMAN_ONLY") {
      throw new ApplicationBrowserError("No human session is active.", "COMMAND_NOT_ALLOWED");
    }
    this.clearHumanSessionTimer();
    this.publishedFillAuthority = null;
    this.humanSessionClosingPromise = (async () => {
      try {
        await this.closeResourcesOnce();
        this.workflowState = "CLOSED";
      } catch {
        this.workflowState = "ERROR";
        this.workflowErrorCode = "HUMAN_SESSION_CLEANUP_UNCERTAIN";
      }
      return this.status();
    })();
    return this.humanSessionClosingPromise;
  }

  async safeStop(code: string): Promise<void> {
    const humanBoundary = this.workflowState === "HANDOFF_PENDING" || this.workflowState === "HUMAN_ONLY";
    this.clearHumanSessionTimer();
    this.activeFillOperation = null;
    if (this.workflowState === "CLOSED") return;
    this.publishedFillAuthority = null;
    this.establishError(code);
    try {
      await this.closeResourcesOnce();
    } catch {
      if (humanBoundary) this.workflowErrorCode = "HUMAN_SESSION_CLEANUP_UNCERTAIN";
      // The owning companion observes the memoized cleanup failure during finalization.
    }
  }

  async close(): Promise<void> {
    const humanBoundary = this.workflowState === "HANDOFF_PENDING" || this.workflowState === "HUMAN_ONLY";
    this.clearHumanSessionTimer();
    this.publishedFillAuthority = null;
    this.activeFillOperation = null;
    this.workflowState = humanBoundary ? "HANDOFF_PENDING" : "CLOSED";
    try {
      await this.closeResourcesOnce();
      this.workflowState = "CLOSED";
    } catch (error) {
      if (humanBoundary) {
        this.workflowState = "ERROR";
        this.workflowErrorCode = "HUMAN_SESSION_CLEANUP_UNCERTAIN";
      }
      throw error;
    }
  }
}

export function createSafeBrowserDiagnostic(input: {
  runId: string;
  state: B1WorkflowState;
  operation: string;
  code: string;
  host?: string;
  elapsedMs?: number;
  count?: number;
  [key: string]: unknown;
}) {
  return {
    runId: input.runId,
    state: input.state,
    operation: input.operation,
    code: input.code,
    ...(input.host ? { host: input.host } : {}),
    ...(typeof input.elapsedMs === "number" ? { elapsedMs: input.elapsedMs } : {}),
    ...(typeof input.count === "number" ? { count: input.count } : {})
  };
}

type SyntheticFulfill = (request: Request, route: Route) => Promise<void>;
type ProtectedTargetSession = Readonly<
  ProtectedFormInspectionAuthority &
  Pick<ProtectedApplicationBrowserSession, "close"> &
  Partial<Pick<ProtectedApplicationBrowserSession, "retireForHuman">>
>;

export function createPlaywrightTargetController(input: {
  context: BrowserContext;
  onUnsafe(code: string): void | Promise<void>;
  testOnlyFulfillMainDocument?: SyntheticFulfill;
  testOnlyBeforeRouteContinue?(request: Request): Promise<void>;
  testOnlyCreateHumanPolicySession?(page: Page): Promise<CDPSession>;
  testOnlyBeforeHumanPolicySwitch?(): Promise<void>;
  testOnlyCreateProtectedSession?(page: Page): Promise<ProtectedTargetSession>;
}) {
  let employerPage: Page | null = null;
  let protectedSession: ProtectedTargetSession | null = null;
  let formInspectionTarget: ProtectedFormInspectionTarget | null = null;
  const mainFrameNavigationListeners = new Set<() => void>();
  const setupPageEvents = new Set<Page>();
  const pageClosePromises = new WeakMap<Page, Promise<void>>();
  const sessionClosePromises = new WeakMap<ProtectedTargetSession, Promise<void>>();
  const pendingCleanup = new Set<Promise<void>>();
  let acceptingEmployerPage = false;
  let setupSettlement: Promise<void> | null = null;
  let setupPage: Page | null = null;
  let setupSession: ProtectedTargetSession | null = null;
  let contextListenerRetirementPromise: Promise<void> | null = null;
  let closePromise: Promise<void> | null = null;
  let closed = false;
  let contextListenerRemoved = false;
  let pageCleanupGeneration = 0;
  let guardFailure: ApplicationBrowserError | null = null;
  let automationRetired = false;
  let retirementIngressClosed = false;
  let retireOwnedPage: ((controlOrigin: string, assertActive: () => void) => Promise<void>) | null = null;
  let retirementPromise: Promise<void> | null = null;
  let humanNavigationCdp: CDPSession | null = null;

  const trackCleanup = (cleanup: Promise<void>): Promise<void> => {
    pendingCleanup.add(cleanup);
    void cleanup.finally(() => pendingCleanup.delete(cleanup));
    return cleanup;
  };

  const closePageOnce = (page: Page): Promise<void> => {
    const existing = pageClosePromises.get(page);
    if (existing) return existing;
    let resolveCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => {
      resolveCleanup = resolve;
    });
    pageClosePromises.set(page, cleanup);
    pageCleanupGeneration += 1;
    trackCleanup(cleanup);
    try {
      void Promise.resolve(page.close()).then(resolveCleanup, resolveCleanup);
    } catch {
      resolveCleanup();
    }
    return cleanup;
  };

  const closeSessionOnce = (session: ProtectedTargetSession): Promise<void> => {
    const existing = sessionClosePromises.get(session);
    if (existing) return existing;
    let resolveCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => {
      resolveCleanup = resolve;
    });
    sessionClosePromises.set(session, cleanup);
    trackCleanup(cleanup);
    try {
      void Promise.resolve(session.close()).then(resolveCleanup, resolveCleanup);
    } catch {
      resolveCleanup();
    }
    return cleanup;
  };

  const reportUnexpectedPage = (page: Page): void => {
    void closePageOnce(page);
    try {
      void Promise.resolve(input.onUnsafe("UNEXPECTED_POPUP")).catch(() => undefined);
    } catch {
      // Notification cannot interrupt synchronous popup revocation or setup settlement.
    }
  };

  const unexpectedPage = (page: Page) => {
    if (closed) {
      void closePageOnce(page);
      return;
    }
    if (acceptingEmployerPage) {
      setupPageEvents.add(page);
      return;
    }
    reportUnexpectedPage(page);
  };
  input.context.on("page", unexpectedPage);

  const removeContextListener = (): void => {
    if (contextListenerRemoved) return;
    contextListenerRemoved = true;
    input.context.off("page", unexpectedPage);
  };

  const retireContextListenerAfterStableCleanup = (): Promise<void> => {
    if (contextListenerRetirementPromise) return contextListenerRetirementPromise;
    contextListenerRetirementPromise = (async () => {
      while (true) {
        const observedGeneration = pageCleanupGeneration;
        await Promise.all([...pendingCleanup]);
        if (pageCleanupGeneration !== observedGeneration) continue;
        removeContextListener();
        return;
      }
    })();
    return contextListenerRetirementPromise;
  };

  const revoke = (): void => {
    if (closed) return;
    closed = true;
    formInspectionTarget = null;
    mainFrameNavigationListeners.clear();
  };

  const cleanupOwnedResources = (): Promise<void> => {
    const policySession = humanNavigationCdp;
    humanNavigationCdp = null;
    const ownedSessions = [protectedSession, setupSession].filter(
      (session): session is ProtectedTargetSession => session !== null
    );
    protectedSession = null;
    setupSession = null;
    const ownedPages = [employerPage, setupPage, ...setupPageEvents].filter(
      (page): page is Page => page !== null
    );
    employerPage = null;
    setupPage = null;
    setupPageEvents.clear();
    const sessionClosures = ownedSessions.map((session) => closeSessionOnce(session));
    const pageClosures = ownedPages.map((page) => closePageOnce(page));
    const policyClosure = policySession ? [Promise.resolve(policySession.detach()).catch(() => undefined)] : [];
    return Promise.all([...sessionClosures, ...pageClosures, ...policyClosure]).then(() => undefined);
  };

  function close(): Promise<void> {
    if (closePromise) return closePromise;
    let resolveClose!: () => void;
    let rejectClose!: (error: unknown) => void;
    const sharedClose = new Promise<void>((resolve, reject) => {
      resolveClose = () => resolve();
      rejectClose = reject;
    });
    closePromise = sharedClose;
    revoke();
    const ownedSetup = setupSettlement;
    void (async () => {
      await cleanupOwnedResources();
      if (ownedSetup) await ownedSetup;
      await cleanupOwnedResources();
      await retireContextListenerAfterStableCleanup();
    })().then(resolveClose, rejectClose);
    return sharedClose;
  }

  const assertOpeningActive = (): void => {
    if (!closed) return;
    throw new ApplicationBrowserError(
      "The employer target opening was cancelled.",
      "BROWSER_WORKFLOW_FAILED"
    );
  };

  const reconcileSetupPageEvents = (created: Page): void => {
    const observed = [...setupPageEvents];
    setupPageEvents.clear();
    for (const page of observed) {
      if (page === created) continue;
      if (closed) {
        void closePageOnce(page);
      } else {
        reportUnexpectedPage(page);
      }
    }
  };

  return Object.freeze({
    async open(openInput: TargetOpenInput, assertActive: () => void): Promise<{ finalUrl: string }> {
      if (closed || employerPage || setupSettlement) {
        throw new ApplicationBrowserError("The employer page is already open.", "TARGET_ALREADY_OPEN");
      }
      let settleSetup!: () => void;
      const ownedSetup = new Promise<void>((resolve) => {
        settleSetup = resolve;
      });
      setupSettlement = ownedSetup;
      let created: Page | null = null;
      let session: ProtectedTargetSession | null = null;
      let handedOff = false;

      try {
        acceptingEmployerPage = true;
        try {
          created = await input.context.newPage();
        } finally {
          acceptingEmployerPage = false;
        }
        setupPage = created;
        if (closed) void closePageOnce(created);
        reconcileSetupPageEvents(created);
        const openingPage = created;
        assertOpeningActive();
        if (await openingPage.opener()) {
          revoke();
          throw new ApplicationBrowserError(
            "The employer page unexpectedly has an opener.",
            "TARGET_OPENER_PRESENT"
          );
        }
        assertOpeningActive();

        try {
          session = await (
            input.testOnlyCreateProtectedSession?.(openingPage) ??
            createProtectedApplicationBrowserSession({ page: openingPage })
          );
          setupSession = session;
          if (closed) void closeSessionOnce(session);
        } catch {
          revoke();
          throw new ApplicationBrowserError(
            "Protected employer-page session setup failed.",
            "BROWSER_WORKFLOW_FAILED"
          );
        }
        assertOpeningActive();

        let navigationCount = 0;
        let navigationPhase: "INITIAL_CONVERGENCE" | "STEADY_TARGET" | "HUMAN_ONLY" = "INITIAL_CONVERGENCE";
        let humanControlOrigin: string | null = null;
        const pendingRouteCallbacks = new Set<Promise<void>>();
        const pendingHumanPolicyDecisions = new Set<Promise<unknown>>();
        const frozenOrigin = openInput.target.url.origin;
        const frozenCanonicalUrl = canonicalWithoutFragment(openInput.target.url);
        const policy = {
          allowedHosts: [...openInput.policy.allowedHosts],
          blockedHosts: [...openInput.policy.blockedHosts]
        };
        const isAllowedAuthority = (candidate: ExecutionTarget | null): candidate is ExecutionTarget =>
          candidate !== null &&
          candidate.url.origin === frozenOrigin &&
          candidate.host === openInput.target.host &&
          isHostAllowedForExecution(candidate.host, policy);
        const isCanonicalTarget = (candidate: ExecutionTarget | null): boolean =>
          isAllowedAuthority(candidate) &&
          canonicalWithoutFragment(candidate.url) === frozenCanonicalUrl;
        const postFenceAllowed = (url: string): boolean => {
          const candidate = parseExecutionTargetUrl(url);
          return candidate !== null && humanControlOrigin !== null && candidate.url.origin !== humanControlOrigin;
        };
        const markUnsafe = (code = "TARGET_NAVIGATION_BLOCKED") => {
          if (guardFailure) return;
          guardFailure = new ApplicationBrowserError(
            "Employer navigation was blocked before the request left Chromium.",
            code
          );
          void input.onUnsafe(code);
        };

        openingPage.on("framenavigated", (frame) => {
          if (frame !== openingPage.mainFrame()) return;
          if (navigationPhase === "STEADY_TARGET" && !isCanonicalTarget(parseExecutionTargetUrl(frame.url()))) markUnsafe();
          if (navigationPhase === "HUMAN_ONLY" && !postFenceAllowed(frame.url())) markUnsafe("HUMAN_NAVIGATION_BLOCKED");
          for (const listener of mainFrameNavigationListeners) {
            try {
              listener();
            } catch {
              // Inspection lifecycle observers cannot interrupt the target guard.
            }
          }
        });
        await openingPage.route("**/*", async (route, request) => {
          let settleRoute!: () => void;
          const routeSettlement = new Promise<void>((resolve) => { settleRoute = resolve; });
          pendingRouteCallbacks.add(routeSettlement);
          try {
          if (retirementIngressClosed && navigationPhase !== "HUMAN_ONLY") {
            await route.abort("blockedbyclient");
            return;
          }
          if (
            !request.isNavigationRequest() ||
            request.resourceType() !== "document" ||
            request.frame() !== openingPage.mainFrame()
          ) {
            await input.testOnlyBeforeRouteContinue?.(request);
            await route.continue();
            return;
          }

          if (navigationPhase === "HUMAN_ONLY") {
            if (guardFailure || !postFenceAllowed(request.url())) {
              markUnsafe("HUMAN_NAVIGATION_BLOCKED");
              await route.abort("blockedbyclient");
              return;
            }
            if (input.testOnlyFulfillMainDocument) await input.testOnlyFulfillMainDocument(request, route);
            else await route.continue();
            return;
          }

          if (navigationPhase === "INITIAL_CONVERGENCE") navigationCount += 1;
          const candidate = parseExecutionTargetUrl(request.url());
          const valid =
            !guardFailure &&
            isAllowedAuthority(candidate) &&
            // Playwright's route.continue carries redirects without re-entering this
            // route. Once the exact page is open, any new document request could
            // redirect to an unreviewed destination. Keep it frozen until handoff.
            navigationPhase === "INITIAL_CONVERGENCE" &&
            navigationCount <= 5 && (navigationCount > 1 || isCanonicalTarget(candidate));
          if (!valid) {
            markUnsafe();
            await route.abort("blockedbyclient");
            return;
          }
          if (input.testOnlyFulfillMainDocument) {
            await input.testOnlyFulfillMainDocument(request, route);
            return;
          }
          await route.continue();
          } finally {
            pendingRouteCallbacks.delete(routeSettlement);
            settleRoute();
          }
        });
        assertOpeningActive();

        assertActive();
        assertOpeningActive();
        try {
          await openingPage.goto(openInput.target.url.toString(), { waitUntil: "domcontentloaded" });
        } catch {
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
          revoke();
          if (guardFailure) throw guardFailure;
          throw new ApplicationBrowserError(
            "Employer target navigation failed.",
            "TARGET_NAVIGATION_FAILED"
          );
        }
        assertOpeningActive();
        assertActive();
        assertOpeningActive();
        if (guardFailure) {
          revoke();
          throw guardFailure;
        }
        if (!isCanonicalTarget(parseExecutionTargetUrl(openingPage.url()))) {
          revoke();
          throw new ApplicationBrowserError(
            "The anonymous employer target could not be reached exactly.",
            "EMPLOYER_AUTH_REQUIRED_UNSUPPORTED"
          );
        }
        navigationPhase = "STEADY_TARGET";
        try {
          await session.waitUntilReady();
        } catch {
          revoke();
          if (guardFailure) throw guardFailure;
          throw new ApplicationBrowserError(
            "Protected employer-page session was not ready.",
            "BROWSER_WORKFLOW_FAILED"
          );
        }
        assertOpeningActive();
        if (guardFailure) {
          revoke();
          throw guardFailure;
        }
        if (!isCanonicalTarget(parseExecutionTargetUrl(openingPage.url()))) {
          revoke();
          throw new ApplicationBrowserError(
            "The anonymous employer target could not be reached exactly.",
            "EMPLOYER_AUTH_REQUIRED_UNSUPPORTED"
          );
        }
        const ownedPage = openingPage;
        const ownedSession = session;
        const assertAuthorityActive = (): void => {
          if (
            closed ||
            automationRetired ||
            employerPage !== ownedPage ||
            protectedSession !== ownedSession ||
            ownedPage.isClosed()
          ) {
            throw new ApplicationBrowserError(
              "Protected employer-page authority is no longer current.",
              "BROWSER_WORKFLOW_FAILED"
            );
          }
        };
        const authority: ProtectedFormInspectionAuthority = Object.freeze({
          waitUntilReady: async () => {
            assertAuthorityActive();
            return ownedSession.waitUntilReady();
          },
          extractApplicationForm: async () => {
            assertAuthorityActive();
            return ownedSession.extractApplicationForm();
          },
          verifyCandidate: async (candidate) => {
            assertAuthorityActive();
            return ownedSession.verifyCandidate(candidate);
          },
          writeCandidateField: async (candidate, request) => {
            assertAuthorityActive();
            const writer = ownedSession.writeCandidateField;
            if (typeof writer !== "function") {
              throw new ApplicationBrowserError(
                "Protected employer-page writing is unavailable.",
                "BROWSER_WORKFLOW_FAILED"
              );
            }
            return writer.call(ownedSession, candidate, request);
          },
          snapshot: async () => {
            assertAuthorityActive();
            return ownedSession.snapshot();
          },
          waitForChange: async (since, timeoutMs) => {
            assertAuthorityActive();
            return ownedSession.waitForChange(since, timeoutMs);
          },
          subscribe: (listener) => {
            assertAuthorityActive();
            return ownedSession.subscribe(listener);
          }
        });
        const target: ProtectedFormInspectionTarget = Object.freeze({
          authority,
          currentTargetUrl: () =>
            !closed && employerPage === ownedPage && !ownedPage.isClosed()
              ? ownedPage.url()
              : null,
          subscribeMainFrameNavigation(listener) {
            if (closed || formInspectionTarget !== target || ownedPage.isClosed()) {
              return () => undefined;
            }
            mainFrameNavigationListeners.add(listener);
            return () => mainFrameNavigationListeners.delete(listener);
          }
        });

        assertOpeningActive();
        employerPage = ownedPage;
        protectedSession = ownedSession;
        setupPage = null;
        setupSession = null;
        formInspectionTarget = target;
        retireOwnedPage = (controlOrigin, assertActive) => {
          if (retirementPromise) return retirementPromise;
          if (closed || guardFailure || employerPage !== ownedPage || protectedSession !== ownedSession) {
            return Promise.reject(new ApplicationBrowserError("The employer page cannot be handed off.", "HANDOFF_RETIREMENT_FAILED"));
          }
          automationRetired = true;
          retirementIngressClosed = true;
          formInspectionTarget = null;
          mainFrameNavigationListeners.clear();
          retirementPromise = (async () => {
            if (!ownedSession.retireForHuman || pendingRouteCallbacks.size > 0) {
              throw new ApplicationBrowserError("Protected browser work is unresolved.", "HANDOFF_NOT_QUIESCENT");
            }
            await ownedSession.retireForHuman();
            if (pendingRouteCallbacks.size > 0) {
              throw new ApplicationBrowserError("A navigation callback is unresolved.", "HANDOFF_NOT_QUIESCENT");
            }
            assertActive();
            if (closed || guardFailure || ownedPage.isClosed()) {
              throw new ApplicationBrowserError("The employer page changed during retirement.", "HANDOFF_RETIREMENT_FAILED");
            }
            humanControlOrigin = controlOrigin;
            // Playwright route.continue follows redirects without re-entering the
            // page route. This lifecycle-only CDP Fetch policy sees each document
            // request, including redirects, without reading bodies or issuing a
            // new employer request on the companion's behalf.
            const policyCdp = await (input.testOnlyCreateHumanPolicySession?.(ownedPage) ??
              input.context.newCDPSession(ownedPage));
            humanNavigationCdp = policyCdp;
            const frameTree = await policyCdp.send("Page.getFrameTree");
            if (frameTree.frameTree.frame.id.length === 0) {
              throw new ApplicationBrowserError("The employer main frame is unavailable.", "HANDOFF_RETIREMENT_FAILED");
            }
            policyCdp.on("Fetch.requestPaused", (event) => {
              const allowed = navigationPhase === "HUMAN_ONLY" &&
                event.resourceType === "Document" &&
                postFenceAllowed(event.request.url);
              const operation = allowed
                ? policyCdp.send("Fetch.continueRequest", { requestId: event.requestId })
                : policyCdp.send("Fetch.failRequest", { requestId: event.requestId, errorReason: "BlockedByClient" });
              pendingHumanPolicyDecisions.add(operation);
              void operation.then(() => {
                if (!allowed) markUnsafe(navigationPhase === "HUMAN_ONLY" ? "HUMAN_NAVIGATION_BLOCKED" : "TARGET_NAVIGATION_BLOCKED");
              }, () => markUnsafe("HUMAN_POLICY_LOST")).finally(() => {
                pendingHumanPolicyDecisions.delete(operation);
              });
            });
            policyCdp.on("close", () => {
              if (!closed && navigationPhase === "HUMAN_ONLY") markUnsafe("HUMAN_POLICY_LOST");
            });
            await policyCdp.send("Fetch.enable", {
              patterns: [{ urlPattern: "*", resourceType: "Document", requestStage: "Request" }]
            });
            await input.testOnlyBeforeHumanPolicySwitch?.();
            assertActive();
            if (closed || guardFailure || ownedPage.isClosed()) {
              throw new ApplicationBrowserError("The employer page changed during policy setup.", "HANDOFF_RETIREMENT_FAILED");
            }
            if (pendingRouteCallbacks.size > 0 || pendingHumanPolicyDecisions.size > 0) {
              throw new ApplicationBrowserError("A browser callback is unresolved.", "HANDOFF_NOT_QUIESCENT");
            }
            navigationPhase = "HUMAN_ONLY";
          })();
          return retirementPromise;
        };
        handedOff = true;
        created = null;
        session = null;
        return { finalUrl: ownedPage.url() };
      } finally {
        acceptingEmployerPage = false;
        try {
          const provisionalPages = [...setupPageEvents];
          setupPageEvents.clear();
          if (setupPage === created) setupPage = null;
          if (setupSession === session) setupSession = null;
          if (!handedOff && session) await closeSessionOnce(session);
          await Promise.all([
            ...(!handedOff && created ? [closePageOnce(created)] : []),
            ...provisionalPages.map((page) => {
              if (closed) return closePageOnce(page);
              reportUnexpectedPage(page);
              return closePageOnce(page);
            })
          ]);
          if (handedOff) assertOpeningActive();
        } finally {
          try {
            if (closed && !closePromise) {
              await retireContextListenerAfterStableCleanup();
            }
          } finally {
            settleSetup();
            if (setupSettlement === ownedSetup) setupSettlement = null;
          }
        }
      }
    },
    page: () => employerPage,
    formInspectionTarget: () =>
      !closed && employerPage && !employerPage.isClosed()
        ? formInspectionTarget
        : null,
    retireForHuman: (controlOrigin: string, assertActive: () => void): Promise<void> =>
      retireOwnedPage?.(controlOrigin, assertActive) ?? Promise.reject(
        new ApplicationBrowserError("The employer page is not ready for handoff.", "HANDOFF_RETIREMENT_FAILED")
      ),
    close
  });
}
