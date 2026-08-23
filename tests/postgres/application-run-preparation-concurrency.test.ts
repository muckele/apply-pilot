import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import type { Prisma } from "@prisma/client";

import { PublicApiError } from "@/lib/api-errors";
import type { ApplicationPlanInput } from "@/lib/ai/application-plan";
import type { AutomationPolicyValues } from "@/lib/application-runs/contracts";
import {
  createApplicationRunOrchestrator,
  type ApplicationRunOrchestrationDependencies
} from "@/lib/application-runs/orchestration";
import { dailyCapWindowStart, PREPARE_LEASE_MS } from "@/lib/application-runs/preparation";
import { automationPolicyDefaultValues, createApplicationRunService } from "@/lib/application-runs/service";
import {
  assertActorSessionPinned,
  assertDistinctActorSessions,
  assertNoIdleTransactions,
  assertNoUnexpectedConcurrencyError,
  createHookedPrismaClient,
  createPostgresTestActor,
  createSyntheticTestUser,
  deferred,
  deleteSyntheticTestUsers,
  disconnectPostgresTestActors,
  waitForActorLockWait,
  withTimeout,
  type Deferred,
  type PostgresTestActor
} from "@/tests/postgres/postgres-test-harness";

const POLICY_ROW_LOCK = {
  kind: "queryRaw",
  includes: ['FROM "ApplicationAutomationPolicy"', "FOR UPDATE"]
} as const;

const RUN_ROW_LOCK = {
  kind: "queryRaw",
  includes: ['FROM "ApplicationRun"', "FOR UPDATE"]
} as const;

const RUN_COUNT = {
  kind: "model",
  model: "applicationRun",
  method: "count"
} as const;

const AUDIT_CREATE = {
  kind: "model",
  model: "auditLog",
  method: "create"
} as const;

const SYNTHETIC_HOST = "jobs.example.test";
const GLOBAL_AUTOMATION_ENABLED = { APPLICATION_AUTOMATION_ENABLED: "true" } as const;
const OPERATION_TIMEOUT_MS = 12_000;
const CLEANUP_OPERATION_TIMEOUT_MS = 5_000;
const CLEANUP_DISCONNECT_TIMEOUT_MS = 3_000;

const RUN_SELECT = {
  id: true,
  userId: true,
  applicationId: true,
  jobPostingId: true,
  state: true,
  stateVersion: true,
  activeRunKey: true,
  prepareAttemptId: true,
  prepareLeaseExpiresAt: true,
  firstPreparingAt: true,
  blockingReason: true,
  errorCategory: true,
  reviewReasons: true,
  policyHash: true,
  fitScoreSnapshot: true,
  matchConfidenceScoreSnapshot: true,
  plannerConfidenceScoreSnapshot: true,
  resumeVersionId: true,
  resumeContentHash: true,
  coverLetterVersionId: true,
  coverLetterContentHash: true,
  plannerProvider: true,
  plannerModel: true,
  plannerPromptVersion: true,
  plannerRequestHash: true,
  preparedAt: true,
  cancelledAt: true,
  createdAt: true,
  updatedAt: true
} as const satisfies Prisma.ApplicationRunSelect;

const POLICY_SELECT = {
  id: true,
  userId: true,
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
  finalReviewRequired: true,
  createdAt: true,
  updatedAt: true
} as const satisfies Prisma.ApplicationAutomationPolicySelect;

const SAFE_AUDIT_SELECT = {
  id: true,
  userId: true,
  action: true,
  resource: true,
  resourceId: true,
  metadata: true,
  createdAt: true
} as const satisfies Prisma.AuditLogSelect;

const SAFE_EVENT_SELECT = {
  id: true,
  userId: true,
  applicationId: true,
  type: true,
  title: true,
  metadata: true,
  occurredAt: true
} as const satisfies Prisma.ApplicationEventSelect;

type RunRow = Prisma.ApplicationRunGetPayload<{ select: typeof RUN_SELECT }>;
type PolicyRow = Prisma.ApplicationAutomationPolicyGetPayload<{ select: typeof POLICY_SELECT }>;
type SafeAudit = Prisma.AuditLogGetPayload<{ select: typeof SAFE_AUDIT_SELECT }>;
type SafeEvent = Prisma.ApplicationEventGetPayload<{ select: typeof SAFE_EVENT_SELECT }>;
type SnapshotProjection = {
  policySnapshotPresent: boolean;
  applicationPlanSnapshotPresent: boolean;
  applicationPlanTargetRoleSummary: string | null;
  requirementCatalogSnapshotPresent: boolean;
  evidenceCatalogSnapshotPresent: boolean;
};
type Planner = NonNullable<ApplicationRunOrchestrationDependencies["planner"]>;

type CapturedFailure = { present: false } | { present: true; error: unknown };
type CleanupFailure = { phase: string; error: unknown };
type CleanupTrace = {
  databaseCleanupAttempted: boolean;
  deletedAuditIds: string[];
  deletedUserIds: string[];
  disconnectedActors: string[];
  failures: CleanupFailure[];
};
type CleanupPhaseResult<T> = { ok: true; value: T } | { ok: false };

const NO_CAPTURED_FAILURE: CapturedFailure = { present: false };

type Scenario = {
  label: string;
  observer: PostgresTestActor;
  actorA: PostgresTestActor;
  actorB: PostgresTestActor;
  actors: PostgresTestActor[];
  releases: Deferred<void>[];
  operations: Promise<unknown>[];
  syntheticUserIds: string[];
};

type EligibleUserFixture = {
  userId: string;
  policy: PolicyRow;
};

type RunSeedOverrides = {
  state?: Prisma.ApplicationRunUncheckedCreateInput["state"];
  stateVersion?: number;
  activeRunKey?: string | null;
  prepareAttemptId?: string | null;
  prepareLeaseExpiresAt?: Date | null;
  firstPreparingAt?: Date | null;
};

type EligibleRunFixture = {
  jobPostingId: string;
  resumeVersionId: string;
  applicationId: string;
  runId: string;
  applyUrl: string;
};

type RunMutationView = {
  data: Record<string, unknown>;
  where: Record<string, unknown>;
  count: number;
};

type StaleFinalizationProbe = {
  acquisitionMutations: number;
  lifecycleMutationAttempts: number;
  completionAuditAttempts: number;
  completionEventAttempts: number;
};

async function createScenario(label: string): Promise<Scenario> {
  const actors: PostgresTestActor[] = [];
  try {
    const observer = await createPostgresTestActor(`${label}-observer`);
    actors.push(observer);
    const actorA = await createPostgresTestActor(`${label}-a`);
    actors.push(actorA);
    const actorB = await createPostgresTestActor(`${label}-b`);
    actors.push(actorB);
    assertDistinctActorSessions(actors);
    return {
      label,
      observer,
      actorA,
      actorB,
      actors,
      releases: [],
      operations: [],
      syntheticUserIds: []
    };
  } catch (error) {
    await disconnectPostgresTestActors(actors);
    throw error;
  }
}

function createCleanupTrace(): CleanupTrace {
  return {
    databaseCleanupAttempted: false,
    deletedAuditIds: [],
    deletedUserIds: [],
    disconnectedActors: [],
    failures: []
  };
}

async function captureCleanupPhase<T>(
  trace: CleanupTrace,
  phase: string,
  action: () => Promise<T>
): Promise<CleanupPhaseResult<T>> {
  try {
    return { ok: true, value: await action() };
  } catch (error) {
    trace.failures.push({ phase, error });
    return { ok: false };
  }
}

function throwCleanupOutcome(primaryFailure: CapturedFailure, trace: CleanupTrace): void {
  if (primaryFailure.present) {
    const secondaryFailures = trace.failures.filter(({ error }) => error !== primaryFailure.error);
    if (
      secondaryFailures.length > 0 &&
      primaryFailure.error instanceof Error &&
      Object.isExtensible(primaryFailure.error) &&
      !("cause" in primaryFailure.error)
    ) {
      const summaries = secondaryFailures.map(
        ({ phase }) => new Error(`Secondary C5.4 cleanup phase failed: ${phase}.`)
      );
      try {
        Object.defineProperty(primaryFailure.error, "cause", {
          value: new AggregateError(summaries, "One or more secondary C5.4 cleanup phases failed."),
          configurable: true
        });
      } catch {
        // The original test failure remains authoritative even when it cannot be annotated.
      }
    }
    throw primaryFailure.error;
  }
  if (trace.failures.length > 0) throw trace.failures[0].error;
}

async function cleanupScenario(
  scenario: Scenario,
  primaryFailure: CapturedFailure = NO_CAPTURED_FAILURE,
  trace: CleanupTrace = createCleanupTrace()
): Promise<void> {
  for (const release of scenario.releases) {
    try {
      release.resolve();
    } catch (error) {
      trace.failures.push({ phase: "release-barrier", error });
    }
  }

  const competitors = [scenario.actorA, scenario.actorB] as const;
  const settlement = Promise.allSettled([...scenario.operations]);
  let operationsSettled = scenario.operations.length === 0;
  if (!operationsSettled) {
    operationsSettled = (
      await captureCleanupPhase(trace, "operation-settlement", () =>
        withTimeout(settlement, CLEANUP_OPERATION_TIMEOUT_MS, `${scenario.label} operation cleanup`)
      )
    ).ok;
  }

  let observerHealthy = (
    await captureCleanupPhase(trace, "observer-pin", () =>
      assertActorSessionPinned(scenario.observer, `${scenario.label}-cleanup-observer`)
    )
  ).ok;
  const competitorsToStop = new Set<PostgresTestActor>();
  if (!operationsSettled) {
    for (const actor of competitors) competitorsToStop.add(actor);
  }

  for (const [index, actor] of competitors.entries()) {
    const actorLabel = index === 0 ? "actor-a" : "actor-b";
    if (observerHealthy) {
      const idleResult = await captureCleanupPhase(trace, `${actorLabel}-idle`, () =>
        assertNoIdleTransactions(scenario.observer, [actor])
      );
      if (!idleResult.ok) {
        competitorsToStop.add(actor);
        observerHealthy = (
          await captureCleanupPhase(trace, `observer-repin-after-${actorLabel}-idle`, () =>
            assertActorSessionPinned(scenario.observer, `${scenario.label}-cleanup-observer-repin`)
          )
        ).ok;
      }
    }

    const pinResult = await captureCleanupPhase(trace, `${actorLabel}-pin`, () =>
      assertActorSessionPinned(actor, `${scenario.label}-cleanup-${actorLabel}`)
    );
    if (!pinResult.ok) competitorsToStop.add(actor);
  }

  const earlyDisconnectAttempted = new Set<PostgresTestActor>();
  const earlyDisconnectSucceeded = new Set<PostgresTestActor>();
  for (const [index, actor] of competitors.entries()) {
    if (!competitorsToStop.has(actor)) continue;
    const actorLabel = index === 0 ? "actor-a" : "actor-b";
    earlyDisconnectAttempted.add(actor);
    const disconnected = await captureCleanupPhase(trace, `${actorLabel}-early-disconnect`, () =>
      disconnectPostgresTestActors([actor], CLEANUP_DISCONNECT_TIMEOUT_MS)
    );
    if (disconnected.ok) {
      earlyDisconnectSucceeded.add(actor);
      trace.disconnectedActors.push(actor.actorName);
    }
  }

  if (!operationsSettled) {
    operationsSettled = (
      await captureCleanupPhase(trace, "operation-settlement-after-disconnect", () =>
        withTimeout(settlement, CLEANUP_OPERATION_TIMEOUT_MS, `${scenario.label} operation cleanup after disconnect`)
      )
    ).ok;
  }

  const unsafeCompetitorRemains = [...competitorsToStop].some(
    (actor) => !earlyDisconnectSucceeded.has(actor)
  );
  if (observerHealthy) {
    observerHealthy = (
      await captureCleanupPhase(trace, "observer-final-pin", () =>
        assertActorSessionPinned(scenario.observer, `${scenario.label}-cleanup-observer-final`)
      )
    ).ok;
  }

  const userIds = [...new Set(scenario.syntheticUserIds)].sort();
  if (observerHealthy && operationsSettled && !unsafeCompetitorRemains && userIds.length > 0) {
    trace.databaseCleanupAttempted = true;
    const auditSelection = await captureCleanupPhase(trace, "audit-id-selection", () =>
      scenario.observer.client.auditLog.findMany({
        where: { userId: { in: userIds } },
        select: { id: true }
      })
    );
    if (auditSelection.ok) {
      const auditIds = [...new Set(auditSelection.value.map(({ id }) => id))].sort();
      let auditDeletionSucceeded = true;
      if (auditIds.length > 0) {
        const auditDeletion = await captureCleanupPhase(trace, "audit-id-deletion", async () => {
          const deleted = await scenario.observer.client.auditLog.deleteMany({
            where: { id: { in: auditIds } }
          });
          assert.equal(deleted.count, auditIds.length);
        });
        auditDeletionSucceeded = auditDeletion.ok;
      }
      if (auditDeletionSucceeded) {
        trace.deletedAuditIds = auditIds;
        const userDeletion = await captureCleanupPhase(trace, "synthetic-user-deletion", () =>
          deleteSyntheticTestUsers(scenario.observer, userIds)
        );
        if (userDeletion.ok) trace.deletedUserIds = userIds;
      }
    }
  }

  for (const [index, actor] of competitors.entries()) {
    if (earlyDisconnectAttempted.has(actor)) continue;
    const actorLabel = index === 0 ? "actor-a" : "actor-b";
    const disconnected = await captureCleanupPhase(trace, `${actorLabel}-disconnect`, () =>
      disconnectPostgresTestActors([actor], CLEANUP_DISCONNECT_TIMEOUT_MS)
    );
    if (disconnected.ok) trace.disconnectedActors.push(actor.actorName);
  }
  const observerDisconnected = await captureCleanupPhase(trace, "observer-disconnect", () =>
    disconnectPostgresTestActors([scenario.observer], CLEANUP_DISCONNECT_TIMEOUT_MS)
  );
  if (observerDisconnected.ok) trace.disconnectedActors.push(scenario.observer.actorName);

  throwCleanupOutcome(primaryFailure, trace);
}

