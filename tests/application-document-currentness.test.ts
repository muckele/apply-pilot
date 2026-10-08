import assert from "node:assert/strict";
import { test } from "node:test";

import { PublicApiError } from "@/lib/api-errors";
import {
  assertApplicationDocumentEvidenceCurrent,
  isEvidenceBindingCurrent,
  resolveEffectiveApplicationDocumentIds
} from "@/lib/applications/document-currentness";
import { resolveCurrentReviewedEvidence } from "@/lib/jobs/evidence-snapshot-contracts";

test("status-only application updates retain and validate both effective document selections", () => {
  assert.deepEqual(resolveEffectiveApplicationDocumentIds({}, {
    resumeVersionId: "resume-existing",
    coverLetterVersionId: "cover-existing"
  }), {
    resumeVersionId: "resume-existing",
    coverLetterVersionId: "cover-existing"
  });

  assert.throws(() => assertApplicationDocumentEvidenceCurrent({
    currentEvidenceSnapshotId: "snapshot-current",
    currentEvidenceSourceValid: true,
    resumeVersion: { evidenceSnapshotId: "snapshot-old" },
    coverLetterVersion: { evidenceSnapshotId: "snapshot-current" }
  }), (error: unknown) => error instanceof PublicApiError &&
    error.status === 409 && error.details?.code === "APPLICATION_DOCUMENT_EVIDENCE_STALE");
});

test("an explicit null cover selection clears it while omitted resume remains selected", () => {
  assert.deepEqual(resolveEffectiveApplicationDocumentIds({ coverLetterVersionId: null }, {
    resumeVersionId: "resume-existing",
    coverLetterVersionId: "cover-existing"
  }), {
    resumeVersionId: "resume-existing",
    coverLetterVersionId: null
  });
});

test("deleted snapshot bindings never collapse into legacy null-binding currentness", () => {
  assert.equal(isEvidenceBindingCurrent({
    currentEvidenceSnapshotId: null,
    currentEvidenceSourceValid: false,
    artifactEvidenceSnapshotId: null
  }), false);
  assert.equal(isEvidenceBindingCurrent({
    currentEvidenceSnapshotId: null,
    currentEvidenceSourceValid: true,
    artifactEvidenceSnapshotId: null
  }), false);
});

test("a stale source resume invalidates an otherwise exact snapshot binding", () => {
  assert.equal(isEvidenceBindingCurrent({
    currentEvidenceSnapshotId: "snapshot-current",
    currentEvidenceSourceValid: false,
    artifactEvidenceSnapshotId: "snapshot-current"
  }), false);
});

test("reviewed evidence resolves only against the exact current master resume version", () => {
  const snapshot = {
    id: "snapshot-current",
    resumeId: "resume-master",
    sourceResumeUpdatedAt: new Date("2026-10-08T10:00:00.000Z"),
    snapshotHash: "a".repeat(64),
    reviewPayload: {
      schema: "apply-pilot/evidence-snapshot-payload/v1",
      decisions: []
    }
  };
  const current = resolveCurrentReviewedEvidence({
    currentEvidenceSnapshotId: snapshot.id,
    evidenceSnapshotGeneration: 1,
    currentEvidenceSnapshot: snapshot
  }, {
    id: "resume-master",
    updatedAt: new Date("2026-10-08T10:00:00.000Z")
  });
  assert.equal(current.currentEvidenceSourceValid, true);
  assert.equal(current.reviewedEvidence?.snapshotId, snapshot.id);

  const edited = resolveCurrentReviewedEvidence({
    currentEvidenceSnapshotId: snapshot.id,
    evidenceSnapshotGeneration: 1,
    currentEvidenceSnapshot: snapshot
  }, {
    id: "resume-master",
    updatedAt: new Date("2026-10-08T10:00:01.000Z")
  });
  assert.equal(edited.currentEvidenceSourceValid, false);
  assert.equal(edited.reviewedEvidence, null);
  assert.equal(edited.effectiveEvidenceSnapshotId, null);
});
