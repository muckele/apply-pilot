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