async function runScenarioBody(scenario: Scenario, body: () => Promise<void>): Promise<void> {
  let primaryFailure: CapturedFailure = NO_CAPTURED_FAILURE;
  try {
    await body();
  } catch (error) {
    primaryFailure = { present: true, error };
  }
  await cleanupScenario(scenario, primaryFailure);
}

function trackRelease(scenario: Scenario, release: Deferred<void>): Deferred<void> {
  scenario.releases.push(release);
  return release;
}

function trackOperation<T>(scenario: Scenario, operation: Promise<T>): Promise<T> {
  scenario.operations.push(operation);
  return operation;
}

function requireFulfilled<T>(
  result: PromiseSettledResult<T>,
  actor: PostgresTestActor,
  phase: string
): T {
  if (result.status === "fulfilled") return result.value;
  assertNoUnexpectedConcurrencyError(result.reason, actor.actorName, phase);
  assert.fail(`PostgreSQL actor ${actor.actorName} failed during ${phase}.`);
}

function requireRejected(
  result: PromiseSettledResult<unknown>,
  actor: PostgresTestActor,
  phase: string
): unknown {
  if (result.status === "rejected") {
    assertNoUnexpectedConcurrencyError(result.reason, actor.actorName, phase);
    return result.reason;
  }
  assert.fail(`PostgreSQL actor ${actor.actorName} unexpectedly fulfilled during ${phase}.`);
}

function assertPublicError(
  error: unknown,
  expected: { code: string; status: number; reason?: string }
): void {
  assert.ok(error instanceof PublicApiError);
  assert.equal(error.status, expected.status);
  assert.equal(error.details?.code, expected.code);
  if (expected.reason !== undefined) assert.equal(error.details?.reason, expected.reason);
}

async function assertObservedLockWait(
  observer: PostgresTestActor,
  waiter: PostgresTestActor,
  blocker: PostgresTestActor
): Promise<void> {
  const observed = await waitForActorLockWait(observer, waiter, blocker);
  assert.equal(observed.waiterPid, waiter.backendPid);
  assert.equal(observed.waiterApplicationName, waiter.applicationName);
  assert.equal(observed.waitEventType, "Lock");
  assert.equal(observed.hasUngrantedLock, true);
  assert.ok(observed.blockingPids.includes(blocker.backendPid));
}

async function assertScenarioSessionsPinned(scenario: Scenario, phase: string): Promise<void> {
  await assertNoIdleTransactions(scenario.observer, scenario.actors);
  for (const actor of scenario.actors) {
    await assertActorSessionPinned(actor, `${scenario.label}-${phase}`);
  }
}

async function createSyntheticUser(scenario: Scenario, label: string): Promise<{ id: string }> {
  const user = await createSyntheticTestUser(scenario.observer, `${scenario.label}-${label}`);
  scenario.syntheticUserIds.push(user.id);
  return { id: user.id };
}

async function createEligibleUser(
  scenario: Scenario,
  label: string,
  policyOverrides: Partial<AutomationPolicyValues> = {}
): Promise<EligibleUserFixture> {
  const user = await createSyntheticUser(scenario, label);
  const policy = await scenario.observer.client.applicationAutomationPolicy.create({
    data: {
      userId: user.id,
      ...automationPolicyDefaultValues(),
      enabled: true,
      allowedHosts: [SYNTHETIC_HOST],
      coverLetterRequired: false,
      ...policyOverrides
    },
    select: POLICY_SELECT
  }) as PolicyRow;
  return { userId: user.id, policy };
}

async function createEligibleRun(
  observer: PostgresTestActor,
  userId: string,
  label: string,
  runOverrides: RunSeedOverrides = {}
): Promise<EligibleRunFixture> {
  const fixtureKey = `${label}-${randomUUID()}`;
  const applyUrl = `https://${SYNTHETIC_HOST}/apply/${fixtureKey}`;
  const jobPosting = await observer.client.jobPosting.create({
    data: {
      userId,
      title: `C5.4 synthetic role ${fixtureKey}`,
      normalizedTitle: `c54-synthetic-role-${fixtureKey}`,
      company: "C5.4 Synthetic Employer",
      normalizedCompany: `c54-synthetic-employer-${fixtureKey}`,
      location: "Remote",
      normalizedLocation: `remote-${fixtureKey}`,
      remoteStatus: "REMOTE",
      sourceUrl: `https://${SYNTHETIC_HOST}/jobs/${fixtureKey}`,
      applyUrl,
      normalizedApplyUrl: applyUrl,
      description: "Synthetic evidence-backed preparation concurrency fixture.",
      requirements: ["TypeScript"],
      preferredQualifications: [],
      benefits: [],
      detectedTechStack: ["TypeScript"],
      sourceType: "MANUAL",
      overallFitScore: 95,
      confidenceScore: 95,
      missingKeywords: [],
      supportedKeywords: ["TypeScript"],
      concerns: []
    },
    select: { id: true }
  });
  const resumeVersion = await observer.client.resumeVersion.create({
    data: {
      userId,
      jobPostingId: jobPosting.id,
      title: `C5.4 assigned resume ${fixtureKey}`,
      summary: "Synthetic candidate with verified TypeScript evidence.",
      skills: ["TypeScript"],
      fullText: "Synthetic candidate with verified TypeScript evidence."
    },
    select: { id: true }
  });
  const application = await observer.client.application.create({
    data: {
      userId,
      jobPostingId: jobPosting.id,
      resumeVersionId: resumeVersion.id
    },
    select: { id: true }
  });
  const run = await observer.client.applicationRun.create({
    data: {
      userId,
      jobPostingId: jobPosting.id,
      applicationId: application.id,
      state: "DRAFT",
      stateVersion: 0,
      activeRunKey: application.id,
      idempotencyKey: `c54:${fixtureKey}`,
      applyUrlSnapshot: applyUrl,
      applyHost: SYNTHETIC_HOST,
      ...runOverrides
    },
    select: { id: true }
  });
  return {
    jobPostingId: jobPosting.id,
    resumeVersionId: resumeVersion.id,
    applicationId: application.id,
    runId: run.id,
    applyUrl
  };
}

function fixedCleanPlan(label: string) {
  const provider = "local" as const;
  const model = `c54-model-${label}`;
  const promptVersion = "c54-1";
  const requestHash = `c54-request-${label}`;
  return {
    targetRoleSummary: `C5.4 grounded plan ${label}`,
    evidenceMap: [
      {
        requirementId: "req-1",
        requirement: "TypeScript",
        evidenceIds: ["skill-1"],
        evidence: ["TypeScript"],
        gap: false
      }
    ],
    resumeStrategy: [`Use verified TypeScript evidence for ${label}`],
    coverLetterAngle: "Use only verified synthetic evidence.",
    riskFlags: [],
    recommendedNextActions: ["Review the synthetic evidence map."],
    confidenceScore: 95,
    unknownRequirementIds: [],
    unknownEvidenceIds: [],
    exaggeratedEvidenceIds: [],
    inventedNumericClaims: [],
    model,
    provider,
    promptVersion,
    requestHash,
    usage: {
      provider,
      model,
      promptVersion,
      requestHash,
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      estimatedCostMicros: 0,
      maximumCostMicros: 0,
      mocked: true,
      cacheHit: false
    }
  };
}

function createPreparation(
  prismaClient: PostgresTestActor["client"],
  options: {
    planner: Planner;
    clock: () => Date;
    attemptIdGenerator: () => string;
  }
) {
  return createApplicationRunOrchestrator({
    prismaClient,
    planner: options.planner,
    clock: options.clock,
    attemptIdGenerator: options.attemptIdGenerator,
    automationEnv: () => GLOBAL_AUTOMATION_ENABLED
  }).prepareApplicationRun;
}

function queuedClock(label: string, values: readonly Date[]) {
  let calls = 0;
  return {
    clock: () => {
      const value = values[calls];
      if (!value) throw new Error(`C5.4 clock ${label} received an unexpected call.`);
      calls += 1;
      return new Date(value.getTime());
    },
    assertCalls: (expected: number) => assert.equal(calls, expected, `${label} clock calls`),
    assertCallsBetween: (minimum: number, maximum: number) => {
      assert.ok(
        calls >= minimum && calls <= maximum,
        `${label} clock calls: expected ${minimum}-${maximum}, received ${calls}`
      );
    }
  };
}

function trackedAttemptId(label: string, attemptId: string) {
  let calls = 0;
  return {
    generate: () => {
      calls += 1;
      return attemptId;
    },
    assertCalls: (expected: number) => assert.equal(calls, expected, `${label} attempt ID calls`)
  };
}

function createPausedPlanner(
  scenario: Scenario,
  label: string,
  expectedUserId: string,
  outcome: () => ReturnType<typeof fixedCleanPlan> | Promise<ReturnType<typeof fixedCleanPlan>>
) {
  const called = deferred(`${label} planner called`);
  const release = trackRelease(scenario, deferred(`release ${label} planner`));
  let calls = 0;
  const planner = (async (
    _input: ApplicationPlanInput,
    userId?: string,
    options?: { automation?: boolean; highCostConfirmed?: boolean }
  ) => {
    calls += 1;
    assert.equal(userId, expectedUserId);
    assert.deepEqual(options, { automation: true, highCostConfirmed: false });
    called.resolve();
    await release.wait();
    return outcome();
  }) as Planner;
  return {
    planner,
    called,
    release,
    assertCalls: (expected: number) => assert.equal(calls, expected, `${label} planner calls`)
  };
}

function createImmediatePlanner(label: string, expectedUserId: string, planLabel: string) {
  let calls = 0;
  const planner = (async (
    _input: ApplicationPlanInput,
    userId?: string,
    options?: { automation?: boolean; highCostConfirmed?: boolean }
  ) => {
    calls += 1;
    assert.equal(userId, expectedUserId);
    assert.deepEqual(options, { automation: true, highCostConfirmed: false });
    return fixedCleanPlan(planLabel);
  }) as Planner;
  return {
    planner,
    assertCalls: (expected: number) => assert.equal(calls, expected, `${label} planner calls`)
  };
}

function extendRunMutationClient(
  prismaClient: PostgresTestActor["client"],
  name: string,
  onCompleted: (view: RunMutationView) => void | Promise<void>
): PostgresTestActor["client"] {
  return prismaClient.$extends({
    name,
    query: {
      applicationRun: {
        async updateMany({ args, query }) {
          const result = await query(args);
          await onCompleted({
            data: args.data as unknown as Record<string, unknown>,
            where: args.where as unknown as Record<string, unknown>,
            count: result.count
          });
          return result;
        }
      }
    }
  }) as unknown as PostgresTestActor["client"];
}

function extendStaleFinalizationProbeClient(
  prismaClient: PostgresTestActor["client"],
  name: string,
  expected: {
    userId: string;
    runId: string;
    applicationId: string;
    acquisitionAttemptId: string;
  },
  probe: StaleFinalizationProbe
): PostgresTestActor["client"] {
  return prismaClient.$extends({
    name,
    query: {
      applicationRun: {
        async updateMany({ args, query }) {
          const where = args.where as unknown as Record<string, unknown>;
          const data = args.data as unknown as Record<string, unknown>;
          const isTargetRun = where.id === expected.runId && where.userId === expected.userId;
          const isAcquisition =
            isTargetRun &&
            data.state === "PREPARING" &&
            data.prepareAttemptId === expected.acquisitionAttemptId;
          const isFinalizationAttempt =
            isTargetRun &&
            ["READY", "REVIEW_REQUIRED", "BLOCKED", "FAILED"].includes(String(data.state));

          if (isFinalizationAttempt) probe.lifecycleMutationAttempts += 1;

          const result = await query(args);
          if (isAcquisition) {
            assert.equal(result.count, 1);
            probe.acquisitionMutations += 1;
          }
          return result;
        }
      },
      auditLog: {
        async create({ args, query }) {
          const data = args.data as unknown as Record<string, unknown>;
          if (
            data.userId === expected.userId &&
            data.resource === "ApplicationRun" &&
            data.resourceId === expected.runId &&
            [
              "application-run.prepare.complete",
              "application-run.prepare.disabled-during-provider",
              "application-run.prepare.provider-blocked",
              "application-run.prepare.failed"
            ].includes(String(data.action))
          ) {
            probe.completionAuditAttempts += 1;
          }
          return query(args);
        }
      },
      applicationEvent: {
        async create({ args, query }) {
          const data = args.data as unknown as Record<string, unknown>;
          const metadata = data.metadata;
          const metadataRunId =
            metadata && typeof metadata === "object" && !Array.isArray(metadata) && "runId" in metadata
              ? (metadata as Record<string, unknown>).runId
              : undefined;
          if (
            data.userId === expected.userId &&
            data.applicationId === expected.applicationId &&
            data.type === "APPLICATION_RUN_EVENT" &&
            metadataRunId === expected.runId &&
            [
              "Application run preparation ready",
              "Application run preparation requires review",
              "Application run preparation blocked",
              "Application run preparation failed"
            ].includes(String(data.title))
          ) {
            probe.completionEventAttempts += 1;
          }
          return query(args);
        }
      }
    }
  }) as unknown as PostgresTestActor["client"];
}

function isIncrementOne(value: unknown): boolean {
  return Boolean(
    value &&
    typeof value === "object" &&
    "increment" in value &&
    (value as { increment?: unknown }).increment === 1
  );
}

function isAcquisitionMutation(view: RunMutationView, runId: string, attemptId: string): boolean {
  return (
    view.where.id === runId &&
    view.data.state === "PREPARING" &&
    view.data.prepareAttemptId === attemptId &&
    view.data.prepareLeaseExpiresAt instanceof Date &&
    isIncrementOne(view.data.stateVersion)
  );
}

