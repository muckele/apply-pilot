import assert from "node:assert/strict";
import test from "node:test";

import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";

import { ApplyKit } from "@/components/apply-kit/apply-kit";
import { loadApplyKitView, type ApplyKitView } from "@/lib/apply-kit/apply-kit-view";
import { JOB, OWNER, fakeDb, fixtures } from "@/tests/fixtures/apply-kit-db";

type Request = { url: string; init: RequestInit };
type Harness = {
  container: HTMLElement;
  requests: Request[];
  refreshes: () => number;
  copied: string[];
};

async function kitView(change?: (data: ReturnType<typeof fixtures>) => void, aiGenerationAvailable = true) {
  const data = fixtures();
  change?.(data);
  data.applicationAnswer.push(
    { id: "vault-auth", userId: OWNER, category: "WORK_AUTHORIZATION", question: "Are you legally authorized to work in the United States?", answer: "SECRET-AUTHORIZATION-ANSWER", sensitive: true, isActive: true },
    { id: "vault-why", userId: OWNER, category: "GENERAL", question: "Why do you want to work here?", answer: "I like reliable systems.", sensitive: false, isActive: true }
  );
  return (await loadApplyKitView(fakeDb(data).db, { userId: OWNER, jobId: JOB, aiGenerationAvailable }))!;
}

