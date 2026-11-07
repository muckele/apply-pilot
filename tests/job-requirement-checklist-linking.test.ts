import assert from "node:assert/strict";
import test from "node:test";

import { validateAndNormalizeJobMatchOutput, type MatchInput } from "@/lib/ai/job-match";
import { buildRequirementChecklist, summarizeChecklist } from "@/lib/jobs/requirement-checklist";

// Synthetic posting shaped like a Greenhouse job: the requirements list is every <li> on the page
// (duties, must-haves, nice-to-haves, benefits), capped at 24, and the description is the whole
// page flattened to one line, so every bullet also appears verbatim inside job.description.
const duties = [
  "Run technical discovery calls with prospective customers alongside Account Executives",
  "Build and deliver tailored product demonstrations for data and analytics teams",
  "Scope proof-of-concept projects and guide customers through evaluation",
  "Answer security questionnaires and RFP technical sections",
  "Partner with Product to relay customer feedback and feature requests",
  "Create reusable demo environments and technical enablement content",
  "Support renewals and expansion conversations with existing accounts",
  "Travel to customer sites up to 25% of the time"
];
const mustHaves = [
  "5+ years in a customer-facing technical role such as solutions engineering or consulting",
  "Hands-on experience with SQL and relational data modeling",
  "Working knowledge of REST APIs and webhooks",
  "Experience with Python for scripting and data analysis",
  "Familiarity with cloud data warehouses like Snowflake or BigQuery",
  "Excellent written and verbal communication skills",
  "Ability to explain complex technical concepts to non-technical audiences",
  "Experience supporting enterprise sales cycles with multiple stakeholders",
  "Comfort working in a fast-paced startup environment",
  "Bachelor's degree in a technical field or equivalent experience"
];
const niceToHaves = [
  "Experience with Salesforce or HubSpot CRM workflows",
  "Prior experience at a B2B SaaS analytics company"
];
const benefits = [
  "Competitive salary and meaningful equity",
  "Comprehensive medical, dental and vision coverage",
  "Flexible paid time off and company-wide recharge weeks",
  "Annual learning and development stipend"
];
const requirements = [...duties, ...mustHaves, ...niceToHaves, ...benefits];
const description = [
  "Quillfern Data builds analytics tooling for growing teams.",
  "As a Solutions Engineer you will help prospects who write SQL every day evaluate Quillfern.",
  "What you'll do", ...duties,
  "What you bring", ...mustHaves,
  "Nice to have", ...niceToHaves,
  "Benefits", ...benefits
].join(" ");

const input: MatchInput = {
  job: {
    title: "Solutions Engineer",
    company: "Quillfern Data",
    location: "Remote",
    description,
    requirements,
    preferredQualifications: [],
    detectedTechStack: ["SQL", "REST", "Python", "Salesforce", "HubSpot", "APIs"]
  },
  resume: {
    summary: "Solutions engineer who explained complex technical concepts to non-technical buyers.",
    skills: ["SQL", "REST APIs", "Python", "Snowflake", "HubSpot"],
    workHistory: [{
      title: "Solutions Engineer",
      company: "Larkspur Metrics",
      startDate: "2016-01",
      endDate: "Present",
      bullets: [
        "Ran technical discovery calls for mid-market prospects.",
        "Built tailored product demonstrations for analytics buyers.",
        "Scoped proof-of-concept projects with customer data teams.",
        "Completed security questionnaires for enterprise deals.",
        "Supported enterprise sales cycles with six-person buying committees."
      ]
    }],
    education: [{ degree: "Bachelor of Science in Computer Science", school: "Example State University" }]
  },
  profile: null
};

function match(applicant: [string, string], job: [string, string], keyword: string) {
  return {
    applicantEvidence: [{ ref: applicant[0], excerpt: applicant[1] }],
    jobEvidence: [{ ref: job[0], excerpt: job[1] }],
    supportedKeywords: [keyword]
  };
}

function gap(index: number, keyword: string) {
  return {
    requirement: requirements[index]!,
    jobRequirement: { ref: `job.requirements[${index}]`, excerpt: requirements[index]! },
    missingKeywords: [keyword]
  };
}

// What the model returns: most factual matches quote the posting through job.description (or the
// detected tech stack, or the title); only gaps are forced to cite job.requirements[n].
const modelOutput = {
  contractVersion: "3",
  overallFitScore: 78, resumeKeywordScore: 74, skillsMatchScore: 80, experienceMatchScore: 76,
  careerGoalScore: 70, locationWorkStyleScore: 90, compensationScore: null, confidenceScore: 70,
  confidenceBasis: "Based on the cited submitted fields; limitations include no salary data.",
  factualMatches: [
    match(["resume.workHistory[0]", "Ran technical discovery calls"], ["job.description", "Run technical discovery calls with prospective customers"], "discovery calls"),
    match(["resume.workHistory[0]", "Built tailored product demonstrations"], ["job.description", "deliver tailored product demonstrations"], "product demonstrations"),
    match(["resume.workHistory[0]", "Scoped proof-of-concept projects"], ["job.description", "Scope proof-of-concept projects"], "proof-of-concept"),
    match(["resume.workHistory[0]", "Completed security questionnaires"], ["job.description", "Answer security questionnaires"], "security questionnaires"),
    // "SQL" is in the intro prose and in a must-have: the quote cannot be pinned to one requirement.
    match(["resume.skills[0]", "SQL"], ["job.description", "SQL"], "SQL"),
    match(["resume.skills[1]", "REST APIs"], ["job.description", "REST APIs and webhooks"], "REST APIs"),
    match(["resume.skills[2]", "Python"], ["job.detectedTechStack[2]", "Python"], "Python"),
    match(["resume.skills[3]", "Snowflake"], ["job.description", "Snowflake or BigQuery"], "Snowflake"),
    match(["resume.summary", "explained complex technical concepts to non-technical"], ["job.description", "explain complex technical concepts to non-technical audiences"], "technical concepts"),
    match(["resume.workHistory[0]", "Supported enterprise sales cycles"], ["job.description", "supporting enterprise sales cycles with multiple stakeholders"], "enterprise sales cycles"),
    // The title is not a requirement.
    match(["resume.workHistory[0]", "Solutions Engineer"], ["job.title", "Solutions Engineer"], "Solutions Engineer"),
    match(["resume.skills[4]", "HubSpot"], ["job.description", "Salesforce or HubSpot CRM workflows"], "HubSpot"),
    match(["resume.education[0]", "Bachelor of Science"], ["job.description", "Bachelor's degree in a technical field"], "Bachelor")
  ],
  requirementGaps: [gap(16, "startup"), gap(19, "B2B")],
  advice: { keywordsToEmphasize: ["discovery calls"], resumeAngle: "Lead with discovery work.", coverLetterAngle: "Mention demos." },
  recommendation: "apply now"
};

