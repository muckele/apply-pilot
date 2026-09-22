import { createHash, randomUUID } from "node:crypto";

import { ApplicationRunState, Prisma } from "@prisma/client";

import { PublicApiError } from "@/lib/api-errors";
import {
  buildApplicationPlanPayload,
  planApplication,
  type ApplicationPlanInput
} from "@/lib/ai/application-plan";
import { applicationRunPathSchema, type ApplicationRunDto, type AutomationPolicyValues } from "@/lib/application-runs/contracts";
import { isHostBlocked, parseExecutionTargetUrl } from "@/lib/application-runs/host-policy";
import { isAutomationAllowed, type AutomationEnv } from "@/lib/application-runs/policy";
import {
  assertPreparationAcquirable,
  buildPreparationAcquireData,
  buildPreparationBlockedData,
  buildPreparationCommitData,
  buildPreparationFailedData,
  canCommitPreparation,
  classifyPreparationAcquisition,
  dailyCapWindowStart,
  evaluatePreparationGates,
  isDailyCapReached,
  type PreparationBlockingReason,
  type PreparationCommitInput,
  type PreparationErrorCategory,
  type PreparationRunFence
} from "@/lib/application-runs/preparation";
import { derivePlanReviewReasons, planCommitState } from "@/lib/application-runs/review-reasons";
import {
  APPLICATION_AUTOMATION_POLICY_VALUE_SELECT,
  APPLICATION_RUN_OPERATIONAL_SELECT,
  automationPolicyDefaultValues,
  toApplicationRunDto
} from "@/lib/application-runs/service";
import { assertRunTransition } from "@/lib/application-runs/state-machine";
import { prisma } from "@/lib/prisma";

const PREPARATION_RUN_SELECT = {
  ...APPLICATION_RUN_OPERATIONAL_SELECT,
  userId: true,
  applyUrlSnapshot: true,
  prepareAttemptId: true,
  firstPreparingAt: true,
  application: {
    select: {
      id: true,
      userId: true,
      jobPostingId: true,
      resumeVersionId: true,
      coverLetterVersionId: true,
      resumeVersion: {
        select: {
          id: true,
          userId: true,
          jobPostingId: true,
          summary: true,
          skills: true,
          fullText: true,
          resume: {
            select: {
              userId: true,
              summary: true,
              skills: true,
              achievements: true,
              workHistory: true,
              projects: true,
              education: true,
              certifications: true
            }
          }
        }
      },
      coverLetterVersion: {
        select: {
          id: true,
          userId: true,
          jobPostingId: true,
          type: true,
          content: true
        }
      }
    }
  },
  jobPosting: {
    select: {
      id: true,
      userId: true,
      title: true,
      company: true,
      location: true,
      remoteStatus: true,
      salaryMin: true,
      salaryMax: true,
      description: true,
      requirements: true,
      preferredQualifications: true,
      detectedTechStack: true,
      overallFitScore: true,
      confidenceScore: true
    }
  },
  user: {
    select: {
      profile: {
        select: {
          careerGoals: true,
          preferredRoles: true,
          preferredLocations: true,
          remotePreference: true,
          salaryTargetMin: true,
          skillsToEmphasize: true,
          skillsNotToExaggerate: true
        }
      }
    }
  }
} as const satisfies Prisma.ApplicationRunSelect;

const PREPARATION_FENCE_SELECT = {
  ...APPLICATION_RUN_OPERATIONAL_SELECT,
  prepareAttemptId: true,
  firstPreparingAt: true
} as const satisfies Prisma.ApplicationRunSelect;

type Planner = typeof planApplication;
type PlannerResult = Awaited<ReturnType<Planner>>;

export type PrepareApplicationRunInput = {
  userId: string;
  runId: string;
  highCostConfirmed: boolean;
};

export type ApplicationRunOrchestrationDependencies = {
  prismaClient?: typeof prisma;
  planner?: Planner;
  clock?: () => Date;
  attemptIdGenerator?: () => string;
  automationEnv?: () => AutomationEnv;
};

