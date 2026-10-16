import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildCurrentJobMatchInput,
  currentJobMatchInputHash,
  CURRENT_JOB_MATCH_ANALYSIS_WHERE,
  currentJobMatchFields,
  hasCurrentJobMatchAnalysis
} from "@/lib/jobs/current-job-match";

test("current JOB_MATCH relation is pinned to the lightweight model and prompt identity", () => {
  assert.deepEqual(CURRENT_JOB_MATCH_ANALYSIS_WHERE, {
    type: "JOB_MATCH",
    model: "gemini-3.8-flash",
    promptVersion: "3.4"
  });
  const input = buildCurrentJobMatchInput({
    job: { title: "Operator", company: "Example", description: "Current description" },
    resume: null,
    profile: null
  });
  const inputHash = currentJobMatchInputHash(input);
  assert.equal(hasCurrentJobMatchAnalysis({ aiAnalyses: [{ inputHash }] }, input), false);
  assert.equal(hasCurrentJobMatchAnalysis({ aiAnalyses: [{ inputHash: "stale" }] }, input), false);
  assert.equal(hasCurrentJobMatchAnalysis({ aiAnalyses: [] }, input), false);
});

test("currentness requires the exact reviewed-evidence binding as well as the input hash", () => {
  const job = { title: "Operator", company: "Example", description: "Current description" };
  const input = buildCurrentJobMatchInput({
    job,
    resume: null,
    profile: null,
    reviewedEvidence: {
      schema: "apply-pilot/job-match-reviewed-evidence/v1",
      snapshotId: "snapshot-current",
      snapshotHash: "a".repeat(64),
      facts: [{
        gapId: "gap:0",
        fact: "Synthetic reviewed evidence.",
        provenance: "OWNER_ATTESTED",
        sourceRef: null
      }],
      unresolvedGapIds: []
    }
  });
  const inputHash = currentJobMatchInputHash(input);

  assert.equal(hasCurrentJobMatchAnalysis({
    currentEvidenceSnapshotId: "snapshot-current",
    aiAnalyses: [{ inputHash, evidenceSnapshotId: "snapshot-current" }]
  }, input), true);
  assert.equal(hasCurrentJobMatchAnalysis({
    currentEvidenceSnapshotId: "snapshot-current",
    aiAnalyses: [{ inputHash, evidenceSnapshotId: null }]
  }, input), false);
  assert.equal(hasCurrentJobMatchAnalysis({
    currentEvidenceSnapshotId: "snapshot-newer",
    aiAnalyses: [{ inputHash, evidenceSnapshotId: "snapshot-current" }]
  }, input), false);
});

test("no-snapshot input is explicit and cannot share a hash with reviewed evidence", () => {
  const job = { title: "Operator", company: "Example", description: "Current description" };
  const plain = buildCurrentJobMatchInput({
    job,
    resume: null,
    profile: null,
    reviewedEvidence: null
  });
  const corrected = buildCurrentJobMatchInput({
    job,
    resume: null,
    profile: null,
    reviewedEvidence: {
      schema: "apply-pilot/job-match-reviewed-evidence/v1",
      snapshotId: "snapshot-current",
      snapshotHash: "b".repeat(64),
      facts: [],
      unresolvedGapIds: ["gap:0"]
    }
  });
  assert.equal(plain.reviewedEvidence, null);
  assert.notEqual(currentJobMatchInputHash(plain), currentJobMatchInputHash(corrected));
});

test("the monotonic generation prevents a deleted snapshot from reviving a bootstrap analysis", () => {
  const job = { title: "Operator", company: "Example", description: "Current description" };
  const bootstrap = buildCurrentJobMatchInput({
    job,
    resume: null,
    profile: null,
    reviewedEvidence: null,
    evidenceSnapshotGeneration: 0
  });
  const afterDeletion = buildCurrentJobMatchInput({
    job,
    resume: null,
    profile: null,
    reviewedEvidence: null,
    evidenceSnapshotGeneration: 1
  });
  assert.notEqual(currentJobMatchInputHash(bootstrap), currentJobMatchInputHash(afterDeletion));
  assert.equal(hasCurrentJobMatchAnalysis({
    currentEvidenceSnapshotId: null,
    aiAnalyses: [{ inputHash: currentJobMatchInputHash(bootstrap), evidenceSnapshotId: null }]
  }, afterDeletion), false);
});

test("stale denormalized score, recommendation, gap, and document advice fields are isolated together", () => {
  const stale = currentJobMatchFields({
    overallFitScore: 92,
    confidenceScore: 90,
    matchRecommendation: "apply now",
    keyMatchReason: "STALE MATCH",
    missingKeywords: ["STALE MISSING"],
    supportedKeywords: ["STALE SUPPORTED"],
    concerns: ["STALE CONCERN"],
    suggestedResumeAngle: "STALE RESUME ANGLE",
    suggestedCoverLetterAngle: "STALE COVER ANGLE"
  }, false);

  assert.deepEqual(stale, {
    overallFitScore: null,
    confidenceScore: null,
    matchRecommendation: null,
    keyMatchReason: null,
    missingKeywords: [],
    supportedKeywords: [],
    concerns: [],
    suggestedResumeAngle: null,
    suggestedCoverLetterAngle: null
  });
});

test("every product score consumer joins the current prompt version before presentation", () => {
  for (const path of [
    "app/(product)/jobs/page.tsx",
    "app/(product)/jobs/review/page.tsx",
    "app/(product)/dashboard/page.tsx",
    "app/(product)/applications/page.tsx",
    "app/(product)/applications/[id]/page.tsx"
  ]) {
    const source = readFileSync(path, "utf8");
    assert.match(source, /CURRENT_JOB_MATCH_ANALYSIS|currentJobMatchFields|hasCurrentJobMatchAnalysis/, path);
  }
});

test("job detail mounts the preview-only evidence correction surface from the current master resume", () => {
  const source = readFileSync("app/(product)/jobs/[id]/page.tsx", "utf8");
  assert.match(source, /EvidenceCorrectionReview/);
  assert.match(source, /buildEvidenceCorrectionReview/);
  assert.match(source, /isMaster: true/);
});
