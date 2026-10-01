import assert from "node:assert/strict";
import { test } from "node:test";

import {
  JOB_MATCH_PROMPT_VERSION,
  normalizeJobMatchOutput,
  type MatchInput,
  type JobMatchModelOutput
} from "@/lib/ai/job-match";
import { buildJobMatchPostingUpdate } from "@/lib/jobs/job-match-projection";

const baseInput: MatchInput = {
  job: {
    title: "Platform Engineer",
    company: "Example Co",
    location: "Remote",
    remoteStatus: "Remote",
    salaryMin: 120_000,
    salaryMax: 150_000,
    description: "Build reliable services with TypeScript.",
    requirements: ["TypeScript"],
    preferredQualifications: ["Kubernetes"],
    detectedTechStack: ["TypeScript"]
  },
  resume: {
    summary: "Platform engineer",
    rawText: "Built TypeScript services.",
    skills: ["TypeScript"],
    achievements: ["Improved service reliability"]
  },
  profile: {
    careerGoals: "Build reliable services",
    preferredRoles: ["Platform Engineer"],
    preferredLocations: ["Remote"],
    remotePreference: "Remote",
    salaryTargetMin: 125_000,
    salaryTargetMax: 145_000,
    skillsToEmphasize: ["TypeScript"],
    skillsNotToExaggerate: ["Kubernetes"]
  }
};

const baseModelOutput: JobMatchModelOutput = {
  contractVersion: "3",
  overallFitScore: 82,
  resumeKeywordScore: 80,
  skillsMatchScore: 84,
  experienceMatchScore: 78,
  careerGoalScore: 86,
  locationWorkStyleScore: 90,
  compensationScore: 75,
  confidenceScore: 79,
  confidenceBasis: "The assessment is based on the cited applicant and job fields.",
  factualMatches: [
    {
      applicantEvidence: [{ ref: "resume.skills[0]", excerpt: "TypeScript" }],
      jobEvidence: [{ ref: "job.requirements[0]", excerpt: "TypeScript" }],
      supportedKeywords: ["TypeScript"]
    }
  ],
  requirementGaps: [
    {
      requirement: "Kubernetes",
      jobRequirement: { ref: "job.preferredQualifications[0]", excerpt: "Kubernetes" },
      missingKeywords: ["Kubernetes"]
    }
  ],
  advice: {
    keywordsToEmphasize: ["TypeScript"],
    resumeAngle: "Describe the supported TypeScript service work clearly.",
    coverLetterAngle: "Discuss interest in reliable platform services without claiming Kubernetes experience."
  },
  recommendation: "consider"
};

function cloneOutput() {
  return structuredClone(baseModelOutput);
}

test("JOB_MATCH uses the v3 prompt and cache contract", () => {
  assert.equal(JOB_MATCH_PROMPT_VERSION, "3");
});

test("compensation keeps null distinct from a genuine numeric zero", () => {
  const explicitNull = cloneOutput();
  explicitNull.compensationScore = null;
  const unknown = normalizeJobMatchOutput(baseInput, explicitNull);
  assert.equal(unknown.compensationScore, null);
  assert.equal(unknown.compensationAssessment.reason, "model_did_not_assess");

  const explicitZero = cloneOutput();
  explicitZero.compensationScore = 0;
  const zero = normalizeJobMatchOutput(baseInput, explicitZero);
  assert.equal(zero.compensationScore, 0);
  assert.equal(zero.compensationAssessment.reason, "assessed");
});

