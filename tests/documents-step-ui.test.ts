import "@/tests/fixtures/dom-globals";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";

import { DocumentsStep, type DocumentsStepProps } from "@/components/apply-page/documents-step";
import { loadApplyKitView, type ApplyKitDocument } from "@/lib/apply-kit/apply-kit-view";
import type { DocumentCreationQuote } from "@/lib/jobs/document-creation-plan";
import { JOB, OWNER, fakeDb, fixtures } from "@/tests/fixtures/apply-kit-db";
import { createDomHarness } from "@/tests/fixtures/dom-harness";

// Synthetic job and documents only. The Apply Kit fixture gives: resume-v2 AI_GROUNDED, resume-v1
// NEEDS_REGENERATION, cover-edited NEEDS_REVIEW (newest letter) and cover-legacy LEGACY_CONFIRMED.

const quote: DocumentCreationQuote = {
  provider: "gemini", model: "gemini-3.8-flash", promptVersion: "12", jobMatchMicros: 72_720, resumeMicros: 64_500, coverMicros: 47_250
};
const BOTH = "Write my résumé and cover letter · up to 12¢";
const RESUME_ONLY = "Write my résumé · up to 7¢";
const COVER_ONLY = "Write my cover letter · up to 5¢";
const BELOW_A = "Assisted Fill needs an A. You can still apply on your own with these documents.";
const question = (cents: string) => `Sends your résumé facts and the lines you added to Google Gemini. Most it can cost: ${cents}.`;

async function kitDocuments() {
  const kit = (await loadApplyKitView(fakeDb(fixtures()).db, { userId: OWNER, jobId: JOB, aiGenerationAvailable: true }))!;
  const byId = (id: string) => [...kit.resumes, ...kit.coverLetters].find((document) => document.id === id)!;
  return { kit, byId };
}

function newerVersion(document: ApplyKitDocument, id: string, versionNumber: number): ApplyKitDocument {
  return { ...document, id, versionNumber, title: `${document.title} (v${versionNumber})`, createdAt: `2026-11-0${versionNumber}T09:00:00.000Z` };
}

function props(overrides: Partial<DocumentsStepProps> = {}): DocumentsStepProps {
  return {
    jobId: "job-1",
    applicationId: "application-1",
    quote,
    generationAvailable: true,
    coverByDefault: true,
    resumes: [],
    coverLetters: [],
    attached: { resumeId: null, coverId: null },
    letter: "A",
    ...overrides
  };
}

type Call = { url: string; method: string; confirmed: string | null; body: unknown };

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

// The real writers answer an unconfirmed request with 428 and their maximum; nothing runs until
// the request comes back with x-ai-cost-confirmed.
function apiStub(calls: Call[], options: { failResume?: boolean; failCover?: boolean; failAttach?: boolean } = {}) {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const call = { url, method, confirmed: new Headers(init?.headers).get("x-ai-cost-confirmed"), body: init?.body ? JSON.parse(String(init.body)) : null };
    calls.push(call);
    if (url === "/api/applications" && method === "POST") return json(201, { application: { id: "application-new" } });
    if (url.startsWith("/api/applications/")) {
      return options.failAttach ? json(500, { error: "The database is unavailable." }) : json(200, { application: {} });
    }
    const kind = url.split("/").at(-1);
    if (!call.confirmed) {
      return json(428, { code: "AI_COST_CONFIRMATION_REQUIRED", maximumCostMicros: kind === "cover-letter" ? 47_250 : 64_500, dataType: "application_packet" });
    }
    if (kind === "tailored-resume" && options.failResume) return json(503, { error: "Gemini is busy.", billingStatus: "not_charged" });
    if (kind === "cover-letter" && options.failCover) return json(503, { error: "Gemini is busy.", billingStatus: "not_charged" });
    return json(200, { ok: true });
  }) as typeof fetch;
}

