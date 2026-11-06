import "@/tests/fixtures/dom-globals";
import assert from "node:assert/strict";
import test from "node:test";
import React from "react";

import { JobWorkspace, type JobWorkspaceProps } from "@/components/job-workspace/job-workspace";
import { buildEvidenceCorrectionReview } from "@/lib/jobs/evidence-correction-review";
import { buildRequirementChecklist } from "@/lib/jobs/requirement-checklist";
import { createDomHarness } from "@/tests/fixtures/dom-harness";

const requirements = [
  "Current Quenby certification",
  "Eight or more years of service operations",
  "Enterprise service delivery",
  "Incident governance",
  "Coaching service professionals",
  "Working knowledge of SQL",
  "Executive reporting"
];

const output = {
  contractVersion: "3",
  promptVersion: "3.4",
  factualMatches: [1, 2, 3, 4].map((index) => ({
    claim: `Shows ${requirements[index]}`,
    applicantEvidence: [{ ref: "resume.rawText", excerpt: `Résumé line for ${requirements[index]}` }],
    jobEvidence: [{ ref: `job.requirements[${index}]`, excerpt: requirements[index] }]
  })),
  requirementGaps: [0, 5].map((index) => ({
    requirement: requirements[index], jobRequirement: { ref: `job.requirements[${index}]`, excerpt: requirements[index] }, missingKeywords: []
  }))
};

function checklist(scored: boolean) {
  const built = buildRequirementChecklist(requirements, scored ? output : null);
  return { items: built.items, counts: built.counts };
}

function props(overrides: Partial<JobWorkspaceProps> = {}): JobWorkspaceProps {
  return {
    job: {
      id: "job-1",
      title: "Service Operations Director",
      company: "Northwind Service Cloud",
      location: "Remote — United States",
      workStyle: "Remote",
      salary: "$165k–$195k",
      postedAge: "2 days ago",
      source: "Greenhouse",
      description: "Lead enterprise service delivery.\n\nThis is a fully remote role open to candidates anywhere in the United States.",
      requirements,
      preferredQualifications: ["Business education"],
      workStyleQuotes: ["This is a fully remote role open to candidates anywhere in the United States."],
      listedWorkStyle: "Remote"
    },
    estimate: {
      score: 68,
      basis: "MASTER_RESUME",
      scoredAt: "2026-11-05T10:00:00.000Z",
      compensation: { score: null, explanation: "Unknown because the applicant salary target is missing." },
      resumeAngle: "Lead with enterprise service delivery.",
      coverLetterAngle: "Connect governance reviews to the role."
    },
    checklist: checklist(true),
    salaryTarget: null,
    tailor: {
      review: buildEvidenceCorrectionReview({
        jobId: "job-1", resumeId: "resume-1", resumeUpdatedAt: "2026-11-01T10:00:00.000Z",
        resume: { rawText: "Service operations leader." }, analysisId: "analysis-1", analysisInputHash: "a".repeat(64),
        analysisModel: "gemini-3.8-flash", analysisPromptVersion: "3.4", analysisOutput: output
      }),
      hasValidCurrentSnapshot: false,
      readOnlyGaps: [],
      quote: { provider: "gemini", model: "gemini-3.8-flash", promptVersion: "12", jobMatchMicros: 72_720, resumeMicros: 64_500, coverMicros: 47_250 },
      generationAvailable: true
    },
    documents: { resumeVersions: [], coverLetters: [] },
    application: null,
    masterResumeText: "Service operations leader.",
    notes: null,
    ...overrides
  };
}

async function withPage(overrides: Partial<JobWorkspaceProps>, run: (harness: ReturnType<typeof createDomHarness>) => Promise<void>) {
  const harness = createDomHarness({ fetch: (async () => new Response("{}")) as typeof fetch, confirm: () => true });
  try {
    await harness.render(React.createElement(JobWorkspace, props(overrides)));
    await run(harness);
  } finally {
    await harness.close();
  }
}

