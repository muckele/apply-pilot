import assert from "node:assert/strict";
import { test } from "node:test";

import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";

import { ApplicationRunPretrialSetup } from "@/components/application-run-pretrial-setup";
import type { PolicyView, RunView } from "@/components/application-run-pretrial-setup";

const APPLICATION_ID = "clz8w7m9a0000qwer1234tyui";
const RUN_ID = "clz8w7m9a0004qwer1234tyui";
const JOB_ID = "clz8w7m9a0002qwer1234tyui";
const HOST = "jobs.example.com";

function run(overrides: Partial<RunView> = {}): RunView {
  return {
    id: RUN_ID,
    applicationId: APPLICATION_ID,
    state: "DRAFT",
    applyHost: HOST,
    blockingReason: null,
    errorCategory: null,
    ...overrides
  };
}

function policy(overrides: Partial<PolicyView> = {}): PolicyView {
  return {
    enabled: true,
    effectiveEnabled: true,
    mode: "PREPARE_ONLY",
    allowedHosts: [HOST],
    blockedHosts: [],
    ...overrides
  };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

type FetchHandler = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

async function mount(options: {
  initialRun?: ReturnType<typeof run>;
  initialPolicy?: ReturnType<typeof policy>;
  handler?: FetchHandler;
  confirm?: boolean;
} = {}) {
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", {
    url: `https://app.example.com/applications/${APPLICATION_ID}`
  });
  const container = dom.window.document.getElementById("root");
  assert.ok(container);
  const prior = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries({
    window: dom.window,
    self: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    Event: dom.window.Event,
    MouseEvent: dom.window.MouseEvent,
    IS_REACT_ACT_ENVIRONMENT: true
  })) {
    prior.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  let confirmations = 0;
  Object.defineProperty(dom.window, "confirm", { configurable: true, value: () => {
    confirmations += 1;
    return options.confirm ?? true;
  } });
  const fetchCalls: Array<{ input: string; init?: RequestInit }> = [];
  const priorFetch = Object.getOwnPropertyDescriptor(globalThis, "fetch");
  Object.defineProperty(globalThis, "fetch", {
    configurable: true, writable: true,
    value: (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls.push({ input: String(input), init });
      if (!options.handler) throw new Error("No fetch was expected");
      return options.handler(input, init);
    }
  });
  let refreshes = 0;
  const router = { back() {}, forward() {}, push() {}, replace() {}, prefetch() {}, refresh() { refreshes += 1; } };
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(AppRouterContext.Provider, { value: router as never },
      createElement(ApplicationRunPretrialSetup, {
        applicationId: APPLICATION_ID,
        jobPostingId: JOB_ID,
        initialRun: options.initialRun ?? run(),
        initialPolicy: options.initialPolicy ?? policy()
      })));
  });
  return {
    container, fetchCalls,
    get confirmations() { return confirmations; },
    get refreshes() { return refreshes; },
    async click(id: string) {
      const button = container.querySelector<HTMLButtonElement>(`button[data-testid='${id}']`);
      assert.ok(button, `missing ${id}`);
      await act(async () => { button.click(); });
    },
    async cleanup() {
      await act(async () => { root.unmount(); });
      if (priorFetch) Object.defineProperty(globalThis, "fetch", priorFetch);
      else Reflect.deleteProperty(globalThis, "fetch");
      for (const [name, descriptor] of prior) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
      dom.window.close();
    }
  };
}

test("eligible owned DRAFT displays policy and Prepare without a render-time request", async () => {
  const ui = await mount();
  try {
    assert.match(ui.container.textContent ?? "", /DRAFT/);
    assert.match(ui.container.textContent ?? "", /jobs\.example\.com/);
    assert.match(ui.container.textContent ?? "", /PREPARE_ONLY/);
    assert.match(ui.container.textContent ?? "", /host.*allowed/i);
    assert.ok(ui.container.querySelector("[data-testid='prepare-run']"));
    assert.equal(ui.container.querySelector("[data-testid='enable-pretrial']"), null);
    assert.deepEqual(ui.fetchCalls, []);
  } finally { await ui.cleanup(); }
});

