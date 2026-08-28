import type { BrowserContext, Page, Request, Route } from "playwright";

import {
  isHostAllowedForExecution,
  parseExecutionTargetUrl,
  type ExecutionTarget
} from "@/lib/application-runs/host-policy";
import type {
  BrowserAutomationPolicy,
  SameOriginClient
} from "@/lib/application-browser/same-origin-client";
import type { B1Command, B1Status, B1WorkflowState } from "@/lib/application-browser/types";

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

type CoordinatorInput = {
  configuredApplyPilotOrigin: string;
  immutableRunId: string;
  client: SameOriginClient;
  openTarget(input: TargetOpenInput, assertActive: () => void): Promise<{ finalUrl: string }>;
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

export class ApplicationBrowserCoordinator {
  readonly configuredApplyPilotOrigin: string;
  readonly immutableRunId: string;
  readonly identity: Readonly<{ configuredApplyPilotOrigin: string; immutableRunId: string }>;
  private readonly input: CoordinatorInput;
  private workflowState: B1WorkflowState = "STARTING";
  private targetHost: string | undefined;
  private workflowErrorCode: string | undefined;
  private closePromise: Promise<void> | null = null;

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
      ...(this.workflowErrorCode ? { errorCode: this.workflowErrorCode } : {})
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
    if (this.workflowState !== "CONTROL_READY") {
      throw new ApplicationBrowserError("OPEN_TARGET is not allowed in this state.", "COMMAND_NOT_ALLOWED");
    }

    this.workflowState = "OPENING_TARGET";
    try {
      assertActive();
      const run = await this.input.client.getApplicationRun(this.immutableRunId);
      assertActive();
      if (run.id !== this.immutableRunId) {
        throw new ApplicationBrowserError("The run identity changed.", "RUN_IDENTITY_MISMATCH");
      }
      if (run.state !== "READY" && run.state !== "REVIEW_REQUIRED") {
        throw new ApplicationBrowserError("The application run is not ready to open.", "RUN_INVALID_STATE");
      }

      const policy = await this.input.client.getAutomationPolicy();
      assertActive();
      if (!policy.effectiveEnabled) {
        throw new ApplicationBrowserError("Application automation is disabled.", "AUTOMATION_DISABLED");
      }
      const target = parseExecutionTargetUrl(run.applyUrlSnapshot);
      if (!target || target.host !== run.applyHost) {
        throw new ApplicationBrowserError("The frozen application target is invalid.", "RUN_TARGET_INVALID");
      }
      if (!isHostAllowedForExecution(target.host, {
        allowedHosts: [...policy.allowedHosts],
        blockedHosts: [...policy.blockedHosts]
      })) {
        throw new ApplicationBrowserError("The frozen application host is not allowed.", "RUN_HOST_NOT_ALLOWED");
      }

      const opened = await this.input.openTarget({ target, policy }, assertActive);
      assertActive();
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
      this.targetHost = target.host;
      this.workflowState = "TARGET_OPEN";
      return this.status();
    } catch (error) {
      this.workflowState = "ERROR";
      this.workflowErrorCode = errorCode(error);
      throw error;
    }
  }

  async safeStop(code: string): Promise<void> {
    if (this.workflowState === "CLOSED") return;
    if (this.workflowState !== "ERROR") {
      this.workflowState = "ERROR";
      this.workflowErrorCode = code;
    }
    await this.input.closeResources();
    this.input.onClosed?.();
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closePromise = (async () => {
      await this.input.closeResources();
      this.workflowState = "CLOSED";
      this.input.onClosed?.();
    })();
    return this.closePromise;
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
