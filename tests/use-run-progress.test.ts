import "@/tests/fixtures/dom-globals";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";

import { useRunProgress } from "@/components/apply-page/use-run-progress";
import { createDomHarness } from "@/tests/fixtures/dom-harness";

function Probe({ runId }: { runId: string | null }) {
  const run = useRunProgress(runId, { state: "READY", companionState: null });
  return React.createElement("p", { "data-state": "" }, run?.state ?? "none");
}

const runResponse = (state: string) => new Response(JSON.stringify({ run: { state } }));
const settle = () => act(async () => { await new Promise((resolve) => setImmediate(resolve)); });

test("refetches only when the tab becomes visible", async () => {
  const urls: string[] = [];
  let state = "READY";
  const fetchStub = (async (input: RequestInfo | URL) => { urls.push(String(input)); return runResponse(state); }) as typeof fetch;
  const harness = createDomHarness({ fetch: fetchStub });
  try {
    await harness.render(React.createElement(Probe, { runId: "run-1" }));
    await settle();
    assert.deepEqual(urls, ["/api/application-runs/run-1"]);
    const setVisibility = (value: string) => Object.defineProperty(harness.window.document, "visibilityState", { configurable: true, value });
    setVisibility("hidden");
    await act(async () => { harness.window.document.dispatchEvent(new harness.window.Event("visibilitychange")); });
    await settle();
    assert.equal(urls.length, 1, "hidden does not refetch");
    state = "FILLING";
    setVisibility("visible");
    await act(async () => { harness.window.document.dispatchEvent(new harness.window.Event("visibilitychange")); });
    await settle();
    assert.equal(urls.length, 2);
    await harness.waitForText(/FILLING/u);
  } finally {
    await harness.close();
  }
});

test("a failed read keeps the last known value and no run id means no fetch", async () => {
  let calls = 0;
  const harness = createDomHarness({ fetch: (async () => { calls += 1; throw new Error("offline"); }) as typeof fetch });
  try {
    await harness.render(React.createElement(Probe, { runId: "run-1" }));
    await settle();
    assert.equal(harness.text(), "READY");
    await harness.render(React.createElement(Probe, { runId: null }));
    assert.equal(calls, 1);
  } finally {
    await harness.close();
  }
});

test("never calls setInterval or setTimeout", async () => {
  const harness = createDomHarness({ fetch: (async () => runResponse("READY")) as typeof fetch });
  const realInterval = globalThis.setInterval;
  const realTimeout = globalThis.setTimeout;
  const calls: string[] = [];
  globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => { calls.push(new Error().stack ?? ""); return realInterval(...args); }) as typeof setInterval;
  globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => { calls.push(new Error().stack ?? ""); return realTimeout(...args); }) as typeof setTimeout;
  try {
    await harness.render(React.createElement(Probe, { runId: "run-1" }));
    await settle();
    Object.defineProperty(harness.window.document, "visibilityState", { configurable: true, value: "visible" });
    await act(async () => { harness.window.document.dispatchEvent(new harness.window.Event("visibilitychange")); });
    await settle();
    // React and the harness may schedule their own timers; the hook must not.
    assert.deepEqual(calls.filter((stack) => stack.includes("use-run-progress")), []);
  } finally {
    globalThis.setInterval = realInterval;
    globalThis.setTimeout = realTimeout;
    await harness.close();
  }
});