function isReadyMutation(view: RunMutationView, runId: string, attemptId: string): boolean {
  return (
    view.where.id === runId &&
    view.where.state === "PREPARING" &&
    view.where.prepareAttemptId === attemptId &&
    view.data.state === "READY" &&
    view.data.preparedAt instanceof Date &&
    view.data.prepareAttemptId === null &&
    view.data.prepareLeaseExpiresAt === null
  );
}

function isFailedMutation(view: RunMutationView, runId: string, category: string): boolean {
  return view.where.id === runId && view.data.state === "FAILED" && view.data.errorCategory === category;
}

function isDisabledDuringProviderMutation(view: RunMutationView, runId: string): boolean {
  return (
    view.where.id === runId &&
    view.data.state === "BLOCKED" &&
    view.data.blockingReason === "automation_disabled_during_preparation"
  );
}

async function requireRun(observer: PostgresTestActor, userId: string, runId: string): Promise<RunRow> {
  const run = await observer.client.applicationRun.findFirst({
    where: { id: runId, userId },
    select: RUN_SELECT
  }) as RunRow | null;
  assert.ok(run);
  return run;
}

async function requirePolicy(observer: PostgresTestActor, userId: string): Promise<PolicyRow> {
  const policy = await observer.client.applicationAutomationPolicy.findUnique({
    where: { userId },
    select: POLICY_SELECT
  }) as PolicyRow | null;
  assert.ok(policy);
  return policy;
}

async function readAudits(observer: PostgresTestActor, userId: string): Promise<SafeAudit[]> {
  return observer.client.auditLog.findMany({
    where: { userId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: SAFE_AUDIT_SELECT
  }) as Promise<SafeAudit[]>;
}

async function readEvents(observer: PostgresTestActor, userId: string): Promise<SafeEvent[]> {
  return observer.client.applicationEvent.findMany({
    where: { userId },
    orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
    select: SAFE_EVENT_SELECT
  }) as Promise<SafeEvent[]>;
}

function jsonRecord(value: Prisma.JsonValue | null): Record<string, Prisma.JsonValue> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, Prisma.JsonValue>;
}

function auditsFor(
  audits: readonly SafeAudit[],
  action: string,
  resource: string,
  resourceId: string
): SafeAudit[] {
  return audits.filter(
    (audit) => audit.action === action && audit.resource === resource && audit.resourceId === resourceId
  );
}

function requireSingleAudit(
  audits: readonly SafeAudit[],
  action: string,
  resource: string,
  resourceId: string
): SafeAudit {
  const matching = auditsFor(audits, action, resource, resourceId);
  assert.equal(matching.length, 1, `${action}:${resource}:${resourceId}`);
  return matching[0];
}

function eventsFor(events: readonly SafeEvent[], applicationId: string, title: string): SafeEvent[] {
  return events.filter((event) => event.applicationId === applicationId && event.title === title);
}

function requireSingleEvent(events: readonly SafeEvent[], applicationId: string, title: string): SafeEvent {
  const matching = eventsFor(events, applicationId, title);
  assert.equal(matching.length, 1, `${applicationId}:${title}`);
  return matching[0];
}

function assertPreparationAudit(
  audit: SafeAudit,
  expected: { userId: string; action: string; runId: string; metadata: Record<string, Prisma.JsonValue> }
): void {
  assert.equal(audit.userId, expected.userId);
  assert.equal(audit.action, expected.action);
  assert.equal(audit.resource, "ApplicationRun");
  assert.equal(audit.resourceId, expected.runId);
  assert.deepEqual(jsonRecord(audit.metadata), expected.metadata);
}

function assertPreparationEvent(
  event: SafeEvent,
  expected: {
    userId: string;
    applicationId: string;
    title: string;
    metadata: Record<string, Prisma.JsonValue>;
  }
): void {
  assert.equal(event.userId, expected.userId);
  assert.equal(event.applicationId, expected.applicationId);
  assert.equal(event.type, "APPLICATION_RUN_EVENT");
  assert.equal(event.title, expected.title);
  assert.deepEqual(jsonRecord(event.metadata), expected.metadata);
}

function assertAcquireRecords(
  audits: readonly SafeAudit[],
  events: readonly SafeEvent[],
  expected: {
    userId: string;
    run: EligibleRunFixture;
    previousState: "DRAFT" | "PREPARING";
    stateVersion: number;
    acquisition: "first-acquire" | "retry-acquire";
  }
): void {
  const matchingAudits = auditsFor(
    audits,
    "application-run.prepare.acquire",
    "ApplicationRun",
    expected.run.runId
  ).filter((audit) => jsonRecord(audit.metadata).acquisition === expected.acquisition);
  assert.equal(matchingAudits.length, 1, `${expected.run.runId}:${expected.acquisition}:audit`);
  assertPreparationAudit(
    matchingAudits[0],
    {
      userId: expected.userId,
      action: "application-run.prepare.acquire",
      runId: expected.run.runId,
      metadata: {
        previousState: expected.previousState,
        nextState: "PREPARING",
        stateVersion: expected.stateVersion,
        acquisition: expected.acquisition
      }
    }
  );
  const matchingEvents = eventsFor(
    events,
    expected.run.applicationId,
    "Application run preparation started"
  ).filter((event) => jsonRecord(event.metadata).acquisition === expected.acquisition);
  assert.equal(matchingEvents.length, 1, `${expected.run.runId}:${expected.acquisition}:event`);
  assertPreparationEvent(
    matchingEvents[0],
    {
      userId: expected.userId,
      applicationId: expected.run.applicationId,
      title: "Application run preparation started",
      metadata: {
        runId: expected.run.runId,
        state: "PREPARING",
        stateVersion: expected.stateVersion,
        acquisition: expected.acquisition
      }
    }
  );
}

function assertCompletionRecords(
  audits: readonly SafeAudit[],
  events: readonly SafeEvent[],
  expected: { userId: string; run: EligibleRunFixture; stateVersion: number }
): void {
  assertPreparationAudit(
    requireSingleAudit(audits, "application-run.prepare.complete", "ApplicationRun", expected.run.runId),
    {
      userId: expected.userId,
      action: "application-run.prepare.complete",
      runId: expected.run.runId,
      metadata: {
        previousState: "PREPARING",
        nextState: "READY",
        stateVersion: expected.stateVersion,
        reviewReasonCount: 0
      }
    }
  );
  assertPreparationEvent(
    requireSingleEvent(events, expected.run.applicationId, "Application run preparation ready"),
    {
      userId: expected.userId,
      applicationId: expected.run.applicationId,
      title: "Application run preparation ready",
      metadata: {
        runId: expected.run.runId,
        state: "READY",
        stateVersion: expected.stateVersion,
        reviewReasonCount: 0
      }
    }
  );
}

function assertBulkRevocationAudit(
  audit: SafeAudit,
  expected: {
    userId: string;
    resource: "User" | "ApplicationRun";
    resourceId: string;
    reason: "policy_changed" | "run_cancelled";
    revokedAt: Date;
    runId?: string;
  }
): void {
  assert.equal(audit.userId, expected.userId);
  assert.equal(audit.action, "application-execution-token.revoke-bulk");
  assert.equal(audit.resource, expected.resource);
  assert.equal(audit.resourceId, expected.resourceId);
  assert.deepEqual(jsonRecord(audit.metadata), {
    ...(expected.runId ? { runId: expected.runId } : {}),
    reason: expected.reason,
    revokedCount: 0,
    revokedAt: expected.revokedAt.toISOString()
  });
}

function assertCancellationRecords(
  audits: readonly SafeAudit[],
  events: readonly SafeEvent[],
  expected: {
    userId: string;
    run: EligibleRunFixture;
    previousState: "PREPARING" | "READY";
    previousStateVersion: number;
    cancelledAt: Date;
  }
): void {
  assertPreparationAudit(
    requireSingleAudit(audits, "application-run.cancel", "ApplicationRun", expected.run.runId),
    {
      userId: expected.userId,
      action: "application-run.cancel",
      runId: expected.run.runId,
      metadata: {
        runId: expected.run.runId,
        previousState: expected.previousState,
        nextState: "CANCELLED",
        previousStateVersion: expected.previousStateVersion,
        nextStateVersion: expected.previousStateVersion + 1,
        revokedExecutionTokenCount: 0,
        cancelledAt: expected.cancelledAt.toISOString()
      }
    }
  );
  assertPreparationEvent(
    requireSingleEvent(events, expected.run.applicationId, "Application run cancelled"),
    {
      userId: expected.userId,
      applicationId: expected.run.applicationId,
      title: "Application run cancelled",
      metadata: {
        runId: expected.run.runId,
        previousState: expected.previousState,
        nextState: "CANCELLED",
        previousStateVersion: expected.previousStateVersion,
        nextStateVersion: expected.previousStateVersion + 1,
        revokedExecutionTokenCount: 0
      }
    }
  );
}

function assertPolicyDisabledRecords(
  audits: readonly SafeAudit[],
  expected: { userId: string; policyId: string; disabledAt: Date }
): void {
  assertBulkRevocationAudit(
    requireSingleAudit(audits, "application-execution-token.revoke-bulk", "User", expected.userId),
    {
      userId: expected.userId,
      resource: "User",
      resourceId: expected.userId,
      reason: "policy_changed",
      revokedAt: expected.disabledAt
    }
  );
  const policyAudit = requireSingleAudit(
    audits,
    "application-automation-policy.update",
    "ApplicationAutomationPolicy",
    expected.policyId
  );
  assert.equal(policyAudit.userId, expected.userId);
  assert.deepEqual(jsonRecord(policyAudit.metadata), {
    changedFields: ["enabled"],
    enabled: false,
    revokedExecutionTokenCount: 0,
    changedAt: expected.disabledAt.toISOString()
  });
}

async function assertNoPlanSnapshots(
  observer: PostgresTestActor,
  userId: string,
  run: RunRow
): Promise<void> {
  assert.equal(run.policyHash, null);
  assert.equal(run.fitScoreSnapshot, null);
  assert.equal(run.matchConfidenceScoreSnapshot, null);
  assert.equal(run.plannerConfidenceScoreSnapshot, null);
  assert.equal(run.resumeVersionId, null);
  assert.equal(run.resumeContentHash, null);
  assert.equal(run.coverLetterVersionId, null);
  assert.equal(run.coverLetterContentHash, null);
  assert.equal(run.plannerProvider, null);
  assert.equal(run.plannerModel, null);
  assert.equal(run.plannerPromptVersion, null);
  assert.equal(run.plannerRequestHash, null);
  assert.deepEqual(run.reviewReasons, []);
  assert.deepEqual(await requireSnapshotProjection(observer, userId, run.id), {
    policySnapshotPresent: false,
    applicationPlanSnapshotPresent: false,
    applicationPlanTargetRoleSummary: null,
    requirementCatalogSnapshotPresent: false,
    evidenceCatalogSnapshotPresent: false
  });
}

async function assertPlanBelongsTo(
  observer: PostgresTestActor,
  userId: string,
  run: RunRow,
  label: string
): Promise<void> {
  assert.notEqual(run.policyHash, null);
  assert.equal(run.fitScoreSnapshot, 95);
  assert.equal(run.matchConfidenceScoreSnapshot, 95);
  assert.notEqual(run.resumeVersionId, null);
  assert.notEqual(run.resumeContentHash, null);
  assert.equal(run.coverLetterVersionId, null);
  assert.equal(run.coverLetterContentHash, null);
  assert.equal(run.plannerProvider, "local");
  assert.equal(run.plannerModel, `c54-model-${label}`);
  assert.equal(run.plannerPromptVersion, "c54-1");
  assert.equal(run.plannerRequestHash, `c54-request-${label}`);
  assert.equal(run.plannerConfidenceScoreSnapshot, 95);
  assert.deepEqual(run.reviewReasons, []);
  assert.deepEqual(await requireSnapshotProjection(observer, userId, run.id), {
    policySnapshotPresent: true,
    applicationPlanSnapshotPresent: true,
    applicationPlanTargetRoleSummary: `C5.4 grounded plan ${label}`,
    requirementCatalogSnapshotPresent: true,
    evidenceCatalogSnapshotPresent: true
  });
}

async function requireSnapshotProjection(
  observer: PostgresTestActor,
  userId: string,
  runId: string
): Promise<SnapshotProjection> {
  const rows = await observer.client.$queryRaw<SnapshotProjection[]>`
    SELECT
      ("policySnapshot" IS NOT NULL) AS "policySnapshotPresent",
      ("applicationPlanSnapshot" IS NOT NULL) AS "applicationPlanSnapshotPresent",
      "applicationPlanSnapshot" ->> 'targetRoleSummary' AS "applicationPlanTargetRoleSummary",
      ("requirementCatalogSnapshot" IS NOT NULL) AS "requirementCatalogSnapshotPresent",
      ("evidenceCatalogSnapshot" IS NOT NULL) AS "evidenceCatalogSnapshotPresent"
    FROM "ApplicationRun"
    WHERE "id" = ${runId} AND "userId" = ${userId}
  `;
  assert.equal(rows.length, 1);
  return rows[0];
}

async function assertNoExecutionTokens(observer: PostgresTestActor, userId: string): Promise<void> {
  assert.equal(await observer.client.applicationExecutionToken.count({ where: { userId } }), 0);
}

