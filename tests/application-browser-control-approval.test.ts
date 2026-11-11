import assert from "node:assert/strict";
import test from "node:test";

import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

import { ApplicationBrowserControl } from "@/components/application-browser-control";
import type { AnswerPacket } from "@/lib/application-browser/control-presentation";
import { APPLICATION_BROWSER_BINDING_NAME, type B1Status } from "@/lib/application-browser/types";

// UX-4b (D035, D-H): one approval screen. One click sends today's per-answer review for each
// pending proposed answer (ticked → APPROVED, unticked → REJECTED), then today's resolve-review,
// and stops at the first failure or change.

const RUN_ID = "cm12345678901234567890123";
const STOP_MESSAGE = "The answers changed, so nothing more was approved. Check them again.";

type Answer = AnswerPacket["answers"][number];

function proposed(id: string, question: string, value: string, key: string): Answer {
  return {
    id,
    normalizedFieldKey: key.repeat(64),
    question,
    fieldType: "URL",
    classification: "PROFESSIONAL_LINK",
    disposition: "PROPOSABLE",
    dispositionReason: null,
    choices: [],
    proposal: { kind: "SCALAR", value },
    required: false,
    requiresReview: true,
    sensitive: false,
    valueRedacted: false,
    status: "PENDING",
    reviewedByUser: false,
    reviewedAt: null
  } as Answer;
}

function manual(): Answer {
  return {
    id: "answer-phone",
    normalizedFieldKey: "f".repeat(64),
    question: "Phone number",
    fieldType: "TEL",
    classification: "CONTACT",
    disposition: "MANUAL_ONLY",
    dispositionReason: "UNCONFIRMED_APPLICANT_CONTACT",
    choices: [],
    proposal: null,
    required: true,
    requiresReview: false,
    sensitive: false,
    valueRedacted: false,
    status: "PENDING",
    reviewedByUser: false,
    reviewedAt: null
  } as Answer;
}

function threeAnswers(): Answer[] {
  return [
    proposed("answer-a", "LinkedIn profile", "https://example.test/in/a", "a"),
    proposed("answer-b", "GitHub profile", "https://example.test/b", "b"),
    proposed("answer-c", "Personal website", "https://example.test/c", "c"),
    manual()
  ];
}

// A small owner-scoped server: the same routes and response shapes the control page uses today.
class FakeServer {
  runState: "REVIEW_REQUIRED" | "READY" = "REVIEW_REQUIRED";
  stateVersion = 7;
  packetVersion = 3;
  reviewedAt: string | null = null;
  answers: Answer[];
  requests: Array<{ method: string; url: string; body: unknown }> = [];
  failReviewFor: string | null = null;
  failReviewStatus = 500;
  onReview: ((answerId: string) => void) | null = null;
  failPacketReadsAfterReview = false;
  hold: { url: string; promise: Promise<void> } | null = null;

  constructor(answers: Answer[]) {
    this.answers = answers;
  }

  packet(): AnswerPacket {
    const proposable = this.answers.filter((answer) => answer.disposition === "PROPOSABLE");
    const pending = proposable.filter((answer) => answer.status === "PENDING").length;
    return {
      inspectionVersion: 2,
      answerPacketVersion: this.packetVersion,
      packetHash: "a".repeat(64),
      reviewedAt: this.reviewedAt,
      createdAt: "2026-08-29T20:00:00.000Z",
      summary: {
        fieldCount: this.answers.length,
        observedFieldCount: this.answers.length,
        ambiguousQuestionCount: 0,
        ambiguousRequiredCount: 0,
        proposableCount: proposable.length,
        pendingReviewCount: pending,
        approvedCount: proposable.filter((answer) => answer.status === "APPROVED").length,
        rejectedCount: proposable.filter((answer) => answer.status === "REJECTED").length,
        manualOnlyCount: this.answers.filter((answer) => answer.disposition === "MANUAL_ONLY").length,
        excludedCount: 0,
        unsupportedCount: 0,
        manualRequiredCount: 1,
        readyForRunResolution: pending === 0
      },
      answers: this.answers.map((answer) => ({ ...answer }))
    } as AnswerPacket;
  }

