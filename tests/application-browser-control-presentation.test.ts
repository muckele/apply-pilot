import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

import { ApplicationBrowserControl } from "@/components/application-browser-control";
import {
  applyAuthoritativeBrowserStatus,
  bindingRejectionPlan,
  browserCommandAvailability,
  derivePacketFreshness,
  dispositionMessage,
  inspectionPresentation,
  buildAnswerReviewRequest,
  buildResolveReviewRequest,
  isAnswerReviewEligible,
  isAnswerReviewPostconditionCurrent,
  isResolveReviewEligible,
  isResolveReviewPostconditionCurrent,
  parseAnswerPacketResponse,
  parseAnswerReviewResponse,
  parseApplicationRunReviewResponse,
  presentProposal,
  REVIEW_REASON_LABELS,
  readinessMessage,
  shouldOfferRetryConnection,
  type AnswerReviewMutationSnapshot,
  type ResolveReviewMutationSnapshot,
  type ReviewRunAuthority,
  type AnswerPacket,
  type PacketFreshness
} from "@/lib/application-browser/control-presentation";
import { APPLICATION_BROWSER_BINDING_NAME } from "@/lib/application-browser/types";
import type {
  B1Command,
  B1Status,
  B1WorkflowState,
  B2InspectionCommandStatus,
  BrowserInspectionRecoverableCode
} from "@/lib/application-browser/types";

const RUN_ID = "cm12345678901234567890123";
const OTHER_RUN_ID = "cm98765432109876543210987";
const SAFE_PROPOSAL_CONTEXT = {
  disposition: "PROPOSABLE" as const,
  sensitive: false,
  valueRedacted: false
};

type FetchHandler = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

