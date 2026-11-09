import type { EvidenceCorrectionDecision, EvidenceCorrectionReview } from "@/lib/jobs/evidence-correction-review";
import type { AcceptedFactActionInput } from "@/lib/jobs/evidence-snapshot-contracts";

// The job page's plain-language gap choices, mapped onto the unchanged evidence-snapshot save
// contract (apply-pilot/evidence-snapshot-save/v2). The server re-validates every decision.

export type GapChoice = "skip" | "add" | "onResume";
export type GapDraft = { choice: GapChoice; line: string; attested: boolean; resumeLine: string };
export type SavedLineAction = "RETAIN" | "REMOVE" | "REPLACE_OWNER_ATTESTATION";
export type SavedLineDraft = { action: SavedLineAction; line: string; attested: boolean };

export const EMPTY_GAP_DRAFT: GapDraft = { choice: "skip", line: "", attested: false, resumeLine: "" };
export const EMPTY_SAVED_LINE_DRAFT: SavedLineDraft = { action: "RETAIN", line: "", attested: false };

const JOB_ONLY = { reuseScope: "JOB_ONLY" as const, masterProfileOptIn: false as const };

export function resumeSourceFact(review: EvidenceCorrectionReview) {
  return review.facts.find((fact) => fact.ref === "resume.rawText" && fact.sourceAuthoritative) ?? null;
}

// Complete, non-heading lines of the submitted résumé text, exactly as the server will compare them.
export function resumeLines(review: EvidenceCorrectionReview): string[] {
  const source = resumeSourceFact(review);
  if (!source) return [];
  const lines = source.value.replace(/\r\n?/gu, "\n").split("\n").map((line) => line.trim())
    .filter((line) => line && !/^[A-Z][A-Z &/]+:?$/u.test(line));
  return [...new Set(lines)];
}

export function gapDraftComplete(draft: GapDraft) {
  if (draft.choice === "add") return Boolean(draft.line.trim()) && draft.attested;
  if (draft.choice === "onResume") return Boolean(draft.resumeLine);
  return true;
}

export function savedLineDraftComplete(draft: SavedLineDraft) {
  return draft.action !== "REPLACE_OWNER_ATTESTATION" || (Boolean(draft.line.trim()) && draft.attested);
}

export function decisionKind(draft: GapDraft): EvidenceCorrectionDecision["kind"] {
  return draft.choice === "add" ? "OWNER_ATTESTATION" : draft.choice === "onResume" ? "SOURCE_CORRECTION" : "UNRESOLVED";
}

export function buildEvidenceSaveBody(
  review: EvidenceCorrectionReview,
  gapDrafts: Readonly<Record<string, GapDraft>>,
  savedLineDrafts: Readonly<Record<string, SavedLineDraft>>,
  requestId: string
) {
  if (!review.analysisId || !review.analysisInputHash || !review.analysisModel || !review.analysisPromptVersion) {
    throw new Error("Score this job before saving your answers.");
  }
  const source = resumeSourceFact(review);
  const decide = (id: string, draft: GapDraft): EvidenceCorrectionDecision => {
    if (draft.choice === "add") {
      return { gapId: id, kind: "OWNER_ATTESTATION", attestedFact: draft.line.trim(), ownerAttested: draft.attested, ...JOB_ONLY };
    }
    if (draft.choice === "onResume") {
      if (!source) throw new Error("Your résumé text is not available to cite.");
      return {
        gapId: id, kind: "SOURCE_CORRECTION", sourceFactId: source.id,
        sourceExcerpt: draft.resumeLine, correctedFact: draft.resumeLine, ...JOB_ONLY
      };
    }
    return { gapId: id, kind: "UNRESOLVED", ...JOB_ONLY };
  };
  // Every gap gets a decision; an unchecked requirement only when it was answered (see
  // normalizeEvidenceCorrectionDecisions), after the gaps and in listed order.
  const decisions: EvidenceCorrectionDecision[] = [
    ...review.gaps.map((gap) => decide(gap.id, gapDrafts[gap.id] ?? EMPTY_GAP_DRAFT)),
    ...review.uncheckedRequirements.flatMap((requirement) => {
      const draft = gapDrafts[requirement.id] ?? EMPTY_GAP_DRAFT;
      return draft.choice === "skip" ? [] : [decide(requirement.id, draft)];
    })
  ];
  const acceptedFactActions: AcceptedFactActionInput[] = review.acceptedFacts.map((fact) => {
    const draft = savedLineDrafts[fact.factId] ?? EMPTY_SAVED_LINE_DRAFT;
    if (draft.action === "REPLACE_OWNER_ATTESTATION") {
      return { factId: fact.factId, action: draft.action, attestedFact: draft.line.trim(), ownerAttested: true, ...JOB_ONLY };
    }
    return { factId: fact.factId, action: draft.action };
  });
  return {
    schema: "apply-pilot/evidence-snapshot-save/v2" as const,
    requestId,
    resumeId: review.resumeId,
    resumeUpdatedAt: review.resumeUpdatedAt,
    reviewedAnalysis: {
      id: review.analysisId,
      inputHash: review.analysisInputHash,
      model: review.analysisModel,
      promptVersion: review.analysisPromptVersion
    },
    decisions,
    acceptedFactActions
  };
}
