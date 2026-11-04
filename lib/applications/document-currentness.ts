import { PublicApiError } from "@/lib/api-errors";
import { isEvidenceBindingCurrent } from "@/lib/jobs/evidence-snapshot-contracts";

export { isEvidenceBindingCurrent } from "@/lib/jobs/evidence-snapshot-contracts";

type ExistingApplicationDocuments = {
  resumeVersionId: string | null;
  coverLetterVersionId: string | null;
} | null;

type ApplicationDocumentPatch = {
  resumeVersionId?: string;
  coverLetterVersionId?: string | null;
};

export function resolveEffectiveApplicationDocumentIds(
  input: ApplicationDocumentPatch,
  existing: ExistingApplicationDocuments
) {
  return {
    resumeVersionId: Object.hasOwn(input, "resumeVersionId")
      ? (input.resumeVersionId ?? null)
      : (existing?.resumeVersionId ?? null),
    coverLetterVersionId: Object.hasOwn(input, "coverLetterVersionId")
      ? (input.coverLetterVersionId ?? null)
      : (existing?.coverLetterVersionId ?? null)
  };
}

// Evidence currentness gates what a request newly attaches or sends, not the tracker history.
// A document must be current when the request explicitly selects it, or when the request moves
// the application into APPLIED (the packet the user is recording as sent). Status, notes, and
// follow-up updates on an existing record keep their historical selections without re-gating, so
// a later master-resume edit or legacy (pre-snapshot) documents never freeze the tracker.
export function applicationDocumentsRequiringCurrentEvidence(input: {
  patch: ApplicationDocumentPatch;
  existingStatus: string | null;
  nextStatus: string;
}) {
  const enteringApplied = input.nextStatus === "APPLIED" && input.existingStatus !== "APPLIED";
  return {
    resumeVersion: enteringApplied || typeof input.patch.resumeVersionId === "string",
    coverLetterVersion: enteringApplied || typeof input.patch.coverLetterVersionId === "string"
  };
}

export function assertApplicationDocumentEvidenceCurrent(input: {
  currentEvidenceSnapshotId: string | null;
  currentEvidenceSourceValid: boolean;
  resumeVersion?: { evidenceSnapshotId: string | null } | null;
  coverLetterVersion?: { evidenceSnapshotId: string | null } | null;
}) {
  const shared = {
    currentEvidenceSnapshotId: input.currentEvidenceSnapshotId,
    currentEvidenceSourceValid: input.currentEvidenceSourceValid
  };
  const stale = [input.resumeVersion, input.coverLetterVersion].some((artifact) => artifact &&
    !isEvidenceBindingCurrent({
      ...shared,
      artifactEvidenceSnapshotId: artifact.evidenceSnapshotId
    }));
  if (stale) {
    throw new PublicApiError(
      "Regenerate documents from the current reviewed evidence before saving this packet.",
      409,
      { code: "APPLICATION_DOCUMENT_EVIDENCE_STALE" }
    );
  }
}
