import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

import { MISSING_CHROMIUM_MESSAGE } from "@/lib/application-browser/browser-runtime";
import { installControlBridge } from "@/lib/application-browser/control-bridge";
import {
  ApplicationBrowserCoordinator,
  createPlaywrightTargetController
} from "@/lib/application-browser/coordinator";
import { createApplicationFormInspectionController } from "@/lib/application-browser/form-inspection-controller";
import { createProtectedApplicationBrowserSession } from "@/lib/application-browser/protected-browser-session";
import type {
  BrowserFillAcquisition,
  BrowserFillAttemptStatus,
  BrowserFillFinalizeInput,
  BrowserFormInspectionPublicationInput,
  SameOriginClientWithFill
} from "@/lib/application-browser/same-origin-client";
import {
  APPLICATION_BROWSER_BINDING_NAME,
  type B1Command,
  type B1Status
} from "@/lib/application-browser/types";
import { buildNormalizedApplicationFormInspection } from "@/lib/application-runs/form-inspection";

import {
  assertNoSubmission,
  boundedWriterFixture,
  type FormFillTrapSnapshot
} from "./form-fill-fixtures";

const CONTROL_ORIGIN = "https://apply-pilot.invalid";
const TARGET_URL = "https://fixture.invalid/apply";
const TARGET_HOST = "fixture.invalid";
const RUN_ID = "clz8w7m9a0002qwer1234tyui";
const CONTROL_URL = `${CONTROL_ORIGIN}/application-runs/${RUN_ID}/browser`;
const ATTEMPT_ID = "550e8400-e29b-41d4-a716-446655440000";
const LEASE_EXPIRES_AT = "2099-09-11T18:00:00.000Z";
const REPOSITORY_ROOT = fileURLToPath(new URL("../../", import.meta.url));

type ControlFillState = {
  activationCount: number;
  settled: boolean;
  result: unknown;
  error: string | null;
};

declare global {
  interface Window {
    __userFillState?: ControlFillState;
    __productionControlBindingState?: {
      commands: B1Command[];
      fillCount: number;
    };
    __productionControlHarness?: {
      mountCount: number;
      remount(): void;
    };
  }
}

function downstreamControlFixture(): string {
  return `<!doctype html><html><body>
    <h1>Apply Pilot browser control</h1>
    <button id="fill-approved-fields" type="button">Fill approved fields</button>
    <script>
      (() => {
        const button = document.getElementById('fill-approved-fields');
        const state = window.__userFillState = {
          activationCount: 0,
          settled: false,
          result: null,
          error: null
        };
        let dispatched = false;
        button.addEventListener('click', async () => {
          if (dispatched) return;
          dispatched = true;
          state.activationCount += 1;
          button.disabled = true;
          try {
            const binding = window[${JSON.stringify(APPLICATION_BROWSER_BINDING_NAME)}];
            if (typeof binding !== 'function') throw new Error('binding unavailable');
            state.result = await binding({ type: 'FILL_APPROVED_FIELDS' });
          } catch (error) {
            state.error = error instanceof Error ? error.message : 'unknown failure';
          } finally {
            state.settled = true;
          }
        });
      })();
    </script>
  </body></html>`;
}

const productionAnswerPacket = {
  inspectionVersion: 2,
  answerPacketVersion: 3,
  packetHash: "a".repeat(64),
  reviewedAt: "2026-09-11T17:01:00.000Z",
  createdAt: "2026-09-11T17:00:00.000Z",
  summary: {
    fieldCount: 1,
    proposableCount: 1,
    pendingReviewCount: 0,
    approvedCount: 1,
    rejectedCount: 0,
    manualOnlyCount: 0,
    excludedCount: 0,
    unsupportedCount: 0,
    manualRequiredCount: 0,
    readyForRunResolution: true
  },
  answers: [{
    id: "answer-name",
    normalizedFieldKey: "b".repeat(64),
    question: "Full name",
    fieldType: "TEXT",
    classification: "CONTACT",
    disposition: "PROPOSABLE",
    dispositionReason: null,
    choices: [],
    proposal: { kind: "SCALAR", value: "Ada Lovelace" },
    required: true,
    requiresReview: true,
    sensitive: false,
    valueRedacted: false,
    status: "APPROVED",
    reviewedByUser: true,
    reviewedAt: "2026-09-11T17:01:00.000Z"
  }]
} as const;

