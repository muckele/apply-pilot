import type { MatchInput } from "@/lib/ai/job-match";
import { JOB_MATCH_PROMPT_VERSION } from "@/lib/ai/job-match-version";
import {
  buildCurrentJobMatchContext,
  currentJobMatchBasis,
  currentJobMatchInputHash
} from "@/lib/jobs/current-job-match";
import { validFitScore } from "@/lib/jobs/fit-presentation";

// Which saved JOB_MATCH analysis the job page and feed may show as Apply Pilot's estimate, and on
// what basis. "isCurrent" is the shared rule in lib/jobs/current-job-match.ts#currentJobMatchBasis,
// the same one Prepare, export and résumé tailoring use.
//
// REVIEWED_EVIDENCE           bound to the current reviewed snapshot (rule: REVIEWED_EVIDENCE).
// MASTER_RESUME               no usable snapshot yet, and the analysis input hash equals the input we
//                             would send now (same job, résumé, profile, generation, no reviewed facts).
//                             Not current: documents and Prepare need a saved review first.
// MASTER_RESUME_NO_NEW_FACTS  the current snapshot reviewed exactly this unreviewed analysis and added
//                             no facts (rule: NOTHING_TO_ADD). Current, but it cannot back a new review
//                             save (the server would reject it as stale), so it is not reviewable.
export type FitEstimateBasis = "REVIEWED_EVIDENCE" | "MASTER_RESUME" | "MASTER_RESUME_NO_NEW_FACTS";

type EstimateJob = Parameters<typeof buildCurrentJobMatchContext>[0]["job"];
type EstimateResume = Parameters<typeof buildCurrentJobMatchContext>[0]["resume"];

export type FitEstimateAnalysis = {
  id: string;
  inputHash: string | null;
  evidenceSnapshotId: string | null;
  output: unknown;
  createdAt: Date;
};

export type FitEstimate<T extends FitEstimateAnalysis = FitEstimateAnalysis> = {
  analysis: T;
  score: number;
  basis: FitEstimateBasis;
  isCurrent: boolean;
  reviewable: boolean;
};

function currentOutputScore(output: unknown): number | null {
  if (typeof output !== "object" || output === null || Array.isArray(output)) return null;
  const record = output as Record<string, unknown>;
  if (record.contractVersion !== "3" || record.promptVersion !== JOB_MATCH_PROMPT_VERSION) return null;
  return validFitScore(record.overallFitScore);
}

export function resolveFitEstimate<T extends FitEstimateAnalysis>(input: {
  job: EstimateJob;
  resume: EstimateResume;
  profile: MatchInput["profile"];
  latestAnalysis: T | null;
  currentSnapshotReviewedAnalysisId: string | null;
}): FitEstimate<T> | null {
  const analysis = input.latestAnalysis;
  if (!analysis?.inputHash) return null;
  const score = currentOutputScore(analysis.output);
  if (score === null) return null;

  const context = buildCurrentJobMatchContext({ job: input.job, resume: input.resume, profile: input.profile });
  const current = currentJobMatchBasis({
    job: {
      ...input.job,
      currentEvidenceSnapshot: input.job.currentEvidenceSnapshot
        ? { ...input.job.currentEvidenceSnapshot, reviewedAnalysisId: input.currentSnapshotReviewedAnalysisId }
        : input.job.currentEvidenceSnapshot
    },
    resume: input.resume,
    profile: input.profile,
    analysis,
    context
  });
  if (current === "REVIEWED_EVIDENCE") {
    return { analysis, score, basis: "REVIEWED_EVIDENCE", isCurrent: true, reviewable: true };
  }
  if (current === "NOTHING_TO_ADD") {
    return { analysis, score, basis: "MASTER_RESUME_NO_NEW_FACTS", isCurrent: true, reviewable: false };
  }

  if (
    context.effectiveEvidenceSnapshotId === null &&
    analysis.evidenceSnapshotId === null &&
    analysis.inputHash === currentJobMatchInputHash(context.matchInput)
  ) {
    return { analysis, score, basis: "MASTER_RESUME", isCurrent: false, reviewable: true };
  }

  return null;
}
