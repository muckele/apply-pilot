import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildJobMatchResponseJsonSchema,
  buildJobMatchSystemPrompt,
  getJobMatchOwnerLineLinks,
  getJobMatchRequirementsToJudge,
  JOB_MATCH_PROMPT_VERSION,
  JOB_MATCH_REQUIREMENTS_TO_JUDGE_LIMIT,
  JobMatchOutputValidationError,
  jobMatchModelOutputSchema,
  validateAndNormalizeJobMatchOutput,
  type JobMatchModelOutput,
  type MatchInput
} from "@/lib/ai/job-match";
import { jobMatchPrompt } from "@/prompts/jobMatchPrompt";
import { buildRequirementChecklist } from "@/lib/jobs/requirement-checklist";

// Production 2026-11-12 (prompt 3.4): the owner wrote step-2 lines for four requirements the first
// JOB_MATCH left "Not checked". The paid re-score left the same four unchecked and flagged a
// requirement the first run skipped. Gemini cited only the requirements it chose, and nothing told
// it which requirement an owner line answered. Prompt 3.5 asks for a verdict on every listed
// requirement, links each owner line to its requirement, and never refuses a paid answer for a
// requirement Gemini still skips: that requirement stays unjudged and is reported. All text here is
// invented.

const REQUIREMENTS = [
  "Excellent written communication with customers",
  "Experience with Zendesk",
  "Comfortable mentoring new teammates"
];
// Shares no whole term with "Comfortable mentoring new teammates".
const LINE = "Coached three recent hires through their first quarter on the help desk.";

function inputWith(options: { requirements?: string[]; lineFor?: string } = {}): MatchInput {
  return {
    job: {
      title: "Synthetic support analyst",
      company: "Example Co",
      location: "Remote",
      remoteStatus: "Remote",
      salaryMin: null,
      salaryMax: null,
      description: "Support synthetic customers.",
      requirements: options.requirements ?? REQUIREMENTS,
      preferredQualifications: [],
      detectedTechStack: []
    },
    resume: { summary: "Support analyst", rawText: "Answered tickets in Zendesk.", skills: ["Zendesk"], achievements: [] },
    profile: null,
    reviewedEvidence: {
      schema: "apply-pilot/job-match-reviewed-evidence/v1",
      snapshotId: "snapshot-1",
      snapshotHash: "a".repeat(64),
      facts: [{ gapId: options.lineFor ?? "requirement:2", fact: LINE, provenance: "OWNER_ATTESTED", sourceRef: null }],
      unresolvedGapIds: []
    }
  };
}

function output(overrides: Partial<JobMatchModelOutput> = {}): JobMatchModelOutput {
  return {
    contractVersion: "3",
    overallFitScore: 74,
    resumeKeywordScore: 70,
    skillsMatchScore: 72,
    experienceMatchScore: 70,
    careerGoalScore: 70,
    locationWorkStyleScore: 80,
    compensationScore: null,
    confidenceScore: 70,
    confidenceBasis: "Based on the cited fields.",
    factualMatches: [
      {
        applicantEvidence: [{ ref: "resume.rawText", excerpt: "Zendesk" }],
        jobEvidence: [{ ref: "job.requirements[1]", excerpt: "Zendesk" }],
        supportedKeywords: ["Zendesk"]
      },
      {
        applicantEvidence: [{ ref: "reviewedEvidence.facts[0]", excerpt: LINE }],
        jobEvidence: [{ ref: "job.requirements[2]", excerpt: "Comfortable mentoring new teammates" }],
        supportedKeywords: ["mentoring"]
      }
    ],
    requirementGaps: [{
      requirement: REQUIREMENTS[0]!,
      jobRequirement: { ref: "job.requirements[0]", excerpt: REQUIREMENTS[0]! },
      missingKeywords: ["written"]
    }],
    advice: { keywordsToEmphasize: [], resumeAngle: "Lead with support work.", coverLetterAngle: "Name the help desk." },
    recommendation: "consider",
    ...overrides
  };
}

function promptLineJson(prompt: string, label: string) {
  const line = prompt.split("\n").find((candidate) => candidate.startsWith(label));
  assert.ok(line, `prompt line "${label}"`);
  return JSON.parse(line.slice(line.indexOf(": ") + 2)) as unknown;
}

test("JOB_MATCH uses prompt/cache revision 3.5 for a verdict on every listed requirement", () => {
  assert.equal(JOB_MATCH_PROMPT_VERSION, "3.5");
});

