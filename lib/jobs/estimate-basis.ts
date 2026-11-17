import type { FitEstimateBasis } from "@/lib/jobs/fit-estimate";

// Client-safe: whether a shown estimate is current for documents and Prepare (the shared rule in
// lib/jobs/current-job-match.ts#currentJobMatchBasis). A bare master-résumé estimate still needs
// a saved review first.
export function estimateIsCurrent(basis: FitEstimateBasis | null | undefined): boolean {
  return basis === "REVIEWED_EVIDENCE" || basis === "MASTER_RESUME_NO_NEW_FACTS";
}
