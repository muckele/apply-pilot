import type { ChecklistView } from "@/lib/jobs/job-view-types";
import { gradeLetter } from "@/lib/jobs/grade";
import { summarizeChecklist } from "@/lib/jobs/requirement-checklist";

// What the result window after a score says (G-6): an A is worth creating documents for, a B is
// close (with what's still missing), and a C or D may not be a good fit.
export type ResultWindowView =
  | { kind: "strong"; letter: "A"; score: number; why: string }
  | { kind: "close"; letter: "B"; score: number; why: string; missing: string[] }
  | { kind: "weak"; letter: "C" | "D"; score: number };

const FITS = "Your résumé fits what this job asks for.";
const MISSING_SHOWN = 2;

export function resultWindowView(input: { score: number; checklist: ChecklistView }): ResultWindowView | null {
  const letter = gradeLetter(input.score);
  if (!letter) return null;
  if (letter === "C" || letter === "D") return { kind: "weak", letter, score: input.score };
  const summary = summarizeChecklist(input.checklist.counts);
  const why = summary && input.checklist.counts.shown + input.checklist.counts.notShown > 0 ? `${summary.heading}.` : FITS;
  if (letter === "A") return { kind: "strong", letter, score: input.score, why };
  const missing = input.checklist.items
    .filter((item) => item.status === "not_shown")
    .slice(0, MISSING_SHOWN)
    .map((item) => item.requirement);
  return { kind: "close", letter, score: input.score, why, missing };
}
