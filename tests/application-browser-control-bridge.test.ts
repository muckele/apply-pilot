import assert from "node:assert/strict";
import { test } from "node:test";

import { createControlBridgeInvocationHandler } from "@/lib/application-browser/control-bridge";
import {
  ApplicationBrowserCoordinator,
  ApplicationBrowserError
} from "@/lib/application-browser/coordinator";

const RUN_ID = "clz8w7m9a0002qwer1234tyui";
const ORIGIN = "https://apply.example.com";
const PATH = `/application-runs/${RUN_ID}/browser`;

function fixture() {
  const frame = {
    currentUrl: `${ORIGIN}${PATH}`,
    detached: false,
    url() { return this.currentUrl; },
    isDetached() { return this.detached; }
  };
  const page = { mainFrame: () => frame };
  const calls: string[] = [];
  const bridge = createControlBridgeInvocationHandler({
    controlPage: page,
    configuredApplyPilotOrigin: ORIGIN,
    immutableRunId: RUN_ID,
    getState: () => "CONTROL_READY",
    async execute(command, assertActive) {
      assertActive();
      calls.push(command.type);
      return { state: "CONTROL_READY", runId: RUN_ID };
    }
  });
  return { bridge, frame, page, calls };
}

async function terminalInspectionBridgeFixture(input: Readonly<{
  inspectionError: Error;
  cleanupError?: Error;
}>) {
  const frame = { url: () => `${ORIGIN}${PATH}`, isDetached: () => false };
  const page = { mainFrame: () => frame };
  const generationId = Symbol("terminal-inspection-generation");
  const inspectionReport = { schemaVersion: "application-form-inspection.v1", forms: [] } as never;
  let cleanupCalls = 0;
  let publicationCalls = 0;
  const coordinator = new ApplicationBrowserCoordinator({
    configuredApplyPilotOrigin: ORIGIN,
    immutableRunId: RUN_ID,
    client: {
      async getApplicationRun() {
        return {
          id: RUN_ID,
          state: "READY",
          stateVersion: 1,
          applyHost: "jobs.example.test",
          applyUrlSnapshot: "https://jobs.example.test/apply"
        };
      },
      async getAutomationPolicy() {
        return { effectiveEnabled: true, allowedHosts: ["jobs.example.test"], blockedHosts: [] };
      },
      async getCurrentAnswerPacket() { return { runId: RUN_ID, current: null }; },
      async publishFormInspection() {
        publicationCalls += 1;
        return {
          replayed: false,
          run: { id: RUN_ID, state: "READY", stateVersion: 2 },
          current: { inspectionVersion: 1, answerPacketVersion: 1 }
        };
      }
    },
    async openTarget() { return { finalUrl: "https://jobs.example.test/apply" }; },
    initializeFormInspectionController() {},
    getFormInspectionPort: () => ({
      async inspect() { throw input.inspectionError; },
      async assertCurrent() { return { generationId, inspectionReport }; },
      currentTargetUrl: () => "https://jobs.example.test/apply"
    }),
    async closeResources() {
      cleanupCalls += 1;
      if (input.cleanupError) throw input.cleanupError;
    }
  });
  coordinator.markControlReady();
  await coordinator.handleCommand({ type: "OPEN_TARGET" }, () => undefined);
  const bridge = createControlBridgeInvocationHandler({
    controlPage: page,
    configuredApplyPilotOrigin: ORIGIN,
    immutableRunId: RUN_ID,
    getState: () => coordinator.state(),
    execute: (command, assertActive) => coordinator.handleCommand(command, assertActive),
    onCommandError: () => coordinator.safeStop("CONTROL_COMMAND_FAILED")
  });
  return {
    bridge,
    coordinator,
    frame,
    page,
    cleanupCalls: () => cleanupCalls,
    publicationCalls: () => publicationCalls
  };
}

test("trusted main-frame invocation accepts only strict B1 commands", async () => {
  const { bridge, frame, page, calls } = fixture();
  const result = await bridge.invoke({ page, frame }, { type: "GET_STATUS" });
  assert.deepEqual(result, { state: "CONTROL_READY", runId: RUN_ID });
  assert.deepEqual(calls, ["GET_STATUS"]);
  await assert.rejects(
    bridge.invoke({ page, frame }, { type: "OPEN_TARGET", url: "https://attacker.example" }),
    /B1 command/i
  );
});

test("binding rejects wrong page, child frame, and detached main frame", async () => {
  const { bridge, frame, page } = fixture();
  await assert.rejects(bridge.invoke({ page: {}, frame }, { type: "GET_STATUS" }), /control page/i);
  await assert.rejects(
    bridge.invoke({ page, frame: { url: frame.url, isDetached: () => false } }, { type: "GET_STATUS" }),
    /main frame/i
  );
  frame.detached = true;
  await assert.rejects(bridge.invoke({ page, frame }, { type: "GET_STATUS" }), /detached/i);
});

