import "@/tests/fixtures/dom-globals";
import assert from "node:assert/strict";
import test from "node:test";
import React from "react";

import { ExperienceStep, type ExperienceStepProps } from "@/components/apply-page/experience-step";
import type { DocumentCreationQuote } from "@/lib/jobs/document-creation-plan";
import { buildEvidenceCorrectionReview } from "@/lib/jobs/evidence-correction-review";
import { experienceDraftKey } from "@/lib/jobs/experience-drafts";
import { createDomHarness } from "@/tests/fixtures/dom-harness";

// Synthetic job and résumé only.
const requirements = ["Current Quenby certification", "Enterprise service delivery", "Working knowledge of SQL", "Experience running vendor reviews"];
const RESUME_LINE = "Ran quarterly vendor reviews for twelve suppliers.";
const SAVED_FACT = "Led the 2025 vendor consolidation for Example Corp.";
const STALE_TEXT = "This job's review changed in another tab. Reload to continue; your lines are kept on this computer.";
const DRAFT_KEY = experienceDraftKey("0123456789abcdef", "job-1");

function review(options: { requirementList?: string[]; gapIndexes?: number[] } = {}) {
  const list = options.requirementList ?? requirements;
  const gapIndexes = options.gapIndexes ?? [0, 2];
  return buildEvidenceCorrectionReview({
    jobId: "job-1", resumeId: "resume-1", resumeUpdatedAt: "2026-11-01T10:00:00.000Z",
    resume: { rawText: ["SUMMARY", "Service operations leader.", RESUME_LINE].join("\n") },
    analysisId: "analysis-1", analysisInputHash: "a".repeat(64), analysisModel: "gemini-3.8-flash", analysisPromptVersion: "3.4",
    analysisOutput: {
      contractVersion: "3",
      promptVersion: "3.4",
      factualMatches: [{
        claim: "Shows enterprise service delivery",
        applicantEvidence: [{ ref: "resume.rawText", excerpt: "Service operations leader." }],
        jobEvidence: [{ ref: "job.requirements[1]", excerpt: list[1] }]
      }],
      requirementGaps: gapIndexes.map((index) => ({
        requirement: list[index], jobRequirement: { ref: `job.requirements[${index}]`, excerpt: list[index] }, missingKeywords: []
      }))
    },
    job: { requirements: list, description: null },
    acceptedFacts: [{
      factId: "fact:owner-1", originGapId: "gap:9", fact: SAVED_FACT,
      provenance: { kind: "OWNER_ATTESTED", ownerAttested: true }, reuseScope: "JOB_ONLY", masterProfileOptIn: false
    }]
  });
}

const quote: DocumentCreationQuote = {
  provider: "gemini", model: "gemini-3.8-flash", promptVersion: "12", jobMatchMicros: 72_720, resumeMicros: 64_500, coverMicros: 47_250
};

function props(overrides: Partial<ExperienceStepProps> = {}): ExperienceStepProps {
  return {
    jobId: "job-1",
    review: review(),
    hasValidCurrentSnapshot: false,
    matchBoundToReview: false,
    quote,
    draftKey: DRAFT_KEY,
    generationAvailable: true,
    ...overrides
  };
}

type Call = { url: string; confirmed: string | null; body: unknown };

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function savedResponse(isCurrent = true) {
  return json(201, {
    schema: "apply-pilot/evidence-snapshot-save-response/v1",
    snapshot: { id: "snapshot-1", hash: "b".repeat(64), createdAt: "2026-11-11T12:00:00.000Z", isCurrent },
    replayed: false,
    invalidations: { assessmentIds: ["analysis-1"], resumeDocumentIds: [], coverLetterDocumentIds: [], totalCount: 1, reason: "EVIDENCE_SNAPSHOT_CHANGED" }
  });
}

// The real match route answers an unconfirmed request with 428 and its maximum; nothing runs until
// the request comes back with x-ai-cost-confirmed.
function apiStub(calls: Call[], options: { save?: () => Response | Promise<Response>; matchMaximum?: number } = {}) {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const call = { url, confirmed: new Headers(init?.headers).get("x-ai-cost-confirmed"), body: init?.body ? JSON.parse(String(init.body)) : null };
    calls.push(call);
    if (url.endsWith("/evidence-snapshots")) return options.save ? options.save() : savedResponse();
    if (!call.confirmed) return json(428, { code: "AI_COST_CONFIRMATION_REQUIRED", maximumCostMicros: options.matchMaximum ?? 72_720 });
    return json(200, { cached: false });
  }) as typeof fetch;
}