const storedOutput = validateAndNormalizeJobMatchOutput(input, modelOutput, { asOf: new Date("2026-11-01T00:00:00Z") }).normalized;

test("a 24-bullet posting links every requirement the match quoted, not only exact job.requirements refs", () => {
  const checklist = buildRequirementChecklist(requirements, storedOutput, { description });
  const byStatus = (status: string) => checklist.items.flatMap((item, index) => item.status === status ? [index] : []);

  assert.deepEqual(byStatus("shown"), [0, 1, 2, 3, 10, 11, 12, 14, 15, 17, 18]);
  assert.deepEqual(byStatus("not_shown"), [16, 19]);
  // Never quoted (or quoted ambiguously, like "SQL") stays unassessed: 9 is not marked shown.
  assert.deepEqual(byStatus("not_assessed"), [4, 5, 6, 7, 8, 9, 13, 20, 21, 22, 23]);
  assert.deepEqual(checklist.counts, { shown: 11, notShown: 2, notAssessed: 11, total: 24 });
  assert.deepEqual(summarizeChecklist(checklist.counts), {
    heading: "Your résumé shows 11 of 13 checked must-haves",
    notChecked: "11 not checked yet"
  });

  const python = checklist.items[11]!;
  assert.equal(python.jobRef, "job.requirements[11]");
  assert.equal(python.claim, "Submitted applicant evidence matches job evidence for Python.");
  assert.deepEqual(python.resumeLines, ["Python"]);
});

test("without the posting's description only exact job.requirements refs link, as before", () => {
  const checklist = buildRequirementChecklist(requirements, storedOutput);
  assert.deepEqual(checklist.counts, { shown: 0, notShown: 2, notAssessed: 22, total: 24 });
});

const small = ["Experience with SQL reporting", "Advanced SQL tuning", "Python scripting for data teams", "Previous title of Solutions Engineer"];
const smallDescription = `Python powers our internal tools. ${small.join(" ")}`;
function quoted(ref: string, excerpt: string) {
  return { claim: `Matches ${excerpt}.`, applicantEvidence: [{ ref: "resume.rawText", excerpt }], jobEvidence: [{ ref, excerpt }] };
}

test("a quote that sits in two requirements, or also outside the list, or in the title, links nothing", () => {
  const checklist = buildRequirementChecklist(small, {
    factualMatches: [
      quoted("job.description", "SQL"),
      quoted("job.description", "Python"),
      quoted("job.detectedTechStack[0]", "Python"),
      quoted("job.title", "Solutions Engineer")
    ],
    requirementGaps: []
  }, { description: smallDescription });
  assert.deepEqual(checklist.items.map((item) => item.status), ["not_assessed", "not_assessed", "not_assessed", "not_assessed"]);
});

test("a quote held by two requirements links neither, even when the description does not repeat them", () => {
  // A manually added job: its requirements were typed separately, so the description lacks them.
  const checklist = buildRequirementChecklist(small, {
    factualMatches: [quoted("job.detectedTechStack[0]", "SQL")],
    requirementGaps: []
  }, { description: "Data role on the platform team." });
  assert.deepEqual(checklist.items.map((item) => item.status), ["not_assessed", "not_assessed", "not_assessed", "not_assessed"]);
});

test("a quote that only part of a word matches does not link", () => {
  const checklist = buildRequirementChecklist(["PostgreSQL administration"], {
    factualMatches: [quoted("job.description", "SQL")],
    requirementGaps: []
  }, { description: "PostgreSQL administration" });
  assert.equal(checklist.items[0]!.status, "not_assessed");
});

test("a gap on a requirement still wins over a match located through the description", () => {
  const checklist = buildRequirementChecklist(small, {
    factualMatches: [quoted("job.description", "SQL reporting")],
    requirementGaps: [{ requirement: small[0], jobRequirement: { ref: "job.requirements[0]", excerpt: small[0] } }]
  }, { description: smallDescription });
  assert.equal(checklist.items[0]!.status, "not_shown");
  assert.equal(checklist.counts.shown, 0);
});

test("a typographic variant of the quote (curly apostrophe, extra spaces) still locates its requirement", () => {
  const checklist = buildRequirementChecklist(["Bachelor’s degree in a technical field"], {
    factualMatches: [quoted("job.description", "Bachelor's  degree")],
    requirementGaps: []
  }, { description: "What you bring Bachelor’s degree in a technical field" });
  assert.equal(checklist.items[0]!.status, "shown");
});