function setup(options: { fetch?: typeof fetch; failResume?: boolean; failCover?: boolean; failAttach?: boolean } = {}) {
  const calls: Call[] = [];
  const windowConfirms: string[] = [];
  const harness = createDomHarness({
    fetch: options.fetch ?? apiStub(calls, options),
    confirm: (message) => { windowConfirms.push(message); return true; }
  });
  return { harness, calls, windowConfirms };
}

type Harness = ReturnType<typeof createDomHarness>;

async function waitUntil(check: () => boolean, what: string) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (check()) return;
    await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 0)); });
  }
  throw new Error(`Timed out waiting for ${what}`);
}

// Lets mount effects and any request they start run to the end.
async function settle() {
  for (let tick = 0; tick < 10; tick += 1) await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 0)); });
}

function askedQuestion(harness: Harness) {
  return harness.container.querySelector('[role="group"] .job-card-copy')?.textContent ?? null;
}

function coverTick(harness: Harness) {
  const label = [...harness.container.querySelectorAll("label")].find((node) => node.textContent === "Include a cover letter");
  assert.ok(label, "the cover-letter tick");
  return label.querySelector("input")!;
}

function row(harness: Harness, id: string) {
  const found = harness.container.querySelector(`[data-version="${id}"]`);
  assert.ok(found, `version ${id}`);
  return found;
}

test("Write documents sends no save or match request", async () => {
  const { harness, calls, windowConfirms } = setup();
  try {
    await harness.render(React.createElement(DocumentsStep, props()));
    await harness.click(harness.button(BOTH));
    await harness.waitForText(/Most it can cost/u);
    assert.equal(askedQuestion(harness), question("12¢"));
    assert.equal(calls.length, 0, "nothing is sent before Confirm");
    await harness.click(harness.button("Confirm"));
    await harness.waitForText(/Your résumé and cover letter are ready to review below\./u);
    assert.deepEqual(calls.map((call) => [call.method, call.url, call.confirmed]), [
      ["POST", "/api/jobs/job-1/tailored-resume", null],
      ["POST", "/api/jobs/job-1/tailored-resume", "true"],
      ["POST", "/api/jobs/job-1/cover-letter", null],
      ["POST", "/api/jobs/job-1/cover-letter", "true"]
    ]);
    assert.equal(calls.some((call) => /evidence-snapshots|\/match$/u.test(call.url)), false);
    assert.deepEqual(windowConfirms, []);
    assert.ok(harness.refreshes >= 1);
  } finally {
    await harness.close();
  }
});

test("the new résumé is attached with a PATCH that has no status", async () => {
  const { byId } = await kitDocuments();
  const stale = byId("resume-v1");
  const { harness, calls } = setup();
  try {
    const before = props({ coverByDefault: false, resumes: [stale], attached: { resumeId: "resume-v1", coverId: null } });
    await harness.render(React.createElement(DocumentsStep, before));
    await settle();
    assert.equal(calls.length, 0, "nothing ready to attach yet");
    await harness.click(harness.button(RESUME_ONLY));
    await harness.waitForText(/Most it can cost/u);
    await harness.click(harness.button("Confirm"));
    await harness.waitForText(/Your résumé is ready to review below\./u);
    const refreshesAfterWriting = harness.refreshes;
    // What router.refresh() delivers: the new version, ready to use.
    const written = newerVersion(byId("resume-v2"), "resume-v3", 3);
    await harness.render(React.createElement(DocumentsStep, { ...before, resumes: [written, stale] }));
    await waitUntil(() => calls.some((call) => call.method === "PATCH"), "the attach request");
    const patch = calls.find((call) => call.method === "PATCH")!;
    assert.equal(patch.url, "/api/applications/application-1");
    assert.deepEqual(patch.body, { resumeVersionId: "resume-v3" });
    assert.equal(Object.hasOwn(patch.body as object, "status"), false);
    assert.equal(calls.some((call) => call.url === "/api/applications"), false, "an existing application is never saved again");
    await waitUntil(() => harness.refreshes > refreshesAfterWriting, "a refresh after attaching");
  } finally {
    await harness.close();
  }
});

