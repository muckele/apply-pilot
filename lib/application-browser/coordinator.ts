import type { BrowserContext, Page, Request, Route } from "playwright";

import {
  isHostAllowedForExecution,
  parseExecutionTargetUrl,
  type ExecutionTarget
} from "@/lib/application-runs/host-policy";
import type {
  BrowserApplicationRun,
  BrowserAutomationPolicy,
  SameOriginClient
} from "@/lib/application-browser/same-origin-client";
import type { ApplicationFormInspectionInvalidationCode } from "@/lib/application-browser/form-inspection-controller";
import type { ApplicationFormInspectionReport } from "@/lib/application-runs/form-inspection";
import {
  BROWSER_INSPECTION_RECOVERABLE_CODES,
  type B1Command,
  type B1Status,
  type B1WorkflowState,
  type B2InspectionCommandStatus,
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
}>;

type CoordinatorInput = {
  configuredApplyPilotOrigin: string;
  immutableRunId: string;
  client: SameOriginClient;
  openTarget(input: TargetOpenInput, assertActive: () => void): Promise<{ finalUrl: string }>;
  initializeFormInspectionController?(input: Readonly<{ authoritativeApplyHost: string }>): void;
  getFormInspectionPort?(): FormInspectionPort | null;
  closeResources(): Promise<void>;
  onClosed?(): void;
};

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
const TERMINAL_INSPECTION_CODES = new Set([
  "APPLY_PILOT_AUTH_REQUIRED",
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
  private inspectionStatus: B2InspectionCommandStatus | undefined;
  private cleanupPromise: Promise<void> | null = null;

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
    if (command.type === "INSPECT_FORM") return this.inspectForm(assertActive);
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
    if (this.inspectionInFlight) {
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

  handleFormInspectionInvalidation(code: ApplicationFormInspectionInvalidationCode): void | Promise<void> {
    if (code === "PAGE_CLOSED") return this.safeStop("TARGET_PAGE_CLOSED");
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

  async safeStop(code: string): Promise<void> {
    if (this.workflowState === "CLOSED") return;
    this.establishError(code);
    try {
      await this.closeResourcesOnce();
    } catch {
      // The owning companion observes the memoized cleanup failure during finalization.
    }
  }

  async close(): Promise<void> {
    if (this.workflowState !== "CLOSED") this.workflowState = "CLOSED";
    await this.closeResourcesOnce();
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

export function createPlaywrightTargetController(input: {
  context: BrowserContext;
  onUnsafe(code: string): void | Promise<void>;
  testOnlyFulfillMainDocument?: SyntheticFulfill;
}) {
  let employerPage: Page | null = null;
  let acceptingEmployerPage = false;
  let closed = false;
  let guardFailure: ApplicationBrowserError | null = null;

  const unexpectedPage = (page: Page) => {
    if (acceptingEmployerPage && employerPage === null) {
      employerPage = page;
      return;
    }
    void page.close().catch(() => undefined);
    void input.onUnsafe("UNEXPECTED_POPUP");
  };
  input.context.on("page", unexpectedPage);

  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    input.context.off("page", unexpectedPage);
    await employerPage?.close().catch(() => undefined);
    employerPage = null;
  }

  return Object.freeze({
    async open(openInput: TargetOpenInput, assertActive: () => void): Promise<{ finalUrl: string }> {
      if (closed || employerPage) {
        throw new ApplicationBrowserError("The employer page is already open.", "TARGET_ALREADY_OPEN");
      }
      acceptingEmployerPage = true;
      const created = await input.context.newPage();
      acceptingEmployerPage = false;
      employerPage = created;
      if (await created.opener()) {
        await close();
        throw new ApplicationBrowserError("The employer page unexpectedly has an opener.", "TARGET_OPENER_PRESENT");
      }

      let navigationCount = 0;
      let navigationPhase: "INITIAL_CONVERGENCE" | "STEADY_TARGET" = "INITIAL_CONVERGENCE";
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
      const markUnsafe = () => {
        if (guardFailure) return;
        guardFailure = new ApplicationBrowserError(
          "Employer navigation was blocked before the request left Chromium.",
          "TARGET_NAVIGATION_BLOCKED"
        );
        void input.onUnsafe("TARGET_NAVIGATION_BLOCKED");
      };

      created.on("framenavigated", (frame) => {
        if (navigationPhase !== "STEADY_TARGET" || frame !== created.mainFrame()) return;
        if (!isCanonicalTarget(parseExecutionTargetUrl(frame.url()))) markUnsafe();
      });
      await created.route("**/*", async (route, request) => {
        if (
          !request.isNavigationRequest() ||
          request.resourceType() !== "document" ||
          request.frame() !== created.mainFrame()
        ) {
          await route.continue();
          return;
        }

        if (navigationPhase === "INITIAL_CONVERGENCE") navigationCount += 1;
        const candidate = parseExecutionTargetUrl(request.url());
        const valid =
          !guardFailure &&
          isAllowedAuthority(candidate) &&
          (navigationPhase === "STEADY_TARGET"
            ? isCanonicalTarget(candidate)
            : navigationCount <= 5 && (navigationCount > 1 || isCanonicalTarget(candidate)));
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
      });

      assertActive();
      try {
        await created.goto(openInput.target.url.toString(), { waitUntil: "domcontentloaded" });
      } catch {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        await close();
        if (guardFailure) throw guardFailure;
        throw new ApplicationBrowserError("Employer target navigation failed.", "TARGET_NAVIGATION_FAILED");
      }
      assertActive();
      if (guardFailure) {
        await close();
        throw guardFailure;
      }
      if (!isCanonicalTarget(parseExecutionTargetUrl(created.url()))) {
        await close();
        throw new ApplicationBrowserError(
          "The anonymous employer target could not be reached exactly.",
          "EMPLOYER_AUTH_REQUIRED_UNSUPPORTED"
        );
      }
      navigationPhase = "STEADY_TARGET";
      return { finalUrl: created.url() };
    },
    page: () => employerPage,
    close
  });
}
