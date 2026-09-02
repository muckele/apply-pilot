import { randomUUID } from "node:crypto";

import { Prisma, type ApplicationRunState } from "@prisma/client";
import { z } from "zod";

import { PublicApiError } from "@/lib/api-errors";
import {
  computeApplicationAnswerProposalHash,
  parseCompatibleApplicationAnswerProposal,
  type ApplicationAnswerProposal
} from "@/lib/application-runs/answer-packet-domain";
import {
  loadVerifiedCurrentAnswerPacketForLockedRunInTransaction,
  type ApplicationRunAnswerPacketTransaction,
  type LockedAnswerPacketRun,
  type VerifiedCurrentAnswerPacket
} from "@/lib/application-runs/answer-packet-service";
import {
  deriveTerminalFillAttemptOutcome,
  FILL_ERROR_CODES,
  FILL_LEASE_MS,
  FILL_STEP_RESULTS,
  projectVerifiedFillCandidates,
  reconcileFillFinalization,
  STOPPED_EARLY_FILL_ERRORS,
  type FillErrorCode,
  type FillStepResult,
  type VerifiedFillCandidate
} from "@/lib/application-runs/fill-attempt-domain";
import { MAX_FIELDS_TOTAL } from "@/lib/application-runs/form-inspection";
import { isHostAllowedForExecution, parseExecutionTargetUrl } from "@/lib/application-runs/host-policy";
import { isApplicationAutomationEnabled, type AutomationEnv } from "@/lib/application-runs/policy";
import {
  assertRunTransition,
  buildAcquireRunFillData,
  buildFinalizeRunFillData,
  buildRecoverExpiredRunFillData
} from "@/lib/application-runs/state-machine";
import { prisma } from "@/lib/prisma";

const serviceUserIdSchema = z.string().trim().min(1).max(128);
const serviceRunIdSchema = z.string().cuid();
const acquireInputSchema = z.object({
  userId: serviceUserIdSchema,
  runId: serviceRunIdSchema,
  expectedStateVersion: z.number().int().safe().nonnegative()
}).strict();
const statusInputSchema = z.object({ userId: serviceUserIdSchema, runId: serviceRunIdSchema }).strict();
const attemptIdSchema = z.string().uuid();
const nonnegativeSafeVersionSchema = z.number().int().safe().nonnegative();
const fillStepKeySchema = z.string().min(1).max(160).superRefine((value, context) => {
  const [prefix, attemptId, normalizedFieldKey, ...rest] = value.split(":");
  if (
    prefix !== "fill" ||
    rest.length > 0 ||
    !attemptIdSchema.safeParse(attemptId).success ||
    !/^[a-f0-9]{64}$/.test(normalizedFieldKey ?? "")
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Fill step keys must bind one UUID attempt to one canonical field key."
    });
  }
});
const finalizeInputSchema = z.object({
  userId: serviceUserIdSchema,
  runId: serviceRunIdSchema,
  fillAttemptId: attemptIdSchema,
  expectedStateVersion: nonnegativeSafeVersionSchema,
  outcome: z.enum(["COMPLETED", "STOPPED_EARLY"]),
  errorCode: z.enum(STOPPED_EARLY_FILL_ERRORS).nullable(),
  steps: z.array(z.object({
    stepKey: fillStepKeySchema,
    result: z.enum(FILL_STEP_RESULTS),
    errorCode: z.enum(FILL_ERROR_CODES).nullable()
  }).strict()).min(1).max(MAX_FIELDS_TOTAL)
}).strict().superRefine((value, context) => {
  if (
    (value.outcome === "COMPLETED" && value.errorCode !== null) ||
    (value.outcome === "STOPPED_EARLY" && value.errorCode === null)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["errorCode"],
      message: "Fill finalization outcome and error must agree."
    });
  }
  const stepKeys = value.steps.map((step) => step.stepKey);
  if (new Set(stepKeys).size !== stepKeys.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["steps"],
      message: "Fill finalization step keys must not contain duplicates."
    });
  }
  const expectedPrefix = `fill:${value.fillAttemptId}:`;
  value.steps.forEach((step, index) => {
    if (!step.stepKey.startsWith(expectedPrefix)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["steps", index, "stepKey"],
        message: "Fill finalization steps must belong to the asserted attempt."
      });
    }
  });
});
const recoverInputSchema = z.object({
  userId: serviceUserIdSchema,
  runId: serviceRunIdSchema,
  fillAttemptId: attemptIdSchema,
  expectedStateVersion: nonnegativeSafeVersionSchema
}).strict();
const FIELD_KEY_PATTERN = /^[a-f0-9]{64}$/;
const CLOSED_FILL_ERRORS = new Set<string>(FILL_ERROR_CODES);

type ApplicationRunFillAttemptPrismaClient = Pick<typeof prisma, "$transaction">;

export type ApplicationRunFillAttemptServiceDependencies = {
  prismaClient?: ApplicationRunFillAttemptPrismaClient;
  env?: AutomationEnv;
  attemptIdGenerator?: () => string;
  assertTransition?: typeof assertRunTransition;
  loadVerifiedCurrentAnswerPacketForLockedRunInTransaction?:
    typeof loadVerifiedCurrentAnswerPacketForLockedRunInTransaction;
};