type MountedControl = {
  container: HTMLElement;
  fetchCalls: Array<{ input: RequestInfo | URL; init?: RequestInit }>;
  setBinding: (binding: ((command: B1Command) => Promise<B1Status>) | undefined) => void;
  setFetchHandler: (handler: FetchHandler) => void;
  unmount: () => Promise<void>;
  cleanup: () => Promise<void>;
};

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function packetResponse(current: AnswerPacket | null, runId = RUN_ID): Response {
  return new Response(JSON.stringify({ runId, current }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

function runResponse(run = validRunAuthority()): Response {
  return new Response(JSON.stringify({ run }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

function answerReviewPath(answerId = "answer-scalar"): string {
  return `/api/application-runs/${encodeURIComponent(RUN_ID)}/answers/${encodeURIComponent(answerId)}/review`;
}

function resolveReviewPath(): string {
  return `/api/application-runs/${encodeURIComponent(RUN_ID)}/resolve-review`;
}

function defaultReviewFetchHandler(input: RequestInfo | URL): Promise<Response> {
  const url = String(input);
  if (url === `/api/application-runs/${RUN_ID}`) return Promise.resolve(runResponse());
  if (url === `/api/application-runs/${RUN_ID}/answer-packet`) return Promise.resolve(packetResponse(null));
  throw new Error(`Unexpected review request: ${url}`);
}

async function flushComponentWork(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function mountControl(
  initialFetchHandler: FetchHandler = defaultReviewFetchHandler
): Promise<MountedControl> {
  const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", {
    url: "http://localhost/application-runs/test/browser"
  });
  const container = dom.window.document.getElementById("root");
  assert.ok(container);

  const installedGlobals = [
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
  const originalDescriptors = new Map<PropertyKey, PropertyDescriptor | undefined>();
  for (const [key, value] of installedGlobals) {
    originalDescriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }

  let fetchHandler = initialFetchHandler;
  const fetchCalls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  const originalFetchDescriptor = Object.getOwnPropertyDescriptor(globalThis, "fetch");
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    writable: true,
    value: async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls.push({ input, init });
      return fetchHandler(input, init);
    }
  });

  const root: Root = createRoot(container);
  let mounted = true;
  await act(async () => {
    root.render(createElement(ApplicationBrowserControl, { runId: RUN_ID }));
  });
  await flushComponentWork();

  const unmount = async () => {
    if (!mounted) return;
    mounted = false;
    await act(async () => {
      root.unmount();
    });
  };

  return {
    container,
    fetchCalls,
    setBinding(binding) {
      if (binding === undefined) {
        Reflect.deleteProperty(dom.window, APPLICATION_BROWSER_BINDING_NAME);
        return;
      }
      Object.defineProperty(dom.window, APPLICATION_BROWSER_BINDING_NAME, {
        configurable: true,
        writable: true,
        value: binding
      });
    },
    setFetchHandler(handler) {
      fetchHandler = handler;
    },
    unmount,
    async cleanup() {
      await unmount();
      Reflect.deleteProperty(dom.window, APPLICATION_BROWSER_BINDING_NAME);
      dom.window.close();
      if (originalFetchDescriptor === undefined) {
        Reflect.deleteProperty(globalThis, "fetch");
      } else {
        Object.defineProperty(globalThis, "fetch", originalFetchDescriptor);
      }
      for (const [key] of [...installedGlobals].reverse()) {
        const descriptor = originalDescriptors.get(key);
        if (descriptor === undefined) {
          Reflect.deleteProperty(globalThis, key);
        } else {
          Object.defineProperty(globalThis, key, descriptor);
        }
      }
    }
  };
}

function buttonNamed(container: HTMLElement, name: string): HTMLButtonElement {
  const button = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === name
  );
  assert.ok(button, `Expected button named ${name}.`);
  return button;
}

function reviewButton(container: HTMLElement, action: "Approve" | "Reject", question: string): HTMLButtonElement {
  const article = [...container.querySelectorAll("article")].find((candidate) =>
    candidate.querySelector("h3")?.textContent?.trim() === question
  );
  assert.ok(article, `Expected article for ${question}.`);
  const button = [...article.querySelectorAll("button")].find((candidate) =>
    candidate.getAttribute("aria-label") === `${action} proposed answer for ${question}`
  );
  assert.ok(button, `Expected ${action} button for ${question}.`);
  return button;
}

function resolveReviewButton(container: HTMLElement): HTMLButtonElement {
  return buttonNamed(container, "Resolve review");
}

type ReviewLoadRefProbe = {
  phase: string;
  unverified: boolean;
  packet: AnswerPacket | null;
};

type ReactHookProbe = {
  memoizedState?: { current?: ReviewLoadRefProbe };
  next?: ReactHookProbe | null;
};

type ReactFiberProbe = {
  memoizedState?: ReactHookProbe | null;
  alternate?: ReactFiberProbe | null;
  return?: ReactFiberProbe | null;
};

async function clickReviewButton(
  control: MountedControl,
  action: "Approve" | "Reject",
  question: string
): Promise<void> {
  await act(async () => {
    reviewButton(control.container, action, question).click();
  });
  await flushComponentWork();
}

async function startReviewButton(
  control: MountedControl,
  action: "Approve" | "Reject",
  question: string
): Promise<void> {
  await act(async () => {
    reviewButton(control.container, action, question).click();
    await Promise.resolve();
  });
}

function trustedReviewLoadRefFromButton(button: HTMLButtonElement): {
  phase: string;
  unverified: boolean;
  packet: AnswerPacket | null;
} | null {
  const fiberKey = Object.keys(button).find((key) => key.startsWith("__reactFiber$"));
  if (fiberKey === undefined) return null;
  let fiber: ReactFiberProbe | null = (button as unknown as Record<string, ReactFiberProbe | undefined>)[fiberKey] ?? null;
  while (fiber !== null) {
    for (const candidate of [fiber, fiber.alternate]) {
      if (candidate === undefined || candidate === null) continue;
      let hook: ReactHookProbe | null = candidate.memoizedState ?? null;
      while (hook !== null) {
        const current = hook.memoizedState?.current;
        if (typeof current === "object" && current !== null && current.phase === "loaded" && current.unverified === false && current.packet?.answers?.[0]?.id === "answer-b") return current;
        hook = hook.next ?? null;
      }
    }
    fiber = fiber.return ?? null;
  }
  return null;
}

async function waitForTrustedReviewLoadRef(button: HTMLButtonElement): Promise<{
  phase: string;
  unverified: boolean;
  packet: AnswerPacket | null;
}> {
  for (let turn = 0; turn < 100; turn += 1) {
    const reviewLoad = trustedReviewLoadRefFromButton(button);
    if (reviewLoad !== null) return reviewLoad;
    await Promise.resolve();
  }
  assert.fail("Expected the component-owned reviewLoadRef to advance to trusted answer B.");
}

async function clickButton(control: MountedControl, name: string): Promise<void> {
  await act(async () => {
    buttonNamed(control.container, name).click();
  });
  await flushComponentWork();
}

async function clickResolveReview(control: MountedControl): Promise<void> {
  await act(async () => {
    resolveReviewButton(control.container).click();
  });
  await flushComponentWork();
}

const workflowStates: B1WorkflowState[] = [
  "STARTING",
  "APPLY_PILOT_AUTH_REQUIRED",
  "CONTROL_READY",
  "OPENING_TARGET",
  "TARGET_OPEN",
  "ERROR",
  "CLOSED"
];

const commands: B1Command["type"][] = [
  "GET_STATUS",
  "OPEN_TARGET",
  "INSPECT_FORM",
  "CLOSE_WORKFLOW"
];

const recoverableMessages: Record<BrowserInspectionRecoverableCode, string> = {
  FORM_INSPECTION_IN_PROGRESS:
    "An inspection is already running. Wait for it to finish, then refresh status.",
  FORM_STABILITY_TIMEOUT:
    "The form did not settle in time. Wait for the page to finish changing, then inspect again.",
  FORM_GENERATION_INVALIDATED: "The employer form changed during inspection. Inspect it again.",
  FORM_CORRELATION_INVALID:
    "The form could not be matched safely. Check that the intended form is visible, then inspect again.",
  AMBIGUOUS_DUPLICATE_FIELD:
    "Similar duplicate fields could not be distinguished safely. Review the employer form, then retry; handle those fields manually if it persists.",
  FORM_INSPECTION_CANCELLED:
    "Inspection stopped before publication. Check that the target is still open, then retry.",
  FORM_INSPECTION_REQUEST_TOO_LARGE:
    "The visible form is too large to inspect safely in one pass. Navigate to a smaller form step if available and retry; otherwise complete it manually.",
  RUN_LIFECYCLE_STALE: "The application run changed. Refresh browser status, then inspect again.",
  RUN_DOCUMENT_STALE: "The application documents changed. Refresh browser status, then inspect again.",
  SAME_ORIGIN_RATE_LIMITED: "Too many inspection requests were made. Wait a moment, then retry.",
  SAME_ORIGIN_REQUEST_FAILED:
    "Apply Pilot could not publish the inspection. Check the control workflow and connection, then retry."
};

function validPacket(): AnswerPacket {
  return {
    inspectionVersion: 2,
    answerPacketVersion: 3,
    packetHash: "a".repeat(64),
    reviewedAt: "2026-08-29T20:30:00.000Z",
    createdAt: "2026-08-29T20:00:00.000Z",
    summary: {
      fieldCount: 4,
      proposableCount: 3,
      pendingReviewCount: 1,
      approvedCount: 1,
      rejectedCount: 1,
      manualOnlyCount: 1,
      excludedCount: 0,
      unsupportedCount: 0,
      manualRequiredCount: 1,
      readyForRunResolution: false
    },
    answers: [
      {
        id: "answer-scalar",
        normalizedFieldKey: "b".repeat(64),
        question: "Portfolio URL",
        fieldType: "URL",
        classification: "PROFESSIONAL_LINK",
        disposition: "PROPOSABLE",
        dispositionReason: null,
        choices: [],
        proposal: { kind: "SCALAR", value: "https://example.com" },
        required: true,
        requiresReview: true,
        sensitive: false,
        valueRedacted: false,
        status: "PENDING",
        reviewedByUser: false,
        reviewedAt: null
      },
      {
        id: "answer-boolean",
        normalizedFieldKey: "c".repeat(64),
        question: "Available immediately?",
        fieldType: "CHECKBOX_BOOLEAN",
        classification: "AVAILABILITY",
        disposition: "PROPOSABLE",
        dispositionReason: null,
        choices: [],
        proposal: { kind: "BOOLEAN", value: true },
        required: false,
        requiresReview: true,
        sensitive: false,
        valueRedacted: false,
        status: "APPROVED",
        reviewedByUser: true,
        reviewedAt: "2026-08-29T20:30:00.000Z"
      },
      {
        id: "answer-options",
        normalizedFieldKey: "d".repeat(64),
        question: "Preferred office",
        fieldType: "SELECT_ONE",
        classification: "RELOCATION",
        disposition: "PROPOSABLE",
        dispositionReason: null,
        choices: [
          { key: "remote", label: "Remote", disabled: false },
          { key: "onsite", label: "On site", disabled: true }
        ],
        proposal: { kind: "OPTIONS", optionKeys: ["remote"] },
        required: true,
        requiresReview: true,
        sensitive: false,
        valueRedacted: false,
        status: "REJECTED",
        reviewedByUser: true,
        reviewedAt: "2026-08-29T20:30:00.000Z"
      },
      {
        id: "answer-document",
        normalizedFieldKey: "e".repeat(64),
        question: "Résumé",
        fieldType: "FILE_UPLOAD",
        classification: "DOCUMENT",
        disposition: "MANUAL_ONLY",
        dispositionReason: "V1_MANUAL_POLICY",
        choices: [],
        proposal: null,
        required: true,
        requiresReview: false,
        sensitive: false,
        valueRedacted: false,
        status: "PENDING",
        reviewedByUser: false,
        reviewedAt: null
      }
    ]
  };
}

function currentFreshnessInput(overrides: Record<string, unknown> = {}) {
  return {
    packet: validPacket(),
    latestPacketResponseWasNull: false,
    packetLoadUnverified: false,
    connection: "CONNECTED" as const,
    workflowState: "TARGET_OPEN" as const,
    lastAcceptedInspection: {
      outcome: "SUCCEEDED" as const,
      replayed: false,
      inspectionVersion: 2,
      answerPacketVersion: 3,
      reinspectionRequired: false
    },
    formInvalidatedSinceVerifiedSuccess: false,
    ...overrides
  };
}

const PLAN_REVIEW_REASONS = [
  "unknown_requirement_ids",
  "unknown_evidence_ids",
  "exaggerated_evidence_removed",
  "invented_numeric_claims",
  "planner_confidence_below_threshold",
  "evidence_gaps_present"
] as const;

function validRunAuthority(overrides: Record<string, unknown> = {}) {
  return {
    id: RUN_ID,
    state: "REVIEW_REQUIRED",
    stateVersion: 7,
    reviewReasons: ["unknown_requirement_ids", "evidence_gaps_present"],
    applicationId: "application-extra",
    applyHost: "jobs.example.com",
    ...overrides
  };
}

function answerReviewResponse(overrides: Record<string, unknown> = {}) {
  return {
    answer: {
      id: "answer-scalar",
      runId: RUN_ID,
      status: "APPROVED",
      reviewedByUser: true,
      reviewedAt: "2026-08-29T20:30:00.000Z",
      sensitive: false,
      valueRedacted: false,
      ...overrides
    }
  };
}

test("answer review eligibility is exactly pending proposable", () => {
  const cases = [
    ["PENDING", "PROPOSABLE", true],
    ["PENDING", "MANUAL_ONLY", false],
    ["PENDING", "EXCLUDED", false],
    ["PENDING", "UNSUPPORTED", false],
    ["APPROVED", "PROPOSABLE", false],
    ["REJECTED", "PROPOSABLE", false]
  ] as const;
  for (const [status, disposition, expected] of cases) {
    assert.equal(isAnswerReviewEligible({ status, disposition }), expected, `${status}/${disposition}`);
  }
});

test("answer review request builders use only exact encoded route and body fields", () => {
  const approve = buildAnswerReviewRequest({
    runId: "run/sentinel",
    answerId: "answer/sentinel",
    answerPacketVersion: 3,
    status: "APPROVED",
    proposal: "proposal-sentinel",
    question: "question-sentinel"
  } as never);
  const reject = buildAnswerReviewRequest({
    runId: RUN_ID,
    answerId: "answer-scalar",
    answerPacketVersion: 3,
    status: "REJECTED"
  });
  assert.equal(approve.url, "/api/application-runs/run%2Fsentinel/answers/answer%2Fsentinel/review");
  assert.equal(approve.init.method, "POST");
  assert.deepEqual(approve.init.headers, { "Content-Type": "application/json" });
  assert.equal(approve.init.cache, "no-store");
  assert.deepEqual(JSON.parse(approve.init.body), { status: "APPROVED", answerPacketVersion: 3 });
  assert.deepEqual(JSON.parse(reject.init.body), { status: "REJECTED", answerPacketVersion: 3 });
  assert.equal(JSON.stringify([approve, reject]).includes("proposal-sentinel"), false);
  assert.equal(JSON.stringify([approve, reject]).includes("question-sentinel"), false);
});

test("run review parser projects strict current authority and preserves canonical reasons", () => {
  const parsed = parseApplicationRunReviewResponse({ run: validRunAuthority() }, RUN_ID);
  assert.deepEqual(parsed, {
    id: RUN_ID,
    state: "REVIEW_REQUIRED",
    stateVersion: 7,
    reviewReasons: ["unknown_requirement_ids", "evidence_gaps_present"]
  });
  for (const value of [
    null,
    [],
    { run: validRunAuthority({ id: OTHER_RUN_ID }) },
    { run: validRunAuthority({ state: "NOT_A_STATE" }) },
    { run: validRunAuthority({ stateVersion: -1 }) },
    { run: validRunAuthority({ stateVersion: 1.5 }) },
    { run: validRunAuthority({ stateVersion: Number.MAX_SAFE_INTEGER + 1 }) },
    { run: validRunAuthority({ reviewReasons: ["unknown_requirement_ids", "unknown_requirement_ids"] }) },
    { run: validRunAuthority({ reviewReasons: ["unknown_requirement_ids", "not-a-reason"] }) },
    { run: validRunAuthority({ reviewReasons: ["evidence_gaps_present", "unknown_requirement_ids"] }) },
    { run: validRunAuthority({ reviewReasons: "not-an-array" }) },
    { run: validRunAuthority(), unexpected: true },
    { unexpected: true }
  ]) {
    assert.throws(() => parseApplicationRunReviewResponse(value, RUN_ID));
  }
  const source = validRunAuthority({ reviewReasons: ["unknown_requirement_ids"] });
  const projected = parseApplicationRunReviewResponse({ run: source }, RUN_ID);
  assert.equal("applicationId" in projected, false);
  assert.equal("applyHost" in projected, false);
});

test("review reason labels contain exactly the six canonical strings in server order", () => {
  assert.deepEqual(Object.keys(REVIEW_REASON_LABELS), PLAN_REVIEW_REASONS);
  assert.deepEqual(REVIEW_REASON_LABELS, {
    unknown_requirement_ids: "Some job requirements could not be matched exactly.",
    unknown_evidence_ids: "Some supporting evidence references could not be matched exactly.",
    exaggerated_evidence_removed: "Unsupported or exaggerated evidence was removed.",
    invented_numeric_claims: "Unsupported numeric claims were detected and removed.",
    planner_confidence_below_threshold: "Application-plan confidence is below the required threshold.",
    evidence_gaps_present: "Some application requirements still have evidence gaps."
  });
  const parsed = parseApplicationRunReviewResponse(
    { run: validRunAuthority({ reviewReasons: ["planner_confidence_below_threshold", "evidence_gaps_present"] }) },
    RUN_ID
  );
  assert.deepEqual(parsed.reviewReasons, ["planner_confidence_below_threshold", "evidence_gaps_present"]);
  assert.equal("unknown_reason" in REVIEW_REASON_LABELS, false);
});

test("answer review response parser accepts only the exact reviewed answer DTO", () => {
  assert.doesNotThrow(() => parseAnswerReviewResponse(answerReviewResponse(), {
    runId: RUN_ID,
    answerId: "answer-scalar",
    status: "APPROVED"
  }));
  for (const value of [
    answerReviewResponse({ runId: OTHER_RUN_ID }),
    answerReviewResponse({ id: "other-answer" }),
    answerReviewResponse({ status: "REJECTED" }),
    answerReviewResponse({ reviewedByUser: false }),
    answerReviewResponse({ reviewedAt: null }),
    answerReviewResponse({ reviewedAt: "not-a-date" }),
    { ...answerReviewResponse(), extra: true },
    { answer: { ...answerReviewResponse().answer, extra: true } },
    { answer: "malformed" },
    null
  ]) {
    assert.throws(() => parseAnswerReviewResponse(value, {
      runId: RUN_ID,
      answerId: "answer-scalar",
      status: "APPROVED"
    }));
  }
});

test("resolve review eligibility requires complete trusted review-required authority", () => {
  const packet = {
    ...validPacket(),
    reviewedAt: null,
    summary: { ...validPacket().summary, readyForRunResolution: true }
  };
  const run = validRunAuthority();
  const complete = { run: run as ReviewRunAuthority, packet, trusted: true };
  assert.equal(isResolveReviewEligible(complete), true);
  const applicationRunStates = [
    "DRAFT",
    "PREPARING",
    "READY",
    "FILLING",
    "REVIEW_REQUIRED",
    "READY_FOR_USER_SUBMISSION",
    "COMPLETED_BY_USER",
    "BLOCKED",
    "FAILED",
    "CANCELLED"
  ] as const;
  for (const state of applicationRunStates) {
    if (state === "REVIEW_REQUIRED") continue;
    assert.equal(
      isResolveReviewEligible({
        ...complete,
        run: { ...run, state } as ReviewRunAuthority
      }),
      false,
      `state=${state}`
    );
  }
  const cases = [
    { ...complete, trusted: false },
    { ...complete, run: null },
    { ...complete, packet: null },
    { ...complete, packet: { ...packet, reviewedAt: "2026-08-29T20:30:00.000Z" } },
    { ...complete, packet: { ...packet, summary: { ...packet.summary, readyForRunResolution: false } } }
  ];
  for (const value of cases) assert.equal(isResolveReviewEligible(value), false);
});

test("resolve review request contains exact ordered authority fields and no packet content", () => {
  const run = validRunAuthority({ reviewReasons: ["unknown_requirement_ids", "evidence_gaps_present"] }) as ReviewRunAuthority;
  const packet = validPacket();
  const request = buildResolveReviewRequest({ runId: RUN_ID, run, packet });
  assert.equal(request.url, `/api/application-runs/${encodeURIComponent(RUN_ID)}/resolve-review`);
  assert.equal(request.init.method, "POST");
  assert.equal(request.init.cache, "no-store");
  assert.deepEqual(JSON.parse(request.init.body), {
    stateVersion: 7,
    acknowledgedReviewReasons: ["unknown_requirement_ids", "evidence_gaps_present"],
    answerPacketVersion: 3,
    packetHash: "a".repeat(64)
  });
  assert.equal(JSON.stringify(request).includes("Portfolio URL"), false);
  assert.equal(JSON.stringify(request).includes("https://example.com"), false);
  assert.equal(JSON.stringify(request).includes("answer-scalar"), false);
});

test("answer postcondition confirms only the exact current reviewed answer", () => {
  const snapshot: AnswerReviewMutationSnapshot = {
    answerId: "answer-scalar",
    requestedStatus: "APPROVED",
    answerPacketVersion: 3
  };
  const packet = validPacket();
  packet.answers[0] = { ...packet.answers[0], status: "APPROVED", reviewedByUser: true, reviewedAt: "2026-08-29T20:30:00.000Z" };
  const complete = { phase: "loaded" as const, unverified: false, packet, snapshot };
  assert.equal(isAnswerReviewPostconditionCurrent(complete), true);
  const failures = [
    { ...complete, phase: "loading" as const },
    { ...complete, unverified: true },
    { ...complete, packet: null },
    { ...complete, packet: { ...packet, answerPacketVersion: 4 } },
    { ...complete, packet: { ...packet, answers: packet.answers.slice(1) } },
    { ...complete, packet: { ...packet, answers: [{ ...packet.answers[0], status: "REJECTED" }] as never } },
    { ...complete, packet: { ...packet, answers: [{ ...packet.answers[0], reviewedByUser: false }] } },
    { ...complete, packet: { ...packet, answers: [{ ...packet.answers[0], reviewedAt: null }] } }
  ];
  for (const value of failures) assert.equal(isAnswerReviewPostconditionCurrent(value), false);
});

test("resolve postcondition confirms only ready current authority with matching packet", () => {
  const snapshot: ResolveReviewMutationSnapshot = {
    stateVersion: 7,
    answerPacketVersion: 3,
    packetHash: "a".repeat(64),
    acknowledgedReviewReasons: ["unknown_requirement_ids", "evidence_gaps_present"]
  };
  const complete = {
    phase: "loaded" as const,
    unverified: false,
    run: { ...validRunAuthority({ state: "READY" }) } as ReviewRunAuthority,
    packet: validPacket(),
    snapshot
  };
  assert.equal(isResolveReviewPostconditionCurrent(complete), true);
  const applicationRunStates = [
    "DRAFT",
    "PREPARING",
    "READY",
    "FILLING",
    "REVIEW_REQUIRED",
    "READY_FOR_USER_SUBMISSION",
    "COMPLETED_BY_USER",
    "BLOCKED",
    "FAILED",
    "CANCELLED"
  ] as const;
  for (const state of applicationRunStates) {
    if (state === "READY") continue;
    assert.equal(
      isResolveReviewPostconditionCurrent({
        ...complete,
        run: { ...complete.run, state } as ReviewRunAuthority
      }),
      false,
      `state=${state}`
    );
  }
  const failures = [
    { ...complete, phase: "loading" as const },
    { ...complete, unverified: true },
    { ...complete, run: null },
    { ...complete, packet: null },
    { ...complete, packet: { ...complete.packet, answerPacketVersion: 4 } },
    { ...complete, packet: { ...complete.packet, packetHash: "b".repeat(64) } },
    { ...complete, packet: { ...complete.packet, reviewedAt: null } }
  ];
  for (const value of failures) assert.equal(isResolveReviewPostconditionCurrent(value), false);
});

test("command authorization covers every workflow state and uses the exact frozen command names", () => {
  for (const state of workflowStates) {
    const availability = browserCommandAvailability({
      status: { state, runId: RUN_ID },
      connection: "CONNECTED",
      pendingCommand: null
    });
    assert.deepEqual(Object.keys(availability), commands);
    assert.equal(availability.GET_STATUS, state !== "CLOSED", `${state} GET_STATUS`);
    assert.equal(availability.OPEN_TARGET, state === "CONTROL_READY", `${state} OPEN_TARGET`);
    assert.equal(availability.INSPECT_FORM, state === "TARGET_OPEN", `${state} INSPECT_FORM`);
    assert.equal(availability.CLOSE_WORKFLOW, state !== "CLOSED", `${state} CLOSE_WORKFLOW`);
    assert.equal("CLOSE" in availability, false);
  }
});

test("CLOSED, pending commands, unavailable connections, and in-progress inspection suppress commands", () => {
  assert.deepEqual(
    browserCommandAvailability({
      status: { state: "CLOSED", runId: RUN_ID },
      connection: "CONNECTED",
      pendingCommand: null
    }),
    { GET_STATUS: false, OPEN_TARGET: false, INSPECT_FORM: false, CLOSE_WORKFLOW: false }
  );

  for (const pendingCommand of commands) {
    assert.deepEqual(
      browserCommandAvailability({
        status: { state: "TARGET_OPEN", runId: RUN_ID },
        connection: "CONNECTED",
        pendingCommand
      }),
      { GET_STATUS: false, OPEN_TARGET: false, INSPECT_FORM: false, CLOSE_WORKFLOW: false }
    );
  }

  assert.deepEqual(
    browserCommandAvailability({
      status: { state: "TARGET_OPEN", runId: RUN_ID },
      connection: "UNKNOWN",
      pendingCommand: null
    }),
    { GET_STATUS: true, OPEN_TARGET: false, INSPECT_FORM: false, CLOSE_WORKFLOW: false }
  );
  assert.deepEqual(
    browserCommandAvailability({
      status: { state: "TARGET_OPEN", runId: RUN_ID },
      connection: "UNAVAILABLE",
      pendingCommand: null
    }),
    { GET_STATUS: false, OPEN_TARGET: false, INSPECT_FORM: false, CLOSE_WORKFLOW: false }
  );

  assert.equal(
    browserCommandAvailability({
      status: { state: "TARGET_OPEN", runId: RUN_ID, inspection: { outcome: "IN_PROGRESS" } },
      connection: "CONNECTED",
      pendingCommand: null
    }).INSPECT_FORM,
    false
  );
});

test("retry connection is offered only for an idle unavailable non-closed workflow", () => {
  assert.equal(shouldOfferRetryConnection("UNAVAILABLE", { state: "TARGET_OPEN", runId: RUN_ID }, null), true);
  assert.equal(shouldOfferRetryConnection("UNKNOWN", { state: "TARGET_OPEN", runId: RUN_ID }, null), false);
  assert.equal(shouldOfferRetryConnection("CONNECTED", { state: "TARGET_OPEN", runId: RUN_ID }, null), false);
  assert.equal(shouldOfferRetryConnection("UNAVAILABLE", { state: "CLOSED", runId: RUN_ID }, null), false);
  assert.equal(
    shouldOfferRetryConnection("UNAVAILABLE", { state: "TARGET_OPEN", runId: RUN_ID }, "GET_STATUS"),
    false
  );
});

test("binding rejection plans preserve authoritative status and permit at most one guarded recovery", () => {
  const status: B1Status = { state: "TARGET_OPEN", runId: RUN_ID, targetHost: "jobs.example.com" };
  const expected = {
    GET_STATUS: { recoverWithGetStatus: false, packetTrust: "UNCHANGED" },
    OPEN_TARGET: { recoverWithGetStatus: true, packetTrust: "UNCHANGED" },
    INSPECT_FORM: { recoverWithGetStatus: true, packetTrust: "UNVERIFIED" },
    CLOSE_WORKFLOW: { recoverWithGetStatus: true, packetTrust: "UNCHANGED" }
  } as const;

  for (const command of commands) {
    const plan = bindingRejectionPlan(command, status, "current");
    assert.equal(plan.connection, "UNAVAILABLE");
    assert.equal(plan.preservedStatus, status);
    assert.equal(plan.recoverWithGetStatus, expected[command].recoverWithGetStatus);
    assert.equal(plan.packetTrust, expected[command].packetTrust);
    assert.notEqual(plan.preservedStatus.state, "ERROR");
  }

  assert.equal(
    bindingRejectionPlan("CLOSE_WORKFLOW", { state: "CLOSED", runId: RUN_ID }, "current")
      .recoverWithGetStatus,
    false
  );
  assert.equal(
    bindingRejectionPlan("INSPECT_FORM", status, "stale").packetTrust,
    "STALE"
  );
});

test("inspection presentation covers progress, material success, replay, reinspection, and retryAllowed", () => {
  assert.deepEqual(inspectionPresentation({ outcome: "IN_PROGRESS" }), {
    tone: "INFO",
    text: "Inspection is in progress. No employer fields are being filled or submitted.",
    retryAllowed: false,
    invalidatesPacket: false,
    automaticPacketRefreshKey: null
  });

  assert.deepEqual(
    inspectionPresentation({
      outcome: "SUCCEEDED",
      replayed: false,
      inspectionVersion: 2,
      answerPacketVersion: 3,
      reinspectionRequired: false
    }),
    {
      tone: "SUCCESS",
      text: "Inspection was published and the current answer packet was updated. Review the proposed answers below. No employer fields were filled or submitted.",
      retryAllowed: false,
      invalidatesPacket: false,
      automaticPacketRefreshKey: "2:3"
    }
  );

  assert.deepEqual(
    inspectionPresentation({
      outcome: "SUCCEEDED",
      replayed: true,
      inspectionVersion: 2,
      answerPacketVersion: 3,
      reinspectionRequired: false
    }),
    {
      tone: "SUCCESS",
      text: "Existing current packet matched the verified inspection; no new packet version was created.",
      retryAllowed: false,
      invalidatesPacket: false,
      automaticPacketRefreshKey: "2:3"
    }
  );

  const succeededStale = inspectionPresentation({
    outcome: "SUCCEEDED",
    replayed: false,
    inspectionVersion: 2,
    answerPacketVersion: 3,
    reinspectionRequired: true
  });
  assert.equal(succeededStale.invalidatesPacket, true);
  assert.equal(succeededStale.automaticPacketRefreshKey, null);
  assert.match(succeededStale.text, /changed.*inspect/i);

  const reinspection = inspectionPresentation({
    outcome: "REINSPECTION_REQUIRED",
    errorCode: "FORM_GENERATION_INVALIDATED",
    retryAllowed: true
  });
  assert.equal(reinspection.retryAllowed, true);
  assert.equal(reinspection.invalidatesPacket, true);
  assert.equal("retry" in reinspection, false);
});

test("all eleven recoverable failures use closed safe messages and exact retryAllowed", () => {
  for (const [errorCode, text] of Object.entries(recoverableMessages) as Array<
    [BrowserInspectionRecoverableCode, string]
  >) {
    const input: B2InspectionCommandStatus = { outcome: "FAILED", errorCode, retryAllowed: true };
    const presentation = inspectionPresentation(input);
    assert.equal(presentation.text, text, errorCode);
    assert.equal(presentation.retryAllowed, true, errorCode);
    assert.equal(presentation.invalidatesPacket, errorCode === "FORM_GENERATION_INVALIDATED", errorCode);
    assert.equal(presentation.automaticPacketRefreshKey, null, errorCode);
    assert.equal("retry" in presentation, false, errorCode);
  }
});

test("authoritative status handling accepts matching statuses through one path and clears invalidation on clean success", () => {
  const status: B1Status = {
    state: "TARGET_OPEN",
    runId: RUN_ID,
    inspection: {
      outcome: "SUCCEEDED",
      replayed: true,
      inspectionVersion: 2,
      answerPacketVersion: 3,
      reinspectionRequired: false
    }
  };
  const result = applyAuthoritativeBrowserStatus({
    value: status,
    expectedRunId: RUN_ID,
    formInvalidatedSinceVerifiedSuccess: true
  });
  assert.equal(result.accepted, true);
  if (!result.accepted) return;
  assert.deepEqual(result.status, status);
  assert.equal(result.connection, "CONNECTED");
  assert.deepEqual(result.lastAcceptedInspection, status.inspection);
  assert.equal(result.formInvalidatedSinceVerifiedSuccess, false);
  assert.equal(result.automaticPacketRefreshKey, "2:3");
  assert.equal(
    result.notice?.text,
    "Existing current packet matched the verified inspection; no new packet version was created."
  );
});

test("authoritative status handling rejects wrong-run and malformed values without fabricating status", () => {
  for (const value of [
    { state: "TARGET_OPEN", runId: OTHER_RUN_ID },
    { state: "NOT_A_STATE", runId: RUN_ID },
    { state: "TARGET_OPEN", runId: RUN_ID, unexpected: true },
    null,
    []
  ]) {
    const result = applyAuthoritativeBrowserStatus({
      value,
      expectedRunId: RUN_ID,
      formInvalidatedSinceVerifiedSuccess: false
    });
    assert.deepEqual(result, { accepted: false, connection: "UNAVAILABLE" });
    assert.equal("status" in result, false);
  }
});

test("authoritative invalidation history survives failures and clears only after a clean success", () => {
  const invalidated = applyAuthoritativeBrowserStatus({
    value: {
      state: "TARGET_OPEN",
      runId: RUN_ID,
      inspection: {
        outcome: "REINSPECTION_REQUIRED",
        errorCode: "FORM_GENERATION_INVALIDATED",
        retryAllowed: true
      }
    },
    expectedRunId: RUN_ID,
    formInvalidatedSinceVerifiedSuccess: false
  });
  assert.equal(invalidated.accepted && invalidated.formInvalidatedSinceVerifiedSuccess, true);

  const failed = applyAuthoritativeBrowserStatus({
    value: {
      state: "TARGET_OPEN",
      runId: RUN_ID,
      inspection: { outcome: "FAILED", errorCode: "FORM_STABILITY_TIMEOUT", retryAllowed: true }
    },
    expectedRunId: RUN_ID,
    formInvalidatedSinceVerifiedSuccess: true
  });
  assert.equal(failed.accepted && failed.formInvalidatedSinceVerifiedSuccess, true);
});

test("packet parser accepts a valid null packet and a complete strict packet", () => {
  assert.deepEqual(parseAnswerPacketResponse({ runId: RUN_ID, current: null }, RUN_ID), {
    runId: RUN_ID,
    current: null
  });
  const packet = validPacket();
  assert.deepEqual(parseAnswerPacketResponse({ runId: RUN_ID, current: packet }, RUN_ID), {
    runId: RUN_ID,
    current: packet
  });
});

test("packet parser rejects invalid top-level boundaries, wrong run IDs, missing current, and extra keys", () => {
  for (const value of [
    null,
    [],
    "packet",
    1,
    { runId: RUN_ID },
    { runId: OTHER_RUN_ID, current: null },
    { runId: RUN_ID, current: null, extra: true }
  ]) {
    assert.throws(() => parseAnswerPacketResponse(value, RUN_ID));
  }
});

test("packet parser rejects bad versions, hashes, timestamps, summaries, and answer containers", () => {
  const mutations: Array<(packet: AnswerPacket) => unknown> = [
    (packet) => ({ ...packet, inspectionVersion: 0 }),
    (packet) => ({ ...packet, inspectionVersion: 1.5 }),
    (packet) => ({ ...packet, answerPacketVersion: Number.MAX_SAFE_INTEGER + 1 }),
    (packet) => ({ ...packet, packetHash: "" }),
    (packet) => ({ ...packet, packetHash: "x".repeat(513) }),
    (packet) => ({ ...packet, createdAt: "yesterday" }),
    (packet) => ({ ...packet, reviewedAt: "2026-13-90" }),
    (packet) => ({ ...packet, summary: { ...packet.summary, fieldCount: -1 } }),
    (packet) => ({ ...packet, summary: { ...packet.summary, readyForRunResolution: "yes" } }),
    (packet) => ({ ...packet, summary: { ...packet.summary, extra: 1 } }),
    (packet) => ({ ...packet, answers: "not-an-array" }),
    (packet) => ({ ...packet, extra: true })
  ];
  for (const mutate of mutations) {
    assert.throws(() => parseAnswerPacketResponse({ runId: RUN_ID, current: mutate(validPacket()) }, RUN_ID));
  }
});

test("packet parser accepts only exact lowercase SHA-256 packet hashes", () => {
  const accepted = validPacket();
  accepted.packetHash = "0123456789abcdef".repeat(4);
  assert.deepEqual(parseAnswerPacketResponse({ runId: RUN_ID, current: accepted }, RUN_ID).current, accepted);

  for (const packetHash of [
    "a".repeat(63),
    "a".repeat(65),
    "A".repeat(64),
    `${"a".repeat(63)}g`,
    "not-a-sha256",
    ""
  ]) {
    const packet = validPacket();
    packet.packetHash = packetHash;
    assert.throws(
      () => parseAnswerPacketResponse({ runId: RUN_ID, current: packet }, RUN_ID),
      `packetHash=${packetHash}`
    );
  }
});

test("packet parser rejects sensitive or redacted answers carrying every proposal variant", () => {
  const variants = [
    {
      proposal: { kind: "SCALAR" as const, value: "privacy-sentinel-scalar" },
      fieldType: "URL" as const,
      classification: "PROFESSIONAL_LINK" as const,
      choices: []
    },
    {
      proposal: { kind: "BOOLEAN" as const, value: true },
      fieldType: "CHECKBOX_BOOLEAN" as const,
      classification: "AVAILABILITY" as const,
      choices: []
    },
    {
      proposal: { kind: "OPTIONS" as const, optionKeys: ["privacy-sentinel-option-key"] },
      fieldType: "SELECT_ONE" as const,
      classification: "RELOCATION" as const,
      choices: [{ key: "privacy-sentinel-option-key", label: "privacy-sentinel-option-label", disabled: false }]
    },
    {
      proposal: {
        kind: "DOCUMENT_REFERENCE" as const,
        artifactType: "RESUME" as const,
        documentId: "privacy-sentinel-document"
      },
      fieldType: "FILE_UPLOAD" as const,
      classification: "DOCUMENT" as const,
      choices: []
    }
  ];

  for (const variant of variants) {
    for (const privacy of [
      { sensitive: true, valueRedacted: false },
      { sensitive: false, valueRedacted: true }
    ]) {
      const packet = validPacket();
      packet.answers[0] = {
        ...packet.answers[0],
        fieldType: variant.fieldType,
        classification: variant.classification,
        choices: variant.choices,
        proposal: variant.proposal,
        ...privacy
      };
      assert.throws(() => parseAnswerPacketResponse({ runId: RUN_ID, current: packet }, RUN_ID));
      assert.equal(
        presentProposal(variant.proposal, variant.choices, {
          disposition: "PROPOSABLE",
          ...privacy
        }),
        null
      );
    }
  }
});

test("packet parser rejects proposal authority on every non-proposable disposition", () => {
  const cases = [
    {
      disposition: "MANUAL_ONLY" as const,
      dispositionReason: "V1_MANUAL_POLICY" as const,
      sensitive: false,
      valueRedacted: false
    },
    {
      disposition: "EXCLUDED" as const,
      dispositionReason: "POLICY_EXCLUDED" as const,
      sensitive: true,
      valueRedacted: true
    },
    {
      disposition: "UNSUPPORTED" as const,
      dispositionReason: "UNSUPPORTED_CONTROL" as const,
      sensitive: false,
      valueRedacted: false
    }
  ];
  for (const invalid of cases) {
    const packet = validPacket();
    packet.answers[0] = {
      ...packet.answers[0],
      ...invalid,
      proposal: { kind: "SCALAR", value: "non-proposable-sentinel" },
      requiresReview: false
    };
    assert.throws(() => parseAnswerPacketResponse({ runId: RUN_ID, current: packet }, RUN_ID));
    assert.equal(
      presentProposal(packet.answers[0].proposal!, packet.answers[0].choices, packet.answers[0]),
      null
    );
  }
});

test("packet parser closes all answer enums and rejects unexpected answer keys", () => {
  const keys = ["fieldType", "classification", "disposition", "dispositionReason", "status"] as const;
  for (const key of keys) {
    const packet = validPacket();
    packet.answers[0] = { ...packet.answers[0], [key]: "UNKNOWN_ENUM" } as never;
    assert.throws(() => parseAnswerPacketResponse({ runId: RUN_ID, current: packet }, RUN_ID), key);
  }
  const packet = validPacket();
  packet.answers[0] = { ...packet.answers[0], extra: true } as never;
  assert.throws(() => parseAnswerPacketResponse({ runId: RUN_ID, current: packet }, RUN_ID));
});

test("packet parser rejects bad choices and malformed or unknown proposal variants", () => {
  const proposals: unknown[] = [
    { kind: "UNKNOWN", value: "x" },
    { kind: "SCALAR", value: true },
    { kind: "SCALAR", value: "x", extra: true },
    { kind: "BOOLEAN", value: "true" },
    { kind: "OPTIONS", optionKeys: "remote" },
    { kind: "OPTIONS", optionKeys: [1] },
    { kind: "DOCUMENT_REFERENCE", artifactType: "PORTFOLIO", documentId: "doc-1" },
    { kind: "DOCUMENT_REFERENCE", artifactType: "RESUME" }
  ];
  for (const proposal of proposals) {
    const packet = validPacket();
    packet.answers[0] = { ...packet.answers[0], proposal } as never;
    assert.throws(() => parseAnswerPacketResponse({ runId: RUN_ID, current: packet }, RUN_ID));
  }

  for (const choices of [
    "not-an-array",
    [{ key: "remote", label: "Remote" }],
    [{ key: "remote", label: "Remote", disabled: false, extra: true }]
  ]) {
    const packet = validPacket();
    packet.answers[0] = { ...packet.answers[0], choices } as never;
    assert.throws(() => parseAnswerPacketResponse({ runId: RUN_ID, current: packet }, RUN_ID));
  }
});

test("freshness derives absent, current, stale, and unverified without a mutable current flag", () => {
  const cases: Array<[string, Record<string, unknown>, PacketFreshness]> = [
    ["absent", { packet: null, latestPacketResponseWasNull: true }, "absent"],
    ["current", {}, "current"],
    [
      "reinspection required",
      {
        lastAcceptedInspection: {
          outcome: "REINSPECTION_REQUIRED",
          errorCode: "FORM_GENERATION_INVALIDATED",
          retryAllowed: true
        }
      },
      "stale"
    ],
    ["remembered invalidation", { formInvalidatedSinceVerifiedSuccess: true }, "stale"],
    ["packet load failure", { packetLoadUnverified: true }, "unverified"],
    ["connection loss", { connection: "UNAVAILABLE" }, "unverified"],
    ["unknown connection", { connection: "UNKNOWN" }, "unverified"],
    ["terminal workflow", { workflowState: "CLOSED" }, "unverified"],
    ["non-target workflow", { workflowState: "CONTROL_READY" }, "unverified"],
    ["inspection mismatch", { packet: { ...validPacket(), inspectionVersion: 9 } }, "unverified"],
    ["packet mismatch", { packet: { ...validPacket(), answerPacketVersion: 9 } }, "unverified"]
  ];
  for (const [name, overrides, expected] of cases) {
    assert.equal(derivePacketFreshness(currentFreshnessInput(overrides)), expected, name);
  }
});

test("recoverable failure makes a prior current packet unverified unless invalidation makes it stale", () => {
  const failure = {
    outcome: "FAILED" as const,
    errorCode: "FORM_STABILITY_TIMEOUT" as const,
    retryAllowed: true as const
  };
  assert.equal(derivePacketFreshness(currentFreshnessInput({ lastAcceptedInspection: failure })), "unverified");
  assert.equal(
    derivePacketFreshness(
      currentFreshnessInput({ lastAcceptedInspection: failure, formInvalidatedSinceVerifiedSuccess: true })
    ),
    "stale"
  );
});

test("a clean replay can restore matching stale packet while a manual packet refresh cannot", () => {
  const stale = currentFreshnessInput({ formInvalidatedSinceVerifiedSuccess: true });
  assert.equal(derivePacketFreshness(stale), "stale");
  assert.equal(
    derivePacketFreshness({ ...stale, packet: validPacket(), packetLoadUnverified: false }),
    "stale",
    "manual refresh alone"
  );
  assert.equal(
    derivePacketFreshness(
      currentFreshnessInput({
        lastAcceptedInspection: {
          outcome: "SUCCEEDED",
          replayed: true,
          inspectionVersion: 2,
          answerPacketVersion: 3,
          reinspectionRequired: false
        },
        formInvalidatedSinceVerifiedSuccess: false
      })
    ),
    "current"
  );
});

test("proposal presentation handles scalar, boolean, and document references without employer-action claims", () => {
  assert.deepEqual(presentProposal({ kind: "SCALAR", value: "Ada" }, [], SAFE_PROPOSAL_CONTEXT), {
    label: "Proposed answer — review before use",
    values: [{ text: "Ada", annotation: null }]
  });
  assert.deepEqual(presentProposal({ kind: "BOOLEAN", value: true }, [], SAFE_PROPOSAL_CONTEXT), {
    label: "Proposed answer — review before use",
    values: [{ text: "Yes", annotation: null }]
  });
  assert.deepEqual(presentProposal({ kind: "BOOLEAN", value: false }, [], SAFE_PROPOSAL_CONTEXT), {
    label: "Proposed answer — review before use",
    values: [{ text: "No", annotation: null }]
  });
  assert.deepEqual(
    presentProposal(
      { kind: "DOCUMENT_REFERENCE", artifactType: "RESUME", documentId: "resume-version-1" },
      [],
      SAFE_PROPOSAL_CONTEXT
    ),
    {
      label: "Proposed résumé document reference",
      values: [{ text: "resume-version-1", annotation: null }]
    }
  );
  assert.deepEqual(
    presentProposal(
      { kind: "DOCUMENT_REFERENCE", artifactType: "COVER_LETTER", documentId: "letter-version-1" },
      [],
      SAFE_PROPOSAL_CONTEXT
    ),
    {
      label: "Proposed cover-letter document reference",
      values: [{ text: "letter-version-1", annotation: null }]
    }
  );
});

test("option proposal resolution preserves order and refuses missing or duplicate keys", () => {
  const choices = [
    { key: "a", label: "Same label", disabled: false },
    { key: "b", label: "Same label", disabled: true },
    { key: "duplicate", label: "First duplicate", disabled: false },
    { key: "duplicate", label: "Second duplicate", disabled: false }
  ];
  assert.deepEqual(presentProposal({ kind: "OPTIONS", optionKeys: ["b", "a"] }, choices, SAFE_PROPOSAL_CONTEXT), {
    label: "Proposed answer — review before use",
    values: [
      { text: "Same label", annotation: "Disabled option" },
      { text: "Same label", annotation: null }
    ]
  });
  assert.deepEqual(presentProposal({ kind: "OPTIONS", optionKeys: ["missing", "duplicate"] }, choices, SAFE_PROPOSAL_CONTEXT), {
    label: "Proposed answer — review before use",
    values: [
      { text: "Option unavailable in packet choices", annotation: null },
      { text: "Option unavailable in packet choices", annotation: null }
    ]
  });
});

test("disposition and readiness copy remain read-only and avoid submission claims", () => {
  assert.equal(
    dispositionMessage("PROPOSABLE"),
    "Apply Pilot produced a proposed answer. Review it before using it."
  );
  assert.equal(dispositionMessage("MANUAL_ONLY"), "You must answer this field manually.");
  assert.equal(dispositionMessage("EXCLUDED"), "Apply Pilot intentionally did not propose an answer.");
  assert.equal(
    dispositionMessage("UNSUPPORTED"),
    "This field or control is unsupported and must be handled manually."
  );

  assert.equal(
    readinessMessage(true),
    "Packet review requirements are satisfied for Apply Pilot's internal run-review workflow."
  );
  assert.equal(
    readinessMessage(false),
    "Packet review requirements are not yet satisfied for Apply Pilot's internal run-review workflow."
  );
  for (const value of [readinessMessage(true), readinessMessage(false)]) {
    assert.doesNotMatch(value, /ready to submit|submission ready|application complete|employer form complete/i);
  }
});

test("mounted control harness renders the real component and completes its initial packet read", async (t) => {
  const control = await mountControl();
  t.after(() => control.cleanup());

  assert.match(control.container.textContent ?? "", /Current answer packet/);
  assert.match(control.container.textContent ?? "", /No current answer packet has been published yet/);
  assert.equal(control.fetchCalls.length, 2);
});

test("mounted control never presents local STARTING as accepted companion authority", async (t) => {
  const control = await mountControl();
  t.after(() => control.cleanup());

  const text = control.container.textContent ?? "";
  assert.doesNotMatch(text, /\bSTARTING\b/);
  assert.match(text, /Awaiting companion status/);
});

test("first missing binding reports that no companion status was received", async (t) => {
  const control = await mountControl();
  t.after(() => control.cleanup());

  await clickButton(control, "Refresh status");
  const text = control.container.textContent ?? "";
  assert.match(text, /No companion status received/);
  assert.doesNotMatch(text, /last accepted browser status is preserved/i);
  assert.doesNotMatch(text, /\bSTARTING\b/);
});

test("initial wrong-run and malformed statuses do not invent prior companion authority", async () => {
  for (const value of [
    { state: "TARGET_OPEN", runId: OTHER_RUN_ID },
    { state: "NOT_A_STATE", runId: RUN_ID }
  ]) {
    const control = await mountControl();
    try {
      control.setBinding(async () => value as B1Status);
      await clickButton(control, "Refresh status");
      const text = control.container.textContent ?? "";
      assert.match(text, /No companion status received/);
      assert.doesNotMatch(text, /last accepted browser status is preserved/i);
      assert.doesNotMatch(text, /\bSTARTING\b/);
    } finally {
      await control.cleanup();
    }
  }
});

test("a real accepted status is preserved accurately after later connection loss", async (t) => {
  const control = await mountControl();
  t.after(() => control.cleanup());
  let callCount = 0;
  control.setBinding(async () => {
    callCount += 1;
    if (callCount === 1) return { state: "TARGET_OPEN", runId: RUN_ID };
    throw new Error("private binding failure");
  });

  await clickButton(control, "Refresh status");
  assert.match(control.container.textContent ?? "", /TARGET_OPEN/);
  await clickButton(control, "Refresh status");

  const text = control.container.textContent ?? "";
  assert.match(text, /TARGET_OPEN/);
  assert.match(text, /last accepted browser status is preserved/i);
});

test("mounted packet boundary rejects a redacted proposal without rendering its sentinel", async (t) => {
  const packet = validPacket();
  packet.answers[0] = {
    ...packet.answers[0],
    proposal: { kind: "SCALAR", value: "render-privacy-sentinel" },
    sensitive: true,
    valueRedacted: true
  };
  const control = await mountControl(async (input) => String(input).endsWith("/answer-packet") ? packetResponse(packet) : runResponse());
  t.after(() => control.cleanup());

  const text = control.container.textContent ?? "";
  assert.match(text, /could not safely read the review authority response/i);
  assert.doesNotMatch(text, /render-privacy-sentinel/);
});

test("matching browser status cannot make a retained packet-read error current", async (t) => {
  const packet = validPacket();
  const successfulStatus: B1Status = {
    state: "TARGET_OPEN",
    runId: RUN_ID,
    inspection: {
      outcome: "SUCCEEDED",
      replayed: false,
      inspectionVersion: packet.inspectionVersion,
      answerPacketVersion: packet.answerPacketVersion,
      reinspectionRequired: false
    }
  };
  const control = await mountControl(async (input) => String(input).endsWith("/answer-packet") ? packetResponse(packet) : runResponse());
  t.after(() => control.cleanup());
  control.setBinding(async () => successfulStatus);

  await clickButton(control, "Refresh status");
  assert.match(control.container.textContent ?? "", /Current packet —/);

  control.setFetchHandler(async () => new Response("{}", { status: 503 }));
  await clickButton(control, "Refresh review data");
  let text = control.container.textContent ?? "";
  assert.match(text, /temporarily unavailable/i);
  assert.match(text, /Unverified packet —/);
  assert.match(text, /Portfolio URL/);

  await clickButton(control, "Refresh status");
  text = control.container.textContent ?? "";
  assert.match(text, /temporarily unavailable/i);
  assert.match(text, /Unverified packet —/);
  assert.doesNotMatch(text, /Current packet —/);
});

test("Task 2 mounted failed inspection publication fences an older manual authority read without phantom loading", async (t) => {
  const oldRun = deferred<Response>();
  const oldPacket = deferred<Response>();
  const newRun = deferred<Response>();
  const newPacket = deferred<Response>();
  let runReads = 0;
  let packetReads = 0;
  const control = await mountControl(async (input) => {
    const url = String(input);
    if (url.endsWith("/answer-packet")) {
      packetReads += 1;
      return packetReads === 1 ? packetResponse(validPacket()) : packetReads === 2 ? oldPacket.promise : newPacket.promise;
    }
    runReads += 1;
    return runReads === 1 ? runResponse() : runReads === 2 ? oldRun.promise : newRun.promise;
  });
  t.after(() => control.cleanup());
  let statusReads = 0;
  control.setBinding(async (command) => {
    if (command.type === "INSPECT_FORM") throw new Error("inspection publication failed");
    if (command.type === "GET_STATUS") {
      statusReads += 1;
      if (statusReads === 1) return { state: "TARGET_OPEN", runId: RUN_ID };
      throw new Error("guarded status recovery failed");
    }
    throw new Error("unexpected command");
  });

  await clickButton(control, "Refresh status");
  await clickButton(control, "Refresh review data");
  assert.equal(control.fetchCalls.filter((call) => String(call.input) === `/api/application-runs/${RUN_ID}`).length, 2);
  assert.equal(control.fetchCalls.filter((call) => String(call.input).endsWith("/answer-packet")).length, 2);

  await clickButton(control, "Inspect form");
  assert.match(control.container.textContent ?? "", /Portfolio URL/);
  assert.match(control.container.textContent ?? "", /Unverified packet —/);
  assert.match(control.container.textContent ?? "", /displayed packet is unverified until browser status is recovered/i);
  assert.equal(reviewButton(control.container, "Approve", "Portfolio URL").disabled, true);
  assert.equal(reviewButton(control.container, "Reject", "Portfolio URL").disabled, true);
  assert.equal(buttonNamed(control.container, "Refresh review data").disabled, false);
  await clickReviewButton(control, "Approve", "Portfolio URL");
  assert.equal(control.fetchCalls.filter((call) => String(call.input).includes("/review")).length, 0);

  oldRun.resolve(runResponse());
  oldPacket.resolve(packetResponse(validPacket()));
  await flushComponentWork();
  assert.equal(reviewButton(control.container, "Approve", "Portfolio URL").disabled, true);
  assert.equal(reviewButton(control.container, "Reject", "Portfolio URL").disabled, true);
  assert.match(control.container.textContent ?? "", /displayed packet is unverified until browser status is recovered/i);

  await clickButton(control, "Refresh review data");
  assert.equal(reviewButton(control.container, "Approve", "Portfolio URL").disabled, true);
  newRun.resolve(runResponse());
  newPacket.resolve(packetResponse(validPacket()));
  await flushComponentWork();
  assert.equal(reviewButton(control.container, "Approve", "Portfolio URL").disabled, false);
  assert.equal(reviewButton(control.container, "Reject", "Portfolio URL").disabled, false);
});

test("Task 2 mounted matching browser status cannot re-trust inspection-invalidated review authority without a fresh paired read", async (t) => {
  const published = validPacket();
  published.answerPacketVersion = 4;
  const recoveryRun = deferred<Response>();
  const recoveryPacket = deferred<Response>();
  let runReads = 0;
  let packetReads = 0;
  const successfulStatus: B1Status = {
    state: "TARGET_OPEN",
    runId: RUN_ID,
    inspection: {
      outcome: "SUCCEEDED",
      replayed: false,
      inspectionVersion: 2,
      answerPacketVersion: 4,
      reinspectionRequired: false
    }
  };
  const control = await mountControl(async (input) => {
    const url = String(input);
    if (url.endsWith("/answer-packet")) {
      packetReads += 1;
      return packetReads === 1 ? packetResponse(validPacket()) : packetReads === 2 ? packetResponse(published) : recoveryPacket.promise;
    }
    runReads += 1;
    return runReads <= 2 ? runResponse() : recoveryRun.promise;
  });
  t.after(() => control.cleanup());
  control.setBinding(async (command) => {
    if (command.type === "GET_STATUS") return successfulStatus;
    if (command.type === "INSPECT_FORM") throw new Error("inspection command interrupted");
    throw new Error("unexpected command");
  });

  await clickButton(control, "Refresh status");
  assert.equal(reviewButton(control.container, "Approve", "Portfolio URL").disabled, false);

  await clickButton(control, "Inspect form");
  assert.match(control.container.textContent ?? "", /Portfolio URL/);
  assert.equal(reviewButton(control.container, "Approve", "Portfolio URL").disabled, true);
  await clickReviewButton(control, "Approve", "Portfolio URL");
  assert.equal(control.fetchCalls.filter((call) => String(call.input).includes("/review")).length, 0);
  assert.equal(control.fetchCalls.filter((call) => String(call.input) === `/api/application-runs/${RUN_ID}`).length, 3);
  assert.equal(control.fetchCalls.filter((call) => String(call.input).endsWith("/answer-packet")).length, 3);

  recoveryRun.resolve(runResponse());
  recoveryPacket.resolve(packetResponse(published));
  await flushComponentWork();
  assert.equal(reviewButton(control.container, "Approve", "Portfolio URL").disabled, false);
});

test("Task 2 mounted 401 mutation failure fences an older automatic paired authority read", async (t) => {
  const staleRun = deferred<Response>();
  const stalePacket = deferred<Response>();
  const post = deferred<Response>();
  let runReads = 0;
  let packetReads = 0;
  const control = await mountControl(async (input) => {
    const url = String(input);
    if (url === answerReviewPath()) return post.promise;
    if (url.endsWith("/answer-packet")) return packetReads++ === 0 ? packetResponse(validPacket()) : stalePacket.promise;
    return runReads++ === 0 ? runResponse() : staleRun.promise;
  });
  t.after(() => control.cleanup());
  control.setBinding(async () => ({
    state: "TARGET_OPEN",
    runId: RUN_ID,
    inspection: {
      outcome: "SUCCEEDED",
      replayed: false,
      inspectionVersion: 2,
      answerPacketVersion: 4,
      reinspectionRequired: false
    }
  }));

  await clickReviewButton(control, "Approve", "Portfolio URL");
  await act(async () => {
    buttonNamed(control.container, "Refresh status").click();
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.equal(control.fetchCalls.filter((call) => String(call.input) === `/api/application-runs/${RUN_ID}`).length, 2);
  assert.equal(control.fetchCalls.filter((call) => String(call.input).endsWith("/answer-packet")).length, 2);

  post.resolve(new Response("{}", { status: 401 }));
  await flushComponentWork();
  assert.equal(control.container.querySelector("article"), null);
  assert.doesNotMatch(control.container.textContent ?? "", /Approve/);
  assert.match(control.container.textContent ?? "", /session is no longer authenticated/i);

  staleRun.resolve(runResponse());
  stalePacket.resolve(packetResponse(validPacket()));
  await flushComponentWork();
  const staleReadRestoredAuthority = control.container.querySelector("article");
  const staleReadRestoredActions = /Approve/.test(control.container.textContent ?? "");
  const staleReadErasedAuthenticationNotice = !/session is no longer authenticated/i.test(control.container.textContent ?? "");
  await control.cleanup();
  assert.equal(staleReadRestoredAuthority, null);
  assert.equal(staleReadRestoredActions, false);
  assert.equal(staleReadErasedAuthenticationNotice, false);
});

test("Task 2 mounted uncertain mutation failure fences an older paired read until an explicitly new refresh commits", async (t) => {
  const staleRun = deferred<Response>();
  const stalePacket = deferred<Response>();
  const post = deferred<Response>();
  let runReads = 0;
  let packetReads = 0;
  const control = await mountControl(async (input) => {
    const url = String(input);
    if (url === answerReviewPath()) return post.promise;
    if (url.endsWith("/answer-packet")) return packetReads++ === 0 ? packetResponse(validPacket()) : stalePacket.promise;
    return runReads++ === 0 ? runResponse() : staleRun.promise;
  });
  t.after(() => control.cleanup());
  control.setBinding(async () => ({
    state: "TARGET_OPEN",
    runId: RUN_ID,
    inspection: {
      outcome: "SUCCEEDED",
      replayed: false,
      inspectionVersion: 2,
      answerPacketVersion: 4,
      reinspectionRequired: false
    }
  }));

  await clickReviewButton(control, "Approve", "Portfolio URL");
  await act(async () => {
    buttonNamed(control.container, "Refresh status").click();
    await Promise.resolve();
    await Promise.resolve();
  });
  post.resolve(new Response("{}", { status: 500 }));
  await flushComponentWork();
  assert.match(control.container.textContent ?? "", /Portfolio URL/);
  assert.equal(reviewButton(control.container, "Approve", "Portfolio URL").disabled, true);

  staleRun.resolve(runResponse());
  stalePacket.resolve(packetResponse(validPacket()));
  await flushComponentWork();
  const staleReadRestoredTrustedAction = reviewButton(control.container, "Approve", "Portfolio URL").disabled;
  assert.equal(staleReadRestoredTrustedAction, true);

  control.setFetchHandler(async (input) => String(input).endsWith("/answer-packet") ? packetResponse(validPacket()) : runResponse());
  await clickButton(control, "Refresh review data");
  assert.equal(reviewButton(control.container, "Approve", "Portfolio URL").disabled, false);
});

test("successful INSPECT_FORM settlement after unmount is inert", async (t) => {
  const control = await mountControl();
  t.after(() => control.cleanup());
  const inspection = deferred<B1Status>();
  const calls: B1Command["type"][] = [];
  control.setBinding(async (command) => {
    calls.push(command.type);
    if (command.type === "GET_STATUS") return { state: "TARGET_OPEN", runId: RUN_ID };
    if (command.type === "INSPECT_FORM") return inspection.promise;
    throw new Error("unexpected command");
  });

  await clickButton(control, "Refresh status");
  await clickButton(control, "Inspect form");
  const fetchCountBeforeUnmount = control.fetchCalls.length;
  await control.unmount();

  inspection.resolve({
    state: "TARGET_OPEN",
    runId: RUN_ID,
    inspection: {
      outcome: "SUCCEEDED",
      replayed: false,
      inspectionVersion: 2,
      answerPacketVersion: 3,
      reinspectionRequired: false
    }
  });
  await flushComponentWork();

  assert.equal(control.fetchCalls.length, fetchCountBeforeUnmount);
  assert.deepEqual(calls, ["GET_STATUS", "INSPECT_FORM"]);
});

test("rejected INSPECT_FORM settlement after unmount starts no recovery", async (t) => {
  const control = await mountControl();
  t.after(() => control.cleanup());
  const inspection = deferred<B1Status>();
  const calls: B1Command["type"][] = [];
  control.setBinding(async (command) => {
    calls.push(command.type);
    if (command.type === "GET_STATUS") return { state: "TARGET_OPEN", runId: RUN_ID };
    if (command.type === "INSPECT_FORM") return inspection.promise;
    throw new Error("unexpected command");
  });

  await clickButton(control, "Refresh status");
  await clickButton(control, "Inspect form");
  const fetchCountBeforeUnmount = control.fetchCalls.length;
  await control.unmount();

  inspection.reject(new Error("private late rejection"));
  await flushComponentWork();

  assert.equal(control.fetchCalls.length, fetchCountBeforeUnmount);
  assert.deepEqual(calls, ["GET_STATUS", "INSPECT_FORM"]);
});

test("recovery status settlement after unmount is inert", async (t) => {
  const control = await mountControl();
  t.after(() => control.cleanup());
  const inspection = deferred<B1Status>();
  const recovery = deferred<B1Status>();
  const calls: B1Command["type"][] = [];
  let statusCalls = 0;
  control.setBinding(async (command) => {
    calls.push(command.type);
    if (command.type === "GET_STATUS") {
      statusCalls += 1;
      return statusCalls === 1 ? { state: "TARGET_OPEN", runId: RUN_ID } : recovery.promise;
    }
    if (command.type === "INSPECT_FORM") return inspection.promise;
    throw new Error("unexpected command");
  });

  await clickButton(control, "Refresh status");
  await clickButton(control, "Inspect form");
  inspection.reject(new Error("private command rejection"));
  await flushComponentWork();
  assert.deepEqual(calls, ["GET_STATUS", "INSPECT_FORM", "GET_STATUS"]);

  const fetchCountBeforeUnmount = control.fetchCalls.length;
  await control.unmount();
  recovery.resolve({
    state: "TARGET_OPEN",
    runId: RUN_ID,
    inspection: {
      outcome: "SUCCEEDED",
      replayed: false,
      inspectionVersion: 2,
      answerPacketVersion: 3,
      reinspectionRequired: false
    }
  });
  await flushComponentWork();

  assert.equal(control.fetchCalls.length, fetchCountBeforeUnmount);
  assert.deepEqual(calls, ["GET_STATUS", "INSPECT_FORM", "GET_STATUS"]);
});

test("control component consumes the canonical binding constant without a duplicate literal", () => {
  const source = readFileSync(
    `${process.cwd()}/components/application-browser-control.tsx`,
    "utf8"
  );
  assert.match(source, /APPLICATION_BROWSER_BINDING_NAME/);
  assert.doesNotMatch(source, /["']__applyPilotB1Command["']/);
});

test("Task 2 mounted review authority load uses paired no-store run and packet reads with one signal", async (t) => {
  const control = await mountControl();
  t.after(() => control.cleanup());

  assert.equal(control.fetchCalls.length, 2);
  assert.deepEqual(control.fetchCalls.map((call) => String(call.input)), [
    `/api/application-runs/${RUN_ID}`,
    `/api/application-runs/${RUN_ID}/answer-packet`
  ]);
  assert.equal(control.fetchCalls[0].init?.cache, "no-store");
  assert.equal(control.fetchCalls[1].init?.cache, "no-store");
  assert.equal(control.fetchCalls[0].init?.signal, control.fetchCalls[1].init?.signal);
});

test("Task 2 mounted pending proposable answer exposes enabled accessible approve and reject controls", async (t) => {
  const control = await mountControl(async (input) => {
    if (String(input).endsWith("/answer-packet")) return packetResponse(validPacket());
    return runResponse();
  });
  t.after(() => control.cleanup());

  assert.equal(reviewButton(control.container, "Approve", "Portfolio URL").disabled, false);
  assert.equal(reviewButton(control.container, "Reject", "Portfolio URL").disabled, false);
});

test("Task 2 mounted pending manual-only excluded and unsupported answers expose no review controls", async (t) => {
  const packet = validPacket();
  packet.answers.push(
    { ...packet.answers[3], id: "answer-excluded", question: "Excluded", disposition: "EXCLUDED", dispositionReason: "POLICY_EXCLUDED" },
    { ...packet.answers[3], id: "answer-unsupported", question: "Unsupported", disposition: "UNSUPPORTED", dispositionReason: "UNSUPPORTED_CONTROL" }
  );
  const control = await mountControl(async (input) => String(input).endsWith("/answer-packet") ? packetResponse(packet) : runResponse());
  t.after(() => control.cleanup());

  for (const question of ["Résumé", "Excluded", "Unsupported"]) {
    assert.equal(control.container.querySelector(`[aria-label="Approve proposed answer for ${question}"]`), null);
    assert.equal(control.container.querySelector(`[aria-label="Reject proposed answer for ${question}"]`), null);
  }
});

test("Task 2 mounted approved and rejected proposable answers expose no review controls", async (t) => {
  const control = await mountControl(async (input) => String(input).endsWith("/answer-packet") ? packetResponse(validPacket()) : runResponse());
  t.after(() => control.cleanup());

  for (const question of ["Available immediately?", "Preferred office"]) {
    assert.equal(control.container.querySelector(`[aria-label="Approve proposed answer for ${question}"]`), null);
    assert.equal(control.container.querySelector(`[aria-label="Reject proposed answer for ${question}"]`), null);
  }
});

test("Task 2 mounted approve posts only exact current answer review authority", async (t) => {
  const control = await mountControl(async (input, init) => {
    if (String(input).endsWith("/answer-packet")) return packetResponse(validPacket());
    if (String(input) === answerReviewPath()) return new Response(JSON.stringify(answerReviewResponse()), { status: 200 });
    if (init?.method === "GET") return runResponse();
    return runResponse();
  });
  t.after(() => control.cleanup());

  await clickReviewButton(control, "Approve", "Portfolio URL");
  const request = control.fetchCalls.find((call) => String(call.input) === answerReviewPath());
  assert.ok(request);
  assert.equal(request.init?.method, "POST");
  assert.equal(request.init?.cache, "no-store");
  assert.deepEqual(JSON.parse(String(request.init?.body)), { status: "APPROVED", answerPacketVersion: 3 });
  assert.equal(JSON.stringify(request).includes("https://example.com"), false);
});

test("Task 2 mounted reject posts only exact current answer review authority", async (t) => {
  const control = await mountControl(async (input, init) => {
    if (String(input).endsWith("/answer-packet")) return packetResponse(validPacket());
    if (String(input) === answerReviewPath()) return new Response(JSON.stringify(answerReviewResponse({ status: "REJECTED" })), { status: 200 });
    if (init?.method === "GET") return runResponse();
    return runResponse();
  });
  t.after(() => control.cleanup());

  await clickReviewButton(control, "Reject", "Portfolio URL");
  const request = control.fetchCalls.find((call) => String(call.input) === answerReviewPath());
  assert.ok(request);
  assert.deepEqual(JSON.parse(String(request.init?.body)), { status: "REJECTED", answerPacketVersion: 3 });
  assert.equal(JSON.stringify(request).includes("https://example.com"), false);
});

test("Task 2 mounted duplicate answer clicks create exactly one post", async (t) => {
  const post = deferred<Response>();
  const control = await mountControl(async (input) => {
    if (String(input).endsWith("/answer-packet")) return packetResponse(validPacket());
    if (String(input) === answerReviewPath()) return post.promise;
    return runResponse();
  });
  t.after(() => control.cleanup());

  await clickReviewButton(control, "Approve", "Portfolio URL");
  await clickReviewButton(control, "Approve", "Portfolio URL");
  assert.equal(control.fetchCalls.filter((call) => String(call.input) === answerReviewPath()).length, 1);
});

test("Task 2 mounted pending answer mutation disables all review actions and refresh", async (t) => {
  const post = deferred<Response>();
  const control = await mountControl(async (input) => {
    if (String(input).endsWith("/answer-packet")) return packetResponse(validPacket());
    if (String(input) === answerReviewPath()) return post.promise;
    return runResponse();
  });
  t.after(() => control.cleanup());

  await clickReviewButton(control, "Approve", "Portfolio URL");
  assert.equal(buttonNamed(control.container, "Approving…").disabled, true);
  assert.equal(reviewButton(control.container, "Reject", "Portfolio URL").disabled, true);
  assert.equal(buttonNamed(control.container, "Refresh review data").disabled, true);
});

test("Task 2 mounted confirmed approve replaces display only from paired refreshed authority", async (t) => {
  const approved = validPacket();
  approved.answers[0] = { ...approved.answers[0], status: "APPROVED", reviewedByUser: true, reviewedAt: "2026-08-30T00:00:00.000Z" };
  let packetReads = 0;
  const control = await mountControl(async (input) => {
    const url = String(input);
    if (url.endsWith("/answer-packet")) return packetResponse(packetReads++ === 0 ? validPacket() : approved);
    if (url === answerReviewPath()) return new Response(JSON.stringify(answerReviewResponse()), { status: 200 });
    return runResponse();
  });
  t.after(() => control.cleanup());
  await clickReviewButton(control, "Approve", "Portfolio URL");
  assert.match(control.container.textContent ?? "", /Answer approved/);
  assert.equal(control.fetchCalls.filter((call) => String(call.input).endsWith("/answer-packet")).length, 2);
  assert.equal(control.fetchCalls.filter((call) => String(call.input) === `/api/application-runs/${RUN_ID}`).length, 2);
  assert.equal(control.container.querySelector('[aria-label="Approve proposed answer for Portfolio URL"]'), null);
});

test("Task 2 mounted confirmed reject replaces display only from paired refreshed authority", async (t) => {
  const rejected = validPacket();
  rejected.answers[0] = { ...rejected.answers[0], status: "REJECTED", reviewedByUser: true, reviewedAt: "2026-08-30T00:00:00.000Z" };
  let packetReads = 0;
  const control = await mountControl(async (input) => {
    const url = String(input);
    if (url.endsWith("/answer-packet")) return packetResponse(packetReads++ === 0 ? validPacket() : rejected);
    if (url === answerReviewPath()) return new Response(JSON.stringify(answerReviewResponse({ status: "REJECTED" })), { status: 200 });
    return runResponse();
  });
  t.after(() => control.cleanup());
  await clickReviewButton(control, "Reject", "Portfolio URL");
  assert.match(control.container.textContent ?? "", /Answer rejected/);
  assert.equal(control.container.querySelector('[aria-label="Reject proposed answer for Portfolio URL"]'), null);
});

test("Task 2 mounted approve and reject remain pending until their deferred paired authority refresh confirms", async () => {
  for (const status of ["APPROVED", "REJECTED"] as const) {
    const runRead = deferred<Response>();
    const packetRead = deferred<Response>();
    const confirmed = validPacket();
    confirmed.answers[0] = {
      ...confirmed.answers[0],
      status,
      reviewedByUser: true,
      reviewedAt: "2026-08-30T00:00:00.000Z"
    };
    let packetReads = 0;
    let runReads = 0;
    const control = await mountControl(async (input) => {
      const url = String(input);
      if (url === answerReviewPath()) return new Response(JSON.stringify(answerReviewResponse({ status })), { status: 200 });
      if (url.endsWith("/answer-packet")) return packetReads++ === 0 ? packetResponse(validPacket()) : packetRead.promise;
      return runReads++ === 0 ? runResponse() : runRead.promise;
    });
    try {
      await startReviewButton(control, status === "APPROVED" ? "Approve" : "Reject", "Portfolio URL");
      assert.match(control.container.textContent ?? "", /Portfolio URL[\s\S]*PENDING/);
      assert.equal(buttonNamed(control.container, "Refreshing…").disabled, true);
      assert.doesNotMatch(control.container.textContent ?? "", /Answer (approved|rejected)\./);
      runRead.resolve(runResponse());
      packetRead.resolve(packetResponse(confirmed));
      await flushComponentWork();
      assert.match(control.container.textContent ?? "", status === "APPROVED" ? /Answer approved\./ : /Answer rejected\./);
    } finally {
      await control.cleanup();
    }
  }
});

test("Task 2 mounted changed committed packet remains trusted and warns instead of claiming stale success", async (t) => {
  const changed = validPacket();
  changed.answerPacketVersion = 4;
  let packetReads = 0;
  const control = await mountControl(async (input) => {
    const url = String(input);
    if (url.endsWith("/answer-packet")) return packetResponse(packetReads++ === 0 ? validPacket() : changed);
    if (url === answerReviewPath()) return new Response(JSON.stringify(answerReviewResponse()), { status: 200 });
    return runResponse();
  });
  t.after(() => control.cleanup());
  await clickReviewButton(control, "Approve", "Portfolio URL");
  assert.match(control.container.textContent ?? "", /Review data changed after the action\. Review the current packet before continuing\./);
  assert.doesNotMatch(control.container.textContent ?? "", /Answer approved/);
  assert.equal(reviewButton(control.container, "Approve", "Portfolio URL").disabled, false);
});

test("Task 2 mounted same-version missing or mismatched postconditions warn without stale success", async () => {
  const confirmed = validPacket();
  confirmed.answers[0] = {
    ...confirmed.answers[0],
    status: "APPROVED",
    reviewedByUser: true,
    reviewedAt: "2026-08-30T00:00:00.000Z"
  };
  const mutations: Array<(packet: AnswerPacket) => AnswerPacket> = [
    (packet: AnswerPacket) => ({ ...packet, answers: packet.answers.slice(1) }),
    (packet: AnswerPacket) => ({ ...packet, answers: [{ ...packet.answers[0], status: "REJECTED" as const }, ...packet.answers.slice(1)] }),
    (packet: AnswerPacket) => ({ ...packet, answers: [{ ...packet.answers[0], reviewedByUser: false }, ...packet.answers.slice(1)] }),
    (packet: AnswerPacket) => ({ ...packet, answers: [{ ...packet.answers[0], reviewedAt: null }, ...packet.answers.slice(1)] })
  ];
  for (const mutate of mutations) {
    let packetReads = 0;
    const control = await mountControl(async (input) => {
      const url = String(input);
      if (url.endsWith("/answer-packet")) return packetResponse(packetReads++ === 0 ? validPacket() : mutate(confirmed));
      if (url === answerReviewPath()) return new Response(JSON.stringify(answerReviewResponse()), { status: 200 });
      return runResponse();
    });
    try {
      await clickReviewButton(control, "Approve", "Portfolio URL");
      assert.match(control.container.textContent ?? "", /Review data changed after the action\. Review the current packet before continuing\./);
      assert.doesNotMatch(control.container.textContent ?? "", /Answer approved/);
    } finally {
      await control.cleanup();
    }
  }
});

test("Task 2 mounted valid post plus failed authority refresh stays inert and releases its lock", async (t) => {
  let packetReads = 0;
  const control = await mountControl(async (input) => {
    const url = String(input);
    if (url.endsWith("/answer-packet")) return packetReads++ === 0 ? packetResponse(validPacket()) : new Response("{}", { status: 503 });
    if (url === answerReviewPath()) return new Response(JSON.stringify(answerReviewResponse()), { status: 200 });
    return runResponse();
  });
  t.after(() => control.cleanup());
  await clickReviewButton(control, "Approve", "Portfolio URL");
  assert.match(control.container.textContent ?? "", /temporarily unavailable/i);
  assert.equal(reviewButton(control.container, "Approve", "Portfolio URL").disabled, true);
  control.setFetchHandler(async (input) => {
    if (String(input).endsWith("/answer-packet")) return packetResponse(validPacket());
    if (String(input) === answerReviewPath()) return new Response(JSON.stringify(answerReviewResponse()), { status: 200 });
    return runResponse();
  });
  await clickButton(control, "Refresh review data");
  await clickReviewButton(control, "Approve", "Portfolio URL");
  assert.equal(control.fetchCalls.filter((call) => String(call.input) === answerReviewPath()).length, 2);
});

test("Task 2 mounted superseded mutation refresh publishes no stale success and releases old lock", async (t) => {
  const oldRun = deferred<Response>();
  const oldPacket = deferred<Response>();
  const next = validPacket();
  next.answerPacketVersion = 4;
  next.answers[0] = { ...next.answers[0], id: "answer-b", question: "Replacement answer" };
  let packetReads = 0;
  let runReads = 0;
  const control = await mountControl(async (input) => {
    const url = String(input);
    if (url.endsWith("/answer-packet")) return packetReads++ === 0 ? packetResponse(validPacket()) : packetReads === 2 ? oldPacket.promise : packetResponse(next);
    if (url === answerReviewPath()) return new Response(JSON.stringify(answerReviewResponse()), { status: 200 });
    if (url === answerReviewPath("answer-b")) return new Response(JSON.stringify(answerReviewResponse({ id: "answer-b" })), { status: 200 });
    return runReads++ === 0 ? runResponse() : runReads === 2 ? oldRun.promise : runResponse(validRunAuthority({ stateVersion: 8 }));
  });
  t.after(() => control.cleanup());
  control.setBinding(async (command) => command.type === "GET_STATUS"
    ? { state: "TARGET_OPEN", runId: RUN_ID }
    : {
        state: "TARGET_OPEN",
        runId: RUN_ID,
        inspection: { outcome: "SUCCEEDED", replayed: false, inspectionVersion: 2, answerPacketVersion: 4, reinspectionRequired: false }
      });
  await startReviewButton(control, "Approve", "Portfolio URL");
  await clickButton(control, "Refresh status");
  await clickButton(control, "Inspect form");
  oldRun.resolve(runResponse());
  oldPacket.resolve(packetResponse(validPacket()));
  await flushComponentWork();
  assert.doesNotMatch(control.container.textContent ?? "", /Answer approved/);
  await clickReviewButton(control, "Approve", "Replacement answer");
  assert.equal(control.fetchCalls.filter((call) => String(call.input) === answerReviewPath("answer-b")).length, 1);
});

test("Task 2 mounted unmount invalidates active answer mutation and permits no late effects", async (t) => {
  const post = deferred<Response>();
  let postSignal: AbortSignal | undefined;
  const control = await mountControl(async (input) => {
    if (String(input).endsWith("/answer-packet")) return packetResponse(validPacket());
    if (String(input) === answerReviewPath()) return post.promise;
    return runResponse();
  });
  t.after(() => control.cleanup());
  control.setFetchHandler(async (input, init) => {
    if (String(input).endsWith("/answer-packet")) return packetResponse(validPacket());
    if (String(input) === answerReviewPath()) {
      postSignal = init?.signal ?? undefined;
      return post.promise;
    }
    return runResponse();
  });
  await clickReviewButton(control, "Approve", "Portfolio URL");
  const count = control.fetchCalls.length;
  await control.unmount();
  assert.equal(postSignal?.aborted, true);
  post.resolve(new Response(JSON.stringify(answerReviewResponse()), { status: 200 }));
  await flushComponentWork();
  assert.equal(control.fetchCalls.length, count);
});

test("Task 2 mounted global pending lock prevents a second review mutation", async (t) => {
  const post = deferred<Response>();
  const control = await mountControl(async (input) => {
    if (String(input).endsWith("/answer-packet")) return packetResponse(validPacket());
    if (String(input) === answerReviewPath()) return post.promise;
    return runResponse();
  });
  t.after(() => control.cleanup());
  await clickReviewButton(control, "Approve", "Portfolio URL");
  await clickReviewButton(control, "Reject", "Portfolio URL");
  assert.equal(control.fetchCalls.filter((call) => String(call.input) === answerReviewPath()).length, 1);
});

test("Task 2 mounted confirmed answer flow releases lock for newly current eligible actions", async (t) => {
  const approved = validPacket();
  approved.answers[0] = { ...approved.answers[0], status: "APPROVED", reviewedByUser: true, reviewedAt: "2026-08-30T00:00:00.000Z" };
  approved.answers.push({ ...validPacket().answers[0], id: "answer-next", question: "Next URL" });
  let packetReads = 0;
  const control = await mountControl(async (input) => {
    const url = String(input);
    if (url.endsWith("/answer-packet")) return packetResponse(packetReads++ === 0 ? validPacket() : approved);
    if (url === answerReviewPath() || url === answerReviewPath("answer-next")) return new Response(JSON.stringify(answerReviewResponse({ id: url.endsWith("answer-next/review") ? "answer-next" : "answer-scalar" })), { status: 200 });
    return runResponse();
  });
  t.after(() => control.cleanup());
  await clickReviewButton(control, "Approve", "Portfolio URL");
  await clickReviewButton(control, "Approve", "Next URL");
  assert.equal(control.fetchCalls.filter((call) => String(call.input) === answerReviewPath("answer-next")).length, 1);
});

test("Task 2 mounted post failure releases lock while separately unverified authority remains inert", async (t) => {
  const control = await mountControl(async (input) => {
    if (String(input).endsWith("/answer-packet")) return packetResponse(validPacket());
    if (String(input) === answerReviewPath()) return new Response("{}", { status: 500 });
    return runResponse();
  });
  t.after(() => control.cleanup());
  await clickReviewButton(control, "Approve", "Portfolio URL");
  assert.equal(reviewButton(control.container, "Approve", "Portfolio URL").disabled, true);
  control.setFetchHandler(async (input) => {
    if (String(input).endsWith("/answer-packet")) return packetResponse(validPacket());
    if (String(input) === answerReviewPath()) return new Response("{}", { status: 500 });
    return runResponse();
  });
  await clickButton(control, "Refresh review data");
  await clickReviewButton(control, "Approve", "Portfolio URL");
  assert.equal(control.fetchCalls.filter((call) => String(call.input) === answerReviewPath()).length, 2);
});

test("Task 2 mounted 409 holds lock through one recovery refresh", async (t) => {
  const recovery = deferred<Response>();
  let packetReads = 0;
  const control = await mountControl(async (input) => {
    const url = String(input);
    if (url.endsWith("/answer-packet")) return packetReads++ === 0 ? packetResponse(validPacket()) : recovery.promise;
    if (url === answerReviewPath()) return new Response("{}", { status: 409 });
    return runResponse();
  });
  t.after(() => control.cleanup());
  await clickReviewButton(control, "Approve", "Portfolio URL");
  await clickReviewButton(control, "Reject", "Portfolio URL");
  assert.equal(control.fetchCalls.filter((call) => String(call.input) === answerReviewPath()).length, 1);
  assert.equal(control.fetchCalls.filter((call) => String(call.input) === `/api/application-runs/${RUN_ID}`).length, 2);
  assert.equal(control.fetchCalls.filter((call) => String(call.input).endsWith("/answer-packet")).length, 2);
  recovery.resolve(packetResponse(validPacket()));
  await flushComponentWork();
  await clickReviewButton(control, "Approve", "Portfolio URL");
  assert.equal(control.fetchCalls.filter((call) => String(call.input) === answerReviewPath()).length, 2);
});

test("Task 2 mounted loading replacement makes visible old action inert and only new answer dispatches", async (t) => {
  const replacement = deferred<Response>();
  const next = validPacket();
  next.answerPacketVersion = 4;
  next.answers[0] = { ...next.answers[0], id: "answer-new", question: "New Portfolio URL" };
  let packetReads = 0;
  const control = await mountControl(async (input) => {
    const url = String(input);
    if (url.endsWith("/answer-packet")) return packetReads++ === 0 ? packetResponse(validPacket()) : replacement.promise;
    if (url.includes("/review")) return new Response(JSON.stringify(answerReviewResponse({ id: "answer-new" })), { status: 200 });
    return runResponse();
  });
  t.after(() => control.cleanup());
  await clickButton(control, "Refresh review data");
  assert.equal(reviewButton(control.container, "Approve", "Portfolio URL").disabled, true);
  await clickReviewButton(control, "Approve", "Portfolio URL");
  assert.equal(control.fetchCalls.filter((call) => String(call.input).includes("/review")).length, 0);
  replacement.resolve(packetResponse(next));
  await flushComponentWork();
  await clickReviewButton(control, "Approve", "New Portfolio URL");
  const request = control.fetchCalls.find((call) => String(call.input).includes("/review"));
  assert.ok(request);
  assert.match(String(request.input), /answer-new/);
  assert.deepEqual(JSON.parse(String(request.init?.body)), { status: "APPROVED", answerPacketVersion: 4 });
});

test("Task 2 mounted current answer object guard rejects a still-connected stale action", async (t) => {
  const replacementRun = deferred<Response>();
  const replacementPacket = deferred<Response>();
  let consumedBodies = 0;
  const jsonResponse = (value: unknown): Response => ({
    ok: true,
    status: 200,
    json: async () => {
      consumedBodies += 1;
      return value;
    }
  } as unknown as Response);
  const next = validPacket();
  next.answerPacketVersion = 4;
  next.answers[0] = { ...next.answers[0], id: "answer-b", question: "Answer B" };
  let packetReads = 0;
  let runReads = 0;
  const control = await mountControl(async (input) => {
    if (String(input).endsWith("/answer-packet")) return packetReads++ === 0 ? packetResponse(validPacket()) : replacementPacket.promise;
    if (String(input).includes("/review")) return new Response(JSON.stringify(answerReviewResponse()), { status: 200 });
    return runReads++ === 0 ? runResponse() : replacementRun.promise;
  });
  t.after(() => control.cleanup());
  const oldButton = reviewButton(control.container, "Approve", "Portfolio URL");
  await clickButton(control, "Refresh review data");
  await act(async () => {
    replacementRun.resolve(jsonResponse({ run: validRunAuthority({ stateVersion: 8 }) }));
    replacementPacket.resolve(jsonResponse({ runId: RUN_ID, current: next }));
    while (consumedBodies !== 2) await Promise.resolve();
    const trustedRef = await waitForTrustedReviewLoadRef(oldButton);
    assert.equal(trustedRef.phase, "loaded");
    assert.equal(trustedRef.unverified, false);
    assert.equal(trustedRef.packet?.answers[0]?.id, "answer-b");
    assert.equal(control.container.contains(oldButton), true);
    oldButton.disabled = false;
    oldButton.click();
    assert.equal(control.fetchCalls.filter((call) => String(call.input).includes("/review")).length, 0);
  });
  await flushComponentWork();
  assert.match(control.container.textContent ?? "", /Answer B/);
});

test("Task 2 mounted 401 403 and 404 clear review authority fail closed", async () => {
  for (const [status, expected] of [
    [401, /session is no longer authenticated/i],
    [403, /not authorized/i],
    [404, /unavailable/i]
  ] as const) {
    const control = await mountControl(async (input) => String(input).endsWith("/answer-packet") ? packetResponse(validPacket()) : runResponse());
    try {
      control.setFetchHandler(async () => new Response("{}", { status }));
      await clickButton(control, "Refresh review data");
      assert.equal(control.container.querySelector("article"), null);
      assert.doesNotMatch(control.container.textContent ?? "", /Approve/);
      assert.match(control.container.textContent ?? "", expected);
    } finally {
      await control.cleanup();
    }
  }
});

test("Task 2 paired read gives packet authentication failure precedence over a transient run failure", async (t) => {
  const control = await mountControl(async (input) => String(input).endsWith("/answer-packet") ? packetResponse(validPacket()) : runResponse());
  t.after(() => control.cleanup());
  control.setFetchHandler(async (input) => {
    if (String(input).endsWith("/answer-packet")) return new Response("{}", { status: 401 });
    return new Response("{}", { status: 503 });
  });

  await clickButton(control, "Refresh review data");
  assert.equal(control.container.querySelector("article"), null);
  assert.match(control.container.textContent ?? "", /session is no longer authenticated/i);
});

test("Task 2 paired authority reads clear on fulfilled auth or not-found even when the sibling rejects", async () => {
  const cases = [
    ["run", 401, /session is no longer authenticated/i],
    ["packet", 401, /session is no longer authenticated/i],
    ["run", 403, /not authorized/i],
    ["packet", 403, /not authorized/i],
    ["run", 404, /unavailable/i],
    ["packet", 404, /unavailable/i]
  ] as const;
  for (const [authorizedEndpoint, status, notice] of cases) {
    const control = await mountControl(async (input) => String(input).endsWith("/answer-packet") ? packetResponse(validPacket()) : runResponse());
    try {
      control.setFetchHandler(async (input) => {
        const isPacket = String(input).endsWith("/answer-packet");
        if ((authorizedEndpoint === "packet") === isPacket) return new Response("{}", { status });
        throw new Error("network sibling rejected");
      });
      await clickButton(control, "Refresh review data");
      assert.equal(control.container.querySelector("article"), null, `${authorizedEndpoint}/${status}`);
      assert.match(control.container.textContent ?? "", notice, `${authorizedEndpoint}/${status}`);
    } finally {
      await control.cleanup();
    }
  }
});

test("Task 2 409 conflict keeps its bounded warning after committed paired recovery", async (t) => {
  let packetReads = 0;
  const control = await mountControl(async (input) => {
    const url = String(input);
    if (url.endsWith("/answer-packet")) return packetResponse(packetReads++ === 0 ? validPacket() : validPacket());
    if (url === answerReviewPath()) return new Response("{}", { status: 409 });
    return runResponse();
  });
  t.after(() => control.cleanup());

  await clickReviewButton(control, "Approve", "Portfolio URL");
  assert.match(control.container.textContent ?? "", /Review authority changed\. Refreshing current review data\./);
  assert.doesNotMatch(control.container.textContent ?? "", /Answer approved/);
});

test("Task 2 mounted 429 500 503 and network failures preserve context but fail closed", async () => {
  for (const failure of [
    async () => new Response("{}", { status: 429 }),
    async () => new Response("{}", { status: 500 }),
    async () => new Response("{}", { status: 503 }),
    async () => { throw new Error("network"); }
  ]) {
    const control = await mountControl(async (input) => String(input).endsWith("/answer-packet") ? packetResponse(validPacket()) : runResponse());
    try {
      control.setFetchHandler(failure);
      await clickButton(control, "Refresh review data");
      assert.match(control.container.textContent ?? "", /Portfolio URL/);
      assert.equal(reviewButton(control.container, "Approve", "Portfolio URL").disabled, true);
    } finally {
      await control.cleanup();
    }
  }
});

test("Task 2 mounted invalid json and invalid 2xx review responses fail closed", async () => {
  const invalids: Array<(input: RequestInfo | URL) => Promise<Response>> = [
    async (input) => String(input) === answerReviewPath()
      ? { ok: true, status: 200, json: async () => { throw new Error("json"); } } as unknown as Response
      : String(input).endsWith("/answer-packet") ? packetResponse(validPacket()) : runResponse(),
    async (input) => String(input) === answerReviewPath()
      ? new Response(JSON.stringify(answerReviewResponse({ runId: OTHER_RUN_ID })), { status: 200 })
      : String(input).endsWith("/answer-packet") ? packetResponse(validPacket()) : runResponse(),
    async (input) => String(input) === answerReviewPath()
      ? new Response(JSON.stringify(answerReviewResponse({ id: "wrong-answer" })), { status: 200 })
      : String(input).endsWith("/answer-packet") ? packetResponse(validPacket()) : runResponse(),
    async (input) => String(input) === answerReviewPath()
      ? new Response(JSON.stringify(answerReviewResponse({ status: "REJECTED" })), { status: 200 })
      : String(input).endsWith("/answer-packet") ? packetResponse(validPacket()) : runResponse(),
    async (input) => String(input) === answerReviewPath()
      ? new Response(JSON.stringify({ answer: { bad: true } }), { status: 200 })
      : String(input).endsWith("/answer-packet") ? packetResponse(validPacket()) : runResponse()
  ];
  for (const handler of invalids) {
    const control = await mountControl(handler);
    try {
      await clickReviewButton(control, "Approve", "Portfolio URL");
      assert.doesNotMatch(control.container.textContent ?? "", /Answer approved/);
      assert.equal(reviewButton(control.container, "Approve", "Portfolio URL").disabled, true);
    } finally {
      await control.cleanup();
    }
  }
});

test("Task 2 mounted approve and reject never call or serialize review authority through the binding", async () => {
  for (const [action, status] of [["Approve", "APPROVED"], ["Reject", "REJECTED"]] as const) {
    const bindingCalls: B1Command[] = [];
    const confirmed = validPacket();
    confirmed.answers[0] = { ...confirmed.answers[0], status, reviewedByUser: true, reviewedAt: "2026-08-30T00:00:00.000Z" };
    let packetReads = 0;
    const control = await mountControl(async (input) => {
      if (String(input).endsWith("/answer-packet")) return packetResponse(packetReads++ === 0 ? validPacket() : confirmed);
      if (String(input).includes("/review")) return new Response(JSON.stringify(answerReviewResponse({ status })), { status: 200 });
      return runResponse();
    });
    try {
      control.setBinding(async (command) => { bindingCalls.push(command); return { state: "TARGET_OPEN", runId: RUN_ID }; });
      await clickReviewButton(control, action, "Portfolio URL");
      assert.match(control.container.textContent ?? "", status === "APPROVED" ? /Answer approved\./ : /Answer rejected\./);
      const serialized = JSON.stringify(bindingCalls);
      assert.deepEqual(bindingCalls, []);
      for (const privateValue of ["answer-scalar", "https://example.com", "a".repeat(64), "APPROVED", "REJECTED", answerReviewPath()]) {
        assert.equal(serialized.includes(privateValue), false);
      }
    } finally {
      await control.cleanup();
    }
  }
});

test("Task 2 mounted valid and rejected mutation settlements after unmount have no follow-on effects", async () => {
  for (const settle of [
    (post: Deferred<Response>) => post.resolve(new Response(JSON.stringify(answerReviewResponse()), { status: 200 })),
    (post: Deferred<Response>) => post.reject(new Error("network"))
  ]) {
    const post = deferred<Response>();
    const bindingCalls: B1Command[] = [];
    const control = await mountControl(async (input) => {
      if (String(input).endsWith("/answer-packet")) return packetResponse(validPacket());
      if (String(input) === answerReviewPath()) return post.promise;
      return runResponse();
    });
    try {
      control.setBinding(async (command) => { bindingCalls.push(command); return { state: "TARGET_OPEN", runId: RUN_ID }; });
      await clickReviewButton(control, "Approve", "Portfolio URL");
      const before = control.fetchCalls.length;
      await control.unmount();
      settle(post);
      await flushComponentWork();
      assert.equal(control.fetchCalls.length, before);
      assert.deepEqual(bindingCalls, []);
    } finally {
      await control.cleanup();
    }
  }
});

function readyReviewPacket(overrides: Partial<AnswerPacket> = {}): AnswerPacket {
  const packet = validPacket();
  return {
    ...packet,
    reviewedAt: null,
    summary: { ...packet.summary, readyForRunResolution: true },
    ...overrides
  };
}

test("Task 3 mounted Resolve review remains visible but enables only current trusted unreviewed REVIEW_REQUIRED authority", async () => {
  const cases: Array<[string, ReturnType<typeof validRunAuthority>, AnswerPacket, boolean]> = [
    ["not ready", validRunAuthority(), validPacket(), false],
    ["not review required", validRunAuthority({ state: "READY" }), readyReviewPacket(), false],
    ["already reviewed", validRunAuthority(), readyReviewPacket({ reviewedAt: "2026-08-30T00:00:00.000Z" }), false],
    ["complete", validRunAuthority(), readyReviewPacket(), true]
  ];
  for (const [name, run, packet, enabled] of cases) {
    const control = await mountControl(async (input) => String(input).endsWith("/answer-packet") ? packetResponse(packet) : runResponse(run));
    try {
      const button = resolveReviewButton(control.container);
      assert.equal(button.disabled, !enabled, name);
      if (enabled) {
        assert.equal(button.type, "button");
        assert.equal(button.getAttribute("aria-describedby"), "review-readiness review-reasons");
        assert.ok(control.container.querySelector("#review-readiness"));
        assert.ok(control.container.querySelector("#review-reasons"));
      }
    } finally {
      await control.cleanup();
    }
  }
});

test("Task 3 mounted resolve reason presentation preserves server order and exact labels including empty copy", async () => {
  const ordered = [...PLAN_REVIEW_REASONS];
  const control = await mountControl(async (input) => String(input).endsWith("/answer-packet") ? packetResponse(readyReviewPacket()) : runResponse(validRunAuthority({ reviewReasons: ordered })));
  try {
    const text = control.container.textContent ?? "";
    let prior = -1;
    for (const reason of ordered) {
      const position = text.indexOf(REVIEW_REASON_LABELS[reason]);
      assert.ok(position > prior, reason);
      prior = position;
    }
    assert.match(text, /Run state/);
    assert.match(text, /State version/);
  } finally {
    await control.cleanup();
  }

  const empty = await mountControl(async (input) => String(input).endsWith("/answer-packet") ? packetResponse(readyReviewPacket()) : runResponse(validRunAuthority({ reviewReasons: [] })));
  try {
    assert.match(empty.container.textContent ?? "", /No planner review reasons require acknowledgment\./);
  } finally {
    await empty.cleanup();
  }
});

test("Task 3 mounted resolve posts only exact current run and packet authority and shares the global lock", async (t) => {
  const post = deferred<Response>();
  const packet = readyReviewPacket();
  const control = await mountControl(async (input) => {
    const url = String(input);
    if (url === resolveReviewPath()) return post.promise;
    if (url.endsWith("/answer-packet")) return packetResponse(packet);
    return runResponse();
  });
  t.after(() => control.cleanup());

  await clickResolveReview(control);
  assert.equal(buttonNamed(control.container, "Resolving…").disabled, true);
  assert.equal(reviewButton(control.container, "Approve", "Portfolio URL").disabled, true);
  assert.equal(reviewButton(control.container, "Reject", "Portfolio URL").disabled, true);
  assert.equal(buttonNamed(control.container, "Refresh review data").disabled, true);
  await act(async () => {
    buttonNamed(control.container, "Resolving…").click();
  });
  await clickReviewButton(control, "Approve", "Portfolio URL");
  assert.equal(control.fetchCalls.filter((call) => String(call.input) === resolveReviewPath()).length, 1);
  assert.equal(control.fetchCalls.filter((call) => String(call.input) === answerReviewPath()).length, 0);
  const request = control.fetchCalls.find((call) => String(call.input) === resolveReviewPath());
  assert.ok(request);
  assert.equal(request.init?.method, "POST");
  assert.equal(request.init?.cache, "no-store");
  assert.deepEqual(JSON.parse(String(request.init?.body)), {
    stateVersion: 7,
    acknowledgedReviewReasons: ["unknown_requirement_ids", "evidence_gaps_present"],
    answerPacketVersion: 3,
    packetHash: "a".repeat(64)
  });
  const body = String(request.init?.body);
  for (const forbidden of ["answer-scalar", "Portfolio URL", "https://example.com", "answers", APPLICATION_BROWSER_BINDING_NAME]) {
    assert.equal(body.includes(forbidden), false, forbidden);
  }
  post.resolve(new Response(JSON.stringify({ run: validRunAuthority({ state: "READY" }) }), { status: 200 }));
});

test("Task 3 mounted resolve success waits for paired refresh and only confirms READY plus reviewed matching packet", async (t) => {
  const refreshPacket = deferred<Response>();
  const refreshed = readyReviewPacket({ reviewedAt: "2026-08-30T00:00:00.000Z" });
  let packetReads = 0;
  let runReads = 0;
  const control = await mountControl(async (input) => {
    const url = String(input);
    if (url === resolveReviewPath()) return new Response(JSON.stringify({ run: validRunAuthority({ state: "READY" }) }), { status: 200 });
    if (url.endsWith("/answer-packet")) return packetReads++ === 0 ? packetResponse(readyReviewPacket()) : refreshPacket.promise;
    return runResponse(runReads++ === 0 ? validRunAuthority() : validRunAuthority({ state: "READY" }));
  });
  t.after(() => control.cleanup());

  await clickResolveReview(control);
  assert.doesNotMatch(control.container.textContent ?? "", /Review resolved\./);
  assert.match(control.container.textContent ?? "", /Run stateREVIEW_REQUIRED/);
  assert.match(control.container.textContent ?? "", /Review timeNot acknowledged/);
  assert.equal(control.fetchCalls.filter((call) => String(call.input) === `/api/application-runs/${RUN_ID}`).length, 2);
  assert.equal(control.fetchCalls.filter((call) => String(call.input).endsWith("/answer-packet")).length, 2);
  refreshPacket.resolve(packetResponse(refreshed));
  await flushComponentWork();
  assert.match(control.container.textContent ?? "", /Review resolved\./);
});

test("Task 3 mounted committed resolve mismatch renders trusted authority and exact bounded warning", async () => {
  const matchingReviewedPacket = readyReviewPacket({ reviewedAt: "2026-08-30T00:00:00.000Z" });
  const cases = [
    ["changed packet version", readyReviewPacket({ answerPacketVersion: 4, reviewedAt: "2026-08-30T00:00:00.000Z" }), "READY"],
    ["changed packet hash", readyReviewPacket({ packetHash: "b".repeat(64), reviewedAt: "2026-08-30T00:00:00.000Z" }), "READY"],
    ...(["DRAFT", "PREPARING", "FILLING", "REVIEW_REQUIRED", "READY_FOR_USER_SUBMISSION", "COMPLETED_BY_USER", "BLOCKED", "FAILED", "CANCELLED"] as const)
      .map((state) => [`non-ready ${state}`, matchingReviewedPacket, state] as const)
  ] as const;
  for (const [name, packet, state] of cases) {
    let packetReads = 0;
    let runReads = 0;
    const control = await mountControl(async (input) => {
      const url = String(input);
      if (url === resolveReviewPath()) return new Response(JSON.stringify({ run: validRunAuthority({ state: "READY" }) }), { status: 200 });
      if (url.endsWith("/answer-packet")) return packetResponse(packetReads++ === 0 ? readyReviewPacket() : packet);
      return runResponse(runReads++ === 0 ? validRunAuthority() : validRunAuthority({ state }));
    });
    try {
      await clickResolveReview(control);
      assert.match(control.container.textContent ?? "", /Review authority changed after the action\. Review the current run and packet before continuing\./);
      assert.doesNotMatch(control.container.textContent ?? "", /Review resolved\./);
      assert.equal(buttonNamed(control.container, "Refresh review data").disabled, false, name);
    } finally {
      await control.cleanup();
    }
  }
});

test("Task 3 mounted resolve failure, conflict recovery, replacement, and unmount all fail closed", async () => {
  for (const failure of [401, 403, 404, 429, 500, 503]) {
    const control = await mountControl(async (input) => {
      if (String(input) === resolveReviewPath()) return new Response("{}", { status: failure });
      return String(input).endsWith("/answer-packet") ? packetResponse(readyReviewPacket()) : runResponse();
    });
    try {
      await clickResolveReview(control);
      assert.doesNotMatch(control.container.textContent ?? "", /Review resolved\./);
      if (failure === 401 || failure === 403 || failure === 404) {
        assert.equal((control.container.textContent ?? "").includes("Resolve review"), false);
      } else {
        assert.equal(resolveReviewButton(control.container).disabled, true);
      }
    } finally {
      await control.cleanup();
    }
  }

  const recovery = deferred<Response>();
  let packetReads = 0;
  const conflict = await mountControl(async (input) => {
    const url = String(input);
    if (url === resolveReviewPath()) return new Response("{}", { status: 409 });
    if (url.endsWith("/answer-packet")) return packetReads++ === 0 ? packetResponse(readyReviewPacket()) : recovery.promise;
    return runResponse();
  });
  try {
    await clickResolveReview(conflict);
    assert.equal(buttonNamed(conflict.container, "Resolving…").disabled, true);
    await clickReviewButton(conflict, "Approve", "Portfolio URL");
    assert.equal(conflict.fetchCalls.filter((call) => String(call.input) === resolveReviewPath()).length, 1, "no duplicate resolve POST");
    assert.equal(conflict.fetchCalls.filter((call) => String(call.input) === answerReviewPath()).length, 0);
    assert.equal(conflict.fetchCalls.filter((call) => String(call.input) === `/api/application-runs/${RUN_ID}`).length, 2, "one paired recovery run GET");
    assert.equal(conflict.fetchCalls.filter((call) => String(call.input).endsWith("/answer-packet")).length, 2, "one paired recovery packet GET");
    assert.match(conflict.container.textContent ?? "", /Run stateREVIEW_REQUIRED/);
    assert.doesNotMatch(conflict.container.textContent ?? "", /Run stateREADY/);
    recovery.resolve(packetResponse(readyReviewPacket()));
    await flushComponentWork();
    assert.doesNotMatch(conflict.container.textContent ?? "", /Review resolved\./);
    assert.equal(resolveReviewButton(conflict.container).disabled, false, "lock releases after the one recovery settles");
  } finally {
    await conflict.cleanup();
  }

  const post = deferred<Response>();
  const unmounted = await mountControl(async (input) => {
    if (String(input) === resolveReviewPath()) return post.promise;
    return String(input).endsWith("/answer-packet") ? packetResponse(readyReviewPacket()) : runResponse();
  });
  try {
    await clickResolveReview(unmounted);
    const before = unmounted.fetchCalls.length;
    await unmounted.unmount();
    post.resolve(new Response(JSON.stringify({ run: validRunAuthority({ state: "READY" }) }), { status: 200 }));
    await flushComponentWork();
    assert.equal(unmounted.fetchCalls.length, before);
  } finally {
    await unmounted.cleanup();
  }
});

test("Task 3 mounted resolve never invokes or serializes review authority through the binding", async (t) => {
  const bindingCalls: B1Command[] = [];
  let packetReads = 0;
  let runReads = 0;
  const control = await mountControl(async (input) => {
    const url = String(input);
    if (url === resolveReviewPath()) return new Response(JSON.stringify({ run: validRunAuthority({ state: "READY" }) }), { status: 200 });
    if (url.endsWith("/answer-packet")) return packetResponse(packetReads++ === 0 ? readyReviewPacket() : readyReviewPacket({ reviewedAt: "2026-08-30T00:00:00.000Z" }));
    return runResponse(runReads++ === 0 ? validRunAuthority() : validRunAuthority({ state: "READY" }));
  });
  t.after(() => control.cleanup());
  control.setBinding(async (command) => { bindingCalls.push(command); return { state: "TARGET_OPEN", runId: RUN_ID }; });

  await clickResolveReview(control);
  assert.match(control.container.textContent ?? "", /Review resolved\./);
  assert.deepEqual(bindingCalls, []);
  const serialized = JSON.stringify(bindingCalls);
  for (const privateValue of [resolveReviewPath(), "a".repeat(64), "unknown_requirement_ids", "answerPacketVersion"]) {
    assert.equal(serialized.includes(privateValue), false, privateValue);
  }
});

test("Task 3 mounted resolve disables for unverified/loading/answer-pending authority and enables the exact trusted case", async (t) => {
  const packet = readyReviewPacket();
  const heldRefresh = deferred<Response>();
  let packetReads = 0;
  const control = await mountControl(async (input) => {
    const url = String(input);
    if (url.endsWith("/answer-packet")) return packetReads++ === 0 ? packetResponse(packet) : heldRefresh.promise;
    if (url === answerReviewPath()) return deferred<Response>().promise;
    return runResponse();
  });
  t.after(() => control.cleanup());

  assert.equal(resolveReviewButton(control.container).disabled, false, "trusted REVIEW_REQUIRED packet");
  await clickButton(control, "Refresh review data");
  assert.equal(resolveReviewButton(control.container).disabled, true, "authority loading");
  heldRefresh.resolve(packetResponse(packet));
  await flushComponentWork();
  assert.equal(resolveReviewButton(control.container).disabled, false, "refreshed authority");

  control.setFetchHandler(async (input) => String(input).endsWith("/answer-packet") ? new Response("{}", { status: 500 }) : runResponse());
  await clickButton(control, "Refresh review data");
  assert.equal(resolveReviewButton(control.container).disabled, true, "unverified authority");
});

test("Task 3 mounted pending answer and pending resolve disable every review action without dispatching disabled controls", async (t) => {
  const answerPost = deferred<Response>();
  const control = await mountControl(async (input) => {
    const url = String(input);
    if (url === answerReviewPath()) return answerPost.promise;
    if (url.endsWith("/answer-packet")) return packetResponse(readyReviewPacket());
    return runResponse();
  });
  t.after(() => control.cleanup());

  await clickReviewButton(control, "Approve", "Portfolio URL");
  assert.equal(resolveReviewButton(control.container).disabled, true, "answer pending");
  assert.equal(reviewButton(control.container, "Reject", "Portfolio URL").disabled, true, "all answer actions pending");
  assert.equal(buttonNamed(control.container, "Refresh review data").disabled, true, "refresh pending");
  answerPost.reject(new Error("network"));
  await flushComponentWork();
});

test("Task 3 mounted invalid and rejected resolve responses fail closed and release the lock after handling", async () => {
  const invalidResponses: Array<[string, (input: RequestInfo | URL) => Promise<Response>]> = [
    ["network", async (input) => { if (String(input) === resolveReviewPath()) throw new Error("network"); return String(input).endsWith("/answer-packet") ? packetResponse(readyReviewPacket()) : runResponse(); }],
    ["invalid json", async (input) => String(input) === resolveReviewPath() ? { ok: true, status: 200, json: async () => { throw new Error("json"); } } as unknown as Response : String(input).endsWith("/answer-packet") ? packetResponse(readyReviewPacket()) : runResponse()],
    ["wrong run", async (input) => String(input) === resolveReviewPath() ? new Response(JSON.stringify({ run: validRunAuthority({ id: OTHER_RUN_ID, state: "READY" }) }), { status: 200 }) : String(input).endsWith("/answer-packet") ? packetResponse(readyReviewPacket()) : runResponse()],
    ["unknown state", async (input) => String(input) === resolveReviewPath() ? new Response(JSON.stringify({ run: validRunAuthority({ state: "NOT_A_STATE" }) }), { status: 200 }) : String(input).endsWith("/answer-packet") ? packetResponse(readyReviewPacket()) : runResponse()],
    ["invalid state version", async (input) => String(input) === resolveReviewPath() ? new Response(JSON.stringify({ run: validRunAuthority({ stateVersion: -1 }) }), { status: 200 }) : String(input).endsWith("/answer-packet") ? packetResponse(readyReviewPacket()) : runResponse()],
    ["duplicate reasons", async (input) => String(input) === resolveReviewPath() ? new Response(JSON.stringify({ run: validRunAuthority({ reviewReasons: ["unknown_requirement_ids", "unknown_requirement_ids"] }) }), { status: 200 }) : String(input).endsWith("/answer-packet") ? packetResponse(readyReviewPacket()) : runResponse()],
    ["unknown reason", async (input) => String(input) === resolveReviewPath() ? new Response(JSON.stringify({ run: validRunAuthority({ reviewReasons: ["not-a-reason"] }) }), { status: 200 }) : String(input).endsWith("/answer-packet") ? packetResponse(readyReviewPacket()) : runResponse()],
    ["strict extra field", async (input) => String(input) === resolveReviewPath() ? new Response(JSON.stringify({ run: validRunAuthority(), extra: true }), { status: 200 }) : String(input).endsWith("/answer-packet") ? packetResponse(readyReviewPacket()) : runResponse()]
  ];
  for (const [name, handler] of invalidResponses) {
    const control = await mountControl(handler);
    try {
      await clickResolveReview(control);
      assert.doesNotMatch(control.container.textContent ?? "", /Review resolved\./, name);
      assert.equal(resolveReviewButton(control.container).disabled, true, name);
      control.setFetchHandler(async (input) => String(input).endsWith("/answer-packet") ? packetResponse(readyReviewPacket()) : runResponse());
      await clickButton(control, "Refresh review data");
      assert.equal(resolveReviewButton(control.container).disabled, false, `${name} releases lock after failure handling`);
    } finally {
      await control.cleanup();
    }
  }
});

test("Task 3 mounted resolve refresh FAILED and SUPERSEDED never publish stale success", async (t) => {
  let packetReads = 0;
  const failed = await mountControl(async (input) => {
    const url = String(input);
    if (url === resolveReviewPath()) return new Response(JSON.stringify({ run: validRunAuthority({ state: "READY" }) }), { status: 200 });
    if (url.endsWith("/answer-packet")) return packetReads++ === 0 ? packetResponse(readyReviewPacket()) : new Response("{}", { status: 503 });
    return runResponse();
  });
  try {
    await clickResolveReview(failed);
    assert.doesNotMatch(failed.container.textContent ?? "", /Review resolved\./);
    assert.equal(resolveReviewButton(failed.container).disabled, true);
    failed.setFetchHandler(async (input) => String(input).endsWith("/answer-packet") ? packetResponse(readyReviewPacket()) : runResponse());
    await clickButton(failed, "Refresh review data");
    assert.equal(resolveReviewButton(failed.container).disabled, false, "FAILED refresh releases the lock after authority failure");
  } finally {
    await failed.cleanup();
  }

  const oldRun = deferred<Response>();
  const oldPacket = deferred<Response>();
  let runReads = 0;
  let supersededPacketReads = 0;
  const superseded = await mountControl(async (input) => {
    const url = String(input);
    if (url === resolveReviewPath()) return new Response(JSON.stringify({ run: validRunAuthority({ state: "READY" }) }), { status: 200 });
    if (url.endsWith("/answer-packet")) {
      supersededPacketReads += 1;
      if (supersededPacketReads === 1) return packetResponse(readyReviewPacket());
      if (supersededPacketReads === 2) return oldPacket.promise;
      return packetResponse(readyReviewPacket({ reviewedAt: "2026-08-30T00:00:00.000Z" }));
    }
    runReads += 1;
    if (runReads === 1) return runResponse();
    if (runReads === 2) return oldRun.promise;
    return runResponse(validRunAuthority({ state: "READY" }));
  });
  t.after(() => superseded.cleanup());
  superseded.setBinding(async () => ({
    state: "TARGET_OPEN",
    runId: RUN_ID,
    inspection: { outcome: "SUCCEEDED", replayed: false, inspectionVersion: 9, answerPacketVersion: 9, reinspectionRequired: false }
  }));
  await clickResolveReview(superseded);
  await clickButton(superseded, "Refresh status");
  oldRun.resolve(runResponse());
  oldPacket.resolve(packetResponse(readyReviewPacket()));
  await flushComponentWork();
  assert.doesNotMatch(superseded.container.textContent ?? "", /Review resolved\./);
});

test("Task 3 mounted held authority replacement makes the old resolve authority inert and dispatches only the replacement snapshot", async (t) => {
  const replacementPacket = deferred<Response>();
  let runReads = 0;
  let packetReads = 0;
  const newPacket = readyReviewPacket({ answerPacketVersion: 4, packetHash: "b".repeat(64) });
  const control = await mountControl(async (input) => {
    const url = String(input);
    if (url === resolveReviewPath()) return new Response(JSON.stringify({ run: validRunAuthority({ state: "READY" }) }), { status: 200 });
    if (url.endsWith("/answer-packet")) return packetReads++ === 0 ? packetResponse(readyReviewPacket()) : replacementPacket.promise;
    return runResponse(runReads++ === 0 ? validRunAuthority() : validRunAuthority({ stateVersion: 8, reviewReasons: ["unknown_evidence_ids", "evidence_gaps_present"] }));
  });
  t.after(() => control.cleanup());
  await clickButton(control, "Refresh review data");
  assert.equal(resolveReviewButton(control.container).disabled, true, "old authority is inert while replacement is pending");
  assert.equal(control.fetchCalls.filter((call) => String(call.input) === resolveReviewPath()).length, 0);
  replacementPacket.resolve(packetResponse(newPacket));
  await flushComponentWork();
  assert.equal(resolveReviewButton(control.container).disabled, false);
  await clickResolveReview(control);
  const request = control.fetchCalls.find((call) => String(call.input) === resolveReviewPath());
  assert.ok(request);
  assert.deepEqual(JSON.parse(String(request.init?.body)), {
    stateVersion: 8,
    acknowledgedReviewReasons: ["unknown_evidence_ids", "evidence_gaps_present"],
    answerPacketVersion: 4,
    packetHash: "b".repeat(64)
  });
});

test("Task 3 mounted valid and rejected resolve settlements after unmount produce no follow-on effects", async () => {
  for (const settle of [
    (post: Deferred<Response>) => post.resolve(new Response(JSON.stringify({ run: validRunAuthority({ state: "READY" }) }), { status: 200 })),
    (post: Deferred<Response>) => post.reject(new Error("network"))
  ]) {
    const post = deferred<Response>();
    const bindingCalls: B1Command[] = [];
    const postSignalRef: { current: AbortSignal | null } = { current: null };
    const control = await mountControl(async (input, init) => {
      if (String(input) === resolveReviewPath()) {
        postSignalRef.current = init?.signal ?? null;
        return post.promise;
      }
      return String(input).endsWith("/answer-packet") ? packetResponse(readyReviewPacket()) : runResponse();
    });
    try {
      control.setBinding(async (command) => { bindingCalls.push(command); return { state: "TARGET_OPEN", runId: RUN_ID }; });
      await clickResolveReview(control);
      assert.ok(postSignalRef.current);
      const postSignal = postSignalRef.current as AbortSignal;
      assert.equal(postSignal.aborted, false);
      const before = control.fetchCalls.length;
      await control.unmount();
      assert.equal(postSignal.aborted, true);
      settle(post);
      await flushComponentWork();
      assert.equal(control.fetchCalls.length, before);
      assert.deepEqual(bindingCalls, []);
    } finally {
      await control.cleanup();
    }
  }
});

test("Task 3 mounted post-success refresh becomes INACTIVE on unmount without a success or follow-on effect", async () => {
  const refreshRun = deferred<Response>();
  const refreshPacket = deferred<Response>();
  const bindingCalls: B1Command[] = [];
  const mutationSignalRef: { current: AbortSignal | null } = { current: null };
  let runReads = 0;
  let packetReads = 0;
  const control = await mountControl(async (input, init) => {
    const url = String(input);
    if (url === resolveReviewPath()) {
      mutationSignalRef.current = init?.signal ?? null;
      return new Response(JSON.stringify({ run: validRunAuthority({ state: "READY" }) }), { status: 200 });
    }
    if (url.endsWith("/answer-packet")) return packetReads++ === 0 ? packetResponse(readyReviewPacket()) : refreshPacket.promise;
    return runReads++ === 0 ? runResponse() : refreshRun.promise;
  });
  try {
    control.setBinding(async (command) => { bindingCalls.push(command); return { state: "TARGET_OPEN", runId: RUN_ID }; });
    await clickResolveReview(control);
    assert.equal(control.fetchCalls.filter((call) => String(call.input) === `/api/application-runs/${RUN_ID}`).length, 2);
    assert.equal(control.fetchCalls.filter((call) => String(call.input).endsWith("/answer-packet")).length, 2);
    assert.match(control.container.textContent ?? "", /Run stateREVIEW_REQUIRED/);
    assert.doesNotMatch(control.container.textContent ?? "", /Review resolved\./);
    assert.ok(mutationSignalRef.current);
    const mutationSignal = mutationSignalRef.current as AbortSignal;
    await control.unmount();
    assert.equal(mutationSignal.aborted, true);
    const before = control.fetchCalls.length;
    refreshRun.resolve(runResponse(validRunAuthority({ state: "READY" })));
    refreshPacket.resolve(packetResponse(readyReviewPacket({ reviewedAt: "2026-08-30T00:00:00.000Z" })));
    await flushComponentWork();
    assert.equal(control.fetchCalls.length, before);
    assert.deepEqual(bindingCalls, []);
  } finally {
    await control.cleanup();
  }
});