function noAttemptStatus() {
  return {
    state: "READY",
    stateVersion: 7,
    fillAttemptId: null,
    fillLeaseExpiresAt: null,
    leaseLive: false,
    expiredRecoveryRequired: false,
    fieldOperationAllowed: false,
    outcome: null,
    errorCode: null,
    steps: []
  } as const;
}

function fillingStatus() {
  return {
    ...noAttemptStatus(),
    state: "FILLING",
    stateVersion: 8,
    fillAttemptId: ATTEMPT_ID,
    fillLeaseExpiresAt: LEASE_EXPIRES_AT,
    leaseLive: true,
    fieldOperationAllowed: true
  } as const;
}

function productionTargetStatus(): B1Status {
  return {
    state: "TARGET_OPEN",
    runId: RUN_ID,
    targetHost: TARGET_HOST,
    inspection: {
      outcome: "SUCCEEDED",
      replayed: false,
      inspectionVersion: productionAnswerPacket.inspectionVersion,
      answerPacketVersion: productionAnswerPacket.answerPacketVersion,
      reinspectionRequired: false
    }
  };
}

function productionControlFixture(): string {
  return `<!doctype html><html><body data-run-id="${RUN_ID}">
    <div id="root"></div>
    <script src="/__application-browser-control.js"></script>
  </body></html>`;
}

type ProductionBindingMode = "PENDING" | "LOST";
type ProductionControlServerState = {
  failFillStatus: boolean;
  fillStatusReads: number;
  fillStatus: ReturnType<typeof noAttemptStatus> | ReturnType<typeof fillingStatus>;
};

let productionControlBundle = "";

async function buildProductionControlBundle(): Promise<string> {
  const result = await build({
    absWorkingDir: REPOSITORY_ROOT,
    bundle: true,
    define: {
      "process.env": JSON.stringify({ NODE_ENV: "test" }),
      "process.env.NODE_ENV": JSON.stringify("test")
    },
    format: "iife",
    logLevel: "silent",
    platform: "browser",
    sourcemap: "inline",
    target: "chrome123",
    tsconfig: "tsconfig.json",
    write: false,
    stdin: {
      contents: `
        import { createElement } from "react";
        import { createRoot } from "react-dom/client";
        import { ApplicationBrowserControl } from "@/components/application-browser-control";

        const container = document.getElementById("root");
        if (!(container instanceof HTMLElement)) throw new Error("production control root missing");
        const runId = document.body.dataset.runId;
        if (!runId) throw new Error("production control run ID missing");
        let root = null;
        const harness = {
          mountCount: 0,
          remount() {
            root?.unmount();
            root = createRoot(container);
            root.render(createElement(ApplicationBrowserControl, { runId, authenticatedOwnerPage: true }));
            harness.mountCount += 1;
          }
        };
        Object.defineProperty(window, "__productionControlHarness", {
          configurable: true,
          value: harness
        });
        harness.remount();
      `,
      loader: "tsx",
      resolveDir: REPOSITORY_ROOT,
      sourcefile: "tests/browser/application-browser-control-entry.tsx"
    }
  });
  assert.equal(result.outputFiles.length, 1);
  return result.outputFiles[0].text;
}

