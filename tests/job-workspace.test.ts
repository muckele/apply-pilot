import "@/tests/fixtures/dom-globals";
import assert from "node:assert/strict";
import test from "node:test";
import React from "react";

import { JobWorkspace, type JobWorkspaceProps } from "@/components/job-workspace/job-workspace";
import { deriveApplyProgress } from "@/lib/apply-page/apply-progress";
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
    progress: deriveApplyProgress({ hasMasterResume: true, hasCurrentMatch: false, reviewSaved: false, resumeAttached: false, coverAttached: false, coverRequired: true, automationAvailable: false, run: null, applied: false }),
    application: null,
    applyReturn: { pending: null, declined: null },
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

test("a years-of-experience shortfall shows what Apply Pilot counted in the full breakdown", async () => {
  const summary = "Your résumé shows about 4 years of service operations; this job asks for 8+ years.";
  const tenureOutput = {
    ...output,
    factualMatches: output.factualMatches.filter((match) => match.jobEvidence[0]!.ref !== "job.requirements[1]"),
    requirementGaps: [...output.requirementGaps, {
      requirement: requirements[1], jobRequirement: { ref: "job.requirements[1]", excerpt: requirements[1] }, missingKeywords: [],
      tenure: {
        method: "work_history_titles_and_dates",
        summary,
        countedRoles: [{ ref: "resume.workHistory[0]", excerpt: "Service Operations Manager", title: "Service Operations Manager", company: "Contoso", startDate: "2021-06", endDate: "Present" }]
      }
    }]
  };
  const built = buildRequirementChecklist(requirements, tenureOutput);
  await withPage({ checklist: { items: built.items, counts: built.counts } }, async (harness) => {
    await harness.click(harness.button("See full breakdown"));
    const panel = harness.container.querySelector("[role=tabpanel]")!.textContent ?? "";
    assert.ok(panel.includes(summary), "breakdown shows the counted duration");
    assert.ok(panel.includes("Counted from work-history titles and dates: Service Operations Manager, Contoso (2021-06 – Present)"), "breakdown names the counted roles");
  });
});

test("an unscored job says so on the job page without a Score button; scoring happens on the Apply page", async () => {
  await withPage({ estimate: null, checklist: checklist(false) }, async (harness) => {
    const card = harness.container.querySelector("[data-match-card]")!;
    assert.match(card.textContent ?? "", /Not scored yet/u);
    assert.equal([...harness.container.querySelectorAll("button")].filter((button) => button.textContent?.includes("Score this job")).length, 0);
  });
});

test("job page links Apply → to /jobs/:id/apply and has no Create my résumé button", async () => {
  await withPage({}, async (harness) => {
    const apply = [...harness.container.querySelectorAll("a")].find((link) => link.textContent?.includes("Apply →"));
    assert.equal(apply?.getAttribute("href"), "/jobs/job-1/apply");
    assert.equal(apply?.textContent?.trim(), "Apply →");
    assert.equal(apply?.querySelector("svg") === null, true, "one arrow: the text's, not an icon as well");
    assert.equal(harness.maybeButton("Create my résumé"), undefined);
    assert.equal(harness.container.querySelector("#tailor"), null);
    assert.equal(harness.container.querySelector("#documents"), null);
  });
});

test("past step 1 the job page's card reads Continue: step N", async () => {
  const progress = deriveApplyProgress({ hasMasterResume: true, hasCurrentMatch: true, reviewSaved: true, resumeAttached: false, coverAttached: false, coverRequired: true, automationAvailable: false, run: null, applied: false });
  await withPage({ progress }, async (harness) => {
    const apply = [...harness.container.querySelectorAll("a")].find((link) => link.textContent?.includes("Continue: step 3"));
    assert.equal(apply?.getAttribute("href"), "/jobs/job-1/apply");
    assert.equal(apply?.querySelectorAll("svg").length, 1, "one arrow");
  });
});

test("an applied job's card reads View application, not Continue: step 10", async () => {
  const progress = deriveApplyProgress({ hasMasterResume: true, hasCurrentMatch: true, reviewSaved: true, resumeAttached: true, coverAttached: true, coverRequired: true, automationAvailable: false, run: null, applied: true });
  await withPage({ progress, application: { id: "application-1", statusLabel: "Applied" } }, async (harness) => {
    assert.doesNotMatch(harness.text(), /Continue: step/u);
    const view = [...harness.container.querySelectorAll("a")].find((link) => link.textContent?.trim() === "View application");
    assert.equal(view?.getAttribute("href"), "/jobs/job-1/apply");
  });
});

test("an estimate from before the review says so", async () => {
  await withPage({ estimate: { ...props().estimate!, basis: "MASTER_RESUME_NO_NEW_FACTS" } }, async (harness) => {
    assert.match(harness.container.querySelector("[data-match-card]")!.textContent ?? "", /your review didn't add any lines/u);
  });
});

test("an unanswered opened application asks 'Did you apply?' on the job page, and only then", async () => {
  await withPage({}, async (harness) => {
    assert.equal(harness.container.querySelector("[data-apply-return]") === null, true, "no question without an opened moment");
  });
  const pending = { openedEventId: "event-opened", openedAt: "2026-11-06T10:00:00.000Z" };
  await withPage({ application: { id: "application-1", statusLabel: "Saved" }, applyReturn: { pending, declined: null } }, async (harness) => {
    const card = harness.container.querySelector("[data-apply-return]");
    assert.ok(card, "the question is shown");
    assert.match(card.textContent ?? "", /Did you submit your application to /u);
    assert.equal(card.tagName, "DIALOG", "the same large window as the Apply page");
    // "Yes, I applied" records in one click (tests/apply-return-ui.test.ts); it isn't a link away.
    assert.equal(card.querySelector("[data-apply-return-yes]")?.tagName, "BUTTON");
  });
});