test("every missing compensation-input combination stays deterministically unknown", () => {
  const cases = [
    { target: null, min: null, max: null, reason: "missing_both" },
    { target: null, min: 120_000, max: null, reason: "missing_applicant_salary_target" },
    { target: null, min: null, max: 150_000, reason: "missing_applicant_salary_target" },
    { target: null, min: 120_000, max: 150_000, reason: "missing_applicant_salary_target" },
    { target: 125_000, min: null, max: null, reason: "missing_job_salary" }
  ] as const;

  for (const item of cases) {
    const input = structuredClone(baseInput);
    input.profile!.salaryTargetMin = item.target;
    input.profile!.salaryTargetMax = null;
    input.job.salaryMin = item.min;
    input.job.salaryMax = item.max;
    const output = cloneOutput();
    output.compensationScore = 0;

    const normalized = normalizeJobMatchOutput(input, output);
    assert.equal(normalized.compensationScore, null, JSON.stringify(item));
    assert.equal(normalized.compensationAssessment.reason, item.reason, JSON.stringify(item));
  }

  const noApplicant = normalizeJobMatchOutput({ ...baseInput, profile: null }, cloneOutput());
  assert.equal(noApplicant.compensationScore, null);
  assert.equal(noApplicant.compensationAssessment.reason, "missing_applicant_salary_target");
});

test("a max-only applicant salary target is present compensation evidence", () => {
  const input = structuredClone(baseInput);
  input.profile!.salaryTargetMin = null;
  input.profile!.salaryTargetMax = 145_000;
  const output = cloneOutput();
  output.compensationScore = 0;

  const normalized = normalizeJobMatchOutput(input, output);
  assert.equal(normalized.compensationScore, 0);
  assert.equal(normalized.compensationAssessment.reason, "assessed");
});

test("one job salary bound is sufficient and explicit zero inputs remain present", () => {
  for (const [salaryMin, salaryMax] of [[120_000, null], [null, 150_000], [0, 0]] as const) {
    const input = structuredClone(baseInput);
    input.job.salaryMin = salaryMin;
    input.job.salaryMax = salaryMax;
    if (salaryMin === 0) input.profile!.salaryTargetMin = 0;
    const output = cloneOutput();
    output.compensationScore = 0;

    const normalized = normalizeJobMatchOutput(input, output);
    assert.equal(normalized.compensationScore, 0);
    assert.equal(normalized.compensationAssessment.reason, "assessed");
  }
});

test("validated factual findings project separately from writing advice", () => {
  const normalized = normalizeJobMatchOutput(baseInput, baseModelOutput);

  assert.deepEqual(normalized.whyGoodMatch, ["Submitted applicant evidence matches job evidence for TypeScript."]);
  assert.deepEqual(normalized.concerns, ["Kubernetes"]);
  assert.deepEqual(normalized.supportedKeywords, ["TypeScript"]);
  assert.deepEqual(normalized.missingKeywords, ["Kubernetes"]);
  assert.equal(normalized.suggestedResumeAngle, baseModelOutput.advice.resumeAngle);
  assert.equal(normalized.suggestedCoverLetterAngle, baseModelOutput.advice.coverLetterAngle);
  assert.ok(!normalized.whyGoodMatch.includes(baseModelOutput.advice.resumeAngle));
});

test("posting projection clears a prior legacy key reason when v3 has no factual match", () => {
  const noMatches = cloneOutput();
  noMatches.factualMatches = [];
  const normalized = normalizeJobMatchOutput(baseInput, noMatches);

  const projection = buildJobMatchPostingUpdate(normalized);
  assert.equal(projection.keyMatchReason, null);
  assert.deepEqual(projection.supportedKeywords, []);
  assert.equal(projection.suggestedResumeAngle, noMatches.advice.resumeAngle);
});

test("unknown evidence references are rejected locally", () => {
  const unknownApplicant = cloneOutput();
  unknownApplicant.factualMatches[0].applicantEvidence[0].ref = "resume.skills[99]";
  assert.throws(() => normalizeJobMatchOutput(baseInput, unknownApplicant), /unknown applicant evidence reference/i);

  const unknownJob = cloneOutput();
  unknownJob.factualMatches[0].jobEvidence[0].ref = "job.requirements[99]";
  assert.throws(() => normalizeJobMatchOutput(baseInput, unknownJob), /unknown job evidence reference/i);
});

