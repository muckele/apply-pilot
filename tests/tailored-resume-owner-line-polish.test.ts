import assert from "node:assert/strict";
import test from "node:test";

import type { ApplicationDocumentPayload } from "@/lib/ai/application-document-claims";
import {
  assembleTailoredResumeProviderOutput,
  buildApplicationDocumentFactCatalog,
  type TailoredResumeProviderOutput
} from "@/lib/ai/application-document-facts";
import { finalizeTailoredResume } from "@/lib/ai/application-document-quality";
import { buildApplicationDocumentPayload, ownerFactForDocuments } from "@/lib/ai/resume-tailoring-payload";
import { ownerLineInResumeVoice } from "@/lib/ai/tailored-resume-keep-rule";

// Live case 2026-11-14 (shape only; every name and fact here is invented): a tailored résumé that
// passed every truth check still read like a questionnaire. Owner lines typed as answers kept their
// "Yes." and their present-tense "I" ("I build…", "I write…", "I respond…"), a line under an
// employer repeated "At <that employer>,", and a skills line split at semicolons lost its label.

const CUSTOMER = "Customer work: Discovery calls, account reviews, renewals.";
const TOOLS = "Tools and development: Zendesk, Jira; JavaScript, SQL, GitHub; Postman.";
const NORTHWIND = "Support Lead | Northwind Rentals | 2019 – 2021";
const NORTHWIND_BULLETS = ["Resolved 40+ rental support tickets a day.", "Trained six new support agents."];
const TRAVEL = "Account Manager | Example Travel | 2016 – 2019";
const TRAVEL_BULLETS = ["Managed 80 partner hotel accounts."];

// Owner lines as typed on the Apply page, answering the job's must-haves.
const OWNER_REPORTS = "I write bug reports with clear repro steps and logs. At Northwind Rentals I worked closely with engineering on site fixes.";
const OWNER_WEBHOOKS = "I build and debug webhook integrations for my own apps.";
const OWNER_LOCATION = "Yes. I’m based in Riverton, on Pacific Time.";
const OWNER_RESPONSE = "I respond quickly and own each issue until it’s resolved.";

const SOURCE = [
  "Sam Sample",
  "sam@example.test | +1 555 010 0199 | Riverton",
  "",
  "SKILLS",
  CUSTOMER,
  TOOLS,
  "",
  "EXPERIENCE",
  NORTHWIND,
  ...NORTHWIND_BULLETS.map((value) => `• ${value}`),
  "",
  TRAVEL,
  ...TRAVEL_BULLETS.map((value) => `• ${value}`)
].join("\n");

// The payload both documents are written from, as the server builds it.
function payload(owner = [OWNER_REPORTS, OWNER_WEBHOOKS, OWNER_LOCATION, OWNER_RESPONSE]): ApplicationDocumentPayload {
  const raw = {
    job: { title: "Product Support Specialist", company: "Example Software", requirements: ["Clear bug reports"], description: "Support customers." },
    resume: {
      rawText: SOURCE,
      summary: "",
      skills: ["Discovery calls", "Account reviews", "Renewals", "Zendesk", "Jira", "JavaScript", "SQL", "GitHub", "Postman"],
      achievements: [],
      workHistory: [
        { sourceText: [NORTHWIND, ...NORTHWIND_BULLETS.map((value) => `• ${value}`)].join("\n"), company: "Northwind Rentals",
          title: "Support Lead", location: null, startDate: "2019", endDate: "2021", bullets: NORTHWIND_BULLETS },
        { sourceText: [TRAVEL, ...TRAVEL_BULLETS.map((value) => `• ${value}`)].join("\n"), company: "Example Travel",
          title: "Account Manager", location: null, startDate: "2016", endDate: "2019", bullets: TRAVEL_BULLETS }
      ],
      projects: [],
      education: [],
      certifications: []
    },
    profile: { skillsToEmphasize: [] },
    reviewedEvidence: {
      schema: "synthetic", snapshotId: "snapshot", snapshotHash: "hash", unresolvedGapIds: [],
      facts: owner.map((fact, index) => ({ gapId: `gap-${index}`, provenance: "OWNER_ATTESTED", sourceRef: null, fact }))
    }
  };
  return buildApplicationDocumentPayload(raw.job, raw.resume, raw.profile, raw.reviewedEvidence);
}

// Gemini's wire answer: each content line cites the catalog facts named in CITES (or the fact with
// its own text). Headings are not cited.
const HEADINGS = new Set(["SKILLS", "EXPERIENCE", "ADDITIONAL INFORMATION"]);
const CITES = new Map<string, string[]>([
  ["Customer work: Discovery calls, account reviews, renewals", ["Discovery calls", "Account reviews", "Renewals"]],
  ["At Northwind Rentals, worked closely with engineering on site fixes.", ["At Northwind Rentals I worked closely with engineering on site fixes."]],
  ["Yes. Based in Riverton, on Pacific Time.", ["I’m based in Riverton, on Pacific Time."]],
  ["I write bug reports with clear repro steps and logs.", ["I write bug reports with clear repro steps and logs."]]
]);
function wire(source: ApplicationDocumentPayload, resumeText: string): TailoredResumeProviderOutput {
  const facts = buildApplicationDocumentFactCatalog(source);
  const resumeTextClaims = resumeText.split("\n")
    .map((line) => line.trim().replace(/^•\s+/u, ""))
    .filter((line) => line && !HEADINGS.has(line))
    .map((claim) => {
      const excerpts = CITES.get(claim) ?? [claim];
      const factIds = excerpts.map((excerpt) => {
        const fact = facts.find((value) => value.excerpt.toLocaleLowerCase() === excerpt.toLocaleLowerCase());
        assert.ok(fact, `synthetic fact for: ${excerpt}`);
        return fact.factId;
      });
      return { claim, factIds };
    });
  return {
    professionalSummary: "", professionalSummaryFactId: "__NO_APPLICANT_FACT__", skillsSection: [], bulletRewrites: [],
    rolesOrProjectsToEmphasize: [], resumeTextClaims, unsupportedKeywords: [], formattingWarnings: [], resumeText
  };
}

