import {
  buildDocumentReview,
  confirmDocumentReviewFlag,
  confirmLegacyDocumentReview,
  resolveReviewBaseline,
  withDocumentReview,
  type DocumentKind
} from "@/lib/documents/document-review";

// Synthetic document fixtures for Apply Kit tests. They are built with the D031 review helpers
// (PR #41) so "edited and confirmed" means exactly what export and the APPLIED gate accept.

export const APPLY_KIT_NOW = new Date("2026-11-03T18:00:00.000Z");
export const CURRENT_SNAPSHOT = "snapshot-current";

export const generatedCoverText = [
  "Dear Example Co Hiring Team,",
  "I led a team of 5 engineers at Example Co.",
  "Sincerely,",
  "Synthetic Applicant"
].join("\n");

export const generatedCoverMetadata = {
  angle: "Reliability",
  claimsUsed: [{
    claim: "I led a team of 5 engineers at Example Co.",
    citations: [{ ref: "resume.workHistory[0]", excerpt: "Led a team of 5 engineers at Example Co." }]
  }]
};

export const generatedResumeText = [
  "Synthetic Applicant",
  "SUMMARY",
  "Built reliable TypeScript services at Example Co."
].join("\n");

export const generatedResumeMetadata = {
  claimEvidence: [{
    claim: "Built reliable TypeScript services at Example Co.",
    citations: [{ ref: "resume.achievements[0]", excerpt: "Built reliable TypeScript services at Example Co." }]
  }]
};

type Artifact = { evidenceSnapshotId: string | null; content: string; metadata: unknown };

// An edited document whose flagged factual edit is still unconfirmed (EDITED_NEEDS_REVIEW).
export function editedUnconfirmed(kind: DocumentKind, original: Artifact, nextContent: string): Artifact {
  const baseline = resolveReviewBaseline({ kind, existing: original, now: APPLY_KIT_NOW });
  const review = buildDocumentReview({ baseline, content: nextContent, previous: null, now: APPLY_KIT_NOW });
  if (!review.flags.length) throw new Error("fixture edit must add an unsupported factual claim");
  return { evidenceSnapshotId: null, content: nextContent, metadata: withDocumentReview(original.metadata, review) };
}

// The same edit after the owner confirmed every flag (EDITED_READY).
export function editedConfirmed(kind: DocumentKind, original: Artifact, nextContent: string): Artifact {
  const baseline = resolveReviewBaseline({ kind, existing: original, now: APPLY_KIT_NOW });
  let review = buildDocumentReview({ baseline, content: nextContent, previous: null, now: APPLY_KIT_NOW });
  for (const flag of review.flags) review = confirmDocumentReviewFlag({ review, flagId: flag.id, now: APPLY_KIT_NOW });
  return { evidenceSnapshotId: null, content: nextContent, metadata: withDocumentReview(original.metadata, review) };
}

// A legacy (pre-citation) document confirmed as a whole (LEGACY_CONFIRMED).
export function legacyConfirmed(content: string): Artifact {
  const review = confirmLegacyDocumentReview({ review: null, content, now: APPLY_KIT_NOW });
  return { evidenceSnapshotId: null, content, metadata: withDocumentReview(null, review) };
}

export const editedCoverText = generatedCoverText.replace("5 engineers", "12 engineers");
export const editedResumeText = `${generatedResumeText}\nCut latency 40% at Example Co.`;