test("same-user first preparations serialize the daily cap without oversubscription", async () => {
  const scenario = await createScenario("preparation-daily-cap");
  const acquireAt = new Date("2036-01-01T00:00:00.000Z");
  const blockedAt = new Date("2036-01-01T00:00:01.000Z");
  const completedAt = new Date("2036-01-01T00:00:02.000Z");
  await runScenarioBody(scenario, async () => {
    const fixture = await createEligibleUser(scenario, "user", { dailyApplicationCap: 1 });
    const runA = await createEligibleRun(scenario.observer, fixture.userId, "daily-cap-a");
    const runB = await createEligibleRun(scenario.observer, fixture.userId, "daily-cap-b");
    const attemptAId = "c54-daily-cap-attempt-a";
    const attemptBId = "c54-daily-cap-attempt-b-unused";
    const aAcquisitionCompleted = deferred("daily cap A acquisition completed");
    const releaseATx1 = trackRelease(scenario, deferred("release daily cap A TX1"));
    const bPolicyLockAttempted = deferred("daily cap B policy lock attempted");

    const aHooks = createHookedPrismaClient(scenario.actorA, [
      {
        name: "daily cap A rolling count",
        match: RUN_COUNT
      }
    ]);
    const bHooks = createHookedPrismaClient(scenario.actorB, [
      {
        name: "daily cap B policy lock attempt",
        match: POLICY_ROW_LOCK,
        before: () => bPolicyLockAttempted.resolve()
      },
      {
        name: "daily cap B authoritative rolling count",
        match: RUN_COUNT
      }
    ]);
    let aAcquireMatches = 0;
    const aClient = extendRunMutationClient(
      aHooks.prismaClient,
      "c54DailyCapAcquirePause",
      async (view) => {
        if (!isAcquisitionMutation(view, runA.runId, attemptAId)) return;
        assert.equal(view.where.userId, fixture.userId);
        assert.equal(view.where.state, "DRAFT");
        assert.equal(view.where.stateVersion, 0);
        assert.equal(view.where.prepareAttemptId, null);
        assert.equal(view.count, 1);
        aAcquireMatches += 1;
        aAcquisitionCompleted.resolve();
        await releaseATx1.wait();
      }
    );
    const aPlanner = createPausedPlanner(
      scenario,
      "daily cap A",
      fixture.userId,
      () => fixedCleanPlan("daily-cap-a")
    );
    let bPlannerCalls = 0;
    const plannerB = (async () => {
      bPlannerCalls += 1;
      return fixedCleanPlan("daily-cap-b-unexpected");
    }) as Planner;
    const clockA = queuedClock("daily cap A", [acquireAt, completedAt]);
    const clockB = queuedClock("daily cap B", [blockedAt]);
    const attemptA = trackedAttemptId("daily cap A", attemptAId);
    const attemptB = trackedAttemptId("daily cap B", attemptBId);
    const prepareA = createPreparation(aClient, {
      planner: aPlanner.planner,
      clock: clockA.clock,
      attemptIdGenerator: attemptA.generate
    });
    const prepareB = createPreparation(bHooks.prismaClient, {
      planner: plannerB,
      clock: clockB.clock,
      attemptIdGenerator: attemptB.generate
    });

    const operationA = trackOperation(
      scenario,
      prepareA({ userId: fixture.userId, runId: runA.runId, highCostConfirmed: false })
    );
    await aAcquisitionCompleted.wait();
    const operationB = trackOperation(
      scenario,
      prepareB({ userId: fixture.userId, runId: runB.runId, highCostConfirmed: false })
    );
    await bPolicyLockAttempted.wait();
    await assertObservedLockWait(scenario.observer, scenario.actorB, scenario.actorA);

    releaseATx1.resolve();
    await aPlanner.called.wait();
    await assertNoIdleTransactions(scenario.observer, [scenario.actorA]);
    const bSettled = await withTimeout(
      Promise.allSettled([operationB]),
      OPERATION_TIMEOUT_MS,
      "daily cap B blocked completion"
    );
    const errorB = requireRejected(bSettled[0], scenario.actorB, "daily-cap-B");
    assertPublicError(errorB, {
      code: "RUN_DAILY_CAP_REACHED",
      status: 429,
      reason: "daily_application_cap_reached"
    });

    const midA = await requireRun(scenario.observer, fixture.userId, runA.runId);
    assert.equal(midA.state, "PREPARING");
    assert.equal(midA.stateVersion, 1);
    assert.equal(midA.prepareAttemptId, attemptAId);
    assert.equal(midA.firstPreparingAt?.toISOString(), acquireAt.toISOString());
    assert.equal(
      midA.prepareLeaseExpiresAt?.toISOString(),
      new Date(acquireAt.getTime() + PREPARE_LEASE_MS).toISOString()
    );
    const midB = await requireRun(scenario.observer, fixture.userId, runB.runId);
    assert.equal(midB.state, "BLOCKED");
    assert.equal(midB.stateVersion, 1);
    assert.equal(midB.firstPreparingAt, null);
    assert.equal(midB.prepareAttemptId, null);
    assert.equal(midB.prepareLeaseExpiresAt, null);
    assert.equal(midB.blockingReason, "daily_application_cap_reached");
    const rollingCount = await scenario.observer.client.applicationRun.count({
      where: {
        userId: fixture.userId,
        firstPreparingAt: { gte: dailyCapWindowStart(blockedAt) }
      }
    });
    assert.equal(rollingCount, 1);

    const midAudits = await readAudits(scenario.observer, fixture.userId);
    const midEvents = await readEvents(scenario.observer, fixture.userId);
    assert.equal(midAudits.length, 2);
    assert.equal(midEvents.length, 2);
    assertAcquireRecords(midAudits, midEvents, {
      userId: fixture.userId,
      run: runA,
      previousState: "DRAFT",
      stateVersion: 1,
      acquisition: "first-acquire"
    });
    assertPreparationAudit(
      requireSingleAudit(midAudits, "application-run.prepare.blocked", "ApplicationRun", runB.runId),
      {
        userId: fixture.userId,
        action: "application-run.prepare.blocked",
        runId: runB.runId,
        metadata: {
          previousState: "DRAFT",
          nextState: "BLOCKED",
          stateVersion: 1,
          reason: "daily_application_cap_reached"
        }
      }
    );
    assertPreparationEvent(
      requireSingleEvent(midEvents, runB.applicationId, "Application run preparation blocked"),
      {
        userId: fixture.userId,
        applicationId: runB.applicationId,
        title: "Application run preparation blocked",
        metadata: {
          runId: runB.runId,
          state: "BLOCKED",
          stateVersion: 1,
          reason: "daily_application_cap_reached"
        }
      }
    );

    aPlanner.release.resolve();
    const aSettled = await withTimeout(
      Promise.allSettled([operationA]),
      OPERATION_TIMEOUT_MS,
      "daily cap A successful completion"
    );
    const resultA = requireFulfilled(aSettled[0], scenario.actorA, "daily-cap-A");
    assert.equal(resultA.state, "READY");
    assert.equal(resultA.stateVersion, 2);

    const finalA = await requireRun(scenario.observer, fixture.userId, runA.runId);
    const finalB = await requireRun(scenario.observer, fixture.userId, runB.runId);
    assert.equal(finalA.state, "READY");
    assert.equal(finalA.stateVersion, 2);
    assert.equal(finalA.firstPreparingAt?.toISOString(), acquireAt.toISOString());
    assert.equal(finalA.prepareAttemptId, null);
    assert.equal(finalA.prepareLeaseExpiresAt, null);
    await assertPlanBelongsTo(scenario.observer, fixture.userId, finalA, "daily-cap-a");
    assert.deepEqual(finalB, midB);
    const finalAudits = await readAudits(scenario.observer, fixture.userId);
    const finalEvents = await readEvents(scenario.observer, fixture.userId);
    assert.equal(finalAudits.length, 3);
    assert.equal(finalEvents.length, 3);
    assertCompletionRecords(finalAudits, finalEvents, {
      userId: fixture.userId,
      run: runA,
      stateVersion: 2
    });
    assert.equal(aAcquireMatches, 1);
    aPlanner.assertCalls(1);
    assert.equal(bPlannerCalls, 0);
    attemptA.assertCalls(1);
    attemptB.assertCalls(0);
    clockA.assertCalls(2);
    clockB.assertCalls(1);
    aHooks.assertExpectedHooksReached();
    bHooks.assertExpectedHooksReached();
    await assertNoExecutionTokens(scenario.observer, fixture.userId);
    await assertScenarioSessionsPinned(scenario, "daily-cap-complete");
  });
});

test("a live PREPARING lease cannot be stolen by a concurrent prepare", async () => {
  const scenario = await createScenario("preparation-live-lease");
  const acquireAt = new Date("2036-01-02T00:00:00.000Z");
  const contenderAt = new Date("2036-01-02T00:01:00.000Z");
  const completedAt = new Date("2036-01-02T00:02:00.000Z");
  await runScenarioBody(scenario, async () => {
    const fixture = await createEligibleUser(scenario, "user");
    const run = await createEligibleRun(scenario.observer, fixture.userId, "live-lease");
    const attemptAId = "c54-live-lease-attempt-a";
    const aAcquisitionCompleted = deferred("live lease A acquisition completed");
    const releaseATx1 = trackRelease(scenario, deferred("release live lease A TX1"));
    const bPolicyLockAttempted = deferred("live lease B policy lock attempted");
    let bPolicyLockCompleted = false;

    const aHooks = createHookedPrismaClient(scenario.actorA, [
      { name: "live lease A rolling count", match: RUN_COUNT }
    ]);
    const bHooks = createHookedPrismaClient(scenario.actorB, [
      {
        name: "live lease B policy lock attempt",
        match: POLICY_ROW_LOCK,
        before: () => bPolicyLockAttempted.resolve(),
        after: () => {
          bPolicyLockCompleted = true;
        }
      },
      { name: "live lease B skips rolling count", match: RUN_COUNT, expectedMatches: 0 },
      { name: "live lease B writes no audit", match: AUDIT_CREATE, expectedMatches: 0 }
    ]);
    let aAcquireMatches = 0;
    const aClient = extendRunMutationClient(aHooks.prismaClient, "c54LiveLeaseAcquirePause", async (view) => {
      if (!isAcquisitionMutation(view, run.runId, attemptAId)) return;
      assert.equal(view.where.userId, fixture.userId);
      assert.equal(view.where.state, "DRAFT");
      assert.equal(view.where.stateVersion, 0);
      assert.equal(view.where.prepareAttemptId, null);
      assert.equal(view.count, 1);
      aAcquireMatches += 1;
      aAcquisitionCompleted.resolve();
      await releaseATx1.wait();
    });
    let bRunMutations = 0;
    const bClient = extendRunMutationClient(bHooks.prismaClient, "c54LiveLeaseNoMutation", (view) => {
      if (view.where.id === run.runId) bRunMutations += 1;
    });
    const aPlanner = createPausedPlanner(
      scenario,
      "live lease A",
      fixture.userId,
      () => fixedCleanPlan("live-lease-a")
    );
    let bPlannerCalls = 0;
    const plannerB = (async () => {
      bPlannerCalls += 1;
      return fixedCleanPlan("live-lease-b-unexpected");
    }) as Planner;
    const clockA = queuedClock("live lease A", [acquireAt, completedAt]);
    const clockB = queuedClock("live lease B", [contenderAt]);
    const attemptA = trackedAttemptId("live lease A", attemptAId);
    const attemptB = trackedAttemptId("live lease B", "c54-live-lease-attempt-b-unused");
    const prepareA = createPreparation(aClient, {
      planner: aPlanner.planner,
      clock: clockA.clock,
      attemptIdGenerator: attemptA.generate
    });
    const prepareB = createPreparation(bClient, {
      planner: plannerB,
      clock: clockB.clock,
      attemptIdGenerator: attemptB.generate
    });

    const operationA = trackOperation(
      scenario,
      prepareA({ userId: fixture.userId, runId: run.runId, highCostConfirmed: false })
    );
    await aAcquisitionCompleted.wait();
    const operationB = trackOperation(
      scenario,
      prepareB({ userId: fixture.userId, runId: run.runId, highCostConfirmed: false })
    );
    await bPolicyLockAttempted.wait();
    await assertObservedLockWait(scenario.observer, scenario.actorB, scenario.actorA);
    assert.equal(
      bPolicyLockCompleted,
      false,
      "live lease B policy-lock query must still be in flight"
    );

    releaseATx1.resolve();
    await aPlanner.called.wait();
    await assertNoIdleTransactions(scenario.observer, [scenario.actorA]);
    const beforeB = await requireRun(scenario.observer, fixture.userId, run.runId);
    assert.equal(beforeB.state, "PREPARING");
    assert.equal(beforeB.stateVersion, 1);
    assert.equal(beforeB.prepareAttemptId, attemptAId);
    assert.equal(beforeB.firstPreparingAt?.toISOString(), acquireAt.toISOString());
    assert.equal(
      beforeB.prepareLeaseExpiresAt?.toISOString(),
      new Date(acquireAt.getTime() + PREPARE_LEASE_MS).toISOString()
    );
    const bSettled = await withTimeout(
      Promise.allSettled([operationB]),
      OPERATION_TIMEOUT_MS,
      "live lease B rejection"
    );
    const errorB = requireRejected(bSettled[0], scenario.actorB, "live-lease-B");
    assertPublicError(errorB, { code: "RUN_PREPARATION_IN_PROGRESS", status: 409 });
    const afterB = await requireRun(scenario.observer, fixture.userId, run.runId);
    assert.deepEqual(afterB, beforeB);
    assert.equal(bRunMutations, 0);
    assert.equal(bPlannerCalls, 0);
    attemptB.assertCalls(0);
    const midAudits = await readAudits(scenario.observer, fixture.userId);
    const midEvents = await readEvents(scenario.observer, fixture.userId);
    assert.equal(midAudits.length, 1);
    assert.equal(midEvents.length, 1);
    assertAcquireRecords(midAudits, midEvents, {
      userId: fixture.userId,
      run,
      previousState: "DRAFT",
      stateVersion: 1,
      acquisition: "first-acquire"
    });

    aPlanner.release.resolve();
    const aSettled = await withTimeout(
      Promise.allSettled([operationA]),
      OPERATION_TIMEOUT_MS,
      "live lease A completion"
    );
    const resultA = requireFulfilled(aSettled[0], scenario.actorA, "live-lease-A");
    assert.equal(
      bPolicyLockCompleted,
      true,
      "live lease B policy-lock query must complete after holder release"
    );
    assert.equal(resultA.state, "READY");
    assert.equal(resultA.stateVersion, 2);
    const finalRun = await requireRun(scenario.observer, fixture.userId, run.runId);
    assert.equal(finalRun.state, "READY");
    assert.equal(finalRun.stateVersion, 2);
    assert.equal(finalRun.firstPreparingAt?.toISOString(), acquireAt.toISOString());
    assert.equal(finalRun.prepareAttemptId, null);
    assert.equal(finalRun.prepareLeaseExpiresAt, null);
    await assertPlanBelongsTo(scenario.observer, fixture.userId, finalRun, "live-lease-a");
    const finalAudits = await readAudits(scenario.observer, fixture.userId);
    const finalEvents = await readEvents(scenario.observer, fixture.userId);
    assert.equal(finalAudits.length, 2);
    assert.equal(finalEvents.length, 2);
    assertCompletionRecords(finalAudits, finalEvents, {
      userId: fixture.userId,
      run,
      stateVersion: 2
    });
    assert.equal(aAcquireMatches, 1);
    aPlanner.assertCalls(1);
    attemptA.assertCalls(1);
    clockA.assertCalls(2);
    clockB.assertCalls(1);
    aHooks.assertExpectedHooksReached();
    bHooks.assertExpectedHooksReached();
    await assertScenarioSessionsPinned(scenario, "live-lease-complete");
  });
});

