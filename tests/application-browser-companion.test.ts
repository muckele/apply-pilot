import assert from "node:assert/strict";
import { test } from "node:test";

import { runApplicationBrowserCompanion } from "@/scripts/application-browser-companion";

const RUN_ID = "clz8w7m9a0002qwer1234tyui";
const APP_ORIGIN = "https://apply.example.com";
const CONTROL_URL = `${APP_ORIGIN}/application-runs/${RUN_ID}/browser`;
const TARGET_URL = "https://jobs.example.test/apply?posting=123";

test("companion owns one protected target inspection controller and closes controller, target, runtime", async () => {
  const calls: string[] = [];
  const protectedTarget = Object.freeze({
    authority: Object.freeze({}),
    currentTargetUrl: () => `${TARGET_URL}#current`,
    subscribeMainFrameNavigation: () => () => undefined
  });
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
  const attemptId = "550e8400-e29b-41d4-a716-446655440000";
  const fieldKey = "a".repeat(64);
  const fieldFingerprint = "b".repeat(64);
  const formFingerprint = "c".repeat(64);
  const stepKey = `fill:${attemptId}:${fieldKey}`;
  let packetReads = 0;
  const liveFillStatus = {
    state: "FILLING" as const,
    stateVersion: 3,
    fillAttemptId: attemptId,
    fillLeaseExpiresAt: "2099-09-10T20:10:00.000Z",
    leaseLive: true,
    expiredRecoveryRequired: false,
    fieldOperationAllowed: true,
    outcome: null,
    errorCode: null,
    steps: []
  };

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
        async getCurrentAnswerPacket() {
          return {
            runId: RUN_ID,
            current: packetReads++ === 0
              ? null
              : { inspectionVersion: 1, answerPacketVersion: 1 }
          };
        },
        async publishFormInspection(_input: unknown, assertReadyToDispatch: () => void) {
          assertReadyToDispatch();
          return { replayed: true, run: { id: RUN_ID, state: "READY", stateVersion: 3 }, current: { inspectionVersion: 1, answerPacketVersion: 1 } };
        },
        async acquireFillAttempt(_input: unknown, assertReadyToDispatch: () => void) {
          calls.push("fill-acquire");
          assertReadyToDispatch();
          return {
            attemptId,
            runStateVersion: 3,
            leaseExpiresAt: liveFillStatus.fillLeaseExpiresAt,
            formInspectionVersion: 1,
            answerPacketVersion: 1,
            packetHash: "d".repeat(64),
            formFingerprint,
            eligibleFields: [{
              stepKey,
              normalizedFieldKey: fieldKey,
              fieldFingerprint,
              fieldType: "TEXT" as const,
              proposal: { kind: "SCALAR" as const, value: "private-proposal-sentinel" }
            }]
          };
        },
        async getFillAttemptStatus() {
          return structuredClone(liveFillStatus);
        },
        async finalizeFillAttempt(_input: unknown, assertReadyToDispatch: () => void) {
          calls.push("fill-finalize");
          assertReadyToDispatch();
          return {
            ...liveFillStatus,
            state: "READY_FOR_USER_SUBMISSION" as const,
            stateVersion: 4,
            fillLeaseExpiresAt: null,
            leaseLive: false,
            fieldOperationAllowed: false,
            outcome: "COMPLETED" as const,
            steps: [{ stepKey, result: "FILLED" as const, errorCode: null }]
          };
        },
        async recoverExpiredFillAttempt(): Promise<never> {
          throw new Error("unexpected recovery");
        }
      }),
      createTargetController: () => ({
        async open() { calls.push("target-open"); return { finalUrl: TARGET_URL }; },
        formInspectionTarget: () => protectedTarget,
        async close() { calls.push("target-close"); }
      }),
      createFormInspectionController(input: Record<string, unknown>) {
        calls.push("controller-create");
        assert.equal(input.target, protectedTarget);
        assert.equal("page" in input, false);
        assert.equal(input.authoritativeApplyHost, "jobs.example.test");
        return {
          async inspect() { return { generationId, inspectionReport: report }; },
          current: () => null,
          async assertCurrent() { return { generationId, inspectionReport: report }; },
          assertAcquiredFillAuthority(id: symbol) {
            assert.equal(id, generationId);
            calls.push("fill-authority-bound");
          },
          async writeApprovedField(id: symbol) {
            assert.equal(id, generationId);
            calls.push("fill-write");
            return { status: "FILLED" as const };
          },
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
  const filled = await execute({ type: "FILL_APPROVED_FIELDS" }, () => undefined);
  assert.deepEqual((filled as { fillCommand?: unknown }).fillCommand, { outcome: "FINALIZED" });
  assert.equal(calls.filter((call) => call === "fill-acquire").length, 1);
  assert.deepEqual(
    calls.filter((call) => call.startsWith("fill-")),
    ["fill-acquire", "fill-authority-bound", "fill-write", "fill-finalize"]
  );
  await execute({ type: "CLOSE_WORKFLOW" }, () => undefined);
  await running;
  assert.deepEqual(calls.slice(-3), ["controller-close", "target-close", "runtime-close"]);
  assert.equal(calls.filter((call) => call === "controller-create").length, 1);
});

test("companion fails closed when a successfully opened target has no protected inspection facade", async () => {
  const calls: string[] = [];
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
        async getApplicationRun() {
          return { id: RUN_ID, state: "READY", stateVersion: 2, applyHost: "jobs.example.test", applyUrlSnapshot: TARGET_URL };
        },
        async getAutomationPolicy() {
          return { effectiveEnabled: true, allowedHosts: ["jobs.example.test"], blockedHosts: [] };
        },
        async getCurrentAnswerPacket() { throw new Error("unexpected packet read"); },
        async publishFormInspection() { throw new Error("unexpected publication"); }
      }),
      createTargetController: () => ({
        async open() { calls.push("target-open"); return { finalUrl: TARGET_URL }; },
        formInspectionTarget: () => null,
        async close() { calls.push("target-close"); }
      }),
      createFormInspectionController() {
        calls.push("unexpected-controller-create");
        throw new Error("unexpected controller creation");
      },
      async installBridge(input: Record<string, unknown>) {
        execute = input.execute as typeof execute;
      },
      writeOutput: () => undefined
    } as never
  );

  await new Promise<void>((resolve) => setImmediate(resolve));
  await assert.rejects(
    execute({ type: "OPEN_TARGET" }, () => undefined),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "BROWSER_WORKFLOW_FAILED"
  );
  assert.deepEqual(calls, ["target-open"]);
  await execute({ type: "CLOSE_WORKFLOW" }, () => undefined);
  await running;
  assert.deepEqual(calls, ["target-open", "target-close", "runtime-close"]);
});

test("companion cleanup attempts every stage and retains the first failure", async () => {
  const calls: string[] = [];
  const firstError = new Error("controller cleanup failed first");
  const protectedTarget = {
    authority: {},
    currentTargetUrl: () => TARGET_URL,
    subscribeMainFrameNavigation: () => () => undefined
  };
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
        formInspectionTarget: () => protectedTarget,
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
