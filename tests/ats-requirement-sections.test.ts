import assert from "node:assert/strict";
import { test } from "node:test";

import { AshbyProvider } from "@/lib/job-sources/ashby";
import { GreenhouseProvider } from "@/lib/job-sources/greenhouse";
import { keepUnchangedMatchContent } from "@/lib/job-sources/ingestion";
import { LeverProvider } from "@/lib/job-sources/lever";
import { ManualJobImportProvider } from "@/lib/job-sources/manual";
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

// Headings in capitals. Some boards write every heading in capitals, some as a title and a
// subtitle, and name their benefits list "BENEFITS AVAILABLE TO ALL …". None of those matched
// a known heading, so each heading, and every benefit under it, was stored as a requirement.

function plainPosting(lines: string[]) {
  // Ashby's plain text: a blank line between blocks, list items as " - item".
  return lines.join("\n\n");
}

test("'what you need' opens the requirements, so the company blurb before it is not one", () => {
  const job = new AshbyProvider().normalizeJob(ashbyJob({
    descriptionPlain: plainPosting([
      "ABOUT NORTHWIND",
      "Northwind builds the answer engine that support teams rely on every day.",
      "WHAT YOU NEED",
      " - 4+ years running support operations at a software company",
      " - Comfort reading data and running experiments on live traffic"
    ])
  }));
  assert.deepEqual(job.requirements, [
    "4+ years running support operations at a software company",
    "Comfort reading data and running experiments on live traffic"
  ]);
});

test("a heading that starts with benefits ends the requirements, with every benefit under it", () => {
  for (const heading of [
    "BENEFITS AVAILABLE TO ALL FULL-TIME NORTHWIND EMPLOYEES (GLOBAL)",
    "Benefits available to all full-time employees (global)",
    "Benefits for full-time employees:"
  ]) {
    const job = new AshbyProvider().normalizeJob(ashbyJob({
      descriptionPlain: plainPosting([
        "WHAT YOU'LL DO",
        " - Own the technical relationship with our customers",
        heading,
        " - A home-office budget for every new hire",
        " - A monthly stipend for gym classes",
        "UNITED STATES",
        " - Medical, dental and vision coverage for you and your dependents",
        "REFERRAL INSTRUCTIONS",
        "Referred by someone on the team? Ask them to send in your application."
      ])
    }));
    assert.deepEqual(job.requirements, ["Own the technical relationship with our customers"], heading);
  }
});

test("headings in capitals, alone or as a title and subtitle, are not requirements", () => {
  const job = new AshbyProvider().normalizeJob(ashbyJob({
    descriptionPlain: plainPosting([
      "WHAT YOU'LL DO",
      "PERFORMANCE: OWN HOW WELL BEACON WORKS",
      " - Audit a sample of Beacon's answers every week",
      "KNOWLEDGE: OWN WHAT BEACON KNOWS",
      " - Maintain the help articles Beacon answers from",
      "CUSTOMER EXPERIENCE: OWN HOW BEACON FEELS TO CUSTOMERS",
      "LAUNCH READINESS: OWN BEACON'S READINESS FOR EVERY LAUNCH",
      "QUALITY, SAFETY AND LAUNCH READINESS",
      "WORKING STYLE",
      " - Write things down so the whole team can follow your decisions"
    ])
  }));
  assert.deepEqual(job.requirements, [
    "Audit a sample of Beacon's answers every week",
    "Maintain the help articles Beacon answers from",
    "Write things down so the whole team can follow your decisions"
  ]);
});

test("a logistics or timezone heading is not a requirement, but the line under it is", () => {
  for (const heading of ["TIMEZONES & LOGISTICS", "Timezones & logistics", "Time zone and location"]) {
    const job = new AshbyProvider().normalizeJob(ashbyJob({
      descriptionPlain: plainPosting([
        "What you'll need",
        " - 4+ years running support operations at a software company",
        heading,
        " - Work at least four hours a day in US Eastern time"
      ])
    }));
    assert.deepEqual(job.requirements, [
      "4+ years running support operations at a software company",
      "Work at least four hours a day in US Eastern time"
    ], heading);
  }
});