test("disabled policy requires confirmation and sends only the run ID for atomic setup", async () => {
  const current = policy({ enabled: false, effectiveEnabled: false, allowedHosts: ["other.example"] });
  const updated = policy({ enabled: true, effectiveEnabled: true, allowedHosts: ["other.example", HOST] });
  const ui = await mount({ initialPolicy: current, handler: async (input, init) => {
    const url = String(input);
    if (url === `/api/application-runs/${RUN_ID}` && init?.method === "GET") return json({ run: run() });
    if (url === "/api/application-automation-policy" && init?.method === "GET") return json(current);
    if (url === "/api/application-automation-policy" && init?.method === "PATCH") return json(updated);
    throw new Error(`Unexpected request: ${url}`);
  } });
  try {
    assert.equal(ui.container.querySelector("[data-testid='prepare-run']"), null);
    await ui.click("enable-pretrial");
    assert.equal(ui.confirmations, 1);
    const patch = ui.fetchCalls.find((call) => call.init?.method === "PATCH");
    assert.ok(patch);
    assert.deepEqual(JSON.parse(String(patch.init?.body)), { enablePretrialForRunId: RUN_ID });
    assert.equal(ui.container.querySelector("[data-testid='prepare-run']") !== null, true);
    assert.equal(ui.fetchCalls.filter((call) => call.init?.method === "POST").length, 0);
  } finally { await ui.cleanup(); }
});

test("cancelled setup confirmation and already allowed policy cause no policy write", async () => {
  const disabled = policy({ enabled: false, effectiveEnabled: false });
  const ui = await mount({ initialPolicy: disabled, confirm: false, handler: async (input, init) => {
    if (String(input) === `/api/application-runs/${RUN_ID}` && init?.method === "GET") return json({ run: run() });
    if (String(input) === "/api/application-automation-policy" && init?.method === "GET") return json(disabled);
    throw new Error("No mutation was authorized");
  } });
  try {
    await ui.click("enable-pretrial");
    assert.equal(ui.confirmations, 1);
    assert.equal(ui.fetchCalls.some((call) => call.init?.method === "PATCH"), false);
  } finally { await ui.cleanup(); }

  const already = await mount();
  try {
    assert.equal(already.container.querySelector("[data-testid='enable-pretrial']"), null);
    assert.deepEqual(already.fetchCalls, []);
  } finally { await already.cleanup(); }
});

test("setup rereads policy and refuses a newly Fill-capable mode without PATCH", async () => {
  const old = policy({ enabled: false, effectiveEnabled: false });
  const changed = policy({ enabled: false, effectiveEnabled: false, mode: "FILL_AND_REVIEW" });
  const ui = await mount({ initialPolicy: old, handler: async (input, init) => {
    if (String(input) === `/api/application-runs/${RUN_ID}` && init?.method === "GET") return json({ run: run() });
    if (String(input) === "/api/application-automation-policy" && init?.method === "GET") return json(changed);
    throw new Error("A stale page must not patch Fill mode");
  } });
  try {
    await ui.click("enable-pretrial");
    assert.equal(ui.confirmations, 0);
    assert.equal(ui.fetchCalls.some((call) => call.init?.method === "PATCH"), false);
    assert.match(ui.container.textContent ?? "", /FILL_AND_REVIEW/);
    assert.equal(ui.container.querySelector("[data-testid='prepare-run']"), null);
  } finally { await ui.cleanup(); }
});