type CapturedPreparationAttempt = {
  userId: string;
  runId: string;
  applicationId: string;
  jobPostingId: string;
  attemptId: string;
  acquiredStateVersion: number;
  policySnapshot: Prisma.InputJsonObject;
  policyHash: string;
  minimumConfidenceScore: number;
  fitScore: number;
  matchConfidenceScore: number;
  resumeVersionId: string;
  resumeContentHash: string;
  coverLetterVersionId: string | null;
  coverLetterContentHash: string | null;
  plannerInput: ApplicationPlanInput;
  requirementCatalogSnapshot: Prisma.InputJsonValue;
  evidenceCatalogSnapshot: Prisma.InputJsonValue;
};

type CommittedBlockedOutcome = {
  kind: "blocked";
  error: PublicApiError;
};

type BlockMutationOutcome = CommittedBlockedOutcome | { kind: "stale" };

type Tx1Outcome =
  | { kind: "acquired"; captured: CapturedPreparationAttempt }
  | CommittedBlockedOutcome
  | { kind: "stale" };

type FinalizationOutcome =
  | { kind: "committed"; run: ApplicationRunDto }
  | CommittedBlockedOutcome
  | { kind: "stale" };

type FailureClassification =
  | {
      state: "BLOCKED";
      category: PreparationBlockingReason;
      publicError: PublicApiError;
    }
  | {
      state: "FAILED";
      category: PreparationErrorCategory;
      publicError: PublicApiError;
    };

function validateUserId(userId: unknown): asserts userId is string {
  if (typeof userId !== "string" || !userId.trim()) {
    throw runNotFound();
  }
}

function resolveNow(clock: () => Date): Date {
  const now = clock();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new PublicApiError("The request could not be completed.", 500);
  }
  return now;
}

function runNotFound(): PublicApiError {
  return new PublicApiError("This application run was not found.", 404, { code: "RUN_NOT_FOUND" });
}

function stalePreparation(): PublicApiError {
  return new PublicApiError("This preparation result is no longer current.", 409, {
    code: "RUN_PREPARATION_STALE"
  });
}

function policyUnavailable(): PublicApiError {
  return new PublicApiError("Application automation policy is unavailable.", 503, {
    code: "AUTOMATION_POLICY_UNAVAILABLE"
  });
}

function hashText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function policySnapshot(policy: AutomationPolicyValues): Prisma.InputJsonObject {
  // policyValues() is compile-time exhaustive over AutomationPolicyValues and
  // constructs the stable serialization order used by the SHA-256 provenance hash.
  return { ...policyValues(policy) };
}

function policyValues(policy: AutomationPolicyValues): AutomationPolicyValues {
  return {
    enabled: policy.enabled,
    mode: policy.mode,
    minimumFitScore: policy.minimumFitScore,
    minimumConfidenceScore: policy.minimumConfidenceScore,
    dailyApplicationCap: policy.dailyApplicationCap,
    allowedHosts: [...policy.allowedHosts],
    blockedHosts: [...policy.blockedHosts],
    permittedAdapters: [...policy.permittedAdapters],
    coverLetterRequired: policy.coverLetterRequired,
    sensitiveAnswerPolicy: policy.sensitiveAnswerPolicy,
    finalReviewRequired: policy.finalReviewRequired
  };
}

function preparationFence(run: PreparationRunFence): PreparationRunFence {
  return {
    state: run.state,
    stateVersion: run.stateVersion,
    prepareAttemptId: run.prepareAttemptId,
    prepareLeaseExpiresAt: run.prepareLeaseExpiresAt,
    firstPreparingAt: run.firstPreparingAt
  };
}

function exactRunFenceWhere(
  runId: string,
  userId: string,
  run: Pick<PreparationRunFence, "state" | "stateVersion" | "prepareAttemptId">
) {
  return {
    id: runId,
    userId,
    state: run.state,
    stateVersion: run.stateVersion,
    prepareAttemptId: run.prepareAttemptId
  };
}