type FillPolicy = {
  id: string;
  userId: string;
  enabled: boolean;
  mode: "PREPARE_ONLY" | "FILL_AND_REVIEW";
  allowedHosts: string[];
  blockedHosts: string[];
  sensitiveAnswerPolicy: "EXCLUDE";
  finalReviewRequired: boolean;
};

type FillRun = LockedAnswerPacketRun & {
  fillAttemptId: string | null;
  fillLeaseExpiresAt: Date | null;
  errorCategory: string | null;
};

type StoredFillStep = {
  stepKey: string;
  sequence: number;
  action: string;
  semanticFieldKey: string | null;
  adapter: string | null;
  status: string;
  attemptNumber: number;
  redactedValueSummary: string | null;
  errorCategory: string | null;
  artifactReference: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
};

function fillError(code: FillErrorCode, status: number, message: string): PublicApiError {
  return new PublicApiError(message, status, { code });
}

function policyDenied(): PublicApiError {
  return fillError("FILL_POLICY_DENIED", 403, "Fill is not allowed by the current automation policy.");
}

function reviewRequired(): PublicApiError {
  return fillError("FILL_REVIEW_REQUIRED", 409, "Current reviewed Fill authority is required.");
}

function alreadyInProgress(): PublicApiError {
  return fillError("FILL_ALREADY_IN_PROGRESS", 409, "This application run has already consumed its Fill attempt.");
}

function noEligibleFields(): PublicApiError {
  return fillError("FILL_NO_ELIGIBLE_FIELDS", 409, "The reviewed packet has no eligible Fill fields.");
}

function fillStale(): PublicApiError {
  return fillError("FILL_STALE", 409, "The application run changed before Fill acquisition completed.");
}

function fillInternal(status = 500): PublicApiError {
  return fillError("FILL_INTERNAL", status, "Fill status is unavailable.");
}

function isClosedFillError(error: unknown): error is PublicApiError {
  return error instanceof PublicApiError &&
    typeof error.details?.code === "string" &&
    CLOSED_FILL_ERRORS.has(error.details.code);
}

function sanitizeFillFailure(error: unknown): never {
  if (isClosedFillError(error)) throw error;
  throw fillInternal();
}

function policyAllowsFill(policy: FillPolicy | null, env: AutomationEnv, run: FillRun): boolean {
  if (
    !isApplicationAutomationEnabled(env) ||
    policy === null ||
    policy.userId !== run.userId ||
    !policy.enabled ||
    policy.mode !== "FILL_AND_REVIEW" ||
    policy.sensitiveAnswerPolicy !== "EXCLUDE" ||
    policy.finalReviewRequired !== true
  ) {
    return false;
  }
  const target = parseExecutionTargetUrl(run.applyUrlSnapshot);
  return target !== null && target.host === run.applyHost &&
    isHostAllowedForExecution(target.host, policy);
}

async function readDatabaseClock(tx: ApplicationRunAnswerPacketTransaction): Promise<Date> {
  const rows = await tx.$queryRaw<Array<{ now: Date }>>`
    SELECT clock_timestamp() AS "now"
  `;
  const now = rows.length === 1 ? rows[0]?.now : null;
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw fillInternal();
  return now;
}

async function lockPolicy(
  tx: ApplicationRunAnswerPacketTransaction,
  userId: string
): Promise<FillPolicy> {
  const locked = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "ApplicationAutomationPolicy"
    WHERE "userId" = ${userId}
    FOR UPDATE
  `;
  if (locked.length !== 1) throw policyDenied();
  const policy = await tx.applicationAutomationPolicy.findUnique({
    where: { userId },
    select: {
      id: true,
      userId: true,
      enabled: true,
      mode: true,
      allowedHosts: true,
      blockedHosts: true,
      sensitiveAnswerPolicy: true,
      finalReviewRequired: true
    }
  });
  if (!policy || policy.id !== locked[0].id) throw policyDenied();
  return policy as FillPolicy;
}

const RUN_INCLUDE = {
  application: { select: { id: true, userId: true, jobPostingId: true } },
  jobPosting: { select: { id: true, userId: true } }
} as const;

function assertOwnedRelationships(run: FillRun, userId: string): void {
  if (
    run.userId !== userId ||
    run.application.id !== run.applicationId ||
    run.application.userId !== userId ||
    run.application.jobPostingId !== run.jobPostingId ||
    run.jobPosting.id !== run.jobPostingId ||
    run.jobPosting.userId !== userId
  ) {
    throw fillInternal(404);
  }
}

async function lockOwnedRun(
  tx: ApplicationRunAnswerPacketTransaction,
  userId: string,
  runId: string
): Promise<FillRun> {
  const locked = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "ApplicationRun"
    WHERE "id" = ${runId} AND "userId" = ${userId}
    FOR UPDATE
  `;
  if (locked.length !== 1) throw fillInternal(404);
  const run = await tx.applicationRun.findFirst({
    where: { id: runId, userId },
    include: RUN_INCLUDE
  });
  if (!run || run.id !== locked[0].id) throw fillInternal(404);
  assertOwnedRelationships(run as FillRun, userId);
  return run as FillRun;
}