test("policy setup can finish while the global environment gate still denies Prepare", async () => {
  const current = policy({ enabled: false, effectiveEnabled: false, allowedHosts: [] });
  const updated = policy({ enabled: true, effectiveEnabled: false, allowedHosts: [HOST] });
  const ui = await mount({ initialPolicy: current, handler: async (input, init) => {
    if (String(input) === `/api/application-runs/${RUN_ID}` && init?.method === "GET") return json({ run: run() });
    if (String(input) === "/api/application-automation-policy" && init?.method === "GET") return json(current);
    if (String(input) === "/api/application-automation-policy" && init?.method === "PATCH") return json(updated);
    throw new Error("Unexpected request");
  } });
  try {
    await ui.click("enable-pretrial");
    assert.match(ui.container.textContent ?? "", /unavailable in this environment/i);
    assert.equal(ui.container.querySelector("[data-testid='prepare-run']"), null);
    assert.equal(ui.fetchCalls.some((call) => call.init?.method === "POST"), false);
  } finally { await ui.cleanup(); }
});

test("Fill-capable policy is displayed without downgrade or Prepare; disabled global gate also blocks Prepare", async () => {
  for (const initialPolicy of [
    policy({ mode: "FILL_AND_REVIEW" }),
    policy({ effectiveEnabled: false })
  ]) {
    const ui = await mount({ initialPolicy });
    try {
      assert.equal(ui.container.querySelector("[data-testid='prepare-run']"), null);
      assert.equal(ui.container.querySelector("[data-testid='enable-pretrial']"), null);
      assert.equal(ui.fetchCalls.length, 0);
      assert.match(ui.container.textContent ?? "", initialPolicy.mode === "FILL_AND_REVIEW" ? /FILL_AND_REVIEW/ : /unavailable in this environment/i);
    } finally { await ui.cleanup(); }
  }
});

