import "@/tests/fixtures/dom-globals";
import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";

import { FeedCard, type FeedCardView } from "@/components/job-feed/feed-card";
import { FeedFilterBar } from "@/components/job-feed/feed-filter-bar";
import { FeedPreview } from "@/components/job-feed/feed-preview";
import { parseFeedFilters } from "@/lib/jobs/feed-query";
import { buildRequirementChecklist } from "@/lib/jobs/requirement-checklist";
import { createDomHarness } from "@/tests/fixtures/dom-harness";

const card: FeedCardView = {
  id: "job-1",
  title: "Service Operations Director",
  company: "Northwind Service Cloud",
  location: "Remote — United States",
  workStyle: "Remote",
  salary: "$165k–$195k",
  postedAge: "2 days ago",
  source: "Greenhouse",
  score: 68,
  href: "/jobs?job=job-1",
  selected: false,
  trackerStatus: null
};

test("a scored card shows company, title, location, salary, work style, age and Apply Pilot's fit", async () => {
  const harness = createDomHarness();
  try {
    await harness.render(React.createElement(FeedCard, { job: card }));
    const text = harness.text();
    for (const part of ["Northwind Service Cloud", "Service Operations Director", "Remote — United States", "$165k–$195k", "Remote", "2 days ago", "68%"]) {
      assert.ok(text.includes(part), part);
    }
    const link = harness.container.querySelector("a")!;
    assert.equal(link.getAttribute("href"), "/jobs?job=job-1");
    assert.equal(Boolean(harness.maybeButton(/^Score/u)), false);
    assert.doesNotMatch(text, /Mark applied|I applied/u);
  } finally {
    await harness.close();
  }
});

test("an unscored card offers Score, which asks for the cost and refreshes the feed", async () => {
  const calls: Array<string | null> = [];
  const harness = createDomHarness({
    confirm: () => true,
    fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const confirmed = new Headers(init?.headers).get("x-ai-cost-confirmed");
      calls.push(confirmed);
      return confirmed
        ? new Response(JSON.stringify({ match: { overallFitScore: 72 } }), { status: 200 })
        : new Response(JSON.stringify({ code: "AI_COST_CONFIRMATION_REQUIRED", maximumCostMicros: 72_720 }), { status: 428 });
    }) as typeof fetch
  });
  try {
    await harness.render(React.createElement(FeedCard, { job: { ...card, score: null, selected: true } }));
    assert.match(harness.text(), /Not scored/u);
    assert.equal(harness.container.querySelector("a")?.getAttribute("aria-current"), "true");
    await harness.click(harness.button("Score"));
    await harness.waitForText(/Scored/u);
    assert.deepEqual(calls, [null, "true"]);
    assert.equal(harness.refreshes, 1);
  } finally {
    await harness.close();
  }
});

test("the preview pane shows the match card, tabs and one path into tailoring and applying", async () => {
  const requirements = ["Enterprise service delivery", "Quenby certification"];
  const output = {
    factualMatches: [{ claim: "Delivery", applicantEvidence: [{ ref: "resume.rawText", excerpt: "Directed service delivery." }], jobEvidence: [{ ref: "job.requirements[0]", excerpt: "Enterprise service delivery" }] }],
    requirementGaps: [{ requirement: "Quenby certification", jobRequirement: { ref: "job.requirements[1]", excerpt: "Quenby certification" } }]
  };
  const built = buildRequirementChecklist(requirements, output);
  const harness = createDomHarness();
  try {
    await harness.render(React.createElement(FeedPreview, {
      job: { ...card, description: "Lead delivery. This is a fully remote role.", requirements, preferredQualifications: [], workStyleQuotes: ["This is a fully remote role."], listedWorkStyle: "Remote" },
      estimate: { score: 68, basis: "MASTER_RESUME", scoredAt: "2026-11-05T10:00:00.000Z", compensation: null, resumeAngle: null, coverLetterAngle: null },
      checklist: { items: built.items, counts: built.counts },
      salaryTarget: null,
      application: null,
      backHref: "/jobs"
    }));
    assert.match(harness.container.querySelector("[data-match-card]")!.textContent ?? "", /You have 1 of 2 must-haves/u);
    const links = Object.fromEntries([...harness.container.querySelectorAll("a")].map((link) => [link.textContent?.trim(), link.getAttribute("href")]));
    assert.equal(links["Tailor your résumé for this job"], "/jobs/job-1#tailor");
    assert.equal(links["Go to Apply Kit"], "/jobs/job-1/apply");
    assert.ok(harness.button("Save job"));
    assert.match(harness.text(), /“This is a fully remote role\.”/u);
    await harness.click(harness.button("See full breakdown"));
    assert.equal(harness.container.querySelector("[role=tab][aria-selected=true]")?.textContent, "Match");
    assert.match(harness.container.querySelector("[role=tabpanel]")!.textContent ?? "", /Directed service delivery/u);
  } finally {
    await harness.close();
  }
});

test("the filter bar has search, location, chips and a sort, all as plain links or a GET form", () => {
  const html = renderToStaticMarkup(React.createElement(FeedFilterBar, {
    filters: parseFeedFilters({ q: "operations", workStyle: "Remote", sort: "newest" }),
    resultSummary: "8 jobs · 3 scored"
  }));
  const document = new JSDOM(html).window.document;
  const form = document.querySelector("form")!;
  assert.equal(form.getAttribute("method"), "get");
  assert.equal((form.querySelector("input[name=q]") as HTMLInputElement).value, "operations");
  assert.ok(form.querySelector("input[name=location]"));
  const remote = [...document.querySelectorAll("a")].find((link) => link.textContent?.trim() === "Remote")!;
  assert.equal(remote.getAttribute("aria-pressed"), "true");
  assert.equal(remote.getAttribute("href"), "/jobs?q=operations&sort=newest");
  const salary = [...document.querySelectorAll("a")].find((link) => link.textContent?.trim() === "Salary listed")!;
  assert.equal(salary.getAttribute("href"), "/jobs?q=operations&workStyle=Remote&salary=listed&sort=newest");
  assert.match(document.body.textContent ?? "", /Sort: Newest/u);
  assert.match(document.body.textContent ?? "", /Posted within/u);
  assert.match(document.body.textContent ?? "", /Seniority/u);
  assert.match(document.body.textContent ?? "", /8 jobs · 3 scored/u);
});
