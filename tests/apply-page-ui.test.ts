import "@/tests/fixtures/dom-globals";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";

import { ApplyPage, matchResultLine, type ApplyPageProps } from "@/components/apply-page/apply-page";
import { loadApplyKitView, type ApplyKitView } from "@/lib/apply-kit/apply-kit-view";
import { deriveApplyProgress, type ApplyProgressInput } from "@/lib/apply-page/apply-progress";
import { attachedDocumentState } from "@/lib/apply-page/attached-documents";
import { applyProgressFromFacts, loadApplyPageState, loadApplyProgress, prepareStateFromFacts, type PrepareStepFacts } from "@/lib/apply-page/load-apply-progress";
import { automationPolicyDefaultValues } from "@/lib/application-runs/service";
import { prisma } from "@/lib/prisma";
import type { JobDetail } from "@/lib/jobs/job-detail";
import { buildEvidenceCorrectionReview } from "@/lib/jobs/evidence-correction-review";
import { buildRequirementChecklist } from "@/lib/jobs/requirement-checklist";
import { JOB, OWNER, fakeDb, fixtures } from "@/tests/fixtures/apply-kit-db";
import { createDomHarness } from "@/tests/fixtures/dom-harness";

const requirements = ["Current Quenby certification", "Enterprise service delivery", "Working knowledge of SQL"];
const output = {
  contractVersion: "3",
  promptVersion: "3.4",
  factualMatches: [{
    claim: "Shows enterprise service delivery",
    applicantEvidence: [{ ref: "resume.rawText", excerpt: "Résumé line." }],
    jobEvidence: [{ ref: "job.requirements[1]", excerpt: requirements[1] }]
  }],
  requirementGaps: [0, 2].map((index) => ({
    requirement: requirements[index], jobRequirement: { ref: `job.requirements[${index}]`, excerpt: requirements[index] }, missingKeywords: []
  }))
};

const PREPARE_FACTS: PrepareStepFacts = {
  jobApplyHost: "jobs.example.com",
  estimate: { score: 90, basis: "REVIEWED_EVIDENCE" },
  confidenceScore: 88,
  documents: { resume: "ready", cover: "ready" },
  policy: { ...automationPolicyDefaultValues(), mode: "PREPARE_ONLY" },
  run: null,
  details: { fields: Array.from({ length: 10 }, () => ({}) as never), confirmedCount: 6, missingRequired: [] }
};

const PROGRESS_INPUT: ApplyProgressInput = {
  hasMasterResume: true, hasCurrentMatch: true, reviewSaved: false, resumeAttached: false, coverAttached: false,
  coverRequired: true, automationAvailable: false, run: null, applied: false
};

const review = () => buildEvidenceCorrectionReview({
  jobId: "job-1", resumeId: "resume-1", resumeUpdatedAt: "2026-11-01T10:00:00.000Z",
  resume: { rawText: "Service operations leader." }, analysisId: "analysis-1", analysisInputHash: "a".repeat(64),
  analysisModel: "gemini-3.8-flash", analysisPromptVersion: "3.4", analysisOutput: output
});

type PageOverrides = Partial<Omit<ApplyPageProps, "detail">> & { detail?: Record<string, unknown>; kitPatch?: Partial<ApplyKitView> };

// The Apply Kit fixture's documents: resume-v2 ready, resume-v1 out of date, cover-edited needs
// review, cover-legacy ready. An application with both ready ones attached has nothing to attach.
const ATTACHED = { id: "application-1", statusLabel: "Saved", resumeVersionId: "resume-v2", coverLetterVersionId: "cover-legacy" };
const BELOW_A = "Assisted Fill needs an A. You can still apply on your own with these documents.";

async function pageProps(overrides: PageOverrides = {}): Promise<ApplyPageProps> {
  const { kitPatch, detail: detailOverrides, ...rest } = overrides;
  const loaded = (await loadApplyKitView(fakeDb(fixtures()).db, { userId: OWNER, jobId: JOB, aiGenerationAvailable: true }))!;
  const kit = { ...loaded, ...kitPatch };
  const built = buildRequirementChecklist(requirements, output);
  const detail = {
    draftUserKey: "0123456789abcdef",
    currentConfidenceScore: 90,
    view: { id: "job-1", title: "Platform Engineer", company: "Example Co", location: "Remote" },
    estimate: { score: 68, basis: "MASTER_RESUME", scoredAt: "2026-11-05T10:00:00.000Z", compensation: { score: null, explanation: "Unknown." }, resumeAngle: "", coverLetterAngle: "" },
    checklist: { items: built.items, counts: built.counts },
    readOnlyGaps: [],
    hasValidCurrentSnapshot: false,
    sourceText: "Service operations leader.",
    resumeVersions: [],
    coverLetters: [],
    application: null,
    applyReturn: { pending: null, declined: null },
    contacts: [],
    salaryTarget: null,
    evidenceReview: review(),
    ...detailOverrides
  } as unknown as JobDetail;
  return {
    kit,
    automationAvailable: false,
    progress: deriveApplyProgress(PROGRESS_INPUT),
    prepare: prepareStateFromFacts(PREPARE_FACTS),
    tailorServer: { quote: { provider: "gemini", model: "gemini-3.8-flash", promptVersion: "12", jobMatchMicros: 72_720, resumeMicros: 64_500, coverMicros: 47_250 }, generationAvailable: true },
    // Most tests here exercise the résumé-only path; the policy default (true) has its own test.
    coverLetterRequired: false,
    appOrigin: "https://app.example.com",
    ...rest,
    detail
  };
}