test("the prompt asks for a verdict on every listed requirement instead of omitting uncertain gaps", () => {
  assert.match(jobMatchPrompt, /Judge every requirement listed under "Requirements to judge"/u);
  assert.match(jobMatchPrompt, /never leave one out/iu);
  assert.match(jobMatchPrompt, /missingKeywords may be empty/iu);
  assert.doesNotMatch(jobMatchPrompt, /omit the gap|omit the entire gap/iu);
});

test("the input-specific prompt lists the requirements to judge: requirement lines only, at most 24", () => {
  const requirements = [
    "What you'll bring:",
    "Experience with Zendesk",
    "   ",
    "Base salary range: $90,000 - $110,000 per year",
    ...Array.from({ length: 30 }, (_, index) => `Synthetic requirement number ${index + 1}`)
  ];
  const input = inputWith({ requirements });
  const asked = getJobMatchRequirementsToJudge(input);

  assert.equal(JOB_MATCH_REQUIREMENTS_TO_JUDGE_LIMIT, 24);
  assert.equal(asked.length, 24);
  assert.equal(asked[0], "job.requirements[1]");
  assert.equal(asked[1], "job.requirements[4]");
  assert.equal(asked.at(-1), "job.requirements[26]");
  assert.deepEqual(promptLineJson(buildJobMatchSystemPrompt(input), "Requirements to judge"), asked);
});

test("an owner line written for a listed requirement is linked to that requirement in the prompt", () => {
  const input = inputWith();
  input.reviewedEvidence = {
    ...input.reviewedEvidence!,
    facts: [
      { gapId: "requirement:2", fact: LINE, provenance: "OWNER_ATTESTED", sourceRef: null },
      { gapId: "gap:0", fact: "Answered synthetic tickets.", provenance: "OWNER_ATTESTED", sourceRef: null },
      { gapId: "requirement:9", fact: "A line for a requirement no longer listed.", provenance: "OWNER_ATTESTED", sourceRef: null }
    ]
  };

  assert.deepEqual(getJobMatchOwnerLineLinks(input), { "reviewedEvidence.facts[0]": "job.requirements[2]" });
  assert.deepEqual(promptLineJson(buildJobMatchSystemPrompt(input), "Applicant lines written for one requirement"), {
    "reviewedEvidence.facts[0]": "job.requirements[2]"
  });
});

test("a gap may name no missing keyword, while a factual match still needs one", () => {
  const schema = buildJobMatchResponseJsonSchema(inputWith()) as unknown as {
    properties: {
      factualMatches: { items: { properties: { supportedKeywords: { minItems?: number } } } };
      requirementGaps: { items: { properties: { missingKeywords: { minItems?: number } } } };
    };
  };
  assert.equal(schema.properties.requirementGaps.items.properties.missingKeywords.minItems, undefined);
  assert.equal(schema.properties.factualMatches.items.properties.supportedKeywords.minItems, 1);

  const noKeyword = output();
  noKeyword.requirementGaps[0]!.missingKeywords = [];
  assert.equal(jobMatchModelOutputSchema.safeParse(noKeyword).success, true);
  const { normalized } = validateAndNormalizeJobMatchOutput(inputWith(), noKeyword);
  assert.deepEqual(normalized.requirementGaps.map((gap) => gap.jobRequirement.ref), ["job.requirements[0]"]);
  assert.deepEqual(normalized.missingKeywords, []);
});

test("an owner line can support its own requirement in other words", () => {
  const input = inputWith();
  const { normalized } = validateAndNormalizeJobMatchOutput(input, output());

  const lineMatch = normalized.factualMatches[1]!;
  assert.equal(lineMatch.applicantEvidence[0]!.excerpt, LINE);
  assert.equal(lineMatch.applicantEvidence[0]!.provenance, "OWNER_ATTESTED");
  assert.equal(lineMatch.claim, "The line you gave for this requirement covers mentoring.");
  // Résumé matches keep their wording.
  assert.equal(normalized.factualMatches[0]!.claim, "Submitted applicant evidence matches job evidence for Zendesk.");

  const item = buildRequirementChecklist(REQUIREMENTS, normalized).items[2]!;
  assert.equal(item.status, "shown");
  assert.deepEqual(item.resumeLines, [LINE]);
});

test("an owner line written for another requirement still needs a shared term", () => {
  assert.throws(
    () => validateAndNormalizeJobMatchOutput(inputWith({ lineFor: "requirement:0" }), output()),
    (error: unknown) => error instanceof JobMatchOutputValidationError &&
      error.validationCode === "UNSUPPORTED_MATCHED_KEYWORD" &&
      error.fieldPath === "factualMatches[1].supportedKeywords[0]"
  );
});

