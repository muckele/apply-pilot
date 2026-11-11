import assert from "node:assert/strict";
import test from "node:test";

import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

import { ApplicationBrowserControl } from "@/components/application-browser-control";
import type { AnswerPacket } from "@/lib/application-browser/control-presentation";
import {
  CONTROL_STEP_ACTIONS,
  deriveControlSteps,
  shouldWarnBeforeLeaving,
  type ControlStepAction,
  type ControlStepInput
} from "@/lib/assisted-apply/control-steps";
import {
  APPLICATION_BROWSER_BINDING_NAME,
  B1_WORKFLOW_STATES,
  type B1Command,
  type B1Status
} from "@/lib/application-browser/types";

// UX-4a: the control page as steps 4–8 with a "Now" card and one primary action.

const RUN_ID = "cm12345678901234567890123";
const ATTEMPT_ID = "550e8400-e29b-41d4-a716-446655440000";

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (reason?: unknown) => void };

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function run(overrides: Record<string, unknown> = {}) {
  return {
    id: RUN_ID,
    state: "READY",
    stateVersion: 7,
    completedAt: null,
    reviewReasons: [],
    applicationId: "application-synthetic",
    applyHost: "jobs.example.test",
    ...overrides
  };
}

function answer(overrides: Record<string, unknown>): AnswerPacket["answers"][number] {
  return {
    normalizedFieldKey: "b".repeat(64),
    dispositionReason: null,
    choices: [],
    required: false,
    requiresReview: true,
    sensitive: false,
    valueRedacted: false,
    reviewedByUser: false,
    reviewedAt: null,
    ...overrides
  } as unknown as AnswerPacket["answers"][number];
}

// Two proposable links (pending) and one manual phone field.
function pendingPacket(): AnswerPacket {
  return {
    inspectionVersion: 2,
    answerPacketVersion: 3,
    packetHash: "a".repeat(64),
    reviewedAt: null,
    createdAt: "2026-08-29T20:00:00.000Z",
    summary: {
      fieldCount: 3,
      observedFieldCount: 3,
      ambiguousQuestionCount: 0,
      ambiguousRequiredCount: 0,
      proposableCount: 2,
      pendingReviewCount: 2,
      approvedCount: 0,
      rejectedCount: 0,
      manualOnlyCount: 1,
      excludedCount: 0,
      unsupportedCount: 0,
      manualRequiredCount: 1,
      readyForRunResolution: false
    },
    answers: [
      answer({
        id: "answer-linkedin",
        normalizedFieldKey: "b".repeat(64),
        question: "LinkedIn profile",
        fieldType: "URL",
        classification: "PROFESSIONAL_LINK",
        disposition: "PROPOSABLE",
        proposal: { kind: "SCALAR", value: "https://example.test/in/someone" },
        status: "PENDING"
      }),
      answer({
        id: "answer-github",
        normalizedFieldKey: "c".repeat(64),
        question: "GitHub profile",
        fieldType: "URL",
        classification: "PROFESSIONAL_LINK",
        disposition: "PROPOSABLE",
        proposal: { kind: "SCALAR", value: "https://example.test/someone" },
        status: "PENDING"
      }),
      answer({
        id: "answer-phone",
        normalizedFieldKey: "d".repeat(64),
        question: "Phone number",
        fieldType: "TEL",
        classification: "CONTACT",
        disposition: "MANUAL_ONLY",
        dispositionReason: "UNCONFIRMED_APPLICANT_CONTACT",
        proposal: null,
        required: true,
        requiresReview: false,
        status: "PENDING"
      })
    ]
  } as AnswerPacket;
}

function decidedPacket(): AnswerPacket {
  const packet = pendingPacket();
  return {
    ...packet,
    summary: { ...packet.summary, pendingReviewCount: 0, approvedCount: 1, rejectedCount: 1, readyForRunResolution: true },
    answers: packet.answers.map((entry) => entry.id === "answer-linkedin"
      ? { ...entry, status: "APPROVED", reviewedByUser: true, reviewedAt: "2026-08-29T20:10:00.000Z" }
      : entry.id === "answer-github"
        ? { ...entry, status: "REJECTED", reviewedByUser: true, reviewedAt: "2026-08-29T20:10:00.000Z" }
        : entry)
  } as AnswerPacket;
}

function reviewedPacket(): AnswerPacket {
  return { ...decidedPacket(), reviewedAt: "2026-08-29T20:11:00.000Z" };
}

function reviewedNothingFillablePacket(): AnswerPacket {
  const packet = reviewedPacket();
  return {
    ...packet,
    summary: { ...packet.summary, approvedCount: 0, rejectedCount: 2 },
    answers: packet.answers.map((entry) => entry.id === "answer-linkedin" ? { ...entry, status: "REJECTED" } : entry)
  } as AnswerPacket;
}

