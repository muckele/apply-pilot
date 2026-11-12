import { pathToFileURL } from "node:url";

import type { BrowserContext, Page } from "playwright";

import {
  launchApplicationBrowserRuntime,
  type ApplicationBrowserRuntime
} from "@/lib/application-browser/browser-runtime";
import { installControlBridge } from "@/lib/application-browser/control-bridge";
import {
  createApplicationFormInspectionController,
  type ApplicationFormInspectionController
} from "@/lib/application-browser/form-inspection-controller";
import {
  ApplicationBrowserError,
  ApplicationBrowserCoordinator,
  createPlaywrightTargetController,
  createSafeBrowserDiagnostic,
  type FormInspectionPort
} from "@/lib/application-browser/coordinator";
import {
  createSameOriginClient,
  type SameOriginClient
} from "@/lib/application-browser/same-origin-client";
import { parseApplyPilotOrigin, parseImmutableRunId } from "@/lib/application-browser/types";

export function parseCompanionArguments(args: string[]) {
  const values = new Map<string, string[]>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if ((name !== "--app-origin" && name !== "--run-id") || value === undefined) {
      throw new Error("Use --app-origin and --run-id exactly once each.");
    }
    values.set(name, [...(values.get(name) ?? []), value]);
  }
  if (values.get("--app-origin")?.length !== 1 || values.get("--run-id")?.length !== 1) {
    throw new Error("Use --app-origin and --run-id exactly once each.");
  }
  return Object.freeze({
    configuredApplyPilotOrigin: parseApplyPilotOrigin(values.get("--app-origin")?.[0]),
    immutableRunId: parseImmutableRunId(values.get("--run-id")?.[0])
  });
}

type CompanionDependencies = Readonly<{
  launchRuntime(): Promise<ApplicationBrowserRuntime>;
  createClient(input: Parameters<typeof createSameOriginClient>[0]): SameOriginClient;
  createTargetController: typeof createPlaywrightTargetController;
  createFormInspectionController: typeof createApplicationFormInspectionController;
  installBridge: typeof installControlBridge;
  writeOutput(message: string): void;
}>;

const productionDependencies: CompanionDependencies = {
  launchRuntime: launchApplicationBrowserRuntime,
  createClient: createSameOriginClient,
  createTargetController: createPlaywrightTargetController,
  createFormInspectionController: createApplicationFormInspectionController,
  installBridge: installControlBridge,
  writeOutput(message) {
    process.stdout.write(message);
  }
};

function startupErrorCode(error: unknown): string {
  return error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : "COMPANION_START_FAILED";
}

// Plain next steps for the person at the terminal. They never include the
// origin, cookies, codes or any other secret; the run ID is the user's own.
const START_MESSAGE =
  "Starting the Apply Pilot browser. Look for a new window titled \"Apply Pilot browser\" " +
  "(in the Dock it shows as \"Google Chrome for Testing\"). " +
  "If you can't see it, check behind other windows or on your other desktops.\n";
const SIGN_IN_MESSAGE =
  "Sign in the Apply Pilot browser with the one-time code from step 5 of this job's Apply page " +
  "in your usual browser. Google sign-in doesn't work in that window.\n";
function connectedMessage(runId: string): string {
  return `The Apply Pilot browser is connected (run ${runId}). Continue in that window.\n`;
}

/**
 * Best-effort: asks Chromium to raise the Apply Pilot control window so the
 * user can find it. This is presentation only. It is never awaited and every
 * failure is ignored, so it cannot delay, stop or change the workflow. It acts
 * on the control page only, never on the employer page.
 */
function bringControlWindowForward(controlPage: Pick<Page, "bringToFront">): void {
  try {
    void Promise.resolve(controlPage.bringToFront()).catch(() => undefined);
  } catch {
    // Window activation is optional; the terminal says where to look.
  }
}

const OWNED_CLEANUP_DEADLINE_MS = 10_000;

