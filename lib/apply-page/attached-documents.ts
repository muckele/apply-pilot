import type { DocumentReadinessState } from "@/lib/documents/document-review";

/**
 * How a document attached to the job's application stands for Prepare. Prepare accepts only an
 * attached version that is ready to use (`isRunDocumentCurrent`, D031 export readiness), so
 * "attached" alone never counts:
 * - ready: attached and ready to use
 * - out_of_date: attached, but written from evidence that has since changed (or not one of this
 *   job's versions), so a new one is needed
 * - needs_review: attached, but edited (or older) and waiting for the owner's review
 */
export type AttachedDocument = "none" | "ready" | "out_of_date" | "needs_review";

/**
 * Reads the state from the job's own versions (`JobDetail.resumeVersions` / `coverLetters`), whose
 * `evidenceCurrent` is the same export readiness Prepare checks.
 */
export function attachedDocumentState(
  attachedId: string | null | undefined,
  versions: ReadonlyArray<{ id: string; evidenceCurrent: boolean; review?: { state: DocumentReadinessState } }>
): AttachedDocument {
  if (!attachedId) return "none";
  const version = versions.find((candidate) => candidate.id === attachedId);
  if (version?.evidenceCurrent) return "ready";
  return version?.review && version.review.state !== "EVIDENCE_STALE" ? "needs_review" : "out_of_date";
}