function noAttempt(overrides: Record<string, unknown> = {}) {
  return {
    state: "READY",
    stateVersion: 7,
    fillAttemptId: null,
    fillLeaseExpiresAt: null,
    leaseLive: false,
    expiredRecoveryRequired: false,
    fieldOperationAllowed: false,
    outcome: null,
    errorCode: null,
    steps: [],
    ...overrides
  };
}

function completedFill() {
  return {
    state: "READY_FOR_USER_SUBMISSION",
    stateVersion: 8,
    fillAttemptId: ATTEMPT_ID,
    fillLeaseExpiresAt: null,
    leaseLive: false,
    expiredRecoveryRequired: false,
    fieldOperationAllowed: false,
    outcome: "COMPLETED",
    errorCode: null,
    steps: [{ stepKey: `fill:${ATTEMPT_ID}:${"b".repeat(64)}`, result: "FILLED", errorCode: null }]
  };
}

function fillingFill() {
  return {
    ...noAttempt(),
    state: "FILLING",
    stateVersion: 8,
    fillAttemptId: ATTEMPT_ID,
    fillLeaseExpiresAt: "2099-09-11T18:00:00.000Z",
    leaseLive: true,
    fieldOperationAllowed: true
  };
}

function readStatus(packet: AnswerPacket, extra: Partial<B1Status> = {}): B1Status {
  return {
    state: "TARGET_OPEN",
    runId: RUN_ID,
    targetHost: "jobs.example.test",
    inspection: {
      outcome: "SUCCEEDED",
      replayed: false,
      inspectionVersion: packet.inspectionVersion,
      answerPacketVersion: packet.answerPacketVersion,
      reinspectionRequired: false
    },
    ...extra
  };
}

type Mounted = {
  container: HTMLElement;
  window: JSDOM["window"];
  bindingCalls: B1Command["type"][];
  fetchCalls: string[];
  setBinding(binding: ((command: B1Command) => Promise<B1Status>) | undefined): void;
  cleanup(): Promise<void>;
};

async function flush(): Promise<void> {
  await act(async () => {
    for (let turn = 0; turn < 6; turn += 1) await Promise.resolve();
  });
}

async function mount(options: {
  run?: Record<string, unknown> | null;
  packet?: AnswerPacket | null;
  fill?: Record<string, unknown>;
  acknowledge?: boolean;
}): Promise<Mounted> {
  const dom = new JSDOM("<!doctype html><html><head><title>Apply Pilot</title></head><body><div id=\"root\"></div></body></html>", {
    url: "http://localhost/application-runs/test/browser"
  });
  const container = dom.window.document.getElementById("root");
  assert.ok(container);
  const globals = [
    ["window", dom.window],
    ["document", dom.window.document],
    ["navigator", dom.window.navigator],
    ["HTMLElement", dom.window.HTMLElement],
    ["Node", dom.window.Node],
    ["Event", dom.window.Event],
    ["MouseEvent", dom.window.MouseEvent],
    ["MutationObserver", dom.window.MutationObserver],
    ["IS_REACT_ACT_ENVIRONMENT", true]
  ] as const;
  const saved = new Map<PropertyKey, PropertyDescriptor | undefined>();
  for (const [key, value] of globals) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const fetchCalls: string[] = [];
  const savedFetch = Object.getOwnPropertyDescriptor(globalThis, "fetch");
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    writable: true,
    value: async (input: RequestInfo | URL) => {
      const url = String(input);
      fetchCalls.push(url);
      if (url === `/api/application-runs/${RUN_ID}`) {
        return options.run === null ? json({}, 503) : json({ run: run(options.run ?? {}) });
      }
      if (url === `/api/application-runs/${RUN_ID}/answer-packet`) {
        return json({ runId: RUN_ID, current: options.packet ?? null });
      }
      if (url === `/api/application-runs/${RUN_ID}/fill-attempt`) return json(options.fill ?? noAttempt());
      throw new Error(`Unexpected request: ${url}`);
    }
  });

  const bindingCalls: B1Command["type"][] = [];
  const setBinding = (binding: ((command: B1Command) => Promise<B1Status>) | undefined) => {
    if (binding === undefined) {
      Reflect.deleteProperty(dom.window, APPLICATION_BROWSER_BINDING_NAME);
      return;
    }
    Object.defineProperty(dom.window, APPLICATION_BROWSER_BINDING_NAME, {
      configurable: true,
      writable: true,
      value: async (command: B1Command) => {
        bindingCalls.push(command.type);
        return binding(command);
      }
    });
  };

  const root: Root = createRoot(container);
  await act(async () => {
    root.render(createElement(ApplicationBrowserControl, { runId: RUN_ID, authenticatedOwnerPage: true }));
  });
  await flush();
  if (options.acknowledge) {
    const acknowledgement = container.querySelector<HTMLInputElement>('[data-testid="transmission-ack"]');
    assert.ok(acknowledgement);
    await act(async () => acknowledgement.click());
  }
  return {
    container,
    window: dom.window,
    bindingCalls,
    fetchCalls,
    setBinding,
    async cleanup() {
      await act(async () => root.unmount());
      dom.window.close();
      if (savedFetch === undefined) Reflect.deleteProperty(globalThis, "fetch");
      else Object.defineProperty(globalThis, "fetch", savedFetch);
      for (const [key] of [...globals].reverse()) {
        const descriptor = saved.get(key);
        if (descriptor === undefined) Reflect.deleteProperty(globalThis, key);
        else Object.defineProperty(globalThis, key, descriptor);
      }
    }
  };
}