function exactAttemptWhere(captured: CapturedPreparationAttempt) {
  return {
    id: captured.runId,
    userId: captured.userId,
    state: "PREPARING" as ApplicationRunState,
    prepareAttemptId: captured.attemptId,
    stateVersion: captured.acquiredStateVersion
  };
}

function deterministicBlockError(reason: PreparationBlockingReason): PublicApiError {
  if (reason === "automation_disabled" || reason === "automation_disabled_during_preparation") {
    return new PublicApiError("Application automation is disabled.", 403, {
      code: "AUTOMATION_DISABLED",
      reason
    });
  }
  if (reason === "host_blocked") {
    return new PublicApiError("This application run target host is blocked by the automation policy.", 403, {
      code: "RUN_HOST_BLOCKED",
      reason
    });
  }
  if (reason === "daily_application_cap_reached") {
    return new PublicApiError("The daily application preparation cap has been reached.", 429, {
      code: "RUN_DAILY_CAP_REACHED",
      reason
    });
  }
  return new PublicApiError("This application run does not satisfy preparation requirements.", 422, {
    code: "RUN_PREPARATION_BLOCKED",
    reason
  });
}

function safeErrorCode(error: unknown): string | null {
  if (!(error instanceof PublicApiError)) return null;
  const code = error.details?.code;
  return typeof code === "string" ? code : null;
}

function classifyPlannerFailure(error: unknown): FailureClassification {
  const code = safeErrorCode(error);
  const blockedCodes: Record<string, PreparationBlockingReason> = {
    AI_BUDGET_EXCEEDED: "ai_budget_exceeded",
    AI_REQUEST_COST_LIMIT: "ai_request_cost_limit",
    AI_COST_CONFIRMATION_REQUIRED: "ai_cost_confirmation_required",
    AI_DUPLICATE_IN_PROGRESS: "ai_duplicate_in_progress"
  };
  const blockedCategory = code ? blockedCodes[code] : undefined;
  if (blockedCategory) {
    return {
      state: "BLOCKED",
      category: blockedCategory,
      publicError: error as PublicApiError
    };
  }

  const category: PreparationErrorCategory =
    code === "PLAN_CONFIDENCE_INVALID"
      ? "planner_confidence_invalid"
      : code === "AI_PROVIDER_USAGE_EXCEEDED_RESERVATION"
        ? "ai_provider_usage_exceeded_reservation"
        : code === "AI_INPUT_TOO_LARGE"
          ? "planner_input_invalid"
          : error instanceof Error && error.name === "GeneratedSchemaError"
            ? "planner_output_invalid"
            : "planner_provider_failure";
  return {
    state: "FAILED",
    category,
    publicError: new PublicApiError("Application planning failed.", 502, {
      code: "RUN_PREPARATION_FAILED",
      category
    })
  };
}

function applicationPlanSnapshot(result: PlannerResult): Prisma.InputJsonObject {
  return {
    targetRoleSummary: result.targetRoleSummary,
    evidenceMap: result.evidenceMap.map((entry) => ({
      requirementId: entry.requirementId,
      requirement: entry.requirement,
      evidenceIds: [...entry.evidenceIds],
      evidence: [...entry.evidence],
      gap: entry.gap
    })),
    resumeStrategy: [...result.resumeStrategy],
    coverLetterAngle: result.coverLetterAngle,
    riskFlags: [...result.riskFlags],
    recommendedNextActions: [...result.recommendedNextActions],
    confidenceScore: result.confidenceScore
  };
}

