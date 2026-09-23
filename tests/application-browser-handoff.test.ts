import assert from "node:assert/strict";
import { test } from "node:test";

import { ApplicationBrowserCoordinator } from "@/lib/application-browser/coordinator";
import { isB1CommandAllowed, parseB1Command } from "@/lib/application-browser/types";

const runId = "clz8w7m9a0002qwer1234tyui";
const targetUrl = "https://jobs.example.test/apply";
const active = () => undefined;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function fixture(input: {
  retire?: () => Promise<void>;
  close?: () => Promise<void>;
  inspect?: () => Promise<never>;
  now?: () => number;
  schedule?: (callback: () => void, delayMs: number) => unknown;
  cancel?: (timer: unknown) => void;
} = {}) {
  let closeCount = 0;
  let retireCount = 0;
  const coordinator = new ApplicationBrowserCoordinator({
    configuredApplyPilotOrigin: "https://apply-pilot.example.test",
    immutableRunId: runId,
    client: {
      async getApplicationRun() {
        return { id: runId, state: "READY", stateVersion: 1, completedAt: null,
          applyHost: "jobs.example.test", applyUrlSnapshot: targetUrl };
      },
      async getAutomationPolicy() {
        return { effectiveEnabled: true, allowedHosts: ["jobs.example.test"], blockedHosts: [] };
      },
      async getCurrentAnswerPacket() { throw new Error("unexpected packet read"); },
      async publishFormInspection() { throw new Error("unexpected publication"); }
    },
    async openTarget() { return { finalUrl: targetUrl }; },
    initializeFormInspectionController() {},
    getFormInspectionPort: () => ({
      currentTargetUrl: () => targetUrl,
      async inspect() { return input.inspect?.() ?? Promise.reject(new Error("unexpected inspection")); },
      async assertCurrent() { throw new Error("unexpected currentness assertion"); }
    }),
    async retireForHuman() { retireCount += 1; await input.retire?.(); },
    async closeResources() { closeCount += 1; await input.close?.(); },
    now: input.now,
    schedule: input.schedule,
    cancel: input.cancel
  } as never);
  return { coordinator, closeCount: () => closeCount, retireCount: () => retireCount };
}

test("handoff commands are payload-free and unavailable outside their exact states", () => {
  assert.deepEqual(parseB1Command({ type: "HANDOFF_TO_HUMAN" }), { type: "HANDOFF_TO_HUMAN" });
  assert.deepEqual(parseB1Command({ type: "END_HUMAN_SESSION" }), { type: "END_HUMAN_SESSION" });
  for (const type of ["HANDOFF_TO_HUMAN", "END_HUMAN_SESSION"]) {
    assert.throws(() => parseB1Command({ type, url: targetUrl }));
  }
  assert.equal(isB1CommandAllowed({ type: "HANDOFF_TO_HUMAN" }, "TARGET_OPEN"), true);
  assert.equal(isB1CommandAllowed({ type: "HANDOFF_TO_HUMAN" }, "HUMAN_ONLY"), true);
  assert.equal(isB1CommandAllowed({ type: "INSPECT_FORM" }, "HUMAN_ONLY"), false);
  assert.equal(isB1CommandAllowed({ type: "FILL_APPROVED_FIELDS" }, "HUMAN_ONLY"), false);
  assert.equal(isB1CommandAllowed({ type: "OPEN_TARGET" }, "HUMAN_ONLY"), false);
  assert.equal(isB1CommandAllowed({ type: "END_HUMAN_SESSION" }, "HUMAN_ONLY"), true);
});

test("handoff fences new commands before retirement settles and never revives Fill", async () => {
  const retirement = deferred();
  const value = fixture({ retire: () => retirement.promise });
  value.coordinator.markControlReady();
  await value.coordinator.handleCommand({ type: "OPEN_TARGET" }, active);
  const pending = value.coordinator.handleCommand({ type: "HANDOFF_TO_HUMAN" }, active);
  assert.equal(value.coordinator.status().state, "HANDOFF_PENDING");
  for (const type of ["INSPECT_FORM", "FILL_APPROVED_FIELDS", "OPEN_TARGET"] as const) {
    await assert.rejects(value.coordinator.handleCommand({ type }, active));
  }
  retirement.resolve();
  assert.equal((await pending).state, "HUMAN_ONLY");
  assert.equal((await value.coordinator.handleCommand({ type: "HANDOFF_TO_HUMAN" }, active)).state, "HUMAN_ONLY");
  assert.equal(value.retireCount(), 1);
  await assert.rejects(value.coordinator.handleCommand({ type: "FILL_APPROVED_FIELDS" }, active));
  await value.coordinator.handleCommand({ type: "END_HUMAN_SESSION" }, active);
  assert.equal(value.closeCount(), 1);
  assert.equal(value.coordinator.status().state, "CLOSED");
});