function boundedOwnedCleanup(cleanup: () => Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    cleanup(),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new ApplicationBrowserError(
        "Exact-owned browser cleanup did not settle.", "HUMAN_SESSION_CLEANUP_UNCERTAIN"
      )), OWNED_CLEANUP_DEADLINE_MS);
    })
  ]).finally(() => { if (timer) clearTimeout(timer); });
}

export async function runApplicationBrowserCompanion(
  args: string[],
  dependencies: CompanionDependencies = productionDependencies
): Promise<void> {
  const identity = parseCompanionArguments(args);
  dependencies.writeOutput(START_MESSAGE);
  const runtime = await dependencies.launchRuntime();
  const controlContext = runtime.context as BrowserContext;
  const employerContext = runtime.employerContext as BrowserContext;
  const controlPage = runtime.controlPage as Page;
  let targetController: ReturnType<typeof createPlaywrightTargetController> | null = null;
  let formInspectionController: ApplicationFormInspectionController | null = null;
  let formInspectionPort: FormInspectionPort | null = null;
  let closeOwnedResourcesPromise: Promise<void> | null = null;
  const closeOwnedResources = (): Promise<void> => {
    if (closeOwnedResourcesPromise) return closeOwnedResourcesPromise;
    closeOwnedResourcesPromise = (async () => {
      let firstError: unknown;
      try {
        await boundedOwnedCleanup(async () => formInspectionController?.close());
      } catch (error) {
        firstError = error;
      }
      try {
        await boundedOwnedCleanup(async () => targetController?.close());
      } catch (error) {
        firstError ??= error;
      }
      try {
        await boundedOwnedCleanup(() => runtime.close());
      } catch (error) {
        firstError ??= error;
      }
      if (firstError !== undefined) throw firstError;
    })();
    return closeOwnedResourcesPromise;
  };
  let interrupt: (() => void) | null = null;

  try {
    const client = dependencies.createClient({
      configuredApplyPilotOrigin: identity.configuredApplyPilotOrigin,
      immutableRunId: identity.immutableRunId,
      requestContext: controlContext.request
    });
    let resolveClosed: (() => void) | undefined;
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    const createdTargetController = dependencies.createTargetController({
      context: employerContext,
      onUnsafe: async (code) => coordinator.safeStop(code)
    });
    targetController = createdTargetController;
    const coordinator = new ApplicationBrowserCoordinator({
      ...identity,
      client,
      openTarget: (target, assertActive) => createdTargetController.open(target, assertActive),
      initializeFormInspectionController: ({ authoritativeApplyHost }) => {
        if (formInspectionController || formInspectionPort) {
          throw new ApplicationBrowserError(
            "The form inspection controller is already initialized.",
            "BROWSER_WORKFLOW_FAILED"
          );
        }
        const target = createdTargetController.formInspectionTarget();
        if (!target) {
          throw new ApplicationBrowserError(
            "The protected form inspection target is unavailable.",
            "BROWSER_WORKFLOW_FAILED"
          );
        }
        const controller = dependencies.createFormInspectionController({
          target,
          authoritativeApplyHost,
          onInvalidated: (code) => {
            void coordinator.handleFormInspectionInvalidation(code);
          }
        });
        formInspectionController = controller;
        formInspectionPort = Object.freeze({
          async inspect() {
            const generation = await controller.inspect();
            return Object.freeze({
              generationId: generation.generationId,
              inspectionReport: generation.inspectionReport
            });
          },
          async assertCurrent(generationId: symbol) {
            const generation = await controller.assertCurrent(generationId);
            return Object.freeze({
              generationId: generation.generationId,
              inspectionReport: generation.inspectionReport
            });
          },
          assertAcquiredFillAuthority(generationId, authority) {
            controller.assertAcquiredFillAuthority(generationId, authority);
          },
          writeApprovedField(generationId, request) {
            return controller.writeApprovedField(generationId, request);
          },
          currentTargetUrl() {
            if (createdTargetController.formInspectionTarget() !== target) return null;
            return target.currentTargetUrl();
          }
        });
      },
      getFormInspectionPort: () => formInspectionPort,
      retireForHuman: async (assertActive) => {
        await formInspectionController?.close();
        formInspectionPort = null;
        assertActive();
        await createdTargetController.retireForHuman(identity.configuredApplyPilotOrigin, assertActive);
      },
      closeResources: closeOwnedResources,
      onClosed: resolveClosed
    });

    const trustedUrl = `${identity.configuredApplyPilotOrigin}/application-runs/${identity.immutableRunId}/browser`;
    let bridgeInstalled = false;
    let installPromise: Promise<void> | null = null;
    let terminalInstallError: unknown;
    const installWhenTrusted = () => {
      if (terminalInstallError !== undefined) return Promise.reject(terminalInstallError);
      if (bridgeInstalled || controlPage.url() !== trustedUrl) return Promise.resolve();
      if (installPromise) return installPromise;
      installPromise = (async () => {
        try {
          const run = await client.getApplicationRun(identity.immutableRunId);
          if (run.id !== identity.immutableRunId) {
            throw new ApplicationBrowserError(
              "The authorized control run identity changed.",
              "RUN_IDENTITY_MISMATCH"
            );
          }
          await dependencies.installBridge({
            controlPage,
            ...identity,
            getState: () => coordinator.state(),
            execute: (command, assertActive) => coordinator.handleCommand(command, assertActive),
            onTrustLost: (code) => coordinator.safeStop(code)
          });
          bridgeInstalled = true;
          coordinator.markControlReady();
          bringControlWindowForward(controlPage);
          dependencies.writeOutput(connectedMessage(identity.immutableRunId));
        } catch (error) {
          const code = startupErrorCode(error);
          if (code === "APPLY_PILOT_AUTH_REQUIRED") {
            coordinator.markApplyPilotAuthRequired();
            return;
          }
          terminalInstallError = error;
          await coordinator.safeStop(code);
          throw error;
        } finally {
          installPromise = null;
        }
      })();
      return installPromise;
    };

    controlPage.on("framenavigated", (frame) => {
      if (frame !== controlPage.mainFrame() || bridgeInstalled) return;
      void installWhenTrusted().catch(() => undefined);
    });
    await controlPage.goto(trustedUrl, { waitUntil: "domcontentloaded" });
    bringControlWindowForward(controlPage);
    await installWhenTrusted();
    if (!bridgeInstalled) {
      coordinator.markApplyPilotAuthRequired();
      dependencies.writeOutput(SIGN_IN_MESSAGE);
    }

    interrupt = () => {
      void coordinator.close();
    };
    process.once("SIGINT", interrupt);
    process.once("SIGTERM", interrupt);
    await closed;
  } finally {
    if (interrupt) {
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", interrupt);
    }
    await closeOwnedResources();
  }
}

const entryPoint = process.argv[1];
if (entryPoint && import.meta.url === pathToFileURL(entryPoint).href) {
  runApplicationBrowserCompanion(process.argv.slice(2)).catch((error: unknown) => {
    const code = error instanceof Error && "code" in error && typeof error.code === "string"
      ? error.code
      : "COMPANION_START_FAILED";
    const diagnostic = createSafeBrowserDiagnostic({
      runId: "unavailable",
      state: "ERROR",
      operation: "START",
      code
    });
    const safeMessage = error instanceof Error && error.message === "Apply Pilot Chromium is not installed. Run: npm run browser:install"
      ? error.message
      : `Apply Pilot browser companion stopped safely (${code}).`;
    process.stderr.write(`${safeMessage}\n`);
    process.stderr.write(`${JSON.stringify(diagnostic)}\n`);
    process.exitCode = 1;
  });
}