function button(container: HTMLElement, name: string): HTMLButtonElement | null {
  return [...container.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === name) ?? null;
}

async function click(target: HTMLButtonElement | null, name = "button"): Promise<void> {
  assert.ok(target, `Expected ${name}.`);
  await act(async () => target.click());
  await flush();
}

async function refreshStatus(mounted: Mounted): Promise<void> {
  await click(button(mounted.container, "Refresh status"), "Refresh status");
}

type PrimarySnapshot = Readonly<{
  count: number;
  action: string | null;
  step: string | null;
  disabled: boolean;
  reason: string;
  nowStep: string | null;
  heading: string;
}>;

function primarySnapshot(container: HTMLElement): PrimarySnapshot {
  const primaries = [...container.querySelectorAll<HTMLButtonElement>("[data-primary-action]")];
  const primary = primaries[0] ?? null;
  const reasonIds = (primary?.getAttribute("aria-describedby") ?? "").split(" ").filter(Boolean);
  const reason = reasonIds
    .map((id) => container.ownerDocument.getElementById(id))
    .filter((element): element is HTMLElement => element?.getAttribute("data-testid") === "disabled-reason")
    .map((element) => element.textContent?.trim() ?? "")
    .join(" ");
  const now = container.querySelector('[data-testid="now-card"]');
  return {
    count: primaries.length,
    action: primary?.getAttribute("data-primary-action") ?? null,
    step: primary?.closest("[data-step]")?.getAttribute("data-step") ?? null,
    disabled: primary?.disabled ?? false,
    reason,
    nowStep: now?.getAttribute("data-step") ?? null,
    heading: now?.querySelector("h2")?.textContent?.trim() ?? ""
  };
}

type TableCase = Readonly<{
  name: string;
  run?: Record<string, unknown> | null;
  packet?: AnswerPacket | null;
  fill?: Record<string, unknown>;
  status?: B1Status;
  acknowledge?: boolean;
  expect: Readonly<{ step: string; action: ControlStepAction; enabled: boolean }> | null;
}>;