test("rewriting with a ready version attached attaches the new version, and only that kind", async () => {
  const { byId } = await kitDocuments();
  const { harness, calls } = setup();
  try {
    // A ready résumé and a ready letter attached; another ready letter exists that isn't attached.
    const before = props({
      coverByDefault: false, resumes: [byId("resume-v2")], coverLetters: [byId("cover-legacy")], attached: { resumeId: "resume-v2", coverId: null }
    });
    await harness.render(React.createElement(DocumentsStep, { ...before, attached: { resumeId: "resume-v2", coverId: "cover-legacy" } }));
    await settle();
    assert.equal(calls.length, 0, "ready versions are attached");
    await harness.click(harness.button(RESUME_ONLY));
    await harness.waitForText(/Most it can cost/u);
    await harness.click(harness.button("Confirm"));
    await harness.waitForText(/Your résumé is ready to review below\./u);
    // The refresh brings the new résumé. The letter's attachment is left alone, even though
    // chooseAutoAttach would pick cover-legacy for an empty letter slot.
    await harness.render(React.createElement(DocumentsStep, { ...before, resumes: [newerVersion(byId("resume-v2"), "resume-v3", 3), byId("resume-v2")] }));
    await waitUntil(() => calls.some((call) => call.method === "PATCH"), "the attach request");
    await settle();
    assert.deepEqual(calls.filter((call) => call.method === "PATCH").map((call) => [call.url, call.body]), [
      ["/api/applications/application-1", { resumeVersionId: "resume-v3" }]
    ]);
  } finally {
    await harness.close();
  }
});

test("on mount, an attached version waiting for its review is not swapped for an older ready one", async () => {
  const { byId } = await kitDocuments();
  const { harness, calls } = setup();
  try {
    // cover-edited (newest, NEEDS_REVIEW) is attached; cover-legacy is older and ready.
    await harness.render(React.createElement(DocumentsStep, props({
      resumes: [byId("resume-v2")], coverLetters: [byId("cover-edited"), byId("cover-legacy")],
      attached: { resumeId: "resume-v2", coverId: "cover-edited" }
    })));
    await settle();
    assert.deepEqual(calls, []);
  } finally {
    await harness.close();
  }
});

test("a step blocked while the question is open sends nothing on Confirm", async () => {
  const { harness, calls } = setup();
  try {
    const open = props();
    await harness.render(React.createElement(DocumentsStep, open));
    await harness.click(harness.button(BOTH));
    await harness.waitForText(/Most it can cost/u);
    const reason = "Update your score in step 2 first, so your documents include your new lines.";
    await harness.render(React.createElement(DocumentsStep, { ...open, blockedReason: reason }));
    await harness.click(harness.button("Confirm"));
    await settle();
    assert.deepEqual(calls, []);
    assert.match(harness.container.querySelector("[data-documents-message]")?.textContent ?? "", /Update your score in step 2 first.*Nothing was sent/u);
  } finally {
    await harness.close();
  }
});