async function withPage(overrides: PageOverrides, run: (harness: ReturnType<typeof createDomHarness>) => Promise<void>) {
  const harness = createDomHarness({ fetch: (async () => new Response("{}")) as typeof fetch, confirm: () => true });
  // react-dom's fallback input listener calls the IE-only attachEvent/detachEvent.
  Object.assign(harness.window.HTMLElement.prototype, { attachEvent() {}, detachEvent() {} });
  try {
    await harness.render(React.createElement(ApplyPage, await pageProps(overrides)));
    await run(harness);
  } finally {
    await harness.close();
  }
}

test("apply page shows Step 1 of 10 · Your match for an unscored job", async () => {
  const progress = deriveApplyProgress({ ...PROGRESS_INPUT, hasCurrentMatch: false });
  await withPage({ progress, detail: { estimate: null } }, async (harness) => {
    const now = harness.container.querySelector("[data-now-card]")!;
    assert.match(now.querySelector("h2")?.textContent ?? "", /^Step 1 of 10 · Your match$/u);
    assert.match(now.textContent ?? "", /Next: Your experience/u);
    const states = [...now.querySelectorAll("ol > li")].map((item) => item.getAttribute("data-state"));
    assert.equal(states.length, 10);
    assert.equal(states[0], "now");
    assert.equal(states[1], "later");
    const step1 = harness.container.querySelector("#step-1")!;
    assert.match(step1.textContent ?? "", /Not scored yet/u);
    assert.ok([...step1.querySelectorAll("button")].some((button) => button.textContent?.includes("Check my match")), "Scoring happens at step 1");
    assert.equal(step1.querySelector("[data-match-result]"), null);
    for (const id of ["#step-2", "#step-3", "#step-4"]) assert.ok(harness.container.querySelector(id), id);
  });
});

test("step 1 reads the grade, fit and confidence, and says what Assisted Fill needs", () => {
  assert.equal(matchResultLine(68, 90), "C · fit 68, confidence 90. Assisted Fill needs an A, with confidence of 85 or more.");
  assert.equal(matchResultLine(90, 70), "A · fit 90, confidence 70. Assisted Fill needs an A, with confidence of 85 or more.");
  assert.equal(matchResultLine(90, 85), "A · fit 90, confidence 85.");
  assert.equal(matchResultLine(72, null), "B · fit 72. Assisted Fill needs an A, with confidence of 85 or more.");
});

