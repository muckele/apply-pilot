import { documentReadinessError, resolveDocumentReadiness } from "@/lib/documents/document-review";
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

type CurrentnessArtifact = {
  evidenceSnapshotId: string | null;
  // Full rows carry their exact bytes and review metadata (D031); a bare binding is checked alone.
  content?: string;
  fullText?: string;
  metadata?: unknown;
} | null | undefined;

// A document is current when it is exactly generated from the current reviewed evidence, or when
// it was edited (or is a legacy document) and its owner's review covers its exact current bytes.
export function assertApplicationDocumentEvidenceCurrent(input: {
  currentEvidenceSnapshotId: string | null;
  currentEvidenceSourceValid: boolean;
  resumeVersion?: CurrentnessArtifact;
  coverLetterVersion?: CurrentnessArtifact;
}) {
  const shared = {
    currentEvidenceSnapshotId: input.currentEvidenceSnapshotId,
    currentEvidenceSourceValid: input.currentEvidenceSourceValid
  };
  const states = [input.resumeVersion, input.coverLetterVersion].flatMap((artifact) => {
    if (!artifact) return [];
    const content = artifact.content ?? artifact.fullText;
    if (content === undefined) {
      return isEvidenceBindingCurrent({ ...shared, artifactEvidenceSnapshotId: artifact.evidenceSnapshotId })
        ? []
        : ["EVIDENCE_STALE" as const];
    }
    const readiness = resolveDocumentReadiness({
      ...shared,
      jobBound: true,
      artifact: { evidenceSnapshotId: artifact.evidenceSnapshotId, content, metadata: artifact.metadata ?? null }
    });
    return readiness.exportReady ? [] : [readiness.state];
  });
  if (!states.length) return;
  throw documentReadinessError(states.includes("EVIDENCE_STALE") ? "EVIDENCE_STALE" : states[0]!, "packet");
}
