import assert from "node:assert/strict";
import { test } from "node:test";

import { createControlBridgeInvocationHandler } from "@/lib/application-browser/control-bridge";

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