async function readOwnedRun(
  tx: ApplicationRunAnswerPacketTransaction,
  userId: string,
  runId: string
): Promise<FillRun> {
  const run = await tx.applicationRun.findFirst({
    where: { id: runId, userId },
    include: RUN_INCLUDE
  });
  if (!run) throw fillInternal(404);
  assertOwnedRelationships(run as FillRun, userId);
  return run as FillRun;
}

function assertAcquisitionRunFence(run: FillRun, expectedStateVersion: number): void {
  if (run.state === "FILLING" || run.fillAttemptId !== null) throw alreadyInProgress();
  if (run.state === "REVIEW_REQUIRED") throw reviewRequired();
  if (run.stateVersion !== expectedStateVersion) throw fillStale();
  if (run.state !== "READY") throw fillInternal();
  if (run.fillLeaseExpiresAt !== null) throw fillInternal();
  if (run.currentFormInspectionVersion <= 0 || run.currentAnswerPacketVersion <= 0) {
    throw reviewRequired();
  }
}

function classifyVerifiedPacketFailure(error: unknown): never {
  if (error instanceof PublicApiError) {
    const code = error.details?.code;
    if (code === "RUN_INSPECTION_STALE" || code === "RUN_TARGET_STALE" || code === "RUN_PACKET_STALE") {
      throw fillStale();
    }
    if (code === "RUN_PACKET_REVIEW_INCOMPLETE") throw reviewRequired();
  }
  throw fillInternal();
}

function eligibleCandidates(
  run: FillRun,
  verified: VerifiedCurrentAnswerPacket
): ReturnType<typeof projectVerifiedFillCandidates> {
  if (
    verified.inspection.runId !== run.id ||
    verified.inspection.userId !== run.userId ||
    verified.inspection.version !== run.currentFormInspectionVersion ||
    verified.packetRecord.runId !== run.id ||
    verified.packetRecord.userId !== run.userId ||
    verified.packetRecord.version !== run.currentAnswerPacketVersion ||
    verified.packetRecord.formInspectionId !== verified.inspection.id ||
    verified.packet.inspectionVersion !== verified.inspection.version ||
    verified.packet.formFingerprint !== verified.inspection.formFingerprint
  ) {
    throw fillStale();
  }
  if (verified.packetRecord.reviewedAt === null || !verified.summary.readyForRunResolution) {
    throw reviewRequired();
  }

  const rowsByKey = new Map(verified.answerRows.map((row) => [row.normalizedFieldKey, row]));
  if (rowsByKey.size !== verified.answerRows.length) throw fillInternal();

  const candidates: VerifiedFillCandidate[] = verified.packet.answers.map((answer) => {
    const row = rowsByKey.get(answer.normalizedFieldKey);
    const field = verified.fieldsByKey.get(answer.normalizedFieldKey);
    if (!row || !field) throw fillInternal();
    if (answer.disposition !== "PROPOSABLE" || answer.proposal === null || row.status === "REJECTED") {
      return {
        normalizedFieldKey: answer.normalizedFieldKey,
        fieldFingerprint: answer.fieldFingerprint,
        fieldType: answer.fieldType,
        proposal: null
      };
    }
    if (row.status !== "APPROVED" || !row.reviewedByUser || row.reviewedAt === null) {
      throw reviewRequired();
    }
    if (
      row.runId !== run.id ||
      row.userId !== run.userId ||
      row.answerPacketId !== verified.packetRecord.id ||
      row.normalizedFieldKey !== answer.normalizedFieldKey ||
      row.fieldFingerprint !== answer.fieldFingerprint ||
      row.fieldType !== answer.fieldType ||
      row.semanticFieldKey !== answer.semanticFieldKey ||
      row.disposition !== "PROPOSABLE" ||
      row.proposal === null ||
      row.sensitive ||
      row.valueRedacted ||
      answer.sensitive ||
      answer.valueRedacted ||
      field.normalizedFieldKey !== answer.normalizedFieldKey ||
      field.fieldFingerprint !== answer.fieldFingerprint ||
      field.fieldType !== answer.fieldType ||
      field.semanticFieldKey !== answer.semanticFieldKey ||
      row.reviewHashVersion !== "CANONICAL_PROPOSAL_V1" ||
      row.finalValueHash === null
    ) {
      throw fillInternal();
    }

    let proposal: ApplicationAnswerProposal;
    try {
      proposal = parseCompatibleApplicationAnswerProposal(answer.proposal, {
        expectedField: {
          normalizedFieldKey: answer.normalizedFieldKey,
          fieldFingerprint: answer.fieldFingerprint,
          fieldType: answer.fieldType,
          semanticFieldKey: answer.semanticFieldKey
        },
        frozenField: {
          normalizedFieldKey: field.normalizedFieldKey,
          fieldFingerprint: field.fieldFingerprint,
          fieldType: field.fieldType,
          semanticFieldKey: field.semanticFieldKey,
          choices: field.choices.map((choice) => ({ key: choice.key, disabled: choice.disabled }))
        }
      });
    } catch {
      throw fillInternal();
    }
    if (
      computeApplicationAnswerProposalHash(proposal) !== row.finalValueHash ||
      computeApplicationAnswerProposalHash(row.proposal) !== row.finalValueHash
    ) {
      throw fillInternal();
    }
    return {
      normalizedFieldKey: answer.normalizedFieldKey,
      fieldFingerprint: answer.fieldFingerprint,
      fieldType: answer.fieldType,
      proposal
    };
  });
  return projectVerifiedFillCandidates(candidates);
}