const TABLE: readonly TableCase[] = [
  { name: "no companion status yet", expect: { step: "4", action: "OPEN_AND_READ", enabled: false } },
  { name: "connected, form not open", status: { state: "CONTROL_READY", runId: RUN_ID }, expect: { step: "4", action: "OPEN_AND_READ", enabled: true } },
  { name: "connected, application not prepared", run: { state: "DRAFT" }, status: { state: "CONTROL_READY", runId: RUN_ID }, expect: { step: "4", action: "OPEN_AND_READ", enabled: false } },
  { name: "browser not signed in", status: { state: "APPLY_PILOT_AUTH_REQUIRED", runId: RUN_ID }, expect: { step: "4", action: "OPEN_AND_READ", enabled: false } },
  { name: "form opening", status: { state: "OPENING_TARGET", runId: RUN_ID }, expect: { step: "4", action: "OPEN_AND_READ", enabled: false } },
  { name: "form open, not read", status: { state: "TARGET_OPEN", runId: RUN_ID }, expect: { step: "4", action: "READ_FORM", enabled: true } },
  { name: "form open, read in progress", status: { state: "TARGET_OPEN", runId: RUN_ID, inspection: { outcome: "IN_PROGRESS" } }, expect: { step: "4", action: "READ_FORM", enabled: false } },
  { name: "form open, read failed", status: { state: "TARGET_OPEN", runId: RUN_ID, inspection: { outcome: "FAILED", errorCode: "FORM_STABILITY_TIMEOUT", retryAllowed: true } }, expect: { step: "4", action: "READ_FORM", enabled: true } },
  { name: "form open, form changed", status: { state: "TARGET_OPEN", runId: RUN_ID, inspection: { outcome: "REINSPECTION_REQUIRED", errorCode: "FORM_GENERATION_INVALIDATED", retryAllowed: true } }, expect: { step: "4", action: "READ_FORM", enabled: true } },
  { name: "answers waiting for decisions", run: { state: "REVIEW_REQUIRED" }, packet: pendingPacket(), fill: noAttempt({ state: "REVIEW_REQUIRED" }), status: readStatus(pendingPacket()), expect: { step: "5", action: "CONTINUE_REVIEW", enabled: false } },
  { name: "answers all decided", run: { state: "REVIEW_REQUIRED" }, packet: decidedPacket(), fill: noAttempt({ state: "REVIEW_REQUIRED" }), status: readStatus(decidedPacket()), expect: { step: "5", action: "CONTINUE_REVIEW", enabled: true } },
  { name: "answers checked, box not ticked", packet: reviewedPacket(), status: readStatus(reviewedPacket()), expect: { step: "6", action: "FILL", enabled: false } },
  { name: "answers checked, box ticked", packet: reviewedPacket(), status: readStatus(reviewedPacket()), acknowledge: true, expect: { step: "6", action: "FILL", enabled: true } },
  { name: "Fill running (bridge)", packet: reviewedPacket(), status: readStatus(reviewedPacket(), { fillCommand: { outcome: "IN_PROGRESS" } }), acknowledge: true, expect: { step: "6", action: "FILL", enabled: false } },
  { name: "Fill running (server), no companion status", run: { state: "FILLING", stateVersion: 8 }, packet: reviewedPacket(), fill: fillingFill(), acknowledge: true, expect: { step: "6", action: "FILL", enabled: false } },
  { name: "Fill refused by the companion", packet: reviewedPacket(), status: readStatus(reviewedPacket(), { fillCommand: { outcome: "REJECTED", errorCode: "FILL_POLICY_DENIED" } }), acknowledge: true, expect: { step: "6", action: "FILL", enabled: false } },
  { name: "nothing to fill", packet: reviewedNothingFillablePacket(), status: readStatus(reviewedNothingFillablePacket()), expect: { step: "7", action: "UNLOCK", enabled: true } },
  { name: "Fill finished, form open", run: { state: "READY_FOR_USER_SUBMISSION", stateVersion: 8 }, packet: reviewedPacket(), fill: completedFill(), status: readStatus(reviewedPacket(), { fillCommand: { outcome: "FINALIZED" } }), expect: { step: "7", action: "UNLOCK", enabled: true } },
  { name: "form handed over", run: { state: "READY_FOR_USER_SUBMISSION", stateVersion: 8 }, packet: reviewedPacket(), fill: completedFill(), status: { state: "HUMAN_ONLY", runId: RUN_ID, humanSession: { expiresAtMs: Date.now() + 30 * 60_000 } }, expect: { step: "7", action: "RECORD", enabled: true } },
  { name: "Fill finished, form closed", run: { state: "READY_FOR_USER_SUBMISSION", stateVersion: 8 }, packet: reviewedPacket(), fill: completedFill(), status: { state: "CONTROL_READY", runId: RUN_ID }, expect: { step: "8", action: "RECORD", enabled: true } },
  { name: "stopped safely before the form opened", status: { state: "ERROR", runId: RUN_ID, errorCode: "RUN_HOST_NOT_ALLOWED" }, expect: { step: "4", action: "OPEN_AND_READ", enabled: false } },
  { name: "workflow closed", status: { state: "CLOSED", runId: RUN_ID }, expect: { step: "4", action: "OPEN_AND_READ", enabled: false } },
  { name: "already recorded", run: { state: "COMPLETED_BY_USER", stateVersion: 9, completedAt: "2026-09-12T18:00:00.000Z" }, fill: completedFill(), status: { state: "CLOSED", runId: RUN_ID }, expect: null },
  { name: "application stopped", run: { state: "CANCELLED", stateVersion: 9 }, status: { state: "CONTROL_READY", runId: RUN_ID }, expect: null }
];

