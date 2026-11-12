import assert from "node:assert/strict";
import { test } from "node:test";

import { AshbyProvider } from "@/lib/job-sources/ashby";
import { GreenhouseProvider } from "@/lib/job-sources/greenhouse";
import { keepUnchangedMatchContent } from "@/lib/job-sources/ingestion";
import { LeverProvider } from "@/lib/job-sources/lever";
import { isRequirementLine } from "@/lib/job-sources/requirement-lines";
import type { NormalizedJob } from "@/lib/job-sources/types";

// Board imports listed every line of a posting as a requirement: company blurbs, section headings,
// "what you won't be doing" and the benefits list. The owner was then asked to write a line for
// each of them, and the score judged them. Synthetic postings shaped like real Ashby ones.

const salesEngineerPlain = [
  "At Northwind, our mission is to help businesses earn and prove trust. We believe security should be monitored and verified continuously, and we empower companies to practice better security from day one.",
  "You'll be an integral part of the Sales team, working pre-sales to ensure technical fit and create solutions for our customers.",
  "What you'll do as a Solutions Engineer at Northwind:",
  "- Own the technical relationship with our customers",
  "- Support customers through their trial of Northwind",
  "How to be successful in this role:",
  "- Have 3+ years of customer-facing, technical experience as a solutions engineer",
  "- Have previous B2B SaaS experience",
  "What you can expect as a Northwinder:",
  "- Industry-competitive salary and equity",
  "- 16 weeks paid parental leave for all new parents"
].join("\n");

const supportEngineerPlain = [
  "ABOUT NORTHWIND",
  "Northwind is your product's context layer. It stores your analytics so you can act on them.",
  "Data warehouse https://example.com/warehouse so users can query product data with SQL.",
  "1. Product-led. More than 500K organizations have installed Northwind.",
  "THINGS WE CARE ABOUT",
  "WHO WE’RE LOOKING FOR",
  "We're looking for a Technical Support Engineer who loves helping customers.",
  "WHAT YOU’LL BE DOING",
  "Owning your tickets from beginning to end, and keeping customers updated",
  "Shipping fixes to the codebase and docs when you find something broken",
  "WHAT YOU WON’T BE DOING",
  "❌ You won't be routing tickets to engineering because they look hard.",
  "You'll be the face of Northwind for many of our customers."
].join("\n");

function ashbyJob(fields: Record<string, unknown>) {
  return {
    title: "Solutions Engineer",
    jobUrl: "https://jobs.ashbyhq.com/northwind/1",
    ...fields
  };
}

test("an Ashby posting's requirements are the lines under its requirement headings", () => {
  const job = new AshbyProvider().normalizeJob(ashbyJob({ descriptionPlain: salesEngineerPlain }));
  assert.deepEqual(job.requirements, [
    "Own the technical relationship with our customers",
    "Support customers through their trial of Northwind",
    "Have 3+ years of customer-facing, technical experience as a solutions engineer",
    "Have previous B2B SaaS experience"
  ]);
});

test("company blurbs, headings and what you won't be doing are not requirements", () => {
  const job = new AshbyProvider().normalizeJob(ashbyJob({ descriptionPlain: supportEngineerPlain }));
  assert.deepEqual(job.requirements, [
    "We're looking for a Technical Support Engineer who loves helping customers.",
    "Owning your tickets from beginning to end, and keeping customers updated",
    "Shipping fixes to the codebase and docs when you find something broken"
  ]);
});

test("an Ashby posting with only HTML keeps its sections", () => {
  const descriptionHtml = [
    "<p>At Northwind, we build trust tooling for growing companies everywhere.</p>",
    "<p><strong>What you'll do as a Solutions Engineer at Northwind:</strong></p>",
    "<ul><li><p>Own the technical relationship with our customers</p></li></ul>",
    "<p><strong>What you can expect as a Northwinder:</strong></p>",
    "<ul><li>Industry-competitive salary and equity</li></ul>"
  ].join("");
  const job = new AshbyProvider().normalizeJob(ashbyJob({ descriptionHtml }));
  assert.deepEqual(job.requirements, ["Own the technical relationship with our customers"]);
});

test("a posting without section headings still lists its lines, as before", () => {
  const plain = [
    "Own the technical relationship with our customers",
    "Have previous B2B SaaS experience"
  ].join("\n");
  const job = new AshbyProvider().normalizeJob(ashbyJob({ descriptionPlain: plain }));
  assert.deepEqual(job.requirements, [
    "Own the technical relationship with our customers",
    "Have previous B2B SaaS experience"
  ]);
});

test("a Lever posting's benefits list and opening are not requirements", () => {
  const job = new LeverProvider().normalizeJob({
    text: "Sales Engineer",
    hostedUrl: "https://jobs.lever.co/northwind/1",
    descriptionPlain: "Northwind builds identity tooling for IT teams across many industries.",
    lists: [
      { text: "What you'll do", content: "<li>Run technical discovery with prospects</li><li>Build demos for evaluations</li>" },
      { text: "Requirements", content: "<li>3+ years in a customer-facing technical role</li>" },
      { text: "Benefits", content: "<li>Medical, dental and vision coverage</li>" }
    ]
  });
  assert.deepEqual(job.requirements, [
    "Run technical discovery with prospects",
    "Build demos for evaluations",
    "3+ years in a customer-facing technical role"
  ]);
});

