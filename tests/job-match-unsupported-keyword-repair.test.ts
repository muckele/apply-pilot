import assert from "node:assert/strict";
import { test } from "node:test";

import {
  JobMatchOutputValidationError,
  validateAndNormalizeJobMatchOutput,
  type JobMatchModelOutput,
  type JobMatchSemanticValidationCode,
  type MatchInput
} from "@/lib/ai/job-match";
import { buildRequirementChecklist } from "@/lib/jobs/requirement-checklist";

// Production 2026-11-13: a paid re-score was refused with UNSUPPORTED_MATCHED_KEYWORD because one
// keyword of one factual match was not a whole word in both that match's quotes. A keyword like
// that is now dropped, and a factual match is dropped only when no keyword is left. Every other
// check still refuses, the scores are Gemini's and stay as they are, and an answer with nothing
// verifiable left is still refused. All text here is invented.

const REQUIREMENTS = ["TypeScript services", "Kubernetes operations", "Postgres tuning"];

const input: MatchInput = {
  job: {
    title: "Synthetic platform engineer",
    company: "Example Co",
    location: "Remote",
    remoteStatus: "Remote",
    salaryMin: null,
    salaryMax: null,
    description: "Run synthetic services.",
    requirements: REQUIREMENTS,
    preferredQualifications: [],
    detectedTechStack: []
  },
  resume: {
    summary: "Synthetic operator",
    rawText: "Built TypeScript services. No Helm experience.",
    skills: ["TypeScript", "Kubernetes", "Postgres"],
    achievements: []
  },
  profile: null
};

type Match = JobMatchModelOutput["factualMatches"][number];

function match(skillIndex: number, supportedKeywords: string[]): Match {
  return {
    applicantEvidence: [{ ref: `resume.skills[${skillIndex}]`, excerpt: input.resume!.skills![skillIndex]! }],
    jobEvidence: [{ ref: `job.requirements[${skillIndex}]`, excerpt: REQUIREMENTS[skillIndex]! }],
    supportedKeywords
  };
}

function output(factualMatches: Match[]): JobMatchModelOutput {
  return {
    contractVersion: "3",
    overallFitScore: 88,
    resumeKeywordScore: 86,
    skillsMatchScore: 87,
    experienceMatchScore: 85,
    careerGoalScore: 80,
    locationWorkStyleScore: 90,
    compensationScore: null,
    confidenceScore: 86,
    confidenceBasis: "Based on the cited fields.",
    factualMatches,
    requirementGaps: [],
    advice: { keywordsToEmphasize: [], resumeAngle: "Lead with the platform work.", coverLetterAngle: "Name the services." },
    recommendation: "apply now"
  };
}

function failsWith(code: JobMatchSemanticValidationCode, fieldPath?: string) {
  return (error: unknown) => error instanceof JobMatchOutputValidationError &&
    error.validationCode === code &&
    (fieldPath === undefined || error.fieldPath === fieldPath);
}

test("one unsupported keyword is dropped and the rest of the paid answer is kept", () => {
  const { modelOutput, normalized, repairs } = validateAndNormalizeJobMatchOutput(input, output([
    match(0, ["TypeScript"]),
    match(1, ["Helm", "Kubernetes"]),
    match(2, ["Postgres"])
  ]));
  assert.deepEqual(normalized.factualMatches.map((item) => item.supportedKeywords), [["TypeScript"], ["Kubernetes"], ["Postgres"]]);
  assert.deepEqual(normalized.supportedKeywords, ["TypeScript", "Kubernetes", "Postgres"]);
  assert.equal(normalized.whyGoodMatch[1], "Submitted applicant evidence matches job evidence for Kubernetes.");
  assert.equal(normalized.overallFitScore, 88);
  assert.equal(normalized.confidenceScore, 86);
  assert.deepEqual(repairs, [{
    action: "DROPPED_KEYWORD",
    validationCode: "UNSUPPORTED_MATCHED_KEYWORD",
    fieldPath: "factualMatches[1].supportedKeywords[0]"
  }]);
  // The cached model output is the repaired one, so a cache hit validates with nothing to repair.
  assert.deepEqual(modelOutput.factualMatches[1]!.supportedKeywords, ["Kubernetes"]);
  assert.deepEqual(validateAndNormalizeJobMatchOutput(input, modelOutput).repairs, []);
});

