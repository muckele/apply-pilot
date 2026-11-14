import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import { JSDOM } from "jsdom";
import { act, createElement, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";

import { ApplyKit } from "@/components/apply-kit/apply-kit";
import { JobApplyReturnPrompt } from "@/components/job-workspace/job-apply-return-prompt";
import { loadApplyKitView, type ApplyKitView } from "@/lib/apply-kit/apply-kit-view";
import { JOB, OWNER, fakeDb, fixtures } from "@/tests/fixtures/apply-kit-db";
import { typeInto } from "@/tests/fixtures/react-input";

// "Did you apply?" in the browser: the return trigger, the one large window (G-7) and its three
// answers. "Yes, I applied" records Applied in one click with the documents attached to the
// application; the full confirmation stays for choosing documents or minutes by hand.

type Request = { url: string; init: RequestInit };
type Harness = {
  container: HTMLElement;
  requests: Request[];
  refreshes: () => number;
  dom: JSDOM;
  leave: () => Promise<void>;
  comeBack: () => Promise<void>;
};

const NOW = new Date("2026-11-06T18:00:00.000Z").getTime();

async function kitView(change?: (view: ApplyKitView) => ApplyKitView) {
  const view = (await loadApplyKitView(fakeDb(fixtures()).db, { userId: OWNER, jobId: JOB, aiGenerationAvailable: true }))!;
  return change ? change(view) : view;
}

const withPending = (openedAt: string) => (view: ApplyKitView): ApplyKitView => ({
  ...view,
  application: { id: "application-1", status: "SAVED", statusLabel: "Saved", dateApplied: null },
  applyReturn: { pending: { openedEventId: "event-opened", openedAt }, declined: null }
});

async function mounted(
  element: ReactElement,
  respond: (request: Request) => Response,
  run: (harness: Harness) => Promise<void>
) {
  const dom = new JSDOM("<html><body><div id='root'></div></body></html>", { url: `http://localhost/jobs/${JOB}/apply` });
  const requests: Request[] = [];
  let refreshCount = 0;
  let visibility: DocumentVisibilityState = "visible";
  Object.defineProperty(dom.window.document, "visibilityState", { configurable: true, get: () => visibility });
  // window.alert/confirm would be the wrong tool: the question is the page's own large window.
  dom.window.alert = () => { throw new Error("alert() must not be used"); };
  dom.window.confirm = () => { throw new Error("confirm() must not be used"); };
  // JSDOM cannot open tabs; stop the link's default action after React has handled the click.
  dom.window.document.addEventListener("click", (event) => event.preventDefault());
  const prior = new Map<string, PropertyDescriptor | undefined>();
  const globals = {
    window: dom.window,
    self: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Event: dom.window.Event,
    IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: () => 0,
    fetch: async (url: string, init: RequestInit) => {
      const request = { url, init };
      requests.push(request);
      return respond(request);
    }
  };
  for (const [name, value] of Object.entries(globals)) {
    prior.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  const container = dom.window.document.getElementById("root")!;
  const root = createRoot(container);
  const noop = () => {};
  const router = { bfcacheId: "apply-return", back: noop, forward: noop, push: noop, replace: noop, prefetch: noop, refresh: () => { refreshCount += 1; } };
  const setVisibility = async (next: DocumentVisibilityState) => {
    visibility = next;
    await act(async () => { dom.window.document.dispatchEvent(new dom.window.Event("visibilitychange")); });
  };
  try {
    await act(async () => {
      root.render(createElement(AppRouterContext.Provider, { value: router }, element));
    });
    await run({
      container,
      requests,
      refreshes: () => refreshCount,
      dom,
      leave: () => setVisibility("hidden"),
      comeBack: () => setVisibility("visible")
    });
  } finally {
    await act(async () => root.unmount());
    for (const [name, descriptor] of prior) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    dom.window.close();
  }
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const openedOk = () => json({ opened: { eventId: "event-opened", openedAt: new Date(NOW).toISOString() } });

function element<T extends Element = HTMLElement>(container: ParentNode, selector: string) {
  const found = container.querySelector<T>(selector);
  assert.ok(found, `missing ${selector}`);
  return found;
}

// Compares a boolean: a failing assertion on a JSDOM node would try to print the whole DOM graph.
function absent(container: ParentNode, selector: string, message?: string) {
  assert.equal(container.querySelector(selector) === null, true, message ?? `unexpected ${selector}`);
}

async function click(target: HTMLElement) {
  await act(async () => { target.click(); });
}

function clock(t: TestContext) {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  return { advanceMinutes: (minutes: number) => t.mock.timers.tick(minutes * 60_000) };
}

test("opening the application records the opened moment and asks only once the user comes back to this tab", async (t) => {
  const time = clock(t);
  await mounted(createElement(ApplyKit, { view: await kitView(), beforeAiRun: async () => true }), openedOk, async ({ container, requests, leave, comeBack }) => {
    const link = element<HTMLAnchorElement>(container, "[data-apply-link]");
    assert.equal(link.getAttribute("target"), "_blank", "a new tab, not a pop-up window");
    assert.equal(link.getAttribute("rel"), "noopener noreferrer");
    absent(container, "[data-apply-return]");

    await click(link);
    assert.equal(requests.length, 1);
    assert.equal(requests[0]!.url, `/api/jobs/${JOB}/apply-return`);
    assert.equal(requests[0]!.init.method, "POST");
    assert.equal(requests[0]!.init.keepalive, true, "the record survives the tab switch");
    assert.deepEqual(JSON.parse(String(requests[0]!.init.body)), { action: "OPENED" });
    absent(container, "[data-apply-return]", "not asked while the user is still here");

    await leave();
    time.advanceMinutes(23);
    absent(container, "[data-apply-return]");
    await comeBack();
    const card = element(container, "[data-apply-return]");
    assert.equal(card.tagName, "DIALOG", "the same large window as the result window");
    assert.match(card.textContent ?? "", /Did you submit your application to Example Co\?/u);
    for (const answer of ["yes", "not-yet", "not-applying"]) element(card, `[data-apply-return-${answer}]`);
    assert.equal(requests.length, 1, "coming back records nothing by itself");
  });
});

test("the return is also noticed when the window regains focus after losing it", async (t) => {
  clock(t);
  await mounted(createElement(ApplyKit, { view: await kitView(), beforeAiRun: async () => true }), openedOk, async ({ container, dom }) => {
    await click(element(container, "[data-apply-link]"));
    await act(async () => { dom.window.dispatchEvent(new dom.window.Event("focus")); });
    absent(container, "[data-apply-return]", "focus without having left is not a return");
    await act(async () => { dom.window.dispatchEvent(new dom.window.Event("blur")); });
    await act(async () => { dom.window.dispatchEvent(new dom.window.Event("focus")); });
    assert.ok(container.querySelector("[data-apply-return]"));
  });
});

test("'Yes, I applied' records Applied in one click, with the documents attached to the application", async (t) => {
  const time = clock(t);
  const view = await kitView();
  await mounted(createElement(ApplyKit, { view, beforeAiRun: async () => true }), (request) => (request.url === "/api/applications" ? json({ application: { id: "application-1", status: "APPLIED" } }) : openedOk()), async ({ container, requests, refreshes, leave, comeBack }) => {
    await click(element(container, "[data-apply-link]"));
    await leave();
    time.advanceMinutes(23);
    await comeBack();
    await click(element(container, "[data-apply-return-yes]"));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

    const applied = requests.filter((request) => request.url === "/api/applications");
    assert.equal(applied.length, 1, "one click, one request");
    assert.equal(applied[0]!.init.method, "POST");
    // No document ids: the server records the documents attached to this application.
    assert.deepEqual(JSON.parse(String(applied[0]!.init.body)), { jobPostingId: JOB, status: "APPLIED" });
    assert.equal(refreshes(), 1);
    absent(container, "[data-apply-return]");
    absent(container, "[data-applied-confirmation]", "no second confirmation");
    const recorded = element(container, "[data-applied-recorded]");
    assert.match(recorded.textContent ?? "", /Recorded as applied\./u);
    assert.equal(element<HTMLAnchorElement>(recorded, "a").getAttribute("href"), "/applications?status=APPLIED");
  });
});

test("the full confirmation (from the job page's fallback) still pre-fills the minutes, which can be cleared", async (t) => {
  clock(t);
  await mounted(createElement(ApplyKit, { view: await kitView(withPending(new Date(NOW - 40 * 60_000).toISOString())), answeredYes: true, beforeAiRun: async () => true }), () => json({ application: { id: "application-1" } }), async ({ container, requests }) => {
    const minutes = element<HTMLInputElement>(container, "[data-effort-minutes]");
    assert.equal(minutes.value, "40", "after a reload the gap since the recorded opened moment is used");
    await typeInto(minutes, "");
    absent(container, "[data-effort-prefilled]");
    await click(element(container, "[data-attest]"));
    await click(element(container, "[data-confirm-applied]"));
    assert.equal(Object.hasOwn(JSON.parse(String(requests[0]!.init.body)), "effortMinutes"), false);
  });
});

test("coming back the next day, the full confirmation leaves the minutes for the user to estimate", async (t) => {
  clock(t);
  await mounted(createElement(ApplyKit, { view: await kitView(withPending(new Date(NOW - 26 * 60 * 60_000).toISOString())), answeredYes: true, beforeAiRun: async () => true }), openedOk, async ({ container }) => {
    assert.equal(element<HTMLInputElement>(container, "[data-effort-minutes]").value, "");
    absent(container, "[data-effort-prefilled]");
  });
});

test("if one-click 'Yes' is refused, the window says why and offers the full confirmation", async (t) => {
  clock(t);
  const stale = () => json({ error: "Regenerate documents.", code: "APPLICATION_DOCUMENT_EVIDENCE_STALE" }, 409);
  await mounted(createElement(ApplyKit, { view: await kitView(withPending(new Date(NOW - 10 * 60_000).toISOString())), beforeAiRun: async () => true }), stale, async ({ container, refreshes }) => {
    await click(element(container, "[data-apply-return-yes]"));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.match(element(container, "[data-apply-return-error]").textContent ?? "", /master résumé or reviewed evidence changed/u);
    assert.equal(refreshes(), 1);
    absent(container, "[data-applied-recorded]");
    await click(element(container, "[data-apply-return-choose]"));
    absent(container, "[data-apply-return]");
    element(container, "[data-applied-confirmation]");
  });
});

test("'Not yet' closes the card without recording anything, and the question is back on the next visit", async (t) => {
  clock(t);
  const view = await kitView(withPending(new Date(NOW - 15 * 60_000).toISOString()));
  await mounted(createElement(ApplyKit, { view, beforeAiRun: async () => true }), openedOk, async ({ container, requests, refreshes }) => {
    const card = element(container, "[data-apply-return]");
    assert.match(card.textContent ?? "", /Example Co/u);
    await click(element(card, "[data-apply-return-not-yet]"));
    absent(container, "[data-apply-return]");
    assert.deepEqual([requests.length, refreshes()], [0, 0]);
    absent(container, "[data-applied-confirmation]");
  });
  // A reload, a closed tab or another device renders the kit again from the same unanswered moment.
  await mounted(createElement(ApplyKit, { view, beforeAiRun: async () => true }), openedOk, async ({ container }) => {
    element(container, "[data-apply-return]");
  });
});

test("'Not applying' sends that answer, refreshes the kit, and a 409 is explained", async (t) => {
  clock(t);
  const view = await kitView(withPending(new Date(NOW - 5 * 60_000).toISOString()));
  await mounted(createElement(ApplyKit, { view, beforeAiRun: async () => true }), () => json({ application: { id: "application-1", status: "ARCHIVED" } }), async ({ container, requests, refreshes }) => {
    await click(element(container, "[data-apply-return-not-applying]"));
    assert.equal(requests.length, 1);
    assert.equal(requests[0]!.url, `/api/jobs/${JOB}/apply-return`);
    assert.deepEqual(JSON.parse(String(requests[0]!.init.body)), { action: "NOT_APPLYING" });
    assert.equal(refreshes(), 1);
    absent(container, "[data-apply-return]");
    assert.match(element(container, "[data-kit-message]").textContent ?? "", /out of your active applications/u);
  });
  const answered = () => json({ error: "There is no open \"Did you apply?\" question for this job.", code: "APPLY_RETURN_NOT_PENDING" }, 409);
  await mounted(createElement(ApplyKit, { view, beforeAiRun: async () => true }), answered, async ({ container, refreshes }) => {
    await click(element(container, "[data-apply-return-not-applying]"));
    assert.match(element(container, "[data-apply-return-error]").textContent ?? "", /no open "Did you apply\?" question/u);
    assert.equal(refreshes(), 1, "the kit reloads to show the answer given elsewhere");
  });
});

test("a 'Not applying' answer in effect can be undone from the kit", async (t) => {
  clock(t);
  const view = await kitView((current) => ({
    ...current,
    canRecordApplied: false,
    application: { id: "application-1", status: "ARCHIVED", statusLabel: "Archived", dateApplied: null },
    applyReturn: { pending: null, declined: { eventId: "event-decline", answeredAt: new Date(NOW).toISOString(), previousStatus: "SAVED", previousPostingStatus: "ACTIVE" } }
  }));
  await mounted(createElement(ApplyKit, { view, beforeAiRun: async () => true }), () => json({ application: { id: "application-1", status: "SAVED" } }), async ({ container, requests, refreshes }) => {
    absent(container, "[data-apply-return]");
    const notice = element(container, "[data-apply-return-declined]");
    assert.match(notice.textContent ?? "", /not applying/iu);
    await click(element(notice, "[data-apply-return-undo]"));
    assert.deepEqual(JSON.parse(String(requests[0]!.init.body)), { action: "UNDO_NOT_APPLYING" });
    assert.equal(refreshes(), 1);
  });
});

test("an application already recorded as applied is neither recorded as opened nor asked about", async (t) => {
  clock(t);
  const view = await kitView((current) => ({
    ...current,
    canRecordApplied: false,
    application: { id: "application-1", status: "APPLIED", statusLabel: "Applied", dateApplied: new Date(NOW).toISOString() }
  }));
  await mounted(createElement(ApplyKit, { view, beforeAiRun: async () => true }), openedOk, async ({ container, requests, leave, comeBack }) => {
    await click(element(container, "[data-apply-link]"));
    await leave();
    await comeBack();
    assert.equal(requests.length, 0);
    absent(container, "[data-apply-return]");
  });
});

test("arriving from the job page's 'Yes, I applied' opens the confirmation straight away", async (t) => {
  clock(t);
  const view = await kitView(withPending(new Date(NOW - 12 * 60_000).toISOString()));
  await mounted(createElement(ApplyKit, { view, answeredYes: true, beforeAiRun: async () => true }), openedOk, async ({ container, requests }) => {
    absent(container, "[data-apply-return]");
    element(container, "[data-applied-confirmation]");
    assert.equal(element<HTMLInputElement>(container, "[data-effort-minutes]").value, "12");
    assert.equal(requests.length, 0);
  });
});

test("the job page asks in the same window; 'Yes' records Applied in one click and 'Not applying' is sent", async (t) => {
  clock(t);
  const pending = { openedEventId: "event-opened", openedAt: new Date(NOW - 30 * 60_000).toISOString() };
  const prompt = createElement(JobApplyReturnPrompt, { jobId: JOB, company: "Example Co", pending, declined: null });
  await mounted(prompt, () => json({ application: { id: "application-1", status: "APPLIED" } }), async ({ container, requests, refreshes }) => {
    const card = element(container, "[data-apply-return]");
    assert.equal(card.tagName, "DIALOG");
    assert.match(card.textContent ?? "", /Did you submit your application to Example Co\?/u);
    await click(element(card, "[data-apply-return-yes]"));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.deepEqual(requests.map((request) => [request.url, JSON.parse(String(request.init.body))]), [
      ["/api/applications", { jobPostingId: JOB, status: "APPLIED" }]
    ]);
    assert.equal(refreshes(), 1);
    absent(container, "[data-apply-return]");
    const recorded = element(container, "[data-applied-recorded]");
    assert.equal(element<HTMLAnchorElement>(recorded, "a").getAttribute("href"), "/applications?status=APPLIED");
  });
  await mounted(prompt, () => json({ application: { id: "application-1", status: "ARCHIVED" } }), async ({ container, requests, refreshes }) => {
    await click(element(container, "[data-apply-return-not-applying]"));
    assert.deepEqual(JSON.parse(String(requests[0]!.init.body)), { action: "NOT_APPLYING" });
    assert.equal(refreshes(), 1);
  });
  await mounted(prompt, () => json({}), async ({ container, requests }) => {
    await click(element(container, "[data-apply-return-not-yet]"));
    absent(container, "[data-apply-return]");
    assert.equal(requests.length, 0);
  });
  // Esc is "Not yet": nothing is recorded and the question comes back on the next visit.
  await mounted(prompt, () => json({}), async ({ container, requests, dom }) => {
    await act(async () => { element(container, "[data-apply-return]").dispatchEvent(new dom.window.Event("cancel", { cancelable: true })); });
    absent(container, "[data-apply-return]");
    assert.equal(requests.length, 0);
  });
  const declined = createElement(JobApplyReturnPrompt, {
    jobId: JOB,
    company: "Example Co",
    pending: null,
    declined: { eventId: "event-decline", answeredAt: new Date(NOW).toISOString(), previousStatus: "SAVED", previousPostingStatus: "ACTIVE" }
  });
  await mounted(declined, () => json({ application: { id: "application-1", status: "SAVED" } }), async ({ container, requests }) => {
    await click(element(container, "[data-apply-return-undo]"));
    assert.deepEqual(JSON.parse(String(requests[0]!.init.body)), { action: "UNDO_NOT_APPLYING" });
  });
});

test("on the job page, a refused one-click 'Yes' links to the Apply page's full confirmation", async (t) => {
  clock(t);
  const pending = { openedEventId: "event-opened", openedAt: new Date(NOW - 30 * 60_000).toISOString() };
  const prompt = createElement(JobApplyReturnPrompt, { jobId: JOB, company: "Example Co", pending, declined: null });
  const stale = () => json({ error: "Regenerate documents.", code: "APPLICATION_DOCUMENT_REVIEW_REQUIRED" }, 409);
  await mounted(prompt, stale, async ({ container }) => {
    await click(element(container, "[data-apply-return-yes]"));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.match(element(container, "[data-apply-return-error]").textContent ?? "", /needs your review/u);
    assert.equal(element<HTMLAnchorElement>(container, "[data-apply-return-choose]").getAttribute("href"), `/jobs/${JOB}/apply?didYouApply=yes`);
    absent(container, "[data-applied-recorded]");
  });
});

test("when the server says there is nothing to ask (applied on another device), coming back asks nothing", async (t) => {
  clock(t);
  await mounted(createElement(ApplyKit, { view: await kitView(), beforeAiRun: async () => true }), () => json({ opened: null }), async ({ container, requests, leave, comeBack }) => {
    await click(element(container, "[data-apply-link]"));
    assert.equal(requests.length, 1);
    await leave();
    await comeBack();
    absent(container, "[data-apply-return]");
  });
});

test("if the opened moment could not be saved, the user is told and is still asked on return", async (t) => {
  clock(t);
  await mounted(createElement(ApplyKit, { view: await kitView(), beforeAiRun: async () => true }), () => json({ error: "Too many requests." }, 429), async ({ container, leave, comeBack }) => {
    await click(element(container, "[data-apply-link]"));
    assert.match(element(container, "[data-kit-message]").textContent ?? "", /could not save that you opened/u);
    await leave();
    await comeBack();
    assert.ok(container.querySelector("[data-apply-return]"));
  });
});

test("while 'Not applying' is in effect its notice replaces the generic archived-job notice", async (t) => {
  clock(t);
  const view = await kitView((current) => ({
    ...current,
    job: { ...current.job, postingStatus: "ARCHIVED", notice: { tone: "info", text: "You archived this job. You can still apply if the posting is open." } },
    canRecordApplied: false,
    application: { id: "application-1", status: "ARCHIVED", statusLabel: "Archived", dateApplied: null },
    applyReturn: { pending: null, declined: { eventId: "event-decline", answeredAt: new Date(NOW).toISOString(), previousStatus: "SAVED", previousPostingStatus: "ACTIVE" } }
  }));
  await mounted(createElement(ApplyKit, { view, beforeAiRun: async () => true }), openedOk, async ({ container }) => {
    element(container, "[data-apply-return-declined]");
    absent(container, "[data-job-notice]", "the generic archived notice is hidden");
  });
});

test("the recorded link opens the Applications page filtered to applied jobs", async () => {
  const { parseApplicationFilters } = await import("@/lib/applications/list-view");
  assert.equal(parseApplicationFilters({ status: "APPLIED" }).status, "APPLIED");
});