test("binding rejects wrong origin, path, run ID, query, and pre-trust route", async () => {
  for (const [name, url] of [
    ["origin", `https://attacker.example${PATH}`],
    ["path", `${ORIGIN}/dashboard`],
    ["run", `${ORIGIN}/application-runs/clz8w7m9a0003qwer1234tyui/browser`],
    ["query", `${ORIGIN}${PATH}?run=${RUN_ID}`],
    ["login", `${ORIGIN}/login`]
  ]) {
    const { bridge, frame, page, calls } = fixture();
    frame.currentUrl = url;
    await assert.rejects(bridge.invoke({ page, frame }, { type: "GET_STATUS" }), /trusted control route/i, name);
    assert.deepEqual(calls, []);
  }
});

test("stale generation and command-invalid state fail closed", async () => {
  const { bridge, frame, page } = fixture();
  bridge.invalidate();
  await assert.rejects(bridge.invoke({ page, frame }, { type: "GET_STATUS" }), /generation/i);

  const denied = createControlBridgeInvocationHandler({
    controlPage: page,
    configuredApplyPilotOrigin: ORIGIN,
    immutableRunId: RUN_ID,
    getState: () => "STARTING",
    async execute() { throw new Error("must not execute"); }
  });
  await assert.rejects(denied.invoke({ page, frame }, { type: "OPEN_TARGET" }), /not allowed/i);
});

test("callback/navigation race revalidates after the invocation yield", async () => {
  const { bridge, frame, page, calls } = fixture();
  const pending = bridge.invoke({ page, frame }, { type: "GET_STATUS" });
  frame.currentUrl = "https://attacker.example/after-callback-start";
  await assert.rejects(pending, /trusted control route/i);
  assert.deepEqual(calls, []);
});

test("top-level trust loss invalidates synchronously and is never reinstalled", async () => {
  const { bridge, frame, page, calls } = fixture();
  bridge.handleTopLevelNavigation();
  frame.currentUrl = `${ORIGIN}${PATH}`;
  await assert.rejects(bridge.invoke({ page, frame }, { type: "GET_STATUS" }), /generation/i);
  assert.deepEqual(calls, []);
});

test("command execution failure invalidates the generation and invokes safe stop", async () => {
  const frame = {
    url: () => `${ORIGIN}${PATH}`,
    isDetached: () => false
  };
  const page = { mainFrame: () => frame };
  let stopCalls = 0;
  const bridge = createControlBridgeInvocationHandler({
    controlPage: page,
    configuredApplyPilotOrigin: ORIGIN,
    immutableRunId: RUN_ID,
    getState: () => "CONTROL_READY",
    async execute() {
      throw new Error("target failed");
    },
    async onCommandError() {
      stopCalls += 1;
    }
  });

  await assert.rejects(bridge.invoke({ page, frame }, { type: "OPEN_TARGET" }), /target failed/i);
  assert.equal(stopCalls, 1);
  await assert.rejects(bridge.invoke({ page, frame }, { type: "GET_STATUS" }), /generation/i);
});

test("terminal INSPECT_FORM dependency errors cross the real bridge only as bounded failures", async () => {
  const privateError = Object.assign(
    new Error("PRIVATE_SENTINEL employer data"),
    { code: "SECRET_VENDOR_CODE" }
  );
  const fixture = await terminalInspectionBridgeFixture({ inspectionError: privateError });

  await assert.rejects(
    fixture.bridge.invoke({ page: fixture.page, frame: fixture.frame }, { type: "INSPECT_FORM" }),
    (error: unknown) => {
      assert.ok(error instanceof ApplicationBrowserError);
      assert.notEqual(error, privateError);
      assert.equal(error.code, "BROWSER_WORKFLOW_FAILED");
      assert.equal(error.message, "The form inspection command failed safely.");
      assert.doesNotMatch(error.message, /PRIVATE_SENTINEL/);
      assert.notEqual(error.code, "SECRET_VENDOR_CODE");
      assert.doesNotMatch(String(error.stack), /PRIVATE_SENTINEL|SECRET_VENDOR_CODE/);
      return true;
    }
  );
  assert.deepEqual(fixture.coordinator.status(), {
    state: "ERROR",
    runId: RUN_ID,
    targetHost: "jobs.example.test",
    errorCode: "BROWSER_WORKFLOW_FAILED"
  });
  assert.equal(fixture.cleanupCalls(), 1);
  assert.equal(fixture.publicationCalls(), 0);
  assert.equal(fixture.bridge.isActive(), false);
  await assert.rejects(
    fixture.bridge.invoke({ page: fixture.page, frame: fixture.frame }, { type: "GET_STATUS" }),
    /generation/i
  );
});