function setup(options: { fetch?: typeof fetch; calls?: Call[] } = {}) {
  const calls = options.calls ?? [];
  const windowConfirms: string[] = [];
  const harness = createDomHarness({
    fetch: options.fetch ?? apiStub(calls),
    confirm: (message) => { windowConfirms.push(message); return true; }
  });
  // react-dom's fallback input listener calls the IE-only attachEvent/detachEvent.
  Object.assign(harness.window.HTMLElement.prototype, { attachEvent() {}, detachEvent() {} });
  return { harness, calls, windowConfirms };
}

type Harness = ReturnType<typeof createDomHarness>;

function box(harness: Harness, requirement: string) {
  const found = [...harness.container.querySelectorAll("fieldset[data-requirement]")].find((node) =>
    node.querySelector("legend")?.textContent === requirement);
  assert.ok(found, `box for ${requirement}`);
  return found;
}

function textarea(harness: Harness, requirement: string) {
  const field = box(harness, requirement).querySelector("textarea");
  assert.ok(field, `textarea for ${requirement}`);
  return field;
}

function tick(harness: Harness) {
  const label = [...harness.container.querySelectorAll("label")].find((node) => node.textContent === "Everything I wrote above is true.");
  assert.ok(label, "the truth tick");
  return label.querySelector("input")!;
}

function blockedReason(harness: Harness) {
  return harness.container.querySelector("[data-blocked-reason]")?.textContent ?? null;
}

function storedDrafts(harness: Harness) {
  const raw = harness.window.localStorage.getItem(DRAFT_KEY);
  return raw === null ? null : (JSON.parse(raw) as { v: number; drafts: Record<string, { line: string; resumeLine: string }> }).drafts;
}

const significant = (calls: Call[]) => calls.map((call) => [call.url.split("/").at(-1), call.confirmed]);

