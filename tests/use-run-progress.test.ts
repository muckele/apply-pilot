import "@/tests/fixtures/dom-globals";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";

import { useRunProgress } from "@/components/apply-page/use-run-progress";
import { createDomHarness } from "@/tests/fixtures/dom-harness";

function Probe({ runId, initialState = "READY" }: { runId: string | null; initialState?: string }) {
  const run = useRunProgress(runId, { state: initialState, companionState: null });
  return React.createElement("p", null, run?.state ?? "none");
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

const fireVisible = async (harness: ReturnType<typeof createDomHarness>) => {
  Object.defineProperty(harness.window.document, "visibilityState", { configurable: true, value: "visible" });
  await act(async () => { harness.window.document.dispatchEvent(new harness.window.Event("visibilitychange")); });
};

test("a new run id uses its own initial state, even when its read fails", async () => {
  const harness = createDomHarness({ fetch: (async (input: RequestInfo | URL) => {
    if (String(input).endsWith("run-a")) return runResponse("CANCELLED");
    throw new Error("offline");
  }) as typeof fetch });
  try {
    await harness.render(React.createElement(Probe, { runId: "run-a" }));
    await settle();
    await harness.waitForText(/CANCELLED/u);
    await harness.render(React.createElement(Probe, { runId: "run-b", initialState: "REVIEW_REQUIRED" }));
    await settle();
    assert.equal(harness.text(), "REVIEW_REQUIRED");
  } finally {
    await harness.close();
  }
});

test("the later read wins when responses arrive out of order", async () => {
  const resolvers: Array<(response: Response) => void> = [];
  const harness = createDomHarness({ fetch: (() => new Promise<Response>((resolve) => { resolvers.push(resolve); })) as typeof fetch });
  try {
    await harness.render(React.createElement(Probe, { runId: "run-1" }));
    await fireVisible(harness);
    assert.equal(resolvers.length, 2);
    await act(async () => { resolvers[1](runResponse("FILLING")); await new Promise((resolve) => setImmediate(resolve)); });
    await act(async () => { resolvers[0](runResponse("READY_FOR_USER_SUBMISSION")); await new Promise((resolve) => setImmediate(resolve)); });
    assert.equal(harness.text(), "FILLING");
  } finally {
    await harness.close();
  }
});

test("a response after unmount changes nothing and logs no warning", async () => {
  let resolve!: (response: Response) => void;
  const harness = createDomHarness({ fetch: (() => new Promise<Response>((r) => { resolve = r; })) as typeof fetch });
  const errors: unknown[][] = [];
  const realError = console.error;
  console.error = (...args: unknown[]) => { errors.push(args); };
  try {
    await harness.render(React.createElement(Probe, { runId: "run-1" }));
    await harness.render(React.createElement("p", null, "gone"));
    await act(async () => { resolve(runResponse("FILLING")); await new Promise((r) => setImmediate(r)); });
    assert.equal(harness.text(), "gone");
    assert.deepEqual(errors, []);
  } finally {
    console.error = realError;
    await harness.close();
  }
});

test("visibilitychange after unmount or with no run id makes no fetch", async () => {
  let calls = 0;
  const harness = createDomHarness({ fetch: (async () => { calls += 1; return runResponse("READY"); }) as typeof fetch });
  try {
    await harness.render(React.createElement(Probe, { runId: "run-1" }));
    await settle();
    assert.equal(calls, 1);
    await harness.render(React.createElement(Probe, { runId: null }));
    await fireVisible(harness);
    await settle();
    assert.equal(calls, 1, "runId null removed the listener");
    await harness.render(React.createElement("p", null, "gone"));
    await fireVisible(harness);
    assert.equal(calls, 1, "unmount removed the listener");
  } finally {
    await harness.close();
  }
});