test("a scored job shows the result line, and Apply on my own holds the Apply Kit", async () => {
  await withPage({}, async (harness) => {
    assert.match(harness.container.querySelector("#step-1 [data-match-result]")?.textContent ?? "", /^C · fit 68, confidence 90\./u);
    const own = [...harness.container.querySelectorAll("details")].find((node) => node.querySelector(":scope > summary")?.textContent === "Apply on my own")!;
    assert.equal(own.querySelector("summary")?.textContent, "Apply on my own");
    assert.ok(own.textContent && own.textContent.length > "Apply on my own".length);
    const step4 = harness.container.querySelector("#step-4")!;
    assert.equal(step4.querySelector("h2")?.textContent, "Prepare");
    assert.match(step4.textContent ?? "", /Assisted apply isn't switched on for this server/u, "no automation, no Prepare");
    assert.equal(harness.maybeButton("Allow and prepare") === undefined, true);
  });
});

test("step 4 is Prepare: the server's ready list and one Allow and prepare", async () => {
  await withPage({ automationAvailable: true, detail: { application: ATTACHED } }, async (harness) => {
    const step4 = harness.container.querySelector("#step-4")!;
    assert.ok(step4.querySelector("[data-prepare-step]"));
    assert.deepEqual([...step4.querySelectorAll("[data-ready-line]")].map((line) => [line.getAttribute("data-ready-line"), line.getAttribute("data-ok")]), [
      ["fit_below_threshold", "true"], ["match_confidence_below_threshold", "true"], ["resume_required", "true"],
      ["cover_letter_required", "true"], ["host_blocked", "true"], ["application_details", "true"]
    ]);
    assert.equal(harness.button("Allow and prepare").disabled, false);
    assert.equal(step4.querySelector('a[href^="/applications/"]') === null, true, "Prepare happens here now, not on the application page");
  });
  const fillOn = prepareStateFromFacts({ ...PREPARE_FACTS, policy: { ...PREPARE_FACTS.policy, mode: "FILL_AND_REVIEW" } });
  await withPage({ automationAvailable: true, detail: { application: ATTACHED }, prepare: fillOn }, async (harness) => {
    assert.equal(harness.button("Allow and prepare").disabled, true);
    assert.ok(harness.button("Turn off"));
  });
  await withPage({ automationAvailable: true, detail: { application: ATTACHED }, kitPatch: { canRecordApplied: false } }, async (harness) => {
    assert.equal(harness.maybeButton("Allow and prepare") === undefined, true, "nothing to prepare once applied");
  });
});

test("step 4's state mirrors Prepare's gates: the reviewed match, documents, policy and host", () => {
  const ready = prepareStateFromFacts(PREPARE_FACTS);
  assert.equal(ready.applyHost, "jobs.example.com");
  assert.equal(ready.fillMode, "PREPARE_ONLY");
  assert.equal(ready.run, null);
  assert.ok(ready.readyList.every((line) => line.ok));

  // A match not bound to the saved review doesn't count, whatever its score.
  const unreviewed = prepareStateFromFacts({ ...PREPARE_FACTS, estimate: { score: 95, basis: "MASTER_RESUME" } });
  assert.equal(unreviewed.readyList.find((line) => line.key === "fit_below_threshold")?.ok, false);
  // The policy's own thresholds, cover rule and block list.
  const strict = prepareStateFromFacts({ ...PREPARE_FACTS, policy: { ...PREPARE_FACTS.policy, minimumFitScore: 95, coverLetterRequired: false, blockedHosts: ["example.com"] } });
  assert.equal(strict.readyList.find((line) => line.key === "fit_below_threshold")?.ok, false);
  assert.equal(strict.readyList.some((line) => line.key === "cover_letter_required"), false);
  assert.equal(strict.readyList.find((line) => line.key === "host_blocked")?.ok, false);
  // Missing details name what's missing and never block.
  const missing = prepareStateFromFacts({ ...PREPARE_FACTS, details: { ...PREPARE_FACTS.details, missingRequired: ["Phone number"] } });
  const details = missing.readyList.find((line) => line.key === "application_details");
  assert.equal(details?.blocking, false);
  assert.match(details?.text ?? "", /Phone number/u);

  // Once a run exists, its own host is the one asked about; no usable link gives no host.
  const withRun = prepareStateFromFacts({
    ...PREPARE_FACTS,
    run: { id: "run-1", state: "BLOCKED", applyHost: "apply.example.org", blockingReason: "fit_below_threshold", errorCategory: null }
  });
  assert.equal(withRun.applyHost, "apply.example.org");
  assert.deepEqual(withRun.run, { id: "run-1", state: "BLOCKED", blockingReason: "fit_below_threshold", errorCategory: null });
  assert.equal(prepareStateFromFacts({ ...PREPARE_FACTS, jobApplyHost: null }).applyHost, "");

  // An attached document Prepare wouldn't accept (out of date, or edited and unconfirmed) isn't ready.
  const notReady = prepareStateFromFacts({ ...PREPARE_FACTS, documents: { resume: "out_of_date", cover: "needs_review" } });
  assert.deepEqual(notReady.readyList.filter((line) => !line.ok).map((line) => [line.key, line.text]), [
    ["resume_required", "Your attached résumé is out of date. Write a new one in step 3."],
    ["cover_letter_required", "Your attached cover letter needs your review before it can be used. Review it in step 3."]
  ]);
});

test("progress facts map the way the plan says", () => {
  const base = {
    hasMasterResume: true, estimateBasis: "MASTER_RESUME" as const, application: null,
    documents: { resume: "none", cover: "none" } as const, coverRequired: true, automationAvailable: false, run: null
  };
  assert.equal(applyProgressFromFacts({ ...base, estimateBasis: null }).current, 1);
  assert.equal(applyProgressFromFacts(base).current, 2);
  assert.equal(applyProgressFromFacts({ ...base, estimateBasis: "REVIEWED_EVIDENCE" }).current, 3);
  const attached = { status: "INTERESTED", resumeVersionId: "r", coverLetterVersionId: null };
  const resumeReady = { resume: "ready", cover: "none" } as const;
  assert.equal(applyProgressFromFacts({ ...base, estimateBasis: "REVIEWED_EVIDENCE", application: attached, documents: resumeReady }).current, 3);
  assert.equal(applyProgressFromFacts({ ...base, estimateBasis: "REVIEWED_EVIDENCE", application: attached, documents: resumeReady, coverRequired: false }).current, 4);
  // Attached isn't enough: Prepare accepts only a document that is ready to use.
  for (const resume of ["out_of_date", "needs_review"] as const) {
    assert.equal(applyProgressFromFacts({ ...base, estimateBasis: "REVIEWED_EVIDENCE", application: attached, documents: { resume, cover: "none" }, coverRequired: false }).current, 3, resume);
  }
  assert.equal(applyProgressFromFacts({ ...base, estimateBasis: "REVIEWED_EVIDENCE", application: { ...attached, status: "APPLIED" } }).current, 10);
  assert.equal(applyProgressFromFacts({ ...base, estimateBasis: "REVIEWED_EVIDENCE", application: { ...attached, status: "REJECTED" } }).steps.every((step) => step.state === "done"), true);
});

test("an attached document counts only when it is ready to use, by the readiness Prepare uses", async () => {
  const versions = [
    { id: "resume-ready", evidenceCurrent: true, review: { state: "EVIDENCE_CURRENT" } },
    { id: "resume-stale", evidenceCurrent: false, review: { state: "EVIDENCE_STALE" } },
    { id: "resume-edited", evidenceCurrent: false, review: { state: "EDITED_NEEDS_REVIEW" } }
  ] as const;
  assert.equal(attachedDocumentState(null, versions), "none");
  assert.equal(attachedDocumentState("resume-ready", versions), "ready");
  assert.equal(attachedDocumentState("resume-stale", versions), "out_of_date");
  assert.equal(attachedDocumentState("resume-edited", versions), "needs_review");
  assert.equal(attachedDocumentState("not-this-job", versions), "out_of_date", "a version Prepare can't find for this job isn't ready either");

  // The loader reads it from the job's own versions: an attached but out-of-date résumé keeps
  // progress at step 3 and gives step 4's ready list the reason.
  type Delegates = {
    applicationAutomationPolicy: { findUnique: unknown };
    applicationAnswer: { findMany: unknown };
    resume: { findMany: unknown };
    application: { findFirst: unknown };
    applicationRun: { findFirst: unknown };
  };
  const delegates = prisma as unknown as Delegates;
  const originals = [
    delegates.applicationAutomationPolicy.findUnique, delegates.applicationAnswer.findMany, delegates.resume.findMany,
    delegates.application.findFirst, delegates.applicationRun.findFirst
  ] as const;
  const applicationId = "clz8w7m9a0004qwer1234tyui";
  const detail = {
    application: { id: applicationId, statusLabel: "Saved", resumeVersionId: "resume-stale", coverLetterVersionId: null },
    resumeVersions: versions, coverLetters: [], sourceText: "Service operations leader.", currentConfidenceScore: 90,
    applyHost: "jobs.example.com", estimate: { score: 90, basis: "REVIEWED_EVIDENCE" }
  } as unknown as JobDetail;
  try {
    delegates.applicationAutomationPolicy.findUnique = async () => ({ ...automationPolicyDefaultValues(), coverLetterRequired: false });
    delegates.applicationAnswer.findMany = async () => [];
    delegates.resume.findMany = async () => [];
    delegates.application.findFirst = async () => ({ status: "SAVED", resumeVersionId: "resume-stale", coverLetterVersionId: null });
    delegates.applicationRun.findFirst = async () => null;
    const state = await loadApplyPageState("user-synthetic-alex-rivera", detail);
    assert.equal(state.progress.current, 3);
    assert.equal(state.progressInput.resumeAttached, false);
    assert.equal(state.prepare.readyList.find((line) => line.key === "resume_required")?.text, "Your attached résumé is out of date. Write a new one in step 3.");
    assert.equal((await loadApplyProgress("user-synthetic-alex-rivera", detail)).current, 3, "the job and application pages agree");
  } finally {
    [
      delegates.applicationAutomationPolicy.findUnique, delegates.applicationAnswer.findMany, delegates.resume.findMany,
      delegates.application.findFirst, delegates.applicationRun.findFirst
    ] = originals;
  }
});

const REVIEWED = {
  application: ATTACHED,
  hasValidCurrentSnapshot: true,
  estimate: { score: 90, basis: "REVIEWED_EVIDENCE", scoredAt: "2026-11-05T10:00:00.000Z", compensation: { score: null, explanation: "Unknown." }, resumeAngle: "", coverLetterAngle: "" }
};

const VERSION = { id: "resume-version-1", title: "Example tailored résumé", fullText: "Alex Rivera\nService operations leader.", summary: null, atsCompatibility: null, jobFitScore: null, evidenceCurrent: true, createdAt: "2026-11-05T11:00:00.000Z" };

test("after a partial run the refreshed page keeps step 3's outcome message", async () => {
  const fetchStub = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/evidence-snapshots")) {
      return new Response(JSON.stringify({
        schema: "apply-pilot/evidence-snapshot-save-response/v1",
        snapshot: { id: "snapshot-1", hash: "b".repeat(64), createdAt: "2026-11-05T12:00:00.000Z", isCurrent: true },
        replayed: false,
        invalidations: { assessmentIds: ["analysis-1"], resumeDocumentIds: [], coverLetterDocumentIds: [], totalCount: 1, reason: "EVIDENCE_SNAPSHOT_CHANGED" }
      }), { status: 201 });
    }
    if (!new Headers(init?.headers).get("x-ai-cost-confirmed")) {
      return new Response(JSON.stringify({ code: "AI_COST_CONFIRMATION_REQUIRED", maximumCostMicros: 1, dataType: "application_packet" }), { status: 428 });
    }
    return new Response(JSON.stringify({ error: "The writer is unavailable.", billingStatus: "not_charged" }), { status: 503 });
  }) as typeof fetch;
  const harness = createDomHarness({ fetch: fetchStub, confirm: () => { throw new Error("window.confirm must not run"); } });
  try {
    await harness.render(React.createElement(ApplyPage, await pageProps({ detail: REVIEWED })));
    await harness.click(harness.button("Write my résumé · up to 7¢"));
    await harness.waitForText(/Most it can cost: 7¢/u);
    await harness.click(harness.button("Confirm"));
    await harness.waitForText(/The writer is unavailable/u);
    const next = await pageProps({ detail: REVIEWED });
    // What router.refresh() delivers: the same documents with a new review identity.
    await harness.render(React.createElement(ApplyPage, {
      ...next, detail: { ...next.detail, evidenceReview: { ...next.detail.evidenceReview!, analysisId: "analysis-2" } }
    }));
    assert.match(harness.container.querySelector("#step-3")?.textContent ?? "", /The writer is unavailable\. You weren't charged for this step\./u);
  } finally {
    await harness.close();
  }
});

