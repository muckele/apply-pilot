import assert from "node:assert/strict";
import { test } from "node:test";

import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

import type { ApplicationBrowserRuntime } from "@/lib/application-browser/browser-runtime";
import { MISSING_CHROMIUM_MESSAGE } from "@/lib/application-browser/browser-runtime";
import { installControlBridge } from "@/lib/application-browser/control-bridge";
import { createPlaywrightTargetController } from "@/lib/application-browser/coordinator";
import {
  createApplicationFormInspectionController,
  type ApplicationFormInspectionController
} from "@/lib/application-browser/form-inspection-controller";
import { createSameOriginClient } from "@/lib/application-browser/same-origin-client";
import {
  APPLICATION_BROWSER_BINDING_NAME,
  type B1Command,
  type B1Status
} from "@/lib/application-browser/types";
import { runApplicationBrowserCompanion } from "@/scripts/application-browser-companion";
import {
  BROWSER_SMOKE_RUN_ID,
  SYNTHETIC_EMPLOYER_URL,
  startBrowserFixtureServers,
  syntheticEmployerHtml
} from "@/tests/browser/fixture-server";

const CURRENT_APPLICANT_SENTINEL = "SECRET-INTEGRATED-CURRENT-APPLICANT-VALUE";
const TRUSTED_PATH = `/application-runs/${BROWSER_SMOKE_RUN_ID}/browser`;
const PACKET_HASH = "b".repeat(64);
const NORMALIZED_FIELD_KEY = "1".repeat(64);
const LOCAL_SETTLEMENT_TIMEOUT_MS = 5_000;

type BindingWindow = Window & {
  __applyPilotB1Command?: (command: B1Command) => Promise<B1Status>;
};

type PublicationRequest = Readonly<{
  ordinal: number;
  path: string;
  contentType: string;
  rawBody: string;
  parsedBody: Record<string, unknown>;
  disposition: "MATERIAL" | "REPLAY";
}>;

type HeldPacketRead = Readonly<{ ordinal: number; path: string }>;

type IntegrationFixtures = Awaited<ReturnType<typeof startBrowserFixtureServers>> & Readonly<{
  publicationRequests(): PublicationRequest[];
  publicationHits(): number;
  coordinatorPacketReadGateActive(): boolean;
  holdNextCoordinatorPacketRead(): void;
  waitForHeldCoordinatorPacketRead(): Promise<HeldPacketRead>;
  releaseHeldCoordinatorPacketRead(): void;
}>;

type TrapSnapshot = Readonly<{
  phase: "DISARMED";
  currentValueReads: Readonly<{
    input: number;
    textarea: number;
    select: number;
    checked: number;
    selected: number;
    files: number;
  }>;
  writes: Readonly<{
    value: number;
    checked: number;
    selected: number;
    files: number;
  }>;
  events: Readonly<{
    click: number;
    keydown: number;
    beforeinput: number;
    input: number;
    change: number;
    focusin: number;
    submit: number;
    formdata: number;
  }>;
  totalObservedMutations: number;
  expectedHarnessMutations: number;
  sentinel: string;
}>;

type SemanticMutationProof = Readonly<{
  inputConnected: boolean;
  labelConnected: boolean;
  labelControlsInput: boolean;
  inputNestingPreserved: boolean;
  visibleTextChanged: boolean;
}>;

type CompanionDependencies = NonNullable<
  Parameters<typeof runApplicationBrowserCompanion>[1]
>;

type CoordinatorExecute = (
  command: B1Command,
  assertActive: () => void
) => Promise<B1Status>;

type ObservedInspectionExecution = Readonly<{
  promise: Promise<B1Status>;
}>;

type CleanupStep = Readonly<{
  label: string;
  run(): void | Promise<void>;
}>;

type Workflow = Readonly<{
  browser: Browser;
  context: BrowserContext;
  controlPage: Page;
  fixtures: IntegrationFixtures;
  targetController(): ReturnType<typeof createPlaywrightTargetController> | null;
  companionSettled(): boolean;
  companionOutcome: Promise<PromiseSettledResult<void>>;
  waitForNextInspectionExecution(): Promise<ObservedInspectionExecution>;
  directExecutorInvocations(): readonly B1Command[];
  cleanup(primaryError?: unknown): Promise<void>;
}>;

type CapturedCloseExecutionTransform = (execution: Promise<B1Status>) => Promise<B1Status>;