test("table: each state renders exactly one primary action, in the expected step, and a disabled one says why", async () => {
  for (const entry of TABLE) {
    const mounted = await mount({ run: entry.run, packet: entry.packet, fill: entry.fill, acknowledge: entry.acknowledge });
    try {
      if (entry.status) {
        const status = entry.status;
        mounted.setBinding(async () => status);
        await refreshStatus(mounted);
      }
      const snapshot = primarySnapshot(mounted.container);
      if (entry.expect === null) {
        assert.equal(snapshot.count, 0, `${entry.name}: no primary action once finished`);
        assert.equal(mounted.container.querySelector('[data-testid="now-card"]') !== null, true, `${entry.name}: Now card`);
        continue;
      }
      assert.equal(snapshot.count, 1, `${entry.name}: exactly one primary action`);
      assert.equal(snapshot.action, entry.expect.action, `${entry.name}: action`);
      assert.equal(snapshot.step, entry.expect.step, `${entry.name}: the action sits in its step`);
      assert.equal(snapshot.nowStep, entry.expect.step, `${entry.name}: the Now card is that step`);
      assert.equal(snapshot.heading.startsWith(`Step ${entry.expect.step} of 8 · `), true, `${entry.name}: heading ${snapshot.heading}`);
      assert.equal(snapshot.disabled, !entry.expect.enabled, `${entry.name}: enabled`);
      if (snapshot.disabled) {
        assert.equal(snapshot.reason.length > 10, true, `${entry.name}: a disabled primary says why`);
        assert.equal(/[A-Z]{2,}_[A-Z_]+/.test(snapshot.reason), false, `${entry.name}: the reason is plain words: ${snapshot.reason}`);
      }
      const list = mounted.container.querySelector('[data-testid="now-card"] [data-testid="step-list"]');
      assert.equal(list?.querySelectorAll("li").length, 8, `${entry.name}: compact list of eight steps`);
      const progress = [...(list?.querySelectorAll("li") ?? [])].map((item) => item.getAttribute("data-progress"));
      assert.deepEqual(progress.slice(0, 3), ["done", "done", "done"], `${entry.name}: steps 1–3 done`);
      assert.equal(progress[Number(entry.expect.step) - 1], "now", `${entry.name}: current step marked now`);
      const next = mounted.container.querySelector('[data-testid="now-card"] [data-testid="now-next"]')?.textContent ?? "";
      assert.equal(next.length > 0, true, `${entry.name}: next line`);
    } finally {
      await mounted.cleanup();
    }
  }
});

