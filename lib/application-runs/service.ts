import { createHash } from "node:crypto";

import { Prisma } from "@prisma/client";

import { PublicApiError } from "@/lib/api-errors";
import {
  computeApplicationAnswerProposalHash,
  parseCompatibleApplicationAnswerProposal
} from "@/lib/application-runs/answer-packet-domain";
import {
  loadVerifiedCurrentAnswerPacketForLockedRunInTransaction,
  type LockedAnswerPacketRun
} from "@/lib/application-runs/answer-packet-service";
import {
  applicationRunPathSchema,
  applicationRunAnswerPathSchema,
  createApplicationRunBodySchema,
  resolveApplicationRunReviewBodySchema,
  reviewApplicationRunAnswerBodySchema,
  type ApplicationRunAnswerDto,
  type ApplicationRunDto,
  type AutomationPolicyDto,
  type AutomationPolicyValues
} from "@/lib/application-runs/contracts";
import { parseExecutionTargetUrl } from "@/lib/application-runs/host-policy";
import {
  AUTOMATION_POLICY_DEFAULTS,
  isAutomationAllowed,
  parseAutomationPolicyPatch,
  type AutomationEnv
} from "@/lib/application-runs/policy";
import {
  revokeUsableExecutionTokensForRunInTransaction,
  revokeUsableExecutionTokensForUserInTransaction
} from "@/lib/application-runs/execution-token";
import { PLAN_REVIEW_REASONS, type PlanReviewReason } from "@/lib/application-runs/review-reasons";
import {
  assertRunTransition,
  buildCancelRunData,
  buildResolveRunReviewData
} from "@/lib/application-runs/state-machine";
import { prisma } from "@/lib/prisma";

export const APPLICATION_AUTOMATION_POLICY_VALUE_SELECT = {
  enabled: true,
  mode: true,
  minimumFitScore: true,
  minimumConfidenceScore: true,
  dailyApplicationCap: true,
  allowedHosts: true,
  blockedHosts: true,
  permittedAdapters: true,
  coverLetterRequired: true,
  sensitiveAnswerPolicy: true,
  finalReviewRequired: true
} as const satisfies Prisma.ApplicationAutomationPolicySelect & Record<keyof AutomationPolicyValues, true>;

export const APPLICATION_AUTOMATION_POLICY_VALUE_KEYS = Object.keys(
  APPLICATION_AUTOMATION_POLICY_VALUE_SELECT
) as Array<keyof AutomationPolicyValues>;

export const APPLICATION_RUN_OPERATIONAL_SELECT = {
  id: true,
  applicationId: true,
  jobPostingId: true,
  state: true,
  stateVersion: true,
  applyHost: true,
  applyUrlSnapshot: true,
  detectedAdapter: true,
  prepareLeaseExpiresAt: true,
  reviewReasons: true,
  reviewAcknowledgedAt: true,
  blockingReason: true,
  errorCategory: true,
  preparedAt: true,
  cancelledAt: true,
  createdAt: true,
  updatedAt: true
} as const satisfies Prisma.ApplicationRunSelect;

const APPLICATION_RUN_LIFECYCLE_SELECT = {
  ...APPLICATION_RUN_OPERATIONAL_SELECT,
  userId: true,
  prepareAttemptId: true,
  fillAttemptId: true,
  fillLeaseExpiresAt: true,
  firstPreparingAt: true,
  currentFormInspectionVersion: true,
  currentAnswerPacketVersion: true,
  applyUrlSnapshot: true,
  resumeVersionId: true,
  resumeContentHash: true,
  coverLetterVersionId: true,
  coverLetterContentHash: true,
  application: {
    select: { id: true, userId: true, jobPostingId: true }
  },
  jobPosting: {
    select: { id: true, userId: true }
  }
} as const satisfies Prisma.ApplicationRunSelect;

const APPLICATION_RUN_ANSWER_REVIEW_SELECT = {
  id: true,
  runId: true,
  userId: true,
  answerPacketId: true,
  normalizedFieldKey: true,
  fieldFingerprint: true,
  semanticFieldKey: true,
  fieldType: true,
  classification: true,
  disposition: true,
  proposedValue: true,
  proposal: true,
  valueRedacted: true,
  sensitive: true,
  status: true,
  reviewedByUser: true,
  reviewedAt: true
} as const satisfies Prisma.ApplicationRunAnswerSelect;

const APPLICATION_RUN_ANSWER_DTO_SELECT = {
  id: true,
  runId: true,
  status: true,
  reviewedByUser: true,
  reviewedAt: true,
  sensitive: true,
  valueRedacted: true
} as const satisfies Prisma.ApplicationRunAnswerSelect;

export type ApplicationRunServicePrismaClient = Pick<
  typeof prisma,
  "$transaction" | "applicationAutomationPolicy" | "application" | "applicationRun" | "applicationRunAnswer"