test("skills marked not to exaggerate cannot support a positive factual match", () => {
  const negativeControl = cloneOutput();
  negativeControl.factualMatches[0] = {
    applicantEvidence: [{ ref: "profile.skillsNotToExaggerate[0]", excerpt: "Kubernetes" }],
    jobEvidence: [{ ref: "job.preferredQualifications[0]", excerpt: "Kubernetes" }],
    supportedKeywords: ["Kubernetes"]
  };

  assert.throws(() => normalizeJobMatchOutput(baseInput, negativeControl), /unknown applicant evidence reference/i);
});

test("unsupported evidence excerpts and keywords are rejected locally", () => {
  const unsupportedExcerpt = cloneOutput();
  unsupportedExcerpt.factualMatches[0].applicantEvidence[0].excerpt = "Rust";
  assert.throws(() => normalizeJobMatchOutput(baseInput, unsupportedExcerpt), /unsupported applicant evidence excerpt/i);

  const unsupportedKeyword = cloneOutput();
  unsupportedKeyword.factualMatches[0].supportedKeywords = ["Rust"];
  assert.throws(() => normalizeJobMatchOutput(baseInput, unsupportedKeyword), /unsupported matched keyword/i);

  const partialKeyword = cloneOutput();
  partialKeyword.factualMatches[0].supportedKeywords = ["Script"];
  assert.throws(() => normalizeJobMatchOutput(baseInput, partialKeyword), /unsupported matched keyword/i);
});

test("free-text factual claims are rejected instead of projecting unsupported assertions", () => {
  const unsupportedClaim = cloneOutput() as JobMatchModelOutput & {
    factualMatches: Array<JobMatchModelOutput["factualMatches"][number] & { claim: string }>;
  };
  unsupportedClaim.factualMatches[0].claim = "Ten years of AWS architecture experience.";

  assert.throws(() => normalizeJobMatchOutput(baseInput, unsupportedClaim), /free-text factual claim/i);
});

test("gaps must cite exact structured job requirements", () => {
  const descriptionOnly = cloneOutput();
  descriptionOnly.requirementGaps[0].jobRequirement = {
    ref: "job.description",
    excerpt: "TypeScript"
  };
  assert.throws(() => normalizeJobMatchOutput(baseInput, descriptionOnly), /structured job requirement/i);

  const paraphrased = cloneOutput();
  paraphrased.requirementGaps[0].requirement = "Production Kubernetes experience";
  assert.throws(() => normalizeJobMatchOutput(baseInput, paraphrased), /exact cited job requirement/i);

  const fragment = cloneOutput();
  const detailedInput = structuredClone(baseInput);
  detailedInput.job.preferredQualifications = ["3+ years of production Kubernetes experience"];
  fragment.requirementGaps[0] = {
    requirement: "Kubernetes",
    jobRequirement: { ref: "job.preferredQualifications[0]", excerpt: "Kubernetes" },
    missingKeywords: ["Kubernetes"]
  };
  assert.throws(() => normalizeJobMatchOutput(detailedInput, fragment), /full structured job requirement/i);

  const partialKeyword = cloneOutput();
  partialKeyword.requirementGaps[0].missingKeywords = ["C"];
  assert.throws(() => normalizeJobMatchOutput(baseInput, partialKeyword), /unsupported missing keyword/i);
});

test("a gap cannot label a keyword missing when submitted applicant evidence contains it", () => {
  const falseGap = cloneOutput();
  falseGap.requirementGaps[0] = {
    requirement: "TypeScript",
    jobRequirement: { ref: "job.requirements[0]", excerpt: "TypeScript" },
    missingKeywords: ["TypeScript"]
  };

  assert.throws(() => normalizeJobMatchOutput(baseInput, falseGap), /present in submitted applicant evidence/i);
});
