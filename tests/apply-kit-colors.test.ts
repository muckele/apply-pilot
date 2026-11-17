import "@/tests/fixtures/dom-globals";
import assert from "node:assert/strict";
import test from "node:test";
import React from "react";

import { ApplyKit } from "@/components/apply-kit/apply-kit";
import { loadApplyKitView, type ApplyKitDocument, type ApplyKitView } from "@/lib/apply-kit/apply-kit-view";
import { JOB, OWNER, fakeDb, fixtures } from "@/tests/fixtures/apply-kit-db";
import { createDomHarness, type DomHarness } from "@/tests/fixtures/dom-harness";

// "Apply on my own" sits on the dark Apply page. Light-theme colors (slate text, white or amber
// boxes, the near-black brand green) were nearly invisible there or clashed with it, so the kit
// uses the page's own styles. The Copy button is the light chip shared with step 5, readable on both.
// Also matches variant-prefixed classes such as `hover:bg-slate-50` and `[&_button]:bg-white`.
const LIGHT_THEME_COLOR = /(?:^|\s)(?:\S+:)?(?:text|bg|border|divide)-(?:slate-\d+|white|black|amber-\d+|emerald-\d+|brand-\d+)(?=\s|$)/;

function lightThemeColored(container: HTMLElement) {
  return Array.from(container.querySelectorAll<HTMLElement>("*"))
    .filter((element) => !element.closest("[data-copy-button]") && LIGHT_THEME_COLOR.test(element.getAttribute("class") ?? ""))
    .map((element) => `${element.tagName.toLowerCase()} ${element.getAttribute("class")}`);
}