test("one explicit Prepare click sends {} without cost confirmation and reconciles READY or REVIEW_REQUIRED", async () => {
  for (const state of ["READY", "REVIEW_REQUIRED"] as const) {
    const ui = await mount({ handler: async (input, init) => {
      if (String(input) === `/api/application-runs/${RUN_ID}/prepare` && init?.method === "POST") return json({ run: run({ state }) });
      if (String(input) === `/api/application-runs/${RUN_ID}` && init?.method === "GET") return json({ run: run({ state }) });
      throw new Error(`Unexpected request: ${String(input)}`);
    } });
    try {
      assert.equal(ui.fetchCalls.length, 0);
      await ui.click("prepare-run");
      assert.deepEqual(ui.fetchCalls.map((call) => [call.input, call.init?.method]), [
        [`/api/application-runs/${RUN_ID}/prepare`, "POST"],
        [`/api/application-runs/${RUN_ID}`, "GET"]
      ]);
      const sent = ui.fetchCalls[0].init;
      assert.deepEqual(JSON.parse(String(sent?.body)), {});
      assert.equal(new Headers(sent?.headers).has("x-ai-cost-confirmed"), false);
      assert.match(ui.container.textContent ?? "", new RegExp(state));
      assert.equal(ui.container.querySelector("[data-testid='prepare-run']"), null);
      assert.equal(ui.fetchCalls.some((call) => /https?:\/\//.test(call.input) || /browser|employer|fill/i.test(call.input)), false);
    } finally { await ui.cleanup(); }
  }
});

test("rapid duplicate Prepare activation dispatches one POST", async () => {
  const pending = deferred<Response>();
  const ui = await mount({ handler: async (input, init) => {
    if (init?.method === "POST") return pending.promise;
    if (String(input) === `/api/application-runs/${RUN_ID}`) return json({ run: run({ state: "PREPARING" }) });
    throw new Error("Unexpected request");
  } });
  try {
    const button = ui.container.querySelector<HTMLButtonElement>("[data-testid='prepare-run']");
    assert.ok(button);
    await act(async () => { button.click(); button.click(); });
    assert.equal(ui.fetchCalls.filter((call) => call.init?.method === "POST").length, 1);
    await act(async () => { pending.resolve(json({ run: run({ state: "PREPARING" }) })); await pending.promise; });
    assert.match(ui.container.textContent ?? "", /preparation is in progress/i);
    assert.equal(ui.container.querySelector("[data-testid='prepare-run']"), null);
  } finally { await ui.cleanup(); }
});

test("lost Prepare response reads durable state without replay; failed reconciliation disables retry", async () => {
  const ui = await mount({ handler: async (input, init) => {
    if (init?.method === "POST") throw new Error("connection dropped");
    if (String(input) === `/api/application-runs/${RUN_ID}`) return json({ run: run({ state: "PREPARING" }) });
    throw new Error("Unexpected request");
  } });
  try {
    await ui.click("prepare-run");
    assert.deepEqual(ui.fetchCalls.map((call) => call.init?.method), ["POST", "GET"]);
    assert.match(ui.container.textContent ?? "", /preparation is in progress/i);
    assert.equal(ui.container.querySelector("[data-testid='prepare-run']"), null);
  } finally { await ui.cleanup(); }

  const unknown = await mount({ handler: async () => { throw new Error("connection dropped"); } });
  try {
    await unknown.click("prepare-run");
    assert.equal(unknown.fetchCalls.filter((call) => call.init?.method === "POST").length, 1);
    assert.equal(unknown.container.querySelector("[data-testid='prepare-run']"), null);
    assert.ok(unknown.container.querySelector("[data-testid='refresh-run-state']"));
  } finally { await unknown.cleanup(); }
});

test("durable blockers and bounded failures are explained without arbitrary error text", async () => {
  const reasons = [
    "automation_disabled", "host_blocked", "fit_below_threshold",
    "match_confidence_below_threshold", "resume_required", "cover_letter_required",
    "daily_application_cap_reached", "ai_budget_exceeded", "ai_request_cost_limit",
    "ai_cost_confirmation_required", "ai_duplicate_in_progress"
  ];
  for (const reason of reasons) {
    const ui = await mount({ initialRun: run({ state: "BLOCKED", blockingReason: reason }) });
    try {
      assert.match(ui.container.textContent ?? "", /blocked/i, reason);
      assert.doesNotMatch(ui.container.textContent ?? "", /undefined|unknown error/i, reason);
      if (reason === "resume_required" || reason === "cover_letter_required") {
        assert.equal(ui.container.querySelector<HTMLAnchorElement>("a[data-testid='job-packet-link']")?.getAttribute("href"), `/jobs/${JOB_ID}`);
      }
      if (reason === "ai_cost_confirmation_required") {
        assert.match(ui.container.textContent ?? "", /separate AI cost confirmation\. No additional planner request was sent\./);
        assert.equal(ui.container.querySelector("[data-testid='prepare-run']"), null);
      }
    } finally { await ui.cleanup(); }
  }
  const failed = await mount({ initialRun: run({ state: "FAILED", errorCategory: "planner_provider_failure" }) });
  try {
    assert.match(failed.container.textContent ?? "", /planner provider/i);
    assert.doesNotMatch(failed.container.textContent ?? "", /stack|exception/i);
  } finally { await failed.cleanup(); }
});

test("AI cost confirmation response stops at durable blocker with no high-cost retry", async () => {
  const ui = await mount({ handler: async (input, init) => {
    if (init?.method === "POST") return json({ error: "confirm", code: "AI_COST_CONFIRMATION_REQUIRED" }, 428);
    if (String(input) === `/api/application-runs/${RUN_ID}`) return json({ run: run({ state: "BLOCKED", blockingReason: "ai_cost_confirmation_required" }) });
    throw new Error("Unexpected request");
  } });
  try {
    await ui.click("prepare-run");
    assert.equal(ui.fetchCalls.filter((call) => call.init?.method === "POST").length, 1);
    assert.equal(new Headers(ui.fetchCalls[0].init?.headers).has("x-ai-cost-confirmed"), false);
    assert.match(ui.container.textContent ?? "", /separate AI cost confirmation/);
    assert.equal(ui.container.querySelector("[data-testid='prepare-run']"), null);
  } finally { await ui.cleanup(); }
});