test("lines in capitals that read as a sentence or a list, and lines that only mention benefits, stay requirements", () => {
  for (const line of [
    "MUST BE ABLE TO TRAVEL TO CUSTOMER SITES UP TO 25% OF THE TIME.",
    "SOC 2, ISO 27001, HIPAA AND PCI AUDIT EXPERIENCE",
    "FIVE OR MORE YEARS OF EXPERIENCE SELLING SOFTWARE TO MID-MARKET FINANCE TEAMS",
    "Benefits administration experience at a growing company"
  ]) {
    assert.equal(isRequirementLine(line), true, line);
  }
  const job = new AshbyProvider().normalizeJob(ashbyJob({
    descriptionPlain: plainPosting([
      "What you'll need",
      " - Benefits administration experience at a growing company",
      " - Comfort with payroll systems and their audits"
    ])
  }));
  assert.deepEqual(job.requirements, [
    "Benefits administration experience at a growing company",
    "Comfort with payroll systems and their audits"
  ]);
});

const capitalsPosting = plainPosting([
  "ABOUT NORTHWIND",
  "Northwind builds the answer engine that support teams rely on every day.",
  "WHAT YOU NEED",
  " - 4+ years running support operations at a software company",
  "TIMEZONES & LOGISTICS",
  " - Work at least four hours a day in US Eastern time",
  "BENEFITS AVAILABLE TO ALL FULL-TIME NORTHWIND EMPLOYEES (GLOBAL)",
  " - A home-office budget for every new hire",
  " - A monthly stipend for gym classes",
  "UNITED STATES",
  " - Medical, dental and vision coverage for you and your dependents"
]);

const capitalsRequirements = [
  "4+ years running support operations at a software company",
  "Work at least four hours a day in US Eastern time"
];

test("a posting imported by hand drops capitals headings and benefits the same way", () => {
  const job = new ManualJobImportProvider().normalizeJob({ title: "Support Operations Lead", company: "Northwind", description: capitalsPosting });
  assert.deepEqual(job.requirements, capitalsRequirements);
});

test("an Ashby posting read from HTML drops capitals headings and benefits the same way", () => {
  const descriptionHtml = [
    "<p><strong>WHAT YOU NEED</strong></p>",
    "<ul><li><p>4+ years running support operations at a software company</p></li></ul>",
    "<p><strong>BENEFITS AVAILABLE TO ALL FULL-TIME NORTHWIND EMPLOYEES (GLOBAL)</strong></p>",
    "<ul><li><p>A monthly stipend for gym classes</p></li></ul>"
  ].join("");
  const job = new AshbyProvider().normalizeJob(ashbyJob({ descriptionHtml }));
  assert.deepEqual(job.requirements, ["4+ years running support operations at a software company"]);
});

test("a posting read as one paragraph never lists a capitals heading as a requirement", () => {
  const job = new AshbyProvider().normalizeJob(ashbyJob({
    descriptionPlain: "WHAT YOU NEED - 4+ years running support operations at a software company - REFERRAL INSTRUCTIONS"
  }));
  assert.deepEqual(job.requirements, ["4+ years running support operations at a software company"]);
});

test("a stored list with capitals headings and benefits is replaced on the next sync", () => {
  const incoming: NormalizedJob = { ...new AshbyProvider().normalizeJob(ashbyJob({ descriptionPlain: capitalsPosting })), company: "Northwind" };
  // What the extractor before this change stored for the same posting.
  const stored: NormalizedJob = {
    ...incoming,
    requirements: [
      "Northwind builds the answer engine that support teams rely on every day.",
      "WHAT YOU NEED",
      "4+ years running support operations at a software company",
      "TIMEZONES & LOGISTICS",
      "Work at least four hours a day in US Eastern time",
      "BENEFITS AVAILABLE TO ALL FULL-TIME NORTHWIND EMPLOYEES (GLOBAL)",
      "A home-office budget for every new hire",
      "A monthly stipend for gym classes",
      "UNITED STATES",
      "Medical, dental and vision coverage for you and your dependents"
    ]
  };
  assert.deepEqual(keepUnchangedMatchContent(stored, incoming).requirements, capitalsRequirements);
});