test("handoff refuses an active inspection without relaxing authority", async () => {
  const inspection = deferred();
  const value = fixture({ inspect: () => inspection.promise as Promise<never> });
  value.coordinator.markControlReady();
  await value.coordinator.handleCommand({ type: "OPEN_TARGET" }, active);
  const pendingInspection = value.coordinator.handleCommand({ type: "INSPECT_FORM" }, active);
  assert.equal(value.coordinator.status().inspection?.outcome, "IN_PROGRESS");
  await assert.rejects(value.coordinator.handleCommand({ type: "HANDOFF_TO_HUMAN" }, active));
  assert.equal(value.coordinator.status().state, "TARGET_OPEN");
  assert.equal(value.retireCount(), 0);
  const closing = value.coordinator.close();
  inspection.resolve();
  await Promise.allSettled([pendingInspection, closing]);
});

test("handoff retirement failure safely closes resources and never enters human navigation", async () => {
  const value = fixture({ retire: async () => { throw new Error("synthetic retirement failure"); } });
  value.coordinator.markControlReady();
  await value.coordinator.handleCommand({ type: "OPEN_TARGET" }, active);
  await assert.rejects(value.coordinator.handleCommand({ type: "HANDOFF_TO_HUMAN" }, active));
  assert.equal(value.closeCount(), 1);
  assert.equal(value.coordinator.status().state, "ERROR");
});

test("human session expires at sixty minutes and close is idempotent", async () => {
  let now = 10_000;
  let expiry: (() => void) | null = null;
  const value = fixture({
    now: () => now,
    schedule(callback, delayMs) { assert.equal(delayMs, 60 * 60 * 1000); expiry = callback; return 1; },
    cancel() { expiry = null; }
  });
  value.coordinator.markControlReady();
  await value.coordinator.handleCommand({ type: "OPEN_TARGET" }, active);
  const status = await value.coordinator.handleCommand({ type: "HANDOFF_TO_HUMAN" }, active);
  assert.equal(status.humanSession?.expiresAtMs, now + 60 * 60 * 1000);
  now += 60 * 60 * 1000;
  assert.ok(expiry);
  (expiry as () => void)();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(value.coordinator.status().state, "CLOSED");
  await value.coordinator.close();
  assert.equal(value.closeCount(), 1);
});

test("failed exact-owned cleanup is reported as uncertain, never as a closed human session", async () => {
  const value = fixture({ close: async () => { throw new Error("synthetic close failure"); } });
  value.coordinator.markControlReady();
  await value.coordinator.handleCommand({ type: "OPEN_TARGET" }, active);
  await value.coordinator.handleCommand({ type: "HANDOFF_TO_HUMAN" }, active);
  const status = await value.coordinator.handleCommand({ type: "END_HUMAN_SESSION" }, active);
  assert.equal(status.state, "ERROR");
  assert.equal(status.errorCode, "HUMAN_SESSION_CLEANUP_UNCERTAIN");
  assert.equal(value.closeCount(), 1);
});

test("concurrent duplicate END commands join one exact-owned close", async () => {
  const cleanup = deferred();
  const value = fixture({ close: () => cleanup.promise });
  value.coordinator.markControlReady();
  await value.coordinator.handleCommand({ type: "OPEN_TARGET" }, active);
  await value.coordinator.handleCommand({ type: "HANDOFF_TO_HUMAN" }, active);
  const first = value.coordinator.handleCommand({ type: "END_HUMAN_SESSION" }, active);
  assert.equal(value.coordinator.state(), "HUMAN_ONLY");
  assert.equal(isB1CommandAllowed({ type: "END_HUMAN_SESSION" }, value.coordinator.state()), true);
  const duplicate = value.coordinator.handleCommand({ type: "END_HUMAN_SESSION" }, active);
  const handoffDuringClose = value.coordinator.handleCommand({ type: "HANDOFF_TO_HUMAN" }, active);
  assert.equal(value.closeCount(), 1);
  cleanup.resolve();
  assert.equal((await first).state, "CLOSED");
  assert.equal((await duplicate).state, "CLOSED");
  assert.equal((await handoffDuringClose).state, "CLOSED");
  assert.equal(value.closeCount(), 1);
});
