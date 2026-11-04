import assert from "node:assert/strict";
import test from "node:test";

import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";

import { JobDocumentWorkspace, type JobCoverLetterOption } from "@/components/job-document-workspace";
import type { DocumentReviewView } from "@/lib/documents/document-review";

const HASH = "b".repeat(64);
const FLAG = "flag:0123456789abcdef01234567";
const content = "Dear Example Co Hiring Team,\nI led a team of 12 engineers at Example Co.\nSincerely,\nSynthetic Applicant";

function view(overrides: Partial<DocumentReviewView>): DocumentReviewView {
  return {
    state: "EDITED_NEEDS_REVIEW",
    exportReady: false,
    contentHash: HASH,
    segments: [
      { lineIndex: 0, text: "Dear Example Co Hiring Team,", origin: "GENERATED", citations: [] },
      { lineIndex: 1, text: "I led a team of 12 engineers at Example Co.", origin: "USER_EDIT", citations: [] },
      { lineIndex: 2, text: "Sincerely,", origin: "GENERATED", citations: [] },
      { lineIndex: 3, text: "Synthetic Applicant", origin: "GENERATED", citations: [{ ref: "resume.rawText", excerpt: "Synthetic Applicant" }] }
    ],
    flags: [{ id: FLAG, lineIndex: 1, text: "I led a team of 12 engineers at Example Co.", claims: [{ text: "12", token: "12", kind: "NUMBER" }], confirmedAt: null }],
    legacyConfirmedAt: null,
    ...overrides
  };
}

function cover(review: DocumentReviewView, text = content): JobCoverLetterOption {
  return { id: "cover-1", title: "Cover letter", content: text, evidenceCurrent: review.exportReady, createdAt: "2026-11-03T00:00:00.000Z", review };
}

async function mounted(option: JobCoverLetterOption, run: (h: { container: HTMLElement; requests: Array<{ url: string; init: RequestInit }>; refreshes: () => number }) => Promise<void>) {
  const dom = new JSDOM("<html><body><div id='root'></div></body></html>", { url: "http://localhost/jobs/job-1" });
  const requests: Array<{ url: string; init: RequestInit }> = [];
  let refreshCount = 0;
  const prior = new Map<string, PropertyDescriptor | undefined>();
  const globals = {
    window: dom.window,
    self: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    Event: dom.window.Event,
    IS_REACT_ACT_ENVIRONMENT: true,
    // Focus/scroll after switching documents is cosmetic and JSDOM has no scrollIntoView.
    requestAnimationFrame: () => 0,
    fetch: async (url: string, init: RequestInit) => {
      requests.push({ url, init });
      return new Response(JSON.stringify({ review: { contentHash: HASH, pendingFlagCount: 0, confirmedAt: "2026-11-03T12:00:00.000Z" } }), {
        headers: { "content-type": "application/json" }
      });
    }
  };
  for (const [name, value] of Object.entries(globals)) {
    prior.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  const container = dom.window.document.getElementById("root")!;
  const root = createRoot(container);
  const noop = () => {};
  const router = { bfcacheId: "document-review", back: noop, forward: noop, push: noop, replace: noop, prefetch: noop, refresh: () => { refreshCount += 1; } };
  try {
    await act(async () => {
      root.render(createElement(AppRouterContext.Provider, { value: router },
        createElement(JobDocumentWorkspace, { resumeVersions: [], coverLetters: [option] })));
    });
    await act(async () => {
      Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Review cover letter")!.click();
    });
    await run({ container, requests, refreshes: () => refreshCount });
  } finally {
    await act(async () => root.unmount());
    for (const [name, descriptor] of prior) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    dom.window.close();
  }
}

function buttons(container: HTMLElement, label: string) {
  return Array.from(container.querySelectorAll("button")).filter((button) => button.textContent === label);
}

test("the editor marks the user's own lines with a subtle marker that never reaches the page layout", async () => mounted(cover(view({})), async ({ container }) => {
  const markers = Array.from(container.querySelectorAll("[data-reading-content] [data-edit-marker]"));
  assert.equal(markers.length, 1);
  assert.equal(markers[0]!.textContent, "your edit");
  assert.match(markers[0]!.parentElement!.textContent ?? "", /team of 12 engineers/u);
  assert.equal(container.querySelector("[data-reading-content] p[data-line-origin='GENERATED']")?.querySelector("[data-edit-marker]"), null);
  assert.doesNotMatch(container.querySelector(".product-document-layout")?.textContent ?? "", /your edit/u);
}));

test("a flagged factual edit blocks export until the owner confirms it is accurate", async () => mounted(cover(view({})), async ({ container, requests, refreshes }) => {
  for (const label of ["Download PDF", "Download DOCX", "Preview actual PDF"]) assert.equal(buttons(container, label)[0]?.disabled, true, label);
  const flag = container.querySelector(`[data-review-flag="${FLAG}"]`);
  assert.ok(flag);
  assert.match(flag.textContent ?? "", /12/u);
  const confirm = buttons(container, "I confirm this is accurate");
  assert.equal(confirm.length, 1);
  await act(async () => confirm[0]!.click());
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.url, "/api/generated-documents/cover-1/review");
  assert.equal(requests[0]!.init.method, "POST");
  assert.deepEqual(JSON.parse(String(requests[0]!.init.body)), { action: "CONFIRM_FLAG", flagId: FLAG, contentHash: HASH });
  assert.equal(refreshes(), 1);
}));

test("a confirmed edited document can export and shows when each flag was confirmed", async () => mounted(cover(view({
  state: "EDITED_READY",
  exportReady: true,
  flags: [{ id: FLAG, lineIndex: 1, text: "I led a team of 12 engineers at Example Co.", claims: [{ text: "12", token: "12", kind: "NUMBER" }], confirmedAt: "2026-11-03T12:00:00.000Z" }]
})), async ({ container }) => {
  assert.equal(buttons(container, "Download PDF")[0]?.disabled, false);
  assert.equal(buttons(container, "I confirm this is accurate").length, 0);
  assert.match(container.querySelector(`[data-review-flag="${FLAG}"]`)?.textContent ?? "", /Confirmed Nov 3, 2026/u);
  assert.equal(container.querySelectorAll("[data-reading-content] [data-edit-marker]").length, 1);
}));

test("a legacy document is confirmed as a whole in one review step", async () => mounted(cover(view({
  state: "LEGACY_REVIEW_REQUIRED",
  exportReady: false,
  segments: [{ lineIndex: 0, text: "Legacy letter.", origin: "LEGACY", citations: [] }],
  flags: []
}), "Legacy letter."), async ({ container, requests }) => {
  assert.match(container.textContent ?? "", /created before fact citations/u);
  assert.equal(buttons(container, "Download PDF")[0]?.disabled, true);
  await act(async () => buttons(container, "I confirm this is accurate")[0]!.click());
  assert.equal(requests[0]!.url, "/api/generated-documents/cover-1/review");
  assert.deepEqual(JSON.parse(String(requests[0]!.init.body)), { action: "CONFIRM_LEGACY_DOCUMENT", contentHash: HASH });
}));