test("step 2 is Your experience: one box per requirement, and step 3 only writes documents", async () => {
  await withPage({}, async (harness) => {
    const step2 = harness.container.querySelector("#step-2")!;
    assert.equal(step2.querySelector("h2")?.textContent, "Your experience");
    assert.equal(step2.querySelector("[data-experience-step]") !== null, true);
    assert.deepEqual([...step2.querySelectorAll("fieldset[data-requirement] legend")].map((node) => node.textContent),
      ["Current Quenby certification", "Working knowledge of SQL"]);
    assert.ok([...step2.querySelectorAll("button")].some((button) => button.textContent === "Nothing to add · update my score"));
    assert.equal(harness.container.querySelector("fieldset[data-gap]") === null, true, "the old three-way gap list is gone from the page");
    const step3 = harness.container.querySelector("#step-3")!;
    assert.ok(step3.querySelector("[data-documents-step]"), "step 3 is Your documents");
    assert.ok([...step3.querySelectorAll("button")].some((button) => button.textContent === "Write my résumé · up to 7¢"));
    await harness.type(step2.querySelector("textarea"), "Earned the Quenby certification in 2024.");
    assert.equal(harness.window.localStorage.getItem("apply-pilot:experience:0123456789abcdef:job-1") !== null, true, "drafts use the server's user key");
  });
  await withPage({ detail: { hasValidCurrentSnapshot: true, estimate: { score: 90, basis: "REVIEWED_EVIDENCE", scoredAt: "2026-11-05T10:00:00.000Z", compensation: { score: null, explanation: "Unknown." }, resumeAngle: "", coverLetterAngle: "" } } }, async (harness) => {
    assert.equal(harness.container.querySelector("#step-2 [data-experience-done]")?.textContent, "Done");
  });
  await withPage({ detail: { evidenceReview: null } }, async (harness) => {
    assert.match(harness.container.querySelector("#step-2")?.textContent ?? "", /needs your master résumé/u);
    assert.equal(harness.container.querySelector("#step-3 [data-blocked-reason]")?.textContent, "Add your master résumé first, so Apply Pilot has facts to work from.");
  });
});

