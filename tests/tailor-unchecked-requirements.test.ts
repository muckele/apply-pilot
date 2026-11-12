import assert from "node:assert/strict";
import test from "node:test";

import {
  buildEvidenceCorrectionReview,
  createReviewedEvidenceSnapshot,
  normalizeEvidenceCorrectionDecisions,
  type EvidenceCorrectionDecision
} from "@/lib/jobs/evidence-correction-review";

// One JOB_MATCH run judges only some of a job's requirements. The Tailor step lists the rest as
// "not checked yet" so the owner can answer every requirement once, before anything is written.

const JOB_ONLY = { reuseScope: "JOB_ONLY" as const, masterProfileOptIn: false as const };

const resume = {
  rawText: ["SUMMARY", "Service operations leader with twelve years of experience.", "SKILLS", "Incident governance"].join("\n"),
  summary: "Service operations leader with twelve years of experience.",
  skills: ["Operations: Incident governance"],
  achievements: [],
  workHistory: [],
  projects: [],
  education: [],
  certifications: []
};

// Stored as an older manual import split them: two headings and a pay line sit among the
// requirements and keep their indexes.
const requirements = [
  "Current Quenby certification",
  "What You'll Do",
  "Experience with incident governance",
  "Write clear technical documentation",
  "US base pay range (CA, WA, NY) per year: $68,000",
  "Working knowledge of SQL",
  "What We Look For",
  "Bachelor's degree or equivalent experience"
];

const analysisOutput = {
  contractVersion: "3",
  promptVersion: "3.4",
  factualMatches: [{
    claim: "Submitted applicant evidence matches job evidence for incident governance.",
    applicantEvidence: [{ ref: "resume.skills[0]", excerpt: "Incident governance" }],
    jobEvidence: [{ ref: "job.requirements[2]", excerpt: "Experience with incident governance" }]
  }],
  requirementGaps: [
    { requirement: "Current Quenby certification", jobRequirement: { ref: "job.requirements[0]", excerpt: "Current Quenby certification" }, missingKeywords: ["Quenby"] },
    { requirement: "Working knowledge of SQL", jobRequirement: { ref: "job.requirements[5]", excerpt: "Working knowledge of SQL" }, missingKeywords: ["SQL"] }
  ]
};

function review(overrides: Partial<Parameters<typeof buildEvidenceCorrectionReview>[0]> = {}) {
  return buildEvidenceCorrectionReview({
    jobId: "job-1",
    resumeId: "resume-1",
    resumeUpdatedAt: "2026-11-01T10:00:00.000Z",
    resume,
    analysisId: "analysis-1",
    analysisOutput,
    job: { requirements, description: null },
    ...overrides
  });
}

const unresolved = (gapId: string): EvidenceCorrectionDecision => ({ gapId, kind: "UNRESOLVED", ...JOB_ONLY });
const attest = (gapId: string, attestedFact: string): EvidenceCorrectionDecision =>
  ({ gapId, kind: "OWNER_ATTESTATION", attestedFact, ownerAttested: true, ...JOB_ONLY });

test("requirements the analysis neither matched nor flagged are listed as unchecked, by their job index", () => {
  assert.deepEqual(review().uncheckedRequirements, [
    { id: "requirement:3", requirement: "Write clear technical documentation", jobRef: "job.requirements[3]", missingKeywords: [] },
    { id: "requirement:7", requirement: "Bachelor's degree or equivalent experience", jobRef: "job.requirements[7]", missingKeywords: [] }
  ]);
  assert.deepEqual(review().gaps.map((gap) => gap.id), ["gap:0", "gap:1"]);
});

test("there is nothing unchecked to answer without a current analysis or the job's requirements", () => {
  assert.deepEqual(review({ analysisId: null, analysisOutput: null }).uncheckedRequirements, []);
  assert.deepEqual(review({ analysisOutput: { ...analysisOutput, promptVersion: "3.3" } }).uncheckedRequirements, []);
  assert.deepEqual(review({ job: undefined }).uncheckedRequirements, []);
});