function integrationEmployerHtml(mutationUrl: string): string {
  const baseHtml = syntheticEmployerHtml(mutationUrl);
  return baseHtml.replace("</body>", `
    <script>
      (() => {
        const phase = { current: "INSTALLING" };
        const reads = { input: 0, textarea: 0, select: 0, checked: 0, selected: 0, files: 0 };
        const writes = { value: 0, checked: 0, selected: 0, files: 0 };
        const events = {
          click: 0,
          keydown: 0,
          beforeinput: 0,
          input: 0,
          change: 0,
          focusin: 0,
          submit: 0,
          formdata: 0
        };
        let totalObservedMutations = 0;
        let expectedHarnessMutations = 0;
        const armed = () => phase.current === "ARMED";
        const wrapProperty = (prototype, property, readKey, writeKey) => {
          const descriptor = Object.getOwnPropertyDescriptor(prototype, property);
          if (!descriptor || typeof descriptor.get !== "function") return null;
          Object.defineProperty(prototype, property, {
            ...descriptor,
            get() {
              if (armed()) reads[readKey] += 1;
              return descriptor.get.call(this);
            },
            ...(typeof descriptor.set === "function" ? {
              set(value) {
                if (armed()) writes[writeKey] += 1;
                return descriptor.set.call(this, value);
              }
            } : {})
          });
          return descriptor;
        };
        const inputValue = wrapProperty(HTMLInputElement.prototype, "value", "input", "value");
        wrapProperty(HTMLTextAreaElement.prototype, "value", "textarea", "value");
        wrapProperty(HTMLSelectElement.prototype, "value", "select", "value");
        wrapProperty(HTMLInputElement.prototype, "checked", "checked", "checked");
        wrapProperty(HTMLOptionElement.prototype, "selected", "selected", "selected");
        wrapProperty(HTMLInputElement.prototype, "files", "files", "files");
        for (const name of Object.keys(events)) {
          document.addEventListener(name, () => {
            if (armed()) events[name] += 1;
          }, true);
        }
        const observer = new MutationObserver((records) => {
          if (armed()) totalObservedMutations += records.length;
        });
        observer.observe(document, {
          subtree: true,
          childList: true,
          characterData: true,
          attributes: true
        });
        const sentinelField = document.getElementById("name");
        if (!(sentinelField instanceof HTMLInputElement) || !inputValue?.set || !inputValue.get) {
          throw new Error("Integration sentinel field is unavailable.");
        }
        phase.current = "DISARMED";
        inputValue.set.call(sentinelField, ${JSON.stringify(CURRENT_APPLICANT_SENTINEL)});
        observer.takeRecords();
        const reset = () => {
          for (const key of Object.keys(reads)) reads[key] = 0;
          for (const key of Object.keys(writes)) writes[key] = 0;
          for (const key of Object.keys(events)) events[key] = 0;
          totalObservedMutations = 0;
          expectedHarnessMutations = 0;
        };
        reset();
        window.__applyPilotIntegrationTrap = {
          arm() {
            observer.takeRecords();
            reset();
            phase.current = "ARMED";
          },
          recordExpectedHarnessMutation() {
            expectedHarnessMutations += 1;
          },
          disarmAndSnapshot() {
            phase.current = "DISARMED";
            totalObservedMutations += observer.takeRecords().length;
            return {
              phase: phase.current,
              currentValueReads: { ...reads },
              writes: { ...writes },
              events: { ...events },
              totalObservedMutations,
              expectedHarnessMutations,
              sentinel: inputValue.get.call(sentinelField)
            };
          }
        };
      })();
    </script>
  </body>`);
}