test("unsaved lines in step 2 hold back the documents in step 3", async () => {
  await withPage({ detail: { resumeVersions: [VERSION] } }, async (harness) => {
    assert.doesNotMatch(harness.text(), /these documents don.t include yet/u);
    await harness.type(harness.container.querySelector("#step-2 textarea"), "Earned the Quenby certification in 2024.");
    assert.match(harness.container.querySelector("#step-3")?.textContent ?? "", /these documents don.t include yet/u);
  });
});

function recordingPage(detail: Record<string, unknown>) {
  const calls: Array<{ url: string; confirmed: string | null }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const confirmed = new Headers(init?.headers).get("x-ai-cost-confirmed");
    calls.push({ url, confirmed });
    if (!confirmed) {
      return new Response(JSON.stringify({ code: "AI_COST_CONFIRMATION_REQUIRED", maximumCostMicros: 1, dataType: "application_packet" }), { status: 428 });
    }
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  const harness = createDomHarness({ fetch: fetchImpl, confirm: () => { throw new Error("window.confirm must not run"); } });
  Object.assign(harness.window.HTMLElement.prototype, { attachEvent() {}, detachEvent() {} });
  return {
    calls,
    harness,
    render: async () => harness.render(React.createElement(ApplyPage, await pageProps({ detail: { application: ATTACHED, ...detail } })))
  };
}

const step3Reason = (harness: ReturnType<typeof createDomHarness>) =>
  harness.container.querySelector("#step-3 [data-blocked-reason]")?.textContent ?? null;

test("step 3 waits for step 2: without a saved review its Write is blocked and sends nothing", async () => {
  const { harness, calls, render } = recordingPage({});
  try {
    await render();
    const create = harness.button("Write my résumé · up to 7¢");
    assert.equal(create.disabled, true);
    assert.equal(step3Reason(harness), "Update my score in step 2 first, so your documents use your reviewed lines.");
    await harness.click(create);
    assert.equal(calls.length, 0);
  } finally {
    await harness.close();
  }
});

test("step 3 waits for step 2: unsaved lines block Write until they're saved", async () => {
  const { harness, calls, render } = recordingPage(REVIEWED);
  try {
    await render();
    assert.equal(harness.button("Write my résumé · up to 7¢").disabled, false);
    await harness.type(harness.container.querySelector("#step-2 textarea"), "Earned the Quenby certification in 2024.");
    assert.equal(harness.button("Write my résumé · up to 7¢").disabled, true);
    assert.equal(step3Reason(harness), "Update my score in step 2 first, so your documents include your new lines.");
    await harness.click(harness.button("Write my résumé · up to 7¢"));
    assert.equal(calls.length, 0);
    await harness.type(harness.container.querySelector("#step-2 textarea"), "");
    assert.equal(harness.button("Write my résumé · up to 7¢").disabled, false);
  } finally {
    await harness.close();
  }
});

test("with step 2 done, step 3's Write sends only the document requests, never a save", async () => {
  const { harness, calls, render } = recordingPage(REVIEWED);
  try {
    await render();
    assert.equal(step3Reason(harness), null);
    const cover = [...harness.container.querySelectorAll("#step-3 label")].find((node) => node.textContent === "Include a cover letter")!.querySelector("input");
    await harness.check(cover);
    await harness.click(harness.button("Write my résumé and cover letter · up to 12¢"));
    await harness.waitForText(/Most it can cost: 12¢/u);
    assert.equal(calls.length, 0);
    await harness.click(harness.button("Confirm"));
    await harness.waitForText(/ready to review/u);
    assert.deepEqual(calls.map((call) => [call.url.split("/").at(-1), call.confirmed]), [
      ["tailored-resume", null], ["tailored-resume", "true"], ["cover-letter", null], ["cover-letter", "true"]
    ]);
    assert.equal(calls.some((call) => call.url.endsWith("/evidence-snapshots")), false);
  } finally {
    await harness.close();
  }
});