async function openProductionControlPage(input: Readonly<{
  bindingMode: ProductionBindingMode;
  fillStatus?: ProductionControlServerState["fillStatus"];
}>): Promise<{
  browserDiagnostics: string[];
  context: BrowserContext;
  page: Page;
  serverState: ProductionControlServerState;
}> {
  const context = await browser.newContext();
  const serverState: ProductionControlServerState = {
    failFillStatus: false,
    fillStatusReads: 0,
    fillStatus: input.fillStatus ?? noAttemptStatus()
  };
  await context.addInitScript(`(() => {
    const bindingMode = ${JSON.stringify(input.bindingMode)};
    const bindingName = ${JSON.stringify(APPLICATION_BROWSER_BINDING_NAME)};
    const trustedStatus = ${JSON.stringify(productionTargetStatus())};
    const state = { commands: [], fillCount: 0 };
    Object.defineProperty(window, "__productionControlBindingState", {
      configurable: true,
      value: state
    });
    Object.defineProperty(window, bindingName, {
      configurable: true,
      value: async (command) => {
        state.commands.push(command);
        if (command.type !== "FILL_APPROVED_FIELDS") return trustedStatus;
        state.fillCount += 1;
        if (bindingMode === "LOST") throw new Error("binding result lost");
        return new Promise(() => undefined);
      }
    });
  })();`);
  await context.route(`${CONTROL_ORIGIN}/**`, async (route) => {
    const requestUrl = new URL(route.request().url());
    if (requestUrl.pathname === new URL(CONTROL_URL).pathname) {
      await route.fulfill({
        status: 200,
        contentType: "text/html; charset=utf-8",
        body: productionControlFixture()
      });
      return;
    }
    if (requestUrl.pathname === "/__application-browser-control.js") {
      await route.fulfill({
        status: 200,
        contentType: "text/javascript; charset=utf-8",
        body: productionControlBundle
      });
      return;
    }
    if (requestUrl.pathname === `/api/application-runs/${RUN_ID}`) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          run: {
            id: RUN_ID,
            state: serverState.fillStatus.state,
            stateVersion: serverState.fillStatus.stateVersion,
            completedAt: null,
            reviewReasons: []
          }
        })
      });
      return;
    }
    if (requestUrl.pathname === `/api/application-runs/${RUN_ID}/answer-packet`) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ runId: RUN_ID, current: productionAnswerPacket })
      });
      return;
    }
    if (requestUrl.pathname === `/api/application-runs/${RUN_ID}/fill-attempt`) {
      serverState.fillStatusReads += 1;
      await route.fulfill(serverState.failFillStatus
        ? { status: 503, contentType: "application/json", body: "{}" }
        : { status: 200, contentType: "application/json", body: JSON.stringify(serverState.fillStatus) }
      );
      return;
    }
    await route.fulfill({ status: 404, body: "not found" });
  });
  try {
    const page = await context.newPage();
    const browserDiagnostics: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error" || message.type() === "warning") {
        browserDiagnostics.push(`console ${message.type()}: ${message.text()}`);
      }
    });
    page.on("pageerror", (error) => {
      browserDiagnostics.push(`pageerror: ${error.message}`);
    });
    await page.goto(CONTROL_URL, { waitUntil: "domcontentloaded" });
    try {
      await page.getByRole("heading", { name: "Current answer packet", exact: true }).waitFor({ timeout: 5_000 });
    } catch (error) {
      const body = await page.locator("body").innerText().catch(() => "<body unavailable>");
      throw new Error(
        `Production control bundle did not render. ${browserDiagnostics.join(" | ") || "No browser diagnostic."} Body: ${body}`,
        { cause: error }
      );
    }
    assert.equal(page.url(), CONTROL_URL);
    return { browserDiagnostics, context, page, serverState };
  } catch (error) {
    await context.close();
    throw error;
  }
}

async function prepareFillEligibleProductionControl(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Refresh status", exact: true }).click();
  await page.getByTestId("transmission-ack").check();
  await page.waitForFunction(() => {
    const fill = [...document.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Fill approved fields"
    );
    return fill instanceof HTMLButtonElement && !fill.disabled;
  });
}

async function invoke(page: Page, command: B1Command & Record<string, unknown>) {
  return page.evaluate(
    async ({ bindingName, value }) => {
      const binding = (window as unknown as Record<string, (input: unknown) => Promise<unknown>>)[bindingName];
      if (typeof binding !== "function") throw new Error("binding unavailable");
      return binding(value);
    },
    { bindingName: APPLICATION_BROWSER_BINDING_NAME, value: command }
  );
}

let browser: Browser;

