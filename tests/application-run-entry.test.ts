import assert from "node:assert/strict";
import test from "node:test";

import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";

import { ApplicationRunEntry } from "@/components/application-run-entry";
import { ensureApplicationRun } from "@/lib/application-runs/client-run";

const APPLICATION_ID = "clz8w7m9a0000qwer1234tyui";
const RUN_ID = "clz8w7m9a0004qwer1234tyui";

type FetchHandler = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function createdResponse(state = "DRAFT", id = RUN_ID) {
  return new Response(JSON.stringify({
    run: { id, applicationId: APPLICATION_ID, state }, replayed: false
  }), { status: 201, headers: { "content-type": "application/json" } });
}

async function mountEntry(
  initialRun: { id: string; state: string } | null,
  handler: FetchHandler,
  existingDom?: JSDOM
) {
  const dom = existingDom ?? new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", {
    url: `https://app.example.com/applications/${APPLICATION_ID}`
  });
  const container = dom.window.document.getElementById("root");
  assert.ok(container);
  const globals = {
    window: dom.window,
    self: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    Event: dom.window.Event,
    MouseEvent: dom.window.MouseEvent,
    sessionStorage: dom.window.sessionStorage,
    IS_REACT_ACT_ENVIRONMENT: true
  };
  const prior = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries(globals)) {
    prior.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  let windowConfirms = 0;
  Object.defineProperty(dom.window, "confirm", { configurable: true, value: () => { windowConfirms += 1; return true; } });
  const fetchCalls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  const priorFetch = Object.getOwnPropertyDescriptor(globalThis, "fetch");
  Object.defineProperty(globalThis, "fetch", {
    configurable: true, writable: true,
    value: (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls.push({ input, init });
      return handler(input, init);
    }
  });
  let refreshes = 0;
  const router = { back() {}, forward() {}, push() {}, replace() {}, prefetch() {}, refresh() { refreshes += 1; } };
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(AppRouterContext.Provider, { value: router as never },
      createElement(ApplicationRunEntry, { applicationId: APPLICATION_ID, initialRun })));
  });
  return {
    dom, container, fetchCalls, get refreshes() { return refreshes; }, get windowConfirms() { return windowConfirms; },
    async clickCreate() {
      const button = container.querySelector<HTMLButtonElement>("button[data-testid='create-browser-run']");
      assert.ok(button);
      await act(async () => { button.click(); });
    },
    async cleanup(preserveDom = false) {
      await act(async () => { root.unmount(); });
      if (priorFetch) Object.defineProperty(globalThis, "fetch", priorFetch);
      else Reflect.deleteProperty(globalThis, "fetch");
      for (const [name, descriptor] of prior) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
      if (!preserveDom) dom.window.close();
    }
  };
}

test("existing owned run shows its real state and browser link without creating on render", async () => {
  const mounted = await mountEntry({ id: RUN_ID, state: "DRAFT" }, async () => {
    throw new Error("render must not call an API");
  });
  try {
    assert.match(mounted.container.textContent ?? "", /DRAFT/);
    assert.match(mounted.container.textContent ?? "", /does not open or submit/i);
    assert.doesNotMatch(mounted.container.textContent ?? "", /ready to fill/i);
    assert.equal(mounted.container.querySelector("[data-testid='create-browser-run']"), null);
    assert.equal(
      mounted.container.querySelector<HTMLAnchorElement>("a[data-testid='open-browser-run']")?.getAttribute("href"),
      `/application-runs/${RUN_ID}/browser`
    );
    assert.equal(mounted.fetchCalls.length, 0);
  } finally { await mounted.cleanup(); }
});

test("one deliberate click uses only the existing run POST and presents returned DRAFT", async () => {
  const mounted = await mountEntry(null, async () => createdResponse());
  try {
    assert.equal(mounted.fetchCalls.length, 0);
    assert.match(mounted.container.textContent ?? "", /Create browser run/);
    await mounted.clickCreate();
    assert.equal(mounted.fetchCalls.length, 1);
    assert.equal(String(mounted.fetchCalls[0].input), "/api/application-runs");
    assert.equal(mounted.fetchCalls[0].init?.method, "POST");
    const body = JSON.parse(String(mounted.fetchCalls[0].init?.body));
    assert.deepEqual(Object.keys(body).sort(), ["applicationId", "idempotencyKey"]);
    assert.equal(body.applicationId, APPLICATION_ID);
    assert.match(body.idempotencyKey, /^[a-f0-9-]{36}$/);
    assert.equal(mounted.container.querySelector<HTMLAnchorElement>("a[data-testid='open-browser-run']")?.getAttribute("href"), `/application-runs/${RUN_ID}/browser`);
    assert.match(mounted.container.textContent ?? "", /DRAFT/);
    assert.doesNotMatch(mounted.container.textContent ?? "", /ready to fill/i);
  } finally { await mounted.cleanup(); }
});

test("double activation dispatches once; uncertain response retries the same key", async () => {
  const first = deferred<Response>();
  let calls = 0;
  const mounted = await mountEntry(null, async () => {
    calls += 1;
    return calls === 1 ? first.promise : createdResponse();
  });
  try {
    const button = mounted.container.querySelector<HTMLButtonElement>("button[data-testid='create-browser-run']");
    assert.ok(button);
    await act(async () => { button.click(); button.click(); });
    assert.equal(mounted.fetchCalls.length, 1);
    await act(async () => { first.reject(new Error("connection dropped")); await first.promise.catch(() => undefined); });
    assert.match(mounted.container.textContent ?? "", /uncertain/i);
    await mounted.clickCreate();
    assert.equal(mounted.fetchCalls.length, 2);
    const keys = mounted.fetchCalls.map((call) => JSON.parse(String(call.init?.body)).idempotencyKey);
    assert.equal(keys[0], keys[1]);
    assert.equal(mounted.container.querySelector<HTMLAnchorElement>("a[data-testid='open-browser-run']")?.getAttribute("href"), `/application-runs/${RUN_ID}/browser`);
  } finally { await mounted.cleanup(); }
});