test("the reason names the blocker in plain words", async () => {
  const cases: Array<[TableCase, RegExp]> = [
    [TABLE[0], /Waiting for the Apply Pilot browser to connect/],
    [TABLE[2], /isn't prepared yet/],
    [TABLE[9], /Approve or reject each proposed answer first \(2 left\)/],
    [TABLE[11], /Tick the box above/],
    [TABLE[13], /Fill is running/],
    [TABLE[20], /Apply Pilot isn't allowed on this employer's site/]
  ];
  for (const [entry, expected] of cases) {
    const mounted = await mount({ run: entry.run, packet: entry.packet, fill: entry.fill, acknowledge: entry.acknowledge });
    try {
      if (entry.status) {
        const status = entry.status;
        mounted.setBinding(async () => status);
        await refreshStatus(mounted);
      }
      assert.match(primarySnapshot(mounted.container).reason, expected, entry.name);
    } finally {
      await mounted.cleanup();
    }
  }
});

test("Check the answers comes before Fill on the page, and nothing says Read-only", async () => {
  const packet = reviewedPacket();
  const mounted = await mount({ packet, acknowledge: true });
  try {
    mounted.setBinding(async () => readStatus(packet));
    await refreshStatus(mounted);
    const container = mounted.container;
    const steps = [...container.querySelectorAll("[data-step]")].map((section) => section.getAttribute("data-step"));
    assert.deepEqual(steps, ["4", "5", "6", "7", "8"]);
    const fill = container.querySelector('[data-step-action="FILL"]');
    const continueButton = container.querySelector('[data-step-action="CONTINUE_REVIEW"]');
    const firstAnswer = container.querySelector('[data-step="5"] article');
    assert.ok(fill && continueButton && firstAnswer);
    const following = container.ownerDocument.defaultView!.Node.DOCUMENT_POSITION_FOLLOWING;
    assert.equal(Boolean(firstAnswer.compareDocumentPosition(fill) & following), true, "answers come before Fill");
    assert.equal(Boolean(continueButton.compareDocumentPosition(fill) & following), true, "continue comes before Fill");
    assert.equal(/read-only/i.test(container.textContent ?? ""), false);
  } finally {
    await mounted.cleanup();
  }
});

test("only the current step is open; other steps shrink to one line and can be shown", async () => {
  const packet = pendingPacket();
  const mounted = await mount({ run: { state: "REVIEW_REQUIRED" }, packet, fill: noAttempt({ state: "REVIEW_REQUIRED" }) });
  try {
    mounted.setBinding(async () => readStatus(packet));
    await refreshStatus(mounted);
    const body = (step: number) => mounted.container.querySelector<HTMLElement>(`#step-${step}-body`);
    assert.equal(body(5)?.hidden, false, "step 5 is open");
    assert.equal(body(6)?.hidden, true, "step 6 is hidden");
    await click(mounted.container.querySelector<HTMLButtonElement>('[aria-controls="step-6-body"]'), "Show step 6");
    assert.equal(body(6)?.hidden, false, "step 6 can be shown");
  } finally {
    await mounted.cleanup();
  }
});

test("Open and read the form sends nothing before the click, then OPEN_TARGET and, after it is accepted, INSPECT_FORM", async () => {
  const packet = pendingPacket();
  const opened = deferred<B1Status>();
  const mounted = await mount({ run: { state: "REVIEW_REQUIRED" }, packet, fill: noAttempt({ state: "REVIEW_REQUIRED" }) });
  try {
    mounted.setBinding(async (command) => {
      if (command.type === "GET_STATUS") return { state: "CONTROL_READY", runId: RUN_ID };
      if (command.type === "OPEN_TARGET") return opened.promise;
      if (command.type === "INSPECT_FORM") return readStatus(packet);
      throw new Error(`unexpected ${command.type}`);
    });
    await refreshStatus(mounted);
    await flush();
    assert.deepEqual(mounted.bindingCalls, ["GET_STATUS"], "nothing is opened or read before the click");

    const openAndRead = button(mounted.container, "Open and read the form");
    assert.equal(openAndRead?.getAttribute("data-primary-action"), "OPEN_AND_READ");
    await act(async () => {
      openAndRead!.click();
      openAndRead!.click();
      await Promise.resolve();
    });
    assert.deepEqual(mounted.bindingCalls, ["GET_STATUS", "OPEN_TARGET"], "one OPEN_TARGET, and no read before it is accepted");

    opened.resolve({ state: "TARGET_OPEN", runId: RUN_ID, targetHost: "jobs.example.test" });
    await flush();
    await flush();
    assert.deepEqual(mounted.bindingCalls, ["GET_STATUS", "OPEN_TARGET", "INSPECT_FORM"]);
    assert.equal(primarySnapshot(mounted.container).nowStep, "5", "the answers come next");
  } finally {
    await mounted.cleanup();
  }
});

test("Open and read stops when opening fails, says why, and never retries or reads", async () => {
  const outcomes: Array<[string, (command: B1Command) => Promise<B1Status>, RegExp]> = [
    ["the open command fails", async (command) => {
      if (command.type === "OPEN_TARGET") throw new Error("private open failure");
      return { state: "ERROR", runId: RUN_ID, errorCode: "RUN_HOST_NOT_ALLOWED" };
    }, /couldn't open the employer's form/],
    ["the open returns a safe stop", async (command) => command.type === "OPEN_TARGET"
      ? { state: "ERROR", runId: RUN_ID, errorCode: "RUN_TARGET_INVALID" }
      : { state: "CONTROL_READY", runId: RUN_ID }, /couldn't open the employer's form/],
    ["the open returns a status for another run", async (command) => command.type === "OPEN_TARGET"
      ? { state: "TARGET_OPEN", runId: "cm98765432109876543210987" }
      : { state: "CONTROL_READY", runId: RUN_ID }, /could not be accepted/],
    ["the open returns a state other than open", async (command) => command.type === "OPEN_TARGET"
      ? { state: "CONTROL_READY", runId: RUN_ID }
      : { state: "CONTROL_READY", runId: RUN_ID }, /couldn't open the employer's form/]
  ];
  for (const [name, binding, notice] of outcomes) {
    const mounted = await mount({});
    try {
      let first = true;
      mounted.setBinding(async (command) => {
        if (first && command.type === "GET_STATUS") {
          first = false;
          return { state: "CONTROL_READY", runId: RUN_ID };
        }
        return binding(command);
      });
      await refreshStatus(mounted);
      await click(button(mounted.container, "Open and read the form"), "Open and read the form");
      await flush();
      await flush();
      assert.equal(mounted.bindingCalls.filter((type) => type === "OPEN_TARGET").length, 1, `${name}: one open`);
      assert.equal(mounted.bindingCalls.includes("INSPECT_FORM"), false, `${name}: no read`);
      assert.match(mounted.container.textContent ?? "", notice, name);
    } finally {
      await mounted.cleanup();
    }
  }
});

test("Read the form, with the form already open, sends only INSPECT_FORM", async () => {
  const packet = pendingPacket();
  const mounted = await mount({ run: { state: "REVIEW_REQUIRED" }, packet, fill: noAttempt({ state: "REVIEW_REQUIRED" }) });
  try {
    mounted.setBinding(async (command) => command.type === "INSPECT_FORM"
      ? readStatus(packet)
      : { state: "TARGET_OPEN", runId: RUN_ID });
    await refreshStatus(mounted);
    const read = button(mounted.container, "Read the form");
    assert.equal(read?.getAttribute("data-primary-action"), "READ_FORM");
    await click(read, "Read the form");
    assert.deepEqual(mounted.bindingCalls, ["GET_STATUS", "INSPECT_FORM"]);
  } finally {
    await mounted.cleanup();
  }
});

test("the leave warning is on only while the form is opening, open or handed over", async () => {
  const warned = new Set(["OPENING_TARGET", "TARGET_OPEN", "HANDOFF_PENDING", "HUMAN_ONLY"]);
  for (const state of B1_WORKFLOW_STATES) {
    const mounted = await mount({});
    try {
      const before = new mounted.window.Event("beforeunload", { cancelable: true });
      mounted.window.dispatchEvent(before);
      assert.equal(before.defaultPrevented, false, `${state}: no warning before any status`);
      mounted.setBinding(async () => ({ state, runId: RUN_ID }));
      await refreshStatus(mounted);
      const event = new mounted.window.Event("beforeunload", { cancelable: true });
      mounted.window.dispatchEvent(event);
      assert.equal(event.defaultPrevented, warned.has(state), state);
    } finally {
      await mounted.cleanup();
    }
  }

  const mounted = await mount({});
  try {
    let state: B1Status["state"] = "TARGET_OPEN";
    mounted.setBinding(async () => ({ state, runId: RUN_ID }));
    await refreshStatus(mounted);
    state = "CLOSED";
    await refreshStatus(mounted);
    const event = new mounted.window.Event("beforeunload", { cancelable: true });
    mounted.window.dispatchEvent(event);
    assert.equal(event.defaultPrevented, false, "the warning is removed once the form is closed");
  } finally {
    await mounted.cleanup();
  }
});

test("a handed-over form that later closes still leads to Record it", async () => {
  const mounted = await mount({ run: { state: "READY" } });
  try {
    let status: B1Status = { state: "HUMAN_ONLY", runId: RUN_ID, humanSession: { expiresAtMs: Date.now() + 30 * 60_000 } };
    mounted.setBinding(async () => status);
    await refreshStatus(mounted);
    assert.equal(primarySnapshot(mounted.container).nowStep, "7");
    status = { state: "CLOSED", runId: RUN_ID };
    await refreshStatus(mounted);
    const snapshot = primarySnapshot(mounted.container);
    assert.equal(snapshot.nowStep, "8");
    assert.equal(snapshot.action, "RECORD");
  } finally {
    await mounted.cleanup();
  }
});

test("answer cards use plain words, keep the new-tab detail link, and keep codes under Details", async () => {
  const packet = pendingPacket();
  const mounted = await mount({ run: { state: "REVIEW_REQUIRED" }, packet, fill: noAttempt({ state: "REVIEW_REQUIRED" }) });
  try {
    const card = [...mounted.container.querySelectorAll("article")].find((article) => article.querySelector("h3")?.textContent === "LinkedIn profile");
    assert.ok(card);
    assert.match(card.textContent ?? "", /Apply Pilot proposes/);
    assert.match(card.textContent ?? "", /From: Your application details/);
    const phone = [...mounted.container.querySelectorAll("article")].find((article) => article.querySelector("h3")?.textContent === "Phone number");
    const link = phone?.querySelector<HTMLAnchorElement>('a[href="/settings/application-details"]');
    assert.equal(link?.getAttribute("target"), "_blank");
    assert.equal(link?.getAttribute("rel"), "noopener noreferrer");
    const visible = card.cloneNode(true) as HTMLElement;
    for (const technical of visible.querySelectorAll("details[data-technical]")) technical.remove();
    assert.equal(/PROFESSIONAL_LINK|PROPOSABLE|PENDING/.test(visible.textContent ?? ""), false);
  } finally {
    await mounted.cleanup();
  }
});

// Pure layout logic.

function baseInput(): ControlStepInput {
  return {
    companion: {
      hasStatus: true,
      connection: "CONNECTED",
      state: "TARGET_OPEN",
      errorCode: null,
      inspection: { outcome: "SUCCEEDED", replayed: false, inspectionVersion: 2, answerPacketVersion: 3, reinspectionRequired: false },
      formInvalidated: false,
      fillCommand: null,
      handedOverEarlier: false,
      humanMinutesRemaining: null,
      canOpenTarget: false,
      canInspectForm: true,
      canHandOff: true,
      pendingCommand: null
    },
    review: {
      phase: "loaded",
      verified: true,
      runState: "READY",
      packet: { inspectionVersion: 2, answerPacketVersion: 3, reviewedAt: "2026-08-29T20:11:00.000Z", fieldCount: 19, proposableCount: 6, pendingReviewCount: 0, readyForRunResolution: true },
      pendingMutation: false,
      pendingResolve: false,
      resolveEligible: false
    },
    fill: {
      phase: "loaded",
      verified: true,
      category: "NO_ATTEMPT",
      fillableCount: 6,
      activationEligible: true,
      acknowledged: true,
      pendingActivation: false,
      mayHaveDispatched: false,
      packetCurrent: true
    },
    handoff: { eligible: true, confirming: false },
    record: { eligible: true, recorded: false, phase: "idle", runVerified: true },
    uiLocked: false
  };
}

test("pure: step 6 says how many fields Fill can do, and the Fill button follows the existing gate exactly", () => {
  const view = deriveControlSteps(baseInput());
  assert.equal(view.current, 6);
  assert.equal(view.sentence, "Apply Pilot can fill 6 of 19 fields. You'll do the rest.");
  assert.equal(view.actions.FILL.label, "Fill 6 fields (runs once)");
  for (const activationEligible of [true, false]) {
    for (const acknowledged of [true, false]) {
      const input = baseInput();
      const next = deriveControlSteps({ ...input, fill: { ...input.fill, activationEligible, acknowledged } });
      assert.equal(next.actions.FILL.enabled, activationEligible && acknowledged, `${activationEligible}/${acknowledged}`);
      assert.equal(next.actions.FILL.reason === null, activationEligible && acknowledged);
    }
  }
});

test("pure: whenever Fill could be activated, step 6 is current with Fill as its primary action", () => {
  const states = B1_WORKFLOW_STATES;
  const runStates = ["READY", "REVIEW_REQUIRED", "FILLING", "READY_FOR_USER_SUBMISSION", "COMPLETED_BY_USER", "CANCELLED", null] as const;
  const categories = ["NO_ATTEMPT", "FILLING", "COMPLETED", "ATTEMPT_CONSUMED", "RECOVERY_PENDING", null] as const;
  let checked = 0;
  for (const state of states) {
    for (const runState of runStates) {
      for (const category of categories) {
        for (const recordPhase of ["idle", "confirming", "uncertain"] as const) {
          const input = baseInput();
          const view = deriveControlSteps({
            ...input,
            companion: { ...input.companion, state },
            review: { ...input.review, runState },
            fill: { ...input.fill, category },
            record: { ...input.record, phase: recordPhase }
          });
          for (const action of CONTROL_STEP_ACTIONS) {
            const actionState = view.actions[action];
            assert.equal(actionState.enabled === (actionState.reason === null), true, `${action}: a disabled action has a reason`);
          }
          const primaryCount = view.primary === null ? 0 : 1;
          assert.equal(primaryCount <= 1, true);
          if (view.finished === null) assert.equal(view.primary !== null, true, `${state}/${runState}/${category}: a primary action`);
          // The Fill gate is the caller's isFillActivationEligible; when that and the box say yes,
          // the page must be on Fill (unless a submission record is in progress).
          if (state === "TARGET_OPEN" && runState === "READY" && category === "NO_ATTEMPT" && recordPhase === "idle") {
            assert.equal(view.current, 6);
            assert.equal(view.primary?.action, "FILL");
          }
          checked += 1;
        }
      }
    }
  }
  assert.equal(checked > 300, true);
});

test("pure: the leave warning covers exactly the four listed companion states", () => {
  const warned = B1_WORKFLOW_STATES.filter((state) => shouldWarnBeforeLeaving({ hasStatus: true, state }));
  assert.deepEqual(warned, ["OPENING_TARGET", "TARGET_OPEN", "HANDOFF_PENDING", "HUMAN_ONLY"]);
  assert.equal(B1_WORKFLOW_STATES.some((state) => shouldWarnBeforeLeaving({ hasStatus: false, state })), false);
});

test("pure: nothing fillable moves straight on to step 7", () => {
  const input = baseInput();
  const view = deriveControlSteps({ ...input, fill: { ...input.fill, fillableCount: 0, activationEligible: false } });
  assert.equal(view.current, 7);
  assert.equal(view.primary?.action, "UNLOCK");
  assert.match(view.sentence, /nothing it can fill/);
  assert.equal(view.progress[6], "done");
});

test("pure: an unconfirmed Fill result is never offered again", () => {
  const input = baseInput();
  const view = deriveControlSteps({
    ...input,
    fill: { ...input.fill, mayHaveDispatched: true, verified: false, activationEligible: false }
  });
  assert.equal(view.current, 6);
  assert.equal(view.actions.FILL.enabled, false);
  assert.match(view.actions.FILL.reason ?? "", /won't run Fill again/);
});