  run() {
    return {
      id: RUN_ID,
      state: this.runState,
      stateVersion: this.stateVersion,
      completedAt: null,
      reviewReasons: ["evidence_gaps_present"],
      applicationId: "application-synthetic",
      applyHost: "jobs.example.test"
    };
  }

  posts(): Array<{ url: string; body: unknown }> {
    return this.requests.filter((request) => request.method === "POST").map(({ url, body }) => ({ url, body }));
  }

  async handle(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    this.requests.push({ method, url, body });
    if (this.hold && this.hold.url === url) await this.hold.promise;
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
    if (method === "GET" && url === `/api/application-runs/${RUN_ID}`) return json({ run: this.run() });
    if (method === "GET" && url === `/api/application-runs/${RUN_ID}/answer-packet`) {
      if (this.failPacketReadsAfterReview && this.requests.some((request) => request.url.endsWith("/review"))) return json({}, 503);
      return json({ runId: RUN_ID, current: this.packet() });
    }
    if (method === "GET" && url === `/api/application-runs/${RUN_ID}/fill-attempt`) {
      return json({
        state: this.runState, stateVersion: this.stateVersion, fillAttemptId: null, fillLeaseExpiresAt: null,
        leaseLive: false, expiredRecoveryRequired: false, fieldOperationAllowed: false, outcome: null, errorCode: null, steps: []
      });
    }
    const review = url.match(new RegExp(`^/api/application-runs/${RUN_ID}/answers/([^/]+)/review$`));
    if (method === "POST" && review) {
      const answerId = decodeURIComponent(review[1]);
      if (this.failReviewFor === answerId) return json({}, this.failReviewStatus);
      const answer = this.answers.find((entry) => entry.id === answerId);
      if (!answer || answer.status !== "PENDING" || body.answerPacketVersion !== this.packetVersion) return json({}, 409);
      answer.status = body.status;
      answer.reviewedByUser = true;
      answer.reviewedAt = "2026-08-29T20:10:00.000Z";
      this.onReview?.(answerId);
      return json({
        answer: {
          id: answerId, runId: RUN_ID, status: body.status, reviewedByUser: true,
          reviewedAt: "2026-08-29T20:10:00.000Z", sensitive: false, valueRedacted: false
        }
      });
    }
    if (method === "POST" && url === `/api/application-runs/${RUN_ID}/resolve-review`) {
      this.runState = "READY";
      this.stateVersion += 1;
      this.reviewedAt = "2026-08-29T20:11:00.000Z";
      return json({ run: this.run() });
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  }
}

type Mounted = {
  container: HTMLElement;
  server: FakeServer;
  cleanup(): Promise<void>;
};

async function flush(turns = 12): Promise<void> {
  await act(async () => {
    for (let turn = 0; turn < turns; turn += 1) await Promise.resolve();
  });
}

async function mount(server: FakeServer, status?: B1Status): Promise<Mounted> {
  const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", {
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
  const savedFetch = Object.getOwnPropertyDescriptor(globalThis, "fetch");
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    writable: true,
    value: (input: RequestInfo | URL, init?: RequestInit) => server.handle(input, init)
  });
  if (status) {
    Object.defineProperty(dom.window, APPLICATION_BROWSER_BINDING_NAME, { configurable: true, writable: true, value: async () => status });
  }
  const root: Root = createRoot(container);
  await act(async () => {
    root.render(createElement(ApplicationBrowserControl, { runId: RUN_ID, authenticatedOwnerPage: true }));
  });
  await flush();
  return {
    container,
    server,
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

function tick(container: HTMLElement, question: string): HTMLInputElement {
  const box = container.querySelector<HTMLInputElement>(`input[data-testid="answer-tick"][data-question="${question}"]`);
  assert.ok(box, `Expected a tick box for ${question}.`);
  return box;
}

function approveButton(container: HTMLElement): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>('[data-step-action="CONTINUE_REVIEW"]');
  assert.ok(button, "Expected the approve-and-continue button.");
  return button;
}

async function untick(mounted: Mounted, question: string): Promise<void> {
  const box = tick(mounted.container, question);
  assert.equal(box.checked, true);
  await act(async () => box.click());
}

