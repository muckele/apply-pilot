import assert from "node:assert/strict";
import { test } from "node:test";

import { PublicApiError } from "@/lib/api-errors";
import {
  applicationDocumentsRequiringCurrentEvidence,
  assertApplicationDocumentEvidenceCurrent,
  isEvidenceBindingCurrent,
  resolveEffectiveApplicationDocumentIds
} from "@/lib/applications/document-currentness";
import { resolveCurrentReviewedEvidence } from "@/lib/jobs/evidence-snapshot-contracts";

test("tracker-only updates never re-gate retained historical document selections", () => {
  for (const nextStatus of ["RECRUITER_SCREEN", "REJECTED", "GHOSTED", "ARCHIVED", "SAVED", "INTERESTED"]) {
    assert.deepEqual(applicationDocumentsRequiringCurrentEvidence({
      patch: {},
      existingStatus: "APPLIED",
      nextStatus
    }), { resumeVersion: false, coverLetterVersion: false });
  }
  assert.deepEqual(applicationDocumentsRequiringCurrentEvidence({
    patch: {},
    existingStatus: "APPLIED",
    nextStatus: "APPLIED"
  }), { resumeVersion: false, coverLetterVersion: false });
  assert.deepEqual(applicationDocumentsRequiringCurrentEvidence({
    patch: { coverLetterVersionId: null },
    existingStatus: "SAVED",
    nextStatus: "SAVED"
  }), { resumeVersion: false, coverLetterVersion: false });
});

test("explicit document selections and entry into APPLIED require current evidence", () => {
  assert.deepEqual(applicationDocumentsRequiringCurrentEvidence({
    patch: { resumeVersionId: "resume-new" },
    existingStatus: "SAVED",
    nextStatus: "SAVED"
  }), { resumeVersion: true, coverLetterVersion: false });
  assert.deepEqual(applicationDocumentsRequiringCurrentEvidence({
    patch: { coverLetterVersionId: "cover-new" },
    existingStatus: null,
    nextStatus: "SAVED"
  }), { resumeVersion: false, coverLetterVersion: true });
  assert.deepEqual(applicationDocumentsRequiringCurrentEvidence({
    patch: {},
    existingStatus: "SAVED",
    nextStatus: "APPLIED"
  }), { resumeVersion: true, coverLetterVersion: true });
  assert.deepEqual(applicationDocumentsRequiringCurrentEvidence({
    patch: {},
    existingStatus: null,
    nextStatus: "APPLIED"
  }), { resumeVersion: true, coverLetterVersion: true });
});

test("effective document selections retain omitted IDs and any stale selected binding fails validation", () => {
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

test("D031: an edited-and-confirmed or legacy-confirmed document counts as current for packet save and APPLIED", async () => {
  const {
    buildDocumentReview,
    confirmDocumentReviewFlag,
    confirmLegacyDocumentReview,
    resolveReviewBaseline,
    withDocumentReview
  } = await import("@/lib/documents/document-review");
  const now = new Date("2026-11-03T09:00:00.000Z");
  const generated = "SUMMARY\nLed a team of 5 engineers.";
  const edited = "SUMMARY\nLed a team of 12 engineers.";
  const baseline = resolveReviewBaseline({
    kind: "RESUME",
    existing: { content: generated, evidenceSnapshotId: "snapshot-current", metadata: null },
    now
  });
  const pending = buildDocumentReview({ baseline, content: edited, previous: null, now });
  const confirmed = confirmDocumentReviewFlag({ review: pending, flagId: pending.flags[0]!.id, now });
  const shared = { currentEvidenceSnapshotId: "snapshot-current", currentEvidenceSourceValid: true };

  assert.doesNotThrow(() => assertApplicationDocumentEvidenceCurrent({
    ...shared,
    resumeVersion: { evidenceSnapshotId: null, fullText: edited, metadata: withDocumentReview(null, confirmed) }
  }));
  assert.throws(() => assertApplicationDocumentEvidenceCurrent({
    ...shared,
    resumeVersion: { evidenceSnapshotId: null, fullText: edited, metadata: withDocumentReview(null, pending) }
  }), (error: unknown) => error instanceof PublicApiError &&
    error.status === 409 && error.details?.code === "APPLICATION_DOCUMENT_REVIEW_REQUIRED");
  assert.throws(() => assertApplicationDocumentEvidenceCurrent({
    currentEvidenceSnapshotId: "snapshot-newer",
    currentEvidenceSourceValid: true,
    resumeVersion: { evidenceSnapshotId: null, fullText: edited, metadata: withDocumentReview(null, confirmed) }
  }), (error: unknown) => error instanceof PublicApiError && error.details?.code === "APPLICATION_DOCUMENT_EVIDENCE_STALE");

  const legacy = "Legacy cover letter body.";
  assert.throws(() => assertApplicationDocumentEvidenceCurrent({
    ...shared,
    coverLetterVersion: { evidenceSnapshotId: null, content: legacy, metadata: null }
  }), (error: unknown) => error instanceof PublicApiError && error.details?.code === "APPLICATION_DOCUMENT_REVIEW_REQUIRED");
  assert.doesNotThrow(() => assertApplicationDocumentEvidenceCurrent({
    ...shared,
    coverLetterVersion: {
      evidenceSnapshotId: null,
      content: legacy,
      metadata: withDocumentReview({ angle: "kept" }, confirmLegacyDocumentReview({ review: null, content: legacy, now }))
    }
  }));
});