test("a factual match with no keyword left is dropped, and its requirement reads as not checked, never missing", () => {
  const { normalized, repairs } = validateAndNormalizeJobMatchOutput(input, output([
    match(0, ["TypeScript"]),
    match(1, ["Helm"]),
    match(2, ["Postgres"])
  ]));
  assert.deepEqual(normalized.factualMatches.map((item) => item.supportedKeywords), [["TypeScript"], ["Postgres"]]);
  assert.equal(normalized.whyGoodMatch.length, 2);
  assert.deepEqual(normalized.supportedKeywords, ["TypeScript", "Postgres"]);
  assert.equal(normalized.overallFitScore, 88);
  assert.equal(normalized.confidenceScore, 86);
  assert.deepEqual(repairs, [
    { action: "DROPPED_KEYWORD", validationCode: "UNSUPPORTED_MATCHED_KEYWORD", fieldPath: "factualMatches[1].supportedKeywords[0]" },
    { action: "DROPPED_FACTUAL_MATCH", validationCode: "UNSUPPORTED_MATCHED_KEYWORD", fieldPath: "factualMatches[1]" }
  ]);
  const checklist = buildRequirementChecklist(REQUIREMENTS, normalized);
  assert.deepEqual(checklist.items.map((item) => item.status), ["shown", "not_assessed", "shown"]);
});

test("an answer with nothing verifiable left is still refused", () => {
  assert.throws(
    () => validateAndNormalizeJobMatchOutput(input, output([match(0, ["Rust"]), match(1, ["Helm"])])),
    failsWith("UNSUPPORTED_MATCHED_KEYWORD", "factualMatches[0].supportedKeywords[0]")
  );
});

test("a match with a quote that isn't in the résumé is still refused, not dropped", () => {
  const madeUp = match(1, ["Helm"]);
  madeUp.applicantEvidence = [{ ref: "resume.skills[1]", excerpt: "Kubernetes and Helm" }];
  assert.throws(
    () => validateAndNormalizeJobMatchOutput(input, output([match(0, ["TypeScript"]), madeUp])),
    failsWith("UNSUPPORTED_APPLICANT_EXCERPT", "factualMatches[1].applicantEvidence[0].excerpt")
  );
});

test("a refusal still names the field path Gemini sent when an earlier match would have been dropped", () => {
  const madeUp = match(2, ["Postgres"]);
  madeUp.applicantEvidence = [{ ref: "resume.skills[2]", excerpt: "Postgres and MySQL" }];
  assert.throws(
    () => validateAndNormalizeJobMatchOutput(input, output([match(0, ["TypeScript"]), match(1, ["Helm"]), madeUp])),
    failsWith("UNSUPPORTED_APPLICANT_EXCERPT", "factualMatches[2].applicantEvidence[0].excerpt")
  );
});

test("a match citing an unknown field is still refused, not dropped", () => {
  const unknown = match(1, ["Helm"]);
  unknown.applicantEvidence = [{ ref: "resume.skills[9]", excerpt: "Helm" }];
  assert.throws(
    () => validateAndNormalizeJobMatchOutput(input, output([match(0, ["TypeScript"]), unknown])),
    failsWith("UNKNOWN_APPLICANT_REF")
  );
});

test("a negated résumé line used as a match is still refused, even when the keyword is not in the job quote", () => {
  const negated: Match = {
    applicantEvidence: [{ ref: "resume.rawText", excerpt: "No Helm experience" }],
    jobEvidence: [{ ref: "job.requirements[1]", excerpt: "Kubernetes operations" }],
    supportedKeywords: ["Helm"]
  };
  assert.throws(
    () => validateAndNormalizeJobMatchOutput(input, output([match(0, ["TypeScript"]), negated])),
    failsWith("APPLICANT_EVIDENCE_NEGATION_REVERSAL", "factualMatches[1].applicantEvidence[0].excerpt")
  );
});

test("a match whose keywords are all blank is still refused as empty", () => {
  assert.throws(
    () => validateAndNormalizeJobMatchOutput(input, output([match(0, ["TypeScript"]), match(1, [" "])])),
    failsWith("EMPTY_SUPPORTED_KEYWORDS", "factualMatches[1].supportedKeywords")
  );
});

test("gap keywords are not repaired: a missing keyword that isn't in its requirement is still refused", () => {
  const withGap = output([match(0, ["TypeScript"])]);
  withGap.requirementGaps = [{
    requirement: "Postgres tuning",
    jobRequirement: { ref: "job.requirements[2]", excerpt: "Postgres tuning" },
    missingKeywords: ["tuning", "MySQL"]
  }];
  assert.throws(
    () => validateAndNormalizeJobMatchOutput(input, withGap),
    failsWith("GAP_KEYWORD_NOT_IN_REQUIREMENT", "requirementGaps[0].missingKeywords[1]")
  );
});