async function kitView(change?: (data: ReturnType<typeof fixtures>) => void) {
  const data = fixtures();
  change?.(data);
  data.applicationAnswer.push(
    { id: "vault-private", userId: OWNER, category: "GENERAL", question: "Anything else we should know?", answer: "Synthetic sensitive answer", sensitive: true, isActive: true },
    { id: "vault-why", userId: OWNER, category: "GENERAL", question: "Why do you want to work here?", answer: "I like reliable systems.", sensitive: false, isActive: true }
  );
  return (await loadApplyKitView(fakeDb(data).db, { userId: OWNER, jobId: JOB, aiGenerationAvailable: true }))!;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function withKit(view: ApplyKitView, respond: () => Response, run: (ui: DomHarness) => Promise<void>) {
  const ui = createDomHarness({ url: `http://localhost/jobs/${JOB}/apply`, fetch: (async () => respond()) as typeof fetch });
  try {
    await ui.render(React.createElement(ApplyKit, { view }));
    await run(ui);
  } finally {
    await ui.close();
  }
}

async function choose(ui: DomHarness, slot: "resume" | "cover-letter", id: string) {
  await ui.type(ui.container.querySelector(`[data-kit-document='${slot}'] select`), id);
}

const present = (ui: DomHarness, selector: string) => assert.equal(ui.container.querySelector(selector) === null, false, `missing ${selector}`);

test("documents, answers and the open-application step use the Apply page's own colors", async () => {
  const view = await kitView();
  const withWarnings: ApplyKitView = {
    ...view,
    job: { ...view.job, notice: { tone: "warning", text: "This posting may be closed." } },
    applyLink: view.applyLink ? { ...view.applyLink, secure: false } : null
  };
  await withKit(withWarnings, () => json({}), async (ui) => {
    present(ui, "[data-job-notice]");
    present(ui, "[data-common-question='work-authorization']");
    present(ui, "[data-saved-answer='vault-why']");
    present(ui, "[data-answer-yourself]");
    present(ui, "[data-apply-link]");
    assert.deepEqual(lightThemeColored(ui.container), []);

    // A stale résumé offers a new version; an edited cover letter opens its review in place.
    await choose(ui, "resume", "resume-v1");
    present(ui, "[data-kit-document='resume'] [data-generate='resume']");
    await choose(ui, "cover-letter", "cover-edited");
    present(ui, "[data-inline-review='cover-letter']");
    assert.deepEqual(lightThemeColored(ui.container), []);
  });

  const info: ApplyKitView = { ...view, job: { ...view.job, notice: { tone: "info", text: "Synthetic notice." } }, applyLink: null };
  await withKit(info, () => json({}), async (ui) => {
    present(ui, "[data-job-notice]");
    present(ui, "[data-no-apply-link]");
    assert.deepEqual(lightThemeColored(ui.container), []);
  });
});

test("a document that needs a whole-document review, or a fresh save, uses the page's colors", async () => {
  const view = await kitView();
  const needs = (document: ApplyKitDocument, readinessState: ApplyKitDocument["readinessState"]): ApplyKitDocument =>
    ({ ...document, exportReady: false, readinessState, review: { ...document.review, state: readinessState } });
  const legacy: ApplyKitView = {
    ...view,
    resumes: view.resumes.map((document) => (document.id === view.selectedResumeId ? needs(document, "REVIEW_OUTDATED") : document)),
    coverLetters: view.coverLetters.map((document) => (document.id === "cover-legacy" ? needs(document, "LEGACY_REVIEW_REQUIRED") : document))
  };
  await withKit(legacy, () => json({}), async (ui) => {
    present(ui, "[data-kit-document-text]");
    present(ui, "#review-resume");
    assert.deepEqual(lightThemeColored(ui.container), []);
  });
});

test("without documents, the generate prompts use the page's colors", async () => {
  const empty = await kitView((data) => { data.resumeVersion = []; data.generatedDocument = []; });
  const unavailable: ApplyKitView = { ...empty, generation: { available: false, reason: "AI generation is unavailable right now.", hasMasterResume: false } };
  await withKit(unavailable, () => json({}), async (ui) => {
    present(ui, "[data-empty-document='resume'] [data-generation-reason]");
    assert.deepEqual(lightThemeColored(ui.container), []);
  });
});

test("'Did you apply?' and the 'Not applying' notice use the page's colors", async () => {
  const view = await kitView();
  const pending: ApplyKitView = {
    ...view,
    application: { id: "application-1", status: "SAVED", statusLabel: "Saved", dateApplied: null },
    applyReturn: { pending: { openedEventId: "event-opened", openedAt: "2026-11-06T18:00:00.000Z" }, declined: null }
  };
  await withKit(pending, () => json({ error: "Synthetic refusal." }, 500), async (ui) => {
    present(ui, "[data-apply-return]");
    await ui.click(ui.container.querySelector("[data-apply-return-not-applying]"));
    present(ui, "[data-apply-return-error]");
    assert.deepEqual(lightThemeColored(ui.container), []);
  });

  const declined: ApplyKitView = {
    ...view,
    applyReturn: { pending: null, declined: { eventId: "event-decline", answeredAt: "2026-11-06T18:00:00.000Z", previousStatus: "SAVED", previousPostingStatus: "ACTIVE" } }
  };
  await withKit(declined, () => json({}), async (ui) => {
    present(ui, "[data-apply-return-declined]");
    assert.deepEqual(lightThemeColored(ui.container), []);
  });
});

test("recording 'I applied', its problems and its confirmation use the page's colors", async () => {
  const view = await kitView();
  const stale = () => json({ error: "Synthetic stale refusal.", code: "APPLICATION_DOCUMENT_EVIDENCE_STALE" }, 409);
  await withKit(view, stale, async (ui) => {
    await ui.click(ui.container.querySelector("[data-start-applied]"));
    present(ui, "[data-applied-confirmation]");
    await choose(ui, "cover-letter", "cover-edited");
    present(ui, "[data-applied-blocker]");
    await ui.type(ui.container.querySelector("[data-effort-minutes]"), "0");
    present(ui, "[data-effort-error]");
    assert.deepEqual(lightThemeColored(ui.container), []);

    await choose(ui, "cover-letter", "cover-legacy");
    await ui.type(ui.container.querySelector("[data-effort-minutes]"), "");
    await ui.click(ui.container.querySelector("[data-attest]"));
    await ui.click(ui.container.querySelector("[data-confirm-applied]"));
    await ui.waitForText(/reviewed evidence changed/u);
    present(ui, "[data-applied-error]");
    assert.deepEqual(lightThemeColored(ui.container), []);
  });

  await withKit(view, () => json({ application: { id: "application-1" } }), async (ui) => {
    await ui.click(ui.container.querySelector("[data-start-applied]"));
    await ui.click(ui.container.querySelector("[data-attest]"));
    await ui.click(ui.container.querySelector("[data-confirm-applied]"));
    await ui.waitForText(/Recorded as applied/u);
    present(ui, "[data-kit-message]");
    assert.deepEqual(lightThemeColored(ui.container), []);
  });

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
  await withKit(applied, () => json({}), async (ui) => {
    present(ui, "[data-sent-summary]");
    assert.deepEqual(lightThemeColored(ui.container), []);
  });
});
