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
import { createSameOriginClient } from "@/lib/application-browser/same-origin-client";
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
  createClient: typeof createSameOriginClient;
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

export async function runApplicationBrowserCompanion(
  args: string[],
  dependencies: CompanionDependencies = productionDependencies
): Promise<void> {
  const identity = parseCompanionArguments(args);
  const runtime = await dependencies.launchRuntime();
  const context = runtime.context as BrowserContext;
  const controlPage = runtime.controlPage as Page;
  let targetController: ReturnType<typeof createPlaywrightTargetController> | null = null;
  let ownedEmployerPage: Page | null = null;
  let formInspectionController: ApplicationFormInspectionController | null = null;
  let formInspectionPort: FormInspectionPort | null = null;
  let closeOwnedResourcesPromise: Promise<void> | null = null;
  const closeOwnedResources = (): Promise<void> => {
    if (closeOwnedResourcesPromise) return closeOwnedResourcesPromise;
    closeOwnedResourcesPromise = (async () => {
      let firstError: unknown;
      try {
        await formInspectionController?.close();
      } catch (error) {
        firstError = error;
      }
      try {
        await targetController?.close();
      } catch (error) {
        firstError ??= error;
      }
      try {
        await runtime.close();
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
      requestContext: context.request
    });
    let resolveClosed: (() => void) | undefined;
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    const createdTargetController = dependencies.createTargetController({
      context,
      onUnsafe: async (code) => coordinator.safeStop(code)
    });
    targetController = createdTargetController;
    const coordinator = new ApplicationBrowserCoordinator({
      ...identity,
      client,
      openTarget: (target, assertActive) => createdTargetController.open(target, assertActive),
      initializeFormInspectionController: ({ authoritativeApplyHost }) => {
        if (ownedEmployerPage || formInspectionController || formInspectionPort) {
          throw new ApplicationBrowserError(
            "The form inspection controller is already initialized.",
            "BROWSER_WORKFLOW_FAILED"
          );
        }
        const page = createdTargetController.page();
        if (!page || page.isClosed()) {
          throw new ApplicationBrowserError(
            "The exact employer page is unavailable.",
            "TARGET_PAGE_CLOSED"
          );
        }
        ownedEmployerPage = page;
        const controller = dependencies.createFormInspectionController({
          page,
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
          currentTargetUrl() {
            if (
              !ownedEmployerPage ||
              createdTargetController.page() !== ownedEmployerPage ||
              ownedEmployerPage.isClosed()
            ) return null;
            return ownedEmployerPage.url();
          }
        });
      },
      getFormInspectionPort: () => formInspectionPort,
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
          dependencies.writeOutput(`Apply Pilot browser control ready for run ${identity.immutableRunId}.\n`);
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
    await installWhenTrusted();
    if (!bridgeInstalled) {
      coordinator.markApplyPilotAuthRequired();
      dependencies.writeOutput("Authenticate in the headed Apply Pilot window to continue.\n");
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