test("a Lever section keeps its items whatever its title says, unless it is benefits", () => {
  const job = new LeverProvider().normalizeJob({
    text: "Operations Partner",
    hostedUrl: "https://jobs.lever.co/northwind/2",
    lists: [
      { text: "In this role, you will...", content: "<li>Plan and run quarterly team off-sites</li>" },
      { text: "Your mission", content: "<li>Keep leadership calendars running smoothly</li>" },
      { text: "Perks:", content: "<li>Commuter benefits and a learning stipend</li>" }
    ]
  });
  assert.deepEqual(job.requirements, [
    "Plan and run quarterly team off-sites",
    "Keep leadership calendars running smoothly"
  ]);
});

test("a Lever opening adds the lines it lists under its own requirement heading", () => {
  const job = new LeverProvider().normalizeJob({
    text: "Sales Engineer",
    hostedUrl: "https://jobs.lever.co/northwind/3",
    descriptionPlain: [
      "Northwind builds identity tooling for IT teams across many industries.",
      "Requirements:",
      "- 3+ years in a customer-facing technical role"
    ].join("\n"),
    lists: [{ text: "Benefits", content: "<li>Medical, dental and vision coverage</li>" }]
  });
  assert.deepEqual(job.requirements, ["3+ years in a customer-facing technical role"]);
});

test("a Greenhouse posting's paragraphs under a requirement heading are prose, not requirements", () => {
  const html = [
    "<h2>About the role</h2>",
    "<p>Northwind is hiring a Solutions Engineer to partner with customers on integrations.</p>",
    "<ul><li>Run technical discovery with prospects</li></ul>"
  ].join("");
  const job = new GreenhouseProvider().normalizeJob({ id: 2, title: "Sales Engineer", absolute_url: "https://example.com/jobs/2", html });
  assert.deepEqual(job.requirements, ["Run technical discovery with prospects"]);
});

test("an Ashby posting whose plain text is one paragraph is read from its HTML", () => {
  const job = new AshbyProvider().normalizeJob(ashbyJob({
    descriptionPlain: "Requirements Own the technical relationship with our customers Benefits Industry-competitive salary and equity, plus more benefits for everyone who joins the team this year.",
    descriptionHtml: "<h3>Requirements</h3><ul><li>Own the technical relationship with our customers</li></ul><h3>Benefits</h3><ul><li>Industry-competitive salary and equity</li></ul>"
  }));
  assert.deepEqual(job.requirements, ["Own the technical relationship with our customers"]);
});

test("a Greenhouse posting's benefits bullets are not requirements", () => {
  const html = [
    "<p>About the role. You will partner with customers on integrations.</p>",
    "<h3>What you'll do</h3>",
    "<ul><li>Run technical discovery with prospects</li></ul>",
    "<h3>Requirements</h3>",
    "<ul><li>3+ years in a customer-facing technical role</li></ul>",
    "<h3>Benefits</h3>",
    "<ul><li>Medical, dental and vision coverage</li><li>Flexible paid time off</li></ul>"
  ].join("");
  const job = new GreenhouseProvider().normalizeJob({ id: 1, title: "Sales Engineer", absolute_url: "https://example.com/jobs/1", html });
  assert.deepEqual(job.requirements, [
    "Run technical discovery with prospects",
    "3+ years in a customer-facing technical role"
  ]);
});

test("headings stored by an older import are recognised as headings", () => {
  for (const heading of [
    "THINGS WE CARE ABOUT",
    "WHO WE’RE LOOKING FOR",
    "WHAT YOU’LL BE DOING",
    "WHAT YOU WON’T BE DOING",
    "What you'll do as a Solutions Engineer at Northwind:",
    "How to be successful in this role:",
    "What you can expect as a Northwind’er:"
  ]) {
    assert.equal(isRequirementLine(heading), false, heading);
  }
  assert.equal(isRequirementLine("Have previous B2B SaaS experience"), true);
});

function storedAshbyJob(overrides: Partial<NormalizedJob> = {}): NormalizedJob {
  return {
    ...new AshbyProvider().normalizeJob(ashbyJob({ descriptionPlain: salesEngineerPlain })),
    company: "Northwind",
    ...overrides
  };
}

test("an unchanged posting stored with non-requirement lines gets the cleaner list", () => {
  const incoming = storedAshbyJob();
  // What the older splitter stored: every line, benefits and headings included.
  const stored = storedAshbyJob({
    requirements: [
      "You'll be an integral part of the Sales team, working pre-sales to ensure technical fit and create solutions for our customers.",
      ...incoming.requirements,
      "Industry-competitive salary and equity",
      "16 weeks paid parental leave for all new parents"
    ]
  });

  const refreshed = keepUnchangedMatchContent(stored, incoming);
  assert.deepEqual(refreshed.requirements, incoming.requirements);
  assert.equal(refreshed.description, stored.description, "the description is still the stored one");
});

test("a stored list the board's extractor still keeps in full is left alone, so the score stays current", () => {
  const incoming = storedAshbyJob();
  const stored = storedAshbyJob({ requirements: incoming.requirements.slice(0, 2) });
  assert.deepEqual(keepUnchangedMatchContent(stored, incoming).requirements, stored.requirements);
});