test("terminal INSPECT_FORM cleanup rejection cannot replace the bounded bridge failure", async () => {
  const privateError = Object.assign(
    new Error("PRIVATE_SENTINEL employer data"),
    { code: "SECRET_VENDOR_CODE" }
  );
  const cleanupError = new Error("PRIVATE_CLEANUP_SENTINEL");
  const fixture = await terminalInspectionBridgeFixture({
    inspectionError: privateError,
    cleanupError
  });

  await assert.rejects(
    fixture.bridge.invoke({ page: fixture.page, frame: fixture.frame }, { type: "INSPECT_FORM" }),
    (error: unknown) => {
      assert.ok(error instanceof ApplicationBrowserError);
      assert.notEqual(error, privateError);
      assert.notEqual(error, cleanupError);
      assert.equal(error.code, "BROWSER_WORKFLOW_FAILED");
      assert.equal(error.message, "The form inspection command failed safely.");
      assert.doesNotMatch(
        `${error.message}\n${String(error.stack)}`,
        /PRIVATE_SENTINEL|SECRET_VENDOR_CODE|PRIVATE_CLEANUP_SENTINEL/
      );
      return true;
    }
  );
  assert.equal(fixture.coordinator.state(), "ERROR");
  assert.equal(fixture.coordinator.status().errorCode, "BROWSER_WORKFLOW_FAILED");
  assert.equal(fixture.cleanupCalls(), 1);
  assert.equal(fixture.publicationCalls(), 0);
  assert.equal(fixture.bridge.isActive(), false);
});

test("recoverable INSPECT_FORM results keep the trusted bridge generation active", async () => {
  const frame = { url: () => `${ORIGIN}${PATH}`, isDetached: () => false };
  const page = { mainFrame: () => frame };
  let attempts = 0;
  const bridge = createControlBridgeInvocationHandler({
    controlPage: page,
    configuredApplyPilotOrigin: ORIGIN,
    immutableRunId: RUN_ID,
    getState: () => "TARGET_OPEN",
    async execute(command, assertActive) {
      assertActive();
      if (command.type === "INSPECT_FORM") {
        attempts += 1;
        return attempts === 1
          ? { state: "TARGET_OPEN", runId: RUN_ID, inspection: { outcome: "FAILED", errorCode: "RUN_DOCUMENT_STALE", retryAllowed: true } }
          : { state: "TARGET_OPEN", runId: RUN_ID, inspection: { outcome: "SUCCEEDED", replayed: true, inspectionVersion: 2, answerPacketVersion: 3, reinspectionRequired: false } };
      }
      return { state: "TARGET_OPEN", runId: RUN_ID };
    }
  });

  const recoverable = await bridge.invoke({ page, frame }, { type: "INSPECT_FORM" });
  assert.equal(recoverable.inspection?.outcome, "FAILED");
  assert.deepEqual(await bridge.invoke({ page, frame }, { type: "GET_STATUS" }), {
    state: "TARGET_OPEN",
    runId: RUN_ID
  });
  assert.equal((await bridge.invoke({ page, frame }, { type: "INSPECT_FORM" })).inspection?.outcome, "SUCCEEDED");
  await assert.rejects(
    bridge.invoke({ page, frame }, { type: "INSPECT_FORM", runId: RUN_ID }),
    /B1 command/i
  );
});

test("trust invalidation during a long-running INSPECT_FORM suppresses late success", async () => {
  const frame = { url: () => `${ORIGIN}${PATH}`, isDetached: () => false };
  const page = { mainFrame: () => frame };
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let stopCalls = 0;
  const bridge = createControlBridgeInvocationHandler({
    controlPage: page,
    configuredApplyPilotOrigin: ORIGIN,
    immutableRunId: RUN_ID,
    getState: () => "TARGET_OPEN",
    async execute(_command, assertActive) {
      await gate;
      assertActive();
      return {
        state: "TARGET_OPEN",
        runId: RUN_ID,
        inspection: { outcome: "SUCCEEDED", replayed: false, inspectionVersion: 1, answerPacketVersion: 1, reinspectionRequired: false }
      };
    },
    async onCommandError() { stopCalls += 1; }
  });

  const pending = bridge.invoke({ page, frame }, { type: "INSPECT_FORM" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  bridge.handleTopLevelNavigation();
  release();
  await assert.rejects(pending, /generation/i);
  assert.equal(stopCalls, 1);
  assert.equal(bridge.isActive(), false);
});
