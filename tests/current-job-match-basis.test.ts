import assert from "node:assert/strict";
import test from "node:test";

import { buildCurrentJobMatchInput, currentJobMatchBasis, currentJobMatchInputHash } from "@/lib/jobs/current-job-match";
import { estimateIsCurrent } from "@/lib/jobs/estimate-basis";

// The one rule for "is this saved JOB_MATCH answer current for the evidence in force?". All data is synthetic.

const resumeUpdatedAt = new Date("2026-11-01T10:00:00.000Z");
const resume = {
  id: "resume-1",
  updatedAt: resumeUpdatedAt,
  summary: "Service operations leader.",
  rawText: "Service operations leader.\nDirected service delivery.",
  skills: ["SQL"],
  achievements: [],
  workHistory: [],
  projects: [],
  education: [],
  certifications: []
};

type Snapshot = {
  id: string; resumeId: string; sourceResumeUpdatedAt: Date; snapshotHash: string; reviewPayload: unknown; reviewedAnalysisId: string | null;
};

function baseJob(overrides: Record<string, unknown> = {}) {
  return {
    title: "Service Operations Director",
    company: "Example Co",
    location: "Remote",
    remoteStatus: "Remote",
    salaryMin: null,
    salaryMax: null,
    description: "Lead service delivery.",
    requirements: ["Service delivery", "Quenby certification"],
    preferredQualifications: [],
    detectedTechStack: [],
    currentEvidenceSnapshotId: null as string | null,
    evidenceSnapshotGeneration: 0,
    currentEvidenceSnapshot: null as Snapshot | null,
    ...overrides
  };
}

const attestedFact = {
  factId: "fact:1",
  originGapId: "gap:0",
  fact: "Holds a current Quenby certification.",
  provenance: { kind: "OWNER_ATTESTED", ownerAttested: true },
  reuseScope: "JOB_ONLY",
  masterProfileOptIn: false
};

function snapshot(facts: unknown[], reviewedAnalysisId: string | null = "analysis-1"): Snapshot {
  return {
    id: "snapshot-1",
    resumeId: resume.id,
    sourceResumeUpdatedAt: resumeUpdatedAt,
    snapshotHash: "a".repeat(64),
    reviewPayload: { schema: "apply-pilot/evidence-snapshot-payload/v2", facts, unresolvedGapIds: ["gap:0"] },
    reviewedAnalysisId
  };
}

function plainHash(job: ReturnType<typeof baseJob>, generation: number) {
  return currentJobMatchInputHash(buildCurrentJobMatchInput({
    job, resume, profile: null, reviewedEvidence: null, evidenceSnapshotGeneration: generation
  }));
}

// A master-résumé score at generation 0, then a "nothing to add" review of exactly that score.
function nothingToAdd(overrides: Record<string, unknown> = {}) {
  const before = baseJob();
  const job = baseJob({ currentEvidenceSnapshotId: "snapshot-1", evidenceSnapshotGeneration: 1, currentEvidenceSnapshot: snapshot([]), ...overrides });
  const analysis = { id: "analysis-1", inputHash: plainHash(before, 0), evidenceSnapshotId: null };
  return { job, analysis };
}

test("an answer bound to the current reviewed snapshot on the input we'd send now is REVIEWED_EVIDENCE", () => {
  const job = baseJob({ currentEvidenceSnapshotId: "snapshot-1", evidenceSnapshotGeneration: 1, currentEvidenceSnapshot: snapshot([attestedFact]) });
  const inputHash = currentJobMatchInputHash(buildCurrentJobMatchInput({
    job, resume, profile: null,
    reviewedEvidence: {
      schema: "apply-pilot/job-match-reviewed-evidence/v1", snapshotId: "snapshot-1", snapshotHash: "a".repeat(64),
      facts: [{ gapId: "gap:0", fact: attestedFact.fact, provenance: "OWNER_ATTESTED", sourceRef: null }], unresolvedGapIds: ["gap:0"]
    },
    evidenceSnapshotGeneration: 1
  }));
  const analysis = { id: "analysis-2", inputHash, evidenceSnapshotId: "snapshot-1" };
  assert.equal(currentJobMatchBasis({ job, resume, profile: null, analysis }), "REVIEWED_EVIDENCE");
});

test("a 'nothing to add' review of exactly this master-résumé answer makes it current, with no second score", () => {
  const { job, analysis } = nothingToAdd();
  assert.equal(currentJobMatchBasis({ job, resume, profile: null, analysis }), "NOTHING_TO_ADD");
});

test("a review that added a line never makes the older answer current", () => {
  const { job, analysis } = nothingToAdd({ currentEvidenceSnapshot: snapshot([attestedFact]) });
  assert.equal(currentJobMatchBasis({ job, resume, profile: null, analysis }), null);
});

test("a review of a different answer never makes this one current", () => {
  const { job, analysis } = nothingToAdd({ currentEvidenceSnapshot: snapshot([], "analysis-other") });
  assert.equal(currentJobMatchBasis({ job, resume, profile: null, analysis }), null);
});

test("a second review since the answer (generation moved twice) is not 'nothing to add'", () => {
  const { job, analysis } = nothingToAdd({ evidenceSnapshotGeneration: 2 });
  assert.equal(currentJobMatchBasis({ job, resume, profile: null, analysis }), null);
});

test("a changed résumé, job or profile since the answer is not current", () => {
  const { job, analysis } = nothingToAdd();
  const changedResume = { ...resume, updatedAt: new Date("2026-11-02T00:00:00.000Z") };
  assert.equal(currentJobMatchBasis({ job, resume: changedResume, profile: null, analysis }), null);
  assert.equal(currentJobMatchBasis({ job: { ...job, description: "Changed posting." }, resume, profile: null, analysis }), null);
  assert.equal(currentJobMatchBasis({
    job, resume, analysis,
    profile: {
      careerGoals: "Lead teams", preferredRoles: [], preferredLocations: [], remotePreference: "REMOTE",
      salaryTargetMin: null, salaryTargetMax: null, skillsToEmphasize: [], skillsNotToExaggerate: []
    }
  }), null);
});

test("an answer already bound to an earlier snapshot is not 'nothing to add'", () => {
  const { job, analysis } = nothingToAdd();
  assert.equal(currentJobMatchBasis({ job, resume, profile: null, analysis: { ...analysis, evidenceSnapshotId: "snapshot-0" } }), null);
});

test("no answer, or a master-résumé answer with no review saved, is not current", () => {
  const job = baseJob();
  assert.equal(currentJobMatchBasis({ job, resume, profile: null, analysis: null }), null);
  assert.equal(currentJobMatchBasis({
    job, resume, profile: null, analysis: { id: "analysis-1", inputHash: plainHash(job, 0), evidenceSnapshotId: null }
  }), null);
});

test("the page treats bound and 'nothing to add' estimates as current, and a bare master-résumé one as not", () => {
  assert.equal(estimateIsCurrent("REVIEWED_EVIDENCE"), true);
  assert.equal(estimateIsCurrent("MASTER_RESUME_NO_NEW_FACTS"), true);
  assert.equal(estimateIsCurrent("MASTER_RESUME"), false);
  assert.equal(estimateIsCurrent(null), false);
});