function validTerminalSteps(fillAttemptId: string, steps: readonly StoredFillStep[]): boolean {
  const prefix = `fill:${fillAttemptId}:`;
  const keys = new Set<string>();
  const sequences = new Set<number>();
  return steps.length > 0 && steps.every((step, index) => {
    const suffix = step.stepKey.startsWith(prefix) ? step.stepKey.slice(prefix.length) : "";
    const valid =
      step.action === "FILL_FIELD" &&
      step.attemptNumber === 1 &&
      step.sequence === index &&
      Number.isInteger(step.sequence) &&
      !keys.has(step.stepKey) &&
      !sequences.has(step.sequence) &&
      FIELD_KEY_PATTERN.test(suffix) &&
      step.semanticFieldKey === null &&
      step.adapter === null &&
      step.artifactReference === null;
    keys.add(step.stepKey);
    sequences.add(step.sequence);
    return valid;
  });
}

async function lockAttemptSteps(
  tx: ApplicationRunAnswerPacketTransaction,
  input: { userId: string; runId: string; fillAttemptId: string }
): Promise<StoredFillStep[]> {
  return tx.$queryRaw<StoredFillStep[]>`
    SELECT
      "stepKey", "sequence", "action", "semanticFieldKey", "adapter", "status",
      "attemptNumber", "redactedValueSummary", "errorCategory", "artifactReference",
      "startedAt", "completedAt"
    FROM "ApplicationRunStep"
    WHERE "runId" = ${input.runId}
      AND "userId" = ${input.userId}
      AND "stepKey" LIKE ${`fill:${input.fillAttemptId}:%`}
    ORDER BY "sequence" ASC
    FOR UPDATE
  `;
}

function isOptionalFiniteDate(value: unknown): value is Date | null {
  return value === null || (value instanceof Date && Number.isFinite(value.getTime()));
}

function assertActiveMutationFence(
  run: FillRun,
  input: { fillAttemptId: string; expectedStateVersion: number }
): Date {
  if (run.state !== "FILLING") throw fillStale();
  if (!attemptIdSchema.safeParse(run.fillAttemptId).success) throw fillInternal();
  if (run.fillAttemptId !== input.fillAttemptId || run.stateVersion !== input.expectedStateVersion) {
    throw fillStale();
  }
  if (
    !(run.fillLeaseExpiresAt instanceof Date) ||
    !Number.isFinite(run.fillLeaseExpiresAt.getTime())
  ) {
    throw fillInternal();
  }
  return run.fillLeaseExpiresAt;
}

function assertUnfinalizedSteps(fillAttemptId: string, steps: readonly StoredFillStep[]): void {
  if (
    !validTerminalSteps(fillAttemptId, steps) ||
    steps.some((step) =>
      step.status !== "PENDING" ||
      step.redactedValueSummary !== null ||
      step.errorCategory !== null ||
      step.completedAt !== null ||
      !isOptionalFiniteDate(step.startedAt)
    )
  ) {
    throw fillInternal();
  }
}

type ProjectedRecoveryStep = {
  source: StoredFillStep;
  status: "SUCCEEDED" | "SKIPPED" | "FAILED";
  redactedValueSummary: FillStepResult;
  errorCategory: FillErrorCode | null;
  recovered: boolean;
};

function projectRecoverySteps(
  fillAttemptId: string,
  steps: readonly StoredFillStep[]
): ProjectedRecoveryStep[] {
  if (!validTerminalSteps(fillAttemptId, steps)) throw fillInternal();
  let unresolvedStarted = false;
  return steps.map((step): ProjectedRecoveryStep => {
    if (!isOptionalFiniteDate(step.startedAt)) throw fillInternal();
    const safeTerminal =
      ((step.status === "SUCCEEDED" && step.redactedValueSummary === "FILLED") ||
        (step.status === "SKIPPED" &&
          (step.redactedValueSummary === "PRESERVED_EXISTING" ||
            step.redactedValueSummary === "MANUAL"))) &&
      step.errorCategory === null &&
      step.completedAt instanceof Date &&
      Number.isFinite(step.completedAt.getTime());
    if (safeTerminal) {
      if (unresolvedStarted) throw fillInternal();
      return {
        source: step,
        status: step.status as "SUCCEEDED" | "SKIPPED",
        redactedValueSummary: step.redactedValueSummary as FillStepResult,
        errorCategory: null,
        recovered: false
      };
    }

    const unresolvedPending =
      step.status === "PENDING" &&
      step.startedAt === null &&
      step.redactedValueSummary === null &&
      step.errorCategory === null &&
      step.completedAt === null;
    const unresolvedRunning =
      step.status === "RUNNING" &&
      step.startedAt instanceof Date &&
      Number.isFinite(step.startedAt.getTime()) &&
      step.redactedValueSummary === null &&
      step.errorCategory === null &&
      step.completedAt === null;
    if (!unresolvedPending && !unresolvedRunning) throw fillInternal();
    unresolvedStarted = true;
    return {
      source: step,
      status: "FAILED",
      redactedValueSummary: "FAILED",
      errorCategory: "FILL_STALE",
      recovered: true
    };
  });
}