async function approveAll(mounted: Mounted): Promise<void> {
  await act(async () => approveButton(mounted.container).click());
  await flush(40);
}

function reviewPath(id: string): string {
  return `/api/application-runs/${RUN_ID}/answers/${id}/review`;
}

const RESOLVE_PATH = `/api/application-runs/${RUN_ID}/resolve-review`;

test("every proposed answer is listed with its question, the value to type and its source; pending ones start ticked", async () => {
  const server = new FakeServer(threeAnswers());
  server.answers[2] = { ...server.answers[2], status: "APPROVED", reviewedByUser: true, reviewedAt: "2026-08-29T20:05:00.000Z" };
  const mounted = await mount(server);
  try {
    const list = mounted.container.querySelector('[data-testid="approval-list"]');
    assert.ok(list);
    const rows = [...list.querySelectorAll('[data-testid="approval-row"]')];
    assert.deepEqual(rows.map((row) => row.getAttribute("data-question")), ["LinkedIn profile", "GitHub profile", "Personal website"]);
    const first = rows[0].textContent ?? "";
    assert.match(first, /LinkedIn profile/);
    assert.match(first, /https:\/\/example\.test\/in\/a/);
    assert.match(first, /Your application details/);
    assert.equal(tick(mounted.container, "LinkedIn profile").checked, true);
    assert.equal(tick(mounted.container, "LinkedIn profile").disabled, false);
    assert.equal(tick(mounted.container, "GitHub profile").checked, true);
    const decided = tick(mounted.container, "Personal website");
    assert.equal(decided.checked, true, "an approved answer shows ticked");
    assert.equal(decided.disabled, true, "a decided answer can't be changed here");
    assert.equal(list.querySelector('[data-question="Phone number"]'), null, "manual fields are not in the approval list");
    const phoneLink = mounted.container.querySelector<HTMLAnchorElement>('a[href="/settings/application-details"]');
    assert.equal(phoneLink?.getAttribute("target"), "_blank");
    assert.equal(mounted.container.querySelector('[aria-label^="Approve proposed answer for"]') === null, true, "no per-answer approve buttons");
  } finally {
    await mounted.cleanup();
  }
});

test("the button names how many ticked answers it approves", async () => {
  const server = new FakeServer(threeAnswers());
  const mounted = await mount(server);
  try {
    assert.equal(approveButton(mounted.container).textContent?.trim(), "Approve these 3 and continue");
    await untick(mounted, "GitHub profile");
    assert.equal(approveButton(mounted.container).textContent?.trim(), "Approve these 2 and continue");
    await untick(mounted, "LinkedIn profile");
    assert.equal(approveButton(mounted.container).textContent?.trim(), "Approve this 1 and continue");
    await untick(mounted, "Personal website");
    assert.equal(approveButton(mounted.container).textContent?.trim(), "Approve none and continue");
    assert.deepEqual(server.posts(), [], "ticking sends nothing");
  } finally {
    await mounted.cleanup();
  }
});

test("one click approves ticked answers and rejects unticked ones, in order, then resolves the review", async () => {
  const server = new FakeServer(threeAnswers());
  const mounted = await mount(server);
  try {
    await untick(mounted, "GitHub profile");
    await approveAll(mounted);
    assert.deepEqual(server.posts(), [
      { url: reviewPath("answer-a"), body: { status: "APPROVED", answerPacketVersion: 3 } },
      { url: reviewPath("answer-b"), body: { status: "REJECTED", answerPacketVersion: 3 } },
      { url: reviewPath("answer-c"), body: { status: "APPROVED", answerPacketVersion: 3 } },
      {
        url: RESOLVE_PATH,
        body: {
          stateVersion: 7,
          acknowledgedReviewReasons: ["evidence_gaps_present"],
          answerPacketVersion: 3,
          packetHash: "a".repeat(64),
          acknowledgedAmbiguousQuestionCount: 0
        }
      }
    ]);
    // Each mutation keeps its authority refresh: a paired run and packet read after each POST.
    const sequence = server.requests.map((request) => `${request.method} ${request.url.replace(`/api/application-runs/${RUN_ID}`, "")}`);
    const afterFirstPost = sequence.slice(sequence.indexOf(`POST /answers/answer-a/review`) + 1, sequence.indexOf(`POST /answers/answer-b/review`));
    assert.deepEqual(afterFirstPost.filter((entry) => entry !== "GET /fill-attempt"), ["GET ", "GET /answer-packet"]);
    assert.match(mounted.container.textContent ?? "", /Review resolved\./);
    assert.doesNotMatch(mounted.container.textContent ?? "", new RegExp(STOP_MESSAGE.replace(/[.,]/g, "\\$&")));
  } finally {
    await mounted.cleanup();
  }
});