test("a ready tailored résumé offers the cover letter on its own; an outdated one does not", async () => {
  await withPage({ detail: { ...REVIEWED, resumeVersions: [VERSION] } }, async (harness) => {
    assert.equal(harness.button("Write my cover letter · up to 5¢").disabled, false);
    assert.equal(harness.button("Write my résumé · up to 7¢").disabled, false);
  });
  const outdatedOnly = (await pageProps()).kit.resumes.filter((document) => !document.exportReady);
  await withPage({ detail: { ...REVIEWED, resumeVersions: [{ ...VERSION, evidenceCurrent: false }] }, kitPatch: { resumes: outdatedOnly } }, async (harness) => {
    assert.equal(harness.maybeButton(/^Write my cover letter/u), undefined);
    assert.ok(harness.button("Write my résumé · up to 7¢"));
  });
});

test("ready documents appear on the Apply page under step 3, ahead of Apply on my own", async () => {
  await withPage({ detail: { resumeVersions: [VERSION] } }, async (harness) => {
    const documents = harness.container.querySelector("#step-3 #apply-documents")!;
    assert.match(documents.textContent ?? "", /Review and edit/u);
    assert.ok(documents.querySelector("[data-product-documents]"));
    assert.ok(harness.button("Write my résumé · up to 7¢"));
  });
});

test("#step-3 exists even before any document does, so the Apply Kit's fix link has a target", async () => {
  await withPage({}, async (harness) => {
    assert.equal(harness.container.querySelector("#step-3") !== null, true);
    assert.equal(harness.container.querySelector("#apply-documents") === null, true);
  });
});

function attachRecorder() {
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ method, url: String(input), body: init?.body ? JSON.parse(String(init.body)) : null });
    if (String(input) === "/api/applications" && method === "POST") return new Response(JSON.stringify({ application: { id: "application-new" } }), { status: 201 });
    return new Response(JSON.stringify({ application: {} }), { status: 200 });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

// Lets step 3's mount attach run to the end.
async function settled() {
  for (let tick = 0; tick < 10; tick += 1) await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 0)); });
}

test("step 3 attaches to the job's own application: what it has attached, no second save, nothing once applied", async () => {
  // An INTERESTED application with only a résumé attached: the ready letter is added, the status is left alone.
  const interested = attachRecorder();
  let harness = createDomHarness({ fetch: interested.fetchImpl });
  try {
    await harness.render(React.createElement(ApplyPage, await pageProps({
      detail: { application: { id: "application-1", statusLabel: "Interested", resumeVersionId: "resume-v2", coverLetterVersionId: null } }
    })));
    await settled();
    assert.deepEqual(interested.calls.map((call) => [call.method, call.url, call.body]), [
      ["PATCH", "/api/applications/application-1", { coverLetterVersionId: "cover-legacy" }]
    ]);
    const step3 = harness.container.querySelector("#step-3")!;
    assert.match(step3.querySelector('[data-version="resume-v2"]')?.textContent ?? "", /Used for this application/u);
    assert.equal(step3.querySelector("[data-below-a]")?.textContent, BELOW_A, "a C is below an A");
  } finally {
    await harness.close();
  }
  // No application yet: the job is saved once, then the ready versions are attached.
  const none = attachRecorder();
  harness = createDomHarness({ fetch: none.fetchImpl });
  try {
    await harness.render(React.createElement(ApplyPage, await pageProps({ detail: { ...REVIEWED, application: null } })));
    await settled();
    assert.deepEqual(none.calls.map((call) => [call.method, call.url]), [["POST", "/api/applications"], ["PATCH", "/api/applications/application-new"]]);
    assert.equal(harness.container.querySelector("#step-3 [data-below-a]"), null, "an A doesn't get the sentence");
  } finally {
    await harness.close();
  }
  // Applied: what's attached stays as it is.
  const applied = attachRecorder();
  harness = createDomHarness({ fetch: applied.fetchImpl });
  try {
    await harness.render(React.createElement(ApplyPage, await pageProps({
      detail: { application: { id: "application-1", statusLabel: "Applied", resumeVersionId: "resume-v1", coverLetterVersionId: null } },
      kitPatch: { canRecordApplied: false }
    })));
    await settled();
    assert.deepEqual(applied.calls, []);
  } finally {
    await harness.close();
  }
});

test("step 3 blocked while its question is open: Confirm sends nothing", async () => {
  const { harness, calls, render } = recordingPage(REVIEWED);
  try {
    await render();
    await harness.click(harness.button("Write my résumé · up to 7¢"));
    await harness.waitForText(/Most it can cost: 7¢/u);
    // Step 2 becomes pending while the question is still open.
    await harness.type(harness.container.querySelector("#step-2 textarea"), "Earned the Quenby certification in 2024.");
    await harness.click(harness.button("Confirm"));
    await settled();
    assert.deepEqual(calls, []);
    assert.match(harness.container.querySelector("#step-3 [data-documents-message]")?.textContent ?? "", /^Update my score in step 2 first/u);
  } finally {
    await harness.close();
  }
});

test("the cover-letter tick follows the account's rule: on when Prepare needs a cover letter", async () => {
  await withPage({ detail: REVIEWED, coverLetterRequired: true }, async (harness) => {
    const tick = [...harness.container.querySelectorAll("#step-3 label")].find((node) => node.textContent === "Include a cover letter")!.querySelector("input")!;
    assert.equal(tick.checked, true);
    assert.ok(harness.button("Write my résumé and cover letter · up to 12¢"));
  });
  await withPage({ detail: REVIEWED, coverLetterRequired: false }, async (harness) => {
    assert.ok(harness.button("Write my résumé · up to 7¢"));
  });
});