export function createApplicationRunOrchestrator(
  dependencies: ApplicationRunOrchestrationDependencies = {}
) {
  const prismaClient = dependencies.prismaClient ?? prisma;
  const planner = dependencies.planner ?? planApplication;
  const clock = dependencies.clock ?? (() => new Date());
  const attemptIdGenerator = dependencies.attemptIdGenerator ?? randomUUID;
  const automationEnv = dependencies.automationEnv ?? (() => process.env);

  async function ensureAutomationPolicy(userId: string): Promise<void> {
    const existing = await prismaClient.applicationAutomationPolicy.findUnique({
      where: { userId },
      select: { id: true }
    });
    if (existing) return;

    await prismaClient.$transaction(async (tx) => {
      const lockedUsers = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "User" WHERE "id" = ${userId} FOR NO KEY UPDATE
      `;
      if (lockedUsers.length !== 1) throw policyUnavailable();

      const afterLock = await tx.applicationAutomationPolicy.findUnique({
        where: { userId },
        select: { id: true }
      });
      if (afterLock) return;

      const created = await tx.applicationAutomationPolicy.create({
        data: { userId, ...automationPolicyDefaultValues() },
        select: { id: true, enabled: true }
      });
      await tx.auditLog.create({
        data: {
          userId,
          action: "application-automation-policy.create",
          resource: "ApplicationAutomationPolicy",
          resourceId: created.id,
          metadata: { enabled: created.enabled, source: "application-run.prepare" }
        }
      });
    });
  }

  async function blockRunInTx(
    tx: Prisma.TransactionClient,
    run: PreparationRunFence & { id: string; applicationId: string },
    userId: string,
    reason: PreparationBlockingReason,
    auditAction: string
  ): Promise<BlockMutationOutcome> {
    assertRunTransition(run.state, "BLOCKED");
    const updated = await tx.applicationRun.updateMany({
      where: exactRunFenceWhere(run.id, userId, run),
      data: buildPreparationBlockedData(reason)
    });
    if (updated.count !== 1) return { kind: "stale" };
    const nextStateVersion = run.stateVersion + 1;
    await tx.auditLog.create({
      data: {
        userId,
        action: auditAction,
        resource: "ApplicationRun",
        resourceId: run.id,
        metadata: {
          previousState: run.state,
          nextState: "BLOCKED",
          stateVersion: nextStateVersion,
          reason
        }
      }
    });
    await tx.applicationEvent.create({
      data: {
        userId,
        applicationId: run.applicationId,
        type: "APPLICATION_RUN_EVENT",
        title: "Application run preparation blocked",
        metadata: { runId: run.id, state: "BLOCKED", stateVersion: nextStateVersion, reason }
      }
    });
    return { kind: "blocked", error: deterministicBlockError(reason) };
  }

  async function acquirePreparation(input: PrepareApplicationRunInput): Promise<Tx1Outcome> {
    return prismaClient.$transaction(async (tx) => {
      const lockedPolicies = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "ApplicationAutomationPolicy" WHERE "userId" = ${input.userId} FOR UPDATE
      `;
      if (lockedPolicies.length !== 1) throw policyUnavailable();
      const policy = await tx.applicationAutomationPolicy.findUnique({
        where: { userId: input.userId },
        select: { id: true, ...APPLICATION_AUTOMATION_POLICY_VALUE_SELECT }
      });
      if (!policy) throw policyUnavailable();

      const lockedRuns = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "ApplicationRun" WHERE "id" = ${input.runId} AND "userId" = ${input.userId} FOR UPDATE
      `;
      if (lockedRuns.length !== 1) throw runNotFound();
      const run = await tx.applicationRun.findFirst({
        where: { id: input.runId, userId: input.userId },
        select: PREPARATION_RUN_SELECT
      });
      if (
        !run ||
        run.userId !== input.userId ||
        run.application.id !== run.applicationId ||
        run.application.userId !== input.userId ||
        run.jobPosting.userId !== input.userId ||
        run.application.jobPostingId !== run.jobPostingId ||
        run.jobPosting.id !== run.jobPostingId
      ) {
        throw runNotFound();
      }

      // Resolve time only after both serialization locks and authoritative rereads,
      // so a lock wait cannot shorten a newly acquired lease or shift the cap window.
      const now = resolveNow(clock);
      const runFence = preparationFence(run);
      const acquisition = classifyPreparationAcquisition(runFence, now);
      assertPreparationAcquirable(acquisition);

      if (!isAutomationAllowed(policy, automationEnv())) {
        return blockRunInTx(tx, run, input.userId, "automation_disabled", "application-run.prepare.blocked");
      }

      const target = parseExecutionTargetUrl(run.applyUrlSnapshot);
      const hostBlocked =
        target === null || target.host !== run.applyHost || isHostBlocked(run.applyHost, policy);
      const assignedResume = run.application.resumeVersion;
      const resumeSelectable = Boolean(
        run.application.resumeVersionId &&
        assignedResume &&
        assignedResume.id === run.application.resumeVersionId &&
        assignedResume.userId === input.userId &&
        assignedResume.jobPostingId === run.jobPostingId &&
        (assignedResume.resume === null || assignedResume.resume.userId === input.userId)
      );
      const assignedCoverLetter = run.application.coverLetterVersion;
      const coverLetterSelectable = Boolean(
        run.application.coverLetterVersionId &&
        assignedCoverLetter &&
        assignedCoverLetter.id === run.application.coverLetterVersionId &&
        assignedCoverLetter.userId === input.userId &&
        assignedCoverLetter.jobPostingId === run.jobPostingId &&
        assignedCoverLetter.type === "COVER_LETTER"
      );
      const gate = evaluatePreparationGates({
        hostBlocked,
        fitScore: run.jobPosting.overallFitScore,
        matchConfidence: run.jobPosting.confidenceScore,
        minimumFitScore: policy.minimumFitScore,
        minimumConfidenceScore: policy.minimumConfidenceScore,
        resumeSelectable,
        coverLetterRequired: policy.coverLetterRequired,
        coverLetterSelectable
      });
      if (gate) {
        return blockRunInTx(tx, run, input.userId, gate, "application-run.prepare.blocked");
      }

      if (acquisition.kind === "first-acquire") {
        const recentCount = await tx.applicationRun.count({
          where: {
            userId: input.userId,
            firstPreparingAt: { gte: dailyCapWindowStart(now) }
          }
        });
        if (isDailyCapReached(recentCount, policy.dailyApplicationCap)) {
          return blockRunInTx(
            tx,
            run,
            input.userId,
            "daily_application_cap_reached",
            "application-run.prepare.blocked"
          );
        }
      }

      const attemptId = attemptIdGenerator();
      if (typeof attemptId !== "string" || !attemptId.trim()) {
        throw new PublicApiError("Application preparation could not be started.", 500);
      }
      // Expired/missing-lease PREPARING is an ownership reclaim, not a lifecycle
      // state transition. All other acquisitions must use an approved inbound edge.
      if (run.state !== "PREPARING") assertRunTransition(run.state, "PREPARING");
      const acquired = await tx.applicationRun.updateMany({
        where: exactRunFenceWhere(run.id, input.userId, run),
        data: buildPreparationAcquireData(runFence, now, attemptId)
      });
      if (acquired.count !== 1) return { kind: "stale" };
      const acquiredStateVersion = run.stateVersion + 1;
      await tx.auditLog.create({
        data: {
          userId: input.userId,
          action: "application-run.prepare.acquire",
          resource: "ApplicationRun",
          resourceId: run.id,
          metadata: {
            previousState: run.state,
            nextState: "PREPARING",
            stateVersion: acquiredStateVersion,
            acquisition: acquisition.kind
          }
        }
      });
      await tx.applicationEvent.create({
        data: {
          userId: input.userId,
          applicationId: run.applicationId,
          type: "APPLICATION_RUN_EVENT",
          title: "Application run preparation started",
          metadata: {
            runId: run.id,
            state: "PREPARING",
            stateVersion: acquiredStateVersion,
            acquisition: acquisition.kind
          }
        }
      });

      // The gate guarantees these values. Keeping the post-gate assertions local
      // prevents nullable database fields from leaking into the captured contract.
      if (
        run.jobPosting.overallFitScore === null ||
        run.jobPosting.confidenceScore === null ||
        !assignedResume ||
        !resumeSelectable
      ) {
        throw new PublicApiError("Application preparation prerequisites changed unexpectedly.", 409, {
          code: "RUN_PREPARATION_STALE"
        });
      }
      const selectedCoverLetter = coverLetterSelectable ? assignedCoverLetter : null;
      const plannerInput: ApplicationPlanInput = {
        job: {
          title: run.jobPosting.title,
          company: run.jobPosting.company,
          location: run.jobPosting.location,
          remoteStatus: run.jobPosting.remoteStatus,
          salaryMin: run.jobPosting.salaryMin,
          salaryMax: run.jobPosting.salaryMax,
          description: run.jobPosting.description,
          requirements: [...run.jobPosting.requirements],
          preferredQualifications: [...run.jobPosting.preferredQualifications],
          detectedTechStack: [...run.jobPosting.detectedTechStack]
        },
        resume: {
          summary: assignedResume.summary,
          skills: [...assignedResume.skills],
          achievements: assignedResume.resume ? [...assignedResume.resume.achievements] : [],
          workHistory: assignedResume.resume?.workHistory,
          projects: assignedResume.resume?.projects,
          education: assignedResume.resume?.education,
          certifications: assignedResume.resume?.certifications
        },
        profile: run.user.profile
          ? {
              careerGoals: run.user.profile.careerGoals,
              preferredRoles: [...run.user.profile.preferredRoles],
              preferredLocations: [...run.user.profile.preferredLocations],
              remotePreference: run.user.profile.remotePreference,
              salaryTargetMin: run.user.profile.salaryTargetMin,
              skillsToEmphasize: [...run.user.profile.skillsToEmphasize],
              skillsNotToExaggerate: [...run.user.profile.skillsNotToExaggerate]
            }
          : null
      };
      const payload = buildApplicationPlanPayload(plannerInput);
      const snapshot = policySnapshot(policyValues(policy));
      return {
        kind: "acquired",
        captured: {
          userId: input.userId,
          runId: run.id,
          applicationId: run.applicationId,
          jobPostingId: run.jobPostingId,
          attemptId,
          acquiredStateVersion,
          policySnapshot: snapshot,
          policyHash: hashText(JSON.stringify(snapshot)),
          minimumConfidenceScore: policy.minimumConfidenceScore,
          fitScore: run.jobPosting.overallFitScore,
          matchConfidenceScore: run.jobPosting.confidenceScore,
          resumeVersionId: assignedResume.id,
          resumeContentHash: hashText(assignedResume.fullText),
          coverLetterVersionId: selectedCoverLetter?.id ?? null,
          coverLetterContentHash: selectedCoverLetter ? hashText(selectedCoverLetter.content) : null,
          plannerInput,
          requirementCatalogSnapshot: payload.job.jobRequirements,
          evidenceCatalogSnapshot: payload.evidenceCatalog
        }
      };
    });
  }

  async function commitSuccessfulPreparation(
    captured: CapturedPreparationAttempt,
    commit: PreparationCommitInput,
    targetState: "READY" | "REVIEW_REQUIRED"
  ): Promise<FinalizationOutcome> {
    return prismaClient.$transaction(async (tx) => {
      const lockedPolicies = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "ApplicationAutomationPolicy" WHERE "userId" = ${captured.userId} FOR UPDATE
      `;
      if (lockedPolicies.length !== 1) throw policyUnavailable();
      const currentPolicy = await tx.applicationAutomationPolicy.findUnique({
        where: { userId: captured.userId },
        select: { enabled: true }
      });
      if (!currentPolicy) throw policyUnavailable();

      const lockedRuns = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "ApplicationRun" WHERE "id" = ${captured.runId} AND "userId" = ${captured.userId} FOR UPDATE
      `;
      if (lockedRuns.length !== 1) return { kind: "stale" };
      const run = await tx.applicationRun.findFirst({
        where: { id: captured.runId, userId: captured.userId },
        select: PREPARATION_FENCE_SELECT
      });
      if (!run || !canCommitPreparation(run, {
        prepareAttemptId: captured.attemptId,
        stateVersion: captured.acquiredStateVersion
      })) {
        return { kind: "stale" };
      }

      if (!isAutomationAllowed(currentPolicy, automationEnv())) {
        return blockRunInTx(
          tx,
          run,
          captured.userId,
          "automation_disabled_during_preparation",
          "application-run.prepare.disabled-during-provider"
        );
      }

      assertRunTransition(run.state, targetState);
      const now = resolveNow(clock);
      const updated = await tx.applicationRun.updateMany({
        where: exactAttemptWhere(captured),
        data: buildPreparationCommitData(targetState, now, commit)
      });
      if (updated.count !== 1) return { kind: "stale" };
      const nextStateVersion = run.stateVersion + 1;
      await tx.auditLog.create({
        data: {
          userId: captured.userId,
          action: "application-run.prepare.complete",
          resource: "ApplicationRun",
          resourceId: captured.runId,
          metadata: {
            previousState: "PREPARING",
            nextState: targetState,
            stateVersion: nextStateVersion,
            reviewReasonCount: commit.reviewReasons.length
          }
        }
      });
      await tx.applicationEvent.create({
        data: {
          userId: captured.userId,
          applicationId: captured.applicationId,
          type: "APPLICATION_RUN_EVENT",
          title: targetState === "READY"
            ? "Application run preparation ready"
            : "Application run preparation requires review",
          metadata: {
            runId: captured.runId,
            state: targetState,
            stateVersion: nextStateVersion,
            reviewReasonCount: commit.reviewReasons.length
          }
        }
      });
      const committed = await tx.applicationRun.findFirst({
        where: { id: captured.runId, userId: captured.userId },
        select: APPLICATION_RUN_OPERATIONAL_SELECT
      });
      if (!committed) throw runNotFound();
      return { kind: "committed", run: toApplicationRunDto(committed) };
    });
  }

  async function finalizePlannerFailure(
    captured: CapturedPreparationAttempt,
    failure: FailureClassification
  ): Promise<"finalized" | "stale"> {
    return prismaClient.$transaction(async (tx) => {
      const lockedRuns = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "ApplicationRun" WHERE "id" = ${captured.runId} AND "userId" = ${captured.userId} FOR UPDATE
      `;
      if (lockedRuns.length !== 1) return "stale";
      const run = await tx.applicationRun.findFirst({
        where: { id: captured.runId, userId: captured.userId },
        select: PREPARATION_FENCE_SELECT
      });
      if (!run || !canCommitPreparation(run, {
        prepareAttemptId: captured.attemptId,
        stateVersion: captured.acquiredStateVersion
      })) {
        return "stale";
      }

      assertRunTransition(run.state, failure.state);
      const data = failure.state === "BLOCKED"
        ? buildPreparationBlockedData(failure.category)
        : buildPreparationFailedData(failure.category);
      const updated = await tx.applicationRun.updateMany({
        where: exactAttemptWhere(captured),
        data
      });
      if (updated.count !== 1) return "stale";
      const nextStateVersion = run.stateVersion + 1;
      await tx.auditLog.create({
        data: {
          userId: captured.userId,
          action: failure.state === "BLOCKED"
            ? "application-run.prepare.provider-blocked"
            : "application-run.prepare.failed",
          resource: "ApplicationRun",
          resourceId: captured.runId,
          metadata: {
            previousState: "PREPARING",
            nextState: failure.state,
            stateVersion: nextStateVersion,
            category: failure.category
          }
        }
      });
      await tx.applicationEvent.create({
        data: {
          userId: captured.userId,
          applicationId: captured.applicationId,
          type: "APPLICATION_RUN_EVENT",
          title: failure.state === "BLOCKED"
            ? "Application run preparation blocked"
            : "Application run preparation failed",
          metadata: {
            runId: captured.runId,
            state: failure.state,
            stateVersion: nextStateVersion,
            category: failure.category
          }
        }
      });
      return "finalized";
    });
  }

  async function prepareApplicationRun(unvalidatedInput: PrepareApplicationRunInput): Promise<ApplicationRunDto> {
    validateUserId(unvalidatedInput?.userId);
    const { id: runId } = applicationRunPathSchema.parse({ id: unvalidatedInput?.runId });
    const input: PrepareApplicationRunInput = {
      userId: unvalidatedInput.userId,
      runId,
      highCostConfirmed: unvalidatedInput.highCostConfirmed === true
    };

    // This read is only a non-enumerating fast preflight. TX1 repeats all lifecycle,
    // ownership, and capability decisions after the required row locks.
    const preflight = await prismaClient.applicationRun.findFirst({
      where: { id: input.runId, userId: input.userId },
      select: {
        state: true,
        stateVersion: true,
        prepareAttemptId: true,
        prepareLeaseExpiresAt: true,
        firstPreparingAt: true
      }
    });
    if (!preflight) throw runNotFound();

    await ensureAutomationPolicy(input.userId);
    const tx1 = await acquirePreparation(input);
    if (tx1.kind === "blocked") throw tx1.error;
    if (tx1.kind === "stale") throw stalePreparation();
    const captured = tx1.captured;

    let plannerResult: PlannerResult;
    let commit: PreparationCommitInput;
    let targetState: "READY" | "REVIEW_REQUIRED";
    try {
      // TX1 has fully resolved before this invocation. No transaction object crosses
      // this boundary, and automation is forced true by this trusted orchestrator.
      plannerResult = await planner(captured.plannerInput, captured.userId, {
        automation: true,
        highCostConfirmed: input.highCostConfirmed
      });
      const reviewReasons = derivePlanReviewReasons({
        unknownRequirementIds: [...plannerResult.unknownRequirementIds],
        unknownEvidenceIds: [...plannerResult.unknownEvidenceIds],
        exaggeratedEvidenceIds: [...plannerResult.exaggeratedEvidenceIds],
        inventedNumericClaims: [...plannerResult.inventedNumericClaims],
        hasEvidenceGaps: plannerResult.evidenceMap.some((entry) => entry.gap),
        plannerConfidence: plannerResult.confidenceScore,
        minimumConfidenceScore: captured.minimumConfidenceScore
      });
      targetState = planCommitState(reviewReasons);
      commit = {
        policySnapshot: captured.policySnapshot,
        policyHash: captured.policyHash,
        fitScoreSnapshot: captured.fitScore,
        matchConfidenceScoreSnapshot: captured.matchConfidenceScore,
        plannerConfidenceScoreSnapshot: plannerResult.confidenceScore,
        resumeVersionId: captured.resumeVersionId,
        resumeContentHash: captured.resumeContentHash,
        coverLetterVersionId: captured.coverLetterVersionId,
        coverLetterContentHash: captured.coverLetterContentHash,
        applicationPlanSnapshot: applicationPlanSnapshot(plannerResult),
        requirementCatalogSnapshot: captured.requirementCatalogSnapshot,
        evidenceCatalogSnapshot: captured.evidenceCatalogSnapshot,
        plannerProvider: plannerResult.provider,
        plannerModel: plannerResult.model,
        plannerPromptVersion: plannerResult.promptVersion,
        plannerRequestHash: plannerResult.requestHash,
        reviewReasons
      };
    } catch (error) {
      const failure = classifyPlannerFailure(error);
      const finalized = await finalizePlannerFailure(captured, failure);
      if (finalized === "stale") throw stalePreparation();
      throw failure.publicError;
    }

    const tx2 = await commitSuccessfulPreparation(captured, commit, targetState);
    if (tx2.kind === "stale") throw stalePreparation();
    if (tx2.kind === "blocked") throw tx2.error;
    return tx2.run;
  }

  return { prepareApplicationRun };
}

const defaultApplicationRunOrchestrator = createApplicationRunOrchestrator();

export const prepareApplicationRun = defaultApplicationRunOrchestrator.prepareApplicationRun;