async function mounted(
  view: ApplyKitView,
  respond: (request: Request) => Response,
  run: (harness: Harness) => Promise<void>
) {
  const dom = new JSDOM("<html><body><div id='root'></div></body></html>", { url: `http://localhost/jobs/${JOB}/apply` });
  const requests: Request[] = [];
  const copied: string[] = [];
  let refreshCount = 0;
  const prior = new Map<string, PropertyDescriptor | undefined>();
  const navigatorStub = Object.create(dom.window.navigator, {
    clipboard: { value: { writeText: async (text: string) => { copied.push(text); } } }
  });
  const globals = {
    window: dom.window,
    self: dom.window,
    document: dom.window.document,
    navigator: navigatorStub,
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
  const router = { bfcacheId: "apply-kit", back: noop, forward: noop, push: noop, replace: noop, prefetch: noop, refresh: () => { refreshCount += 1; } };
  try {
    await act(async () => {
      root.render(createElement(AppRouterContext.Provider, { value: router }, createElement(ApplyKit, { view })));
    });
    await run({ container, requests, refreshes: () => refreshCount, copied });
  } finally {
    await act(async () => root.unmount());
    for (const [name, descriptor] of prior) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    dom.window.close();
  }
}

const ok = () => new Response(JSON.stringify({ application: { id: "application-1" } }), { headers: { "content-type": "application/json" } });

function element<T extends Element = HTMLElement>(container: HTMLElement, selector: string) {
  const found = container.querySelector<T>(selector);
  assert.ok(found, `missing ${selector}`);
  return found;
}

async function click(target: HTMLElement) {
  await act(async () => { target.click(); });
}

test("the application link opens the employer site in a new tab without referrer and shows its hostname", async () => {
  await mounted(await kitView(), ok, async ({ container }) => {
    const link = element<HTMLAnchorElement>(container, "[data-apply-link]");
    assert.equal(link.getAttribute("href"), "https://boards.greenhouse.io/exampleco/jobs/123");
    assert.equal(link.getAttribute("target"), "_blank");
    assert.equal(link.getAttribute("rel"), "noopener noreferrer");
    assert.equal(element(container, "[data-apply-host]").textContent, "boards.greenhouse.io");
    assert.match(container.textContent ?? "", /never clicks the employer's Submit/u);
  });
  const noLink = await kitView((data) => Object.assign(data.jobPosting[0]!, { applyUrl: null, sourceUrl: "" }));
  await mounted(noLink, ok, async ({ container }) => {
    assert.equal(container.querySelector("[data-apply-link]"), null);
    assert.ok(container.querySelector("[data-no-apply-link]"));
  });
});

test("saved answers copy to the clipboard; sensitive questions are 'answer this yourself' with no value or copy button", async () => {
  await mounted(await kitView(), ok, async ({ container, copied }) => {
    assert.equal((container.textContent ?? "").includes("SECRET-AUTHORIZATION-ANSWER"), false);
    const auth = element(container, "[data-common-question='work-authorization']");
    assert.equal(auth.dataset.answerStatus, "ANSWER_YOURSELF");
    assert.match(auth.textContent ?? "", /Answer this yourself/u);
    assert.equal(auth.querySelector("[data-copy-button]"), null);
    for (const id of ["sponsorship", "gender", "disability", "veteran", "criminal-history", "attestation"]) {
      assert.equal(element(container, `[data-common-question='${id}']`).querySelector("[data-copy-button]"), null, id);
    }
    const linkedin = element(container, "[data-common-question='linkedin']");
    await click(element(linkedin, "[data-copy-button]"));
    assert.deepEqual(copied, ["https://www.linkedin.com/in/owner"]);
    assert.match(linkedin.textContent ?? "", /Copied/u);
    await click(element(element(container, "[data-saved-answer='vault-why']"), "[data-copy-button]"));
    assert.deepEqual(copied.at(-1), "I like reliable systems.");
  });
});

test("downloads reuse the export route and are offered only for export-ready documents", async () => {
  const view = await kitView();
  await mounted(view, () => new Response("docx-bytes", { headers: { "content-disposition": 'attachment; filename="resume.docx"' } }), async ({ container, requests }) => {
    const resumeDocx = element<HTMLButtonElement>(container, "[data-download='resume-docx']");
    assert.equal(resumeDocx.disabled, false);
    assert.equal(element(container, "[data-kit-document='resume'] [data-document-status]").textContent, "AI-grounded");
    const url = globalThis.URL as unknown as Record<string, unknown>;
    const restore = { create: url.createObjectURL, revoke: url.revokeObjectURL };
    url.createObjectURL = () => "blob:fake";
    url.revokeObjectURL = () => {};
    try {
      await click(resumeDocx);
    } finally {
      url.createObjectURL = restore.create;
      url.revokeObjectURL = restore.revoke;
    }
    assert.equal(requests[0]!.url, "/api/documents/export");
    assert.deepEqual(JSON.parse(String(requests[0]!.init.body)), { resumeVersionId: "resume-v2", format: "docx" });
  });

  // The edited cover letter with an unconfirmed factual change cannot be downloaded and links to its review.
  const select = async (container: HTMLElement) => {
    const chooser = element<HTMLSelectElement>(container, "[data-kit-document='cover-letter'] select");
    await act(async () => {
      chooser.value = "cover-edited";
      chooser.dispatchEvent(new window.Event("change", { bubbles: true }));
    });
  };
  await mounted(view, ok, async ({ container, requests }) => {
    await select(container);
    assert.equal(element<HTMLButtonElement>(container, "[data-download='cover-letter-pdf']").disabled, true);
    assert.equal(element(container, "[data-kit-document='cover-letter'] [data-document-status]").textContent, "Needs review");
    const review = element(container, "[data-inline-review='cover-letter']");
    assert.equal(review.id, "review-cover-letter");
    const confirm = Array.from(review.querySelectorAll("button")).find((button) => button.textContent === "I confirm this is accurate");
    assert.ok(confirm, "the inline review offers the D031 confirmation");
    await click(confirm);
    assert.equal(requests.at(-1)!.url, "/api/generated-documents/cover-edited/review");
  });
});

test("'I applied' needs an explicit attestation and records the exact selected versions with their hashes", async () => {
  const view = await kitView();
  await mounted(view, ok, async ({ container, requests, refreshes }) => {
    await click(element(container, "[data-start-applied]"));
    const record = element<HTMLButtonElement>(container, "[data-confirm-applied]");
    assert.equal(record.disabled, true, "recording waits for the attestation");
    assert.match(element(container, "[data-confirm-resume]").textContent ?? "", /v2/u);
    assert.match(element(container, "[data-confirm-cover]").textContent ?? "", /v1/u);
    await click(element(container, "[data-attest]"));
    assert.equal(record.disabled, false);
    await click(record);
    assert.equal(requests.length, 1);
    assert.equal(requests[0]!.url, "/api/applications");
    const resume = view.resumes.find((document) => document.id === "resume-v2")!;
    const cover = view.coverLetters.find((document) => document.id === "cover-legacy")!;
    assert.deepEqual(JSON.parse(String(requests[0]!.init.body)), {
      jobPostingId: JOB,
      status: "APPLIED",
      resumeVersionId: "resume-v2",
      expectedResumeContentHash: resume.contentHash,
      coverLetterVersionId: "cover-legacy",
      expectedCoverLetterContentHash: cover.contentHash
    });
    assert.equal(refreshes(), 1);
    assert.match(element(container, "[data-kit-message]").textContent ?? "", /exactly which documents/u);
  });
});

// react-dom is imported before this file installs a DOM, so React watches text inputs through its
// legacy fallback (focus, then keyup) instead of the input event. JSDOM lacks the old IE hooks that
// fallback attaches, so they are stubbed; React's own change detection then fires onChange.
async function typeInto(input: HTMLInputElement, value: string) {
  Object.assign(input, { attachEvent: () => undefined, detachEvent: () => undefined });
  const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    input.dispatchEvent(new window.FocusEvent("focusin", { bubbles: true }));
    setValue.call(input, value);
    input.dispatchEvent(new window.KeyboardEvent("keyup", { bubbles: true }));
  });
}