test("an expired PREPARING lease is reclaimed by exactly one concurrent actor", async () => {
  const scenario = await createScenario("preparation-expired-reclaim");
  const historicalFirstPreparingAt = new Date("2036-01-02T12:00:00.000Z");
  const reclaimAt = new Date("2036-01-03T00:00:00.000Z");
  const completedAt = new Date("2036-01-03T00:02:00.000Z");
  const oldAttemptId = "c54-expired-old-attempt";
  const attemptAId = "c54-expired-attempt-a";
  const initialVersion = 5;
  await runScenarioBody(scenario, async () => {
    const fixture = await createEligibleUser(scenario, "user");
    const run = await createEligibleRun(scenario.observer, fixture.userId, "expired-reclaim", {
      state: "PREPARING",
      stateVersion: initialVersion,
      prepareAttemptId: oldAttemptId,
      prepareLeaseExpiresAt: new Date(reclaimAt.getTime() - 1),
      firstPreparingAt: historicalFirstPreparingAt
    });
    const aReclaimCompleted = deferred("expired reclaim A update completed");
    const releaseATx1 = trackRelease(scenario, deferred("release expired reclaim A TX1"));
    const bPolicyLockAttempted = deferred("expired reclaim B policy lock attempted");
    let bPolicyLockCompleted = false;

    const aHooks = createHookedPrismaClient(scenario.actorA, [
      { name: "expired reclaim A skips rolling count", match: RUN_COUNT, expectedMatches: 0 }
    ]);
    const bHooks = createHookedPrismaClient(scenario.actorB, [
      {
        name: "expired reclaim B policy lock attempt",
        match: POLICY_ROW_LOCK,
        before: () => bPolicyLockAttempted.resolve(),
        after: () => {
          bPolicyLockCompleted = true;
        }
      },
      { name: "expired reclaim B skips rolling count", match: RUN_COUNT, expectedMatches: 0 },
      { name: "expired reclaim B writes no audit", match: AUDIT_CREATE, expectedMatches: 0 }
    ]);
    let aReclaimMatches = 0;
    const aClient = extendRunMutationClient(aHooks.prismaClient, "c54ExpiredReclaimPause", async (view) => {
      if (!isAcquisitionMutation(view, run.runId, attemptAId)) return;
      assert.equal(view.where.userId, fixture.userId);
      assert.equal(view.where.state, "PREPARING");
      assert.equal(view.where.stateVersion, initialVersion);
      assert.equal(view.where.prepareAttemptId, oldAttemptId);
      assert.equal(view.data.firstPreparingAt, undefined);
      assert.equal(view.count, 1);
      aReclaimMatches += 1;
      aReclaimCompleted.resolve();
      await releaseATx1.wait();
    });
    let bRunMutations = 0;
    const bClient = extendRunMutationClient(bHooks.prismaClient, "c54ExpiredReclaimNoLoserMutation", (view) => {
      if (view.where.id === run.runId) bRunMutations += 1;
    });
    const aPlanner = createPausedPlanner(
      scenario,
      "expired reclaim A",
      fixture.userId,
      () => fixedCleanPlan("expired-reclaim-a")
    );
    let bPlannerCalls = 0;
    const plannerB = (async () => {
      bPlannerCalls += 1;
      return fixedCleanPlan("expired-reclaim-b-unexpected");
    }) as Planner;
    const clockA = queuedClock("expired reclaim A", [reclaimAt, completedAt]);
    const clockB = queuedClock("expired reclaim B", [reclaimAt]);
    const attemptA = trackedAttemptId("expired reclaim A", attemptAId);
    const attemptB = trackedAttemptId("expired reclaim B", "c54-expired-attempt-b-unused");
    const prepareA = createPreparation(aClient, {
      planner: aPlanner.planner,
      clock: clockA.clock,
      attemptIdGenerator: attemptA.generate
    });
    const prepareB = createPreparation(bClient, {
      planner: plannerB,
      clock: clockB.clock,
      attemptIdGenerator: attemptB.generate
    });

    const operationA = trackOperation(
      scenario,
      prepareA({ userId: fixture.userId, runId: run.runId, highCostConfirmed: false })
    );
    await aReclaimCompleted.wait();
    const operationB = trackOperation(
      scenario,
      prepareB({ userId: fixture.userId, runId: run.runId, highCostConfirmed: false })
    );
    await bPolicyLockAttempted.wait();
    await assertObservedLockWait(scenario.observer, scenario.actorB, scenario.actorA);
    assert.equal(
      bPolicyLockCompleted,
      false,
      "expired reclaim B policy-lock query must still be in flight"
    );

    releaseATx1.resolve();
    await aPlanner.called.wait();
    await assertNoIdleTransactions(scenario.observer, [scenario.actorA]);
    const reclaimed = await requireRun(scenario.observer, fixture.userId, run.runId);
    assert.equal(reclaimed.state, "PREPARING");
    assert.equal(reclaimed.stateVersion, initialVersion + 1);
    assert.equal(reclaimed.prepareAttemptId, attemptAId);
    assert.equal(reclaimed.firstPreparingAt?.toISOString(), historicalFirstPreparingAt.toISOString());
    assert.equal(
      reclaimed.prepareLeaseExpiresAt?.toISOString(),
      new Date(reclaimAt.getTime() + PREPARE_LEASE_MS).toISOString()
    );
    const bSettled = await withTimeout(
      Promise.allSettled([operationB]),
      OPERATION_TIMEOUT_MS,
      "expired reclaim B rejection"
    );
    const errorB = requireRejected(bSettled[0], scenario.actorB, "expired-reclaim-B");
    assertPublicError(errorB, { code: "RUN_PREPARATION_IN_PROGRESS", status: 409 });
    assert.deepEqual(await requireRun(scenario.observer, fixture.userId, run.runId), reclaimed);
    assert.equal(bRunMutations, 0);
    assert.equal(bPlannerCalls, 0);
    attemptB.assertCalls(0);

    aPlanner.release.resolve();
    const aSettled = await withTimeout(
      Promise.allSettled([operationA]),
      OPERATION_TIMEOUT_MS,
      "expired reclaim A completion"
    );
    const resultA = requireFulfilled(aSettled[0], scenario.actorA, "expired-reclaim-A");
    assert.equal(
      bPolicyLockCompleted,
      true,
      "expired reclaim B policy-lock query must complete after holder release"
    );
    assert.equal(resultA.state, "READY");
    assert.equal(resultA.stateVersion, initialVersion + 2);
    const finalRun = await requireRun(scenario.observer, fixture.userId, run.runId);
    assert.equal(finalRun.state, "READY");
    assert.equal(finalRun.stateVersion, initialVersion + 2);
    assert.equal(finalRun.firstPreparingAt?.toISOString(), historicalFirstPreparingAt.toISOString());
    assert.equal(finalRun.prepareAttemptId, null);
    assert.equal(finalRun.prepareLeaseExpiresAt, null);
    await assertPlanBelongsTo(scenario.observer, fixture.userId, finalRun, "expired-reclaim-a");
    assert.equal(
      await scenario.observer.client.applicationRun.count({
        where: {
          userId: fixture.userId,
          firstPreparingAt: { gte: dailyCapWindowStart(reclaimAt) }
        }
      }),
      1
    );
    const audits = await readAudits(scenario.observer, fixture.userId);
    const events = await readEvents(scenario.observer, fixture.userId);
    assert.equal(audits.length, 2);
    assert.equal(events.length, 2);
    assertAcquireRecords(audits, events, {
      userId: fixture.userId,
      run,
      previousState: "PREPARING",
      stateVersion: initialVersion + 1,
      acquisition: "retry-acquire"
    });
    assertCompletionRecords(audits, events, {
      userId: fixture.userId,
      run,
      stateVersion: initialVersion + 2
    });
    assert.equal(aReclaimMatches, 1);
    aPlanner.assertCalls(1);
    attemptA.assertCalls(1);
    clockA.assertCalls(2);
    clockB.assertCalls(1);
    aHooks.assertExpectedHooksReached();
    bHooks.assertExpectedHooksReached();
    await assertScenarioSessionsPinned(scenario, "expired-reclaim-complete");
  });
});

