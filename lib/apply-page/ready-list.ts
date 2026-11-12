import { PREPARE_BLOCKER_COPY, type ReadyFix } from "@/lib/application-runs/blocker-copy";
import type { AttachedDocument } from "@/lib/apply-page/attached-documents";
import { AUTOMATION_POLICY_DEFAULTS } from "@/lib/application-runs/policy";
import type { PreparationBlockingReason } from "@/lib/application-runs/preparation";

export type { ReadyFix };

export type ReadyLine = {
  key: PreparationBlockingReason | "fill_on" | "application_details";
  ok: boolean;
  text: string;
  fix: ReadyFix | null;
  blocking: boolean;
};

export type ReadyListInput = {
  fitScore: number | null;
  confidenceScore: number | null;
  hasCurrentMatch: boolean;
  /** The application's attached résumé and cover letter, against Prepare's readiness rule. */
  resume: AttachedDocument;
  cover: AttachedDocument;
  coverRequired: boolean;
  fillMode: "PREPARE_ONLY" | "FILL_AND_REVIEW";
  hostBlocked: boolean;
  details: { confirmed: number; total: number; missing: string[] };
  minimumFitScore?: number;
  minimumConfidenceScore?: number;
};

const STEP_3: ReadyFix = { label: "Go to step 3", target: "step-3" };

// What an attached document that isn't ready says; the blocker copy covers "nothing attached".
const NOT_READY_TEXT: Record<"out_of_date" | "needs_review", (noun: string) => string> = {
  out_of_date: (noun) => `Your attached ${noun} is out of date. Write a new one in step 3.`,
  needs_review: (noun) => `Your attached ${noun} needs your review before it can be used. Review it in step 3.`
};

function list(items: string[]) {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

export function buildReadyList(input: ReadyListInput): ReadyLine[] {
  const minFit = input.minimumFitScore ?? AUTOMATION_POLICY_DEFAULTS.minimumFitScore;
  const minConfidence = input.minimumConfidenceScore ?? AUTOMATION_POLICY_DEFAULTS.minimumConfidenceScore;
  const scored = (key: "fit_below_threshold" | "match_confidence_below_threshold", label: string, score: number | null, min: number): ReadyLine => {
    const ok = input.hasCurrentMatch && score !== null && score >= min;
    return {
      key,
      ok,
      text: ok ? `${label} ${score} (needs ${min})` : PREPARE_BLOCKER_COPY[key].text,
      fix: ok ? null : { label: "Go to step 1", target: "step-1" },
      blocking: !ok
    };
  };
  const copyLine = (key: PreparationBlockingReason, ok: boolean, okText: string): ReadyLine => ({
    key,
    ok,
    text: ok ? okText : PREPARE_BLOCKER_COPY[key].text,
    fix: ok ? null : PREPARE_BLOCKER_COPY[key].fix,
    blocking: !ok
  });

  const documentLine = (key: "resume_required" | "cover_letter_required", state: AttachedDocument, noun: string, okText: string): ReadyLine =>
    state === "ready" || state === "none"
      ? copyLine(key, state === "ready", okText)
      : { key, ok: false, text: NOT_READY_TEXT[state](noun), fix: STEP_3, blocking: true };

  const lines: ReadyLine[] = [
    scored("fit_below_threshold", "Fit", input.fitScore, minFit),
    scored("match_confidence_below_threshold", "Confidence", input.confidenceScore, minConfidence),
    documentLine("resume_required", input.resume, "résumé", "A résumé is attached.")
  ];
  if (input.coverRequired) lines.push(documentLine("cover_letter_required", input.cover, "cover letter", "A cover letter is attached."));
  lines.push(copyLine("host_blocked", !input.hostBlocked, "This site is not on your block list."));
  if (input.fillMode === "FILL_AND_REVIEW") {
    lines.push({
      key: "fill_on",
      ok: false,
      text: "Assisted Fill is still on from an earlier application. Turn it off to prepare this one.",
      fix: { label: "Turn off", target: "turn-off-fill" },
      blocking: true
    });
  }
  const missing = input.details.missing;
  const complete = missing.length === 0;
  lines.push({
    key: "application_details",
    ok: complete,
    text: complete
      ? "Your application details are confirmed."
      : `We couldn't find your ${list(missing)}. Add them on Your application details.`,
    fix: null,
    blocking: false
  });
  return lines;
}