test("unticking everything rejects every proposed answer, then resolves", async () => {
  const server = new FakeServer(threeAnswers());
  const mounted = await mount(server);
  try {
    for (const question of ["LinkedIn profile", "GitHub profile", "Personal website"]) await untick(mounted, question);
    await approveAll(mounted);
    assert.deepEqual(server.posts().map((post) => [post.url, (post.body as { status?: string }).status ?? "resolve"]), [
      [reviewPath("answer-a"), "REJECTED"],
      [reviewPath("answer-b"), "REJECTED"],
      [reviewPath("answer-c"), "REJECTED"],
      [RESOLVE_PATH, "resolve"]
    ]);
  } finally {
    await mounted.cleanup();
  }
});

test("already decided answers send nothing; only the review is resolved", async () => {
  const server = new FakeServer(threeAnswers().map((answer) => answer.disposition === "PROPOSABLE"
    ? { ...answer, status: "APPROVED", reviewedByUser: true, reviewedAt: "2026-08-29T20:05:00.000Z" } as Answer
    : answer));
  const mounted = await mount(server);
  try {
    // Review fix: the label names only what the click approves; nothing is waiting here.
    assert.equal(approveButton(mounted.container).textContent?.trim(), "Continue");
    await approveAll(mounted);
    assert.deepEqual(server.posts().map((post) => post.url), [RESOLVE_PATH]);
  } finally {
    await mounted.cleanup();
  }
});

test("a failed approval stops: nothing more is sent, the review data reloads and the page says so", async () => {
  const server = new FakeServer(threeAnswers());
  server.failReviewFor = "answer-b";
  const mounted = await mount(server);
  try {
    await approveAll(mounted);
    assert.deepEqual(server.posts().map((post) => post.url), [reviewPath("answer-a"), reviewPath("answer-b")]);
    const afterFailure = server.requests.slice(server.requests.findIndex((request) => request.url === reviewPath("answer-b")) + 1);
    assert.equal(afterFailure.some((request) => request.method === "GET" && request.url.endsWith("/answer-packet")), true, "review data reloads");
    assert.equal(afterFailure.some((request) => request.method === "POST"), false, "nothing more is sent");
    assert.match(mounted.container.textContent ?? "", /The answers changed, so nothing more was approved\. Check them again\./);
    assert.doesNotMatch(mounted.container.textContent ?? "", /Review resolved\./);
  } finally {
    await mounted.cleanup();
  }
});

test("a conflict on the server stops the sequence", async () => {
  const server = new FakeServer(threeAnswers());
  server.failReviewFor = "answer-a";
  server.failReviewStatus = 409;
  const mounted = await mount(server);
  try {
    await approveAll(mounted);
    assert.deepEqual(server.posts().map((post) => post.url), [reviewPath("answer-a")]);
    assert.match(mounted.container.textContent ?? "", /The answers changed, so nothing more was approved\. Check them again\./);
  } finally {
    await mounted.cleanup();
  }
});

test("answers that change between steps stop the sequence before anything else is sent", async () => {
  for (const change of ["new packet version", "answer value changed", "answer decided elsewhere"] as const) {
    const server = new FakeServer(threeAnswers());
    server.onReview = (answerId) => {
      if (answerId !== "answer-a") return;
      if (change === "new packet version") server.packetVersion = 4;
      if (change === "answer value changed") server.answers[1] = { ...server.answers[1], proposal: { kind: "SCALAR", value: "https://example.test/other" } };
      if (change === "answer decided elsewhere") server.answers[1] = { ...server.answers[1], status: "REJECTED", reviewedByUser: true, reviewedAt: "2026-08-29T20:09:00.000Z" };
    };
    const mounted = await mount(server);
    try {
      await approveAll(mounted);
      assert.deepEqual(server.posts().map((post) => post.url), [reviewPath("answer-a")], change);
      assert.match(mounted.container.textContent ?? "", /The answers changed, so nothing more was approved\. Check them again\./, change);
    } finally {
      await mounted.cleanup();
    }
  }
});

