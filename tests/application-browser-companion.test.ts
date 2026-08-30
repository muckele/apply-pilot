import assert from "node:assert/strict";
import { test } from "node:test";

import { runApplicationBrowserCompanion } from "@/scripts/application-browser-companion";

const RUN_ID = "clz8w7m9a0002qwer1234tyui";
const APP_ORIGIN = "https://apply.example.com";
const CONTROL_URL = `${APP_ORIGIN}/application-runs/${RUN_ID}/browser`;
const TARGET_URL = "https://jobs.example.test/apply?posting=123";

test("companion owns one exact-page inspection controller and closes controller, target, runtime", async () => {
  const calls: string[] = [];
  const employerPage = {
    url: () => `${TARGET_URL}#current`,
    isClosed: () => false
  };
  const mainFrame = {};
  const controlPage = {
    url: () => CONTROL_URL,
    mainFrame: () => mainFrame,
    on: () => undefined,
    async goto() { return null; }
  };
  let execute!: (command: { type: string }, assertActive: () => void) => Promise<Record<string, unknown>>;
  const report = { schemaVersion: "application-form-inspection.v1", forms: [] } as never;
  const generationId = Symbol("owned-generation");

  const running = runApplicationBrowserCompanion(
    ["--app-origin", APP_ORIGIN, "--run-id", RUN_ID],
    {
      async launchRuntime() {
        return {
          context: { request: {} },
          controlPage,
          async close() { calls.push("runtime-close"); }
        };
      },
      createClient: () => ({
        async getApplicationRun() {
          return { id: RUN_ID, state: "READY", stateVersion: 2, applyHost: "jobs.example.test", applyUrlSnapshot: TARGET_URL };
        },
        async getAutomationPolicy() {
          return { effectiveEnabled: true, allowedHosts: ["jobs.example.test"], blockedHosts: [] };
        },
        async getCurrentAnswerPacket() { return { runId: RUN_ID, current: null }; },
        async publishFormInspection(_input: unknown, assertReadyToDispatch: () => void) {
          assertReadyToDispatch();
          return { replayed: true, run: { id: RUN_ID, state: "READY", stateVersion: 3 }, current: { inspectionVersion: 1, answerPacketVersion: 1 } };
        }
      }),
      createTargetController: () => ({
        async open() { calls.push("target-open"); return { finalUrl: TARGET_URL }; },
        page: () => employerPage,
        async close() { calls.push("target-close"); }
      }),
      createFormInspectionController(input: Record<string, unknown>) {
        calls.push("controller-create");
        assert.equal(input.page, employerPage);
        assert.equal(input.authoritativeApplyHost, "jobs.example.test");
        return {
          async inspect() { return { generationId, inspectionReport: report }; },
          current: () => null,
          async assertCurrent() { return { generationId, inspectionReport: report }; },
          async close() { calls.push("controller-close"); }
        };
      },
      async installBridge(input: Record<string, unknown>) {
        execute = input.execute as typeof execute;
      },
      writeOutput: () => undefined
    } as never
  );

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(typeof execute, "function");
  const opened = await execute({ type: "OPEN_TARGET" }, () => undefined);
  assert.equal(opened.state, "TARGET_OPEN");
  assert.deepEqual(calls.slice(0, 2), ["target-open", "controller-create"]);
  const inspected = await execute({ type: "INSPECT_FORM" }, () => undefined);
  assert.deepEqual((inspected as { inspection?: unknown }).inspection, {
    outcome: "SUCCEEDED",
    replayed: true,
    inspectionVersion: 1,
    answerPacketVersion: 1,
    reinspectionRequired: false
  });
  await execute({ type: "CLOSE_WORKFLOW" }, () => undefined);
  await running;
  assert.deepEqual(calls.slice(-3), ["controller-close", "target-close", "runtime-close"]);
  assert.equal(calls.filter((call) => call === "controller-create").length, 1);
});

test("companion cleanup attempts every stage and retains the first failure", async () => {
  const calls: string[] = [];
  const firstError = new Error("controller cleanup failed first");
  const employerPage = { url: () => TARGET_URL, isClosed: () => false };
  const mainFrame = {};
  const controlPage = {
    url: () => CONTROL_URL,
    mainFrame: () => mainFrame,
    on: () => undefined,
    async goto() { return null; }
  };
  let execute!: (command: { type: string }, assertActive: () => void) => Promise<Record<string, unknown>>;
  const running = runApplicationBrowserCompanion(
    ["--app-origin", APP_ORIGIN, "--run-id", RUN_ID],
    {
      async launchRuntime() {
        return {
          context: { request: {} },
          controlPage,
          async close() { calls.push("runtime-close"); }
        };
      },
      createClient: () => ({
        async getApplicationRun() { return { id: RUN_ID, state: "READY", stateVersion: 1, applyHost: "jobs.example.test", applyUrlSnapshot: TARGET_URL }; },
        async getAutomationPolicy() { return { effectiveEnabled: true, allowedHosts: ["jobs.example.test"], blockedHosts: [] }; },
        async getCurrentAnswerPacket() { throw new Error("unexpected packet read"); },
        async publishFormInspection() { throw new Error("unexpected publication"); }
      }),
      createTargetController: () => ({
        async open() { return { finalUrl: TARGET_URL }; },
        page: () => employerPage,
        async close() { calls.push("target-close"); throw new Error("later target cleanup failure"); }
      }),
      createFormInspectionController: () => ({
        async inspect() { throw new Error("unexpected inspection"); },
        current: () => null,
        async assertCurrent() { throw new Error("unexpected currentness assertion"); },
        async close() { calls.push("controller-close"); throw firstError; }
      }),
      async installBridge(input: Record<string, unknown>) { execute = input.execute as typeof execute; },
      writeOutput: () => undefined
    } as never
  );

  await new Promise<void>((resolve) => setImmediate(resolve));
  await execute({ type: "OPEN_TARGET" }, () => undefined);
  const [closeResult, runResult] = await Promise.allSettled([
    execute({ type: "CLOSE_WORKFLOW" }, () => undefined),
    running
  ]);
  assert.equal(closeResult.status, "rejected");
  assert.equal(runResult.status, "rejected");
  if (closeResult.status === "rejected") assert.equal(closeResult.reason, firstError);
  if (runResult.status === "rejected") assert.equal(runResult.reason, firstError);
  assert.deepEqual(calls, ["controller-close", "target-close", "runtime-close"]);
});