test("every requirement gets one box: the gaps, then the requirements the match didn't check", async () => {
  const { harness } = setup();
  try {
    await harness.render(React.createElement(ExperienceStep, props()));
    const listed = [...harness.container.querySelectorAll("fieldset[data-requirement] legend")].map((node) => node.textContent);
    assert.deepEqual(listed, ["Current Quenby certification", "Working knowledge of SQL", "Experience running vendor reviews"]);
    const field = textarea(harness, "Current Quenby certification");
    assert.equal(field.getAttribute("placeholder"), "If you have this, say what you did.");
    assert.match(box(harness, "Current Quenby certification").textContent ?? "", /0\/200/u);
    assert.match(harness.text(), /Lines you've added before/u);
    assert.match(harness.text(), new RegExp(SAVED_FACT.replace(/\./gu, "\\."), "u"));
    assert.ok(harness.button("Nothing to add · update my score"));
  } finally {
    await harness.close();
  }
});

test("the same requirement text is listed once", async () => {
  const { harness } = setup();
  try {
    // "Working knowledge of SQL" appears twice in the posting: once flagged, once not checked.
    const list = [...requirements, "Working knowledge of SQL"];
    await harness.render(React.createElement(ExperienceStep, props({ review: review({ requirementList: list }) })));
    const listed = [...harness.container.querySelectorAll("fieldset[data-requirement] legend")].map((node) => node.textContent);
    assert.equal(listed.filter((text) => text === "Working knowledge of SQL").length, 1);
  } finally {
    await harness.close();
  }
});

test("a placeholder is flagged under its box before any request", async () => {
  const { harness, calls } = setup();
  try {
    await harness.render(React.createElement(ExperienceStep, props()));
    await harness.type(textarea(harness, "Current Quenby certification"), "Earned the Quenby certification in [X].");
    const problems = [...box(harness, "Current Quenby certification").querySelectorAll("[data-problem]")];
    assert.equal(problems.length, 1);
    assert.match(problems[0]!.textContent ?? "", /\[X\]/u);
    const describedBy = (textarea(harness, "Current Quenby certification").getAttribute("aria-describedby") ?? "").split(" ");
    assert.equal(describedBy.some((id) => id && harness.window.document.getElementById(id)?.contains(problems[0]!)), true, "the box names its problem");
    assert.equal(box(harness, "Working knowledge of SQL").querySelector("[data-problem]") === null, true, "only the box with the problem");
    assert.equal(harness.button("Update my score · about 8¢").disabled, true);
    assert.equal(blockedReason(harness), 'Fix the line for "Current Quenby certification" first.');
    assert.equal(calls.length, 0);
  } finally {
    await harness.close();
  }
});

test("a 201-character line shows the limit and blocks Update", async () => {
  const { harness, calls } = setup();
  try {
    await harness.render(React.createElement(ExperienceStep, props()));
    const line = `I ${"b".repeat(197)}.`;
    assert.equal(`${line}s`.length, 201);
    await harness.type(textarea(harness, "Working knowledge of SQL"), `${line}s`);
    const sql = box(harness, "Working knowledge of SQL");
    assert.match(sql.textContent ?? "", /201\/200/u);
    assert.match(sql.querySelector("[data-problem]")?.textContent ?? "", /200 characters/u);
    await harness.check(tick(harness));
    assert.equal(harness.button("Update my score · about 8¢").disabled, true);
    assert.equal(blockedReason(harness), 'Fix the line for "Working knowledge of SQL" first.');
    await harness.type(textarea(harness, "Working knowledge of SQL"), line);
    assert.match(sql.textContent ?? "", /200\/200/u);
    assert.equal(sql.querySelector("[data-problem]") === null, true);
    assert.equal(harness.button("Update my score · about 8¢").disabled, false);
    // Only the length counts: two sentences, U.S. and e.g. are fine.
    await harness.type(textarea(harness, "Working knowledge of SQL"), "I wrote SQL reports for U.S. teams, e.g. finance. I tuned queries.");
    assert.equal(sql.querySelector("[data-problem]") === null, true);
    assert.equal(harness.button("Update my score · about 8¢").disabled, false);
    assert.equal(calls.length, 0);
  } finally {
    await harness.close();
  }
});

test("the truth tick is required for a new line and a changed saved line", async () => {
  const { harness } = setup();
  try {
    await harness.render(React.createElement(ExperienceStep, props()));
    await harness.type(textarea(harness, "Current Quenby certification"), "Earned the Quenby certification in 2024.");
    assert.equal(blockedReason(harness), 'Tick "Everything I wrote above is true." first.');
    await harness.check(tick(harness));
    assert.equal(blockedReason(harness), null);
    await harness.type(textarea(harness, "Current Quenby certification"), "");
    await harness.check(tick(harness), false);
    const saved = harness.container.querySelector("fieldset[data-saved-line]")!;
    await harness.click([...saved.querySelectorAll("label")].find((node) => node.textContent === "Change")?.querySelector("input"));
    assert.equal(harness.button("Update my score · about 8¢").disabled, true);
    assert.equal(blockedReason(harness), `Fix the line for "${SAVED_FACT}" first.`);
    await harness.type(saved.querySelector("textarea"), "Led the 2025 vendor consolidation for three regions.");
    assert.equal(blockedReason(harness), 'Tick "Everything I wrote above is true." first.');
    await harness.click([...saved.querySelectorAll("label")].find((node) => node.textContent === "Remove")?.querySelector("input"));
    assert.equal(blockedReason(harness), null, "Remove needs no tick");
    assert.equal(harness.button("Update my score · about 8¢").disabled, false);
  } finally {
    await harness.close();
  }
});

test("Update my score sends exactly save then match", async () => {
  const { harness, calls, windowConfirms } = setup();
  try {
    await harness.render(React.createElement(ExperienceStep, props()));
    await harness.type(textarea(harness, "Current Quenby certification"), "Earned the Quenby certification in 2024.");
    const vendor = box(harness, "Experience running vendor reviews");
    await harness.click([...vendor.querySelectorAll("button")].find((node) => node.textContent === "It's on my résumé"));
    await harness.type(vendor.querySelector("select"), RESUME_LINE);
    await harness.check(tick(harness));
    await harness.click(harness.button("Update my score · about 8¢"));
    await harness.waitForText(/could cost up to \$0\.07272/u);
    // What the re-score actually sends (lib/ai/job-match.ts), so the question can stand for consent.
    assert.match(harness.text(), /Sends this job, your résumé, your job preferences from your profile \(such as target roles, locations and salary\) and the lines you added for this job to Google Gemini to update your score\./u);
    assert.equal(calls.length, 0, "nothing is sent before the in-page Confirm");
    await harness.click(harness.button("Confirm"));
    await harness.waitForText(/Your lines were saved and your score was updated\./u);
    // The first match request is the server's cost check (428, nothing runs); the one that scores
    // carries the header.
    assert.deepEqual(significant(calls), [["evidence-snapshots", null], ["match", null], ["match", "true"]]);
    const body = calls[0]!.body as { requestId: string; decisions: Array<Record<string, unknown>>; acceptedFactActions: unknown[] };
    assert.deepEqual(body.decisions, [
      { gapId: "gap:0", kind: "OWNER_ATTESTATION", attestedFact: "Earned the Quenby certification in 2024.", ownerAttested: true, reuseScope: "JOB_ONLY", masterProfileOptIn: false },
      { gapId: "gap:1", kind: "UNRESOLVED", reuseScope: "JOB_ONLY", masterProfileOptIn: false },
      {
        gapId: "requirement:3", kind: "SOURCE_CORRECTION", sourceFactId: "fact:resume.rawText",
        sourceExcerpt: RESUME_LINE, correctedFact: RESUME_LINE, reuseScope: "JOB_ONLY", masterProfileOptIn: false
      }
    ]);
    assert.deepEqual(body.acceptedFactActions, [{ factId: "fact:owner-1", action: "RETAIN" }]);
    assert.equal(harness.refreshes, 1);
    assert.equal(windowConfirms.length, 0);
  } finally {
    await harness.close();
  }
});

test("a changed saved line is sent as an attested replacement", async () => {
  const { harness, calls } = setup();
  try {
    await harness.render(React.createElement(ExperienceStep, props({ hasValidCurrentSnapshot: true })));
    const saved = harness.container.querySelector("fieldset[data-saved-line]")!;
    await harness.click([...saved.querySelectorAll("label")].find((node) => node.textContent === "Change")?.querySelector("input"));
    await harness.type(saved.querySelector("textarea"), "Led the 2025 vendor consolidation for three regions.");
    await harness.check(tick(harness));
    await harness.click(harness.button("Update my score · about 8¢"));
    await harness.click(harness.button("Confirm"));
    await harness.waitForText(/score was updated/u);
    const body = calls[0]!.body as { acceptedFactActions: unknown[] };
    assert.deepEqual(body.acceptedFactActions, [{
      factId: "fact:owner-1", action: "REPLACE_OWNER_ATTESTATION", attestedFact: "Led the 2025 vendor consolidation for three regions.",
      ownerAttested: true, reuseScope: "JOB_ONLY", masterProfileOptIn: false
    }]);
  } finally {
    await harness.close();
  }
});

test("with nothing to add the button re-scores, saving the review only when none is saved yet", async () => {
  {
    const { harness, calls } = setup();
    try {
      await harness.render(React.createElement(ExperienceStep, props()));
      assert.equal(blockedReason(harness), null);
      await harness.click(harness.button("Nothing to add · update my score"));
      await harness.click(harness.button("Confirm"));
      await harness.waitForText(/Your score was updated\./u);
      assert.deepEqual(significant(calls), [["evidence-snapshots", null], ["match", null], ["match", "true"]]);
    } finally {
      await harness.close();
    }
  }
  {
    const { harness, calls } = setup();
    try {
      await harness.render(React.createElement(ExperienceStep, props({ hasValidCurrentSnapshot: true })));
      await harness.click(harness.button("Nothing to add · update my score"));
      await harness.click(harness.button("Confirm"));
      await harness.waitForText(/Your score was updated\./u);
      assert.deepEqual(significant(calls), [["match", null], ["match", "true"]], "the saved review is already in force");
    } finally {
      await harness.close();
    }
  }
});

test("a match already tied to the saved review shows Done until something changes", async () => {
  const { harness } = setup();
  try {
    await harness.render(React.createElement(ExperienceStep, props({ hasValidCurrentSnapshot: true, matchBoundToReview: true })));
    assert.equal(harness.container.querySelector("[data-experience-done]")?.textContent, "Done");
    assert.equal(harness.maybeButton(/update my score/iu) === undefined, true);
    await harness.type(textarea(harness, "Working knowledge of SQL"), "Wrote SQL reports for the service desk.");
    assert.equal(harness.container.querySelector("[data-experience-done]") === null, true);
    assert.ok(harness.button("Update my score · about 8¢"));
  } finally {
    await harness.close();
  }
});

test("Cancel sends no match request", async () => {
  const { harness, calls } = setup();
  try {
    await harness.render(React.createElement(ExperienceStep, props()));
    await harness.type(textarea(harness, "Current Quenby certification"), "Earned the Quenby certification in 2024.");
    await harness.check(tick(harness));
    await harness.click(harness.button("Update my score · about 8¢"));
    await harness.waitForText(/could cost up to/u);
    await harness.click(harness.button("Cancel"));
    await harness.waitForText(/Canceled\. Nothing was sent and nothing was charged\./u);
    assert.equal(calls.length, 0);
    assert.equal(harness.button("Update my score · about 8¢").disabled, false);
    assert.equal(textarea(harness, "Current Quenby certification").value, "Earned the Quenby certification in 2024.");
  } finally {
    await harness.close();
  }
});

test("drafts survive a remount and are cleared after success", async () => {
  const { harness } = setup();
  try {
    await harness.render(React.createElement(ExperienceStep, props()));
    await harness.type(textarea(harness, "Current Quenby certification"), "Earned the Quenby certification in 2024.");
    const vendor = box(harness, "Experience running vendor reviews");
    await harness.click([...vendor.querySelectorAll("button")].find((node) => node.textContent === "It's on my résumé"));
    await harness.type(vendor.querySelector("select"), RESUME_LINE);
    assert.match(box(harness, "Current Quenby certification").textContent ?? "", /Saved on this computer/u);
    await harness.check(tick(harness));
    assert.deepEqual(storedDrafts(harness), {
      "Current Quenby certification": { line: "Earned the Quenby certification in 2024.", resumeLine: "" },
      "Experience running vendor reviews": { line: "", resumeLine: RESUME_LINE }
    });

    await harness.render(React.createElement("div"));
    await harness.render(React.createElement(ExperienceStep, props()));
    assert.equal(textarea(harness, "Current Quenby certification").value, "Earned the Quenby certification in 2024.");
    assert.equal(box(harness, "Experience running vendor reviews").querySelector("select")?.value, RESUME_LINE);
    assert.equal(tick(harness).checked, false, "the truth tick is never kept");

    await harness.check(tick(harness));
    await harness.click(harness.button("Update my score · about 8¢"));
    await harness.click(harness.button("Confirm"));
    await harness.waitForText(/score was updated/u);
    assert.equal(storedDrafts(harness), null);
    assert.equal(textarea(harness, "Current Quenby certification").value, "");
  } finally {
    await harness.close();
  }
});

test("a throwing storage still lets you update", async () => {
  const { harness, calls } = setup();
  try {
    Object.defineProperty(harness.window, "localStorage", {
      configurable: true,
      get() { throw new harness.window.DOMException("The operation is insecure.", "SecurityError"); }
    });
    await harness.render(React.createElement(ExperienceStep, props()));
    await harness.type(textarea(harness, "Current Quenby certification"), "Earned the Quenby certification in 2024.");
    assert.match(box(harness, "Current Quenby certification").textContent ?? "", /Not kept between visits on this browser/u);
    assert.doesNotMatch(harness.text(), /Saved on this computer/u);
    await harness.check(tick(harness));
    await harness.click(harness.button("Update my score · about 8¢"));
    await harness.click(harness.button("Confirm"));
    await harness.waitForText(/Your lines were saved and your score was updated\./u);
    assert.deepEqual(significant(calls), [["evidence-snapshots", null], ["match", null], ["match", "true"]]);
  } finally {
    await harness.close();
  }
});

test("a double click sends one save and one match", async () => {
  let releaseSave!: () => void;
  const saveHeld = new Promise<void>((resolve) => { releaseSave = resolve; });
  const calls: Call[] = [];
  const { harness } = setup({ calls, fetch: apiStub(calls, { save: async () => { await saveHeld; return savedResponse(); } }) });
  try {
    await harness.render(React.createElement(ExperienceStep, props()));
    await harness.type(textarea(harness, "Current Quenby certification"), "Earned the Quenby certification in 2024.");
    await harness.check(tick(harness));
    const button = harness.button("Update my score · about 8¢");
    await harness.click(button);
    await harness.click(button);
    await harness.waitForText(/could cost up to/u);
    assert.equal(harness.container.querySelectorAll('[role="group"]').length, 1, "one question");
    await harness.click(harness.button("Confirm"));
    // A slow network: the save is still in flight.
    await harness.click(button);
    await harness.click(button);
    assert.equal(button.disabled, true);
    releaseSave();
    await harness.waitForText(/score was updated/u);
    assert.equal(calls.filter((call) => call.url.endsWith("/evidence-snapshots")).length, 1);
    assert.equal(calls.filter((call) => call.url.endsWith("/match") && call.confirmed === "true").length, 1);
  } finally {
    await harness.close();
  }
});

test("a stale review keeps drafts and asks to reload", async () => {
  for (const response of [
    () => json(409, { error: "The fit assessment changed after this review was opened.", code: "EVIDENCE_ANALYSIS_STALE" }),
    () => json(409, { error: "The source resume changed after this review was opened.", code: "EVIDENCE_SOURCE_STALE" }),
    () => savedResponse(false)
  ]) {
    const calls: Call[] = [];
    const { harness } = setup({ calls, fetch: apiStub(calls, { save: response }) });
    try {
      await harness.render(React.createElement(ExperienceStep, props()));
      await harness.type(textarea(harness, "Current Quenby certification"), "Earned the Quenby certification in 2024.");
      await harness.check(tick(harness));
      await harness.click(harness.button("Update my score · about 8¢"));
      await harness.click(harness.button("Confirm"));
      await harness.waitForText(/changed in another tab/u);
      assert.match(harness.text(), new RegExp(STALE_TEXT.replace(/[.']/gu, "."), "u"));
      assert.deepEqual(significant(calls), [["evidence-snapshots", null]], "no re-score");
      assert.equal(textarea(harness, "Current Quenby certification").value, "Earned the Quenby certification in 2024.");
      assert.deepEqual(storedDrafts(harness), { "Current Quenby certification": { line: "Earned the Quenby certification in 2024.", resumeLine: "" } });
      assert.equal(harness.refreshes, 0);
    } finally {
      await harness.close();
    }
  }
});

test("a 422 shows the server's message under the step and keeps the request ID for a retry", async () => {
  let saves = 0;
  const calls: Call[] = [];
  const { harness } = setup({
    calls,
    fetch: apiStub(calls, {
      save: () => (++saves === 1
        ? json(422, { error: "Keep each line to 200 characters or fewer.", code: "OWNER_FACT_TOO_LONG" })
        : savedResponse())
    })
  });
  try {
    await harness.render(React.createElement(ExperienceStep, props()));
    await harness.type(textarea(harness, "Current Quenby certification"), "Earned the Quenby certification in 2024.");
    await harness.check(tick(harness));
    await harness.click(harness.button("Update my score · about 8¢"));
    await harness.click(harness.button("Confirm"));
    await harness.waitForText(/Keep each line to 200 characters or fewer\./u);
    assert.equal(calls.length, 1);
    assert.equal(storedDrafts(harness) !== null, true, "drafts are kept");
    await harness.click(harness.button("Update my score · about 8¢"));
    await harness.click(harness.button("Confirm"));
    await harness.waitForText(/score was updated/u);
    const [first, second] = calls.filter((call) => call.url.endsWith("/evidence-snapshots")).map((call) => (call.body as { requestId: string }).requestId);
    assert.equal(first, second, "the same answers reuse the same request ID");
  } finally {
    await harness.close();
  }
});

test("a draft whose requirement disappeared is dropped with a notice", async () => {
  const { harness } = setup();
  try {
    harness.window.localStorage.setItem(DRAFT_KEY, JSON.stringify({
      v: 1,
      drafts: {
        "Working knowledge of SQL": { line: "Wrote SQL reports for the service desk.", resumeLine: "" },
        "Fluent in Quenby scheduling": { line: "Ran Quenby scheduling for two years.", resumeLine: "" },
        // Not the stored shape: ignored, never shown.
        "Current Quenby certification": { line: 42 }
      }
    }));
    await harness.render(React.createElement(ExperienceStep, props()));
    assert.match(harness.text(), /1 line no longer matches this job's requirements and was removed\./u);
    assert.equal(textarea(harness, "Working knowledge of SQL").value, "Wrote SQL reports for the service desk.");
    assert.equal(textarea(harness, "Current Quenby certification").value, "");
    assert.deepEqual(storedDrafts(harness), { "Working knowledge of SQL": { line: "Wrote SQL reports for the service desk.", resumeLine: "" } });
    await harness.type(textarea(harness, "Working knowledge of SQL"), "Wrote SQL reports for the service team.");
    assert.match(harness.text(), /1 line no longer matches/u, "the notice stays while you type");
  } finally {
    await harness.close();
  }
});

test("window.confirm is never called", async () => {
  // The server's maximum is above the quote, so the match asks again: in the page as well.
  const calls: Call[] = [];
  const { harness, windowConfirms } = setup({ calls, fetch: apiStub(calls, { matchMaximum: 100_000 }) });
  try {
    await harness.render(React.createElement(ExperienceStep, props()));
    await harness.type(textarea(harness, "Current Quenby certification"), "Earned the Quenby certification in 2024.");
    await harness.check(tick(harness));
    await harness.click(harness.button("Update my score · about 8¢"));
    await harness.click(harness.button("Confirm"));
    await harness.waitForText(/more than the \$0\.07272 you approved/u);
    await harness.click(harness.button("Confirm"));
    await harness.waitForText(/score was updated/u);
    assert.deepEqual(windowConfirms, []);
    assert.deepEqual(significant(calls), [["evidence-snapshots", null], ["match", null], ["match", "true"]]);
  } finally {
    await harness.close();
  }
});

test("a failed re-score after a save says the lines were saved and clears the drafts", async () => {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, confirmed: new Headers(init?.headers).get("x-ai-cost-confirmed"), body: null });
    if (url.endsWith("/evidence-snapshots")) return savedResponse();
    return json(503, { error: "Gemini is busy.", billingStatus: "not_charged" });
  }) as typeof fetch;
  const { harness } = setup({ calls, fetch: fetchImpl });
  try {
    await harness.render(React.createElement(ExperienceStep, props()));
    await harness.type(textarea(harness, "Current Quenby certification"), "Earned the Quenby certification in 2024.");
    await harness.check(tick(harness));
    await harness.click(harness.button("Update my score · about 8¢"));
    await harness.click(harness.button("Confirm"));
    await harness.waitForText(/Your lines were saved, but your score wasn't updated\. Gemini is busy\. You weren't charged for this step\./u);
    assert.equal(storedDrafts(harness), null);
    assert.equal(harness.refreshes, 1);
  } finally {
    await harness.close();
  }
});

test("without a current match the step points back to step 1", async () => {
  const { harness } = setup();
  try {
    const unscored = buildEvidenceCorrectionReview({
      jobId: "job-1", resumeId: "resume-1", resumeUpdatedAt: "2026-11-01T10:00:00.000Z",
      resume: { rawText: "Service operations leader." }, analysisId: null, analysisOutput: null
    });
    await harness.render(React.createElement(ExperienceStep, props({ review: unscored })));
    assert.match(harness.text(), /Check your match in step 1 first/u);
    assert.equal(harness.container.querySelector("fieldset[data-requirement]") === null, true);
    assert.equal(harness.maybeButton(/update my score/iu) === undefined, true);
  } finally {
    await harness.close();
  }
});

test("after a save whose re-score failed, the refreshed step keeps the outcome and says the lines are saved", async () => {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, confirmed: new Headers(init?.headers).get("x-ai-cost-confirmed"), body: null });
    if (url.endsWith("/evidence-snapshots")) return savedResponse();
    return json(503, { error: "Gemini is busy.", billingStatus: "not_charged" });
  }) as typeof fetch;
  const { harness } = setup({ calls, fetch: fetchImpl });
  try {
    await harness.render(React.createElement(ExperienceStep, props()));
    await harness.type(textarea(harness, "Current Quenby certification"), "Earned the Quenby certification in 2024.");
    await harness.check(tick(harness));
    await harness.click(harness.button("Update my score · about 8¢"));
    await harness.click(harness.button("Confirm"));
    await harness.waitForText(/score wasn't updated/u);
    // What router.refresh() delivers: the save invalidated the match, so nothing is reviewable yet.
    const refreshed = buildEvidenceCorrectionReview({
      jobId: "job-1", resumeId: "resume-1", resumeUpdatedAt: "2026-11-01T10:00:00.000Z",
      resume: { rawText: "Service operations leader." }, analysisId: null, analysisOutput: null,
      acceptedFacts: [{
        factId: "fact:owner-2", originGapId: "gap:0", fact: "Earned the Quenby certification in 2024.",
        provenance: { kind: "OWNER_ATTESTED", ownerAttested: true }, reuseScope: "JOB_ONLY", masterProfileOptIn: false
      }]
    });
    await harness.render(React.createElement(ExperienceStep, props({ review: refreshed, hasValidCurrentSnapshot: true })));
    assert.match(harness.text(), /Your lines were saved, but your score wasn't updated\. Gemini is busy\. You weren't charged for this step\./u);
    assert.match(harness.text(), /Your lines are saved\. Update my score to use them\./u);
    assert.match(harness.text(), /Earned the Quenby certification in 2024\./u);
    assert.doesNotMatch(harness.text(), /before adding lines/u);
    assert.ok(harness.button("Update my score · about 8¢"), "the step offers the re-score itself");
  } finally {
    await harness.close();
  }
});

