import assert from "node:assert/strict";
import test from "node:test";

import { JOB_MATCH_PROMPT_VERSION } from "@/lib/ai/job-match-version";
import { buildCurrentJobMatchInput, currentJobMatchInputHash } from "@/lib/jobs/current-job-match";
import { resolveFitEstimate } from "@/lib/jobs/fit-estimate";

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

function baseJob(overrides: Record<string, unknown> = {}) {
  return {
    title: "Service Operations Director",
    company: "Northwind",
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
    currentEvidenceSnapshot: null as null | {
      id: string; resumeId: string; sourceResumeUpdatedAt: Date; snapshotHash: string; reviewPayload: unknown;
    },
    ...overrides
  };
}

function output(score: number) {
  return { contractVersion: "3", promptVersion: JOB_MATCH_PROMPT_VERSION, overallFitScore: score, factualMatches: [], requirementGaps: [] };
}

function plainHash(job: ReturnType<typeof baseJob>, generation: number) {
  return currentJobMatchInputHash(buildCurrentJobMatchInput({
    job, resume, profile: null, reviewedEvidence: null, evidenceSnapshotGeneration: generation
  }));
}

function snapshot(facts: unknown[]) {
  return {
    id: "snapshot-1",
    resumeId: resume.id,
    sourceResumeUpdatedAt: resumeUpdatedAt,
    snapshotHash: "a".repeat(64),
    reviewPayload: { schema: "apply-pilot/evidence-snapshot-payload/v2", facts, unresolvedGapIds: ["gap:0"] }
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

test("no analysis means no estimate", () => {
  assert.equal(resolveFitEstimate({ job: baseJob(), resume, profile: null, latestAnalysis: null, currentSnapshotReviewedAnalysisId: null }), null);
});

test("an unreviewed job shows the master-résumé estimate when its input is unchanged", () => {
  const job = baseJob();
  const estimate = resolveFitEstimate({
    job, resume, profile: null, currentSnapshotReviewedAnalysisId: null,
    latestAnalysis: { id: "analysis-1", inputHash: plainHash(job, 0), evidenceSnapshotId: null, output: output(68), createdAt: new Date() }
  });
  assert.deepEqual(estimate && { score: estimate.score, basis: estimate.basis, isCurrent: estimate.isCurrent, reviewable: estimate.reviewable },
    { score: 68, basis: "MASTER_RESUME", isCurrent: false, reviewable: true });
});

test("an estimate disappears when the job, résumé or profile changed after scoring", () => {
  const job = baseJob();
  const estimate = resolveFitEstimate({
    job: { ...job, description: "Changed posting." }, resume, profile: null, currentSnapshotReviewedAnalysisId: null,
    latestAnalysis: { id: "analysis-1", inputHash: plainHash(job, 0), evidenceSnapshotId: null, output: output(68), createdAt: new Date() }
  });
  assert.equal(estimate, null);
});

test("an analysis bound to the current reviewed evidence is the current estimate", () => {
  const job = baseJob({ currentEvidenceSnapshotId: "snapshot-1", evidenceSnapshotGeneration: 1, currentEvidenceSnapshot: snapshot([attestedFact]) });
  const hash = currentJobMatchInputHash(buildCurrentJobMatchInput({
    job, resume, profile: null,
    reviewedEvidence: {
      schema: "apply-pilot/job-match-reviewed-evidence/v1", snapshotId: "snapshot-1", snapshotHash: "a".repeat(64),
      facts: [{ gapId: "gap:0", fact: attestedFact.fact, provenance: "OWNER_ATTESTED", sourceRef: null }], unresolvedGapIds: ["gap:0"]
    },
    evidenceSnapshotGeneration: 1
  }));
  const estimate = resolveFitEstimate({
    job, resume, profile: null, currentSnapshotReviewedAnalysisId: "analysis-1",
    latestAnalysis: { id: "analysis-2", inputHash: hash, evidenceSnapshotId: "snapshot-1", output: output(74), createdAt: new Date() }
  });
  assert.deepEqual(estimate && { score: estimate.score, basis: estimate.basis, isCurrent: estimate.isCurrent, reviewable: estimate.reviewable },
    { score: 74, basis: "REVIEWED_EVIDENCE", isCurrent: true, reviewable: true });
});

test("a review that added no facts keeps the estimate it reviewed: current, labelled and not reviewable", () => {
  const before = baseJob();
  const job = baseJob({ currentEvidenceSnapshotId: "snapshot-1", evidenceSnapshotGeneration: 1, currentEvidenceSnapshot: snapshot([]) });
  const estimate = resolveFitEstimate({
    job, resume, profile: null, currentSnapshotReviewedAnalysisId: "analysis-1",
    latestAnalysis: { id: "analysis-1", inputHash: plainHash(before, 0), evidenceSnapshotId: null, output: output(68), createdAt: new Date() }
  });
  assert.deepEqual(estimate && { score: estimate.score, basis: estimate.basis, isCurrent: estimate.isCurrent, reviewable: estimate.reviewable },
    { score: 68, basis: "MASTER_RESUME_NO_NEW_FACTS", isCurrent: true, reviewable: false });
});

test("a review that added facts never carries the older estimate forward", () => {
  const before = baseJob();
  const job = baseJob({ currentEvidenceSnapshotId: "snapshot-1", evidenceSnapshotGeneration: 1, currentEvidenceSnapshot: snapshot([attestedFact]) });
  assert.equal(resolveFitEstimate({
    job, resume, profile: null, currentSnapshotReviewedAnalysisId: "analysis-1",
    latestAnalysis: { id: "analysis-1", inputHash: plainHash(before, 0), evidenceSnapshotId: null, output: output(68), createdAt: new Date() }
  }), null);
});

test("an empty review carries forward only the exact analysis it reviewed, on unchanged inputs", () => {
  const before = baseJob();
  const job = baseJob({ currentEvidenceSnapshotId: "snapshot-1", evidenceSnapshotGeneration: 1, currentEvidenceSnapshot: snapshot([]) });
  const latestAnalysis = { id: "analysis-1", inputHash: plainHash(before, 0), evidenceSnapshotId: null, output: output(68), createdAt: new Date() };
  assert.equal(resolveFitEstimate({ job, resume, profile: null, currentSnapshotReviewedAnalysisId: "analysis-other", latestAnalysis }), null);
  assert.equal(resolveFitEstimate({ job: { ...job, title: "Changed title" }, resume, profile: null, currentSnapshotReviewedAnalysisId: "analysis-1", latestAnalysis }), null);
  assert.equal(resolveFitEstimate({
    job, resume: { ...resume, updatedAt: new Date("2026-11-02T00:00:00.000Z") }, profile: null,
    currentSnapshotReviewedAnalysisId: "analysis-1", latestAnalysis
  }), null);
});

test("legacy or invalid outputs are never shown as an estimate", () => {
  const job = baseJob();
  const latestAnalysis = { id: "analysis-1", inputHash: plainHash(job, 0), evidenceSnapshotId: null, createdAt: new Date() };
  assert.equal(resolveFitEstimate({ job, resume, profile: null, currentSnapshotReviewedAnalysisId: null,
    latestAnalysis: { ...latestAnalysis, output: { ...output(68), contractVersion: "2" } } }), null);
  assert.equal(resolveFitEstimate({ job, resume, profile: null, currentSnapshotReviewedAnalysisId: null,
    latestAnalysis: { ...latestAnalysis, output: output(140) } }), null);
});
