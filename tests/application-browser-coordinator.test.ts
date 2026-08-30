import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ApplicationBrowserCoordinator,
  createSafeBrowserDiagnostic
} from "@/lib/application-browser/coordinator";
import {
  launchApplicationBrowserRuntimeWithLauncherForTest,
  MISSING_CHROMIUM_MESSAGE
} from "@/lib/application-browser/browser-runtime";
import {
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
    { type: 1 },
    null
  ]) {
    assert.throws(() => parseB1Command(invalid), /B1 command/i);
  }
});

test("coordinator opens only the immutable run's frozen, policy-allowed READY target", async () => {
  const calls: string[] = [];
  let openedTarget = "";
  const coordinator = new ApplicationBrowserCoordinator({
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