test("an owner line's keyword must still come from the requirement it answers", () => {
  const coaching = output();
  coaching.factualMatches[1]!.supportedKeywords = ["leadership"];
  assert.throws(
    () => validateAndNormalizeJobMatchOutput(inputWith(), coaching),
    (error: unknown) => error instanceof JobMatchOutputValidationError &&
      error.validationCode === "UNSUPPORTED_MATCHED_KEYWORD"
  );
});

test("a paid answer that skips a requirement is kept, and the skipped requirement is reported unjudged", () => {
  const skipped = output({ requirementGaps: [] });
  const { normalized } = validateAndNormalizeJobMatchOutput(inputWith(), skipped);

  assert.deepEqual(normalized.requirementCoverage, {
    askedRefs: ["job.requirements[0]", "job.requirements[1]", "job.requirements[2]"],
    unjudgedRefs: ["job.requirements[0]"],
    setAsideGaps: []
  });
  assert.equal(buildRequirementChecklist(REQUIREMENTS, normalized).items[0]!.status, "not_assessed");
});

test("a full answer reports every requirement judged", () => {
  const { normalized } = validateAndNormalizeJobMatchOutput(inputWith(), output());
  assert.deepEqual(normalized.requirementCoverage.unjudgedRefs, []);
  assert.deepEqual(normalized.requirementCoverage.setAsideGaps, []);
});

test("a gap whose missing keyword is on the résumé is set aside, not shown and not refused", () => {
  const refuted = output();
  refuted.factualMatches = [refuted.factualMatches[1]!];
  refuted.requirementGaps.push({
    requirement: REQUIREMENTS[1]!,
    jobRequirement: { ref: "job.requirements[1]", excerpt: REQUIREMENTS[1]! },
    missingKeywords: ["Zendesk"]
  });
  const { normalized } = validateAndNormalizeJobMatchOutput(inputWith(), refuted);

  assert.deepEqual(normalized.requirementGaps.map((gap) => gap.jobRequirement.ref), ["job.requirements[0]"]);
  assert.deepEqual(normalized.missingKeywords, ["written"]);
  assert.deepEqual(normalized.concerns, [REQUIREMENTS[0]]);
  assert.deepEqual(normalized.requirementCoverage.setAsideGaps, [
    { ref: "job.requirements[1]", validationCode: "GAP_KEYWORD_PRESENT_IN_APPLICANT_EVIDENCE" }
  ]);
  assert.deepEqual(normalized.requirementCoverage.unjudgedRefs, ["job.requirements[1]"]);
  assert.equal(buildRequirementChecklist(REQUIREMENTS, normalized).items[1]!.status, "not_assessed");
});

test("a gap resting only on an illustrative example, or on a term the requirement lacks, is set aside", () => {
  const requirements = [...REQUIREMENTS, "Experience with help desk tools such as Freshdesk"];
  const input = inputWith({ requirements });
  const illustrative = output();
  illustrative.requirementGaps = [
    {
      requirement: requirements[3]!,
      jobRequirement: { ref: "job.requirements[3]", excerpt: requirements[3]! },
      missingKeywords: ["Freshdesk"]
    },
    {
      requirement: requirements[0]!,
      jobRequirement: { ref: "job.requirements[0]", excerpt: requirements[0]! },
      missingKeywords: ["phone"]
    }
  ];
  const { normalized } = validateAndNormalizeJobMatchOutput(input, illustrative);

  assert.deepEqual(normalized.requirementGaps, []);
  assert.deepEqual(normalized.requirementCoverage.setAsideGaps, [
    { ref: "job.requirements[3]", validationCode: "GAP_KEYWORD_ILLUSTRATIVE_ONLY" },
    { ref: "job.requirements[0]", validationCode: "GAP_KEYWORD_NOT_IN_REQUIREMENT" }
  ]);
  assert.deepEqual(normalized.requirementCoverage.unjudgedRefs, ["job.requirements[0]", "job.requirements[3]"]);
});

test("a gap that misquotes its requirement is still refused", () => {
  const paraphrased = output();
  paraphrased.requirementGaps[0]!.requirement = "Great written communication";
  assert.throws(
    () => validateAndNormalizeJobMatchOutput(inputWith(), paraphrased),
    (error: unknown) => error instanceof JobMatchOutputValidationError &&
      error.validationCode === "GAP_REQUIREMENT_NOT_EXACT"
  );
});
