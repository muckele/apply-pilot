import { PublicApiError } from "@/lib/api-errors";

// Deterministic review-reason identifiers, in stable evaluation order. Derived from the
// enforcement signals produced by lib/ai/application-plan.ts (its enforcement logic is
// not duplicated here; this helper consumes its already-validated output shape).
export const PLAN_REVIEW_REASONS = [
  "unknown_requirement_ids",
  "unknown_evidence_ids",
  "exaggerated_evidence_removed",
  "invented_numeric_claims",
  "planner_confidence_below_threshold",
  "evidence_gaps_present"
] as const;
export type PlanReviewReason = (typeof PLAN_REVIEW_REASONS)[number];

export type PlannerReviewSignals = {
  unknownRequirementIds: string[];
  unknownEvidenceIds: string[];
  exaggeratedEvidenceIds: string[];
  inventedNumericClaims: string[];
  hasEvidenceGaps: boolean;
  // Planner confidence must be a real number from an already schema-validated plan.
  // A missing/malformed value is an unusable planner result: it is handled upstream as
  // FAILED and must never be converted into REVIEW_REQUIRED by this helper.
  plannerConfidence: number;
  minimumConfidenceScore: number;
};

// Maps a validated, enforced planner result to deterministic review reasons.
// Throws PLAN_CONFIDENCE_INVALID for missing/malformed confidence instead of
// manufacturing a review reason from unusable provider output.
export function derivePlanReviewReasons(signals: PlannerReviewSignals): PlanReviewReason[] {
  if (!Number.isFinite(signals.plannerConfidence)) {
    throw new PublicApiError("Planner confidence is missing or malformed; the planner result is unusable.", 502, {
      code: "PLAN_CONFIDENCE_INVALID"
    });
  }
  const reasons: PlanReviewReason[] = [];
  if (signals.unknownRequirementIds.length > 0) reasons.push("unknown_requirement_ids");
  if (signals.unknownEvidenceIds.length > 0) reasons.push("unknown_evidence_ids");
  if (signals.exaggeratedEvidenceIds.length > 0) reasons.push("exaggerated_evidence_removed");
  if (signals.inventedNumericClaims.length > 0) reasons.push("invented_numeric_claims");
  if (signals.plannerConfidence < signals.minimumConfidenceScore) {
    reasons.push("planner_confidence_below_threshold");
  }
  if (signals.hasEvidenceGaps) reasons.push("evidence_gaps_present");
  return reasons;
}

// A usable plan with no review reasons becomes READY; any deterministic uncertainty
// routes to REVIEW_REQUIRED.
export function planCommitState(reviewReasons: readonly string[]): "READY" | "REVIEW_REQUIRED" {
  return reviewReasons.length === 0 ? "READY" : "REVIEW_REQUIRED";
}