function terminalStatus(input: {
  run: FillRun;
  outcome: "COMPLETED" | "STOPPED_EARLY" | "RECOVERED_AFTER_LOSS";
  errorCode: FillErrorCode | null;
  steps: readonly { stepKey: string; result: FillStepResult; errorCode: FillErrorCode | null }[];
}) {
  return {
    state: "READY_FOR_USER_SUBMISSION" as const,
    stateVersion: input.run.stateVersion + 1,
    fillAttemptId: input.run.fillAttemptId as string,
    fillLeaseExpiresAt: null,
    leaseLive: false,
    expiredRecoveryRequired: false,
    fieldOperationAllowed: false,
    outcome: input.outcome,
    errorCode: input.errorCode,
    steps: input.steps
  };
}

function resultCounts(steps: readonly { result: FillStepResult }[]): Record<FillStepResult, number> {
  const counts: Record<FillStepResult, number> = {
    FILLED: 0,
    PRESERVED_EXISTING: 0,
    MANUAL: 0,
    FAILED: 0,
    NOT_ATTEMPTED: 0
  };
  for (const step of steps) counts[step.result] += 1;
  return counts;
}

function baseStatus(run: FillRun) {
  return {
    state: run.state,
    stateVersion: run.stateVersion,
    fillAttemptId: run.fillAttemptId,
    fillLeaseExpiresAt: run.fillLeaseExpiresAt,
    leaseLive: false,
    expiredRecoveryRequired: false,
    fieldOperationAllowed: false,
    outcome: null,
    errorCode: null,
    steps: []
  } as {
    state: ApplicationRunState;
    stateVersion: number;
    fillAttemptId: string | null;
    fillLeaseExpiresAt: Date | null;
    leaseLive: boolean;
    expiredRecoveryRequired: boolean;
    fieldOperationAllowed: boolean;
    outcome: "COMPLETED" | "STOPPED_EARLY" | "RECOVERED_AFTER_LOSS" | null;
    errorCode: FillErrorCode | null;
    steps: Array<{ stepKey: string; result: FillStepResult; errorCode: FillErrorCode | null }>;
  };
}