test("the Apply page's server state carries the cover-letter rule (default on) and step 4's state", async () => {
  type Delegates = {
    applicationAutomationPolicy: { findUnique: unknown };
    applicationAnswer: { findMany: unknown };
    resume: { findMany: unknown };
  };
  const delegates = prisma as unknown as Delegates;
  const originals = [delegates.applicationAutomationPolicy.findUnique, delegates.applicationAnswer.findMany, delegates.resume.findMany] as const;
  const detail = {
    application: null, sourceText: "Service operations leader.", estimate: null, currentConfidenceScore: null, applyHost: "jobs.example.com"
  } as unknown as JobDetail;
  try {
    delegates.applicationAutomationPolicy.findUnique = async () => null;
    delegates.applicationAnswer.findMany = async () => [];
    delegates.resume.findMany = async () => [];
    const defaults = await loadApplyPageState("user-synthetic-alex-rivera", detail);
    assert.equal(defaults.coverLetterRequired, true);
    assert.equal(defaults.progress.current, 1);
    assert.equal(defaults.prepare.applyHost, "jobs.example.com");
    assert.equal(defaults.prepare.run, null);
    assert.equal(defaults.prepare.readyList.find((line) => line.key === "application_details")?.ok, false, "no details saved yet");
    delegates.applicationAutomationPolicy.findUnique = async () => ({ ...automationPolicyDefaultValues(), coverLetterRequired: false });
    assert.equal((await loadApplyPageState("user-synthetic-alex-rivera", detail)).coverLetterRequired, false);
  } finally {
    [delegates.applicationAutomationPolicy.findUnique, delegates.applicationAnswer.findMany, delegates.resume.findMany] = originals;
  }
});

function costResponse() {
  return new Response(JSON.stringify({ code: "AI_COST_CONFIRMATION_REQUIRED", maximumCostMicros: 72_720 }), { status: 428 });
}

test("step 1 asks in the page, not with window.confirm", async () => {
  const requests: RequestInit[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (!String(input).endsWith("/match")) return new Response("{}");
    requests.push(init ?? {});
    return new Headers(init?.headers).get("x-ai-cost-confirmed") === "true" ? new Response("{}", { status: 200 }) : costResponse();
  }) as typeof fetch;
  let windowConfirms = 0;
  const harness = createDomHarness({ fetch: fetchImpl, confirm: () => { windowConfirms += 1; return true; } });
  await harness.render(React.createElement(ApplyPage, await pageProps({ progress: deriveApplyProgress({ ...PROGRESS_INPUT, hasCurrentMatch: false }), detail: { estimate: null } })));
  try {
    await harness.click(harness.button(/Check my match · about 8¢/));
    await harness.waitForText(/could cost up to/);
    assert.equal(requests.length, 1);
    assert.equal(harness.container.querySelectorAll('[role="group"]').length >= 1, true);
    await harness.click(harness.button("Cancel"));
    assert.equal(requests.length, 1);
    await harness.click(harness.button(/Check my match/));
    await harness.waitForText(/could cost up to/);
    assert.equal(requests.length, 2);
    await harness.click(harness.button("Confirm"));
    await harness.waitForText(/Scored/);
    assert.equal(requests.length, 3);
    assert.equal(new Headers(requests[2].headers).get("x-ai-cost-confirmed"), "true");
    assert.equal(windowConfirms, 0);
  } finally {
    await harness.close();
  }
});

test("a saved empty review whose re-score failed keeps a way on: step 2's own Update my score only re-scores", async () => {
  // What the page shows after "Nothing to add · update my score" saved the review but the re-score
  // failed: the estimate predates the review (no new lines), and there is no analysis to review.
  const unreviewable = buildEvidenceCorrectionReview({
    jobId: "job-1", resumeId: "resume-1", resumeUpdatedAt: "2026-11-01T10:00:00.000Z",
    resume: { rawText: "Service operations leader." }, analysisId: null, analysisOutput: null
  });
  const calls: Array<{ url: string; confirmed: string | null }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const confirmed = new Headers(init?.headers).get("x-ai-cost-confirmed");
    calls.push({ url, confirmed });
    if (url.endsWith("/match") && !confirmed) return costResponse();
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  const harness = createDomHarness({ fetch: fetchImpl, confirm: () => { throw new Error("window.confirm must not run"); } });
  try {
    await harness.render(React.createElement(ApplyPage, await pageProps({
      detail: {
        application: ATTACHED,
        hasValidCurrentSnapshot: true,
        evidenceReview: unreviewable,
        estimate: { score: 68, basis: "MASTER_RESUME_NO_NEW_FACTS", scoredAt: "2026-11-05T10:00:00.000Z", compensation: { score: null, explanation: "Unknown." }, resumeAngle: "", coverLetterAngle: "" }
      }
    })));
    await settled();
    calls.length = 0;
    const step2 = harness.container.querySelector("#step-2")!;
    assert.match(step2.textContent ?? "", /Your review is saved\. Update my score to continue\./u);
    assert.equal(step3Reason(harness), "Update my score in step 2 first, so your documents use your reviewed lines.");
    const update = [...step2.querySelectorAll("button")].find((button) => button.textContent === "Update my score · about 8¢");
    assert.ok(update, "step 2 offers the re-score itself");
    await harness.click(update);
    await harness.waitForText(/could cost up to \$0\.07272/u);
    assert.equal(calls.length, 0, "nothing is sent before the in-page Confirm");
    await harness.click(harness.button("Confirm"));
    await harness.waitForText(/Your score was updated\./u);
    assert.deepEqual(calls.map((call) => [call.url, call.confirmed]), [["/api/jobs/job-1/match", null], ["/api/jobs/job-1/match", "true"]]);
    assert.equal(harness.refreshes, 1);
  } finally {
    await harness.close();
  }
});