test("review data that can't be verified after an approval stops the sequence", async () => {
  const server = new FakeServer(threeAnswers());
  server.failPacketReadsAfterReview = true;
  const mounted = await mount(server);
  try {
    await approveAll(mounted);
    assert.deepEqual(server.posts().map((post) => post.url), [reviewPath("answer-a")]);
    assert.match(mounted.container.textContent ?? "", /nothing more was approved/);
  } finally {
    await mounted.cleanup();
  }
});

test("a double click sends one sequence, and the screen is locked while it runs", async () => {
  const server = new FakeServer(threeAnswers());
  let release!: () => void;
  server.hold = { url: reviewPath("answer-a"), promise: new Promise<void>((resolve) => { release = resolve; }) };
  const mounted = await mount(server);
  try {
    const button = approveButton(mounted.container);
    await act(async () => {
      button.click();
      button.click();
      await Promise.resolve();
    });
    assert.equal(approveButton(mounted.container).disabled, true);
    assert.equal(approveButton(mounted.container).textContent?.trim(), "Approving…");
    assert.equal(tick(mounted.container, "GitHub profile").disabled, true, "ticks are locked while approving");
    const refresh = [...mounted.container.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === "Refresh review data");
    assert.equal(refresh?.disabled, true);
    release();
    await flush(40);
    assert.equal(server.posts().filter((post) => post.url === reviewPath("answer-a")).length, 1);
    assert.equal(server.posts().filter((post) => post.url === RESOLVE_PATH).length, 1);
    assert.doesNotMatch(mounted.container.textContent ?? "", /nothing more was approved/, "the second click is ignored, not treated as a change");
    assert.match(mounted.container.textContent ?? "", /Review resolved\./);
  } finally {
    await mounted.cleanup();
  }
});

test("a click from a screen that shows older answers sends nothing", async () => {
  const changes: Array<[string, (server: FakeServer) => void]> = [
    ["a new version with a different answer", (server) => {
      server.packetVersion = 4;
      server.answers[0] = { ...server.answers[0], id: "answer-new", question: "New question" };
    }],
    // Same version, one more answer the screen never showed: only the screen check can stop it.
    ["the same version with one more answer", (server) => {
      server.answers.splice(3, 0, proposed("answer-extra", "Portfolio", "https://example.test/portfolio", "e"));
    }]
  ];
  for (const [name, change] of changes) {
    const server = new FakeServer(threeAnswers());
    const mounted = await mount(server);
    try {
      const button = approveButton(mounted.container);
      const propsKey = Object.keys(button).find((key) => key.startsWith("__reactProps$"));
      assert.ok(propsKey);
      const staleClick = (button as unknown as Record<string, { onClick: () => void }>)[propsKey].onClick;
      change(server);
      const refresh = [...mounted.container.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === "Refresh review data");
      await act(async () => refresh!.click());
      await flush();
      await act(async () => staleClick());
      await flush(40);
      assert.deepEqual(server.posts(), [], name);
      assert.match(mounted.container.textContent ?? "", /The answers changed, so nothing more was approved\. Check them again\./, name);
    } finally {
      await mounted.cleanup();
    }
  }
});

test("an answer that changes after its approval stops the review from being resolved", async () => {
  for (const change of ["value changed", "decision changed"] as const) {
    const server = new FakeServer(threeAnswers());
    server.onReview = (answerId) => {
      if (answerId !== "answer-c") return;
      server.answers[0] = change === "value changed"
        ? { ...server.answers[0], proposal: { kind: "SCALAR", value: "https://example.test/in/changed" } }
        : { ...server.answers[0], status: "REJECTED" };
    };
    const mounted = await mount(server);
    try {
      await approveAll(mounted);
      assert.deepEqual(server.posts().map((post) => post.url), [reviewPath("answer-a"), reviewPath("answer-b"), reviewPath("answer-c")], change);
      assert.match(mounted.container.textContent ?? "", /The answers changed, so nothing more was approved\. Check them again\./, change);
    } finally {
      await mounted.cleanup();
    }
  }
});