test("the header names the job with themed text, and the match card is Apply Pilot's own estimate", async () => {
  await withPage({}, async (harness) => {
    const title = harness.container.querySelector("h1");
    assert.equal(title?.textContent, "Service Operations Director");
    assert.ok(title?.classList.contains("job-title"), "the title uses the themed class, not a fixed dark colour");
    const card = harness.container.querySelector("[data-match-card]")!;
    assert.match(card.textContent ?? "", /68%/u);
    assert.match(card.textContent ?? "", /Apply Pilot's estimate, not an employer score/u);
    assert.match(card.textContent ?? "", /Your résumé shows 4 of 6 checked must-haves/u);
    assert.match(card.textContent ?? "", /1 not checked yet/u);
    assert.doesNotMatch(card.textContent ?? "", /of 7/u);
    assert.equal(card.querySelectorAll("[data-check=shown]").length, 4);
    assert.equal(card.querySelectorAll("[data-check=not_shown]").length, 1);
    assert.match(card.textContent ?? "", /\+1 more not on your résumé/u);
    for (const meta of ["Remote", "$165k–$195k", "2 days ago", "Northwind Service Cloud"]) assert.match(harness.text(), new RegExp(meta.replace(/[$]/gu, "\\$"), "u"));
  });
});

test("a mostly unchecked posting never reads as meeting almost nothing", async () => {
  const many = Array.from({ length: 24 }, (_, index) => `Listed requirement ${index + 1}`);
  const mixed = buildRequirementChecklist(many, {
    factualMatches: [{ claim: "Shown", applicantEvidence: [{ ref: "resume.rawText", excerpt: "Résumé line." }], jobEvidence: [{ ref: "job.requirements[3]", excerpt: many[3] }] }],
    requirementGaps: [{ requirement: many[7], jobRequirement: { ref: "job.requirements[7]", excerpt: many[7] } }]
  });
  await withPage({
    estimate: { ...props().estimate!, score: 82 },
    checklist: { items: mixed.items, counts: mixed.counts }
  }, async (harness) => {
    const card = harness.container.querySelector("[data-match-card]")!.textContent ?? "";
    assert.match(card, /82%/u);
    assert.match(card, /Your résumé shows 1 of 2 checked must-haves/u);
    assert.match(card, /22 not checked yet/u);
    assert.doesNotMatch(card, /of 24/u);
    const list = harness.container.querySelector("[data-match-card]")!;
    assert.equal(list.querySelectorAll("[data-check=not_assessed]").length, 0, "the card lists checked requirements only");
    assert.equal(list.querySelectorAll("[data-check=shown]").length, 1);
    assert.equal(list.querySelectorAll("[data-check=not_shown]").length, 1);
  });
});

test("when nothing was checked the card says so instead of showing a ratio", async () => {
  await withPage({ checklist: checklist(false) }, async (harness) => {
    const card = harness.container.querySelector("[data-match-card]")!.textContent ?? "";
    assert.match(card, /Apply Pilot didn't check these requirements/u);
    assert.doesNotMatch(card, /\d+ of \d+/u);
  });
});

test("the page has one way to apply and no duplicate packet or applied controls", async () => {
  await withPage({}, async (harness) => {
    const applyLinks = [...harness.container.querySelectorAll("a")].filter((link) => /apply/iu.test(link.textContent ?? ""));
    assert.ok(applyLinks.length >= 1);
    for (const link of applyLinks) assert.equal(link.getAttribute("href"), "/jobs/job-1/apply");
    for (const removed of [/I applied/u, /Open apply link/u, /Save packet/u, /Build packet/u, /Tailor resume/u, /Draft cover/u, /Missing-fact corrections/u, /Mark applied/u]) {
      assert.doesNotMatch(harness.text(), removed);
    }
    assert.equal(harness.container.querySelectorAll("a[href^='https://']").length, 0, "no direct employer link on the job page");
  });
});

test("tabs switch between overview, the full match breakdown, and salary without leaving the page", async () => {
  await withPage({}, async (harness) => {
    const panel = () => harness.container.querySelector("[role=tabpanel]")!;
    assert.match(panel().textContent ?? "", /Remote check/u);
    assert.match(panel().textContent ?? "", /“This is a fully remote role open to candidates anywhere in the United States\.”/u);
    await harness.click(harness.button("See full breakdown"));
    assert.equal(harness.container.querySelector("[role=tab][aria-selected=true]")?.textContent, "Match");
    assert.match(panel().textContent ?? "", /Résumé line for Enterprise service delivery/u);
    assert.match(panel().textContent ?? "", /Not on your résumé/u);
    await harness.click([...harness.container.querySelectorAll("[role=tab]")].find((tab) => tab.textContent === "Salary"));
    assert.match(panel().textContent ?? "", /\$165k–\$195k/u);
    assert.match(panel().textContent ?? "", /listed by the employer/u);
    assert.equal(harness.pushes.length, 0);
  });
});

test("an unscored job shows Score this job in the match card", async () => {
  await withPage({ estimate: null, checklist: checklist(false) }, async (harness) => {
    const card = harness.container.querySelector("[data-match-card]")!;
    assert.match(card.textContent ?? "", /Not scored yet/u);
    assert.ok([...card.querySelectorAll("button")].some((button) => button.textContent?.includes("Score this job")));
    assert.equal([...harness.container.querySelectorAll("button")].filter((button) => button.textContent?.includes("Score this job")).length, 1);
  });
});

test("an estimate from before the review says so", async () => {
  await withPage({ estimate: { ...props().estimate!, basis: "MASTER_RESUME_NO_NEW_FACTS" } }, async (harness) => {
    assert.match(harness.container.querySelector("[data-match-card]")!.textContent ?? "", /your review didn't add any lines/u);
  });
});

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
    await harness.render(React.createElement(JobWorkspace, props()));
    const gap = harness.container.querySelector("fieldset[data-gap]")!;
    await harness.click([...gap.querySelectorAll("label")].find((label) => /^Skip$/u.test(label.textContent ?? ""))?.querySelector("input"));
    await harness.click(harness.button("Create my résumé and cover letter"));
    await harness.waitForText(/The writer is unavailable/u);
    const before = props();
    // What router.refresh() delivers: the saved review is now in force and bound to a new analysis.
    await harness.render(React.createElement(JobWorkspace, props({
      tailor: { ...before.tailor, hasValidCurrentSnapshot: true, review: { ...before.tailor.review!, analysisId: "analysis-2" } }
    })));
    assert.match(harness.text(), /Your answers were saved\. The writer is unavailable\./u);
    await harness.click([...harness.container.querySelector("fieldset[data-gap]")!.querySelectorAll("label")].find((label) => /I have this/u.test(label.textContent ?? ""))?.querySelector("input"));
    await harness.render(React.createElement(JobWorkspace, props({
      tailor: { ...before.tailor, hasValidCurrentSnapshot: true, review: { ...before.tailor.review!, analysisId: "analysis-3" } }
    })));
    const choice = [...harness.container.querySelector("fieldset[data-gap]")!.querySelectorAll("label")].find((label) => /^Skip$/u.test(label.textContent ?? ""))?.querySelector("input");
    assert.equal(choice?.checked, true, "answers drafted against an older review are cleared");
  } finally {
    await harness.close();
  }
});

test("ready documents lead to review, then the Apply Kit", async () => {
  await withPage({
    documents: {
      resumeVersions: [{ id: "resume-version-1", title: "Northwind tailored résumé", fullText: "Taylor Boundary\nService operations leader.", summary: null, atsCompatibility: null, jobFitScore: null, evidenceCurrent: true, createdAt: "2026-11-05T11:00:00.000Z" }],
      coverLetters: []
    }
  }, async (harness) => {
    const documents = harness.container.querySelector("#documents")!;
    assert.match(documents.textContent ?? "", /Review and edit/u);
    assert.ok(documents.querySelector("[data-product-documents]"));
    assert.ok([...documents.querySelectorAll("a")].some((link) => link.textContent?.includes("Go to Apply Kit") && link.getAttribute("href") === "/jobs/job-1/apply"));
    assert.ok(harness.button("Create new versions"));
  });
});
