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
  planner?: "gemini" | "local";
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
  // Questions are asked in the page (useInPageConfirm); a browser pop-up is only counted, never answered.
  let confirmations = 0;
  let windowConfirms = 0;
  const confirmMessages: string[] = [];
  Object.defineProperty(dom.window, "confirm", { configurable: true, value: () => {
    windowConfirms += 1;
    return false;
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
        initialPolicy: options.initialPolicy ?? policy(),
        planner: options.planner ?? "local"
      })));
  });
  // Answers each in-page question the click raises (Confirm, or Cancel when `confirm: false`).
  async function answerQuestions() {
    for (let tick = 0; tick < 10; tick += 1) {
      const dialog = container!.querySelector("[role='group']");
      if (dialog) {
        confirmations += 1;
        confirmMessages.push(dialog.querySelector(".job-card-copy")?.textContent ?? "");
        const label = (options.confirm ?? true) ? "Confirm" : "Cancel";
        const answer = [...dialog.querySelectorAll("button")].find((node) => node.textContent === label);
        assert.ok(answer, `missing ${label}`);
        await act(async () => { answer.click(); });
        tick = -1;
        continue;
      }
      await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 0)); });
    }
  }
  return {
    container, fetchCalls, confirmMessages,
    get confirmations() { return confirmations; },
    get windowConfirms() { return windowConfirms; },
    get refreshes() { return refreshes; },
    async click(id: string) {
      const button = container.querySelector<HTMLButtonElement>(`button[data-testid='${id}']`);
      assert.ok(button, `missing ${id}`);
      await act(async () => { button.click(); });
      await answerQuestions();
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
    assert.match(ui.container.textContent ?? "", /deterministic local rule-based planning/i);
    assert.ok(ui.container.querySelector("[data-testid='prepare-run']"));
    assert.match(ui.container.querySelector("[data-testid='prepare-run']")?.textContent ?? "", /Prepare with local rules/);
    assert.equal(ui.container.querySelector("[data-testid='enable-pretrial']"), null);
    assert.deepEqual(ui.fetchCalls, []);
  } finally { await ui.cleanup(); }
});