test("after approval the page moves on to Fill when the form was read in this window", async () => {
  const server = new FakeServer(threeAnswers());
  const status: B1Status = {
    state: "TARGET_OPEN",
    runId: RUN_ID,
    inspection: { outcome: "SUCCEEDED", replayed: false, inspectionVersion: 2, answerPacketVersion: 3, reinspectionRequired: false }
  };
  const mounted = await mount(server, status);
  try {
    const refreshStatus = [...mounted.container.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === "Refresh status");
    await act(async () => refreshStatus!.click());
    await flush();
    assert.equal(mounted.container.querySelector('[data-testid="now-card"]')?.getAttribute("data-step"), "5");
    assert.equal(approveButton(mounted.container).getAttribute("data-primary-action"), "CONTINUE_REVIEW");
    await approveAll(mounted);
    assert.equal(mounted.container.querySelector('[data-testid="now-card"]')?.getAttribute("data-step"), "6");
  } finally {
    await mounted.cleanup();
  }
});

// Review fixes (UX-4b).

test("review fix: after a run that stopped part-way, the label counts only the answers still to approve", async () => {
  const server = new FakeServer(threeAnswers());
  server.failReviewFor = "answer-b";
  const mounted = await mount(server);
  try {
    await approveAll(mounted);
    assert.deepEqual(server.posts().map((post) => post.url), [reviewPath("answer-a"), reviewPath("answer-b")]);
    assert.equal(tick(mounted.container, "LinkedIn profile").disabled, true, "A is already approved");
    assert.equal(approveButton(mounted.container).textContent?.trim(), "Approve these 2 and continue");
    server.failReviewFor = null;
    const before = server.posts().length;
    await approveAll(mounted);
    assert.deepEqual(server.posts().slice(before).map((post) => post.url), [reviewPath("answer-b"), reviewPath("answer-c"), RESOLVE_PATH]);
    assert.equal(server.posts().slice(before).filter((post) => post.url !== RESOLVE_PATH).length, 2, "it approved exactly the 2 it named");
  } finally {
    await mounted.cleanup();
  }
});

test("review fix: the 'doesn't fill this kind of field' note follows each answer, even when two share a label", async () => {
  const phoneBox = proposed("answer-phone-box", "Phone", "+1 555 555 0100", "1");
  const phoneChoice = {
    ...proposed("answer-phone-choice", "Phone", "", "2"),
    fieldType: "RADIO_GROUP",
    classification: "CONTACT",
    choices: [{ key: "mobile", label: "Mobile", disabled: false }, { key: "home", label: "Home", disabled: false }],
    proposal: { kind: "OPTIONS", optionKeys: ["mobile"] }
  } as Answer;
  const server = new FakeServer([phoneBox, phoneChoice]);
  const mounted = await mount(server);
  try {
    const rows = [...mounted.container.querySelectorAll('[data-testid="approval-row"]')];
    assert.equal(rows.length, 2);
    const note = /doesn't fill this kind of field/;
    assert.equal(note.test(rows[0].textContent ?? ""), false, "the phone box is a kind Fill types");
    assert.equal(note.test(rows[1].textContent ?? ""), true, "the choice buttons are not");
  } finally {
    await mounted.cleanup();
  }
});

test("review check: a proposed answer without a value never reaches the screen, so nothing is sent for it", async () => {
  // The packet parser refuses a PROPOSABLE answer whose proposal is null, so such a packet is never
  // shown and the approval click can't plan a write the screen didn't name.
  const server = new FakeServer(threeAnswers());
  server.answers[1] = { ...server.answers[1], proposal: null };
  const mounted = await mount(server);
  try {
    assert.equal(mounted.container.querySelector('[data-testid="approval-list"]') === null, true);
    assert.equal(mounted.container.querySelector('[data-step-action="CONTINUE_REVIEW"]') === null, true);
    assert.match(mounted.container.textContent ?? "", /could not safely read the review authority response/i);
    assert.deepEqual(server.posts(), []);
  } finally {
    await mounted.cleanup();
  }
});