test("step 5 waits for Prepare, then shows the start command for the prepared run", async () => {
  await withPage({}, async (harness) => {
    assert.match(harness.container.querySelector("#step-5")?.textContent ?? "", /After Prepare, start the Apply Pilot browser here\./u);
    assert.equal(harness.container.querySelector("[data-browser-step]"), null);
  });
  const prepared = prepareStateFromFacts({ ...PREPARE_FACTS, run: { id: "clz8w7m9a0004qwer1234tyui", applyHost: "jobs.example.com", state: "READY", blockingReason: null, errorCategory: null } } as never);
  await withPage({ prepare: prepared }, async (harness) => {
    const command = harness.container.querySelector("#step-5 [data-browser-start-command]");
    assert.equal(command?.textContent, "npm run application-browser -- --app-origin https://app.example.com --run-id clz8w7m9a0004qwer1234tyui");
  });
});

const RUN_ID = "clz8w7m9a0004qwer1234tyui";
const START_COMMAND = `npm run application-browser -- --app-origin https://app.example.com --run-id ${RUN_ID}`;
const runAt = (state: string) =>
  prepareStateFromFacts({ ...PREPARE_FACTS, run: { id: RUN_ID, applyHost: "jobs.example.com", state, blockingReason: null, errorCategory: null } } as never);

test("step 5 keeps the start command and sign-in code for a run anywhere from READY to submitting", async () => {
  for (const state of ["READY", "REVIEW_REQUIRED", "FILLING", "READY_FOR_USER_SUBMISSION"]) {
    await withPage({ prepare: runAt(state) }, async (harness) => {
      const step5 = harness.container.querySelector("#step-5")!;
      assert.equal(step5.querySelector("[data-browser-start-command]")?.textContent, START_COMMAND, state);
      assert.ok(step5.querySelector('[data-testid="companion-code-button"]'), `${state}: the sign-in code`);
      assert.doesNotMatch(step5.textContent ?? "", /After Prepare/u, state);
    });
  }
  for (const state of ["DRAFT", "BLOCKED", "PREPARING", "CANCELLED"]) {
    await withPage({ prepare: runAt(state) }, async (harness) => {
      assert.equal(harness.container.querySelector("#step-5 [data-browser-step]"), null, state);
    });
  }
});

test("without an app origin, step 5 still says how to continue and offers the sign-in code", async () => {
  await withPage({ prepare: runAt("FILLING"), appOrigin: null }, async (harness) => {
    const step5 = harness.container.querySelector("#step-5")!;
    const text = step5.textContent ?? "";
    assert.doesNotMatch(text, /After Prepare/u);
    assert.equal(step5.querySelector("[data-browser-start-command]")?.textContent,
      `npm run application-browser -- --app-origin <this site's address> --run-id ${RUN_ID}`);
    assert.match(text, /address bar/u);
    assert.ok(step5.querySelector('[data-testid="companion-code-button"]'), "the sign-in code");
  });
});

test("step 5 follows the run's live state when you come back to the tab", async () => {
  const liveState = { value: "READY" };
  const fetchImpl = (async (input: RequestInfo | URL) => String(input) === `/api/application-runs/${RUN_ID}`
    ? new Response(JSON.stringify({ run: { state: liveState.value } }), { status: 200 })
    : new Response("{}")) as typeof fetch;
  const harness = createDomHarness({ fetch: fetchImpl, confirm: () => true });
  try {
    // Loaded while Prepare was still running; the run has since been prepared.
    await harness.render(React.createElement(ApplyPage, await pageProps({
      prepare: runAt("PREPARING"),
      progressInput: { ...PROGRESS_INPUT, reviewSaved: true, resumeAttached: true, run: { state: "PREPARING", companionState: null } }
    })));
    await settled();
    assert.equal(harness.container.querySelector("#step-5 [data-browser-start-command]")?.textContent, START_COMMAND);
    // Cancelled in the other window: the way in goes.
    liveState.value = "CANCELLED";
    Object.defineProperty(harness.window.document, "visibilityState", { configurable: true, value: "visible" });
    await act(async () => { harness.window.document.dispatchEvent(new harness.window.Event("visibilitychange")); });
    await settled();
    assert.equal(harness.container.querySelector("#step-5 [data-browser-step]"), null);
  } finally {
    await harness.close();
  }
});

test("without application automation, the Now card points to Apply on my own, which opens by default", async () => {
  const atPrepare = { ...PROGRESS_INPUT, reviewSaved: true, resumeAttached: true, coverAttached: true };
  const ownDetails = (harness: ReturnType<typeof createDomHarness>) =>
    [...harness.container.querySelectorAll("details")].find((node) => node.querySelector(":scope > summary")?.textContent === "Apply on my own")!;
  await withPage({ detail: REVIEWED, progress: deriveApplyProgress({ ...atPrepare, automationAvailable: false }) }, async (harness) => {
    assert.match(harness.container.querySelector("[data-now-card]")?.textContent ?? "", /Apply on your own with your documents: open Apply on my own\./u);
    assert.equal(ownDetails(harness).open, true);
  });
  await withPage({ detail: REVIEWED, automationAvailable: true, progress: deriveApplyProgress({ ...atPrepare, automationAvailable: true }) }, async (harness) => {
    assert.match(harness.container.querySelector("[data-now-card]")?.textContent ?? "", /Allow and prepare/u);
    assert.equal(ownDetails(harness).open, false);
  });
});
