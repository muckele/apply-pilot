import type { ApplicationDetailsView } from "@/lib/application-details";
import { loadApplicationDetails } from "@/lib/application-details-store";
import type { ApplicationRunDto, AutomationPolicyDto } from "@/lib/application-runs/contracts";
import { isHostBlocked } from "@/lib/application-runs/host-policy";
import { isApplicationAutomationEnabled } from "@/lib/application-runs/policy";
import { getCurrentApplicationRun, readAutomationPolicy } from "@/lib/application-runs/service";
import { deriveApplyProgress, type ApplyProgress, type ApplyProgressInput } from "@/lib/apply-page/apply-progress";
import { buildReadyList, type ReadyLine } from "@/lib/apply-page/ready-list";
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
  return deriveApplyProgress(applyProgressInputFromFacts(facts));
}

/** The inputs behind a job's progress; the Apply page re-derives with a fresher run from them. */
export function applyProgressInputFromFacts(facts: ApplyProgressFacts): ApplyProgressInput {
  return {
    hasMasterResume: facts.hasMasterResume,
    hasCurrentMatch: facts.estimateBasis !== null,
    reviewSaved: facts.estimateBasis === "REVIEWED_EVIDENCE",
    resumeAttached: Boolean(facts.application?.resumeVersionId),
    coverAttached: Boolean(facts.application?.coverLetterVersionId),
    coverRequired: facts.coverRequired,
    automationAvailable: facts.automationAvailable,
    run: facts.run ? { state: facts.run.state, companionState: null } : null,
    applied: facts.application ? !NOT_APPLIED_STATUSES.has(facts.application.status) : false
  };
}

/** What step 4 (Prepare) shows: the ready list, the host it asks about, the Fill mode and the run. */
export type PrepareStepState = {
  /** The run's host once a run exists, else the host the job's apply link gives ("" when none is usable). */
  applyHost: string;
  readyList: ReadyLine[];
  fillMode: AutomationPolicyDto["mode"];
  run: { id: string; state: string; blockingReason: string | null; errorCategory: string | null } | null;
};

export type PrepareStepFacts = {
  jobApplyHost: string | null;
  estimate: { score: number; basis: string } | null;
  /** The current detailed match's confidence (null without a current match). */
  confidenceScore: number | null;
  application: { resumeVersionId: string | null; coverLetterVersionId: string | null } | null;
  policy: Pick<AutomationPolicyDto, "mode" | "coverLetterRequired" | "blockedHosts" | "minimumFitScore" | "minimumConfidenceScore">;
  run: Pick<ApplicationRunDto, "id" | "state" | "applyHost" | "blockingReason" | "errorCategory"> | null;
  details: Pick<ApplicationDetailsView, "fields" | "confirmedCount" | "missingRequired">;
};

/**
 * Pure mapping from loaded facts to step 4's state. The ready list mirrors Prepare's own gates: the
 * fit and confidence of the match bound to the saved review (the only match Prepare accepts), the
 * attached documents, the policy's thresholds, cover-letter rule and block list, and the Fill mode.
 */
export function prepareStateFromFacts(facts: PrepareStepFacts): PrepareStepState {
  const applyHost = facts.run?.applyHost ?? facts.jobApplyHost ?? "";
  return {
    applyHost,
    fillMode: facts.policy.mode,
    run: facts.run
      ? { id: facts.run.id, state: facts.run.state, blockingReason: facts.run.blockingReason, errorCategory: facts.run.errorCategory }
      : null,
    readyList: buildReadyList({
      fitScore: facts.estimate?.score ?? null,
      confidenceScore: facts.confidenceScore,
      hasCurrentMatch: facts.estimate?.basis === "REVIEWED_EVIDENCE",
      resumeAttached: Boolean(facts.application?.resumeVersionId),
      coverAttached: Boolean(facts.application?.coverLetterVersionId),
      coverRequired: facts.policy.coverLetterRequired,
      fillMode: facts.policy.mode,
      hostBlocked: applyHost !== "" && isHostBlocked(applyHost, facts.policy),
      details: { confirmed: facts.details.confirmedCount, total: facts.details.fields.length, missing: facts.details.missingRequired },
      minimumFitScore: facts.policy.minimumFitScore,
      minimumConfidenceScore: facts.policy.minimumConfidenceScore
    })
  };
}

// The application, policy and current run behind a job's progress, and the progress itself.
async function loadProgressFacts(userId: string, detail: JobDetail) {
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
  const progressFacts: ApplyProgressFacts = {
    hasMasterResume: detail.sourceText.trim().length > 0,
    estimateBasis: detail.estimate?.basis ?? null,
    application,
    coverRequired: policy.coverLetterRequired,
    automationAvailable: isApplicationAutomationEnabled(),
    run
  };
  return { application, policy, run, progress: applyProgressFromFacts(progressFacts), progressInput: applyProgressInputFromFacts(progressFacts) };
}

/** The one server-side place that works out which Apply step a job is on (job page and Apply page). */
export async function loadApplyProgress(userId: string, detail: JobDetail): Promise<ApplyProgress> {
  return (await loadProgressFacts(userId, detail)).progress;
}

/**
 * The Apply page's server state: its progress, whether the account's policy requires a cover
 * letter (Prepare blocks without one), which is step 3's default for "Include a cover letter", and
 * step 4's ready list and run.
 */
export async function loadApplyPageState(
  userId: string,
  detail: JobDetail
): Promise<{ progress: ApplyProgress; progressInput: ApplyProgressInput; coverLetterRequired: boolean; prepare: PrepareStepState }> {
  const [{ application, policy, run, progress, progressInput }, details] = await Promise.all([
    loadProgressFacts(userId, detail),
    loadApplicationDetails(userId)
  ]);
  const prepare = prepareStateFromFacts({
    jobApplyHost: detail.applyHost,
    estimate: detail.estimate,
    confidenceScore: detail.currentConfidenceScore,
    application,
    policy,
    run,
    details
  });
  return { progress, progressInput, coverLetterRequired: policy.coverLetterRequired, prepare };
}
