import assert from "node:assert/strict";
import { test } from "node:test";

import { ManualJobImportProvider } from "@/lib/job-sources/manual";
import { manualJobImportSchema } from "@/lib/validators";

const baseInput = {
  title: "Solutions Engineer",
  company: "Example Co",
  sourceUrl: "https://example.test/jobs/123",
  description: "Overview\nFour years of client-facing experience\nSQL experience and stakeholder communication.",
  runMatch: false
};

test("manual import preserves explicit zero salary and derives omitted evidence lists", () => {
  const input = manualJobImportSchema.parse({
    ...baseInput,
    salaryMin: 0,
    salaryMax: 0,
    datePosted: "2026-07-08"
  });
  const normalized = new ManualJobImportProvider().normalizeJob(input);

  assert.equal(normalized.salaryMin, 0);
  assert.equal(normalized.salaryMax, 0);
  assert.equal(normalized.datePosted?.toISOString(), "2026-07-08T00:00:00.000Z");
  assert.deepEqual(normalized.requirements, [
    "Four years of client-facing experience",
    "SQL experience and stakeholder communication."
  ]);
  assert.deepEqual(normalized.detectedTechStack, ["SQL"]);
});

test("manual import preserves explicitly supplied requirement and preference evidence", () => {
  const input = manualJobImportSchema.parse({
    ...baseInput,
    requirements: ["Four years of client-facing experience"],
    preferredQualifications: ["Early-stage company experience"],
    detectedTechStack: ["SQL"]
  });
  const normalized = new ManualJobImportProvider().normalizeJob(input);

  assert.deepEqual(normalized.requirements, ["Four years of client-facing experience"]);
  assert.deepEqual(normalized.preferredQualifications, ["Early-stage company experience"]);
  assert.deepEqual(normalized.detectedTechStack, ["SQL"]);
});

test("manual import preserves explicitly empty evidence arrays instead of deriving replacements", () => {
  const input = manualJobImportSchema.parse({
    ...baseInput,
    requirements: [],
    preferredQualifications: [],
    detectedTechStack: []
  });
  const normalized = new ManualJobImportProvider().normalizeJob(input);

  assert.deepEqual(normalized.requirements, []);
  assert.deepEqual(normalized.preferredQualifications, []);
  assert.deepEqual(normalized.detectedTechStack, []);
});

test("manual import rejects a salary range whose minimum exceeds its maximum", () => {
  assert.throws(
    () => manualJobImportSchema.parse({ ...baseInput, salaryMin: 120_000, salaryMax: 90_000 }),
    /salary/i
  );
});

test("manual import keeps empty and whitespace-only salary values unknown", () => {
  for (const blank of ["", "   ", "\t"]) {
    const input = manualJobImportSchema.parse({ ...baseInput, salaryMin: blank, salaryMax: blank });
    const normalized = new ManualJobImportProvider().normalizeJob(input);

    assert.equal(normalized.salaryMin, undefined);
    assert.equal(normalized.salaryMax, undefined);
  }
});

// A synthetic posting shaped like the pasted Greenhouse page that, on 2026-11-09, produced 24
// "requirements" of which 9 were an intro line, section headings, pay lines and a benefits heading.
const sectionedPosting = [
  "At Northwind, we build payment tools people trust, with clear terms and no surprise fees for anyone who uses them.",
  "About the Merchant Operations team",
  "The Merchant Operations team keeps partner launches running smoothly. ".repeat(4).trim(),
  "About the Role",
  "You will help merchants launch and grow with our checkout. ".repeat(5).trim(),
  "What You’ll Do",
  "Support merchant partners with onboarding questions, reporting workflows and integration troubleshooting",
  "Resolve integration issues across storefront platforms and order management systems",
  "Write clear technical documentation",
  "What We Look For",
  "Bachelor’s degree or equivalent experience",
  "1-3 years of experience in a customer-facing technical role",
  "Nice to have: familiarity with HTML, JavaScript and REST APIs",
  "This role requires candidates to be based in the Mountain Time Zone.",
  "Pay Grade - C",
  "Equity Grade - 2",
  "New employees usually start near the beginning of the range, which is set by role and level. ".repeat(3).trim(),
  "US base pay range (CA, WA, NY) per year: $68,000 - $88,000",
  "US base pay range (all other states) per year: $60,000 - $80,000",
  "#LI-Remote",
  "Remote-first with room to travel",
  "Most roles can be done from anywhere in the country of employment.",
  "Benefits built for you",
  "Health coverage: we pay 100% of premiums for employees and their dependents.",
  "Monthly stipends for your home office, wellness and learning.",
  "Flexible time off and a generous holiday calendar."
].join("\n");

test("manual import keeps only the lines under requirement headings of a sectioned posting", () => {
  const input = manualJobImportSchema.parse({ ...baseInput, description: sectionedPosting });
  const normalized = new ManualJobImportProvider().normalizeJob(input);

  assert.deepEqual(normalized.requirements, [
    "Support merchant partners with onboarding questions, reporting workflows and integration troubleshooting",
    "Resolve integration issues across storefront platforms and order management systems",
    "Write clear technical documentation",
    "Bachelor’s degree or equivalent experience",
    "1-3 years of experience in a customer-facing technical role",
    "Nice to have: familiarity with HTML, JavaScript and REST APIs",
    "This role requires candidates to be based in the Mountain Time Zone."
  ]);
});

test("manual import ends a requirement list at a perks heading or a pay line but keeps requirements that mention benefits or money", () => {
  const description = [
    "We are hiring an implementation lead.",
    "Responsibilities:",
    "- Own onboarding for new enterprise accounts",
    "- Partner with sales on technical discovery calls",
    "Requirements:",
    "• 3+ years of SaaS implementation experience",
    "• Experience administering employee benefits platforms",
    "• Managed a $2M annual software budget",
    "Perks:",
    "- Paid parental leave for all employees",
    "- 401(k) matching up to four percent",
    "Nice to have:",
    "- Experience with payroll integrations",
    "Compensation: $95,000 – $120,000 per year",
    "- Quarterly team offsites in a new city"
  ].join("\n");
  const input = manualJobImportSchema.parse({ ...baseInput, description });

  assert.deepEqual(new ManualJobImportProvider().normalizeJob(input).requirements, [
    "Own onboarding for new enterprise accounts",
    "Partner with sales on technical discovery calls",
    "3+ years of SaaS implementation experience",
    "Experience administering employee benefits platforms",
    "Managed a $2M annual software budget",
    "Experience with payroll integrations"
  ]);
});

test("manual import of a posting without requirement headings drops only headings, pay lines and the benefits that follow", () => {
  const description = [
    "About Northwind",
    "Strong written communication with customers and partners",
    "Salary range: $70,000 - $90,000 per year",
    "Experience with Zendesk or a similar support tool",
    "Benefits",
    "Health, dental and vision insurance for you and your family"
  ].join("\n");
  const input = manualJobImportSchema.parse({ ...baseInput, description });

  assert.deepEqual(new ManualJobImportProvider().normalizeJob(input).requirements, [
    "Strong written communication with customers and partners",
    "Experience with Zendesk or a similar support tool"
  ]);
});
