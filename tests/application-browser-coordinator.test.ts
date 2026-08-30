import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ApplicationBrowserCoordinator,
  ApplicationBrowserError,
  createSafeBrowserDiagnostic
} from "@/lib/application-browser/coordinator";
import {
  launchApplicationBrowserRuntimeWithLauncherForTest,
  MISSING_CHROMIUM_MESSAGE
} from "@/lib/application-browser/browser-runtime";
import {
  BROWSER_INSPECTION_RECOVERABLE_CODES,
  isB1CommandAllowed,
  parseApplyPilotOrigin,
  parseB1Command,
  parseImmutableRunId
} from "@/lib/application-browser/types";
import * as companionModule from "@/scripts/application-browser-companion";

const RUN_ID = "clz8w7m9a0002qwer1234tyui";
const APP_ORIGIN = "https://apply.example.com";
const CONTROL_URL = `${APP_ORIGIN}/application-runs/${RUN_ID}/browser`;
const UNEXPECTED_B23A_CLIENT_METHODS = {
  async getCurrentAnswerPacket() {
    throw new Error("unexpected answer-packet read");
  },
  async publishFormInspection() {
    throw new Error("unexpected form-inspection publication");
  }
} as const;
const NO_FORM_INSPECTION = {
  initializeFormInspectionController() {},
  getFormInspectionPort: () => ({
    async inspect() { throw new Error("unexpected form inspection"); },
    async assertCurrent() { throw new Error("unexpected currentness assertion"); },
    currentTargetUrl: () => null
  })
} as const;

const { parseCompanionArguments } = companionModule;

type CompanionRunner = (
  args: string[],
  dependencies: Record<string, unknown>
) => Promise<void>;

function getCompanionRunner(): CompanionRunner {
  const candidate = (companionModule as unknown as Record<string, unknown>).runApplicationBrowserCompanion;
  assert.equal(typeof candidate, "function", "the companion orchestration entry point must be injectable");
  return candidate as CompanionRunner;
}

function idempotentCloseCounter() {
  let closed = false;
  let count = 0;
  return {
    async close() {
      if (closed) return;
      closed = true;
      count += 1;
    },
    count: () => count
  };
}

test("companion arguments require exactly one valid immutable run identity", () => {
  assert.throws(() => parseCompanionArguments(["--app-origin", APP_ORIGIN]), /run-id/i);
  assert.throws(
    () => parseCompanionArguments(["--app-origin", APP_ORIGIN, "--run-id", "not-a-cuid"]),
    /run ID/i
  );
  assert.throws(
    () =>
      parseCompanionArguments([
        "--app-origin",
        APP_ORIGIN,
        "--run-id",
        RUN_ID,
        "--run-id",
        "clz8w7m9a0003qwer1234tyui"
      ]),
    /exactly once/i
  );

  const parsed = parseCompanionArguments([
    "--app-origin",
    `${APP_ORIGIN}/`,
    "--run-id",
    RUN_ID
  ]);
  assert.deepEqual(parsed, { configuredApplyPilotOrigin: APP_ORIGIN, immutableRunId: RUN_ID });
  assert.equal(Object.isFrozen(parsed), true);
  assert.equal(parseImmutableRunId(RUN_ID), RUN_ID);
});

test("Apply Pilot origin parsing permits HTTPS and explicit loopback HTTP only", () => {
  assert.equal(parseApplyPilotOrigin("https://apply.example.com/"), APP_ORIGIN);
  assert.equal(parseApplyPilotOrigin("http://localhost:3000"), "http://localhost:3000");
  assert.equal(parseApplyPilotOrigin("http://127.0.0.1:4100"), "http://127.0.0.1:4100");
  assert.equal(parseApplyPilotOrigin("http://[::1]:4100"), "http://[::1]:4100");

  for (const invalid of [
    "http://apply.example.com",
    "https://user:pass@apply.example.com",
    "https://apply.example.com/other",
    "https://apply.example.com?run=other",
    "https://apply.example.com#fragment"
  ]) {
    assert.throws(() => parseApplyPilotOrigin(invalid), /Apply Pilot origin/i, invalid);
  }
});