// The résumé Gemini wrote in the live case, in this fixture's words.
const GEMINI = [
  "Sam Sample",
  "sam@example.test | +1 555 010 0199 | Riverton",
  "",
  "SKILLS",
  "Customer work: Discovery calls, account reviews, renewals",
  "JavaScript, SQL, GitHub",
  "",
  "EXPERIENCE",
  NORTHWIND,
  "• At Northwind Rentals, worked closely with engineering on site fixes.",
  ...NORTHWIND_BULLETS.map((value) => `• ${value}`),
  "",
  TRAVEL,
  ...TRAVEL_BULLETS.map((value) => `• ${value}`),
  "",
  "ADDITIONAL INFORMATION",
  "Yes. Based in Riverton, on Pacific Time.",
  OWNER_WEBHOOKS,
  "I write bug reports with clear repro steps and logs.",
  OWNER_RESPONSE
].join("\n");

function tailor() {
  const source = payload();
  return finalizeTailoredResume(source, assembleTailoredResumeProviderOutput(source, wire(source, GEMINI)));
}
function lines(text: string) {
  return text.split("\n").map((line) => line.trim().replace(/^•\s+/u, "")).filter(Boolean);
}

test("a saved answer's Yes or No never reaches either document", () => {
  const excerpts = buildApplicationDocumentFactCatalog(payload()).map((fact) => fact.excerpt);
  assert.ok(excerpts.includes("I’m based in Riverton, on Pacific Time."));
  assert.equal(excerpts.some((excerpt) => /^(?:yes|no)\b/iu.test(excerpt)), false);
  const answers = payload(["Yes, I’m based in Riverton.", "No.", "Yes. I write weekly notes.\nNo, I need no visa."]);
  assert.deepEqual((answers.reviewedEvidence!.facts as Array<{ fact: string }>).map((fact) => fact.fact),
    ["I’m based in Riverton.", "", "I write weekly notes.\nI need no visa."]);
  const owned = buildApplicationDocumentFactCatalog(answers).filter((fact) => fact.ref.startsWith("reviewedEvidence."));
  assert.deepEqual(owned.map((fact) => fact.excerpt), ["I’m based in Riverton.", "I write weekly notes.", "I need no visa."]);
  // Only an answer word goes: a sentence that merely starts with No, or "No. 1", stays as typed.
  for (const typed of ["No customer waited more than a day.", "No. 1 in regional sales in 2020.", "No, but I have used Jira daily."]) {
    assert.equal(ownerFactForDocuments(typed), typed);
  }
});

test("present-tense first-person owner lines read in résumé voice, and Yes or No is dropped", () => {
  assert.equal(ownerLineInResumeVoice(OWNER_WEBHOOKS), "Build and debug webhook integrations for my own apps.");
  assert.equal(ownerLineInResumeVoice(OWNER_RESPONSE), "Respond quickly and own each issue until it’s resolved.");
  assert.equal(ownerLineInResumeVoice(OWNER_LOCATION), "Based in Riverton, on Pacific Time.");
  assert.equal(ownerLineInResumeVoice("At Northwind Rentals I write the weekly release notes."), "At Northwind Rentals, write the weekly release notes.");
  // A stative verb, a modal or anything else stays as typed.
  for (const typed of ["I speak Spanish.", "I hold a current forklift licence.", "I can start in January.", "I care about fast tools."]) {
    assert.equal(ownerLineInResumeVoice(typed), typed);
  }
});

test("the tailored résumé reads like a résumé: no answer words, no leading I, no repeated employer, labelled skills", () => {
  const result = tailor();
  const all = lines(result.resumeText);
  assert.equal(all.some((line) => /\bYes\b/u.test(line)), false, "no Yes");
  assert.equal(all.some((line) => /^I\s/u.test(line)), false, "no leading I");
  for (const line of [
    "Based in Riverton, on Pacific Time.",
    "Build and debug webhook integrations for my own apps.",
    "Write bug reports with clear repro steps and logs.",
    "Respond quickly and own each issue until it’s resolved.",
    "Worked closely with engineering on site fixes.",
  ]) assert.ok(all.includes(line), `missing: ${line}`);
  // The tools line keeps its source label (the keep rule may restore more of its tools).
  const tools = all.find((line) => line.includes("JavaScript, SQL, GitHub"));
  assert.ok(tools?.startsWith("Tools and development: "), `labelled: ${tools}`);
  // The Northwind line still reads under Northwind Rentals, without naming it again.
  assert.ok(all.indexOf("Worked closely with engineering on site fixes.") > all.indexOf(NORTHWIND));
  assert.ok(all.indexOf("Worked closely with engineering on site fixes.") < all.indexOf(TRAVEL));
  assert.equal(all.some((line) => line.startsWith("At Northwind Rentals,")), false);
  // Every line the reader sees is backed by a claim or by a fact's own words.
  for (const line of [tools!, "Worked closely with engineering on site fixes."]) {
    assert.ok(result.claimEvidence.some((entry) => entry.claim === line), `claim for: ${line}`);
  }
});