test("'I applied' can carry the minutes it took: optional, whole minutes only, sent with the record", async () => {
  const view = await kitView();
  await mounted(view, ok, async ({ container, requests }) => {
    await click(element(container, "[data-start-applied]"));
    const minutes = element<HTMLInputElement>(container, "[data-effort-minutes]");
    assert.equal(minutes.value, "", "the box starts empty");
    assert.equal(minutes.required, false);
    assert.match(container.querySelector(`label[for="${minutes.id}"]`)?.textContent ?? "", /minutes.*optional/iu);
    assert.match(element(container, `#${minutes.getAttribute("aria-describedby")}`).textContent ?? "", /Insights/u);
    await click(element(container, "[data-attest]"));
    const record = element<HTMLButtonElement>(container, "[data-confirm-applied]");

    for (const bad of ["0", "12.5", "601"]) {
      await typeInto(minutes, bad);
      assert.equal(record.disabled, true, `${bad} blocks recording`);
      assert.match(element(container, "[data-effort-error]").textContent ?? "", /whole minutes from 1 to 600/u);
      assert.equal(minutes.getAttribute("aria-invalid"), "true");
    }
    await typeInto(minutes, "45");
    assert.equal(container.querySelector("[data-effort-error]"), null);
    assert.equal(record.disabled, false);
    await click(record);
    assert.equal(JSON.parse(String(requests[0]!.init.body)).effortMinutes, 45);
  });
});

test("a cover letter that needs review blocks recording until it is reviewed or left out", async () => {
  const view = await kitView((data) => { data.generatedDocument = data.generatedDocument.filter((row) => row.id !== "cover-legacy"); });
  await mounted(view, ok, async ({ container, requests }) => {
    await click(element(container, "[data-start-applied]"));
    await click(element(container, "[data-attest]"));
    assert.ok(container.querySelector("[data-applied-blocker]"));
    assert.equal(element<HTMLButtonElement>(container, "[data-confirm-applied]").disabled, true);
    await click(element(container, "[data-include-cover]"));
    assert.equal(container.querySelector("[data-applied-blocker]"), null);
    await click(element(container, "[data-confirm-applied]"));
    const body = JSON.parse(String(requests[0]!.init.body));
    assert.equal(body.coverLetterVersionId, null);
    assert.equal(Object.hasOwn(body, "expectedCoverLetterContentHash"), false);
  });
});

test("a 409 stale-evidence refusal explains what happened and links to the fix", async () => {
  const stale = () => new Response(JSON.stringify({
    error: "Regenerate documents from the current reviewed evidence before saving this packet.",
    code: "APPLICATION_DOCUMENT_EVIDENCE_STALE"
  }), { status: 409, headers: { "content-type": "application/json" } });
  await mounted(await kitView(), stale, async ({ container, refreshes }) => {
    await click(element(container, "[data-start-applied]"));
    await click(element(container, "[data-attest]"));
    await click(element(container, "[data-confirm-applied]"));
    const error = element(container, "[data-applied-error]");
    assert.match(error.textContent ?? "", /master résumé or reviewed evidence changed/u);
    assert.equal(element<HTMLAnchorElement>(error, "a").getAttribute("href"), "#documents");
    assert.equal(refreshes(), 1, "the kit reloads document states");
  });
});

test("without documents the kit offers generation, and explains when AI is unavailable", async () => {
  const empty = (data: ReturnType<typeof fixtures>) => { data.resumeVersion = []; data.generatedDocument = []; };
  await mounted(await kitView(empty, false), ok, async ({ container }) => {
    const generate = element<HTMLButtonElement>(container, "[data-generate='resume']");
    assert.equal(generate.disabled, true);
    assert.match(element(container, "[data-empty-document='resume'] [data-generation-reason]").textContent ?? "", /unavailable/u);
  });
  await mounted(await kitView(empty, true), () => new Response(JSON.stringify({ version: { id: "new" } }), { headers: { "content-type": "application/json" } }), async ({ container, requests, refreshes }) => {
    await click(element(container, "[data-generate='resume']"));
    assert.equal(requests[0]!.url, `/api/jobs/${JOB}/tailored-resume`);
    assert.equal(requests[0]!.init.method, "POST");
    assert.equal(refreshes(), 1);
  });
});

test("an application already recorded as applied shows what was sent instead of the button", async () => {
  const view = await kitView();
  const applied: ApplyKitView = {
    ...view,
    canRecordApplied: false,
    application: { id: "application-1", status: "APPLIED", statusLabel: "Applied", dateApplied: "2026-11-03T12:00:00.000Z" },
    sent: {
      eventId: "event-1",
      recordedAt: "2026-11-03T12:00:00.000Z",
      href: "/applications/application-1/sent/event-1",
      resume: { versionNumber: 2, title: "Resume two", readinessState: "EVIDENCE_CURRENT", shortHash: "abcdef012345" },
      coverLetter: null
    }
  };
  await mounted(applied, ok, async ({ container }) => {
    assert.equal(container.querySelector("[data-start-applied]"), null);
    const sent = element(container, "[data-sent-summary]");
    assert.match(sent.textContent ?? "", /résumé v2 \(abcdef012345…\), no cover letter/u);
    assert.equal(element<HTMLAnchorElement>(sent, "a").getAttribute("href"), "/applications/application-1/sent/event-1");
  });
});