test("a saved review with nothing to review re-scores only, and Cancel sends nothing", async () => {
  const { harness, calls } = setup();
  try {
    const saved = buildEvidenceCorrectionReview({
      jobId: "job-1", resumeId: "resume-1", resumeUpdatedAt: "2026-11-01T10:00:00.000Z",
      resume: { rawText: "Service operations leader." }, analysisId: null, analysisOutput: null
    });
    await harness.render(React.createElement(ExperienceStep, props({ review: saved, hasValidCurrentSnapshot: true })));
    assert.match(harness.text(), /Your review is saved\. Update my score to continue\./u);
    await harness.click(harness.button("Update my score · about 8¢"));
    await harness.waitForText(/could cost up to/u);
    await harness.click(harness.button("Cancel"));
    await harness.waitForText(/Canceled\. Nothing was sent and nothing was charged\./u);
    assert.equal(calls.length, 0);
    await harness.click(harness.button("Update my score · about 8¢"));
    await harness.click(harness.button("Confirm"));
    await harness.waitForText(/Your score was updated\./u);
    assert.deepEqual(significant(calls), [["match", null], ["match", "true"]], "never a save");
    assert.equal(harness.refreshes, 1);
  } finally {
    await harness.close();
  }
  const off = setup();
  try {
    const saved = buildEvidenceCorrectionReview({
      jobId: "job-1", resumeId: "resume-1", resumeUpdatedAt: "2026-11-01T10:00:00.000Z",
      resume: { rawText: "Service operations leader." }, analysisId: null, analysisOutput: null
    });
    await off.harness.render(React.createElement(ExperienceStep, props({ review: saved, hasValidCurrentSnapshot: true, generationAvailable: false })));
    assert.equal(off.harness.button("Update my score · about 8¢").disabled, true);
    assert.match(blockedReason(off.harness) ?? "", /Scoring is switched off/u);
  } finally {
    await off.harness.close();
  }
});