test("answers to unchecked requirements follow the gap decisions and become resolved owner facts", () => {
  const decisions = normalizeEvidenceCorrectionDecisions(review(), [
    unresolved("gap:0"),
    unresolved("gap:1"),
    attest("requirement:7", "Bachelor of Science in Operations Management, 2014.")
  ]);
  assert.deepEqual(decisions.map((decision) => [decision.gapId, decision.status, decision.fact]), [
    ["gap:0", "UNRESOLVED", null],
    ["gap:1", "UNRESOLVED", null],
    ["requirement:7", "RESOLVED", "Bachelor of Science in Operations Management, 2014."]
  ]);
});

test("a save that answers no unchecked requirement is unchanged", () => {
  const decisions = normalizeEvidenceCorrectionDecisions(review(), [unresolved("gap:0"), unresolved("gap:1")]);
  assert.deepEqual(decisions.map((decision) => decision.gapId), ["gap:0", "gap:1"]);
});

test("an unchecked requirement can only be answered, never recorded as skipped", () => {
  assert.throws(
    () => normalizeEvidenceCorrectionDecisions(review(), [unresolved("gap:0"), unresolved("gap:1"), unresolved("requirement:3")]),
    /Skip/u
  );
});

test("answers must name a listed unchecked requirement, once, in listed order, after every gap", () => {
  const fact = "Wrote the runbook library for a 40-person support team.";
  const invalid: EvidenceCorrectionDecision[][] = [
    // A requirement the analysis already matched.
    [unresolved("gap:0"), unresolved("gap:1"), attest("requirement:2", fact)],
    // A heading stored as a requirement.
    [unresolved("gap:0"), unresolved("gap:1"), attest("requirement:1", fact)],
    // Out of listed order.
    [unresolved("gap:0"), unresolved("gap:1"), attest("requirement:7", fact), attest("requirement:3", fact)],
    // Twice.
    [unresolved("gap:0"), unresolved("gap:1"), attest("requirement:3", fact), attest("requirement:3", fact)],
    // Before the gap decisions.
    [attest("requirement:3", fact), unresolved("gap:0"), unresolved("gap:1")],
    // Missing a gap decision.
    [unresolved("gap:0"), attest("requirement:3", fact)]
  ];
  for (const decisions of invalid) {
    assert.throws(() => normalizeEvidenceCorrectionDecisions(review(), decisions), Error, JSON.stringify(decisions.map((item) => item.gapId)));
  }
});

test("a review built without the job's requirements still rejects answers to them", () => {
  assert.throws(
    () => normalizeEvidenceCorrectionDecisions(review({ job: undefined }), [
      unresolved("gap:0"), unresolved("gap:1"), attest("requirement:3", "Wrote the runbook library.")
    ]),
    /Unknown disputed gap/u
  );
});

test("the reviewed snapshot keeps the gap list and records the unchecked answer", async () => {
  const snapshot = await createReviewedEvidenceSnapshot(review(), [
    unresolved("gap:0"),
    unresolved("gap:1"),
    attest("requirement:3", "Wrote the runbook library for a 40-person support team.")
  ], { reviewedAt: "2026-11-09T12:00:00.000Z" });
  assert.deepEqual(snapshot.gaps.map((gap) => gap.id), ["gap:0", "gap:1"]);
  assert.deepEqual(snapshot.decisions.at(-1), {
    gapId: "requirement:3",
    status: "RESOLVED",
    fact: "Wrote the runbook library for a 40-person support team.",
    provenance: { kind: "OWNER_ATTESTED", ownerAttested: true },
    ...JOB_ONLY
  });
});

test("a requirement already answered with a line is not asked again when a rescore still doesn't check it", () => {
  const answered = review({
    acceptedFacts: [{
      factId: "fact:answered",
      originGapId: "requirement:7",
      fact: "Bachelor of Science in Operations Management, 2014.",
      provenance: { kind: "OWNER_ATTESTED", ownerAttested: true },
      ...JOB_ONLY
    }]
  });
  assert.deepEqual(answered.uncheckedRequirements.map((requirement) => requirement.id), ["requirement:3"]);
  assert.throws(() => normalizeEvidenceCorrectionDecisions(answered, [
    unresolved("gap:0"), unresolved("gap:1"), attest("requirement:7", "Bachelor of Science, 2014.")
  ]), /Unknown disputed gap/u);
});