test("a stale successful planner result cannot overwrite a reclaimed attempt", async () => {
  const scenario = await createScenario("preparation-stale-success");
  const acquireAAt = new Date("2036-01-04T00:00:00.000Z");
  const reclaimBAt = new Date(acquireAAt.getTime() + PREPARE_LEASE_MS + 1_000);
  const completeBAt = new Date(reclaimBAt.getTime() + 1_000);
  const unusedStaleAAt = new Date(reclaimBAt.getTime() + 500);
  await runScenarioBody(scenario, async () => {
    const fixture = await createEligibleUser(scenario, "user");
    const run = await createEligibleRun(scenario.observer, fixture.userId, "stale-success");
    const attemptAId = "c54-stale-success-attempt-a";
    const attemptBId = "c54-stale-success-attempt-b";
    const aLockOrder: string[] = [];
    const aHooks = createHookedPrismaClient(scenario.actorA, [
      { name: "stale success A rolling count", match: RUN_COUNT },
      {
        name: "stale success A TX1 and TX2 policy locks",
        match: POLICY_ROW_LOCK,
        expectedMatches: 2,
        after: () => {
          aLockOrder.push("policy");
        }
      },
      {
        name: "stale success A TX1 and TX2 run locks",
        match: RUN_ROW_LOCK,
        expectedMatches: 2,
        after: () => {
          aLockOrder.push("run");
        }
      }
    ]);
    const bLockOrder: string[] = [];
    const bHooks = createHookedPrismaClient(scenario.actorB, [
      { name: "stale success B skips rolling count on reclaim", match: RUN_COUNT, expectedMatches: 0 },
      {
        name: "stale success B TX1 and TX2 policy locks",
        match: POLICY_ROW_LOCK,
        expectedMatches: 2,
        after: () => {
          bLockOrder.push("policy");
        }
      },
      {
        name: "stale success B TX1 and TX2 run locks",
        match: RUN_ROW_LOCK,
        expectedMatches: 2,
        after: () => {
          bLockOrder.push("run");
        }
      }
    ]);
    const aProbe: StaleFinalizationProbe = {
      acquisitionMutations: 0,
      lifecycleMutationAttempts: 0,
      completionAuditAttempts: 0,
      completionEventAttempts: 0
    };
    const aClient = extendStaleFinalizationProbeClient(
      aHooks.prismaClient,
      "c54StaleSuccessFinalizationProbe",
      {
        userId: fixture.userId,
        runId: run.runId,
        applicationId: run.applicationId,
        acquisitionAttemptId: attemptAId
      },
      aProbe
    );
    let bSuccessfulMutations = 0;
    const bClient = extendRunMutationClient(
      bHooks.prismaClient,
      "c54StaleSuccessWinnerCasProbe",
      (view) => {
        if (view.data.state !== "READY" && view.data.state !== "REVIEW_REQUIRED") return;
        assert.equal(view.where.id, run.runId);
        assert.equal(view.where.userId, fixture.userId);
        assert.equal(view.where.state, "PREPARING");
        assert.equal(view.where.prepareAttemptId, attemptBId);
        assert.equal(view.where.stateVersion, 2);
        assert.equal(view.data.state, "READY");
        assert.ok(view.data.preparedAt instanceof Date);
        assert.equal(view.data.preparedAt.toISOString(), completeBAt.toISOString());
        assert.equal(view.data.prepareAttemptId, null);
        assert.equal(view.data.prepareLeaseExpiresAt, null);
        assert.equal(isIncrementOne(view.data.stateVersion), true);
        assert.equal(view.count, 1);
        bSuccessfulMutations += 1;
      }
    );
    const plannerA = createPausedPlanner(
      scenario,
      "stale success A",
      fixture.userId,
      () => fixedCleanPlan("stale-success-a")
    );
    const plannerB = createPausedPlanner(
      scenario,
      "stale success B",
      fixture.userId,
      () => fixedCleanPlan("stale-success-b")
    );
    const clockA = queuedClock("stale success A", [acquireAAt, unusedStaleAAt]);
    const clockB = queuedClock("stale success B", [reclaimBAt, completeBAt]);
    const attemptA = trackedAttemptId("stale success A", attemptAId);
    const attemptB = trackedAttemptId("stale success B", attemptBId);
    const prepareA = createPreparation(aClient, {
      planner: plannerA.planner,
      clock: clockA.clock,
      attemptIdGenerator: attemptA.generate
    });
    const prepareB = createPreparation(bClient, {
      planner: plannerB.planner,
      clock: clockB.clock,
      attemptIdGenerator: attemptB.generate
    });

    const operationA = trackOperation(
      scenario,
      prepareA({ userId: fixture.userId, runId: run.runId, highCostConfirmed: false })
    );
    await plannerA.called.wait();
    await assertNoIdleTransactions(scenario.observer, [scenario.actorA]);
    const operationB = trackOperation(
      scenario,
      prepareB({ userId: fixture.userId, runId: run.runId, highCostConfirmed: false })
    );
    await plannerB.called.wait();
    await assertNoIdleTransactions(scenario.observer, [scenario.actorA, scenario.actorB]);
    plannerA.assertCalls(1);
    plannerB.assertCalls(1);
    clockA.assertCalls(1);
    clockB.assertCalls(1);
    assert.deepEqual(aLockOrder, ["policy", "run"]);
    assert.deepEqual(bLockOrder, ["policy", "run"]);

    const ownerBeforeA = await requireRun(scenario.observer, fixture.userId, run.runId);
    assert.equal(ownerBeforeA.state, "PREPARING");
    assert.equal(ownerBeforeA.stateVersion, 2);
    assert.equal(ownerBeforeA.prepareAttemptId, attemptBId);
    assert.ok(ownerBeforeA.prepareLeaseExpiresAt);
    assert.equal(
      ownerBeforeA.prepareLeaseExpiresAt.toISOString(),
      new Date(reclaimBAt.getTime() + PREPARE_LEASE_MS).toISOString()
    );
    assert.ok(ownerBeforeA.prepareLeaseExpiresAt.getTime() > reclaimBAt.getTime());
    assert.equal(ownerBeforeA.firstPreparingAt?.toISOString(), acquireAAt.toISOString());
    assert.equal(ownerBeforeA.activeRunKey, run.applicationId);
    assert.equal(ownerBeforeA.preparedAt, null);
    assert.equal(ownerBeforeA.cancelledAt, null);
    assert.equal(ownerBeforeA.blockingReason, null);
    assert.equal(ownerBeforeA.errorCategory, null);
    await assertNoPlanSnapshots(scenario.observer, fixture.userId, ownerBeforeA);
    const projectionBeforeA = await requireSnapshotProjection(
      scenario.observer,
      fixture.userId,
      run.runId
    );
    const auditsBeforeA = await readAudits(scenario.observer, fixture.userId);
    const eventsBeforeA = await readEvents(scenario.observer, fixture.userId);
    assert.equal(auditsBeforeA.length, 2);
    assert.equal(eventsBeforeA.length, 2);
    assertAcquireRecords(auditsBeforeA, eventsBeforeA, {
      userId: fixture.userId,
      run,
      previousState: "DRAFT",
      stateVersion: 1,
      acquisition: "first-acquire"
    });
    assertAcquireRecords(auditsBeforeA, eventsBeforeA, {
      userId: fixture.userId,
      run,
      previousState: "PREPARING",
      stateVersion: 2,
      acquisition: "retry-acquire"
    });
    assert.equal(
      auditsFor(auditsBeforeA, "application-run.prepare.complete", "ApplicationRun", run.runId).length,
      0
    );
    assert.equal(eventsFor(eventsBeforeA, run.applicationId, "Application run preparation ready").length, 0);

    plannerA.release.resolve();
    const aSettled = await withTimeout(
      Promise.allSettled([operationA]),
      OPERATION_TIMEOUT_MS,
      "stale success A stale finalization"
    );
    const errorA = requireRejected(aSettled[0], scenario.actorA, "stale-success-A");
    assertPublicError(errorA, { code: "RUN_PREPARATION_STALE", status: 409 });
    assert.deepEqual(aLockOrder, ["policy", "run", "policy", "run"]);
    aHooks.assertExpectedHooksReached();
    assert.equal(aProbe.acquisitionMutations, 1);
    assert.equal(aProbe.lifecycleMutationAttempts, 0);
    assert.equal(aProbe.completionAuditAttempts, 0);
    assert.equal(aProbe.completionEventAttempts, 0);
    const ownerAfterA = await requireRun(scenario.observer, fixture.userId, run.runId);
    assert.deepEqual(ownerAfterA, ownerBeforeA);
    assert.equal(ownerAfterA.state, "PREPARING");
    assert.equal(ownerAfterA.stateVersion, 2);
    assert.equal(ownerAfterA.prepareAttemptId, attemptBId);
    assert.deepEqual(
      await requireSnapshotProjection(scenario.observer, fixture.userId, run.runId),
      projectionBeforeA
    );
    assert.deepEqual(await readAudits(scenario.observer, fixture.userId), auditsBeforeA);
    assert.deepEqual(await readEvents(scenario.observer, fixture.userId), eventsBeforeA);
    await assertNoIdleTransactions(scenario.observer, [scenario.actorA, scenario.actorB]);
    clockA.assertCallsBetween(1, 2);
    clockB.assertCalls(1);

    plannerB.release.resolve();
    const bSettled = await withTimeout(
      Promise.allSettled([operationB]),
      OPERATION_TIMEOUT_MS,
      "stale success B completion"
    );
    const resultB = requireFulfilled(bSettled[0], scenario.actorB, "stale-success-B");
    assert.equal(resultB.state, "READY");
    assert.equal(resultB.stateVersion, 3);
    const finalRun = await requireRun(scenario.observer, fixture.userId, run.runId);
    assert.equal(finalRun.state, "READY");
    assert.equal(finalRun.stateVersion, 3);
    assert.equal(finalRun.firstPreparingAt?.toISOString(), acquireAAt.toISOString());
    assert.equal(finalRun.preparedAt?.toISOString(), completeBAt.toISOString());
    assert.equal(finalRun.prepareAttemptId, null);
    assert.equal(finalRun.prepareLeaseExpiresAt, null);
    assert.equal(finalRun.blockingReason, null);
    assert.equal(finalRun.errorCategory, null);
    await assertPlanBelongsTo(scenario.observer, fixture.userId, finalRun, "stale-success-b");
    const audits = await readAudits(scenario.observer, fixture.userId);
    const events = await readEvents(scenario.observer, fixture.userId);
    assert.equal(audits.length, 3);
    assert.equal(events.length, 3);
    assertAcquireRecords(audits, events, {
      userId: fixture.userId,
      run,
      previousState: "DRAFT",
      stateVersion: 1,
      acquisition: "first-acquire"
    });
    assertAcquireRecords(audits, events, {
      userId: fixture.userId,
      run,
      previousState: "PREPARING",
      stateVersion: 2,
      acquisition: "retry-acquire"
    });
    assertCompletionRecords(audits, events, { userId: fixture.userId, run, stateVersion: 3 });
    assert.equal(
      auditsFor(audits, "application-run.prepare.complete", "ApplicationRun", run.runId).length,
      1
    );
    assert.equal(eventsFor(events, run.applicationId, "Application run preparation ready").length, 1);
    assert.equal(aProbe.lifecycleMutationAttempts, 0);
    assert.equal(aProbe.completionAuditAttempts, 0);
    assert.equal(aProbe.completionEventAttempts, 0);
    assert.equal(bSuccessfulMutations, 1);
    plannerA.assertCalls(1);
    plannerB.assertCalls(1);
    attemptA.assertCalls(1);
    attemptB.assertCalls(1);
    clockA.assertCallsBetween(1, 2);
    clockB.assertCalls(2);
    assert.deepEqual(bLockOrder, ["policy", "run", "policy", "run"]);
    bHooks.assertExpectedHooksReached();
    await assertScenarioSessionsPinned(scenario, "stale-success-complete");
  });
});

test("a stale planner failure cannot overwrite a reclaimed successful attempt", async () => {
  const scenario = await createScenario("preparation-stale-failure");
  const acquireAAt = new Date("2036-01-05T00:00:00.000Z");
  const reclaimBAt = new Date(acquireAAt.getTime() + PREPARE_LEASE_MS + 1_000);
  const completeBAt = new Date(reclaimBAt.getTime() + 1_000);
  const unusedStaleAAt = new Date(completeBAt.getTime() + 1_000);
  await runScenarioBody(scenario, async () => {
    const fixture = await createEligibleUser(scenario, "user");
    const run = await createEligibleRun(scenario.observer, fixture.userId, "stale-failure");
    const attemptAId = "c54-stale-failure-attempt-a";
    const attemptBId = "c54-stale-failure-attempt-b";
    const aHooks = createHookedPrismaClient(scenario.actorA, [
      { name: "stale failure A rolling count", match: RUN_COUNT },
      { name: "stale failure A TX1 and failure-finalizer run locks", match: RUN_ROW_LOCK, expectedMatches: 2 }
    ]);
    const bHooks = createHookedPrismaClient(scenario.actorB, [
      { name: "stale failure B skips rolling count on reclaim", match: RUN_COUNT, expectedMatches: 0 },
      { name: "stale failure B TX1 and TX2 run locks", match: RUN_ROW_LOCK, expectedMatches: 2 }
    ]);
    let aFailedMutations = 0;
    let aDisabledMutations = 0;
    const aClient = extendRunMutationClient(
      aHooks.prismaClient,
      "c54StaleFailureMutationCounter",
      (view) => {
        if (isFailedMutation(view, run.runId, "planner_provider_failure")) aFailedMutations += 1;
        if (isDisabledDuringProviderMutation(view, run.runId)) aDisabledMutations += 1;
      }
    );
    const plannerA = createPausedPlanner(scenario, "stale failure A", fixture.userId, () => {
      throw new Error("C5.4 fixed stale planner failure.");
    });
    const plannerB = createImmediatePlanner("stale failure B", fixture.userId, "stale-failure-b");
    const clockA = queuedClock("stale failure A", [acquireAAt, unusedStaleAAt]);
    const clockB = queuedClock("stale failure B", [reclaimBAt, completeBAt]);
    const attemptA = trackedAttemptId("stale failure A", attemptAId);
    const attemptB = trackedAttemptId("stale failure B", attemptBId);
    const prepareA = createPreparation(aClient, {
      planner: plannerA.planner,
      clock: clockA.clock,
      attemptIdGenerator: attemptA.generate
    });
    const prepareB = createPreparation(bHooks.prismaClient, {
      planner: plannerB.planner,
      clock: clockB.clock,
      attemptIdGenerator: attemptB.generate
    });

    const operationA = trackOperation(
      scenario,
      prepareA({ userId: fixture.userId, runId: run.runId, highCostConfirmed: false })
    );
    await plannerA.called.wait();
    await assertNoIdleTransactions(scenario.observer, [scenario.actorA]);
    const operationB = trackOperation(
      scenario,
      prepareB({ userId: fixture.userId, runId: run.runId, highCostConfirmed: false })
    );
    const bSettled = await withTimeout(
      Promise.allSettled([operationB]),
      OPERATION_TIMEOUT_MS,
      "stale failure B reclaim and completion"
    );
    const resultB = requireFulfilled(bSettled[0], scenario.actorB, "stale-failure-B");
    assert.equal(resultB.state, "READY");
    assert.equal(resultB.stateVersion, 3);
    const winnerBeforeA = await requireRun(scenario.observer, fixture.userId, run.runId);
    await assertPlanBelongsTo(scenario.observer, fixture.userId, winnerBeforeA, "stale-failure-b");
    assert.equal(winnerBeforeA.errorCategory, null);
    assert.equal(winnerBeforeA.blockingReason, null);
    assert.equal(winnerBeforeA.prepareAttemptId, null);
    assert.equal(winnerBeforeA.prepareLeaseExpiresAt, null);
    const winnerAuditsBeforeA = await readAudits(scenario.observer, fixture.userId);
    const winnerEventsBeforeA = await readEvents(scenario.observer, fixture.userId);
    assert.equal(winnerAuditsBeforeA.length, 3);
    assert.equal(winnerEventsBeforeA.length, 3);
    assertAcquireRecords(winnerAuditsBeforeA, winnerEventsBeforeA, {
      userId: fixture.userId,
      run,
      previousState: "DRAFT",
      stateVersion: 1,
      acquisition: "first-acquire"
    });
    assertAcquireRecords(winnerAuditsBeforeA, winnerEventsBeforeA, {
      userId: fixture.userId,
      run,
      previousState: "PREPARING",
      stateVersion: 2,
      acquisition: "retry-acquire"
    });
    assertCompletionRecords(winnerAuditsBeforeA, winnerEventsBeforeA, {
      userId: fixture.userId,
      run,
      stateVersion: 3
    });

    plannerA.release.resolve();
    const aSettled = await withTimeout(
      Promise.allSettled([operationA]),
      OPERATION_TIMEOUT_MS,
      "stale failure A stale finalization"
    );
    const errorA = requireRejected(aSettled[0], scenario.actorA, "stale-failure-A");
    assertPublicError(errorA, { code: "RUN_PREPARATION_STALE", status: 409 });
    const finalRun = await requireRun(scenario.observer, fixture.userId, run.runId);
    assert.deepEqual(finalRun, winnerBeforeA);
    assert.equal(finalRun.state, "READY");
    assert.equal(finalRun.stateVersion, 3);
    assert.equal(finalRun.preparedAt?.toISOString(), completeBAt.toISOString());
    await assertPlanBelongsTo(scenario.observer, fixture.userId, finalRun, "stale-failure-b");
    const audits = await readAudits(scenario.observer, fixture.userId);
    const events = await readEvents(scenario.observer, fixture.userId);
    assert.deepEqual(audits, winnerAuditsBeforeA);
    assert.deepEqual(events, winnerEventsBeforeA);
    assertAcquireRecords(audits, events, {
      userId: fixture.userId,
      run,
      previousState: "DRAFT",
      stateVersion: 1,
      acquisition: "first-acquire"
    });
    assertAcquireRecords(audits, events, {
      userId: fixture.userId,
      run,
      previousState: "PREPARING",
      stateVersion: 2,
      acquisition: "retry-acquire"
    });
    assertCompletionRecords(audits, events, { userId: fixture.userId, run, stateVersion: 3 });
    assert.equal(auditsFor(audits, "application-run.prepare.failed", "ApplicationRun", run.runId).length, 0);
    assert.equal(
      auditsFor(audits, "application-run.prepare.provider-blocked", "ApplicationRun", run.runId).length,
      0
    );
    assert.equal(eventsFor(events, run.applicationId, "Application run preparation failed").length, 0);
    assert.equal(eventsFor(events, run.applicationId, "Application run preparation blocked").length, 0);
    assert.equal(aFailedMutations, 0);
    assert.equal(aDisabledMutations, 0);
    plannerA.assertCalls(1);
    plannerB.assertCalls(1);
    attemptA.assertCalls(1);
    attemptB.assertCalls(1);
    clockA.assertCallsBetween(1, 2);
    clockB.assertCalls(2);
    aHooks.assertExpectedHooksReached();
    bHooks.assertExpectedHooksReached();
    await assertScenarioSessionsPinned(scenario, "stale-failure-complete");
  });
});