test("Nothing to add keeps a line typed before switching to the résumé picker", async () => {
  const { harness } = setup();
  try {
    await harness.render(React.createElement(ExperienceStep, props()));
    await harness.type(textarea(harness, "Working knowledge of SQL"), "Wrote SQL reports for the service desk.");
    const sql = box(harness, "Working knowledge of SQL");
    await harness.click([...sql.querySelectorAll("button")].find((node) => node.textContent === "It's on my résumé"));
    await harness.click(harness.button("Nothing to add · update my score"));
    await harness.click(harness.button("Confirm"));
    await harness.waitForText(/Your score was updated\./u);
    assert.deepEqual(storedDrafts(harness), { "Working knowledge of SQL": { line: "Wrote SQL reports for the service desk.", resumeLine: "" } });
    assert.equal(textarea(harness, "Working knowledge of SQL").value, "Wrote SQL reports for the service desk.");
  } finally {
    await harness.close();
  }
});

// Step 2 owns the requirement list: it never claims to cover everything, and speaks plainly.
test("with nothing flagged, the step never claims the résumé covers every requirement", async () => {
  const { harness } = setup();
  try {
    await harness.render(React.createElement(ExperienceStep, props({ review: { ...review(), gaps: [], uncheckedRequirements: [], acceptedFacts: [] } })));
    assert.doesNotMatch(harness.text(), /Every requirement/u);
    assert.match(harness.text(), /didn't flag any listed requirement/u);
    assert.match(harness.text(), /can't check every requirement \(years of experience, for example\)/u);
  } finally {
    await harness.close();
  }
});

test("plain language: no internal jargon", async () => {
  const { harness } = setup();
  try {
    await harness.render(React.createElement(ExperienceStep, props()));
    await harness.type(textarea(harness, "Current Quenby certification"), "Earned the Quenby certification in 2024.");
    assert.doesNotMatch(harness.text(), /immutable|snapshot|Correction-first|reassess|Build packet|provenance|ATS score/iu);
  } finally {
    await harness.close();
  }
});
