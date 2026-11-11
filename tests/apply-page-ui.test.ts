import "@/tests/fixtures/dom-globals";
import assert from "node:assert/strict";
import test from "node:test";
import React from "react";

import { ApplyPage, matchResultLine, type ApplyPageProps } from "@/components/apply-page/apply-page";
import { loadApplyKitView } from "@/lib/apply-kit/apply-kit-view";
import { deriveApplyProgress, type ApplyProgressInput } from "@/lib/apply-page/apply-progress";
import { applyProgressFromFacts } from "@/lib/apply-page/load-apply-progress";
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

const PROGRESS_INPUT: ApplyProgressInput = {
  hasMasterResume: true, hasCurrentMatch: true, reviewSaved: false, resumeAttached: false, coverAttached: false,
  coverRequired: true, automationAvailable: false, run: null, applied: false
};

const review = () => buildEvidenceCorrectionReview({
  jobId: "job-1", resumeId: "resume-1", resumeUpdatedAt: "2026-11-01T10:00:00.000Z",
  resume: { rawText: "Service operations leader." }, analysisId: "analysis-1", analysisInputHash: "a".repeat(64),
  analysisModel: "gemini-3.8-flash", analysisPromptVersion: "3.4", analysisOutput: output
});

type PageOverrides = Partial<Omit<ApplyPageProps, "detail">> & { detail?: Record<string, unknown> };

async function pageProps(overrides: PageOverrides = {}): Promise<ApplyPageProps> {
  const kit = (await loadApplyKitView(fakeDb(fixtures()).db, { userId: OWNER, jobId: JOB, aiGenerationAvailable: true }))!;
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
    ...overrides.detail
  } as unknown as JobDetail;
  return {
    kit,
    automationAvailable: false,
    progress: deriveApplyProgress(PROGRESS_INPUT),
    tailorServer: { quote: { provider: "gemini", model: "gemini-3.8-flash", promptVersion: "12", jobMatchMicros: 72_720, resumeMicros: 64_500, coverMicros: 47_250 }, generationAvailable: true },
    ...overrides,
    detail
  };
}

async function withPage(overrides: PageOverrides, run: (harness: ReturnType<typeof createDomHarness>) => Promise<void>) {
  const harness = createDomHarness({ fetch: (async () => new Response("{}")) as typeof fetch, confirm: () => true });
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
    assert.ok([...step1.querySelectorAll("button")].some((button) => button.textContent?.includes("Score this job")), "Scoring happens at step 1");
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
    assert.equal(harness.container.querySelector("#step-4")?.textContent, "", "no Prepare line without an application");
  });
  await withPage({ detail: { application: { id: "application-1", statusLabel: "Saved" } } }, async (harness) => {
    const link = harness.container.querySelector("#step-4 a");
    assert.equal(link?.getAttribute("href"), "/applications/application-1");
    assert.match(harness.container.querySelector("#step-4")?.textContent ?? "", /Prepare this application on its application page for now\./u);
  });
});

test("progress facts map the way the plan says", () => {
  const base = { hasMasterResume: true, estimateBasis: "MASTER_RESUME" as const, application: null, coverRequired: true, automationAvailable: false, run: null };
  assert.equal(applyProgressFromFacts({ ...base, estimateBasis: null }).current, 1);
  assert.equal(applyProgressFromFacts(base).current, 2);
  assert.equal(applyProgressFromFacts({ ...base, estimateBasis: "REVIEWED_EVIDENCE" }).current, 3);
  const attached = { status: "INTERESTED", resumeVersionId: "r", coverLetterVersionId: null };
  assert.equal(applyProgressFromFacts({ ...base, estimateBasis: "REVIEWED_EVIDENCE", application: attached }).current, 3);
  assert.equal(applyProgressFromFacts({ ...base, estimateBasis: "REVIEWED_EVIDENCE", application: attached, coverRequired: false }).current, 4);
  assert.equal(applyProgressFromFacts({ ...base, estimateBasis: "REVIEWED_EVIDENCE", application: { ...attached, status: "APPLIED" } }).current, 10);
  assert.equal(applyProgressFromFacts({ ...base, estimateBasis: "REVIEWED_EVIDENCE", application: { ...attached, status: "REJECTED" } }).steps.every((step) => step.state === "done"), true);
});

const VERSION = { id: "resume-version-1", title: "Example tailored résumé", fullText: "Alex Rivera\nService operations leader.", summary: null, atsCompatibility: null, jobFitScore: null, evidenceCurrent: true, createdAt: "2026-11-05T11:00:00.000Z" };

test("after a partial run the refreshed page keeps the outcome message but resets answers for the new review", async () => {
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
  const harness = createDomHarness({ fetch: fetchStub, confirm: () => true });
  try {
    await harness.render(React.createElement(ApplyPage, await pageProps({})));
    const gap = harness.container.querySelector("fieldset[data-gap]")!;
    await harness.click([...gap.querySelectorAll("label")].find((label) => /^Skip$/u.test(label.textContent ?? ""))?.querySelector("input"));
    await harness.click(harness.button("Create my résumé"));
    await harness.waitForText(/The writer is unavailable/u);
    const refreshed = async (analysisId: string) => {
      const next = await pageProps({});
      return React.createElement(ApplyPage, { ...next, detail: { ...next.detail, hasValidCurrentSnapshot: true, evidenceReview: { ...next.detail.evidenceReview!, analysisId } } });
    };
    // What router.refresh() delivers: the saved review is now in force and bound to a new analysis.
    await harness.render(await refreshed("analysis-2"));
    assert.match(harness.text(), /Your answers were saved\. The writer is unavailable\./u);
    await harness.click([...harness.container.querySelector("fieldset[data-gap]")!.querySelectorAll("label")].find((label) => /I have this/u.test(label.textContent ?? ""))?.querySelector("input"));
    await harness.render(await refreshed("analysis-3"));
    const choice = [...harness.container.querySelector("fieldset[data-gap]")!.querySelectorAll("label")].find((label) => /^Skip$/u.test(label.textContent ?? ""))?.querySelector("input");
    assert.equal(choice?.checked, true, "answers drafted against an older review are cleared");
  } finally {
    await harness.close();
  }
});

test("a ready tailored résumé offers the cover letter on its own; an outdated one does not", async () => {
  await withPage({ detail: { hasValidCurrentSnapshot: true, resumeVersions: [VERSION] } }, async (harness) => {
    assert.equal(harness.button("Create cover letter only").disabled, false);
    assert.equal(harness.button("Create new versions").disabled, false);
  });
  await withPage({ detail: { hasValidCurrentSnapshot: true, resumeVersions: [{ ...VERSION, evidenceCurrent: false }] } }, async (harness) => {
    assert.equal(harness.maybeButton("Create cover letter only"), undefined);
    assert.ok(harness.button("Create new versions"));
  });
});

test("ready documents appear on the Apply page under step 3, ahead of Apply on my own", async () => {
  await withPage({ detail: { resumeVersions: [VERSION] } }, async (harness) => {
    const documents = harness.container.querySelector("#step-3 #documents")!;
    assert.match(documents.textContent ?? "", /Review and edit/u);
    assert.ok(documents.querySelector("[data-product-documents]"));
    assert.ok(harness.button("Create new versions"));
  });
});
