import type { EvidenceCorrectionReview } from "@/lib/jobs/evidence-correction-review";
import { evidenceSnapshotSaveResponseSchema } from "@/lib/jobs/evidence-snapshot-contracts";
import { buildEvidenceSaveBody } from "@/lib/jobs/tailor-decisions";
import { aiErrorText, type AiErrorPayload } from "@/lib/apply-page/ai-error-text";

const STALE_CODES: ReadonlySet<string> = new Set(["EVIDENCE_SOURCE_STALE", "EVIDENCE_ANALYSIS_STALE"]);
export const REVIEW_CHANGED = "This job's review changed in another tab. Reload this page to continue.";

// "Create" on a master-résumé match (G-6): record that the user had nothing to add for this job,
// leaving every requirement open, so that exact match stands as current with no second score
// (lib/jobs/current-job-match.ts#currentJobMatchBasis). No line is attested, so no truth check.
export async function saveNothingToAdd(jobId: string, review: EvidenceCorrectionReview, requestId: string): Promise<void> {
  const response = await fetch(`/api/jobs/${jobId}/evidence-snapshots`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(buildEvidenceSaveBody(review, {}, {}, requestId))
  });
  const json = (await response.json().catch(() => null)) as AiErrorPayload;
  if (!response.ok) {
    if (response.status === 409 && typeof json?.code === "string" && STALE_CODES.has(json.code)) throw new Error(REVIEW_CHANGED);
    throw new Error(aiErrorText(json, "Apply Pilot couldn't save your review."));
  }
  const saved = evidenceSnapshotSaveResponseSchema.safeParse(json);
  if (!saved.success || !saved.data.snapshot.isCurrent) throw new Error(REVIEW_CHANGED);
}