test("disabled policy requires confirmation and sends only the run ID for atomic setup", async () => {
  const current = policy({ enabled: false, effectiveEnabled: false, allowedHosts: ["other.example"] });
  const updated = policy({ enabled: true, effectiveEnabled: true, allowedHosts: ["other.example", HOST] });
  let written = false;
  const ui = await mount({ initialPolicy: current, handler: async (input, init) => {
    const url = String(input);
    if (url === `/api/application-runs/${RUN_ID}` && init?.method === "GET") return json({ run: run() });
    if (url === "/api/application-automation-policy" && init?.method === "GET") return json(written ? updated : current);
    if (url === "/api/application-automation-policy" && init?.method === "PATCH") { written = true; return json(updated); }
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
  let written = false;
  const ui = await mount({ initialPolicy: current, handler: async (input, init) => {
    if (String(input) === `/api/application-runs/${RUN_ID}` && init?.method === "GET") return json({ run: run() });
    if (String(input) === "/api/application-automation-policy" && init?.method === "GET") return json(written ? updated : current);
    if (String(input) === "/api/application-automation-policy" && init?.method === "PATCH") { written = true; return json(updated); }
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
    "automation_disabled", "automation_disabled_during_preparation", "host_blocked", "fit_below_threshold",
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
    assert.match(failed.container.textContent ?? "", /local rule-based plan/i);
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

// ---------------------------------------------------------------------------
// Assisted Fill switch (WP1.6). Assertions compare primitives rather than DOM
// nodes: a failing assert that prints a JSDOM node hangs node:test.
// ---------------------------------------------------------------------------

const SWITCH = "assisted-fill-switch";
const POLICY_URL = "/api/application-automation-policy";
const RUN_URL = `/api/application-runs/${RUN_ID}`;
const ALL_RUN_STATES = [
  "DRAFT", "PREPARING", "READY", "FILLING", "REVIEW_REQUIRED",
  "READY_FOR_USER_SUBMISSION", "COMPLETED_BY_USER", "BLOCKED", "FAILED", "CANCELLED"
] as const;

type MountedUi = Awaited<ReturnType<typeof mount>>;

function assistedFill(ui: MountedUi) {
  const control = ui.container.querySelector<HTMLButtonElement>(`button[data-testid='${SWITCH}']`);
  return {
    present: control !== null,
    role: control?.getAttribute("role") ?? null,
    checked: control?.getAttribute("aria-checked") ?? null,
    disabled: control?.disabled ?? null
  };
}

function shows(ui: MountedUi, testId: string) {
  return ui.container.querySelector(`[data-testid='${testId}']`) !== null;
}

function requests(ui: MountedUi) {
  return ui.fetchCalls.map((call) => `${call.init?.method} ${call.input}`);
}

function patchBodies(ui: MountedUi) {
  return ui.fetchCalls
    .filter((call) => call.init?.method === "PATCH")
    .map((call) => JSON.parse(String(call.init?.body)) as unknown);
}

function routes(table: {
  run?: () => Response;
  readPolicy?: () => Response;
  writePolicy?: () => Response | Promise<Response>;
}): FetchHandler {
  return async (input, init) => {
    const url = String(input);
    if (url === RUN_URL && init?.method === "GET" && table.run) return table.run();
    if (url === POLICY_URL && init?.method === "GET" && table.readPolicy) return table.readPolicy();
    if (url === POLICY_URL && init?.method === "PATCH" && table.writePolicy) return table.writePolicy();
    throw new Error(`Unexpected request: ${init?.method} ${url}`);
  };
}

const fillOn = (overrides: Partial<PolicyView> = {}) => policy({ mode: "FILL_AND_REVIEW", ...overrides });

test("assisted Fill starts off as a real switch and sends nothing on render", async () => {
  const ui = await mount({ initialRun: run({ state: "READY" }) });
  try {
    assert.deepEqual(assistedFill(ui), { present: true, role: "switch", checked: "false", disabled: false });
    assert.equal(ui.container.querySelector(`button[data-testid='${SWITCH}']`)?.getAttribute("aria-label"), "Assisted Fill");
    assert.deepEqual(ui.fetchCalls, []);
  } finally { await ui.cleanup(); }
});

test("turning assisted Fill on from a prepared run rereads, confirms and sends only the mode", async () => {
  for (const state of ["READY", "REVIEW_REQUIRED"] as const) {
    const current = run({ state });
    const ui = await mount({
      initialRun: current,
      handler: routes({
        run: () => json({ run: current }),
        readPolicy: () => json(policy()),
        writePolicy: () => json(fillOn())
      })
    });
    try {
      await ui.click(SWITCH);
      assert.deepEqual(requests(ui), [`GET ${RUN_URL}`, `GET ${POLICY_URL}`, `PATCH ${POLICY_URL}`], state);
      assert.deepEqual(patchBodies(ui), [{ mode: "FILL_AND_REVIEW" }], state);
      assert.equal(ui.confirmations, 1, state);
      assert.match(ui.confirmMessages[0], /whole account/i, state);
      assert.match(ui.confirmMessages[0], /you still click Submit/i, state);
      assert.equal(assistedFill(ui).checked, "true", state);
      assert.equal(ui.refreshes, 1, state);
    } finally { await ui.cleanup(); }
  }
});

test("declining the confirmation leaves assisted Fill off with no policy write", async () => {
  const current = run({ state: "READY" });
  const ui = await mount({
    initialRun: current,
    confirm: false,
    handler: routes({ run: () => json({ run: current }), readPolicy: () => json(policy()) })
  });
  try {
    await ui.click(SWITCH);
    assert.equal(ui.confirmations, 1);
    assert.deepEqual(patchBodies(ui), []);
    assert.equal(assistedFill(ui).checked, "false");
  } finally { await ui.cleanup(); }
});

test("assisted Fill cannot be turned on before the job is prepared, because that would hide Prepare", async () => {
  for (const state of ["DRAFT", "PREPARING", "BLOCKED", "FAILED"] as const) {
    const ui = await mount({ initialRun: run({ state }) });
    try {
      assert.equal(assistedFill(ui).disabled, true, state);
      assert.match(ui.container.textContent ?? "", /Prepare this job first/, state);
      await ui.click(SWITCH);
      assert.equal(ui.confirmations, 0, state);
      assert.deepEqual(ui.fetchCalls, [], state);
    } finally { await ui.cleanup(); }
  }
});

test("assisted Fill cannot be turned on from a run that is past Fill", async () => {
  for (const state of ["FILLING", "READY_FOR_USER_SUBMISSION", "COMPLETED_BY_USER", "CANCELLED"] as const) {
    const ui = await mount({ initialRun: run({ state }) });
    try {
      assert.equal(assistedFill(ui).disabled, true, state);
      assert.match(ui.container.textContent ?? "", /past the point where Fill can start/, state);
      assert.deepEqual(ui.fetchCalls, [], state);
    } finally { await ui.cleanup(); }
  }
});

test("assisted Fill cannot be turned on without setup, an allowed host or the environment gate", async () => {
  const cases: Array<{ label: string; initialPolicy: PolicyView; reason: RegExp }> = [
    { label: "owner policy off", initialPolicy: policy({ enabled: false, effectiveEnabled: false }), reason: /isn't set up/ },
    { label: "host not allowed", initialPolicy: policy({ allowedHosts: [] }), reason: /isn't set up/ },
    { label: "host blocked", initialPolicy: policy({ blockedHosts: [HOST] }), reason: /isn't set up/ },
    { label: "environment gate off", initialPolicy: policy({ effectiveEnabled: false }), reason: /unavailable in this environment/ }
  ];
  for (const { label, initialPolicy, reason } of cases) {
    const ui = await mount({ initialRun: run({ state: "READY" }), initialPolicy });
    try {
      assert.equal(assistedFill(ui).disabled, true, label);
      assert.match(ui.container.textContent ?? "", reason, label);
      await ui.click(SWITCH);
      assert.deepEqual(ui.fetchCalls, [], label);
    } finally { await ui.cleanup(); }
  }
});

test("turning on stops without a confirm or write when the reread shows the run or policy changed", async () => {
  const cases: Array<{ label: string; latestRun: RunView; latestPolicy: PolicyView; checked: string }> = [
    { label: "policy disabled", latestRun: run({ state: "READY" }), latestPolicy: policy({ enabled: false, effectiveEnabled: false }), checked: "false" },
    { label: "host blocked", latestRun: run({ state: "READY" }), latestPolicy: policy({ blockedHosts: [HOST] }), checked: "false" },
    { label: "environment gate closed", latestRun: run({ state: "READY" }), latestPolicy: policy({ effectiveEnabled: false }), checked: "false" },
    { label: "run cancelled", latestRun: run({ state: "CANCELLED" }), latestPolicy: policy(), checked: "false" },
    { label: "already on", latestRun: run({ state: "READY" }), latestPolicy: fillOn(), checked: "true" }
  ];
  for (const { label, latestRun, latestPolicy, checked } of cases) {
    const ui = await mount({
      initialRun: run({ state: "READY" }),
      handler: routes({ run: () => json({ run: latestRun }), readPolicy: () => json(latestPolicy) })
    });
    try {
      await ui.click(SWITCH);
      assert.equal(ui.confirmations, 0, label);
      assert.deepEqual(patchBodies(ui), [], label);
      assert.equal(assistedFill(ui).checked, checked, label);
    } finally { await ui.cleanup(); }
  }
});

test("turning on sends no write when the run or policy cannot be read", async () => {
  const cases = [
    { label: "run read failed", table: { run: () => json({ error: "down" }, 503), readPolicy: () => json(policy()) } },
    { label: "policy read failed", table: { run: () => json({ run: run({ state: "READY" }) }), readPolicy: () => json({ error: "down" }, 503) } }
  ];
  for (const { label, table } of cases) {
    const ui = await mount({ initialRun: run({ state: "READY" }), handler: routes(table) });
    try {
      await ui.click(SWITCH);
      assert.equal(ui.confirmations, 0, label);
      assert.deepEqual(patchBodies(ui), [], label);
      assert.equal(assistedFill(ui).checked, "false", label);
      assert.equal(assistedFill(ui).disabled, true, label);
      assert.equal(shows(ui, "refresh-run-state"), true, label);
    } finally { await ui.cleanup(); }
  }
});

test("turning off is one click with no reads first, in every run state and with every gate closed", async () => {
  const policies = [fillOn(), fillOn({ effectiveEnabled: false }), fillOn({ enabled: false, effectiveEnabled: false }), fillOn({ allowedHosts: [] })];
  for (const state of ALL_RUN_STATES) {
    for (const initialPolicy of policies) {
      const label = `${state} ${JSON.stringify(initialPolicy)}`;
      const ui = await mount({
        initialRun: run({ state }),
        initialPolicy,
        handler: routes({ writePolicy: () => json({ ...initialPolicy, mode: "PREPARE_ONLY" }) })
      });
      try {
        assert.deepEqual(assistedFill(ui), { present: true, role: "switch", checked: "true", disabled: false }, label);
        await ui.click(SWITCH);
        assert.deepEqual(requests(ui), [`PATCH ${POLICY_URL}`], label);
        assert.deepEqual(patchBodies(ui), [{ mode: "PREPARE_ONLY" }], label);
        assert.equal(ui.confirmations, 0, label);
        assert.equal(assistedFill(ui).checked, "false", label);
      } finally { await ui.cleanup(); }
    }
  }
});

test("while assisted Fill is on, Prepare stays hidden with a way forward; turning off brings it back", async () => {
  const ui = await mount({
    initialPolicy: fillOn(),
    handler: routes({ writePolicy: () => json(policy()) })
  });
  try {
    assert.equal(shows(ui, "prepare-run"), false);
    assert.equal(shows(ui, "enable-pretrial"), false);
    assert.match(ui.container.textContent ?? "", /turn this off first/i);
    await ui.click(SWITCH);
    assert.equal(shows(ui, "prepare-run"), true);
    assert.doesNotMatch(ui.container.textContent ?? "", /turn this off first/i);
  } finally { await ui.cleanup(); }
});

test("a lost write is never replayed; one policy read reports the real state", async () => {
  const cases: Array<{ label: string; afterLoss: PolicyView; checked: string; notice: RegExp | null }> = [
    { label: "the write landed", afterLoss: fillOn(), checked: "true", notice: null },
    { label: "the write did not land", afterLoss: policy(), checked: "false", notice: /not confirmed/i }
  ];
  for (const { label, afterLoss, checked, notice } of cases) {
    const current = run({ state: "READY" });
    let policyReads = 0;
    const ui = await mount({
      initialRun: current,
      handler: routes({
        run: () => json({ run: current }),
        readPolicy: () => {
          policyReads += 1;
          return json(policyReads === 1 ? policy() : afterLoss);
        },
        writePolicy: () => { throw new Error("connection dropped"); }
      })
    });
    try {
      await ui.click(SWITCH);
      assert.deepEqual(requests(ui), [`GET ${RUN_URL}`, `GET ${POLICY_URL}`, `PATCH ${POLICY_URL}`, `GET ${POLICY_URL}`], label);
      assert.equal(assistedFill(ui).checked, checked, label);
      assert.equal(shows(ui, "refresh-run-state"), false, label);
      if (notice) assert.match(ui.container.textContent ?? "", notice, label);
    } finally { await ui.cleanup(); }
  }
});

test("a refused write reads the policy once and reports it without replaying", async () => {
  const ui = await mount({
    initialPolicy: fillOn(),
    handler: routes({ writePolicy: () => json({ error: "slow down" }, 429), readPolicy: () => json(fillOn()) })
  });
  try {
    await ui.click(SWITCH);
    assert.deepEqual(requests(ui), [`PATCH ${POLICY_URL}`, `GET ${POLICY_URL}`]);
    assert.equal(assistedFill(ui).checked, "true");
    assert.match(ui.container.textContent ?? "", /still on/i);
  } finally { await ui.cleanup(); }
});

test("when neither the write nor the reread is confirmed, turning on locks but turning off stays available", async () => {
  const off = run({ state: "READY" });
  let reads = 0;
  const turningOn = await mount({
    initialRun: off,
    handler: routes({
      run: () => json({ run: off }),
      readPolicy: () => {
        reads += 1;
        return reads === 1 ? json(policy()) : json({ error: "down" }, 503);
      },
      writePolicy: () => { throw new Error("connection dropped"); }
    })
  });
  try {
    await turningOn.click(SWITCH);
    assert.equal(patchBodies(turningOn).length, 1);
    assert.equal(assistedFill(turningOn).disabled, true);
    assert.equal(shows(turningOn, "refresh-run-state"), true);
    assert.match(turningOn.container.textContent ?? "", /could not be confirmed/i);
  } finally { await turningOn.cleanup(); }

  const turningOff = await mount({
    initialPolicy: fillOn(),
    handler: routes({
      readPolicy: () => json({ error: "down" }, 503),
      writePolicy: () => { throw new Error("connection dropped"); }
    })
  });
  try {
    await turningOff.click(SWITCH);
    assert.equal(patchBodies(turningOff).length, 1);
    assert.equal(assistedFill(turningOff).disabled, false);
    assert.equal(shows(turningOff, "refresh-run-state"), true);
  } finally { await turningOff.cleanup(); }
});

test("a response that contradicts the request is shown as it is and never as success", async () => {
  const current = run({ state: "READY" });
  const ui = await mount({
    initialRun: current,
    handler: routes({
      run: () => json({ run: current }),
      readPolicy: () => json(policy()),
      writePolicy: () => json(policy())
    })
  });
  try {
    await ui.click(SWITCH);
    assert.equal(assistedFill(ui).checked, "false");
    assert.equal(shows(ui, "refresh-run-state"), true);
    assert.match(ui.container.textContent ?? "", /could not be confirmed/i);
  } finally { await ui.cleanup(); }
});

test("rapid duplicate switch activation dispatches one write and the switch waits while it is pending", async () => {
  const pending = deferred<Response>();
  const ui = await mount({
    initialPolicy: fillOn(),
    handler: routes({ writePolicy: () => pending.promise })
  });
  try {
    const control = ui.container.querySelector<HTMLButtonElement>(`button[data-testid='${SWITCH}']`);
    assert.ok(control);
    await act(async () => { control.click(); control.click(); });
    assert.equal(patchBodies(ui).length, 1);
    assert.equal(assistedFill(ui).disabled, true);
    await act(async () => { pending.resolve(json(policy())); await pending.promise; });
    assert.equal(assistedFill(ui).checked, "false");
  } finally { await ui.cleanup(); }
});

test("the switch never starts Prepare, opens a browser or calls anything but the policy and run reads", async () => {
  const current = run({ state: "READY" });
  const ui = await mount({
    initialRun: current,
    handler: routes({
      run: () => json({ run: current }),
      readPolicy: () => json(policy()),
      writePolicy: () => json(fillOn())
    })
  });
  try {
    await ui.click(SWITCH);
    assert.equal(ui.fetchCalls.every((call) => call.input === POLICY_URL || call.input === RUN_URL), true);
    assert.equal(ui.fetchCalls.some((call) => call.init?.method === "POST"), false);
  } finally { await ui.cleanup(); }
});

test("when Gemini plans the run, Prepare says so instead of claiming local rules", async () => {
  const ui = await mount({ planner: "gemini" });
  try {
    const text = ui.container.textContent ?? "";
    assert.match(ui.container.querySelector("[data-testid='prepare-run']")?.textContent ?? "", /^Prepare with Gemini$/);
    assert.match(text, /Google Gemini/);
    assert.match(text, /AI budget/);
    assert.doesNotMatch(text, /does not send planning data to an AI provider/);
    assert.doesNotMatch(text, /local rule-based/);
  } finally { await ui.cleanup(); }
});

test("a planner failure is described without naming local rules", async () => {
  for (const planner of ["gemini", "local"] as const) {
    const ui = await mount({ planner, initialRun: run({ state: "FAILED", errorCategory: "planner_provider_failure" }) });
    try {
      const failure = [...ui.container.querySelectorAll("[role='status']")]
        .map((element) => element.textContent ?? "")
        .find((text) => text.startsWith("Preparation failed"));
      assert.equal(failure, "Preparation failed while building the application plan.");
    } finally { await ui.cleanup(); }
  }
});

test("no window.confirm: setup and turning Fill on ask in the page", async () => {
  const disabled = policy({ enabled: false, effectiveEnabled: false, allowedHosts: [] });
  let written = false;
  const setup = await mount({ initialPolicy: disabled, handler: async (input, init) => {
    if (String(input) === RUN_URL && init?.method === "GET") return json({ run: run() });
    if (String(input) === POLICY_URL && init?.method === "GET") return json(written ? policy() : disabled);
    if (String(input) === POLICY_URL && init?.method === "PATCH") { written = true; return json(policy()); }
    throw new Error("Unexpected request");
  } });
  try {
    await setup.click("enable-pretrial");
    assert.equal(setup.windowConfirms, 0);
    assert.equal(setup.confirmations, 1);
    assert.match(setup.confirmMessages[0], /allow jobs\.example\.com for this run\? This does not authorize Fill\./);
    assert.deepEqual(patchBodies(setup), [{ enablePretrialForRunId: RUN_ID }]);
    assert.equal(shows(setup, "prepare-run"), true);
  } finally { await setup.cleanup(); }

  const current = run({ state: "READY" });
  const fill = await mount({
    initialRun: current,
    handler: routes({ run: () => json({ run: current }), readPolicy: () => json(policy()), writePolicy: () => json(fillOn()) })
  });
  try {
    await fill.click(SWITCH);
    assert.equal(fill.windowConfirms, 0);
    assert.equal(fill.confirmations, 1);
    assert.deepEqual(patchBodies(fill), [{ mode: "FILL_AND_REVIEW" }]);
  } finally { await fill.cleanup(); }
});
