import assert from "node:assert/strict";
import { test } from "node:test";

import {
  JobMatchOutputValidationError,
  validateAndNormalizeJobMatchOutput,
  type JobMatchModelOutput,
  type JobMatchSemanticValidationCode,
  type MatchInput
} from "@/lib/ai/job-match";

// A reviewed fact is owner-reviewed and its ref names it exactly. Production case 2026-11-10:
// Gemini quoted part of a long owner line, the output was refused with
// REVIEWED_EVIDENCE_EXCERPT_NOT_FULL, and the re-score had already been charged. A genuine part of
// the cited fact now becomes the whole fact locally; a quote that is not in the fact still fails,
// and the negation check reads the whole fact. All text here is invented.

function inputWith(fact: string): MatchInput {
  return {
    job: {
      title: "Synthetic platform engineer",
      company: "Example Co",
      location: "Remote",
      remoteStatus: "Remote",
      salaryMin: null,
      salaryMax: null,
      description: "Run synthetic services on Kubernetes.",
      requirements: ["Kubernetes experience"],
      preferredQualifications: [],
      detectedTechStack: []
    },
    resume: { summary: "Synthetic operator", rawText: "Wrote synthetic runbooks.", skills: ["Runbooks"], achievements: [] },
    profile: null,
    reviewedEvidence: {
      schema: "apply-pilot/job-match-reviewed-evidence/v1",
      snapshotId: "snapshot-1",
      snapshotHash: "a".repeat(64),
      facts: [{ gapId: "gap:0", fact, provenance: "OWNER_ATTESTED", sourceRef: null }],
      unresolvedGapIds: []
    }
  };
}

function outputQuoting(excerpt: string, keyword = "Kubernetes"): JobMatchModelOutput {
  return {
    contractVersion: "3",
    overallFitScore: 70,
    resumeKeywordScore: 70,
    skillsMatchScore: 70,
    experienceMatchScore: 70,
    careerGoalScore: 70,
    locationWorkStyleScore: 70,
    compensationScore: null,
    confidenceScore: 60,
    confidenceBasis: "Based on the cited fields.",
    factualMatches: [{
      applicantEvidence: [{ ref: "reviewedEvidence.facts[0]", excerpt }],
      jobEvidence: [{ ref: "job.requirements[0]", excerpt: "Kubernetes experience" }],
      supportedKeywords: [keyword]
    }],
    requirementGaps: [],
    advice: { keywordsToEmphasize: [], resumeAngle: "Lead with the platform work.", coverLetterAngle: "Name the migration." },
    recommendation: "consider"
  };
}

function failsWith(code: JobMatchSemanticValidationCode) {
  return (error: unknown) => error instanceof JobMatchOutputValidationError && error.validationCode === code;
}

const MIGRATION =
  "Ran the synthetic billing migration to Kubernetes for 40 services. Cut deploy time from two hours to ten minutes.";

test("a JOB_MATCH output quoting part of a reviewed fact validates, and the stored excerpt is the full fact", () => {
  const input = inputWith(MIGRATION);
  const { modelOutput, normalized } = validateAndNormalizeJobMatchOutput(input, outputQuoting("migration to Kubernetes"));
  assert.equal(normalized.factualMatches[0]!.applicantEvidence[0]!.excerpt, MIGRATION);
  assert.equal(normalized.factualMatches[0]!.applicantEvidence[0]!.provenance, "OWNER_ATTESTED");
  // The cached model output carries the full fact too, so a cache hit validates the same way.
  assert.equal(modelOutput.factualMatches[0]!.applicantEvidence[0]!.excerpt, MIGRATION);
  const again = validateAndNormalizeJobMatchOutput(input, modelOutput).normalized;
  assert.equal(again.factualMatches[0]!.applicantEvidence[0]!.excerpt, MIGRATION);
});

test("a retyped partial quote (hyphen for en dash, other case) is still part of the fact", () => {
  const fact = "Ran 24–7 Kubernetes on-call for synthetic services. Wrote the paging runbook.";
  const { normalized } = validateAndNormalizeJobMatchOutput(inputWith(fact), outputQuoting("ran 24-7 kubernetes on-call"));
  assert.equal(normalized.factualMatches[0]!.applicantEvidence[0]!.excerpt, fact);
});

test("an excerpt that isn't part of the reviewed fact still fails", () => {
  assert.throws(
    () => validateAndNormalizeJobMatchOutput(inputWith(MIGRATION), outputQuoting("migration to Kubernetes for 400 services")),
    failsWith("UNSUPPORTED_APPLICANT_EXCERPT")
  );
});

const NEGATED = "Ran the synthetic billing migration. Did not use Kubernetes for it.";

test("a partial quote from a negated sentence of a reviewed fact still fails as a negation reversal", () => {
  assert.throws(
    () => validateAndNormalizeJobMatchOutput(inputWith(NEGATED), outputQuoting("use Kubernetes for it")),
    failsWith("APPLICANT_EVIDENCE_NEGATION_REVERSAL")
  );
});

test("the negation check reads every sentence of a full multi-sentence reviewed fact", () => {
  assert.throws(
    () => validateAndNormalizeJobMatchOutput(inputWith(NEGATED), outputQuoting(NEGATED)),
    failsWith("APPLICANT_EVIDENCE_NEGATION_REVERSAL")
  );
  assert.throws(
    () => validateAndNormalizeJobMatchOutput(inputWith("Used Python daily but not Kubernetes."), outputQuoting("Used Python daily but not Kubernetes.")),
    failsWith("APPLICANT_EVIDENCE_NEGATION_REVERSAL")
  );
});

test("a reviewed fact with one positive sentence about the keyword still supports it", () => {
  const fact = "Used Kubernetes daily on the synthetic platform. Did not use Kubernetes Operators.";
  const { normalized } = validateAndNormalizeJobMatchOutput(inputWith(fact), outputQuoting("Kubernetes daily"));
  assert.equal(normalized.factualMatches[0]!.applicantEvidence[0]!.excerpt, fact);
});