test("cancellation committed before preparation TX2 makes the planner result stale", async () => {
  const scenario = await createScenario("preparation-cancel-before-tx2");
  const acquireAt = new Date("2036-01-06T00:00:00.000Z");
  const cancelledAt = new Date("2036-01-06T00:00:01.000Z");
  const unusedStaleAAt = new Date(cancelledAt.getTime() + 1_000);
  await runScenarioBody(scenario, async () => {
    const fixture = await createEligibleUser(scenario, "user");
    const run = await createEligibleRun(scenario.observer, fixture.userId, "cancel-before-tx2");
    const attemptId = "c54-cancel-before-tx2-attempt";
    const aHooks = createHookedPrismaClient(scenario.actorA, [
      { name: "cancel before TX2 A rolling count", match: RUN_COUNT },
      { name: "cancel before TX2 A TX1 and stale TX2 run locks", match: RUN_ROW_LOCK, expectedMatches: 2 }
    ]);
    let aReadyMutations = 0;
    const aClient = extendRunMutationClient(
      aHooks.prismaClient,
      "c54CancelBeforeTx2MutationCounter",
      (view) => {
        if (isReadyMutation(view, run.runId, attemptId)) aReadyMutations += 1;
      }
    );
    const plannerA = createPausedPlanner(
      scenario,
      "cancel before TX2 A",
      fixture.userId,
      () => fixedCleanPlan("cancel-before-tx2-a")
    );
    const clockA = queuedClock("cancel before TX2 A", [acquireAt, unusedStaleAAt]);
    const attemptA = trackedAttemptId("cancel before TX2 A", attemptId);
    const cancelClock = queuedClock("cancel before TX2 B", [cancelledAt]);
    const prepareA = createPreparation(aClient, {
      planner: plannerA.planner,
      clock: clockA.clock,
      attemptIdGenerator: attemptA.generate
    });
    const serviceB = createApplicationRunService({
      prismaClient: scenario.actorB.client,
      env: GLOBAL_AUTOMATION_ENABLED,
      clock: cancelClock.clock
    });

    const operationA = trackOperation(
      scenario,
      prepareA({ userId: fixture.userId, runId: run.runId, highCostConfirmed: false })
    );
    await plannerA.called.wait();
    await assertNoIdleTransactions(scenario.observer, [scenario.actorA]);
    const operationB = trackOperation(
      scenario,
      serviceB.cancelApplicationRun({ userId: fixture.userId, runId: run.runId })
    );
    const bSettled = await withTimeout(
      Promise.allSettled([operationB]),
      OPERATION_TIMEOUT_MS,
      "cancel before TX2 completion"
    );
    const resultB = requireFulfilled(bSettled[0], scenario.actorB, "cancel-before-tx2-B");
    assert.equal(resultB.run.state, "CANCELLED");
    assert.equal(resultB.run.stateVersion, 2);
    assert.equal(resultB.revokedExecutionTokenCount, 0);
    const cancelledBeforeA = await requireRun(scenario.observer, fixture.userId, run.runId);
    assert.equal(cancelledBeforeA.state, "CANCELLED");
    assert.equal(cancelledBeforeA.stateVersion, 2);
    assert.equal(cancelledBeforeA.cancelledAt?.toISOString(), cancelledAt.toISOString());
    assert.equal(cancelledBeforeA.firstPreparingAt?.toISOString(), acquireAt.toISOString());
    assert.equal(cancelledBeforeA.activeRunKey, null);
    assert.equal(cancelledBeforeA.prepareAttemptId, null);
    assert.equal(cancelledBeforeA.prepareLeaseExpiresAt, null);
    await assertNoPlanSnapshots(scenario.observer, fixture.userId, cancelledBeforeA);

    plannerA.release.resolve();
    const aSettled = await withTimeout(
      Promise.allSettled([operationA]),
      OPERATION_TIMEOUT_MS,
      "cancel before TX2 stale preparation"
    );
    const errorA = requireRejected(aSettled[0], scenario.actorA, "cancel-before-tx2-A");
    assertPublicError(errorA, { code: "RUN_PREPARATION_STALE", status: 409 });
    const finalRun = await requireRun(scenario.observer, fixture.userId, run.runId);
    assert.deepEqual(finalRun, cancelledBeforeA);
    await assertNoPlanSnapshots(scenario.observer, fixture.userId, finalRun);
    const audits = await readAudits(scenario.observer, fixture.userId);
    const events = await readEvents(scenario.observer, fixture.userId);
    assert.equal(audits.length, 3);
    assert.equal(events.length, 2);
    assertAcquireRecords(audits, events, {
      userId: fixture.userId,
      run,
      previousState: "DRAFT",
      stateVersion: 1,
      acquisition: "first-acquire"
    });
    assertBulkRevocationAudit(
      requireSingleAudit(
        audits,
        "application-execution-token.revoke-bulk",
        "ApplicationRun",
        run.runId
      ),
      {
        userId: fixture.userId,
        resource: "ApplicationRun",
        resourceId: run.runId,
        runId: run.runId,
        reason: "run_cancelled",
        revokedAt: cancelledAt
      }
    );
    assertCancellationRecords(audits, events, {
      userId: fixture.userId,
      run,
      previousState: "PREPARING",
      previousStateVersion: 1,
      cancelledAt
    });
    assert.equal(auditsFor(audits, "application-run.prepare.complete", "ApplicationRun", run.runId).length, 0);
    assert.equal(eventsFor(events, run.applicationId, "Application run preparation ready").length, 0);
    assert.equal(aReadyMutations, 0);
    await assertNoExecutionTokens(scenario.observer, fixture.userId);
    plannerA.assertCalls(1);
    attemptA.assertCalls(1);
    clockA.assertCallsBetween(1, 2);
    cancelClock.assertCalls(1);
    aHooks.assertExpectedHooksReached();
    await assertScenarioSessionsPinned(scenario, "cancel-before-tx2-complete");
  });
});

test("preparation TX2 committed before cancellation yields READY then CANCELLED", async () => {
  const scenario = await createScenario("preparation-tx2-before-cancel");
  const acquireAt = new Date("2036-01-07T00:00:00.000Z");
  const completeAt = new Date("2036-01-07T00:00:01.000Z");
  const cancelledAt = new Date("2036-01-07T00:00:02.000Z");
  await runScenarioBody(scenario, async () => {
    const fixture = await createEligibleUser(scenario, "user");
    const run = await createEligibleRun(scenario.observer, fixture.userId, "tx2-before-cancel");
    const attemptId = "c54-tx2-before-cancel-attempt";
    const aReadyCompleted = deferred("TX2 before cancel A ready mutation completed");
    const releaseATx2 = trackRelease(scenario, deferred("release TX2 before cancel A TX2"));
    const bRunLockAttempted = deferred("TX2 before cancel B run lock attempted");
    const aHooks = createHookedPrismaClient(scenario.actorA, [
      { name: "TX2 before cancel A rolling count", match: RUN_COUNT },
      { name: "TX2 before cancel A TX1 and TX2 run locks", match: RUN_ROW_LOCK, expectedMatches: 2 }
    ]);
    let aReadyMatches = 0;
    const aClient = extendRunMutationClient(
      aHooks.prismaClient,
      "c54Tx2BeforeCancelPause",
      async (view) => {
        if (!isReadyMutation(view, run.runId, attemptId)) return;
        assert.equal(view.where.userId, fixture.userId);
        assert.equal(view.where.stateVersion, 1);
        assert.equal((view.data.preparedAt as Date).toISOString(), completeAt.toISOString());
        assert.equal(view.count, 1);
        aReadyMatches += 1;
        aReadyCompleted.resolve();
        await releaseATx2.wait();
      }
    );
    const bHooks = createHookedPrismaClient(scenario.actorB, [
      {
        name: "TX2 before cancel B run lock attempt",
        match: RUN_ROW_LOCK,
        before: () => bRunLockAttempted.resolve()
      }
    ]);
    const plannerA = createImmediatePlanner("TX2 before cancel A", fixture.userId, "tx2-before-cancel-a");
    const clockA = queuedClock("TX2 before cancel A", [acquireAt, completeAt]);
    const attemptA = trackedAttemptId("TX2 before cancel A", attemptId);
    const cancelClock = queuedClock("TX2 before cancel B", [cancelledAt]);
    const prepareA = createPreparation(aClient, {
      planner: plannerA.planner,
      clock: clockA.clock,
      attemptIdGenerator: attemptA.generate
    });
    const serviceB = createApplicationRunService({
      prismaClient: bHooks.prismaClient,
      env: GLOBAL_AUTOMATION_ENABLED,
      clock: cancelClock.clock
    });

    const operationA = trackOperation(
      scenario,
      prepareA({ userId: fixture.userId, runId: run.runId, highCostConfirmed: false })
    );
    await aReadyCompleted.wait();
    const operationB = trackOperation(
      scenario,
      serviceB.cancelApplicationRun({ userId: fixture.userId, runId: run.runId })
    );
    await bRunLockAttempted.wait();
    await assertObservedLockWait(scenario.observer, scenario.actorB, scenario.actorA);

    releaseATx2.resolve();
    const settled = await withTimeout(
      Promise.allSettled([operationA, operationB]),
      OPERATION_TIMEOUT_MS,
      "TX2 before cancel completion"
    );
    const resultA = requireFulfilled(settled[0], scenario.actorA, "tx2-before-cancel-A");
    const resultB = requireFulfilled(settled[1], scenario.actorB, "tx2-before-cancel-B");
    assert.equal(resultA.state, "READY");
    assert.equal(resultA.stateVersion, 2);
    assert.equal(resultA.preparedAt?.toISOString(), completeAt.toISOString());
    assert.equal(resultB.run.state, "CANCELLED");
    assert.equal(resultB.run.stateVersion, 3);
    assert.equal(resultB.revokedExecutionTokenCount, 0);
    const finalRun = await requireRun(scenario.observer, fixture.userId, run.runId);
    assert.equal(finalRun.state, "CANCELLED");
    assert.equal(finalRun.stateVersion, 3);
    assert.equal(finalRun.firstPreparingAt?.toISOString(), acquireAt.toISOString());
    assert.equal(finalRun.preparedAt?.toISOString(), completeAt.toISOString());
    assert.equal(finalRun.cancelledAt?.toISOString(), cancelledAt.toISOString());
    assert.equal(finalRun.activeRunKey, null);
    assert.equal(finalRun.prepareAttemptId, null);
    assert.equal(finalRun.prepareLeaseExpiresAt, null);
    assert.equal(finalRun.blockingReason, null);
    assert.equal(finalRun.errorCategory, null);
    await assertPlanBelongsTo(scenario.observer, fixture.userId, finalRun, "tx2-before-cancel-a");
    const audits = await readAudits(scenario.observer, fixture.userId);
    const events = await readEvents(scenario.observer, fixture.userId);
    assert.equal(audits.length, 4);
    assert.equal(events.length, 3);
    assertAcquireRecords(audits, events, {
      userId: fixture.userId,
      run,
      previousState: "DRAFT",
      stateVersion: 1,
      acquisition: "first-acquire"
    });
    assertCompletionRecords(audits, events, { userId: fixture.userId, run, stateVersion: 2 });
    assertBulkRevocationAudit(
      requireSingleAudit(
        audits,
        "application-execution-token.revoke-bulk",
        "ApplicationRun",
        run.runId
      ),
      {
        userId: fixture.userId,
        resource: "ApplicationRun",
        resourceId: run.runId,
        runId: run.runId,
        reason: "run_cancelled",
        revokedAt: cancelledAt
      }
    );
    assertCancellationRecords(audits, events, {
      userId: fixture.userId,
      run,
      previousState: "READY",
      previousStateVersion: 2,
      cancelledAt
    });
    assert.equal(aReadyMatches, 1);
    await assertNoExecutionTokens(scenario.observer, fixture.userId);
    plannerA.assertCalls(1);
    attemptA.assertCalls(1);
    clockA.assertCalls(2);
    cancelClock.assertCalls(1);
    aHooks.assertExpectedHooksReached();
    bHooks.assertExpectedHooksReached();
    await assertScenarioSessionsPinned(scenario, "tx2-before-cancel-complete");
  });
});