test("Use this version during another attach says to wait instead of doing nothing", async () => {
  const { byId } = await kitDocuments();
  const calls: Call[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const stub = apiStub(calls);
  let started = 0;
  const { harness } = setup({ fetch: (async (input: RequestInfo | URL, init?: RequestInit) => { started += 1; await gate; return stub(input, init); }) as typeof fetch });
  try {
    await harness.render(React.createElement(DocumentsStep, props({
      resumes: [newerVersion(byId("resume-v2"), "resume-v3", 3), byId("resume-v2")], attached: { resumeId: "resume-v2", coverId: null },
      coverLetters: [byId("cover-legacy")]
    })));
    // Mount is attaching the letter (held at the gate); a click now is told to wait.
    await waitUntil(() => started === 1, "the mount attach");
    await harness.click(row(harness, "resume-v3").querySelector("button"));
    assert.match(harness.container.querySelector("[data-attach-message]")?.textContent ?? "", /Still attaching/u);
    release();
    await waitUntil(() => harness.refreshes === 1, "the mount attach to finish");
    assert.equal(calls.length, 1, "the click wasn't queued");
    assert.equal(harness.container.querySelector("[data-attach-message]"), null);
  } finally {
    await harness.close();
  }
});

test("Cancel sends nothing", async () => {
  const { byId } = await kitDocuments();
  const { harness, calls } = setup();
  try {
    await harness.render(React.createElement(DocumentsStep, props({ resumes: [byId("resume-v2")], attached: { resumeId: "resume-v2", coverId: null } })));
    await settle();
    for (const [name, cents] of [[BOTH, "12¢"], [COVER_ONLY, "5¢"]] as const) {
      await harness.click(harness.button(name));
      await harness.waitForText(/Most it can cost/u);
      assert.equal(askedQuestion(harness), question(cents));
      await harness.click(harness.button("Cancel"));
      await harness.waitForText(/Canceled\. Nothing was sent and nothing was charged\./u);
    }
    assert.equal(calls.length, 0);
    assert.equal(harness.refreshes, 0);
  } finally {
    await harness.close();
  }
});

test("below an A the step says Fill needs an A", async () => {
  const { harness } = setup();
  try {
    for (const letter of ["B", "C", "D"] as const) {
      await harness.render(React.createElement(DocumentsStep, props({ letter })));
      assert.equal(harness.container.querySelector("[data-below-a]")?.textContent, BELOW_A, letter);
    }
    await harness.render(React.createElement(DocumentsStep, props({ letter: "A" })));
    assert.equal(harness.text().includes(BELOW_A), false);
    await harness.render(React.createElement(DocumentsStep, props({ letter: null })));
    assert.equal(harness.text().includes(BELOW_A), false, "no grade yet is not below an A");
  } finally {
    await harness.close();
  }
});

test("once on mount, a job with no application is saved and its newest ready versions are attached", async () => {
  const { kit } = await kitDocuments();
  const { harness, calls } = setup();
  try {
    const mounted = props({ applicationId: null, resumes: kit.resumes, coverLetters: kit.coverLetters });
    await harness.render(React.createElement(DocumentsStep, mounted));
    await waitUntil(() => calls.length === 2 && harness.refreshes === 1, "save, attach and refresh");
    assert.deepEqual(calls.map((call) => [call.method, call.url, call.body]), [
      ["POST", "/api/applications", { jobPostingId: "job-1", status: "SAVED" }],
      ["PATCH", "/api/applications/application-new", { resumeVersionId: "resume-v2", coverLetterVersionId: "cover-legacy" }]
    ]);
    await harness.render(React.createElement(DocumentsStep, mounted));
    await settle();
    assert.equal(calls.length, 2, "only once");
  } finally {
    await harness.close();
  }
});

test("an existing application is only patched, and a version that needs review is never attached", async () => {
  const { byId } = await kitDocuments();
  const { harness, calls } = setup();
  try {
    await harness.render(React.createElement(DocumentsStep, props({
      resumes: [byId("resume-v2"), byId("resume-v1")], coverLetters: [byId("cover-edited")]
    })));
    await waitUntil(() => calls.length >= 1, "the attach request");
    await settle();
    assert.deepEqual(calls.map((call) => [call.method, call.url, call.body]), [
      ["PATCH", "/api/applications/application-1", { resumeVersionId: "resume-v2" }]
    ]);
  } finally {
    await harness.close();
  }
});

test("versions: the attached one is Used for this application, other ready ones offer Use this version, the rest fold away", async () => {
  const { byId } = await kitDocuments();
  const { harness, calls } = setup();
  try {
    await harness.render(React.createElement(DocumentsStep, props({
      resumes: [newerVersion(byId("resume-v2"), "resume-v3", 3), byId("resume-v2"), byId("resume-v1")],
      coverLetters: [byId("cover-edited"), byId("cover-legacy")],
      attached: { resumeId: "resume-v2", coverId: "cover-legacy" }
    })));
    await settle();
    assert.equal(calls.length, 0, "ready attached versions are kept");
    assert.match(row(harness, "resume-v2").textContent ?? "", /Used for this application/u);
    assert.equal(row(harness, "resume-v2").querySelector("button"), null);
    assert.equal(row(harness, "resume-v3").querySelector("button")?.textContent, "Use this version");
    assert.equal(row(harness, "resume-v1").closest("details")?.querySelector("summary")?.textContent, "Older versions (1)");
    assert.equal(row(harness, "resume-v1").querySelector("button"), null, "an out-of-date version can't be used");
    assert.match(row(harness, "cover-legacy").textContent ?? "", /Used for this application/u);
    assert.equal(row(harness, "cover-edited").querySelector("button"), null, "a version that needs review can't be used");
    assert.equal(row(harness, "cover-edited").closest("details"), null, "the newest version stays in view");
    await harness.click(row(harness, "resume-v3").querySelector("button"));
    await waitUntil(() => calls.length === 1, "the attach request");
    assert.deepEqual([calls[0]!.method, calls[0]!.url, calls[0]!.body], ["PATCH", "/api/applications/application-1", { resumeVersionId: "resume-v3" }]);
    await waitUntil(() => harness.refreshes === 1, "a refresh after attaching");
  } finally {
    await harness.close();
  }
});

test("a version that becomes ready when its review is confirmed is attached", async () => {
  const { byId } = await kitDocuments();
  const { harness, calls } = setup();
  try {
    const before = props({ resumes: [byId("resume-v2")], coverLetters: [byId("cover-edited")], attached: { resumeId: "resume-v2", coverId: null } });
    await harness.render(React.createElement(DocumentsStep, before));
    await settle();
    assert.equal(calls.length, 0);
    // What the refresh after "I confirm this is accurate" delivers.
    const confirmed: ApplyKitDocument = { ...byId("cover-edited"), status: "EDITED_CONFIRMED", exportReady: true };
    await harness.render(React.createElement(DocumentsStep, { ...before, coverLetters: [confirmed] }));
    await waitUntil(() => calls.length === 1, "the attach request");
    assert.deepEqual([calls[0]!.method, calls[0]!.body], ["PATCH", { coverLetterVersionId: "cover-edited" }]);
  } finally {
    await harness.close();
  }
});

test("an attach that fails says so in the step and doesn't throw", async () => {
  const { byId } = await kitDocuments();
  const { harness } = setup({ failAttach: true });
  try {
    await harness.render(React.createElement(DocumentsStep, props({ resumes: [byId("resume-v2")] })));
    await harness.waitForText(/The database is unavailable\./u);
    assert.match(harness.container.querySelector("[data-attach-message]")?.textContent ?? "", /couldn't attach/u);
    assert.equal(harness.refreshes, 0);
  } finally {
    await harness.close();
  }
});

test("once the application is past applying, its documents are left as they are", async () => {
  const { byId } = await kitDocuments();
  const { harness, calls } = setup();
  try {
    await harness.render(React.createElement(DocumentsStep, props({
      attachable: false, resumes: [byId("resume-v2")], coverLetters: [byId("cover-legacy")]
    })));
    await settle();
    assert.equal(calls.length, 0);
    assert.equal(harness.maybeButton("Use this version"), undefined);
  } finally {
    await harness.close();
  }
});

test("unticking the cover letter drops it from the button, the question and the requests", async () => {
  const { harness, calls } = setup();
  try {
    await harness.render(React.createElement(DocumentsStep, props()));
    assert.equal(coverTick(harness).checked, true);
    await harness.check(coverTick(harness), false);
    await harness.click(harness.button(RESUME_ONLY));
    await harness.waitForText(/Most it can cost/u);
    assert.equal(askedQuestion(harness), question("7¢"));
    await harness.click(harness.button("Confirm"));
    await harness.waitForText(/Your résumé is ready to review below\./u);
    assert.deepEqual(calls.map((call) => call.url.split("/").at(-1)), ["tailored-resume", "tailored-resume"]);
  } finally {
    await harness.close();
  }
});

test("the cover letter starts unticked when coverByDefault is off, and ticking it adds the letter back", async () => {
  const { harness } = setup();
  try {
    await harness.render(React.createElement(DocumentsStep, props({ coverByDefault: false })));
    assert.equal(coverTick(harness).checked, false);
    assert.ok(harness.button(RESUME_ONLY));
    await harness.check(coverTick(harness), true);
    assert.ok(harness.button(BOTH));
  } finally {
    await harness.close();
  }
});

test("with a ready résumé, the cover letter alone asks once for its own maximum and calls only the cover-letter writer", async () => {
  const { byId } = await kitDocuments();
  const calls: Call[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const stub = apiStub(calls);
  const { harness, windowConfirms } = setup({ fetch: (async (input: RequestInfo | URL, init?: RequestInit) => { await gate; return stub(input, init); }) as typeof fetch });
  try {
    await harness.render(React.createElement(DocumentsStep, props({ resumes: [byId("resume-v2")], attached: { resumeId: "resume-v2", coverId: null } })));
    assert.equal(harness.button(BOTH).disabled, false, "the main action is still there");
    assert.equal(harness.button(COVER_ONLY).disabled, false);
    assert.match(harness.container.querySelector("[data-cover-only]")?.textContent ?? "", /Keeps your current résumé/u);
    await harness.click(harness.button(COVER_ONLY));
    await harness.waitForText(/Most it can cost/u);
    assert.equal(askedQuestion(harness), question("5¢"));
    await harness.click(harness.button("Confirm"));
    await waitUntil(() => harness.button(COVER_ONLY).disabled, "the cover-letter button to turn off while it runs");
    assert.equal(harness.button(BOTH).disabled, true, "nothing else starts while it runs");
    release();
    await harness.waitForText(/Your cover letter is ready to review below\./u);
    assert.deepEqual(calls.map((call) => [call.url, call.confirmed]), [
      ["/api/jobs/job-1/cover-letter", null],
      ["/api/jobs/job-1/cover-letter", "true"]
    ]);
    const progress = harness.container.querySelector("[aria-label=Progress]")?.textContent ?? "";
    assert.match(progress, /Writing your cover letter/u);
    assert.doesNotMatch(progress, /résumé/u);
    assert.deepEqual(windowConfirms, []);
  } finally {
    await harness.close();
  }
});

test("the cover letter alone is offered only when a ready résumé exists", async () => {
  const { byId } = await kitDocuments();
  const { harness } = setup();
  try {
    for (const resumes of [[], [byId("resume-v1")]]) {
      await harness.render(React.createElement(DocumentsStep, props({ resumes, attached: { resumeId: "resume-v1", coverId: null } })));
      assert.equal(harness.maybeButton(/^Write my cover letter/u), undefined);
    }
  } finally {
    await harness.close();
  }
});

test("a failed step stops the run and says what was already written", async () => {
  const failed = setup({ failResume: true });
  try {
    await failed.harness.render(React.createElement(DocumentsStep, props()));
    await failed.harness.click(failed.harness.button(BOTH));
    await failed.harness.waitForText(/Most it can cost/u);
    await failed.harness.click(failed.harness.button("Confirm"));
    await failed.harness.waitForText(/Gemini is busy\. You weren't charged for this step\./u);
    assert.equal(failed.calls.some((call) => call.url.endsWith("/cover-letter")), false);
    assert.ok(failed.harness.container.querySelector("[aria-label=Progress] [data-state=failed]"));
    assert.equal(failed.harness.refreshes, 0, "nothing was written, so nothing to show");
  } finally {
    await failed.harness.close();
  }
  const partial = setup({ failCover: true });
  try {
    await partial.harness.render(React.createElement(DocumentsStep, props()));
    await partial.harness.click(partial.harness.button(BOTH));
    await partial.harness.waitForText(/Most it can cost/u);
    await partial.harness.click(partial.harness.button("Confirm"));
    await partial.harness.waitForText(/Your résumé was created\. Gemini is busy\./u);
    assert.ok(partial.harness.refreshes >= 1, "the new résumé is shown");
  } finally {
    await partial.harness.close();
  }
});

test("a server maximum above the quote is asked again in the page, never with window.confirm", async () => {
  const { harness, calls, windowConfirms } = setup();
  try {
    await harness.render(React.createElement(DocumentsStep, props({ coverByDefault: false, quote: { ...quote, resumeMicros: 1 } })));
    await harness.click(harness.button("Write my résumé · up to 1¢"));
    await harness.waitForText(/Most it can cost: 1¢\./u);
    await harness.click(harness.button("Confirm"));
    await harness.waitForText(/more than the \$0\.000001 you approved/u);
    await harness.click(harness.button("Confirm"));
    await harness.waitForText(/Your résumé is ready to review below\./u);
    assert.deepEqual(calls.map((call) => call.confirmed), [null, "true"]);
    assert.deepEqual(windowConfirms, []);
  } finally {
    await harness.close();
  }
});

test("a blocked reason from the page disables both Write buttons, shows the reason and sends nothing", async () => {
  const { byId } = await kitDocuments();
  const { harness, calls } = setup();
  try {
    const reason = "Update your score in step 2 first, so your documents include your new lines.";
    await harness.render(React.createElement(DocumentsStep, props({
      blockedReason: reason, resumes: [byId("resume-v2")], attached: { resumeId: "resume-v2", coverId: null }
    })));
    assert.equal(harness.button(BOTH).disabled, true);
    assert.equal(harness.button(COVER_ONLY).disabled, true);
    assert.equal(harness.container.querySelector("[data-blocked-reason]")?.textContent, reason);
    await harness.click(harness.button(BOTH));
    await settle();
    assert.equal(calls.length, 0);
    await harness.render(React.createElement(DocumentsStep, props({ generationAvailable: false })));
    assert.equal(harness.button(BOTH).disabled, true);
    assert.match(harness.container.querySelector("[data-blocked-reason]")?.textContent ?? "", /Document writing is switched off/u);
  } finally {
    await harness.close();
  }
});

test("a double click asks once and writes each document once", async () => {
  const { harness, calls } = setup();
  try {
    await harness.render(React.createElement(DocumentsStep, props()));
    await harness.click(harness.button(BOTH));
    await harness.click(harness.button(BOTH));
    await harness.waitForText(/Most it can cost/u);
    assert.equal(harness.container.querySelectorAll('[role="group"]').length, 1);
    await harness.click(harness.button("Confirm"));
    await harness.waitForText(/ready to review below/u);
    assert.equal(calls.length, 4);
  } finally {
    await harness.close();
  }
});

test("plain language: no internal jargon", async () => {
  const { kit } = await kitDocuments();
  const { harness } = setup();
  try {
    await harness.render(React.createElement(DocumentsStep, props({
      letter: "C", resumes: kit.resumes, coverLetters: kit.coverLetters, attached: { resumeId: "resume-v2", coverId: "cover-legacy" }
    })));
    assert.doesNotMatch(harness.text(), /immutable|snapshot|Correction-first|reassess|Build packet|provenance|ATS score/iu);
  } finally {
    await harness.close();
  }
});