before(async () => {
  productionControlBundle = await buildProductionControlBundle();
  try {
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    if (
      error instanceof Error &&
      /executable.*(doesn'?t exist|missing|not found)|playwright install/i.test(error.message)
    ) {
      throw new Error(MISSING_CHROMIUM_MESSAGE);
    }
    throw error;
  }
});

after(async () => {
  await browser?.close();
});

test("production ApplicationBrowserControl suppresses a rapid duplicate Fill and locks pending UI", async () => {
  const { browserDiagnostics, context, page } = await openProductionControlPage({ bindingMode: "PENDING" });
  try {
    await prepareFillEligibleProductionControl(page);
    const fill = page.getByRole("button", { name: "Fill approved fields", exact: true });
    await fill.evaluate((button) => {
      if (!(button instanceof HTMLButtonElement)) throw new Error("Fill control is not a button");
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await page.getByRole("button", { name: "Filling…", exact: true }).waitFor();

    const bindingState = await page.evaluate(() => window.__productionControlBindingState!);
    assert.equal(bindingState.fillCount, 1);
    assert.deepEqual(bindingState.commands.map((command) => command.type), [
      "GET_STATUS",
      "FILL_APPROVED_FIELDS"
    ]);
    for (const name of [
      "Filling…",
      "Refresh status",
      "Open frozen target",
      "Inspect form",
      "Close workflow",
      "Refresh review data",
      "Refresh Fill status"
    ]) {
      assert.equal(
        await page.getByRole("button", { name, exact: true }).isDisabled(),
        true,
        name
      );
    }
    const text = await page.locator("body").innerText();
    assert.match(text, /Fill command is pending/i);
    assert.doesNotMatch(text, /Fill has not started/i);
    assert.doesNotMatch(text, /No Fill attempt has been consumed/i);
    assert.deepEqual(browserDiagnostics, []);
  } finally {
    await context.close();
  }
});

test("production ApplicationBrowserControl reconciles a lost Fill result read-only without replay", async () => {
  const { browserDiagnostics, context, page, serverState } = await openProductionControlPage({ bindingMode: "LOST" });
  try {
    await prepareFillEligibleProductionControl(page);
    const readsBeforeFill = serverState.fillStatusReads;
    serverState.failFillStatus = true;

    await page.getByRole("button", { name: "Fill approved fields", exact: true }).click();
    await page.getByText(/Fill mutation outcome is uncertain/i).waitFor();

    const bindingState = await page.evaluate(() => window.__productionControlBindingState!);
    assert.equal(bindingState.fillCount, 1);
    assert.equal(
      bindingState.commands.filter((command) => command.type === "FILL_APPROVED_FIELDS").length,
      1
    );
    assert.equal(bindingState.commands.filter((command) => command.type === "GET_STATUS").length, 1);
    assert.equal(serverState.fillStatusReads, readsBeforeFill + 1);
    const text = await page.locator("body").innerText();
    assert.match(text, /Fill status is temporarily unavailable/i);
    assert.match(text, /Durable Fill status is unverified/i);
    assert.doesNotMatch(text, /Fill has not started/i);
    assert.doesNotMatch(text, /No Fill attempt has been consumed/i);

    const readOnlyRefresh = page.waitForResponse((response) =>
      new URL(response.url()).pathname === `/api/application-runs/${RUN_ID}/fill-attempt`
    );
    await page.getByRole("button", { name: "Refresh Fill status", exact: true }).click();
    await readOnlyRefresh;
    const afterRefresh = await page.evaluate(() => window.__productionControlBindingState!);
    assert.equal(afterRefresh.fillCount, 1, "a read-only refresh must not replay Fill");
    assert.equal(serverState.fillStatusReads, readsBeforeFill + 2);
    assert.equal(browserDiagnostics.length, 2);
    for (const diagnostic of browserDiagnostics) {
      assert.match(diagnostic, /Failed to load resource.*503 \(Service Unavailable\)/i);
    }
  } finally {
    await context.close();
  }
});

test("a production ApplicationBrowserControl remount with an existing attempt never dispatches Fill", async () => {
  const { browserDiagnostics, context, page, serverState } = await openProductionControlPage({
    bindingMode: "PENDING",
    fillStatus: fillingStatus()
  });
  try {
    await page.getByText("Fill is in progress", { exact: true }).waitFor();
    const readsBeforeRemount = serverState.fillStatusReads;
    const remountRead = page.waitForResponse((response) =>
      new URL(response.url()).pathname === `/api/application-runs/${RUN_ID}/fill-attempt`
    );
    await page.evaluate(() => window.__productionControlHarness!.remount());
    await remountRead;
    await page.waitForFunction(() => window.__productionControlHarness?.mountCount === 2);
    await page.getByText("Fill is in progress", { exact: true }).waitFor();

    const bindingState = await page.evaluate(() => window.__productionControlBindingState!);
    assert.equal(bindingState.fillCount, 0);
    assert.deepEqual(bindingState.commands, []);
    assert.equal(serverState.fillStatusReads, readsBeforeRemount + 1);
    assert.deepEqual(browserDiagnostics, []);
  } finally {
    await context.close();
  }
});

test("downstream synthetic trigger crosses one trusted bridge and writes six families without employer action or submit", async () => {
  const context = await browser.newContext();
  const employerContext = await browser.newContext();
  await context.route(`${CONTROL_ORIGIN}/**`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: downstreamControlFixture()
    });
  });
  const controlPage = await context.newPage();
  await controlPage.goto(CONTROL_URL, { waitUntil: "domcontentloaded" });

  const unsafeCodes: string[] = [];
  const coordinatorRef: { current: ApplicationBrowserCoordinator | null } = { current: null };
  const targetController = createPlaywrightTargetController({
    context: employerContext,
    onUnsafe(code) {
      unsafeCodes.push(code);
      void coordinatorRef.current?.safeStop(code);
    },
    testOnlyCreateProtectedSession: (page) =>
      createProtectedApplicationBrowserSession({ page }),
    async testOnlyFulfillMainDocument(_request, route) {
      await route.fulfill({
        status: 200,
        contentType: "text/html; charset=utf-8",
        body: boundedWriterFixture()
      });
    }
  });

  let formController: ReturnType<typeof createApplicationFormInspectionController> | null = null;
  let packetPublished = false;
  let acquisition: BrowserFillAcquisition | null = null;
  let acquisitionCount = 0;
  let finalization: BrowserFillFinalizeInput | null = null;
  let fillStatusReads = 0;
  const serverFieldOrder: string[] = [];
  const writerFieldOrder: string[] = [];
  let writerCalls = 0;
  let writersInFlight = 0;
  let maxWriterConcurrency = 0;

  const liveStatus = (): BrowserFillAttemptStatus => Object.freeze({
    state: "FILLING",
    stateVersion: 8,
    fillAttemptId: ATTEMPT_ID,
    fillLeaseExpiresAt: LEASE_EXPIRES_AT,
    leaseLive: true,
    expiredRecoveryRequired: false,
    fieldOperationAllowed: true,
    outcome: null,
    errorCode: null,
    steps: Object.freeze([])
  });

  const client = {
    async getApplicationRun(runId: string) {
      assert.equal(runId, RUN_ID);
      return {
        id: RUN_ID,
        state: "READY" as const,
        stateVersion: 7,
        completedAt: null,
        applyHost: TARGET_HOST,
        applyUrlSnapshot: TARGET_URL
      };
    },
    async getAutomationPolicy() {
      return {
        effectiveEnabled: true,
        allowedHosts: [TARGET_HOST],
        blockedHosts: []
      };
    },
    async getCurrentAnswerPacket(runId: string) {
      assert.equal(runId, RUN_ID);
      return {
        runId: RUN_ID,
        current: packetPublished
          ? { inspectionVersion: 2, answerPacketVersion: 3 }
          : null
      };
    },
    async publishFormInspection(
      publication: BrowserFormInspectionPublicationInput,
      assertReadyToDispatch: () => void
    ) {
      assertReadyToDispatch();
      const normalized = buildNormalizedApplicationFormInspection({
        authoritativeApplyHost: TARGET_HOST,
        report: publication.inspectionReport
      });
      const fields = normalized.snapshot.forms.flatMap((form) =>
        form.sections.flatMap((section) => section.fields)
      );
      const field = (question: string) => {
        const matches = fields.filter((candidate) => candidate.question === question);
        assert.equal(matches.length, 1, question);
        return matches[0];
      };
      const select = field("Empty select");
      const selectedChoice = select.choices.find((choice) => choice.label === "A");
      assert.ok(selectedChoice);
      const definitions = [
        [field("Empty text"), "TEXT", { kind: "SCALAR", value: "Ada Lovelace" }],
        [field("Empty email"), "EMAIL", { kind: "SCALAR", value: "ada@example.test" }],
        [field("Empty telephone"), "TEL", { kind: "SCALAR", value: "+1 555 0100" }],
        [field("Empty URL"), "URL", { kind: "SCALAR", value: "https://portfolio.example.test" }],
        [field("Empty textarea"), "TEXTAREA", { kind: "SCALAR", value: "Carefully reviewed response." }],
        [select, "SELECT_ONE", { kind: "OPTIONS", optionKeys: [selectedChoice.key] }],
        [field("Occupied text"), "TEXT", { kind: "SCALAR", value: "MUST-NOT-OVERWRITE" }]
      ] as const;
      const eligibleFields = definitions.map(([candidate, fieldType, proposal]) => Object.freeze({
        stepKey: `fill:${ATTEMPT_ID}:${candidate.normalizedFieldKey}`,
        normalizedFieldKey: candidate.normalizedFieldKey,
        fieldFingerprint: candidate.fieldFingerprint,
        fieldType,
        proposal: proposal.kind === "OPTIONS"
          ? Object.freeze({
              kind: "OPTIONS" as const,
              optionKeys: Object.freeze([proposal.optionKeys[0]]) as readonly [string]
            })
          : Object.freeze({ kind: "SCALAR" as const, value: proposal.value })
      }));
      serverFieldOrder.push(...eligibleFields.map((candidate) => candidate.normalizedFieldKey));
      acquisition = Object.freeze({
        attemptId: ATTEMPT_ID,
        runStateVersion: 8,
        leaseExpiresAt: LEASE_EXPIRES_AT,
        formInspectionVersion: 2,
        answerPacketVersion: 3,
        packetHash: "d".repeat(64),
        formFingerprint: normalized.formFingerprint,
        eligibleFields: Object.freeze(eligibleFields)
      });
      packetPublished = true;
      return {
        replayed: false,
        run: { id: RUN_ID, state: "REVIEW_REQUIRED" as const, stateVersion: 8 },
        current: { inspectionVersion: 2, answerPacketVersion: 3 }
      };
    },
    async acquireFillAttempt(input: unknown, assertReadyToDispatch: () => void) {
      acquisitionCount += 1;
      assert.deepEqual(input, { runId: RUN_ID, expectedStateVersion: 7 });
      assertReadyToDispatch();
      assert.ok(acquisition);
      return acquisition;
    },
    async getFillAttemptStatus(runId: string) {
      fillStatusReads += 1;
      assert.equal(runId, RUN_ID);
      return liveStatus();
    },
    async finalizeFillAttempt(
      input: BrowserFillFinalizeInput,
      assertReadyToDispatch: () => void
    ) {
      assertReadyToDispatch();
      finalization = structuredClone(input);
      return Object.freeze({
        state: "READY_FOR_USER_SUBMISSION" as const,
        stateVersion: input.expectedStateVersion + 1,
        fillAttemptId: input.fillAttemptId,
        fillLeaseExpiresAt: null,
        leaseLive: false,
        expiredRecoveryRequired: false,
        fieldOperationAllowed: false,
        outcome: input.outcome,
        errorCode: input.errorCode,
        steps: input.steps
      });
    },
    async recoverExpiredFillAttempt(): Promise<never> {
      throw new Error("live user activation must not recover");
    }
  } satisfies SameOriginClientWithFill;

  let closePromise: Promise<void> | null = null;
  const coordinator = new ApplicationBrowserCoordinator({
    configuredApplyPilotOrigin: CONTROL_ORIGIN,
    immutableRunId: RUN_ID,
    client,
    openTarget: (input, assertActive) => targetController.open(input, assertActive),
    initializeFormInspectionController({ authoritativeApplyHost }) {
      const target = targetController.formInspectionTarget();
      assert.ok(target);
      formController = createApplicationFormInspectionController({
        target,
        authoritativeApplyHost,
        onInvalidated(code) {
          void coordinatorRef.current?.handleFormInspectionInvalidation(code);
        }
      });
    },
    getFormInspectionPort() {
      if (formController === null) return null;
      return Object.freeze({
        inspect: () => formController!.inspect(),
        assertCurrent: (generationId: symbol) => formController!.assertCurrent(generationId),
        currentTargetUrl: () => targetController.formInspectionTarget()?.currentTargetUrl() ?? null,
        assertAcquiredFillAuthority: (generationId, authority) =>
          formController!.assertAcquiredFillAuthority(generationId, authority),
        async writeApprovedField(generationId, request) {
          writerCalls += 1;
          writerFieldOrder.push(request.normalizedFieldKey);
          writersInFlight += 1;
          maxWriterConcurrency = Math.max(maxWriterConcurrency, writersInFlight);
          try {
            return await formController!.writeApprovedField(generationId, request);
          } finally {
            writersInFlight -= 1;
          }
        }
      });
    },
    async retireForHuman(assertActive) {
      await formController?.close();
      assertActive();
      await targetController.retireForHuman(CONTROL_ORIGIN, assertActive);
    },
    closeResources() {
      closePromise ??= (async () => {
        await formController?.close();
        await targetController.close();
      })();
      return closePromise;
    }
  });
  coordinatorRef.current = coordinator;

  let bridgeFillCommandCount = 0;
  await installControlBridge({
    controlPage,
    configuredApplyPilotOrigin: CONTROL_ORIGIN,
    immutableRunId: RUN_ID,
    getState: () => coordinator.state(),
    execute(command, assertActive) {
      if (command.type === "FILL_APPROVED_FIELDS") bridgeFillCommandCount += 1;
      return coordinator.handleCommand(command, assertActive);
    },
    onTrustLost: (code) => coordinator.safeStop(code)
  });
  coordinator.markControlReady();

  try {
    await invoke(controlPage, { type: "OPEN_TARGET" });
    const inspection = await invoke(controlPage, { type: "INSPECT_FORM" }) as {
      inspection?: { outcome?: string };
    };
    assert.equal(inspection.inspection?.outcome, "SUCCEEDED");
    await assert.rejects(
      invoke(controlPage, { type: "FILL_APPROVED_FIELDS", proposal: "private" }),
      /Invalid B1 command/i
    );

    const employerPage = targetController.page();
    assert.ok(employerPage);
    const originalEmployerUrl = employerPage.url();
    let navigation = 0;
    let popup = 0;
    let upload = 0;
    let syntheticSubmissionRequest = 0;
    employerPage.on("framenavigated", (frame) => {
      if (frame === employerPage.mainFrame()) navigation += 1;
    });
    employerPage.on("popup", () => { popup += 1; });
    employerPage.on("filechooser", () => { upload += 1; });
    employerContext.on("request", (request) => {
      if (request.url().includes("/__apply_pilot_submit")) syntheticSubmissionRequest += 1;
    });

    await controlPage.locator("#fill-approved-fields").click({ clickCount: 2 });
    await controlPage.waitForFunction(() => window.__userFillState?.settled === true);
    const controlState = await controlPage.evaluate(() => window.__userFillState!);

    assert.equal(controlState.activationCount, 1);
    assert.equal(controlState.error, null);
    assert.deepEqual(controlState.result, {
      state: "TARGET_OPEN",
      runId: RUN_ID,
      targetHost: TARGET_HOST,
      inspection: {
        outcome: "SUCCEEDED",
        replayed: false,
        inspectionVersion: 2,
        answerPacketVersion: 3,
        reinspectionRequired: false
      },
      fillCommand: { outcome: "FINALIZED" }
    });
    assert.equal(JSON.stringify(controlState.result).includes(ATTEMPT_ID), false);
    assert.equal(JSON.stringify(controlState.result).includes("Ada Lovelace"), false);
    assert.equal(bridgeFillCommandCount, 1);
    assert.equal(acquisitionCount, 1);
    assert.equal(writerCalls, 7);
    assert.equal(maxWriterConcurrency, 1);
    assert.deepEqual(writerFieldOrder, serverFieldOrder);
    assert.equal(new Set(writerFieldOrder).size, 7);
    assert.ok(fillStatusReads >= 8);

    const acquired = acquisition as BrowserFillAcquisition | null;
    assert.ok(acquired);
    assert.deepEqual(
      new Set(acquired.eligibleFields.map((field) => field.fieldType)),
      new Set(["TEXT", "EMAIL", "TEL", "URL", "TEXTAREA", "SELECT_ONE"])
    );
    const recordedFinalization = finalization as BrowserFillFinalizeInput | null;
    assert.ok(recordedFinalization);
    assert.deepEqual(
      recordedFinalization.steps.map((step) => step.stepKey),
      acquired.eligibleFields.map((field) => field.stepKey)
    );
    assert.deepEqual(
      recordedFinalization.steps.map((step) => step.result),
      ["FILLED", "FILLED", "FILLED", "FILLED", "FILLED", "FILLED", "PRESERVED_EXISTING"]
    );

    assert.equal(await employerPage.locator("#text-empty").inputValue(), "Ada Lovelace");
    assert.equal(await employerPage.locator("#email-empty").inputValue(), "ada@example.test");
    assert.equal(await employerPage.locator("#tel-empty").inputValue(), "+1 555 0100");
    assert.equal(await employerPage.locator("#url-empty").inputValue(), "https://portfolio.example.test");
    assert.equal(await employerPage.locator("#textarea-empty").inputValue(), "Carefully reviewed response.");
    assert.equal(await employerPage.locator("#select-empty").inputValue(), "SECRET-A");
    assert.equal(await employerPage.locator("#text-occupied").inputValue(), "SECRET-OCCUPIED-TEXT");
    assert.equal(await employerPage.locator("#radio-a").isChecked(), false);
    assert.equal(await employerPage.locator("#radio-b").isChecked(), false);
    assert.equal(await employerPage.locator("#checkbox-unchecked").isChecked(), false);
    assert.equal(await employerPage.locator("#checkbox-checked").isChecked(), true);
    assert.equal(employerPage.url(), originalEmployerUrl);

    const localTraps = await employerPage.evaluate(() => window.__formFillTraps!);
    const traps: FormFillTrapSnapshot = {
      ...localTraps,
      navigation,
      popup,
      syntheticSubmissionRequest
    };
    assert.deepEqual(traps.eventLog, [
      "text-empty:input",
      "email-empty:input",
      "tel-empty:input",
      "url-empty:input",
      "textarea-empty:input",
      "select-empty:input",
      "select-empty:change"
    ]);
    assert.equal(traps.input, 6);
    assert.equal(traps.change, 1);
    assert.equal(traps.click, 0);
    assert.equal(traps.focus, 0);
    assert.equal(traps.keyboard, 0);
    assert.equal(traps.pointer, 0);
    assert.equal(traps.mouse, 0);
    assert.equal(upload, 0);
    assert.equal(navigation, 0);
    assert.equal(popup, 0);
    assertNoSubmission(traps);
    assert.deepEqual(unsafeCodes, []);

    const handoff = await invoke(controlPage, { type: "HANDOFF_TO_HUMAN" }) as B1Status;
    assert.equal(handoff.state, "HUMAN_ONLY");
    assert.deepEqual(handoff.fillCommand, { outcome: "FINALIZED" });
    assert.equal(targetController.formInspectionTarget(), null);
    assert.equal(employerPage.isClosed(), false);
    assert.equal(await employerPage.locator("#text-empty").inputValue(), "Ada Lovelace");
    assert.equal(await employerPage.locator("#select-empty").inputValue(), "SECRET-A");
    await assert.rejects(coordinator.handleCommand({ type: "FILL_APPROVED_FIELDS" }, () => undefined));
    assert.equal(acquisitionCount, 1);
    assert.equal(writerCalls, 7);
  } finally {
    await coordinator.close().catch(() => undefined);
    await employerContext.close().catch(() => undefined);
    await context.close().catch(() => undefined);
  }
});