>;

export type ApplicationRunServiceDependencies = {
  prismaClient?: ApplicationRunServicePrismaClient;
  env?: AutomationEnv;
  clock?: () => Date;
  loadVerifiedCurrentAnswerPacketForLockedRunInTransaction?:
    typeof loadVerifiedCurrentAnswerPacketForLockedRunInTransaction;
  assertTransition?: typeof assertRunTransition;
};

function validateUserId(userId: unknown): asserts userId is string {
  if (typeof userId !== "string" || !userId.trim()) {
    throw new PublicApiError("The requested resource was not found.", 404, { code: "RESOURCE_NOT_FOUND" });
  }
}

export function automationPolicyDefaultValues(): AutomationPolicyValues {
  return {
    enabled: AUTOMATION_POLICY_DEFAULTS.enabled,
    mode: AUTOMATION_POLICY_DEFAULTS.mode,
    minimumFitScore: AUTOMATION_POLICY_DEFAULTS.minimumFitScore,
    minimumConfidenceScore: AUTOMATION_POLICY_DEFAULTS.minimumConfidenceScore,
    dailyApplicationCap: AUTOMATION_POLICY_DEFAULTS.dailyApplicationCap,
    allowedHosts: [...AUTOMATION_POLICY_DEFAULTS.allowedHosts],
    blockedHosts: [...AUTOMATION_POLICY_DEFAULTS.blockedHosts],
    permittedAdapters: [...AUTOMATION_POLICY_DEFAULTS.permittedAdapters],
    coverLetterRequired: AUTOMATION_POLICY_DEFAULTS.coverLetterRequired,
    sensitiveAnswerPolicy: AUTOMATION_POLICY_DEFAULTS.sensitiveAnswerPolicy,
    finalReviewRequired: AUTOMATION_POLICY_DEFAULTS.finalReviewRequired
  };
}

function copyPolicyValues(policy: AutomationPolicyValues): AutomationPolicyValues {
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

function nextPolicyValues(
  current: AutomationPolicyValues,
  patch: ReturnType<typeof parseAutomationPolicyPatch>
): AutomationPolicyValues {
  return {
    enabled: patch.enabled ?? current.enabled,
    mode: patch.mode ?? current.mode,
    minimumFitScore: patch.minimumFitScore ?? current.minimumFitScore,
    minimumConfidenceScore: patch.minimumConfidenceScore ?? current.minimumConfidenceScore,
    dailyApplicationCap: patch.dailyApplicationCap ?? current.dailyApplicationCap,
    allowedHosts: patch.allowedHosts ? [...patch.allowedHosts] : [...current.allowedHosts],
    blockedHosts: patch.blockedHosts ? [...patch.blockedHosts] : [...current.blockedHosts],
    permittedAdapters: patch.permittedAdapters ? [...patch.permittedAdapters] : [...current.permittedAdapters],
    coverLetterRequired: patch.coverLetterRequired ?? current.coverLetterRequired,
    sensitiveAnswerPolicy: patch.sensitiveAnswerPolicy ?? current.sensitiveAnswerPolicy,
    finalReviewRequired: patch.finalReviewRequired ?? current.finalReviewRequired
  };
}

function valuesEqual(left: AutomationPolicyValues[keyof AutomationPolicyValues], right: AutomationPolicyValues[keyof AutomationPolicyValues]) {
  return Array.isArray(left) && Array.isArray(right)
    ? left.length === right.length && left.every((value, index) => value === right[index])
    : left === right;
}

export function changedAutomationPolicyFields(
  current: AutomationPolicyValues,
  next: AutomationPolicyValues
): Array<keyof AutomationPolicyValues> {
  return APPLICATION_AUTOMATION_POLICY_VALUE_KEYS.filter((key) => !valuesEqual(current[key], next[key]));
}

function policyDto(policy: AutomationPolicyValues, persisted: boolean, env: AutomationEnv): AutomationPolicyDto {
  const values = copyPolicyValues(policy);
  return {
    ...values,
    persisted,
    effectiveEnabled: isAutomationAllowed(values, env)
  };
}

export function toApplicationRunDto(run: ApplicationRunDto): ApplicationRunDto {
  return {
    id: run.id,
    applicationId: run.applicationId,
    jobPostingId: run.jobPostingId,
    state: run.state,
    stateVersion: run.stateVersion,
    applyHost: run.applyHost,
    applyUrlSnapshot: run.applyUrlSnapshot,
    detectedAdapter: run.detectedAdapter,
    prepareLeaseExpiresAt: run.prepareLeaseExpiresAt,
    reviewReasons: [...run.reviewReasons],
    reviewAcknowledgedAt: run.reviewAcknowledgedAt,
    blockingReason: run.blockingReason,
    errorCategory: run.errorCategory,
    preparedAt: run.preparedAt,
    cancelledAt: run.cancelledAt,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt
  };
}

function applicationNotFound(): PublicApiError {
  return new PublicApiError("This application was not found.", 404, { code: "APPLICATION_NOT_FOUND" });
}

function runNotFound(): PublicApiError {
  return new PublicApiError("This application run was not found.", 404, { code: "RUN_NOT_FOUND" });
}

function answerNotFound(): PublicApiError {
  return new PublicApiError("This application run answer was not found.", 404, { code: "RUN_ANSWER_NOT_FOUND" });
}

function staleRunLifecycle(): PublicApiError {
  return new PublicApiError("This application run changed before the request could be completed.", 409, {
    code: "RUN_LIFECYCLE_STALE"
  });
}

function packetStale(): PublicApiError {
  return new PublicApiError("The requested answer packet is no longer current.", 409, {
    code: "RUN_PACKET_STALE"
  });
}

function packetInvalid(): PublicApiError {
  return new PublicApiError("The current answer packet is invalid.", 409, {
    code: "RUN_PACKET_INVALID"
  });
}

function packetReviewIncomplete(): PublicApiError {
  return new PublicApiError("The current answer packet review is incomplete.", 409, {
    code: "RUN_PACKET_REVIEW_INCOMPLETE"
  });
}

function answerNotApprovable(): PublicApiError {
  return new PublicApiError("This application run answer cannot be approved.", 422, {
    code: "RUN_ANSWER_NOT_APPROVABLE"
  });
}

function toApplicationRunAnswerDto(answer: ApplicationRunAnswerDto): ApplicationRunAnswerDto {
  return {
    id: answer.id,
    runId: answer.runId,
    status: answer.status,
    reviewedByUser: answer.reviewedByUser,
    reviewedAt: answer.reviewedAt,
    sensitive: answer.sensitive,
    valueRedacted: answer.valueRedacted
  };
}

function resolveNow(clock: () => Date) {
  const now = clock();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new PublicApiError("The request could not be completed.", 500);
  }
  return now;
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") ||
    (Boolean(error) && typeof error === "object" && (error as { code?: unknown }).code === "P2002")
  );
}