export function createApplicationRunFillAttemptService(
  dependencies: ApplicationRunFillAttemptServiceDependencies = {}
) {
  const prismaClient = dependencies.prismaClient ?? prisma;
  const env = dependencies.env ?? process.env;
  const attemptIdGenerator = dependencies.attemptIdGenerator ?? randomUUID;
  const assertTransition = dependencies.assertTransition ?? assertRunTransition;
  const loadVerifiedCurrentPacket =
    dependencies.loadVerifiedCurrentAnswerPacketForLockedRunInTransaction ??
    loadVerifiedCurrentAnswerPacketForLockedRunInTransaction;

  async function acquireFillAttempt(input: unknown) {
    try {
      const parsed = acquireInputSchema.parse(input);
      if (!isApplicationAutomationEnabled(env)) throw policyDenied();
      return await prismaClient.$transaction(async (untypedTx) => {
        const tx = untypedTx as ApplicationRunAnswerPacketTransaction;
        const policy = await lockPolicy(tx, parsed.userId);
        const run = await lockOwnedRun(tx, parsed.userId, parsed.runId);
        if (!policyAllowsFill(policy, env, run)) throw policyDenied();
        assertAcquisitionRunFence(run, parsed.expectedStateVersion);

        let verified: VerifiedCurrentAnswerPacket | null;
        try {
          verified = await loadVerifiedCurrentPacket(tx, { userId: parsed.userId, run });
        } catch (error) {
          classifyVerifiedPacketFailure(error);
        }
        if (!verified) throw reviewRequired();
        const eligibleFields = eligibleCandidates(run, verified);
        if (eligibleFields.length === 0) throw noEligibleFields();

        try {
          assertTransition("READY", "FILLING");
        } catch {
          throw fillInternal();
        }
        const databaseNow = await readDatabaseClock(tx);
        const attemptIdResult = attemptIdSchema.safeParse(attemptIdGenerator());
        if (!attemptIdResult.success) throw fillInternal();
        const attemptId = attemptIdResult.data;
        const leaseExpiresAt = new Date(databaseNow.getTime() + FILL_LEASE_MS);

        const update = await tx.applicationRun.updateMany({
          where: {
            id: run.id,
            userId: parsed.userId,
            state: "READY",
            stateVersion: parsed.expectedStateVersion,
            fillAttemptId: null,
            currentFormInspectionVersion: run.currentFormInspectionVersion,
            currentAnswerPacketVersion: run.currentAnswerPacketVersion
          },
          data: buildAcquireRunFillData({ fillAttemptId: attemptId, fillLeaseExpiresAt: leaseExpiresAt })
        });
        if (update.count !== 1) throw fillStale();

        const stepData = eligibleFields.map((field, sequence) => ({
          runId: run.id,
          userId: parsed.userId,
          stepKey: `fill:${attemptId}:${field.normalizedFieldKey}`,
          sequence,
          action: "FILL_FIELD",
          semanticFieldKey: null,
          adapter: null,
          status: "PENDING" as const,
          attemptNumber: 1,
          redactedValueSummary: null,
          errorCategory: null,
          artifactReference: null,
          startedAt: null,
          completedAt: null
        }));
        const created = await tx.applicationRunStep.createMany({ data: stepData });
        if (created.count !== stepData.length) throw fillInternal();

        await tx.auditLog.create({
          data: {
            userId: parsed.userId,
            action: "application-run-fill-attempt.acquire",
            resource: "ApplicationRun",
            resourceId: run.id,
            metadata: {
              runId: run.id,
              fillAttemptId: attemptId,
              previousStateVersion: run.stateVersion,
              nextStateVersion: run.stateVersion + 1,
              formInspectionVersion: run.currentFormInspectionVersion,
              answerPacketVersion: run.currentAnswerPacketVersion,
              eligibleFieldCount: eligibleFields.length,
              leaseExpiresAt: leaseExpiresAt.toISOString()
            } as Prisma.InputJsonValue
          }
        });

        return {
          attemptId,
          runStateVersion: run.stateVersion + 1,
          leaseExpiresAt,
          formInspectionVersion: run.currentFormInspectionVersion,
          answerPacketVersion: run.currentAnswerPacketVersion,
          packetHash: verified.packetRecord.packetHash,
          formFingerprint: verified.inspection.formFingerprint,
          eligibleFields
        };
      });
    } catch (error) {
      sanitizeFillFailure(error);
    }
  }

  async function getFillAttemptStatus(input: unknown) {
    try {
      const parsed = statusInputSchema.parse(input);
      return await prismaClient.$transaction(async (untypedTx) => {
        const tx = untypedTx as ApplicationRunAnswerPacketTransaction;
        const policy = await tx.applicationAutomationPolicy.findUnique({
          where: { userId: parsed.userId },
          select: {
            id: true,
            userId: true,
            enabled: true,
            mode: true,
            allowedHosts: true,
            blockedHosts: true,
            sensitiveAnswerPolicy: true,
            finalReviewRequired: true
          }
        }) as FillPolicy | null;
        const run = await readOwnedRun(tx, parsed.userId, parsed.runId);
        const databaseNow = await readDatabaseClock(tx);
        const status = baseStatus(run);

        if (run.state === "CANCELLED") {
          return {
            ...status,
            fillLeaseExpiresAt: null,
            leaseLive: false,
            expiredRecoveryRequired: false,
            fieldOperationAllowed: false,
            outcome: null,
            errorCode: null,
            steps: []
          };
        }

        if (run.state === "FILLING") {
          if (
            !attemptIdSchema.safeParse(run.fillAttemptId).success ||
            !(run.fillLeaseExpiresAt instanceof Date) ||
            !Number.isFinite(run.fillLeaseExpiresAt.getTime())
          ) {
            return { ...status, leaseLive: false, fieldOperationAllowed: false, errorCode: "FILL_INTERNAL" as const };
          }
          const leaseLive = run.fillLeaseExpiresAt.getTime() > databaseNow.getTime();
          return {
            ...status,
            leaseLive,
            expiredRecoveryRequired: !leaseLive,
            fieldOperationAllowed: leaseLive && policyAllowsFill(policy, env, run)
          };
        }

        if (run.state === "READY_FOR_USER_SUBMISSION") {
          const attemptId = attemptIdSchema.safeParse(run.fillAttemptId);
          if (!attemptId.success || run.fillLeaseExpiresAt !== null) {
            return { ...status, fillLeaseExpiresAt: null, errorCode: "FILL_INTERNAL" as const, steps: [] };
          }
          const steps = await tx.applicationRunStep.findMany({
            where: {
              runId: run.id,
              userId: parsed.userId,
              stepKey: { startsWith: `fill:${attemptId.data}:` }
            },
            orderBy: { sequence: "asc" },
            select: {
              stepKey: true,
              sequence: true,
              action: true,
              semanticFieldKey: true,
              adapter: true,
              status: true,
              attemptNumber: true,
              redactedValueSummary: true,
              errorCategory: true,
              artifactReference: true
            }
          }) as StoredFillStep[];
          if (!validTerminalSteps(attemptId.data, steps)) {
            return { ...status, errorCode: "FILL_INTERNAL" as const, steps: [] };
          }
          const canonicalStepKeys = steps.map((step) => step.stepKey);
          const derived = deriveTerminalFillAttemptOutcome({
            state: run.state,
            fillAttemptId: attemptId.data,
            errorCategory: run.errorCategory,
            canonicalStepKeys,
            steps: steps.map((step) => ({
              stepKey: step.stepKey,
              status: step.status,
              redactedValueSummary: step.redactedValueSummary,
              errorCategory: step.errorCategory
            }))
          });
          if (derived.errorCode === "FILL_INTERNAL") {
            return { ...status, outcome: null, errorCode: "FILL_INTERNAL" as const, steps: [] };
          }
          return {
            ...status,
            outcome: derived.outcome,
            errorCode: derived.errorCode,
            steps: steps.map((step) => ({
              stepKey: step.stepKey,
              result: step.redactedValueSummary as FillStepResult,
              errorCode: step.errorCategory as FillErrorCode | null
            }))
          };
        }

        if (run.fillAttemptId === null && run.fillLeaseExpiresAt === null) return status;
        if (
          (run.state === "REVIEW_REQUIRED" || run.state === "COMPLETED_BY_USER") &&
          run.fillAttemptId !== null &&
          run.fillLeaseExpiresAt === null
        ) {
          return status;
        }
        return { ...status, fillLeaseExpiresAt: null, errorCode: "FILL_INTERNAL" as const, steps: [] };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    } catch (error) {
      sanitizeFillFailure(error);
    }
  }

  async function finalizeFillAttempt(input: unknown) {
    try {
      const parsed = finalizeInputSchema.parse(input);
      const assertion = {
        fillAttemptId: parsed.fillAttemptId,
        outcome: parsed.outcome,
        errorCode: parsed.errorCode,
        steps: parsed.steps
      };
      reconcileFillFinalization({
        fillAttemptId: parsed.fillAttemptId,
        persistedSteps: parsed.steps.map((step) => ({
          fillAttemptId: parsed.fillAttemptId,
          stepKey: step.stepKey
        })),
        assertion
      });
      return await prismaClient.$transaction(async (untypedTx) => {
        const tx = untypedTx as ApplicationRunAnswerPacketTransaction;
        const run = await lockOwnedRun(tx, parsed.userId, parsed.runId);
        const leaseExpiresAt = assertActiveMutationFence(run, parsed);
        const databaseNow = await readDatabaseClock(tx);
        if (databaseNow.getTime() >= leaseExpiresAt.getTime()) throw fillStale();

        const persistedSteps = await lockAttemptSteps(tx, parsed);
        assertUnfinalizedSteps(parsed.fillAttemptId, persistedSteps);
        const reconciled = reconcileFillFinalization({
          fillAttemptId: parsed.fillAttemptId,
          persistedSteps: persistedSteps.map((step) => ({
            fillAttemptId: parsed.fillAttemptId,
            stepKey: step.stepKey
          })),
          assertion
        });

        try {
          assertTransition("FILLING", "READY_FOR_USER_SUBMISSION");
        } catch {
          throw fillInternal();
        }

        for (let index = 0; index < reconciled.steps.length; index += 1) {
          const source = persistedSteps[index];
          const terminal = reconciled.steps[index];
          const update = await tx.applicationRunStep.updateMany({
            where: {
              runId: run.id,
              userId: parsed.userId,
              stepKey: source.stepKey,
              sequence: source.sequence,
              action: "FILL_FIELD",
              attemptNumber: 1,
              semanticFieldKey: null,
              adapter: null,
              artifactReference: null,
              status: "PENDING",
              redactedValueSummary: null,
              errorCategory: null,
              startedAt: source.startedAt,
              completedAt: null
            },
            data: {
              status: terminal.status,
              redactedValueSummary: terminal.redactedValueSummary,
              errorCategory: terminal.errorCategory,
              completedAt: databaseNow
            }
          });
          if (update.count !== 1) throw fillInternal();
        }

        const runUpdate = await tx.applicationRun.updateMany({
          where: {
            id: run.id,
            userId: parsed.userId,
            state: "FILLING",
            stateVersion: parsed.expectedStateVersion,
            fillAttemptId: parsed.fillAttemptId,
            fillLeaseExpiresAt: leaseExpiresAt
          },
          data: buildFinalizeRunFillData({ errorCategory: reconciled.errorCategory })
        });
        if (runUpdate.count !== 1) throw fillInternal();

        const responseSteps = reconciled.steps.map((step) => ({
          stepKey: step.stepKey,
          result: step.redactedValueSummary,
          errorCode: step.errorCategory
        }));
        await tx.auditLog.create({
          data: {
            userId: parsed.userId,
            action: "application-run-fill-attempt.finalize",
            resource: "ApplicationRun",
            resourceId: run.id,
            metadata: {
              runId: run.id,
              fillAttemptId: parsed.fillAttemptId,
              previousStateVersion: run.stateVersion,
              nextStateVersion: run.stateVersion + 1,
              outcome: reconciled.outcome,
              errorCode: reconciled.errorCategory,
              resultCounts: resultCounts(responseSteps),
              completedAt: databaseNow.toISOString()
            } as Prisma.InputJsonValue
          }
        });

        return terminalStatus({
          run,
          outcome: reconciled.outcome,
          errorCode: reconciled.errorCategory,
          steps: responseSteps
        });
      });
    } catch (error) {
      sanitizeFillFailure(error);
    }
  }

  async function recoverExpiredFillAttempt(input: unknown) {
    try {
      const parsed = recoverInputSchema.parse(input);
      return await prismaClient.$transaction(async (untypedTx) => {
        const tx = untypedTx as ApplicationRunAnswerPacketTransaction;
        const run = await lockOwnedRun(tx, parsed.userId, parsed.runId);
        const leaseExpiresAt = assertActiveMutationFence(run, parsed);
        const databaseNow = await readDatabaseClock(tx);
        if (databaseNow.getTime() < leaseExpiresAt.getTime()) throw alreadyInProgress();

        const persistedSteps = await lockAttemptSteps(tx, parsed);
        const projected = projectRecoverySteps(parsed.fillAttemptId, persistedSteps);
        const canonicalStepKeys = projected.map((step) => step.source.stepKey);
        const derived = deriveTerminalFillAttemptOutcome({
          state: "READY_FOR_USER_SUBMISSION",
          fillAttemptId: parsed.fillAttemptId,
          errorCategory: "FILL_STALE",
          canonicalStepKeys,
          steps: projected.map((step) => ({
            stepKey: step.source.stepKey,
            status: step.status,
            redactedValueSummary: step.redactedValueSummary,
            errorCategory: step.errorCategory
          }))
        });
        if (derived.outcome !== "RECOVERED_AFTER_LOSS" || derived.errorCode !== "FILL_STALE") {
          throw fillInternal();
        }

        try {
          assertTransition("FILLING", "READY_FOR_USER_SUBMISSION");
        } catch {
          throw fillInternal();
        }

        for (const step of projected) {
          if (!step.recovered) continue;
          const unresolvedStatus = step.source.status;
          if (unresolvedStatus !== "PENDING" && unresolvedStatus !== "RUNNING") {
            throw fillInternal();
          }
          const update = await tx.applicationRunStep.updateMany({
            where: {
              runId: run.id,
              userId: parsed.userId,
              stepKey: step.source.stepKey,
              sequence: step.source.sequence,
              action: "FILL_FIELD",
              attemptNumber: 1,
              semanticFieldKey: null,
              adapter: null,
              artifactReference: null,
              status: unresolvedStatus,
              redactedValueSummary: null,
              errorCategory: null,
              startedAt: step.source.startedAt,
              completedAt: null
            },
            data: {
              status: "FAILED",
              redactedValueSummary: "FAILED",
              errorCategory: "FILL_STALE",
              completedAt: databaseNow
            }
          });
          if (update.count !== 1) throw fillInternal();
        }

        const runUpdate = await tx.applicationRun.updateMany({
          where: {
            id: run.id,
            userId: parsed.userId,
            state: "FILLING",
            stateVersion: parsed.expectedStateVersion,
            fillAttemptId: parsed.fillAttemptId,
            fillLeaseExpiresAt: leaseExpiresAt
          },
          data: buildRecoverExpiredRunFillData()
        });
        if (runUpdate.count !== 1) throw fillInternal();

        const recoveredFailedCount = projected.filter((step) => step.recovered).length;
        await tx.auditLog.create({
          data: {
            userId: parsed.userId,
            action: "application-run-fill-attempt.recover",
            resource: "ApplicationRun",
            resourceId: run.id,
            metadata: {
              runId: run.id,
              fillAttemptId: parsed.fillAttemptId,
              previousStateVersion: run.stateVersion,
              nextStateVersion: run.stateVersion + 1,
              errorCode: "FILL_STALE",
              preservedSafeCount: projected.length - recoveredFailedCount,
              recoveredFailedCount,
              recoveredAt: databaseNow.toISOString()
            } as Prisma.InputJsonValue
          }
        });

        return terminalStatus({
          run,
          outcome: "RECOVERED_AFTER_LOSS",
          errorCode: "FILL_STALE",
          steps: projected.map((step) => ({
            stepKey: step.source.stepKey,
            result: step.redactedValueSummary,
            errorCode: step.errorCategory
          }))
        });
      });
    } catch (error) {
      sanitizeFillFailure(error);
    }
  }

  return { acquireFillAttempt, getFillAttemptStatus, finalizeFillAttempt, recoverExpiredFillAttempt };
}

const defaultApplicationRunFillAttemptService = createApplicationRunFillAttemptService();

export const acquireFillAttempt = defaultApplicationRunFillAttemptService.acquireFillAttempt;
export const getFillAttemptStatus = defaultApplicationRunFillAttemptService.getFillAttemptStatus;
export const finalizeFillAttempt = defaultApplicationRunFillAttemptService.finalizeFillAttempt;
export const recoverExpiredFillAttempt = defaultApplicationRunFillAttemptService.recoverExpiredFillAttempt;
