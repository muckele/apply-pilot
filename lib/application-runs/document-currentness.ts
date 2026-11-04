import { resolveDocumentReadiness } from "@/lib/documents/document-review";

// D031 for Human-Submit runs: a tailored document is current for a run exactly when PR #41 lets it
// be exported or recorded as APPLIED. That is, it was generated from the current reviewed evidence,
// or it was edited (or is a legacy document) and the owner's review covers its exact bytes. An
// edited document with an unconfirmed factual edit, an outdated review, or an edit of older
// evidence is not current. This is the only run rule D031 changes; callers keep every other check.
export function isRunDocumentCurrent(input: {
  currentEvidenceSnapshotId: string | null;
  currentEvidenceSourceValid: boolean;
  artifact: { evidenceSnapshotId: string | null; content: string; metadata: unknown };
}): boolean {
  return resolveDocumentReadiness({
    jobBound: true,
    currentEvidenceSnapshotId: input.currentEvidenceSnapshotId,
    currentEvidenceSourceValid: input.currentEvidenceSourceValid,
    artifact: {
      evidenceSnapshotId: input.artifact.evidenceSnapshotId,
      content: input.artifact.content,
      metadata: input.artifact.metadata ?? null
    }
  }).exportReady;
}