test("a lost create response retains its request key across a same-session page remount", async () => {
  const first = await mountEntry(null, async () => { throw new Error("response lost"); });
  let originalKey: string;
  try {
    await first.clickCreate();
    originalKey = JSON.parse(String(first.fetchCalls[0].init?.body)).idempotencyKey as string;
    assert.match(first.container.textContent ?? "", /uncertain/i);
  } finally { await first.cleanup(true); }

  const second = await mountEntry(null, async () => createdResponse(), first.dom);
  try {
    assert.equal(second.fetchCalls.length, 0);
    await second.clickCreate();
    assert.equal(JSON.parse(String(second.fetchCalls[0].init?.body)).idempotencyKey, originalKey);
    assert.equal(second.container.querySelector<HTMLAnchorElement>("a[data-testid='open-browser-run']")?.getAttribute("href"), `/application-runs/${RUN_ID}/browser`);
  } finally { await second.cleanup(); }
});

test("active-run conflict, unauthenticated response, and malformed success do not mint a browser link", async () => {
  for (const response of [
    new Response(JSON.stringify({ error: "Active run" }), { status: 409 }),
    new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }),
    createdResponse("DRAFT", "not-a-run-id")
  ]) {
    const mounted = await mountEntry(null, async () => response.clone());
    try {
      await mounted.clickCreate();
      assert.equal(mounted.container.querySelector("a[data-testid='open-browser-run']"), null);
      assert.equal(mounted.fetchCalls.length, 1);
      assert.ok(mounted.refreshes >= 1);
    } finally { await mounted.cleanup(); }
  }
});

test("no window.confirm: creating a run asks nothing in a browser pop-up", async () => {
  const mounted = await mountEntry(null, async () => createdResponse());
  try {
    await mounted.clickCreate();
    assert.equal(mounted.fetchCalls.length, 1);
    assert.equal(mounted.windowConfirms, 0);
  } finally { await mounted.cleanup(); }
});

// The create-run helper the Apply page and this panel share.

class MemoryStorage {
  private values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

test("ensureApplicationRun keeps its request key until a confirmed run, then clears it", async () => {
  const storage = new MemoryStorage();
  const bodies: Array<{ applicationId: string; idempotencyKey: string }> = [];
  let calls = 0;
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    calls += 1;
    bodies.push(JSON.parse(String(init?.body)));
    if (calls === 1) throw new Error("connection dropped");
    if (calls === 2) return new Response(JSON.stringify({ error: "busy" }), { status: 503 });
    return createdResponse();
  }) as typeof fetch;
  await assert.rejects(ensureApplicationRun(APPLICATION_ID, { fetchImpl, storage }), (error: Error & { kind?: string }) => error.kind === "uncertain");
  const key = storage.getItem(`application-run-create:${APPLICATION_ID}`);
  assert.match(key ?? "", /^[a-f0-9-]{36}$/);
  await assert.rejects(ensureApplicationRun(APPLICATION_ID, { fetchImpl, storage }), (error: Error & { kind?: string }) => error.kind === "refused");
  assert.deepEqual(await ensureApplicationRun(APPLICATION_ID, { fetchImpl, storage }), { id: RUN_ID, state: "DRAFT", applyHost: null });
  assert.deepEqual(bodies.map((body) => body.idempotencyKey), [key, key, key]);
  assert.deepEqual(bodies.map((body) => Object.keys(body).sort()), Array(3).fill(["applicationId", "idempotencyKey"]));
  assert.equal(storage.getItem(`application-run-create:${APPLICATION_ID}`), null);
});

test("ensureApplicationRun sends nothing without session storage, and refuses another application's run", async () => {
  let calls = 0;
  const fetchImpl = (async () => { calls += 1; return createdResponse(); }) as typeof fetch;
  await assert.rejects(ensureApplicationRun(APPLICATION_ID, { fetchImpl, storage: null }), (error: Error & { kind?: string }) => error.kind === "storage");
  assert.equal(calls, 0);

  const other = (async () => new Response(JSON.stringify({
    run: { id: RUN_ID, applicationId: "clz8w7m9a0009qwer1234tyui", state: "DRAFT" }, replayed: false
  }), { status: 201 })) as typeof fetch;
  await assert.rejects(ensureApplicationRun(APPLICATION_ID, { fetchImpl: other, storage: new MemoryStorage() }), (error: Error & { kind?: string }) => error.kind === "uncertain");

  // A replay of a run that has since ended is not a run to use: its key is dropped for a fresh request.
  for (const state of ["CANCELLED", "COMPLETED_BY_USER"]) {
    const storage = new MemoryStorage();
    const ended = (async () => createdResponse(state)) as typeof fetch;
    await assert.rejects(ensureApplicationRun(APPLICATION_ID, { fetchImpl: ended, storage }), (error: Error & { kind?: string }) => error.kind === "ended");
    assert.equal(storage.getItem(`application-run-create:${APPLICATION_ID}`), null, state);
  }

  for (const [status, kind] of [[409, "conflict"], [401, "unauthorized"], [403, "unauthorized"]] as const) {
    const refused = (async () => new Response(JSON.stringify({ error: "no" }), { status })) as typeof fetch;
    await assert.rejects(ensureApplicationRun(APPLICATION_ID, { fetchImpl: refused, storage: new MemoryStorage() }), (error: Error & { kind?: string }) => error.kind === kind);
  }
});