test("the B1 command parser accepts only the closed no-payload union", () => {
  assert.deepEqual(parseB1Command({ type: "GET_STATUS" }), { type: "GET_STATUS" });
  assert.deepEqual(parseB1Command({ type: "OPEN_TARGET" }), { type: "OPEN_TARGET" });
  assert.deepEqual(parseB1Command({ type: "CLOSE_WORKFLOW" }), { type: "CLOSE_WORKFLOW" });
  assert.deepEqual(parseB1Command({ type: "INSPECT_FORM" }), { type: "INSPECT_FORM" });

  for (const invalid of [
    { type: "CLICK" },
    { type: "SUBMIT" },
    { type: "FILL" },
    { type: "UPLOAD" },
    { type: "REQUEST" },
    { type: "KEYBOARD" },
    { type: "EVALUATE" },
    { type: "OPEN_TARGET", url: "https://attacker.example" },
    { type: "OPEN_TARGET", runId: "clz8w7m9a0003qwer1234tyui" },
    { type: "GET_STATUS", extra: true },
    { type: "INSPECT_FORM", runId: RUN_ID },
    { type: "INSPECT_FORM", url: "https://jobs.example.test/apply" },
    { type: "INSPECT_FORM", observedUrl: "https://jobs.example.test/apply" },
    { type: "INSPECT_FORM", expectedStateVersion: 1 },
    { type: "INSPECT_FORM", inspectionReport: {} },
    { type: "INSPECT_FORM", fields: [] },
    { type: 1 },
    null
  ]) {
    assert.throws(() => parseB1Command(invalid), /B1 command/i);
  }
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test("INSPECT_FORM is single-flight, privately sequenced, and publishes fresh authority", async () => {
  const calls: string[] = [];
  const generationId = Symbol("private-generation");
  const report = { schemaVersion: "application-form-inspection.v1", forms: [] } as never;
  const inspectionGate = deferred<{ generationId: symbol; inspectionReport: never }>();
  let inspectionPort: {
    inspect(): Promise<{ generationId: symbol; inspectionReport: never }>;
    assertCurrent(id: symbol): Promise<{ generationId: symbol; inspectionReport: never }>;
    currentTargetUrl(): string | null;
  } | null = null;
  let runRead = 0;
  let published: Record<string, unknown> | undefined;
  const coordinator = new ApplicationBrowserCoordinator({
    ...NO_FORM_INSPECTION,
    configuredApplyPilotOrigin: APP_ORIGIN,
    immutableRunId: RUN_ID,
    client: {
      async getApplicationRun() {
        runRead += 1;
        calls.push(`run:${runRead}`);
        return {
          id: RUN_ID,
          state: "READY",
          stateVersion: runRead === 1 ? 7 : 8,
          applyHost: "jobs.example.test",
          applyUrlSnapshot: "https://jobs.example.test/apply?posting=123#fresh"
        };
      },
      async getAutomationPolicy() {
        calls.push("policy");
        return { effectiveEnabled: true, allowedHosts: ["jobs.example.test"], blockedHosts: [] };
      },
      async getCurrentAnswerPacket() {
        calls.push("packet");
        return { runId: RUN_ID, current: { inspectionVersion: 4, answerPacketVersion: 6 } };
      },
      async publishFormInspection(input: Record<string, unknown>, assertReadyToDispatch: () => void) {
        calls.push("publish-callback");
        assertReadyToDispatch();
        published = input as unknown as Record<string, unknown>;
        calls.push("publish");
        return {
          replayed: false,
          run: { id: RUN_ID, state: "READY", stateVersion: 9 },
          current: { inspectionVersion: 5, answerPacketVersion: 7 }
        };
      }
    },
    async openTarget() {
      calls.push("open");
      return { finalUrl: "https://jobs.example.test/apply?posting=123#opened" };
    },
    initializeFormInspectionController({ authoritativeApplyHost }: { authoritativeApplyHost: string }) {
      calls.push(`initialize:${authoritativeApplyHost}`);
      inspectionPort = {
        async inspect() {
          calls.push("inspect");
          return inspectionGate.promise;
        },
        async assertCurrent(id) {
          calls.push("assert-current");
          assert.equal(id, generationId);
          return { generationId, inspectionReport: report };
        },
        currentTargetUrl() {
          return "https://jobs.example.test/apply?posting=123#current";
        }
      };
    },
    getFormInspectionPort: () => inspectionPort,
    async closeResources() {}
  } as never);

  coordinator.markControlReady();
  await coordinator.handleCommand({ type: "OPEN_TARGET" }, () => undefined);
  calls.length = 0;
  runRead = 0;
  const primary = coordinator.handleCommand({ type: "INSPECT_FORM" } as never, () => undefined);
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(coordinator.status().inspection, { outcome: "IN_PROGRESS" });
  const secondary = await coordinator.handleCommand({ type: "INSPECT_FORM" } as never, () => undefined);
  assert.deepEqual(secondary.inspection, {
    outcome: "FAILED",
    errorCode: "FORM_INSPECTION_IN_PROGRESS",
    retryAllowed: true
  });
  assert.deepEqual(coordinator.status().inspection, { outcome: "IN_PROGRESS" });

  inspectionGate.resolve({ generationId, inspectionReport: report });
  const result = await primary;
  assert.deepEqual(calls, [
    "run:1",
    "policy",
    "inspect",
    "run:2",
    "packet",
    "policy",
    "assert-current",
    "publish-callback",
    "publish"
  ]);
  assert.deepEqual(published, {
    runId: RUN_ID,
    freshRunState: "READY",
    expectedStateVersion: 8,
    expectedFormInspectionVersion: 4,
    expectedAnswerPacketVersion: 6,
    observedUrl: "https://jobs.example.test/apply?posting=123#current",
    inspectionReport: report
  });
  assert.deepEqual(result.inspection, {
    outcome: "SUCCEEDED",
    replayed: false,
    inspectionVersion: 5,
    answerPacketVersion: 7,
    reinspectionRequired: false
  });
  assert.equal("inspectionReport" in result, false);
  assert.equal(JSON.stringify(result).includes("posting=123"), false);
});

test("inspection invalidation is monotonic and PAGE_CLOSED is terminal", async () => {
  let releaseCleanup!: () => void;
  const cleanup = new Promise<void>((resolve) => { releaseCleanup = resolve; });
  const coordinator = new ApplicationBrowserCoordinator({
    configuredApplyPilotOrigin: APP_ORIGIN,
    immutableRunId: RUN_ID,
    client: {
      ...UNEXPECTED_B23A_CLIENT_METHODS,
      async getApplicationRun() { throw new Error("unexpected"); },
      async getAutomationPolicy() { throw new Error("unexpected"); }
    },
    async openTarget() { throw new Error("unexpected"); },
    initializeFormInspectionController() {},
    getFormInspectionPort: () => null,
    async closeResources() { await cleanup; }
  } as never);

  coordinator.handleFormInspectionInvalidation("REINSPECTION_REQUIRED");
  assert.equal(coordinator.status().inspection, undefined);
  const stopping = coordinator.handleFormInspectionInvalidation("PAGE_CLOSED");
  assert.equal(coordinator.state(), "ERROR");
  assert.equal(coordinator.status().errorCode, "TARGET_PAGE_CLOSED");
  coordinator.handleFormInspectionInvalidation("TARGET_NAVIGATED");
  assert.equal(coordinator.state(), "ERROR");
  releaseCleanup();
  await stopping;
  await coordinator.close();
  assert.equal(coordinator.state(), "CLOSED");
});

test("INSPECT_FORM authorization is closed to TARGET_OPEN and recoverable codes are exact", () => {
  for (const state of [
    "STARTING",
    "APPLY_PILOT_AUTH_REQUIRED",
    "CONTROL_READY",
    "OPENING_TARGET",
    "ERROR",
    "CLOSED"
  ] as const) {
    assert.equal(isB1CommandAllowed({ type: "INSPECT_FORM" }, state), false, state);
  }
  assert.equal(isB1CommandAllowed({ type: "INSPECT_FORM" }, "TARGET_OPEN"), true);
  assert.deepEqual(BROWSER_INSPECTION_RECOVERABLE_CODES, [
    "FORM_INSPECTION_IN_PROGRESS",
    "FORM_STABILITY_TIMEOUT",
    "FORM_GENERATION_INVALIDATED",
    "FORM_CORRELATION_INVALID",
    "AMBIGUOUS_DUPLICATE_FIELD",
    "FORM_INSPECTION_CANCELLED",
    "FORM_INSPECTION_REQUEST_TOO_LARGE",
    "RUN_LIFECYCLE_STALE",
    "RUN_DOCUMENT_STALE",
    "SAME_ORIGIN_RATE_LIMITED",
    "SAME_ORIGIN_REQUEST_FAILED"
  ]);
});

function createInspectionErrorFixture(publicationError?: Error, publicationWait?: Promise<void>) {
  const generationId = Symbol("fixture-generation");
  let assertedGenerationId = generationId;
  const report = { schemaVersion: "application-form-inspection.v1", forms: [] } as never;
  let cleanupCalls = 0;
  let publicationCalls = 0;
  let currentUrl = "https://jobs.example.test/apply#current";
  const port = {
    async inspect() { return { generationId, inspectionReport: report }; },
    async assertCurrent() { return { generationId: assertedGenerationId, inspectionReport: report }; },
    currentTargetUrl: () => currentUrl
  };
  const coordinator = new ApplicationBrowserCoordinator({
    configuredApplyPilotOrigin: APP_ORIGIN,
    immutableRunId: RUN_ID,
    client: {
      async getApplicationRun() {
        return { id: RUN_ID, state: "READY", stateVersion: 3, applyHost: "jobs.example.test", applyUrlSnapshot: "https://jobs.example.test/apply#fresh" };
      },
      async getAutomationPolicy() {
        return { effectiveEnabled: true, allowedHosts: ["jobs.example.test"], blockedHosts: [] };
      },
      async getCurrentAnswerPacket() { return { runId: RUN_ID, current: null }; },
      async publishFormInspection(_input, assertReadyToDispatch) {
        publicationCalls += 1;
        assertReadyToDispatch();
        if (publicationError) throw publicationError;
        await publicationWait;
        return { replayed: true, run: { id: RUN_ID, state: "READY", stateVersion: 4 }, current: { inspectionVersion: 1, answerPacketVersion: 1 } };
      }
    },
    async openTarget() { return { finalUrl: "https://jobs.example.test/apply#opened" }; },
    initializeFormInspectionController() {},
    getFormInspectionPort: () => port,
    async closeResources() { cleanupCalls += 1; }
  });
  return {
    coordinator,
    cleanupCalls: () => cleanupCalls,
    publicationCalls: () => publicationCalls,
    returnGenerationFromAssertCurrent(value: symbol) { assertedGenerationId = value; },
    setCurrentUrl(value: string) { currentUrl = value; }
  };
}

test("the closed recoverable error set remains TARGET_OPEN without throwing", async () => {
  for (const code of BROWSER_INSPECTION_RECOVERABLE_CODES.slice(1)) {
    const fixture = createInspectionErrorFixture(Object.assign(new Error("bounded failure"), { code }));
    fixture.coordinator.markControlReady();
    await fixture.coordinator.handleCommand({ type: "OPEN_TARGET" }, () => undefined);
    const result = await fixture.coordinator.handleCommand({ type: "INSPECT_FORM" }, () => undefined);
    assert.equal(result.state, "TARGET_OPEN", code);
    assert.equal(result.inspection?.outcome, code === "FORM_GENERATION_INVALIDATED" ? "REINSPECTION_REQUIRED" : "FAILED", code);
    assert.equal(result.inspection && "errorCode" in result.inspection ? result.inspection.errorCode : null, code);
    assert.equal(fixture.cleanupCalls(), 0, code);
  }
});

test("terminal and unknown inspection errors synchronously establish ERROR and preserve first code", async () => {
  for (const [thrownCode, expectedCode] of [
    ["APPLY_PILOT_AUTH_REQUIRED", "APPLY_PILOT_AUTH_REQUIRED"],
    ["SAME_ORIGIN_REDIRECT_REJECTED", "SAME_ORIGIN_REDIRECT_REJECTED"],
    ["CALLER_SUPPLIED_ARBITRARY_CODE", "BROWSER_WORKFLOW_FAILED"],
    [undefined, "BROWSER_WORKFLOW_FAILED"]
  ] as const) {
    const error = thrownCode
      ? Object.assign(new Error("terminal"), { code: thrownCode })
      : new Error("unknown implementation failure");
    const fixture = createInspectionErrorFixture(error);
    fixture.coordinator.markControlReady();
    await fixture.coordinator.handleCommand({ type: "OPEN_TARGET" }, () => undefined);
    await assert.rejects(
      fixture.coordinator.handleCommand({ type: "INSPECT_FORM" }, () => undefined),
      (rejected: unknown) => {
        assert.ok(rejected instanceof ApplicationBrowserError);
        assert.equal(rejected.code, expectedCode);
        assert.equal(rejected.message, "The form inspection command failed safely.");
        assert.notEqual(rejected, error);
        assert.doesNotMatch(rejected.message, /terminal|unknown implementation failure/);
        return true;
      }
    );
    assert.equal(fixture.coordinator.state(), "ERROR");
    assert.equal(fixture.coordinator.status().errorCode, expectedCode);
    assert.equal(fixture.cleanupCalls(), 1);
    await fixture.coordinator.safeStop("LATER_ERROR");
    assert.equal(fixture.coordinator.status().errorCode, expectedCode);
  }
});

test("assertCurrent returning a different generation is a terminal integrity failure", async () => {
  const fixture = createInspectionErrorFixture();
  fixture.returnGenerationFromAssertCurrent(Symbol("impossible-returned-generation"));
  fixture.coordinator.markControlReady();
  await fixture.coordinator.handleCommand({ type: "OPEN_TARGET" }, () => undefined);

  await assert.rejects(
    fixture.coordinator.handleCommand({ type: "INSPECT_FORM" }, () => undefined),
    (error: unknown) => {
      assert.ok(error instanceof ApplicationBrowserError);
      assert.equal(error.code, "BROWSER_WORKFLOW_FAILED");
      assert.equal(error.message, "The form inspection command failed safely.");
      return true;
    }
  );
  assert.equal(fixture.publicationCalls(), 0);
  assert.equal(fixture.coordinator.state(), "ERROR");
  assert.equal(fixture.coordinator.status().errorCode, "BROWSER_WORKFLOW_FAILED");
  assert.equal(fixture.coordinator.status().inspection, undefined);
  assert.equal(fixture.cleanupCalls(), 1);
  await assert.rejects(
    fixture.coordinator.handleCommand({ type: "INSPECT_FORM" }, () => undefined),
    (error: unknown) => error instanceof ApplicationBrowserError && error.code === "COMMAND_NOT_ALLOWED"
  );
});

test("target drift prevents publication and safe-stops before inspecting", async () => {
  const fixture = createInspectionErrorFixture();
  fixture.coordinator.markControlReady();
  await fixture.coordinator.handleCommand({ type: "OPEN_TARGET" }, () => undefined);
  fixture.setCurrentUrl("https://jobs.example.test/other?posting=changed");
  await assert.rejects(
    fixture.coordinator.handleCommand({ type: "INSPECT_FORM" }, () => undefined),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "RUN_TARGET_STALE"
  );
  assert.equal(fixture.coordinator.state(), "ERROR");
  assert.equal(fixture.publicationCalls(), 0);
  assert.equal(fixture.cleanupCalls(), 1);
});

test("invalidation during publication wins persisted status without hiding safe replay metadata", async () => {
  const publicationGate = deferred<void>();
  const fixture = createInspectionErrorFixture(undefined, publicationGate.promise);
  fixture.coordinator.markControlReady();
  await fixture.coordinator.handleCommand({ type: "OPEN_TARGET" }, () => undefined);
  const pending = fixture.coordinator.handleCommand({ type: "INSPECT_FORM" }, () => undefined);
  await new Promise<void>((resolve) => setImmediate(resolve));
  fixture.coordinator.handleFormInspectionInvalidation("TARGET_NAVIGATED");
  publicationGate.resolve();
  const result = await pending;
  assert.deepEqual(result.inspection, {
    outcome: "SUCCEEDED",
    replayed: true,
    inspectionVersion: 1,
    answerPacketVersion: 1,
    reinspectionRequired: true
  });
  assert.deepEqual(fixture.coordinator.status().inspection, {
    outcome: "REINSPECTION_REQUIRED",
    errorCode: "FORM_GENERATION_INVALIDATED",
    retryAllowed: true
  });
});

test("coordinator opens only the immutable run's frozen, policy-allowed READY target", async () => {
  const calls: string[] = [];
  let openedTarget = "";
  const coordinator = new ApplicationBrowserCoordinator({
    ...NO_FORM_INSPECTION,
    configuredApplyPilotOrigin: APP_ORIGIN,
    immutableRunId: RUN_ID,
    client: {
      ...UNEXPECTED_B23A_CLIENT_METHODS,
      async getApplicationRun(runId) {
        calls.push(`run:${runId}`);
        return {
          id: RUN_ID,
          state: "READY",
          stateVersion: 0,
          applyHost: "jobs.example.test",
          applyUrlSnapshot: "https://jobs.example.test/apply?posting=123#intro"
        };
      },
      async getAutomationPolicy() {
        calls.push("policy");
        return {
          effectiveEnabled: true,
          allowedHosts: ["jobs.example.test"],
          blockedHosts: []
        };
      }
    },
    async openTarget(input, assertActive) {
      assertActive();
      openedTarget = input.target.url.toString();
      calls.push(`open:${input.target.host}`);
      return { finalUrl: "https://jobs.example.test/apply?posting=123#finished" };
    },
    async closeResources() {
      calls.push("close");
    }
  });

  coordinator.markControlReady();
  const result = await coordinator.handleCommand({ type: "OPEN_TARGET" }, () => undefined);

  assert.deepEqual(calls, [`run:${RUN_ID}`, "policy", "open:jobs.example.test"]);
  assert.equal(openedTarget, "https://jobs.example.test/apply?posting=123#intro");
  assert.deepEqual(result, {
    state: "TARGET_OPEN",
    runId: RUN_ID,
    targetHost: "jobs.example.test"
  });
});

test("coordinator rejects alternate run data, invalid state, disabled policy, and stale guards", async () => {
  const scenarios = [
    {
      name: "alternate run",
      run: { id: "clz8w7m9a0003qwer1234tyui", state: "READY", stateVersion: 0, applyHost: "jobs.example.test", applyUrlSnapshot: "https://jobs.example.test/apply" },
      policy: { effectiveEnabled: true, allowedHosts: ["jobs.example.test"], blockedHosts: [] },
      code: "RUN_IDENTITY_MISMATCH"
    },
    {
      name: "invalid state",
      run: { id: RUN_ID, state: "DRAFT", stateVersion: 0, applyHost: "jobs.example.test", applyUrlSnapshot: "https://jobs.example.test/apply" },
      policy: { effectiveEnabled: true, allowedHosts: ["jobs.example.test"], blockedHosts: [] },
      code: "RUN_INVALID_STATE"
    },
    {
      name: "disabled policy",
      run: { id: RUN_ID, state: "READY", stateVersion: 0, applyHost: "jobs.example.test", applyUrlSnapshot: "https://jobs.example.test/apply" },
      policy: { effectiveEnabled: false, allowedHosts: ["jobs.example.test"], blockedHosts: [] },
      code: "AUTOMATION_DISABLED"
    }
  ] as const;

  for (const scenario of scenarios) {
    let openCalls = 0;
    const coordinator = new ApplicationBrowserCoordinator({
      ...NO_FORM_INSPECTION,
      configuredApplyPilotOrigin: APP_ORIGIN,
      immutableRunId: RUN_ID,
      client: {
        ...UNEXPECTED_B23A_CLIENT_METHODS,
        async getApplicationRun() {
          return scenario.run;
        },
        async getAutomationPolicy() {
          return scenario.policy;
        }
      },
      async openTarget() {
        openCalls += 1;
        return { finalUrl: "https://jobs.example.test/apply" };
      },
      async closeResources() {}
    });
    coordinator.markControlReady();
    await assert.rejects(
      coordinator.handleCommand({ type: "OPEN_TARGET" }, () => undefined),
      (error: unknown) =>
        error instanceof Error && "code" in error && error.code === scenario.code,
      scenario.name
    );
    assert.equal(openCalls, 0);
  }

  let clientCalls = 0;
  const stale = new ApplicationBrowserCoordinator({
    ...NO_FORM_INSPECTION,
    configuredApplyPilotOrigin: APP_ORIGIN,
    immutableRunId: RUN_ID,
    client: {
      ...UNEXPECTED_B23A_CLIENT_METHODS,
      async getApplicationRun() {
        clientCalls += 1;
        throw new Error("unexpected");
      },
      async getAutomationPolicy() {
        throw new Error("unexpected");
      }
    },
    async openTarget() {
      throw new Error("unexpected");
    },
    async closeResources() {}
  });
  stale.markControlReady();
  await assert.rejects(
    stale.handleCommand({ type: "OPEN_TARGET" }, () => {
      throw new Error("Bridge generation is stale.");
    }),
    /stale/i
  );
  assert.equal(clientCalls, 0);
});

test("coordinator enforces command state and idempotent close", async () => {
  let closeCalls = 0;
  const coordinator = new ApplicationBrowserCoordinator({
    ...NO_FORM_INSPECTION,
    configuredApplyPilotOrigin: APP_ORIGIN,
    immutableRunId: RUN_ID,
    client: {
      ...UNEXPECTED_B23A_CLIENT_METHODS,
      async getApplicationRun() {
        throw new Error("unexpected");
      },
      async getAutomationPolicy() {
        throw new Error("unexpected");
      }
    },
    async openTarget() {
      throw new Error("unexpected");
    },
    async closeResources() {
      closeCalls += 1;
    }
  });

  await assert.rejects(
    coordinator.handleCommand({ type: "OPEN_TARGET" }, () => undefined),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "COMMAND_NOT_ALLOWED"
  );
  coordinator.markControlReady();
  assert.equal((await coordinator.handleCommand({ type: "GET_STATUS" }, () => undefined)).state, "CONTROL_READY");
  await coordinator.close();
  await coordinator.close();
  assert.equal(closeCalls, 1);
  assert.equal(coordinator.status().state, "CLOSED");
});

test("production runtime always requests headed non-persistent Chromium and normalizes missing-browser errors", async () => {
  const launchOptions: Array<Record<string, unknown>> = [];
  let newContextCalls = 0;
  let closeCalls = 0;
  const runtime = await launchApplicationBrowserRuntimeWithLauncherForTest({
    async launch(options) {
      launchOptions.push(options as Record<string, unknown>);
      return {
        async newContext() {
          newContextCalls += 1;
          return {
            async newPage() {
              return { close: async () => undefined };
            },
            async close() {
              closeCalls += 1;
            }
          };
        },
        async close() {
          closeCalls += 1;
        }
      };
    }
  });

  assert.deepEqual(launchOptions, [{ headless: false }]);
  assert.equal("executablePath" in launchOptions[0], false);
  assert.equal(newContextCalls, 1);
  await runtime.close();
  await runtime.close();
  assert.equal(closeCalls, 2);

  await assert.rejects(
    launchApplicationBrowserRuntimeWithLauncherForTest({
      async launch() {
        throw new Error("Executable doesn't exist at /missing/chromium");
      }
    }),
    (error: unknown) => error instanceof Error && error.message === MISSING_CHROMIUM_MESSAGE
  );
  assert.equal(MISSING_CHROMIUM_MESSAGE, "Apply Pilot Chromium is not installed. Run: npm run browser:install");
});

test("companion closes the target controller and runtime when control navigation fails after launch", async () => {
  const runCompanion = getCompanionRunner();
  const runtimeClose = idempotentCloseCounter();
  const targetClose = idempotentCloseCounter();
  const mainFrame = {};
  const controlPage = {
    url: () => CONTROL_URL,
    mainFrame: () => mainFrame,
    on: () => undefined,
    async goto() {
      throw new Error("synthetic control navigation failure");
    }
  };

  await assert.rejects(
    runCompanion(["--app-origin", APP_ORIGIN, "--run-id", RUN_ID], {
      async launchRuntime() {
        return {
          context: { request: {} },
          controlPage,
          close: runtimeClose.close
        };
      },
      createClient: () => ({
        ...UNEXPECTED_B23A_CLIENT_METHODS,
        async getApplicationRun() { throw new Error("unexpected owner read"); },
        async getAutomationPolicy() { throw new Error("unexpected policy read"); }
      }),
      createTargetController: () => ({
        async open() { throw new Error("unexpected target open"); },
        close: targetClose.close
      }),
      async installBridge() {
        throw new Error("unexpected bridge install");
      },
      writeOutput: () => undefined
    }),
    /synthetic control navigation failure/
  );

  assert.equal(targetClose.count(), 1);
  assert.equal(runtimeClose.count(), 1);
});

test("companion proves run ownership before installing a bridge on an exact control URL", async () => {
  const runCompanion = getCompanionRunner();
  const runtimeClose = idempotentCloseCounter();
  const targetClose = idempotentCloseCounter();
  const calls: string[] = [];
  let bindingInstallations = 0;
  const mainFrame = {};
  const controlPage = {
    url: () => CONTROL_URL,
    mainFrame: () => mainFrame,
    on: () => undefined,
    async goto() {
      return null;
    }
  };
  const ownerFailure = Object.assign(new Error("owner-safe run was not found"), {
    code: "SAME_ORIGIN_REQUEST_FAILED"
  });

  await assert.rejects(
    runCompanion(["--app-origin", APP_ORIGIN, "--run-id", RUN_ID], {
      async launchRuntime() {
        return {
          context: { request: {} },
          controlPage,
          close: async () => {
            calls.push("runtime-close");
            await runtimeClose.close();
          }
        };
      },
      createClient: () => ({
        ...UNEXPECTED_B23A_CLIENT_METHODS,
        async getApplicationRun(runId: string) {
          calls.push(`owner:${runId}`);
          throw ownerFailure;
        },
        async getAutomationPolicy() { throw new Error("unexpected policy read"); }
      }),
      createTargetController: () => ({
        async open() { throw new Error("unexpected target open"); },
        close: async () => {
          calls.push("target-close");
          await targetClose.close();
        }
      }),
      async installBridge() {
        bindingInstallations += 1;
        throw new Error("bridge installation must not be reached");
      },
      writeOutput: () => undefined
    }),
    /owner-safe run was not found/
  );

  assert.deepEqual(calls, [`owner:${RUN_ID}`, "target-close", "runtime-close"]);
  assert.equal(bindingInstallations, 0);
  assert.equal(targetClose.count(), 1);
  assert.equal(runtimeClose.count(), 1);
});

test("safe browser diagnostics exclude URLs, response bodies, credentials, and plaintext", () => {
  const diagnostic = createSafeBrowserDiagnostic({
    runId: RUN_ID,
    state: "ERROR",
    operation: "OPEN_TARGET",
    code: "TARGET_NAVIGATION_FAILED",
    host: "jobs.example.test",
    elapsedMs: 25,
    count: 1,
    ignored: "https://jobs.example.test/apply?token=secret resume plaintext password cookie"
  });
  assert.deepEqual(diagnostic, {
    runId: RUN_ID,
    state: "ERROR",
    operation: "OPEN_TARGET",
    code: "TARGET_NAVIGATION_FAILED",
    host: "jobs.example.test",
    elapsedMs: 25,
    count: 1
  });
  assert.equal(JSON.stringify(diagnostic).includes("secret"), false);
});