async function launchSmokeBrowser(): Promise<Browser> {
  try {
    return await chromium.launch({ headless: true });
  } catch (error) {
    if (
      error instanceof Error &&
      /executable.*(doesn'?t exist|missing|not found)|playwright install/i.test(error.message)
    ) {
      throw new Error(MISSING_CHROMIUM_MESSAGE);
    }
    throw error;
  }
}

async function mutateIntegrationLabel(page: Page): Promise<SemanticMutationProof> {
  return page.evaluate(() => {
    const trap = (window as typeof window & {
      __applyPilotIntegrationTrap?: { recordExpectedHarnessMutation(): void };
    }).__applyPilotIntegrationTrap;
    trap?.recordExpectedHarnessMutation();
    const label = document.querySelector("label");
    const input = label?.querySelector("input");
    if (!(label instanceof HTMLLabelElement) || !(input instanceof HTMLInputElement)) {
      throw new Error("Integration label and field are unavailable.");
    }
    const acceptedText = label.textContent;
    const acceptedParent = input.parentElement;
    const textNode = label.firstChild;
    if (!(textNode instanceof Text)) {
      throw new Error("Integration label text node is unavailable.");
    }
    textNode.data = "Full legal name ";
    return {
      inputConnected: input.isConnected,
      labelConnected: label.isConnected,
      labelControlsInput: label.control === input,
      inputNestingPreserved: input.parentElement === acceptedParent && acceptedParent === label,
      visibleTextChanged: label.textContent !== acceptedText
    };
  });
}

function assertSemanticMutationPreservesField(proof: SemanticMutationProof): void {
  assert.deepEqual(proof, {
    inputConnected: true,
    labelConnected: true,
    labelControlsInput: true,
    inputNestingPreserved: true,
    visibleTextChanged: true
  });
}

async function waitFor<T>(
  description: string,
  read: () => T | Promise<T>,
  accept: (value: T) => boolean = Boolean,
  timeoutMs = 5_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (!accept(value) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    value = await read();
  }
  assert.equal(accept(value), true, `Timed out waiting for ${description}.`);
  return value;
}

async function runCleanupSteps(
  primaryError: unknown | undefined,
  steps: readonly CleanupStep[],
  onAttempt?: (label: string) => void
): Promise<void> {
  const cleanupErrors: unknown[] = [];
  const failedLabels: string[] = [];
  for (const step of steps) {
    onAttempt?.(step.label);
    try {
      await step.run();
    } catch (error) {
      cleanupErrors.push(error);
      failedLabels.push(step.label);
    }
  }

  if (primaryError !== undefined) {
    if (cleanupErrors.length === 0) throw primaryError;
    throw new AggregateError(
      [primaryError, ...cleanupErrors],
      `Primary test failure was followed by cleanup failure(s): ${failedLabels.join(", ")}.`
    );
  }
  if (cleanupErrors.length === 1) throw cleanupErrors[0];
  if (cleanupErrors.length > 1) {
    throw new AggregateError(cleanupErrors, `Cleanup failed in: ${failedLabels.join(", ")}.`);
  }
}

async function settleWithin<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out settling ${label}.`)), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function invoke(page: Page, command: B1Command): Promise<B1Status> {
  return page.evaluate(
    async ({ bindingName, value }) => {
      const binding = (window as BindingWindow)[bindingName as typeof APPLICATION_BROWSER_BINDING_NAME];
      if (!binding) throw new Error("binding absent");
      return binding(value);
    },
    { bindingName: APPLICATION_BROWSER_BINDING_NAME, value: command }
  );
}

function observe<T>(promise: Promise<T>): Promise<PromiseSettledResult<T>> {
  return promise.then(
    (value) => ({ status: "fulfilled", value }),
    (reason: unknown) => ({ status: "rejected", reason })
  );
}

async function createWorkflow(input: {
  mutateBeforeAssertCurrent?: boolean;
  failAt?: "AFTER_FIXTURES" | "AFTER_BRIDGE";
  armHeldPacketReadBeforeFailure?: boolean;
  setupFailure?: Error;
  closeSettlementTimeoutMs?: number;
  testOnlyTransformCapturedCloseExecution?: CapturedCloseExecutionTransform;
  onCleanupStepAttempt?(label: string): void;
  onFixturesAcquired?(fixtures: IntegrationFixtures): void;
  onBrowserAcquired?(browser: Browser): void;
  onCompanionStarted?(input: Readonly<{
    controlPage: Page;
    companionOutcome: Promise<PromiseSettledResult<void>>;
  }>): void;
} = {}): Promise<Workflow> {
  const closeSettlementTimeoutMs = input.closeSettlementTimeoutMs ?? LOCAL_SETTLEMENT_TIMEOUT_MS;
  const companionSignalBaseline = {
    sigint: process.listenerCount("SIGINT"),
    sigterm: process.listenerCount("SIGTERM")
  };
  let fixtures: IntegrationFixtures | undefined;
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let controlPage: Page | undefined;
  let companionOutcome: Promise<PromiseSettledResult<void>> | undefined;
  let runtimeClosed = false;
  let capturedTargetController: ReturnType<typeof createPlaywrightTargetController> | null = null;
  let capturedExecute: CoordinatorExecute | null = null;
  let companionSettled = false;
  let directExecutorCleanupActive = false;
  const directExecutorInvocations: B1Command[] = [];
  const queuedInspectionExecutions: ObservedInspectionExecution[] = [];
  const inspectionExecutionWaiters: Array<(execution: ObservedInspectionExecution) => void> = [];
  const queuedCloseExecutions: ObservedInspectionExecution[] = [];
  const closeExecutionWaiters: Array<(execution: ObservedInspectionExecution) => void> = [];

  const recordInspectionExecution = (promise: Promise<B1Status>): void => {
    const execution = Object.freeze({ promise });
    const waiter = inspectionExecutionWaiters.shift();
    if (waiter) waiter(execution);
    else queuedInspectionExecutions.push(execution);
  };

  const waitForNextInspectionExecution = (): Promise<ObservedInspectionExecution> => {
    const queued = queuedInspectionExecutions.shift();
    if (queued) return Promise.resolve(queued);
    return settleWithin(
      new Promise<ObservedInspectionExecution>((resolve) => inspectionExecutionWaiters.push(resolve)),
      LOCAL_SETTLEMENT_TIMEOUT_MS,
      "page-binding INSPECT_FORM delegate observation"
    );
  };

  const recordCloseExecution = (promise: Promise<B1Status>): void => {
    const execution = Object.freeze({ promise });
    const waiter = closeExecutionWaiters.shift();
    if (waiter) waiter(execution);
    else queuedCloseExecutions.push(execution);
  };

  const waitForNextCloseExecution = (): Promise<ObservedInspectionExecution> => {
    const queued = queuedCloseExecutions.shift();
    if (queued) return Promise.resolve(queued);
    return settleWithin(
      new Promise<ObservedInspectionExecution>((resolve) => closeExecutionWaiters.push(resolve)),
      closeSettlementTimeoutMs,
      "page-binding CLOSE_WORKFLOW delegate observation"
    );
  };

  const cleanup = async (primaryError?: unknown): Promise<void> => {
    await runCleanupSteps(primaryError, [
      {
        label: "held packet-read release",
        run() {
          fixtures?.releaseHeldCoordinatorPacketRead();
        }
      },
      {
        label: "companion close request",
        async run() {
          if (!companionOutcome || companionSettled) return;
          const bindingUsable = Boolean(
            fixtures &&
            controlPage &&
            !controlPage.isClosed() &&
            controlPage.url() === `${fixtures.controlOrigin}${TRUSTED_PATH}` &&
            await controlPage.evaluate(
              (name) => typeof (window as unknown as Record<string, unknown>)[name] === "function",
              APPLICATION_BROWSER_BINDING_NAME
            ).catch(() => false)
          );
          if (bindingUsable && controlPage) {
            const nextCloseExecution = waitForNextCloseExecution();
            void observe(invoke(controlPage, { type: "CLOSE_WORKFLOW" }));
            const execution = await nextCloseExecution;
            await settleWithin(
              execution.promise,
              closeSettlementTimeoutMs,
              "application browser companion close request"
            );
            return;
          }
          if (!capturedExecute) return;
          assert.equal(bindingUsable, false);
          directExecutorCleanupActive = true;
          const command = Object.freeze({ type: "CLOSE_WORKFLOW" }) as B1Command;
          directExecutorInvocations.push(command);
          try {
            assert.equal(directExecutorCleanupActive, true);
            assert.deepEqual(command, { type: "CLOSE_WORKFLOW" });
            const execution = capturedExecute(command, () => undefined);
            await settleWithin(
              input.testOnlyTransformCapturedCloseExecution?.(execution) ?? execution,
              closeSettlementTimeoutMs,
              "application browser companion close request"
            );
          } finally {
            directExecutorCleanupActive = false;
          }
        }
      },
      {
        label: "browser context close",
        async run() {
          await context?.close();
        }
      },
      {
        label: "companion settlement",
        async run() {
          if (!companionOutcome) return;
          const outcome = await settleWithin(
            companionOutcome,
            LOCAL_SETTLEMENT_TIMEOUT_MS,
            "application browser companion"
          );
          if (outcome.status === "rejected") throw outcome.reason;
        }
      },
      {
        label: "browser close",
        async run() {
          await browser?.close();
        }
      },
      {
        label: "fixture server close",
        async run() {
          await fixtures?.close();
        }
      },
      {
        label: "captured executor boundary assertion",
        run() {
          assert.equal(directExecutorCleanupActive, false);
          for (const command of directExecutorInvocations) {
            assert.deepEqual(command, { type: "CLOSE_WORKFLOW" });
          }
        }
      }
    ], input.onCleanupStepAttempt);
  };

  try {
    fixtures = await startBrowserFixtureServers() as IntegrationFixtures;
    input.onFixturesAcquired?.(fixtures);
    if (input.failAt === "AFTER_FIXTURES") throw input.setupFailure ?? new Error("Injected setup failure.");
    browser = await launchSmokeBrowser();
    input.onBrowserAcquired?.(browser);
    context = await browser.newContext();
    controlPage = await context.newPage();
    const acquiredFixtures = fixtures;
    const acquiredBrowser = browser;
    const acquiredContext = context;
    const acquiredControlPage = controlPage;

    const dependencies: CompanionDependencies = {
      async launchRuntime(): Promise<ApplicationBrowserRuntime> {
        return {
          browser: acquiredBrowser,
          context: acquiredContext,
          controlPage: acquiredControlPage,
          async close() {
            if (runtimeClosed) return;
            runtimeClosed = true;
            await acquiredControlPage.close().catch(() => undefined);
            await acquiredContext.close().catch(() => undefined);
          }
        };
      },
      createClient: createSameOriginClient,
      createTargetController(targetInput) {
        assert.equal(targetInput.context, acquiredContext);
        assert.equal(typeof targetInput.onUnsafe, "function");
        const expectedRequestUrl = new URL(SYNTHETIC_EMPLOYER_URL);
        expectedRequestUrl.hash = "";
        const controller = createPlaywrightTargetController({
          ...targetInput,
          testOnlyFulfillMainDocument: async (request, route) => {
            assert.equal(request.url(), expectedRequestUrl.toString());
            assert.equal(request.isNavigationRequest(), true);
            assert.equal(request.resourceType(), "document");
            await route.fulfill({
              status: 200,
              contentType: "text/html; charset=utf-8",
              body: integrationEmployerHtml(acquiredFixtures.mutationUrl)
            });
          }
        });
        capturedTargetController = controller;
        return controller;
      },
      createFormInspectionController(controllerInput) {
        const controller = createApplicationFormInspectionController(controllerInput);
        if (!input.mutateBeforeAssertCurrent) return controller;
        return {
          ...controller,
          async assertCurrent(generationId, options) {
            assert.equal(acquiredFixtures.publicationHits(), 0);
            assertSemanticMutationPreservesField(await mutateIntegrationLabel(controllerInput.page));
            assert.equal(acquiredFixtures.publicationHits(), 0);
            return controller.assertCurrent(generationId, options);
          }
        } satisfies ApplicationFormInspectionController;
      },
      async installBridge(bridgeInput) {
        capturedExecute = bridgeInput.execute;
        return installControlBridge({
          ...bridgeInput,
          execute(command, assertActive) {
            const result = bridgeInput.execute(command, assertActive);
            if (command.type === "INSPECT_FORM") recordInspectionExecution(result);
            if (command.type === "CLOSE_WORKFLOW") recordCloseExecution(result);
            return result;
          }
        });
      },
      writeOutput() {}
    };

    const companion = runApplicationBrowserCompanion(
      ["--app-origin", acquiredFixtures.controlOrigin, "--run-id", BROWSER_SMOKE_RUN_ID],
      dependencies
    );
    companionOutcome = companion.then(
      (): PromiseSettledResult<void> => {
        companionSettled = true;
        return { status: "fulfilled", value: undefined };
      },
      (reason: unknown): PromiseSettledResult<void> => {
        companionSettled = true;
        return { status: "rejected", reason };
      }
    );
    input.onCompanionStarted?.({ controlPage: acquiredControlPage, companionOutcome });

    await waitFor(
      "the real control binding",
      () => acquiredControlPage.isClosed()
        ? "closed"
        : acquiredControlPage.evaluate(
          (name) => typeof (window as unknown as Record<string, unknown>)[name],
          APPLICATION_BROWSER_BINDING_NAME
        ).catch(() => "absent"),
      (value) => value === "function"
    );
    assert.deepEqual(await invoke(acquiredControlPage, { type: "GET_STATUS" }), {
      state: "CONTROL_READY",
      runId: BROWSER_SMOKE_RUN_ID
    });
    if (input.failAt === "AFTER_BRIDGE") {
      await waitFor(
        "the companion signal listeners before injected setup failure",
        () => ({
          sigint: process.listenerCount("SIGINT"),
          sigterm: process.listenerCount("SIGTERM")
        }),
        (counts) =>
          counts.sigint > companionSignalBaseline.sigint &&
          counts.sigterm > companionSignalBaseline.sigterm
      );
      if (input.armHeldPacketReadBeforeFailure) acquiredFixtures.holdNextCoordinatorPacketRead();
      throw input.setupFailure ?? new Error("Injected setup failure.");
    }

    return {
      browser: acquiredBrowser,
      context: acquiredContext,
      controlPage: acquiredControlPage,
      fixtures: acquiredFixtures,
      targetController: () => capturedTargetController,
      companionSettled: () => companionSettled,
      companionOutcome,
      waitForNextInspectionExecution,
      directExecutorInvocations: () => directExecutorInvocations.slice(),
      cleanup
    };
  } catch (error) {
    await cleanup(error);
    throw error;
  }
}

async function disposeWorkflow(workflow: Workflow | undefined, primaryError?: unknown): Promise<void> {
  if (!workflow) {
    if (primaryError !== undefined) throw primaryError;
    return;
  }
  await workflow.cleanup(primaryError);
}

async function withWorkflow<T>(
  input: Parameters<typeof createWorkflow>[0],
  run: (workflow: Workflow) => Promise<T>
): Promise<T> {
  let workflow: Workflow | undefined;
  let primaryError: unknown;
  let result: T | undefined;
  try {
    workflow = await createWorkflow(input);
    result = await run(workflow);
  } catch (error) {
    primaryError = error;
  }
  await disposeWorkflow(workflow, primaryError);
  return result as T;
}

async function openAndArm(workflow: Workflow): Promise<Page> {
  assert.deepEqual(await invoke(workflow.controlPage, { type: "OPEN_TARGET" }), {
    state: "TARGET_OPEN",
    runId: BROWSER_SMOKE_RUN_ID,
    targetHost: "employer.example.test"
  });
  const employerPage = workflow.targetController()?.page();
  assert.ok(employerPage);
  assert.equal(await employerPage.opener(), null);
  assert.equal(
    await employerPage.evaluate(
      (name) => typeof (window as unknown as Record<string, unknown>)[name],
      APPLICATION_BROWSER_BINDING_NAME
    ),
    "undefined"
  );
  await employerPage.evaluate(() => {
    const trap = (window as typeof window & {
      __applyPilotIntegrationTrap?: { arm(): void };
    }).__applyPilotIntegrationTrap;
    if (!trap) throw new Error("Integration trap is unavailable.");
    trap.arm();
  });
  return employerPage;
}

async function trapSnapshot(employerPage: Page): Promise<TrapSnapshot> {
  return employerPage.evaluate(() => {
    const trap = (window as typeof window & {
      __applyPilotIntegrationTrap?: { disarmAndSnapshot(): TrapSnapshot };
    }).__applyPilotIntegrationTrap;
    if (!trap) throw new Error("Integration trap is unavailable.");
    return trap.disarmAndSnapshot();
  });
}

function assertExactKeys(value: unknown, expected: string[]): asserts value is Record<string, unknown> {
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  assert.equal(Array.isArray(value), false);
  assert.deepEqual(Object.keys(value as Record<string, unknown>).sort(), [...expected].sort());
}

function assertSuccessfulBindingResult(
  value: B1Status,
  replayed: boolean
): asserts value is B1Status & { inspection: Record<string, unknown> } {
  assertExactKeys(value, ["inspection", "runId", "state", "targetHost"]);
  assert.equal(value.state, "TARGET_OPEN");
  assert.equal(value.runId, BROWSER_SMOKE_RUN_ID);
  assert.equal(value.targetHost, "employer.example.test");
  assertExactKeys(value.inspection, [
    "answerPacketVersion",
    "inspectionVersion",
    "outcome",
    "reinspectionRequired",
    "replayed"
  ]);
  assert.deepEqual(value.inspection, {
    outcome: "SUCCEEDED",
    replayed,
    inspectionVersion: 1,
    answerPacketVersion: 1,
    reinspectionRequired: false
  });
}

function assertReinspectionBindingResult(value: B1Status): void {
  assertExactKeys(value, ["inspection", "runId", "state", "targetHost"]);
  assert.equal(value.state, "TARGET_OPEN");
  assertExactKeys(value.inspection, ["errorCode", "outcome", "retryAllowed"]);
  assert.deepEqual(value.inspection, {
    outcome: "REINSPECTION_REQUIRED",
    errorCode: "FORM_GENERATION_INVALIDATED",
    retryAllowed: true
  });
}

function assertNoEmployerAuthority(snapshot: TrapSnapshot, expectedHarnessMutations = 0): void {
  assert.deepEqual(snapshot.currentValueReads, {
    input: 0,
    textarea: 0,
    select: 0,
    checked: 0,
    selected: 0,
    files: 0
  });
  assert.deepEqual(snapshot.writes, { value: 0, checked: 0, selected: 0, files: 0 });
  assert.deepEqual(snapshot.events, {
    click: 0,
    keydown: 0,
    beforeinput: 0,
    input: 0,
    change: 0,
    focusin: 0,
    submit: 0,
    formdata: 0
  });
  assert.equal(snapshot.expectedHarnessMutations, expectedHarnessMutations);
  assert.equal(snapshot.totalObservedMutations - snapshot.expectedHarnessMutations, 0);
  assert.equal(snapshot.sentinel, CURRENT_APPLICANT_SENTINEL);
}

function assertSentinelAbsentFromEveryPublication(requests: readonly PublicationRequest[]): void {
  assert.equal(
    requests.some((request) => request.rawBody.includes(CURRENT_APPLICANT_SENTINEL)),
    false
  );
}

async function assertFixtureListenersUnreachable(fixtures: IntegrationFixtures): Promise<void> {
  const [control, alternate] = await Promise.all([
    observe(fetch(fixtures.controlUrl)),
    observe(fetch(`${fixtures.alternateOrigin}/rollback-probe`))
  ]);
  assert.deepEqual(
    { control: control.status, alternate: alternate.status },
    { control: "rejected", alternate: "rejected" }
  );
}

test("cleanup preserves the primary failure and still attempts later cleanup steps", async () => {
  const primary = new Error("PRIMARY_ASSERTION_SENTINEL");
  const cleanupFailure = new Error("CLEANUP_SENTINEL");
  const cleanupCalls: string[] = [];

  const outcome = await observe(runCleanupSteps(primary, [
    {
      label: "failing cleanup",
      async run() {
        cleanupCalls.push("failing cleanup");
        throw cleanupFailure;
      }
    },
    {
      label: "later cleanup",
      async run() {
        cleanupCalls.push("later cleanup");
      }
    }
  ]));

  assert.equal(outcome.status, "rejected");
  assert.equal(outcome.reason instanceof AggregateError, true);
  const errors = (outcome.reason as AggregateError).errors;
  assert.equal(errors[0], primary);
  assert.equal(errors[1], cleanupFailure);
  assert.deepEqual(cleanupCalls, ["failing cleanup", "later cleanup"]);
});

test("local settlement timeout still permits later cleanup", async () => {
  let laterCleanupRan = false;
  const startedAt = Date.now();
  const outcome = await observe(runCleanupSteps(undefined, [
    {
      label: "never-settling companion",
      run: () => settleWithin(
        new Promise<never>(() => undefined),
        40,
        "never-settling test promise"
      )
    },
    {
      label: "later cleanup",
      run() {
        laterCleanupRan = true;
      }
    }
  ]));

  assert.equal(outcome.status, "rejected");
  assert.match(String(outcome.reason), /Timed out settling never-settling test promise\./);
  assert.equal(laterCleanupRan, true);
  assert.equal(Date.now() - startedAt < 500, true);
});

test("real workflow cleanup retains a captured-executor close rejection and attempts every later step", { timeout: 20_000 }, async () => {
  const primary = new Error("PRIMARY_ASSERTION_SENTINEL");
  const closeFailure = new Error("REAL_CLOSE_REJECTION_SENTINEL");
  const cleanupAttempts: string[] = [];
  const workflow = await createWorkflow({
    onCleanupStepAttempt(label) {
      cleanupAttempts.push(label);
    },
    testOnlyTransformCapturedCloseExecution() {
      return Promise.reject(closeFailure);
    }
  });
  await workflow.controlPage.close();

  const outcome = await observe(workflow.cleanup(primary));

  assert.equal(outcome.status, "rejected");
  assert.equal(outcome.reason instanceof AggregateError, true);
  const errors = (outcome.reason as AggregateError).errors;
  assert.equal(errors[0], primary);
  assert.equal(errors[1], closeFailure);
  assert.deepEqual(cleanupAttempts, [
    "held packet-read release",
    "companion close request",
    "browser context close",
    "companion settlement",
    "browser close",
    "fixture server close",
    "captured executor boundary assertion"
  ]);
  assert.equal(workflow.companionSettled(), true);
  assert.equal(workflow.browser.isConnected(), false);
  await assertFixtureListenersUnreachable(workflow.fixtures);
});

test("real workflow cleanup locally times out a never-settling captured-executor close and attempts every later step", { timeout: 20_000 }, async () => {
  const primary = new Error("PRIMARY_ASSERTION_SENTINEL");
  const cleanupAttempts: string[] = [];
  let releaseClose: (() => void) | undefined;
  const workflow = await createWorkflow({
    closeSettlementTimeoutMs: 40,
    onCleanupStepAttempt(label) {
      cleanupAttempts.push(label);
    },
    testOnlyTransformCapturedCloseExecution(execution) {
      return new Promise((resolve, reject) => {
        releaseClose = () => execution.then(resolve, reject);
      });
    }
  });
  await workflow.controlPage.close();
  const startedAt = Date.now();
  const cleanupOutcome = observe(workflow.cleanup(primary));
  let outcome: PromiseSettledResult<void>;
  try {
    outcome = await settleWithin(cleanupOutcome, 250, "real CLOSE_WORKFLOW regression watchdog");
  } finally {
    releaseClose?.();
    await cleanupOutcome;
  }

  assert.equal(outcome.status, "rejected");
  assert.equal(outcome.reason instanceof AggregateError, true);
  const errors = (outcome.reason as AggregateError).errors;
  assert.equal(errors[0], primary);
  assert.match(String(errors[1]), /Timed out settling application browser companion close request\./);
  assert.deepEqual(cleanupAttempts, [
    "held packet-read release",
    "companion close request",
    "browser context close",
    "companion settlement",
    "browser close",
    "fixture server close",
    "captured executor boundary assertion"
  ]);
  assert.equal(workflow.companionSettled(), true);
  assert.equal(workflow.browser.isConnected(), false);
  await assertFixtureListenersUnreachable(workflow.fixtures);
  assert.equal(Date.now() - startedAt < 250, true);
});

test("workflow setup failure after fixture acquisition rolls back both fixture listeners", async () => {
  const setupFailure = new Error("SETUP_AFTER_FIXTURES_SENTINEL");
  let fixtures: IntegrationFixtures | undefined;
  try {
    const outcome = await observe(createWorkflow({
      failAt: "AFTER_FIXTURES",
      setupFailure,
      onFixturesAcquired(value) {
        fixtures = value;
      }
    }));
    assert.equal(outcome.status, "rejected");
    if (outcome.status === "rejected") assert.equal(outcome.reason, setupFailure);
    assert.ok(fixtures);
    await assertFixtureListenersUnreachable(fixtures);
  } finally {
    await fixtures?.close().catch(() => undefined);
  }
});

test("workflow setup failure after bridge acquisition rolls back browser, companion, listeners, and fixtures", { timeout: 20_000 }, async () => {
  const setupFailure = new Error("SETUP_AFTER_BRIDGE_SENTINEL");
  const baseline = {
    sigint: process.listenerCount("SIGINT"),
    sigterm: process.listenerCount("SIGTERM")
  };
  let fixtures: IntegrationFixtures | undefined;
  let browser: Browser | undefined;
  let controlPage: Page | undefined;
  let companionOutcome: Promise<PromiseSettledResult<void>> | undefined;
  let primaryError: unknown;
  let rollbackProven = false;
  try {
    const outcome = await observe(createWorkflow({
      failAt: "AFTER_BRIDGE",
      armHeldPacketReadBeforeFailure: true,
      setupFailure,
      onFixturesAcquired(value) {
        fixtures = value;
      },
      onBrowserAcquired(value) {
        browser = value;
      },
      onCompanionStarted(value) {
        controlPage = value.controlPage;
        companionOutcome = value.companionOutcome;
      }
    }));
    assert.equal(outcome.status, "rejected");
    if (outcome.status === "rejected") assert.equal(outcome.reason, setupFailure);
    assert.ok(fixtures);
    assert.ok(browser);
    assert.equal(fixtures.coordinatorPacketReadGateActive(), false);
    const [controlReachability, alternateReachability] = await Promise.all([
      observe(fetch(fixtures.controlUrl)),
      observe(fetch(`${fixtures.alternateOrigin}/rollback-probe`))
    ]);
    assert.deepEqual({
      browserConnected: browser.isConnected(),
      controlFixtureReachable: controlReachability.status === "fulfilled",
      alternateFixtureReachable: alternateReachability.status === "fulfilled",
      sigint: process.listenerCount("SIGINT"),
      sigterm: process.listenerCount("SIGTERM")
    }, {
      browserConnected: false,
      controlFixtureReachable: false,
      alternateFixtureReachable: false,
      sigint: baseline.sigint,
      sigterm: baseline.sigterm
    });
    rollbackProven = true;
  } catch (error) {
    primaryError = error;
  }
  await runCleanupSteps(primaryError, [
    {
      label: "setup-regression defensive close request",
      async run() {
        if (!controlPage || controlPage.isClosed()) return;
        await settleWithin(
          invoke(controlPage, { type: "CLOSE_WORKFLOW" }),
          LOCAL_SETTLEMENT_TIMEOUT_MS,
          "setup-regression defensive CLOSE_WORKFLOW request"
        );
      }
    },
    {
      label: "setup-regression defensive browser close",
      async run() {
        if (browser?.isConnected()) await browser.close();
      }
    },
    {
      label: "setup-regression defensive companion settlement",
      async run() {
        if (!companionOutcome) return;
        const outcome = await settleWithin(
          companionOutcome,
          LOCAL_SETTLEMENT_TIMEOUT_MS,
          "setup-regression defensive application browser companion"
        );
        if (outcome.status === "rejected") throw outcome.reason;
      }
    },
    {
      label: "setup-regression defensive fixture close",
      async run() {
        if (!rollbackProven) await fixtures?.close();
      }
    }
  ]);
});

test("captured executor fallback is cleanup-only CLOSE_WORKFLOW after the binding becomes unavailable", { timeout: 20_000 }, async () => {
  let inspectedWorkflow: Workflow | undefined;
  await withWorkflow({}, async (workflow) => {
    inspectedWorkflow = workflow;
    assert.deepEqual(workflow.directExecutorInvocations(), []);
    await workflow.controlPage.close();
  });
  assert.ok(inspectedWorkflow);
  assert.deepEqual(inspectedWorkflow.directExecutorInvocations(), [{ type: "CLOSE_WORKFLOW" }]);
});

test("real companion materially publishes, exposes the full owner packet only by HTTP, and exactly replays", { timeout: 30_000 }, async () => {
  await withWorkflow({}, async (workflow) => {
    const employerPage = await openAndArm(workflow);

    const material = await invoke(workflow.controlPage, { type: "INSPECT_FORM" });
    assertSuccessfulBindingResult(material, false);
    assert.equal(workflow.fixtures.publicationHits(), 1);
    const [firstRequest] = workflow.fixtures.publicationRequests();
    assert.equal(firstRequest.ordinal, 1);
    assert.equal(firstRequest.path, `/api/application-runs/${BROWSER_SMOKE_RUN_ID}/form-inspection`);
    assert.equal(firstRequest.contentType.split(";", 1)[0].trim().toLowerCase(), "application/json");
    assert.equal(firstRequest.disposition, "MATERIAL");
    assert.equal(firstRequest.parsedBody.expectedStateVersion, 0);
    assert.equal(firstRequest.parsedBody.expectedFormInspectionVersion, 0);
    assert.equal(firstRequest.parsedBody.expectedAnswerPacketVersion, 0);
    assert.equal(firstRequest.parsedBody.observedUrl, SYNTHETIC_EMPLOYER_URL);
    assert.equal(typeof firstRequest.parsedBody.inspectionReport, "object");

    const packetResponse = await fetch(
      `${workflow.fixtures.controlOrigin}/api/application-runs/${BROWSER_SMOKE_RUN_ID}/answer-packet`
    );
    assert.equal(packetResponse.status, 200);
    const packet = await packetResponse.json() as Record<string, unknown>;
    assert.deepEqual(packet, {
      runId: BROWSER_SMOKE_RUN_ID,
      current: {
        inspectionVersion: 1,
        answerPacketVersion: 1,
        packetHash: PACKET_HASH,
        reviewedAt: null,
        createdAt: "2026-08-30T12:00:00.000Z",
        summary: {
          fieldCount: 1,
          proposableCount: 1,
          pendingReviewCount: 1,
          approvedCount: 0,
          rejectedCount: 0,
          manualOnlyCount: 0,
          excludedCount: 0,
          unsupportedCount: 0,
          manualRequiredCount: 1,
          readyForRunResolution: false
        },
        answers: [{
          id: "answer-integrated-name",
          normalizedFieldKey: NORMALIZED_FIELD_KEY,
          question: "Name",
          fieldType: "TEXT",
          classification: "PERSONAL_NAME",
          disposition: "PROPOSABLE",
          dispositionReason: null,
          choices: [],
          proposal: { kind: "SCALAR", value: "Ada Lovelace" },
          required: false,
          requiresReview: true,
          sensitive: false,
          valueRedacted: false,
          status: "PENDING",
          reviewedByUser: false,
          reviewedAt: null
        }]
      }
    });
    assert.equal(JSON.stringify(material).includes(PACKET_HASH), false);
    assert.equal(JSON.stringify(material).includes("Ada Lovelace"), false);
    assert.equal(JSON.stringify(material).includes("inspectionReport"), false);

    const replay = await invoke(workflow.controlPage, { type: "INSPECT_FORM" });
    assertSuccessfulBindingResult(replay, true);
    assert.equal(workflow.fixtures.publicationHits(), 2);
    const requests = workflow.fixtures.publicationRequests();
    assert.equal(requests.length, 2);
    assertSentinelAbsentFromEveryPublication(requests);
    assert.deepEqual(
      requests.map((request) => ({
        ordinal: request.ordinal,
        disposition: request.disposition,
        expectedStateVersion: request.parsedBody.expectedStateVersion,
        expectedFormInspectionVersion: request.parsedBody.expectedFormInspectionVersion,
        expectedAnswerPacketVersion: request.parsedBody.expectedAnswerPacketVersion
      })),
      [
        {
          ordinal: 1,
          disposition: "MATERIAL",
          expectedStateVersion: 0,
          expectedFormInspectionVersion: 0,
          expectedAnswerPacketVersion: 0
        },
        {
          ordinal: 2,
          disposition: "REPLAY",
          expectedStateVersion: 1,
          expectedFormInspectionVersion: 1,
          expectedAnswerPacketVersion: 1
        }
      ]
    );
    assertNoEmployerAuthority(await trapSnapshot(employerPage));
    assert.equal(workflow.fixtures.mutationHits(), 0);
  });
});

test("semantic label mutation preserves the accepted field attachment and ownership", { timeout: 20_000 }, async () => {
  await withWorkflow({}, async (workflow) => {
    const employerPage = await openAndArm(workflow);
    const proof = await mutateIntegrationLabel(employerPage);
    assertSemanticMutationPreservesField(proof);
    assert.equal(workflow.fixtures.publicationHits(), 0);
  });
});

test("real strong currentness rejects a test-side semantic mutation before publication", { timeout: 20_000 }, async () => {
  await withWorkflow({ mutateBeforeAssertCurrent: true }, async (workflow) => {
    const employerPage = await openAndArm(workflow);
    const invocation = await observe(invoke(workflow.controlPage, { type: "INSPECT_FORM" }));
    if (invocation.status === "rejected") {
      assert.fail(`Strong-current invocation rejected: ${String(invocation.reason)}`);
    }
    const result = invocation.value;
    assertReinspectionBindingResult(result);
    assert.equal(workflow.fixtures.publicationHits(), 0);
    assert.equal((await fetch(
      `${workflow.fixtures.controlOrigin}/api/application-runs/${BROWSER_SMOKE_RUN_ID}/answer-packet`
    ).then((response) => response.json()) as { current: unknown }).current, null);
    assertNoEmployerAuthority(await trapSnapshot(employerPage), 1);
    assert.equal(workflow.fixtures.mutationHits(), 0);
  });
});

test("control trust loss while the coordinator packet read is held prevents publication", { timeout: 20_000 }, async () => {
  await withWorkflow({}, async (workflow) => {
    const employerPage = await openAndArm(workflow);
    workflow.fixtures.holdNextCoordinatorPacketRead();
    const nextExecution = workflow.waitForNextInspectionExecution();
    let pageSideSettled = false;
    const pending = observe(invoke(workflow.controlPage, { type: "INSPECT_FORM" })).then((outcome) => {
      pageSideSettled = true;
      return outcome;
    });
    const execution = await nextExecution;
    let delegateSettled = false;
    const delegatePending = observe(execution.promise).then((outcome) => {
      delegateSettled = true;
      return outcome;
    });
    assert.deepEqual(await workflow.fixtures.waitForHeldCoordinatorPacketRead(), {
      ordinal: 1,
      path: `/api/application-runs/${BROWSER_SMOKE_RUN_ID}/answer-packet`
    });
    const snapshot = await trapSnapshot(employerPage);
    await workflow.controlPage.goto(`${workflow.fixtures.alternateOrigin}/left-control`).catch(() => undefined);
    await waitFor("the page-side binding rejection", () => pageSideSettled);
    assert.equal(delegateSettled, false);
    workflow.fixtures.releaseHeldCoordinatorPacketRead();
    const outcome = await settleWithin(pending, LOCAL_SETTLEMENT_TIMEOUT_MS, "page-side trust-loss invocation");
    assert.equal(outcome.status, "rejected");
    const delegateOutcome = await settleWithin(
      delegatePending,
      LOCAL_SETTLEMENT_TIMEOUT_MS,
      "trust-loss INSPECT_FORM coordinator delegate"
    );
    assert.equal(delegateOutcome.status, "rejected");
    assert.equal(workflow.fixtures.publicationHits(), 0);
    assertNoEmployerAuthority(snapshot);
    const companionOutcome = await settleWithin(
      workflow.companionOutcome,
      LOCAL_SETTLEMENT_TIMEOUT_MS,
      "trust-loss application browser companion"
    );
    assert.equal(companionOutcome.status, "fulfilled");
    assert.equal(workflow.fixtures.publicationHits(), 0);
    assert.deepEqual(workflow.directExecutorInvocations(), []);
  });
});

test("real target guard safe-stops path/query drift while the coordinator packet read is held", { timeout: 20_000 }, async () => {
  await withWorkflow({}, async (workflow) => {
    const employerPage = await openAndArm(workflow);
    workflow.fixtures.holdNextCoordinatorPacketRead();
    const pending = observe(invoke(workflow.controlPage, { type: "INSPECT_FORM" }));
    await workflow.fixtures.waitForHeldCoordinatorPacketRead();
    const snapshot = await trapSnapshot(employerPage);
    await employerPage.evaluate(() => history.pushState({}, "", "/apply?posting=changed"));
    workflow.fixtures.releaseHeldCoordinatorPacketRead();
    const outcome = await pending;
    assert.equal(outcome.status, "rejected");
    assert.equal(workflow.fixtures.publicationHits(), 0);
    assertNoEmployerAuthority(snapshot);
  });
});

test("fragment navigation invalidates the held generation without removing later inspection authority", { timeout: 30_000 }, async () => {
  await withWorkflow({}, async (workflow) => {
    const employerPage = await openAndArm(workflow);
    workflow.fixtures.holdNextCoordinatorPacketRead();
    const pending = observe(invoke(workflow.controlPage, { type: "INSPECT_FORM" }));
    await workflow.fixtures.waitForHeldCoordinatorPacketRead();
    await employerPage.evaluate(() => history.pushState({}, "", "/apply?posting=123#review"));
    workflow.fixtures.releaseHeldCoordinatorPacketRead();
    const outcome = await pending;
    assert.equal(outcome.status, "fulfilled");
    if (outcome.status === "fulfilled") assertReinspectionBindingResult(outcome.value);
    assert.equal(workflow.fixtures.publicationHits(), 0);
    assert.equal((await invoke(workflow.controlPage, { type: "GET_STATUS" })).state, "TARGET_OPEN");

    const later = await invoke(workflow.controlPage, { type: "INSPECT_FORM" });
    assertSuccessfulBindingResult(later, false);
    assert.equal(workflow.fixtures.publicationHits(), 1);
    const requests = workflow.fixtures.publicationRequests();
    assert.equal(requests.length, 1);
    assert.equal(
      requests[0].parsedBody.observedUrl,
      "https://employer.example.test/apply?posting=123#review"
    );
    assert.equal(
      requests[0].rawBody.includes('"observedUrl":"https://employer.example.test/apply?posting=123#review"'),
      true
    );
    assertSentinelAbsentFromEveryPublication(requests);
    assertNoEmployerAuthority(await trapSnapshot(employerPage));
  });
});