export function createApplicationRunService(dependencies: ApplicationRunServiceDependencies = {}) {
  const prismaClient = dependencies.prismaClient ?? prisma;
  const env = dependencies.env ?? process.env;
  const clock = dependencies.clock ?? (() => new Date());
  const loadVerifiedCurrentPacket =
    dependencies.loadVerifiedCurrentAnswerPacketForLockedRunInTransaction ??
    loadVerifiedCurrentAnswerPacketForLockedRunInTransaction;
  const assertTransition = dependencies.assertTransition ?? assertRunTransition;

  async function readAutomationPolicy(userId: string): Promise<AutomationPolicyDto> {
    validateUserId(userId);
    const policy = await prismaClient.applicationAutomationPolicy.findUnique({
      where: { userId },
      select: APPLICATION_AUTOMATION_POLICY_VALUE_SELECT
    });
    return policyDto(policy ?? automationPolicyDefaultValues(), policy !== null, env);
  }

  async function updateAutomationPolicy(userId: string, unvalidatedPatch: unknown) {
    validateUserId(userId);
    const patch = parseAutomationPolicyPatch(unvalidatedPatch);
    if (Object.keys(patch).length === 0) {
      return { ...(await readAutomationPolicy(userId)), changed: false, revokedExecutionTokenCount: 0 };
    }

    return prismaClient.$transaction(async (tx) => {
      // The stable owning row serializes simultaneous first PATCH requests while
      // allowing Prisma to remain the source of CUID and timestamp generation.
      // All policy writers take this lock before the policy lock.
      const lockedUsers = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "User" WHERE "id" = ${userId} FOR NO KEY UPDATE
      `;
      if (lockedUsers.length !== 1) {
        throw new PublicApiError("Application automation policy is unavailable.", 503, {
          code: "AUTOMATION_POLICY_UNAVAILABLE"
        });
      }

      const existingAfterUserLock = await tx.applicationAutomationPolicy.findUnique({
        where: { userId },
        select: { id: true }
      });
      const defaults = automationPolicyDefaultValues();
      const insertedByThisTransaction = existingAfterUserLock === null;
      const ensured = existingAfterUserLock ?? await tx.applicationAutomationPolicy.create({
        data: { userId, ...defaults },
        select: { id: true }
      });
      await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "ApplicationAutomationPolicy" WHERE "userId" = ${userId} FOR UPDATE
      `;
      const locked = await tx.applicationAutomationPolicy.findUnique({
        where: { userId },
        select: { id: true, ...APPLICATION_AUTOMATION_POLICY_VALUE_SELECT }
      });
      if (!locked) {
        throw new PublicApiError("Application automation policy is unavailable.", 503, {
          code: "AUTOMATION_POLICY_UNAVAILABLE"
        });
      }

      const currentValues = copyPolicyValues(locked);
      const nextValues = nextPolicyValues(currentValues, patch);
      const changedFields = changedAutomationPolicyFields(currentValues, nextValues);

      if (changedFields.length === 0) {
        if (insertedByThisTransaction) {
          await tx.auditLog.create({
            data: {
              userId,
              action: "application-automation-policy.create",
              resource: "ApplicationAutomationPolicy",
              resourceId: ensured.id,
              metadata: { enabled: nextValues.enabled }
            }
          });
        }
        return {
          ...policyDto(nextValues, true, env),
          changed: false,
          revokedExecutionTokenCount: 0
        };
      }

      const updated = await tx.applicationAutomationPolicy.update({
        where: { userId },
        data: {
          enabled: nextValues.enabled,
          mode: nextValues.mode,
          minimumFitScore: nextValues.minimumFitScore,
          minimumConfidenceScore: nextValues.minimumConfidenceScore,
          dailyApplicationCap: nextValues.dailyApplicationCap,
          allowedHosts: nextValues.allowedHosts,
          blockedHosts: nextValues.blockedHosts,
          permittedAdapters: nextValues.permittedAdapters,
          coverLetterRequired: nextValues.coverLetterRequired,
          sensitiveAnswerPolicy: nextValues.sensitiveAnswerPolicy,
          finalReviewRequired: nextValues.finalReviewRequired
        },
        select: { id: true, ...APPLICATION_AUTOMATION_POLICY_VALUE_SELECT }
      });
      const now = resolveNow(clock);
      const revokedExecutionTokenCount = await revokeUsableExecutionTokensForUserInTransaction(tx, {
        userId,
        now,
        reason: "policy_changed"
      });
      await tx.auditLog.create({
        data: {
          userId,
          action: insertedByThisTransaction
            ? "application-automation-policy.create"
            : "application-automation-policy.update",
          resource: "ApplicationAutomationPolicy",
          resourceId: updated.id,
          metadata: {
            changedFields,
            enabled: updated.enabled,
            revokedExecutionTokenCount,
            changedAt: now.toISOString()
          } as Prisma.InputJsonValue
        }
      });

      return {
        ...policyDto(updated, true, env),
        changed: true,
        revokedExecutionTokenCount
      };
    });
  }

  async function resolveRunIdempotencyReplay(userId: string, applicationId: string, idempotencyKey: string) {
    const replay = await prismaClient.applicationRun.findUnique({
      where: { userId_idempotencyKey: { userId, idempotencyKey } },
      select: APPLICATION_RUN_OPERATIONAL_SELECT
    });
    if (replay) {
      if (replay.applicationId !== applicationId) {
        throw new PublicApiError("This idempotency key is already bound to another application.", 409, {
          code: "IDEMPOTENCY_KEY_REUSED"
        });
      }
      return { run: toApplicationRunDto(replay), replayed: true as const };
    }

    return null;
  }

  async function assertNoActiveApplicationRun(applicationId: string) {
    const active = await prismaClient.applicationRun.findUnique({
      where: { activeRunKey: applicationId },
      select: APPLICATION_RUN_OPERATIONAL_SELECT
    });
    if (active) {
      throw new PublicApiError("This application already has an active application run.", 409, {
        code: "APPLICATION_RUN_ACTIVE"
      });
    }
  }

  async function createApplicationRun(
    userId: string,
    unvalidatedInput: unknown
  ): Promise<{ run: ApplicationRunDto; replayed: boolean }> {
    validateUserId(userId);
    const input = createApplicationRunBodySchema.parse(unvalidatedInput);
    const application = await prismaClient.application.findFirst({
      where: { id: input.applicationId, userId },
      select: {
        id: true,
        userId: true,
        jobPostingId: true,
        jobPosting: {
          select: { id: true, userId: true, applyUrl: true, sourceUrl: true }
        }
      }
    });
    if (
      !application ||
      application.userId !== userId ||
      application.jobPosting.userId !== userId ||
      application.jobPosting.id !== application.jobPostingId
    ) {
      throw applicationNotFound();
    }

    const replay = await resolveRunIdempotencyReplay(userId, application.id, input.idempotencyKey);
    if (replay) return replay;

    const target = parseExecutionTargetUrl(application.jobPosting.applyUrl ?? application.jobPosting.sourceUrl);
    if (!target) {
      throw new PublicApiError("This application does not have a safe HTTPS application target.", 422, {
        code: "RUN_TARGET_INVALID"
      });
    }

    await assertNoActiveApplicationRun(application.id);

    try {
      const run = await prismaClient.$transaction(async (tx) => {
        const created = await tx.applicationRun.create({
          data: {
            userId,
            applicationId: application.id,
            jobPostingId: application.jobPostingId,
            state: "DRAFT",
            idempotencyKey: input.idempotencyKey,
            activeRunKey: application.id,
            applyUrlSnapshot: target.url.toString(),
            applyHost: target.host
          },
          select: APPLICATION_RUN_OPERATIONAL_SELECT
        });
        await tx.applicationEvent.create({
          data: {
            userId,
            applicationId: application.id,
            type: "APPLICATION_RUN_EVENT",
            title: "Application run created",
            metadata: { runId: created.id, state: created.state }
          }
        });
        await tx.auditLog.create({
          data: {
            userId,
            action: "application-run.create",
            resource: "ApplicationRun",
            resourceId: created.id,
            metadata: {
              applicationId: application.id,
              jobPostingId: application.jobPostingId,
              state: created.state,
              applyHost: created.applyHost
            }
          }
        });
        return created;
      });
      return { run: toApplicationRunDto(run), replayed: false };
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      const raced = await resolveRunIdempotencyReplay(userId, application.id, input.idempotencyKey);
      if (raced) return raced;
      await assertNoActiveApplicationRun(application.id);
      throw new PublicApiError("This application run could not be created because of a concurrent request.", 409, {
        code: "APPLICATION_RUN_CONFLICT"
      });
    }
  }

  async function getApplicationRun(userId: string, unvalidatedRunId: unknown): Promise<ApplicationRunDto> {
    validateUserId(userId);
    const { id } = applicationRunPathSchema.parse({ id: unvalidatedRunId });
    const run = await prismaClient.applicationRun.findFirst({
      where: { id, userId },
      select: APPLICATION_RUN_OPERATIONAL_SELECT
    });
    if (!run) throw runNotFound();
    return toApplicationRunDto(run);
  }

  async function lockOwnedApplicationRun(
    tx: Prisma.TransactionClient,
    userId: string,
    runId: string
  ): Promise<Prisma.ApplicationRunGetPayload<{ select: typeof APPLICATION_RUN_LIFECYCLE_SELECT }>> {
    const lockedRows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "ApplicationRun"
      WHERE "id" = ${runId} AND "userId" = ${userId}
      FOR UPDATE
    `;
    if (lockedRows.length !== 1) throw runNotFound();

    const run = await tx.applicationRun.findFirst({
      where: { id: runId, userId },
      select: APPLICATION_RUN_LIFECYCLE_SELECT
    });
    if (
      !run ||
      run.userId !== userId ||
      run.application.userId !== userId ||
      run.jobPosting.userId !== userId ||
      run.application.id !== run.applicationId ||
      run.jobPosting.id !== run.jobPostingId ||
      run.application.jobPostingId !== run.jobPostingId
    ) {
      throw runNotFound();
    }
    return run;
  }

  async function cancelApplicationRun(input: { userId: unknown; runId: unknown }) {
    validateUserId(input?.userId);
    const userId = input.userId;
    const { id: runId } = applicationRunPathSchema.parse({ id: input?.runId });

    return prismaClient.$transaction(async (tx) => {
      const run = await lockOwnedApplicationRun(tx, userId, runId);
      assertRunTransition(run.state, "CANCELLED");
      const now = resolveNow(clock);
      const updated = await tx.applicationRun.updateMany({
        where: {
          id: run.id,
          userId,
          state: run.state,
          stateVersion: run.stateVersion,
          prepareAttemptId: run.prepareAttemptId
        },
        data: buildCancelRunData(now)
      });
      if (updated.count !== 1) throw staleRunLifecycle();

      const revokedExecutionTokenCount = await revokeUsableExecutionTokensForRunInTransaction(tx, {
        userId,
        runId,
        now,
        reason: "run_cancelled"
      });
      await tx.auditLog.create({
        data: {
          userId,
          action: "application-run.cancel",
          resource: "ApplicationRun",
          resourceId: run.id,
          metadata: {
            runId: run.id,
            previousState: run.state,
            nextState: "CANCELLED",
            previousStateVersion: run.stateVersion,
            nextStateVersion: run.stateVersion + 1,
            revokedExecutionTokenCount,
            cancelledAt: now.toISOString()
          } as Prisma.InputJsonValue
        }
      });
      await tx.applicationEvent.create({
        data: {
          userId,
          applicationId: run.applicationId,
          type: "APPLICATION_RUN_EVENT",
          title: "Application run cancelled",
          metadata: {
            runId: run.id,
            previousState: run.state,
            nextState: "CANCELLED",
            previousStateVersion: run.stateVersion,
            nextStateVersion: run.stateVersion + 1,
            revokedExecutionTokenCount
          }
        }
      });
      const cancelled = await tx.applicationRun.findFirst({
        where: { id: run.id, userId },
        select: APPLICATION_RUN_OPERATIONAL_SELECT
      });
      if (!cancelled) throw staleRunLifecycle();
      return { run: toApplicationRunDto(cancelled), revokedExecutionTokenCount };
    });
  }

  async function resolveApplicationRunReview(input: {
    userId: unknown;
    runId: unknown;
    stateVersion: unknown;
    acknowledgedReviewReasons: unknown;
    answerPacketVersion?: unknown;
    packetHash?: unknown;
  }): Promise<ApplicationRunDto> {
    validateUserId(input?.userId);
    const userId = input.userId;
    const { id: runId } = applicationRunPathSchema.parse({ id: input?.runId });
    const acknowledgment = resolveApplicationRunReviewBodySchema.parse({
      stateVersion: input?.stateVersion,
      acknowledgedReviewReasons: input?.acknowledgedReviewReasons,
      answerPacketVersion: input?.answerPacketVersion,
      packetHash: input?.packetHash
    });

    return prismaClient.$transaction(async (tx) => {
      const run = await lockOwnedApplicationRun(tx, userId, runId);
      if (run.state !== "REVIEW_REQUIRED") {
        throw new PublicApiError("This application run is not awaiting review.", 409, {
          code: "RUN_INVALID_STATE"
        });
      }
      if (run.fillLeaseExpiresAt !== null) {
        throw new PublicApiError("This application run has contradictory Fill state.", 409, {
          code: "RUN_INVALID_STATE"
        });
      }
      const targetState = run.fillAttemptId === null ? "READY" : "READY_FOR_USER_SUBMISSION";
      assertTransition(run.state, targetState);
      if (run.stateVersion !== acknowledgment.stateVersion) {
        throw new PublicApiError("The application run review has changed. Refresh and try again.", 409, {
          code: "RUN_REVIEW_STALE"
        });
      }
      const persistedReasonsAreValid = run.reviewReasons.every((reason) =>
        PLAN_REVIEW_REASONS.includes(reason as PlanReviewReason)
      );
      const reasonsMatch =
        persistedReasonsAreValid &&
        run.reviewReasons.length === acknowledgment.acknowledgedReviewReasons.length &&
        run.reviewReasons.every((reason, index) => reason === acknowledgment.acknowledgedReviewReasons[index]);
      if (!reasonsMatch) {
        throw new PublicApiError("The current application run review reasons were not acknowledged exactly.", 409, {
          code: "RUN_REVIEW_REASONS_MISMATCH"
        });
      }

      if (acknowledgment.answerPacketVersion !== run.currentAnswerPacketVersion) {
        throw packetStale();
      }

      let now: Date;
      if (acknowledgment.answerPacketVersion === 0) {
        if (run.currentFormInspectionVersion !== 0 || run.currentAnswerPacketVersion !== 0) {
          throw packetInvalid();
        }
        now = resolveNow(clock);
      } else {
        const storedPacket = await tx.applicationRunAnswerPacket.findUnique({
          where: {
            runId_version: {
              runId: run.id,
              version: run.currentAnswerPacketVersion
            }
          }
        });
        if (
          !storedPacket ||
          storedPacket.runId !== run.id ||
          storedPacket.userId !== userId ||
          storedPacket.version !== run.currentAnswerPacketVersion ||
          !/^[a-f0-9]{64}$/.test(storedPacket.packetHash)
        ) {
          throw packetInvalid();
        }
        if (acknowledgment.packetHash !== storedPacket.packetHash) {
          throw packetStale();
        }

        const verified = await loadVerifiedCurrentPacket(tx, {
          userId,
          run: run as LockedAnswerPacketRun
        });
        if (!verified || verified.packetRecord.id !== storedPacket.id) {
          throw packetInvalid();
        }
        if (verified.packetRecord.reviewedAt !== null) {
          throw packetInvalid();
        }
        if (!verified.summary.readyForRunResolution) {
          throw packetReviewIncomplete();
        }

        const databaseTimes = await tx.$queryRaw<Array<{ now: Date }>>`
          SELECT CURRENT_TIMESTAMP AS "now"
        `;
        if (
          databaseTimes.length !== 1 ||
          !(databaseTimes[0].now instanceof Date) ||
          !Number.isFinite(databaseTimes[0].now.getTime())
        ) {
          throw new PublicApiError("The request could not be completed.", 500);
        }
        now = databaseTimes[0].now;
        const acknowledgedPacket = await tx.applicationRunAnswerPacket.updateMany({
          where: {
            id: verified.packetRecord.id,
            runId: run.id,
            userId,
            version: acknowledgment.answerPacketVersion,
            reviewedAt: null
          },
          data: { reviewedAt: now }
        });
        if (acknowledgedPacket.count !== 1) throw packetInvalid();
      }

      const acknowledgePlannerReview =
        run.reviewReasons.length > 0 && run.reviewAcknowledgedAt === null;
      const updated = await tx.applicationRun.updateMany({
        where: {
          id: run.id,
          userId,
          state: "REVIEW_REQUIRED",
          stateVersion: acknowledgment.stateVersion,
          currentFormInspectionVersion: run.currentFormInspectionVersion,
          currentAnswerPacketVersion: run.currentAnswerPacketVersion,
          fillAttemptId: run.fillAttemptId,
          fillLeaseExpiresAt: null
        },
        data: buildResolveRunReviewData(now, {
          acknowledgePlannerReview,
          fillAttemptId: run.fillAttemptId
        })
      });
      if (updated.count !== 1) {
        throw new PublicApiError("The application run review has changed. Refresh and try again.", 409, {
          code: "RUN_REVIEW_STALE"
        });
      }
      await tx.auditLog.create({
        data: {
          userId,
          action: "application-run.review.resolve",
          resource: "ApplicationRun",
          resourceId: run.id,
          metadata: {
            runId: run.id,
            reviewReasons: acknowledgment.acknowledgedReviewReasons,
            answerPacketVersion: acknowledgment.answerPacketVersion,
            ...(targetState === "READY_FOR_USER_SUBMISSION" ? { nextState: targetState } : {}),
            previousStateVersion: run.stateVersion,
            nextStateVersion: run.stateVersion + 1,
            acknowledgedAt: now.toISOString()
          } as Prisma.InputJsonValue
        }
      });
      await tx.applicationEvent.create({
        data: {
          userId,
          applicationId: run.applicationId,
          type: "APPLICATION_RUN_EVENT",
          title: "Application run review resolved",
          metadata: {
            runId: run.id,
            reviewReasons: acknowledgment.acknowledgedReviewReasons,
            ...(targetState === "READY_FOR_USER_SUBMISSION" ? { nextState: targetState } : {}),
            previousStateVersion: run.stateVersion,
            nextStateVersion: run.stateVersion + 1
          }
        }
      });
      const resolved = await tx.applicationRun.findFirst({
        where: { id: run.id, userId },
        select: APPLICATION_RUN_OPERATIONAL_SELECT
      });
      if (!resolved) throw staleRunLifecycle();
      return toApplicationRunDto(resolved);
    });
  }

  async function reviewApplicationRunAnswer(input: {
    userId: unknown;
    runId: unknown;
    answerId: unknown;
    status: unknown;
    answerPacketVersion?: unknown;
  }): Promise<ApplicationRunAnswerDto> {
    validateUserId(input?.userId);
    const userId = input.userId;
    const { id: runId, answerId } = applicationRunAnswerPathSchema.parse({
      id: input?.runId,
      answerId: input?.answerId
    });
    const review = reviewApplicationRunAnswerBodySchema.parse({
      status: input?.status,
      answerPacketVersion: input?.answerPacketVersion
    });

    return prismaClient.$transaction(async (tx) => {
      const run = await lockOwnedApplicationRun(tx, userId, runId);
      if (run.state !== "READY" && run.state !== "REVIEW_REQUIRED") {
        throw new PublicApiError("Answers cannot be reviewed in this application run state.", 409, {
          code: "RUN_INVALID_STATE"
        });
      }

      if (review.answerPacketVersion !== run.currentAnswerPacketVersion) {
        throw packetStale();
      }

      let currentPacketId: string | null = null;
      let verifiedPacket: Awaited<ReturnType<typeof loadVerifiedCurrentPacket>> = null;
      if (review.answerPacketVersion === 0) {
        if (run.currentFormInspectionVersion !== 0 || run.currentAnswerPacketVersion !== 0) {
          throw packetInvalid();
        }
        const lockedAnswers = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM "ApplicationRunAnswer"
          WHERE "id" = ${answerId}
            AND "runId" = ${runId}
            AND "userId" = ${userId}
            AND "answerPacketId" IS NULL
          FOR UPDATE
        `;
        if (lockedAnswers.length !== 1) throw answerNotFound();
      } else {
        verifiedPacket = await loadVerifiedCurrentPacket(tx, {
          userId,
          run: run as LockedAnswerPacketRun
        });
        if (!verifiedPacket) throw packetInvalid();
        currentPacketId = verifiedPacket.packetRecord.id;
        const lockedAnswers = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM "ApplicationRunAnswer"
          WHERE "id" = ${answerId}
            AND "runId" = ${runId}
            AND "userId" = ${userId}
            AND "answerPacketId" = ${currentPacketId}
          FOR UPDATE
        `;
        if (lockedAnswers.length !== 1) throw answerNotFound();
      }

      const answer = await tx.applicationRunAnswer.findFirst({
        where: { id: answerId, runId, userId, answerPacketId: currentPacketId },
        select: APPLICATION_RUN_ANSWER_REVIEW_SELECT
      });
      if (
        !answer ||
        answer.runId !== run.id ||
        answer.userId !== userId ||
        answer.answerPacketId !== currentPacketId
      ) {
        throw answerNotFound();
      }
      if (answer.status !== "PENDING") {
        throw new PublicApiError("This application run answer has already been reviewed.", 409, {
          code: "RUN_ANSWER_ALREADY_REVIEWED"
        });
      }

      let finalValueHash: string | null = null;
      let reviewHashVersion: "LEGACY_SCALAR_SHA256" | "CANONICAL_PROPOSAL_V1" | null = null;
      if (review.answerPacketVersion > 0) {
        const frozenField = verifiedPacket?.fieldsByKey.get(answer.normalizedFieldKey);
        if (
          !frozenField ||
          answer.disposition !== "PROPOSABLE" ||
          answer.proposal === null ||
          answer.sensitive ||
          answer.valueRedacted ||
          answer.fieldFingerprint === null ||
          answer.fieldType === null
        ) {
          throw answerNotApprovable();
        }
        let proposal;
        try {
          proposal = parseCompatibleApplicationAnswerProposal(answer.proposal, {
            expectedField: {
              normalizedFieldKey: answer.normalizedFieldKey,
              fieldFingerprint: answer.fieldFingerprint,
              fieldType: answer.fieldType,
              semanticFieldKey: answer.semanticFieldKey
            },
            frozenField: {
              normalizedFieldKey: frozenField.normalizedFieldKey,
              fieldFingerprint: frozenField.fieldFingerprint,
              fieldType: frozenField.fieldType,
              semanticFieldKey: frozenField.semanticFieldKey,
              choices: frozenField.choices.map((choice) => ({
                key: choice.key,
                disabled: choice.disabled
              }))
            }
          });
        } catch {
          throw answerNotApprovable();
        }
        if (review.status === "APPROVED") {
          finalValueHash = computeApplicationAnswerProposalHash(proposal);
          reviewHashVersion = "CANONICAL_PROPOSAL_V1";
        }
      } else if (review.status === "APPROVED") {
        if (answer.sensitive || answer.valueRedacted || answer.proposedValue === null) {
          throw answerNotApprovable();
        }
        finalValueHash = createHash("sha256").update(answer.proposedValue, "utf8").digest("hex");
        reviewHashVersion = "LEGACY_SCALAR_SHA256";
      }

      const now = resolveNow(clock);
      const updated = await tx.applicationRunAnswer.updateMany({
        where: {
          id: answer.id,
          runId,
          userId,
          answerPacketId: currentPacketId,
          status: "PENDING"
        },
        data: {
          status: review.status,
          reviewedByUser: true,
          reviewedAt: now,
          finalValueHash,
          reviewHashVersion
        }
      });
      if (updated.count !== 1) {
        throw new PublicApiError("This application run answer has already been reviewed.", 409, {
          code: "RUN_ANSWER_ALREADY_REVIEWED"
        });
      }
      await tx.auditLog.create({
        data: {
          userId,
          action: "application-run-answer.review",
          resource: "ApplicationRunAnswer",
          resourceId: answer.id,
          metadata: {
            runId,
            answerId: answer.id,
            answerPacketVersion: review.answerPacketVersion,
            normalizedFieldKey: answer.normalizedFieldKey,
            status: review.status,
            reviewedAt: now.toISOString()
          } as Prisma.InputJsonValue
        }
      });
      const reviewed = await tx.applicationRunAnswer.findFirst({
        where: { id: answer.id, runId, userId },
        select: APPLICATION_RUN_ANSWER_DTO_SELECT
      });
      if (!reviewed) throw answerNotFound();
      return toApplicationRunAnswerDto(reviewed);
    });
  }

  return {
    readAutomationPolicy,
    updateAutomationPolicy,
    createApplicationRun,
    getApplicationRun,
    cancelApplicationRun,
    resolveApplicationRunReview,
    reviewApplicationRunAnswer
  };
}

const defaultApplicationRunService = createApplicationRunService();

export const readAutomationPolicy = defaultApplicationRunService.readAutomationPolicy;
export const updateAutomationPolicy = defaultApplicationRunService.updateAutomationPolicy;
export const createApplicationRun = defaultApplicationRunService.createApplicationRun;
export const getApplicationRun = defaultApplicationRunService.getApplicationRun;
export const cancelApplicationRun = defaultApplicationRunService.cancelApplicationRun;
export const resolveApplicationRunReview = defaultApplicationRunService.resolveApplicationRunReview;
export const reviewApplicationRunAnswer = defaultApplicationRunService.reviewApplicationRunAnswer;