test("policy disable committed before preparation TX2 blocks the active attempt", async () => {
  const scenario = await createScenario("preparation-disable-before-tx2");
  const acquireAt = new Date("2036-01-08T00:00:00.000Z");
  const disabledAt = new Date("2036-01-08T00:00:01.000Z");
  await runScenarioBody(scenario, async () => {
    const fixture = await createEligibleUser(scenario, "user");
    const run = await createEligibleRun(scenario.observer, fixture.userId, "disable-before-tx2");
    const attemptId = "c54-disable-before-tx2-attempt";
    const aHooks = createHookedPrismaClient(scenario.actorA, [
      { name: "disable before TX2 A rolling count", match: RUN_COUNT },
      { name: "disable before TX2 A TX1 and kill-switch run locks", match: RUN_ROW_LOCK, expectedMatches: 2 }
    ]);
    let aDisabledMutations = 0;
    let aReadyMutations = 0;
    const aClient = extendRunMutationClient(
      aHooks.prismaClient,
      "c54DisableBeforeTx2MutationCounter",
      (view) => {
        if (isDisabledDuringProviderMutation(view, run.runId)) {
          assert.equal(view.where.userId, fixture.userId);
          assert.equal(view.where.state, "PREPARING");
          assert.equal(view.where.stateVersion, 1);
          assert.equal(view.where.prepareAttemptId, attemptId);
          assert.equal(view.count, 1);
          aDisabledMutations += 1;
        }
        if (isReadyMutation(view, run.runId, attemptId)) aReadyMutations += 1;
      }
    );
    const plannerA = createPausedPlanner(
      scenario,
      "disable before TX2 A",
      fixture.userId,
      () => fixedCleanPlan("disable-before-tx2-a")
    );
    const clockA = queuedClock("disable before TX2 A", [acquireAt]);
    const attemptA = trackedAttemptId("disable before TX2 A", attemptId);
    const policyClock = queuedClock("disable before TX2 B", [disabledAt]);
    const prepareA = createPreparation(aClient, {
      planner: plannerA.planner,
      clock: clockA.clock,
      attemptIdGenerator: attemptA.generate
    });
    const serviceB = createApplicationRunService({
      prismaClient: scenario.actorB.client,
      env: GLOBAL_AUTOMATION_ENABLED,
      clock: policyClock.clock
    });

    const operationA = trackOperation(
      scenario,
      prepareA({ userId: fixture.userId, runId: run.runId, highCostConfirmed: false })
    );
    await plannerA.called.wait();
    await assertNoIdleTransactions(scenario.observer, [scenario.actorA]);
    const operationB = trackOperation(
      scenario,
      serviceB.updateAutomationPolicy(fixture.userId, { enabled: false })
    );
    const bSettled = await withTimeout(
      Promise.allSettled([operationB]),
      OPERATION_TIMEOUT_MS,
      "disable before TX2 policy update"
    );
    const resultB = requireFulfilled(bSettled[0], scenario.actorB, "disable-before-tx2-B");
    assert.equal(resultB.changed, true);
    assert.equal(resultB.enabled, false);
    assert.equal(resultB.effectiveEnabled, false);
    assert.equal(resultB.revokedExecutionTokenCount, 0);
    const disabledPolicy = await requirePolicy(scenario.observer, fixture.userId);
    assert.equal(disabledPolicy.enabled, false);
    const midAudits = await readAudits(scenario.observer, fixture.userId);
    const midEvents = await readEvents(scenario.observer, fixture.userId);
    assert.equal(midAudits.length, 3);
    assert.equal(midEvents.length, 1);
    assertAcquireRecords(midAudits, midEvents, {
      userId: fixture.userId,
      run,
      previousState: "DRAFT",
      stateVersion: 1,
      acquisition: "first-acquire"
    });
    assertPolicyDisabledRecords(midAudits, {
      userId: fixture.userId,
      policyId: fixture.policy.id,
      disabledAt
    });

    plannerA.release.resolve();
    const aSettled = await withTimeout(
      Promise.allSettled([operationA]),
      OPERATION_TIMEOUT_MS,
      "disable before TX2 blocked finalization"
    );
    const errorA = requireRejected(aSettled[0], scenario.actorA, "disable-before-tx2-A");
    assertPublicError(errorA, {
      code: "AUTOMATION_DISABLED",
      status: 403,
      reason: "automation_disabled_during_preparation"
    });
    const finalRun = await requireRun(scenario.observer, fixture.userId, run.runId);
    assert.equal(finalRun.state, "BLOCKED");
    assert.equal(finalRun.stateVersion, 2);
    assert.equal(finalRun.blockingReason, "automation_disabled_during_preparation");
    assert.equal(finalRun.errorCategory, null);
    assert.equal(finalRun.activeRunKey, run.applicationId);
    assert.equal(finalRun.firstPreparingAt?.toISOString(), acquireAt.toISOString());
    assert.equal(finalRun.prepareAttemptId, null);
    assert.equal(finalRun.prepareLeaseExpiresAt, null);
    assert.equal(finalRun.preparedAt, null);
    await assertNoPlanSnapshots(scenario.observer, fixture.userId, finalRun);
    const audits = await readAudits(scenario.observer, fixture.userId);
    const events = await readEvents(scenario.observer, fixture.userId);
    assert.equal(audits.length, 4);
    assert.equal(events.length, 2);
    assertPolicyDisabledRecords(audits, {
      userId: fixture.userId,
      policyId: fixture.policy.id,
      disabledAt
    });
    assertPreparationAudit(
      requireSingleAudit(
        audits,
        "application-run.prepare.disabled-during-provider",
        "ApplicationRun",
        run.runId
      ),
      {
        userId: fixture.userId,
        action: "application-run.prepare.disabled-during-provider",
        runId: run.runId,
        metadata: {
          previousState: "PREPARING",
          nextState: "BLOCKED",
          stateVersion: 2,
          reason: "automation_disabled_during_preparation"
        }
      }
    );
    assertPreparationEvent(
      requireSingleEvent(events, run.applicationId, "Application run preparation blocked"),
      {
        userId: fixture.userId,
        applicationId: run.applicationId,
        title: "Application run preparation blocked",
        metadata: {
          runId: run.runId,
          state: "BLOCKED",
          stateVersion: 2,
          reason: "automation_disabled_during_preparation"
        }
      }
    );
    assert.equal(aDisabledMutations, 1);
    assert.equal(aReadyMutations, 0);
    await assertNoExecutionTokens(scenario.observer, fixture.userId);
    plannerA.assertCalls(1);
    attemptA.assertCalls(1);
    clockA.assertCalls(1);
    policyClock.assertCalls(1);
    aHooks.assertExpectedHooksReached();
    await assertScenarioSessionsPinned(scenario, "disable-before-tx2-complete");
  });
});

test("a cancellation fence takes precedence over a later policy disable", async () => {
  const scenario = await createScenario("preparation-stale-precedence");
  const acquireAt = new Date("2036-01-09T00:00:00.000Z");
  const cancelledAt = new Date("2036-01-09T00:00:01.000Z");
  const disabledAt = new Date("2036-01-09T00:00:02.000Z");
  const unusedStaleAAt = new Date(disabledAt.getTime() + 1_000);
  await runScenarioBody(scenario, async () => {
    const fixture = await createEligibleUser(scenario, "user");
    const run = await createEligibleRun(scenario.observer, fixture.userId, "stale-precedence");
    const attemptId = "c54-stale-precedence-attempt";
    const aHooks = createHookedPrismaClient(scenario.actorA, [
      { name: "stale precedence A rolling count", match: RUN_COUNT },
      { name: "stale precedence A TX1 and stale TX2 run locks", match: RUN_ROW_LOCK, expectedMatches: 2 }
    ]);
    let aDisabledMutations = 0;
    let aReadyMutations = 0;
    const aClient = extendRunMutationClient(
      aHooks.prismaClient,
      "c54StalePrecedenceMutationCounter",
      (view) => {
        if (isDisabledDuringProviderMutation(view, run.runId)) aDisabledMutations += 1;
        if (isReadyMutation(view, run.runId, attemptId)) aReadyMutations += 1;
      }
    );
    const plannerA = createPausedPlanner(
      scenario,
      "stale precedence A",
      fixture.userId,
      () => fixedCleanPlan("stale-precedence-a")
    );
    const clockA = queuedClock("stale precedence A", [acquireAt, unusedStaleAAt]);
    const attemptA = trackedAttemptId("stale precedence A", attemptId);
    const cancelClock = queuedClock("stale precedence cancellation B", [cancelledAt]);
    const policyClock = queuedClock("stale precedence policy B", [disabledAt]);
    const prepareA = createPreparation(aClient, {
      planner: plannerA.planner,
      clock: clockA.clock,
      attemptIdGenerator: attemptA.generate
    });
    const cancellationServiceB = createApplicationRunService({
      prismaClient: scenario.actorB.client,
      env: GLOBAL_AUTOMATION_ENABLED,
      clock: cancelClock.clock
    });
    const policyServiceB = createApplicationRunService({
      prismaClient: scenario.actorB.client,
      env: GLOBAL_AUTOMATION_ENABLED,
      clock: policyClock.clock
    });

    const operationA = trackOperation(
      scenario,
      prepareA({ userId: fixture.userId, runId: run.runId, highCostConfirmed: false })
    );
    await plannerA.called.wait();
    await assertNoIdleTransactions(scenario.observer, [scenario.actorA]);
    const cancellationOperation = trackOperation(
      scenario,
      cancellationServiceB.cancelApplicationRun({ userId: fixture.userId, runId: run.runId })
    );
    const cancellationSettled = await withTimeout(
      Promise.allSettled([cancellationOperation]),
      OPERATION_TIMEOUT_MS,
      "stale precedence cancellation"
    );
    const cancellationResult = requireFulfilled(
      cancellationSettled[0],
      scenario.actorB,
      "stale-precedence-cancel-B"
    );
    assert.equal(cancellationResult.run.state, "CANCELLED");
    assert.equal(cancellationResult.run.stateVersion, 2);
    assert.equal(cancellationResult.revokedExecutionTokenCount, 0);
    const policyOperation = trackOperation(
      scenario,
      policyServiceB.updateAutomationPolicy(fixture.userId, { enabled: false })
    );
    const policySettled = await withTimeout(
      Promise.allSettled([policyOperation]),
      OPERATION_TIMEOUT_MS,
      "stale precedence policy disable"
    );
    const policyResult = requireFulfilled(policySettled[0], scenario.actorB, "stale-precedence-policy-B");
    assert.equal(policyResult.changed, true);
    assert.equal(policyResult.enabled, false);
    assert.equal(policyResult.effectiveEnabled, false);
    assert.equal(policyResult.revokedExecutionTokenCount, 0);
    const committedRunBeforeA = await requireRun(scenario.observer, fixture.userId, run.runId);
    assert.equal(committedRunBeforeA.state, "CANCELLED");
    assert.equal(committedRunBeforeA.stateVersion, 2);
    assert.equal(committedRunBeforeA.cancelledAt?.toISOString(), cancelledAt.toISOString());
    await assertNoPlanSnapshots(scenario.observer, fixture.userId, committedRunBeforeA);
    const committedPolicyBeforeA = await requirePolicy(scenario.observer, fixture.userId);
    assert.equal(committedPolicyBeforeA.enabled, false);
    assert.equal((await readAudits(scenario.observer, fixture.userId)).length, 5);
    assert.equal((await readEvents(scenario.observer, fixture.userId)).length, 2);

    plannerA.release.resolve();
    const aSettled = await withTimeout(
      Promise.allSettled([operationA]),
      OPERATION_TIMEOUT_MS,
      "stale precedence A finalization"
    );
    const errorA = requireRejected(aSettled[0], scenario.actorA, "stale-precedence-A");
    assertPublicError(errorA, { code: "RUN_PREPARATION_STALE", status: 409 });
    const finalPolicy = await requirePolicy(scenario.observer, fixture.userId);
    assert.deepEqual(finalPolicy, committedPolicyBeforeA);
    const finalRun = await requireRun(scenario.observer, fixture.userId, run.runId);
    assert.deepEqual(finalRun, committedRunBeforeA);
    assert.equal(finalRun.state, "CANCELLED");
    assert.equal(finalRun.stateVersion, 2);
    assert.equal(finalRun.cancelledAt?.toISOString(), cancelledAt.toISOString());
    assert.equal(finalRun.firstPreparingAt?.toISOString(), acquireAt.toISOString());
    assert.equal(finalRun.activeRunKey, null);
    assert.equal(finalRun.prepareAttemptId, null);
    assert.equal(finalRun.prepareLeaseExpiresAt, null);
    assert.equal(finalRun.preparedAt, null);
    assert.equal(finalRun.blockingReason, null);
    assert.equal(finalRun.errorCategory, null);
    await assertNoPlanSnapshots(scenario.observer, fixture.userId, finalRun);
    const audits = await readAudits(scenario.observer, fixture.userId);
    const events = await readEvents(scenario.observer, fixture.userId);
    assert.equal(audits.length, 5);
    assert.equal(events.length, 2);
    assertAcquireRecords(audits, events, {
      userId: fixture.userId,
      run,
      previousState: "DRAFT",
      stateVersion: 1,
      acquisition: "first-acquire"
    });
    assertBulkRevocationAudit(
      requireSingleAudit(
        audits,
        "application-execution-token.revoke-bulk",
        "ApplicationRun",
        run.runId
      ),
      {
        userId: fixture.userId,
        resource: "ApplicationRun",
        resourceId: run.runId,
        runId: run.runId,
        reason: "run_cancelled",
        revokedAt: cancelledAt
      }
    );
    assertCancellationRecords(audits, events, {
      userId: fixture.userId,
      run,
      previousState: "PREPARING",
      previousStateVersion: 1,
      cancelledAt
    });
    assertPolicyDisabledRecords(audits, {
      userId: fixture.userId,
      policyId: fixture.policy.id,
      disabledAt
    });
    assert.equal(
      auditsFor(
        audits,
        "application-run.prepare.disabled-during-provider",
        "ApplicationRun",
        run.runId
      ).length,
      0
    );
    assert.equal(auditsFor(audits, "application-run.prepare.complete", "ApplicationRun", run.runId).length, 0);
    assert.equal(eventsFor(events, run.applicationId, "Application run preparation blocked").length, 0);
    assert.equal(eventsFor(events, run.applicationId, "Application run preparation ready").length, 0);
    assert.equal(aDisabledMutations, 0);
    assert.equal(aReadyMutations, 0);
    await assertNoExecutionTokens(scenario.observer, fixture.userId);
    plannerA.assertCalls(1);
    attemptA.assertCalls(1);
    clockA.assertCallsBetween(1, 2);
    cancelClock.assertCalls(1);
    policyClock.assertCalls(1);
    aHooks.assertExpectedHooksReached();
    await assertScenarioSessionsPinned(scenario, "stale-precedence-complete");
  });
});
