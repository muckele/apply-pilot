import { isApplicationAutomationEnabled } from "@/lib/application-runs/policy";
import { getCurrentApplicationRun, readAutomationPolicy } from "@/lib/application-runs/service";
import { deriveApplyProgress, type ApplyProgress } from "@/lib/apply-page/apply-progress";
import type { JobDetail } from "@/lib/jobs/job-detail";
import { prisma } from "@/lib/prisma";

// Statuses from APPLIED on mean the user has applied; SAVED, INTERESTED (and ARCHIVED) do not.
const NOT_APPLIED_STATUSES = new Set(["SAVED", "INTERESTED", "ARCHIVED"]);

export type ApplyProgressFacts = {
  hasMasterResume: boolean;
  estimateBasis: "REVIEWED_EVIDENCE" | "MASTER_RESUME" | "MASTER_RESUME_NO_NEW_FACTS" | null;
  application: { status: string; resumeVersionId: string | null; coverLetterVersionId: string | null } | null;
  coverRequired: boolean;
  automationAvailable: boolean;
  run: { state: string } | null;
};

/** Pure mapping from loaded facts to progress, so tests need no database. */
export function applyProgressFromFacts(facts: ApplyProgressFacts): ApplyProgress {
  return deriveApplyProgress({
    hasMasterResume: facts.hasMasterResume,
    hasCurrentMatch: facts.estimateBasis !== null,
    reviewSaved: facts.estimateBasis === "REVIEWED_EVIDENCE",
    resumeAttached: Boolean(facts.application?.resumeVersionId),
    coverAttached: Boolean(facts.application?.coverLetterVersionId),
    coverRequired: facts.coverRequired,
    automationAvailable: facts.automationAvailable,
    run: facts.run ? { state: facts.run.state, companionState: null } : null,
    applied: facts.application ? !NOT_APPLIED_STATUSES.has(facts.application.status) : false
  });
}

/** The one server-side place that works out which Apply step a job is on (job page and Apply page). */
export async function loadApplyProgress(userId: string, detail: JobDetail): Promise<ApplyProgress> {
  const application = detail.application
    ? await prisma.application.findFirst({
        where: { id: detail.application.id, userId },
        select: { status: true, resumeVersionId: true, coverLetterVersionId: true }
      })
    : null;
  const [policy, run] = await Promise.all([
    readAutomationPolicy(userId),
    detail.application && application ? getCurrentApplicationRun(userId, detail.application.id) : Promise.resolve(null)
  ]);
  return applyProgressFromFacts({
    hasMasterResume: detail.sourceText.trim().length > 0,
    estimateBasis: detail.estimate?.basis ?? null,
    application,
    coverRequired: policy.coverLetterRequired,
    automationAvailable: isApplicationAutomationEnabled(),
    run
  });
}
