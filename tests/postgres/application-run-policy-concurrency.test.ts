import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "node:test";

import type { Prisma } from "@prisma/client";

import { PublicApiError } from "@/lib/api-errors";
import type { AutomationPolicyValues } from "@/lib/application-runs/contracts";
import {
  createExecutionTokenService,
  hashExecutionToken,
  isTokenLive
} from "@/lib/application-runs/execution-token";
import { automationPolicyDefaultValues, createApplicationRunService } from "@/lib/application-runs/service";
import {
  PostgresTestActorSessionChangedError,
  PostgresTestLateFailureError,
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
  lateFailureSentinel,
  waitForActorLockWait,
  withTimeout,
  type Deferred,
  type PostgresTestActor
} from "@/tests/postgres/postgres-test-harness";

const USER_POLICY_SERIALIZATION_LOCK = {
  kind: "queryRaw",
  includes: ['FROM "User"', "FOR NO KEY UPDATE"]
} as const;

const POLICY_ROW_LOCK = {
  kind: "queryRaw",
  includes: ['FROM "ApplicationAutomationPolicy"', "FOR UPDATE"]
} as const;

const RUN_ROW_LOCK = {
  kind: "queryRaw",
  includes: ['FROM "ApplicationRun"', "FOR UPDATE"]
} as const;

const AUDIT_CREATE = {
  kind: "model",
  model: "auditLog",
  method: "create"
} as const;

const POLICY_CREATE = {
  kind: "model",
  model: "applicationAutomationPolicy",
  method: "create"
} as const;

const POLICY_UPDATE = {
  kind: "model",
  model: "applicationAutomationPolicy",
  method: "update"
} as const;

const TOKEN_UPDATE_MANY = {
  kind: "model",
  model: "applicationExecutionToken",
  method: "updateMany"
} as const;

const TOKEN_CREATE = {
  kind: "model",
  model: "applicationExecutionToken",
  method: "create"
} as const;

const SYNTHETIC_HOST = "jobs.example.test";
const GLOBAL_AUTOMATION_ENABLED = { APPLICATION_AUTOMATION_ENABLED: "true" } as const;
const OLD_POLICY_TIME = new Date("2000-01-01T00:00:00.000Z");
const OPERATION_TIMEOUT_MS = 12_000;
const CLEANUP_OPERATION_TIMEOUT_MS = 5_000;
const CLEANUP_DISCONNECT_TIMEOUT_MS = 3_000;

const POLICY_ROW_SELECT = {
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
  action: true,
  resource: true,
  resourceId: true,
  metadata: true,
  createdAt: true
} as const satisfies Prisma.AuditLogSelect;

const SAFE_TOKEN_SELECT = {
  id: true,
  userId: true,
  runId: true,
  host: true,
  scope: true,
  singleUse: true,
  consumedAt: true,
  expiresAt: true,
  revokedAt: true,
  createdAt: true
} as const satisfies Prisma.ApplicationExecutionTokenSelect;

type PolicyRow = Prisma.ApplicationAutomationPolicyGetPayload<{ select: typeof POLICY_ROW_SELECT }>;
type SafeAudit = Prisma.AuditLogGetPayload<{ select: typeof SAFE_AUDIT_SELECT }>;
type SafeToken = Prisma.ApplicationExecutionTokenGetPayload<{ select: typeof SAFE_TOKEN_SELECT }>;

type CapturedFailure = { present: false } | { present: true; error: unknown };

type CleanupFailure = {
  phase: string;
  error: unknown;
};

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

type ReadyRunFixture = {
  jobPostingId: string;
  applicationId: string;
  runId: string;
  applyUrl: string;
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
        ({ phase }) => new Error(`Secondary C5.3 cleanup phase failed: ${phase}.`)
      );
      try {
        Object.defineProperty(primaryFailure.error, "cause", {
          value: new AggregateError(summaries, "One or more secondary C5.3 cleanup phases failed."),
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

async function createSyntheticUser(scenario: Scenario, label: string): Promise<{ id: string }> {
  const user = await createSyntheticTestUser(scenario.observer, `${scenario.label}-${label}`);
  scenario.syntheticUserIds.push(user.id);
  return { id: user.id };
}

async function readPolicyRows(observer: PostgresTestActor, userId: string): Promise<PolicyRow[]> {
  return observer.client.applicationAutomationPolicy.findMany({
    where: { userId },
    select: POLICY_ROW_SELECT
  }) as Promise<PolicyRow[]>;
}

async function requireSinglePolicy(observer: PostgresTestActor, userId: string): Promise<PolicyRow> {
  const policies = await readPolicyRows(observer, userId);
  assert.equal(policies.length, 1);
  return policies[0];
}

function assertPolicyValues(policy: PolicyRow, overrides: Partial<AutomationPolicyValues> = {}): void {
  const expected = { ...automationPolicyDefaultValues(), ...overrides };
  assert.equal(policy.enabled, expected.enabled);
  assert.equal(policy.mode, expected.mode);
  assert.equal(policy.minimumFitScore, expected.minimumFitScore);
  assert.equal(policy.minimumConfidenceScore, expected.minimumConfidenceScore);
  assert.equal(policy.dailyApplicationCap, expected.dailyApplicationCap);
  assert.deepEqual(policy.allowedHosts, expected.allowedHosts);
  assert.deepEqual(policy.blockedHosts, expected.blockedHosts);
  assert.deepEqual(policy.permittedAdapters, expected.permittedAdapters);
  assert.equal(policy.coverLetterRequired, expected.coverLetterRequired);
  assert.equal(policy.sensitiveAnswerPolicy, expected.sensitiveAnswerPolicy);
  assert.equal(policy.finalReviewRequired, expected.finalReviewRequired);
}

async function readAudits(observer: PostgresTestActor, userId: string): Promise<SafeAudit[]> {
  return observer.client.auditLog.findMany({
    where: { userId },
    select: SAFE_AUDIT_SELECT
  }) as Promise<SafeAudit[]>;
}

async function readSafeTokens(observer: PostgresTestActor, userId: string): Promise<SafeToken[]> {
  return observer.client.applicationExecutionToken.findMany({
    where: { userId },
    orderBy: { id: "asc" },
    select: SAFE_TOKEN_SELECT
  }) as Promise<SafeToken[]>;
}

function auditsWithAction(audits: readonly SafeAudit[], action: string): SafeAudit[] {
  return audits.filter((audit) => audit.action === action);
}

function requireSingleAudit(audits: readonly SafeAudit[], action: string): SafeAudit {
  const matching = auditsWithAction(audits, action);
  assert.equal(matching.length, 1, action);
  return matching[0];
}

function metadataRecord(audit: SafeAudit): Record<string, Prisma.JsonValue> {
  assert.ok(audit.metadata && typeof audit.metadata === "object" && !Array.isArray(audit.metadata));
  return audit.metadata as Record<string, Prisma.JsonValue>;
}

function assertPolicyChangeAudit(
  audit: SafeAudit,
  expected: {
    action: "application-automation-policy.create" | "application-automation-policy.update";
    policyId: string;
    changedFields: string[];
    enabled: boolean;
    revokedExecutionTokenCount: number;
    changedAt: Date;
  }
): void {
  assert.equal(audit.action, expected.action);
  assert.equal(audit.resource, "ApplicationAutomationPolicy");
  assert.equal(audit.resourceId, expected.policyId);
  assert.deepEqual(metadataRecord(audit), {
    changedFields: expected.changedFields,
    enabled: expected.enabled,
    revokedExecutionTokenCount: expected.revokedExecutionTokenCount,
    changedAt: expected.changedAt.toISOString()
  });
}

function assertBulkRevocationAudit(
  audit: SafeAudit,
  expected: { userId: string; revokedCount: number; revokedAt: Date }
): void {
  assert.equal(audit.action, "application-execution-token.revoke-bulk");
  assert.equal(audit.resource, "User");
  assert.equal(audit.resourceId, expected.userId);
  assert.deepEqual(metadataRecord(audit), {
    reason: "policy_changed",
    revokedCount: expected.revokedCount,
    revokedAt: expected.revokedAt.toISOString()
  });
}

async function assertNoApplicationEvents(observer: PostgresTestActor, userId: string): Promise<void> {
  assert.equal(await observer.client.applicationEvent.count({ where: { userId } }), 0);
}

async function assertScenarioSessionsPinned(scenario: Scenario, phase: string): Promise<void> {
  await assertNoIdleTransactions(scenario.observer, scenario.actors);
  for (const actor of scenario.actors) {
    await assertActorSessionPinned(actor, `${scenario.label}-${phase}`);
  }
}

async function createPersistedPolicy(
  observer: PostgresTestActor,
  userId: string,
  overrides: Partial<AutomationPolicyValues> = {}
): Promise<PolicyRow> {
  return observer.client.applicationAutomationPolicy.create({
    data: {
      userId,
      ...automationPolicyDefaultValues(),
      ...overrides,
      createdAt: OLD_POLICY_TIME,
      updatedAt: OLD_POLICY_TIME
    },
    select: POLICY_ROW_SELECT
  }) as Promise<PolicyRow>;
}

async function createReadyRunFixture(
  observer: PostgresTestActor,
  userId: string,
  label: string
): Promise<ReadyRunFixture> {
  const fixtureKey = `${label}-${randomUUID()}`;
  const applyUrl = `https://${SYNTHETIC_HOST}/apply/${fixtureKey}`;
  const jobPosting = await observer.client.jobPosting.create({
    data: {
      userId,
      title: `Commit 5 synthetic role ${fixtureKey}`,
      normalizedTitle: `commit-5-synthetic-role-${fixtureKey}`,
      company: "Commit 5 Synthetic Employer",
      normalizedCompany: `commit-5-synthetic-employer-${fixtureKey}`,
      normalizedLocation: "remote",
      sourceUrl: `https://${SYNTHETIC_HOST}/jobs/${fixtureKey}`,
      applyUrl,
      normalizedApplyUrl: applyUrl,
      description: "Synthetic C5.3 PostgreSQL concurrency fixture.",
      requirements: [],
      preferredQualifications: [],
      benefits: [],
      detectedTechStack: [],
      sourceType: "MANUAL",
      missingKeywords: [],
      supportedKeywords: [],
      concerns: []
    },
    select: { id: true }
  });
  const application = await observer.client.application.create({
    data: { userId, jobPostingId: jobPosting.id },
    select: { id: true }
  });
  const run = await observer.client.applicationRun.create({
    data: {
      userId,
      jobPostingId: jobPosting.id,
      applicationId: application.id,
      state: "READY",
      activeRunKey: application.id,
      idempotencyKey: `c53:${fixtureKey}`,
      applyUrlSnapshot: applyUrl,
      applyHost: SYNTHETIC_HOST,
      preparedAt: OLD_POLICY_TIME
    },
    select: { id: true }
  });
  return {
    jobPostingId: jobPosting.id,
    applicationId: application.id,
    runId: run.id,
    applyUrl
  };
}

function deterministicTokenGenerator(label: string) {
  const token = `aet_${createHash("sha256").update(`commit5-c53-${label}`).digest("base64url")}`;
  const generated = {
    token,
    tokenHash: hashExecutionToken(token),
    tokenPrefix: `${token.slice(0, 12)}...`
  };
  return () => ({ ...generated });
}

function assertSafeTokenBinding(token: SafeToken, expected: { userId: string; runId: string }): void {
  assert.equal(token.userId, expected.userId);
  assert.equal(token.runId, expected.runId);
  assert.equal(token.host, SYNTHETIC_HOST);
  assert.equal(token.scope, "APPLICATION_READ");
  assert.equal(token.singleUse, false);
  assert.equal(token.consumedAt, null);
}

function assertTokenCreateAudit(
  audit: SafeAudit,
  expected: {
    tokenId: string;
    run: ReadyRunFixture;
    expiresAt: Date;
    supersededCount: number;
  }
): void {
  assert.equal(audit.action, "application-execution-token.create");
  assert.equal(audit.resource, "ApplicationExecutionToken");
  assert.equal(audit.resourceId, expected.tokenId);
  assert.deepEqual(metadataRecord(audit), {
    runId: expected.run.runId,
    applicationId: expected.run.applicationId,
    jobPostingId: expected.run.jobPostingId,
    scope: "APPLICATION_READ",
    host: SYNTHETIC_HOST,
    expiresAt: expected.expiresAt.toISOString(),
    supersededCount: expected.supersededCount
  });
}

test("simultaneous first equivalent policy PATCHes serialize to one creator", async () => {
  const scenario = await createScenario("first-equivalent");
  await runScenarioBody(scenario, async () => {
    const user = await createSyntheticUser(scenario, "user");
    const aUserLockGranted = deferred("first equivalent A User lock granted");
    const releaseA = trackRelease(scenario, deferred("release first equivalent A"));
    const bUserLockAttempted = deferred("first equivalent B User lock attempted");
    const bPolicyLockGranted = deferred("first equivalent B policy lock granted");
    const releaseB = trackRelease(scenario, deferred("release first equivalent B"));
    const auditEvents: string[] = [];

    const aHooks = createHookedPrismaClient(scenario.actorA, [
      {
        name: "first equivalent A User serialization lock",
        match: USER_POLICY_SERIALIZATION_LOCK,
        after: async () => {
          aUserLockGranted.resolve();
          await releaseA.wait();
        }
      },
      {
        name: "first equivalent A creator audit",
        match: AUDIT_CREATE,
        after: () => {
          auditEvents.push("A");
        }
      }
    ]);
    const bHooks = createHookedPrismaClient(scenario.actorB, [
      {
        name: "first equivalent B User serialization attempt",
        match: USER_POLICY_SERIALIZATION_LOCK,
        before: () => bUserLockAttempted.resolve()
      },
      {
        name: "first equivalent B post-A policy row lock",
        match: POLICY_ROW_LOCK,
        after: async () => {
          bPolicyLockGranted.resolve();
          await releaseB.wait();
        }
      },
      {
        name: "first equivalent B performs no policy create",
        match: POLICY_CREATE,
        expectedMatches: 0
      },
      {
        name: "first equivalent B performs no policy update",
        match: POLICY_UPDATE,
        expectedMatches: 0
      },
      {
        name: "first equivalent B performs no token invalidation",
        match: TOKEN_UPDATE_MANY,
        expectedMatches: 0
      },
      {
        name: "first equivalent B writes no audit",
        match: AUDIT_CREATE,
        expectedMatches: 0
      }
    ]);
    const serviceA = createApplicationRunService({
      prismaClient: aHooks.prismaClient,
      env: GLOBAL_AUTOMATION_ENABLED
    });
    const serviceB = createApplicationRunService({
      prismaClient: bHooks.prismaClient,
      env: GLOBAL_AUTOMATION_ENABLED
    });

    const operationA = trackOperation(scenario, serviceA.updateAutomationPolicy(user.id, { enabled: false }));
    await aUserLockGranted.wait();
    const operationB = trackOperation(scenario, serviceB.updateAutomationPolicy(user.id, { enabled: false }));
    await bUserLockAttempted.wait();
    await assertObservedLockWait(scenario.observer, scenario.actorB, scenario.actorA);

    releaseA.resolve();
    const boundary = await withTimeout(
      Promise.allSettled([operationA, bPolicyLockGranted.wait()]),
      OPERATION_TIMEOUT_MS,
      "first equivalent post-A pre-B boundary"
    );
    const resultA = requireFulfilled(boundary[0], scenario.actorA, "first-equivalent-A");
    requireFulfilled(boundary[1], scenario.actorB, "first-equivalent-B-policy-lock");
    assert.equal(resultA.persisted, true);
    assert.equal(resultA.changed, false);
    assert.equal(resultA.revokedExecutionTokenCount, 0);

    const policyAfterA = await requireSinglePolicy(scenario.observer, user.id);
    assertPolicyValues(policyAfterA);
    const auditsAfterA = await readAudits(scenario.observer, user.id);
    const auditIdsAfterA = auditsAfterA.map(({ id }) => id).sort();
    assert.equal(auditsAfterA.length, 1);
    const createAuditAfterA = requireSingleAudit(auditsAfterA, "application-automation-policy.create");
    assert.equal(createAuditAfterA.resource, "ApplicationAutomationPolicy");
    assert.equal(createAuditAfterA.resourceId, policyAfterA.id);
    assert.deepEqual(metadataRecord(createAuditAfterA), { enabled: false });
    const tokensAfterA = await readSafeTokens(scenario.observer, user.id);
    assert.deepEqual(tokensAfterA, []);
    assert.deepEqual(auditEvents, ["A"]);

    releaseB.resolve();
    const bResult = await withTimeout(
      Promise.allSettled([operationB]),
      OPERATION_TIMEOUT_MS,
      "first equivalent B completion"
    );
    const resultB = requireFulfilled(bResult[0], scenario.actorB, "first-equivalent-B");
    assert.equal(resultB.persisted, true);
    assert.equal(resultB.changed, false);
    assert.equal(resultB.revokedExecutionTokenCount, 0);

    const finalPolicy = await requireSinglePolicy(scenario.observer, user.id);
    assert.deepEqual(finalPolicy, policyAfterA);
    assertPolicyValues(finalPolicy);
    const finalAudits = await readAudits(scenario.observer, user.id);
    assert.deepEqual(finalAudits.map(({ id }) => id).sort(), auditIdsAfterA);
    assert.equal(finalAudits.length, 1);
    const finalCreateAudit = requireSingleAudit(finalAudits, "application-automation-policy.create");
    assert.equal(finalCreateAudit.resource, "ApplicationAutomationPolicy");
    assert.equal(finalCreateAudit.resourceId, finalPolicy.id);
    assert.deepEqual(metadataRecord(finalCreateAudit), { enabled: false });
    assert.equal(auditsWithAction(finalAudits, "application-automation-policy.update").length, 0);
    assert.equal(auditsWithAction(finalAudits, "application-execution-token.revoke-bulk").length, 0);
    const finalTokens = await readSafeTokens(scenario.observer, user.id);
    assert.deepEqual(finalTokens, tokensAfterA);
    assert.deepEqual(finalTokens, []);
    await assertNoApplicationEvents(scenario.observer, user.id);
    aHooks.assertExpectedHooksReached();
    bHooks.assertExpectedHooksReached();
    await assertScenarioSessionsPinned(scenario, "first-equivalent-complete");
  });
});

test("different simultaneous first policy PATCHes preserve both committed changes", async () => {
  const scenario = await createScenario("first-different");
  const clockA = new Date("2035-01-01T00:00:01.000Z");
  const clockB = new Date("2035-01-01T00:00:02.000Z");
  await runScenarioBody(scenario, async () => {
    const user = await createSyntheticUser(scenario, "user");
    const aUserLockGranted = deferred("first different A User lock granted");
    const releaseA = trackRelease(scenario, deferred("release first different A"));
    const bUserLockAttempted = deferred("first different B User lock attempted");
    const auditEvents: string[] = [];

    const aHooks = createHookedPrismaClient(scenario.actorA, [
      {
        name: "first different A User serialization lock",
        match: USER_POLICY_SERIALIZATION_LOCK,
        after: async () => {
          aUserLockGranted.resolve();
          await releaseA.wait();
        }
      },
      {
        name: "first different A audits",
        match: AUDIT_CREATE,
        expectedMatches: 2,
        after: () => {
          auditEvents.push("A");
        }
      }
    ]);
    const bHooks = createHookedPrismaClient(scenario.actorB, [
      {
        name: "first different B User serialization attempt",
        match: USER_POLICY_SERIALIZATION_LOCK,
        before: () => bUserLockAttempted.resolve()
      },
      {
        name: "first different B audits",
        match: AUDIT_CREATE,
        expectedMatches: 2,
        after: () => {
          auditEvents.push("B");
        }
      }
    ]);
    const serviceA = createApplicationRunService({
      prismaClient: aHooks.prismaClient,
      env: GLOBAL_AUTOMATION_ENABLED,
      clock: () => new Date(clockA)
    });
    const serviceB = createApplicationRunService({
      prismaClient: bHooks.prismaClient,
      env: GLOBAL_AUTOMATION_ENABLED,
      clock: () => new Date(clockB)
    });

    const operationA = trackOperation(
      scenario,
      serviceA.updateAutomationPolicy(user.id, { dailyApplicationCap: 1 })
    );
    await aUserLockGranted.wait();
    const operationB = trackOperation(
      scenario,
      serviceB.updateAutomationPolicy(user.id, { coverLetterRequired: false })
    );
    await bUserLockAttempted.wait();
    await assertObservedLockWait(scenario.observer, scenario.actorB, scenario.actorA);

    releaseA.resolve();
    const results = await withTimeout(
      Promise.allSettled([operationA, operationB]),
      OPERATION_TIMEOUT_MS,
      "different first policy PATCHes"
    );
    const resultA = requireFulfilled(results[0], scenario.actorA, "first-different-A");
    const resultB = requireFulfilled(results[1], scenario.actorB, "first-different-B");
    assert.equal(resultA.changed, true);
    assert.equal(resultA.revokedExecutionTokenCount, 0);
    assert.equal(resultA.dailyApplicationCap, 1);
    assert.equal(resultA.coverLetterRequired, true);
    assert.equal(resultB.changed, true);
    assert.equal(resultB.revokedExecutionTokenCount, 0);
    assert.equal(resultB.dailyApplicationCap, 1);
    assert.equal(resultB.coverLetterRequired, false);

    const policy = await requireSinglePolicy(scenario.observer, user.id);
    assertPolicyValues(policy, { dailyApplicationCap: 1, coverLetterRequired: false });
    const audits = await readAudits(scenario.observer, user.id);
    assert.equal(audits.length, 4);
    assertPolicyChangeAudit(requireSingleAudit(audits, "application-automation-policy.create"), {
      action: "application-automation-policy.create",
      policyId: policy.id,
      changedFields: ["dailyApplicationCap"],
      enabled: false,
      revokedExecutionTokenCount: 0,
      changedAt: clockA
    });
    assertPolicyChangeAudit(requireSingleAudit(audits, "application-automation-policy.update"), {
      action: "application-automation-policy.update",
      policyId: policy.id,
      changedFields: ["coverLetterRequired"],
      enabled: false,
      revokedExecutionTokenCount: 0,
      changedAt: clockB
    });
    const bulkAudits = auditsWithAction(audits, "application-execution-token.revoke-bulk");
    assert.equal(bulkAudits.length, 2);
    const bulkTimes = bulkAudits.map((audit) => String(metadataRecord(audit).revokedAt)).sort();
    assert.deepEqual(bulkTimes, [clockA.toISOString(), clockB.toISOString()]);
    for (const audit of bulkAudits) {
      const revokedAt = String(metadataRecord(audit).revokedAt);
      assertBulkRevocationAudit(audit, {
        userId: user.id,
        revokedCount: 0,
        revokedAt: new Date(revokedAt)
      });
    }
    assert.deepEqual(auditEvents, ["A", "A", "B", "B"]);
    await assertNoApplicationEvents(scenario.observer, user.id);
    aHooks.assertExpectedHooksReached();
    bHooks.assertExpectedHooksReached();
    await assertScenarioSessionsPinned(scenario, "first-different-complete");
  });
});

test("first policy creator rollback releases its waiting successor to become creator", async () => {
  const scenario = await createScenario("creator-rollback");
  const clockB = new Date("2035-01-02T00:00:02.000Z");
  await runScenarioBody(scenario, async () => {
    const user = await createSyntheticUser(scenario, "user");
    const aUserLockGranted = deferred("rollback creator A User lock granted");
    const aLateAuditWritten = deferred("rollback creator A late audit written");
    const releaseA = trackRelease(scenario, deferred("release rollback creator A"));
    const bUserLockAttempted = deferred("rollback successor B User lock attempted");
    const auditEvents: string[] = [];
    const rollbackSentinel = lateFailureSentinel("C5.3 creator audit rollback");
    let policyCreateCompleted = false;
    let tokenUpdateCompleted = false;
    let completedBulkAudits = 0;
    let completedPolicyCreateAudits = 0;
    let provisionalPolicyId: string | null = null;
    let rolledBackPolicyId: string | null = null;

    const aHooks = createHookedPrismaClient(scenario.actorA, [
      {
        name: "rollback creator A User serialization lock",
        match: USER_POLICY_SERIALIZATION_LOCK,
        after: () => aUserLockGranted.resolve()
      },
      {
        name: "rollback creator A policy row create",
        match: POLICY_CREATE,
        after: () => {
          policyCreateCompleted = true;
        }
      },
      {
        name: "rollback creator A zero-count token revocation",
        match: TOKEN_UPDATE_MANY,
        after: () => {
          tokenUpdateCompleted = true;
        }
      }
    ]);
    const aPrismaClient = aHooks.prismaClient.$extends({
      name: "commit5CreatorRollbackAuditFailure",
      query: {
        applicationAutomationPolicy: {
          async create({ args, query }) {
            const result = await query(args);
            const createdPolicyId = result.id;
            assert.ok(typeof createdPolicyId === "string" && createdPolicyId.length > 0);
            provisionalPolicyId = createdPolicyId;
            return result;
          }
        },
        auditLog: {
          async create({ args, query }) {
            const { action, resource, resourceId } = args.data;
            const candidateUserId = "userId" in args.data ? args.data.userId : undefined;
            const directUserId = typeof candidateUserId === "string" ? candidateUserId : null;
            const result = await query(args);

            if (
              directUserId === user.id &&
              action === "application-execution-token.revoke-bulk"
            ) {
              assert.equal(resource, "User");
              assert.equal(resourceId, user.id);
              assert.equal(policyCreateCompleted, true);
              assert.equal(tokenUpdateCompleted, true);
              completedBulkAudits += 1;
              auditEvents.push("A:bulk");
              return result;
            }

            if (directUserId !== user.id || action !== "application-automation-policy.create") {
              return result;
            }

            assert.equal(resource, "ApplicationAutomationPolicy");
            assert.ok(provisionalPolicyId);
            assert.equal(resourceId, provisionalPolicyId);
            assert.equal(policyCreateCompleted, true);
            assert.equal(tokenUpdateCompleted, true);
            assert.equal(completedBulkAudits, 1);
            completedPolicyCreateAudits += 1;
            rolledBackPolicyId = resourceId;
            auditEvents.push("A:policy-create");
            aLateAuditWritten.resolve();
            await releaseA.wait();
            throw rollbackSentinel;
          }
        }
      }
    }) as unknown as PostgresTestActor["client"];
    const bHooks = createHookedPrismaClient(scenario.actorB, [
      {
        name: "rollback successor B User serialization attempt",
        match: USER_POLICY_SERIALIZATION_LOCK,
        before: () => bUserLockAttempted.resolve()
      },
      {
        name: "rollback successor B durable audits",
        match: AUDIT_CREATE,
        expectedMatches: 2,
        after: () => {
          auditEvents.push("B");
        }
      }
    ]);
    const serviceA = createApplicationRunService({
      prismaClient: aPrismaClient,
      env: GLOBAL_AUTOMATION_ENABLED
    });
    const serviceB = createApplicationRunService({
      prismaClient: bHooks.prismaClient,
      env: GLOBAL_AUTOMATION_ENABLED,
      clock: () => new Date(clockB)
    });

    const operationA = trackOperation(
      scenario,
      serviceA.updateAutomationPolicy(user.id, { coverLetterRequired: false })
    );
    await aUserLockGranted.wait();
    await aLateAuditWritten.wait();
    const operationB = trackOperation(
      scenario,
      serviceB.updateAutomationPolicy(user.id, { dailyApplicationCap: 1 })
    );
    await bUserLockAttempted.wait();
    await assertObservedLockWait(scenario.observer, scenario.actorB, scenario.actorA);

    releaseA.resolve();
    const results = await withTimeout(
      Promise.allSettled([operationA, operationB]),
      OPERATION_TIMEOUT_MS,
      "creator rollback and waiter takeover"
    );
    const errorA = requireRejected(results[0], scenario.actorA, "creator-rollback-A");
    assert.strictEqual(errorA, rollbackSentinel);
    assert.ok(errorA instanceof PostgresTestLateFailureError);
    assert.equal(errorA.code, "POSTGRES_TEST_LATE_FAILURE");
    assert.equal(policyCreateCompleted, true);
    assert.equal(tokenUpdateCompleted, true);
    assert.equal(completedBulkAudits, 1);
    assert.equal(completedPolicyCreateAudits, 1);
    assert.ok(provisionalPolicyId);
    assert.equal(rolledBackPolicyId, provisionalPolicyId);
    const resultB = requireFulfilled(results[1], scenario.actorB, "creator-rollback-B");
    assert.equal(resultB.changed, true);
    assert.equal(resultB.revokedExecutionTokenCount, 0);
    assert.equal(resultB.dailyApplicationCap, 1);

    const policy = await requireSinglePolicy(scenario.observer, user.id);
    assertPolicyValues(policy, { enabled: false, dailyApplicationCap: 1 });
    assert.notEqual(policy.id, rolledBackPolicyId);
    const audits = await readAudits(scenario.observer, user.id);
    assert.equal(audits.length, 2);
    assert.equal(audits.some((audit) => audit.resourceId === rolledBackPolicyId), false);
    assertPolicyChangeAudit(requireSingleAudit(audits, "application-automation-policy.create"), {
      action: "application-automation-policy.create",
      policyId: policy.id,
      changedFields: ["dailyApplicationCap"],
      enabled: false,
      revokedExecutionTokenCount: 0,
      changedAt: clockB
    });
    assert.equal(auditsWithAction(audits, "application-automation-policy.update").length, 0);
    assertBulkRevocationAudit(requireSingleAudit(audits, "application-execution-token.revoke-bulk"), {
      userId: user.id,
      revokedCount: 0,
      revokedAt: clockB
    });
    assert.deepEqual(auditEvents, ["A:bulk", "A:policy-create", "B", "B"]);
    await assertNoApplicationEvents(scenario.observer, user.id);
    aHooks.assertExpectedHooksReached();
    bHooks.assertExpectedHooksReached();
    await assertScenarioSessionsPinned(scenario, "creator-rollback-complete");
  });
});

test("concurrent existing-policy PATCHes serialize without losing disjoint updates", async () => {
  const scenario = await createScenario("existing-disjoint");
  const clockA = new Date("2035-01-03T00:00:01.000Z");
  const clockB = new Date("2035-01-03T00:00:02.000Z");
  await runScenarioBody(scenario, async () => {
    const user = await createSyntheticUser(scenario, "user");
    const initialPolicy = await createPersistedPolicy(scenario.observer, user.id);
    const aPolicyLockGranted = deferred("existing disjoint A policy lock granted");
    const releaseA = trackRelease(scenario, deferred("release existing disjoint A"));
    const bUserLockAttempted = deferred("existing disjoint B User lock attempted");
    let bUserLockCompleted = false;
    const auditEvents: string[] = [];
    const completionOrder: string[] = [];

    const aHooks = createHookedPrismaClient(scenario.actorA, [
      {
        name: "existing disjoint A policy row lock",
        match: POLICY_ROW_LOCK,
        after: async () => {
          aPolicyLockGranted.resolve();
          await releaseA.wait();
        }
      },
      {
        name: "existing disjoint A audits",
        match: AUDIT_CREATE,
        expectedMatches: 2,
        after: () => {
          auditEvents.push("A");
        }
      }
    ]);
    const bHooks = createHookedPrismaClient(scenario.actorB, [
      {
        name: "existing disjoint B User serialization attempt",
        match: USER_POLICY_SERIALIZATION_LOCK,
        before: () => bUserLockAttempted.resolve(),
        after: () => {
          bUserLockCompleted = true;
        }
      },
      {
        name: "existing disjoint B audits",
        match: AUDIT_CREATE,
        expectedMatches: 2,
        after: () => {
          auditEvents.push("B");
        }
      }
    ]);
    const serviceA = createApplicationRunService({
      prismaClient: aHooks.prismaClient,
      env: GLOBAL_AUTOMATION_ENABLED,
      clock: () => new Date(clockA)
    });
    const serviceB = createApplicationRunService({
      prismaClient: bHooks.prismaClient,
      env: GLOBAL_AUTOMATION_ENABLED,
      clock: () => new Date(clockB)
    });

    const operationA = trackOperation(
      scenario,
      serviceA.updateAutomationPolicy(user.id, { dailyApplicationCap: 1 }).then((result) => {
        completionOrder.push("A");
        return result;
      })
    );
    await aPolicyLockGranted.wait();
    const operationB = trackOperation(
      scenario,
      serviceB.updateAutomationPolicy(user.id, { coverLetterRequired: false }).then((result) => {
        completionOrder.push("B");
        return result;
      })
    );
    await bUserLockAttempted.wait();
    await assertObservedLockWait(scenario.observer, scenario.actorB, scenario.actorA);
    assert.equal(
      bUserLockCompleted,
      false,
      "existing disjoint B User serialization query must still be in flight"
    );

    releaseA.resolve();
    const results = await withTimeout(
      Promise.allSettled([operationA, operationB]),
      OPERATION_TIMEOUT_MS,
      "existing disjoint policy PATCHes"
    );
    const resultA = requireFulfilled(results[0], scenario.actorA, "existing-disjoint-A");
    const resultB = requireFulfilled(results[1], scenario.actorB, "existing-disjoint-B");
    assert.equal(
      bUserLockCompleted,
      true,
      "existing disjoint B User serialization query must complete after holder release"
    );
    assert.equal(resultA.changed, true);
    assert.equal(resultA.revokedExecutionTokenCount, 0);
    assert.equal(resultB.changed, true);
    assert.equal(resultB.revokedExecutionTokenCount, 0);
    assert.equal(resultB.dailyApplicationCap, 1);
    assert.equal(resultB.coverLetterRequired, false);
    assert.deepEqual(completionOrder, ["A", "B"]);

    const policy = await requireSinglePolicy(scenario.observer, user.id);
    assertPolicyValues(policy, { dailyApplicationCap: 1, coverLetterRequired: false });
    assert.ok(policy.updatedAt.getTime() > initialPolicy.updatedAt.getTime());
    const audits = await readAudits(scenario.observer, user.id);
    assert.equal(audits.length, 4);
    assert.equal(auditsWithAction(audits, "application-automation-policy.create").length, 0);
    const policyAudits = auditsWithAction(audits, "application-automation-policy.update");
    assert.equal(policyAudits.length, 2);
    const capAudit = policyAudits.find((audit) => metadataRecord(audit).changedAt === clockA.toISOString());
    const coverAudit = policyAudits.find((audit) => metadataRecord(audit).changedAt === clockB.toISOString());
    assert.ok(capAudit);
    assert.ok(coverAudit);
    assertPolicyChangeAudit(capAudit, {
      action: "application-automation-policy.update",
      policyId: policy.id,
      changedFields: ["dailyApplicationCap"],
      enabled: false,
      revokedExecutionTokenCount: 0,
      changedAt: clockA
    });
    assertPolicyChangeAudit(coverAudit, {
      action: "application-automation-policy.update",
      policyId: policy.id,
      changedFields: ["coverLetterRequired"],
      enabled: false,
      revokedExecutionTokenCount: 0,
      changedAt: clockB
    });
    const bulkAudits = auditsWithAction(audits, "application-execution-token.revoke-bulk");
    assert.equal(bulkAudits.length, 2);
    for (const [audit, clock] of [
      [bulkAudits.find((entry) => metadataRecord(entry).revokedAt === clockA.toISOString()), clockA],
      [bulkAudits.find((entry) => metadataRecord(entry).revokedAt === clockB.toISOString()), clockB]
    ] as const) {
      assert.ok(audit);
      assertBulkRevocationAudit(audit, { userId: user.id, revokedCount: 0, revokedAt: clock });
    }
    assert.deepEqual(auditEvents, ["A", "A", "B", "B"]);
    await assertNoApplicationEvents(scenario.observer, user.id);
    aHooks.assertExpectedHooksReached();
    bHooks.assertExpectedHooksReached();
    await assertScenarioSessionsPinned(scenario, "existing-disjoint-complete");
  });
});

test("existing-policy no-op waiter does not churn timestamps or revoke a token twice", async () => {
  const scenario = await createScenario("existing-noop");
  const issuanceTime = new Date("2035-01-04T00:00:00.000Z");
  const policyChangeTime = new Date("2035-01-04T00:01:00.000Z");
  await runScenarioBody(scenario, async () => {
    const user = await createSyntheticUser(scenario, "user");
    await createPersistedPolicy(scenario.observer, user.id, {
      enabled: true,
      allowedHosts: [SYNTHETIC_HOST]
    });
    const run = await createReadyRunFixture(scenario.observer, user.id, "noop");
    const tokenService = createExecutionTokenService({
      prismaClient: scenario.observer.client,
      env: GLOBAL_AUTOMATION_ENABLED,
      clock: () => new Date(issuanceTime),
      tokenGenerator: deterministicTokenGenerator("existing-noop")
    });
    const { tokenRecord } = await tokenService.issueExecutionToken({
      userId: user.id,
      runId: run.runId,
      scope: "APPLICATION_READ"
    });
    const initialToken = await scenario.observer.client.applicationExecutionToken.findUnique({
      where: { id: tokenRecord.id },
      select: SAFE_TOKEN_SELECT
    }) as SafeToken | null;
    assert.ok(initialToken);
    assertSafeTokenBinding(initialToken, { userId: user.id, runId: run.runId });
    assert.equal(isTokenLive(initialToken, policyChangeTime), true);

    const aPolicyLockGranted = deferred("existing no-op A policy lock granted");
    const releaseA = trackRelease(scenario, deferred("release existing no-op A"));
    const bUserLockAttempted = deferred("existing no-op B User lock attempted");
    let bUserLockCompleted = false;
    const bPolicyLockGranted = deferred("existing no-op B post-A policy lock granted");
    const releaseB = trackRelease(scenario, deferred("release existing no-op B"));
    const auditEvents: string[] = [];

    const aHooks = createHookedPrismaClient(scenario.actorA, [
      {
        name: "existing no-op A policy row lock",
        match: POLICY_ROW_LOCK,
        after: async () => {
          aPolicyLockGranted.resolve();
          await releaseA.wait();
        }
      },
      {
        name: "existing no-op A audits",
        match: AUDIT_CREATE,
        expectedMatches: 2,
        after: () => {
          auditEvents.push("A");
        }
      }
    ]);
    const bHooks = createHookedPrismaClient(scenario.actorB, [
      {
        name: "existing no-op B User serialization attempt",
        match: USER_POLICY_SERIALIZATION_LOCK,
        before: () => bUserLockAttempted.resolve(),
        after: () => {
          bUserLockCompleted = true;
        }
      },
      {
        name: "existing no-op B post-A policy row lock",
        match: POLICY_ROW_LOCK,
        after: async () => {
          bPolicyLockGranted.resolve();
          await releaseB.wait();
        }
      },
      {
        name: "existing no-op B writes no audit",
        match: AUDIT_CREATE,
        expectedMatches: 0
      },
      {
        name: "existing no-op B performs no policy update",
        match: POLICY_UPDATE,
        expectedMatches: 0
      },
      {
        name: "existing no-op B performs no token revocation",
        match: TOKEN_UPDATE_MANY,
        expectedMatches: 0
      }
    ]);
    const serviceA = createApplicationRunService({
      prismaClient: aHooks.prismaClient,
      env: GLOBAL_AUTOMATION_ENABLED,
      clock: () => new Date(policyChangeTime)
    });
    const serviceB = createApplicationRunService({
      prismaClient: bHooks.prismaClient,
      env: GLOBAL_AUTOMATION_ENABLED,
      clock: () => new Date("2035-01-04T00:02:00.000Z")
    });

    const operationA = trackOperation(
      scenario,
      serviceA.updateAutomationPolicy(user.id, { dailyApplicationCap: 1 })
    );
    await aPolicyLockGranted.wait();
    const operationB = trackOperation(
      scenario,
      serviceB.updateAutomationPolicy(user.id, { dailyApplicationCap: 1 })
    );
    await bUserLockAttempted.wait();
    await assertObservedLockWait(scenario.observer, scenario.actorB, scenario.actorA);
    assert.equal(
      bUserLockCompleted,
      false,
      "existing no-op B User serialization query must still be in flight"
    );

    releaseA.resolve();
    const intermediate = await withTimeout(
      Promise.allSettled([operationA, bPolicyLockGranted.wait()]),
      OPERATION_TIMEOUT_MS,
      "existing no-op post-A observation point"
    );
    const resultA = requireFulfilled(intermediate[0], scenario.actorA, "existing-noop-A");
    requireFulfilled(intermediate[1], scenario.actorB, "existing-noop-B-policy-lock");
    assert.equal(resultA.changed, true);
    assert.equal(resultA.revokedExecutionTokenCount, 1);

    const policyAfterA = await requireSinglePolicy(scenario.observer, user.id);
    const tokenAfterA = await scenario.observer.client.applicationExecutionToken.findUnique({
      where: { id: tokenRecord.id },
      select: SAFE_TOKEN_SELECT
    }) as SafeToken | null;
    assert.ok(tokenAfterA);
    assert.equal(tokenAfterA.revokedAt?.getTime(), policyChangeTime.getTime());
    const auditIdsAfterA = (await readAudits(scenario.observer, user.id)).map(({ id }) => id).sort();

    releaseB.resolve();
    const resultBSettled = await withTimeout(
      Promise.allSettled([operationB]),
      OPERATION_TIMEOUT_MS,
      "existing no-op waiter completion"
    );
    const resultB = requireFulfilled(resultBSettled[0], scenario.actorB, "existing-noop-B");
    assert.equal(
      bUserLockCompleted,
      true,
      "existing no-op B User serialization query must complete after holder release"
    );
    assert.equal(resultB.changed, false);
    assert.equal(resultB.revokedExecutionTokenCount, 0);
    assert.equal(resultB.dailyApplicationCap, 1);

    const finalPolicy = await requireSinglePolicy(scenario.observer, user.id);
    assertPolicyValues(finalPolicy, {
      enabled: true,
      allowedHosts: [SYNTHETIC_HOST],
      dailyApplicationCap: 1
    });
    assert.equal(finalPolicy.updatedAt.getTime(), policyAfterA.updatedAt.getTime());
    const finalToken = await scenario.observer.client.applicationExecutionToken.findUnique({
      where: { id: tokenRecord.id },
      select: SAFE_TOKEN_SELECT
    }) as SafeToken | null;
    assert.ok(finalToken);
    assertSafeTokenBinding(finalToken, { userId: user.id, runId: run.runId });
    assert.equal(finalToken.revokedAt?.getTime(), policyChangeTime.getTime());
    assert.equal(isTokenLive(finalToken, policyChangeTime), false);

    const audits = await readAudits(scenario.observer, user.id);
    assert.deepEqual(audits.map(({ id }) => id).sort(), auditIdsAfterA);
    assert.equal(audits.length, 3);
    assertTokenCreateAudit(requireSingleAudit(audits, "application-execution-token.create"), {
      tokenId: tokenRecord.id,
      run,
      expiresAt: tokenRecord.expiresAt,
      supersededCount: 0
    });
    assertBulkRevocationAudit(requireSingleAudit(audits, "application-execution-token.revoke-bulk"), {
      userId: user.id,
      revokedCount: 1,
      revokedAt: policyChangeTime
    });
    assertPolicyChangeAudit(requireSingleAudit(audits, "application-automation-policy.update"), {
      action: "application-automation-policy.update",
      policyId: finalPolicy.id,
      changedFields: ["dailyApplicationCap"],
      enabled: true,
      revokedExecutionTokenCount: 1,
      changedAt: policyChangeTime
    });
    assert.deepEqual(auditEvents, ["A", "A"]);
    await assertNoApplicationEvents(scenario.observer, user.id);
    aHooks.assertExpectedHooksReached();
    bHooks.assertExpectedHooksReached();
    await assertScenarioSessionsPinned(scenario, "existing-noop-complete");
  });
});

test("issuance-first policy PATCH completes through the User foreign-key lock graph without deadlock", async () => {
  const scenario = await createScenario("issuance-first");
  const issuanceTime = new Date("2035-01-05T00:00:00.000Z");
  const policyChangeTime = new Date("2035-01-05T00:01:00.000Z");
  await runScenarioBody(scenario, async () => {
    const user = await createSyntheticUser(scenario, "user");
    await createPersistedPolicy(scenario.observer, user.id, {
      enabled: true,
      allowedHosts: [SYNTHETIC_HOST]
    });
    const run = await createReadyRunFixture(scenario.observer, user.id, "issuance-first");
    const issuancePolicyLockGranted = deferred("issuance-first policy lock granted");
    const releaseIssuance = trackRelease(scenario, deferred("release issuance-first issuer"));
    const patchUserLockGranted = deferred("issuance-first PATCH User lock granted");
    const patchPolicyLockAttempted = deferred("issuance-first PATCH policy lock attempted");
    const sequence: string[] = [];

    const issuanceHooks = createHookedPrismaClient(scenario.actorA, [
      {
        name: "issuance-first issuer policy row lock",
        match: POLICY_ROW_LOCK,
        after: async () => {
          sequence.push("I:policy-lock");
          issuancePolicyLockGranted.resolve();
          await releaseIssuance.wait();
        }
      },
      {
        name: "issuance-first issuer run row lock",
        match: RUN_ROW_LOCK,
        after: () => {
          sequence.push("I:run-lock");
        }
      },
      {
        name: "issuance-first predecessor update",
        match: TOKEN_UPDATE_MANY,
        after: () => {
          sequence.push("I:predecessor-update");
        }
      },
      {
        name: "issuance-first token insert",
        match: TOKEN_CREATE,
        after: () => {
          sequence.push("I:token-create");
        }
      },
      {
        name: "issuance-first token audit",
        match: AUDIT_CREATE,
        after: () => {
          sequence.push("I:token-audit");
        }
      }
    ]);
    const patchHooks = createHookedPrismaClient(scenario.actorB, [
      {
        name: "issuance-first PATCH User row lock",
        match: USER_POLICY_SERIALIZATION_LOCK,
        after: () => {
          sequence.push("P:user-lock");
          patchUserLockGranted.resolve();
        }
      },
      {
        name: "issuance-first PATCH policy attempt",
        match: POLICY_ROW_LOCK,
        before: () => {
          sequence.push("P:policy-attempt");
          patchPolicyLockAttempted.resolve();
        },
        after: () => {
          sequence.push("P:policy-lock");
        }
      },
      {
        name: "issuance-first PATCH token revocation",
        match: TOKEN_UPDATE_MANY,
        after: () => {
          sequence.push("P:token-revoke");
        }
      },
      {
        name: "issuance-first PATCH audits",
        match: AUDIT_CREATE,
        expectedMatches: 2,
        after: () => {
          sequence.push("P:audit");
        }
      }
    ]);
    const tokenService = createExecutionTokenService({
      prismaClient: issuanceHooks.prismaClient,
      env: GLOBAL_AUTOMATION_ENABLED,
      clock: () => new Date(issuanceTime),
      tokenGenerator: deterministicTokenGenerator("issuance-first")
    });
    const policyService = createApplicationRunService({
      prismaClient: patchHooks.prismaClient,
      env: GLOBAL_AUTOMATION_ENABLED,
      clock: () => new Date(policyChangeTime)
    });

    const issuanceOperation = trackOperation(
      scenario,
      tokenService.issueExecutionToken({ userId: user.id, runId: run.runId, scope: "APPLICATION_READ" })
    );
    await issuancePolicyLockGranted.wait();
    const patchOperation = trackOperation(
      scenario,
      policyService.updateAutomationPolicy(user.id, { dailyApplicationCap: 1 })
    );
    await patchUserLockGranted.wait();
    await patchPolicyLockAttempted.wait();
    await assertObservedLockWait(scenario.observer, scenario.actorB, scenario.actorA);

    releaseIssuance.resolve();
    const results = await withTimeout(
      Promise.allSettled([issuanceOperation, patchOperation]),
      OPERATION_TIMEOUT_MS,
      "issuance-first policy lock graph"
    );
    const issuanceResult = requireFulfilled(results[0], scenario.actorA, "issuance-first-issuer");
    const patchResult = requireFulfilled(results[1], scenario.actorB, "issuance-first-policy-PATCH");
    assert.equal(patchResult.changed, true);
    assert.equal(patchResult.revokedExecutionTokenCount, 1);
    assert.deepEqual(sequence, [
      "I:policy-lock",
      "P:user-lock",
      "P:policy-attempt",
      "I:run-lock",
      "I:predecessor-update",
      "I:token-create",
      "I:token-audit",
      "P:policy-lock",
      "P:token-revoke",
      "P:audit",
      "P:audit"
    ]);

    const policy = await requireSinglePolicy(scenario.observer, user.id);
    assertPolicyValues(policy, {
      enabled: true,
      allowedHosts: [SYNTHETIC_HOST],
      dailyApplicationCap: 1
    });
    const tokens = await scenario.observer.client.applicationExecutionToken.findMany({
      where: { userId: user.id, runId: run.runId, scope: "APPLICATION_READ" },
      select: SAFE_TOKEN_SELECT
    }) as SafeToken[];
    assert.equal(tokens.length, 1);
    const token = tokens[0];
    assert.equal(token.id, issuanceResult.tokenRecord.id);
    assertSafeTokenBinding(token, { userId: user.id, runId: run.runId });
    assert.equal(token.revokedAt?.getTime(), policyChangeTime.getTime());
    assert.equal(isTokenLive(token, policyChangeTime), false);

    const audits = await readAudits(scenario.observer, user.id);
    assert.equal(audits.length, 3);
    assertTokenCreateAudit(requireSingleAudit(audits, "application-execution-token.create"), {
      tokenId: token.id,
      run,
      expiresAt: issuanceResult.tokenRecord.expiresAt,
      supersededCount: 0
    });
    assertBulkRevocationAudit(requireSingleAudit(audits, "application-execution-token.revoke-bulk"), {
      userId: user.id,
      revokedCount: 1,
      revokedAt: policyChangeTime
    });
    assertPolicyChangeAudit(requireSingleAudit(audits, "application-automation-policy.update"), {
      action: "application-automation-policy.update",
      policyId: policy.id,
      changedFields: ["dailyApplicationCap"],
      enabled: true,
      revokedExecutionTokenCount: 1,
      changedAt: policyChangeTime
    });
    await assertNoApplicationEvents(scenario.observer, user.id);
    issuanceHooks.assertExpectedHooksReached();
    patchHooks.assertExpectedHooksReached();
    await assertScenarioSessionsPinned(scenario, "issuance-first-complete");
  });
});

test("policy-disable-first makes waiting issuance reject after its authoritative policy reread", async () => {
  const scenario = await createScenario("patch-first");
  const policyChangeTime = new Date("2035-01-06T00:01:00.000Z");
  await runScenarioBody(scenario, async () => {
    const user = await createSyntheticUser(scenario, "user");
    await createPersistedPolicy(scenario.observer, user.id, {
      enabled: true,
      allowedHosts: [SYNTHETIC_HOST]
    });
    const run = await createReadyRunFixture(scenario.observer, user.id, "patch-first");
    const patchPolicyLockGranted = deferred("patch-first policy lock granted");
    const releasePatch = trackRelease(scenario, deferred("release patch-first policy writer"));
    const issuancePolicyLockAttempted = deferred("patch-first issuance policy lock attempted");
    const sequence: string[] = [];

    const patchHooks = createHookedPrismaClient(scenario.actorA, [
      {
        name: "patch-first policy row lock",
        match: POLICY_ROW_LOCK,
        after: async () => {
          sequence.push("P:policy-lock");
          patchPolicyLockGranted.resolve();
          await releasePatch.wait();
        }
      },
      {
        name: "patch-first token revocation",
        match: TOKEN_UPDATE_MANY,
        after: () => {
          sequence.push("P:token-revoke");
        }
      },
      {
        name: "patch-first audits",
        match: AUDIT_CREATE,
        expectedMatches: 2,
        after: () => {
          sequence.push("P:audit");
        }
      }
    ]);
    const issuanceHooks = createHookedPrismaClient(scenario.actorB, [
      {
        name: "patch-first issuance policy attempt",
        match: POLICY_ROW_LOCK,
        before: () => {
          sequence.push("I:policy-attempt");
          issuancePolicyLockAttempted.resolve();
        },
        after: () => {
          sequence.push("I:policy-lock");
        }
      },
      {
        name: "patch-first issuance never reaches run lock",
        match: RUN_ROW_LOCK,
        expectedMatches: 0
      },
      {
        name: "patch-first issuance creates no token",
        match: TOKEN_CREATE,
        expectedMatches: 0
      },
      {
        name: "patch-first issuance writes no audit",
        match: AUDIT_CREATE,
        expectedMatches: 0
      }
    ]);
    const policyService = createApplicationRunService({
      prismaClient: patchHooks.prismaClient,
      env: GLOBAL_AUTOMATION_ENABLED,
      clock: () => new Date(policyChangeTime)
    });
    const tokenService = createExecutionTokenService({
      prismaClient: issuanceHooks.prismaClient,
      env: GLOBAL_AUTOMATION_ENABLED,
      clock: () => new Date("2035-01-06T00:02:00.000Z"),
      tokenGenerator: deterministicTokenGenerator("patch-first")
    });

    const patchOperation = trackOperation(
      scenario,
      policyService.updateAutomationPolicy(user.id, { enabled: false })
    );
    await patchPolicyLockGranted.wait();
    const issuanceOperation = trackOperation(
      scenario,
      tokenService.issueExecutionToken({ userId: user.id, runId: run.runId, scope: "APPLICATION_READ" })
    );
    await issuancePolicyLockAttempted.wait();
    await assertObservedLockWait(scenario.observer, scenario.actorB, scenario.actorA);

    releasePatch.resolve();
    const results = await withTimeout(
      Promise.allSettled([patchOperation, issuanceOperation]),
      OPERATION_TIMEOUT_MS,
      "patch-first policy lock graph"
    );
    const patchResult = requireFulfilled(results[0], scenario.actorA, "patch-first-policy-PATCH");
    assert.equal(patchResult.changed, true);
    assert.equal(patchResult.revokedExecutionTokenCount, 0);
    const issuanceError = requireRejected(results[1], scenario.actorB, "patch-first-issuance");
    assert.ok(issuanceError instanceof PublicApiError);
    assert.equal(issuanceError.status, 403);
    assert.equal(issuanceError.details?.code, "AUTOMATION_DISABLED");
    assert.deepEqual(sequence, [
      "P:policy-lock",
      "I:policy-attempt",
      "P:token-revoke",
      "P:audit",
      "P:audit",
      "I:policy-lock"
    ]);

    const policy = await requireSinglePolicy(scenario.observer, user.id);
    assertPolicyValues(policy, { enabled: false, allowedHosts: [SYNTHETIC_HOST] });
    assert.equal(await scenario.observer.client.applicationExecutionToken.count({ where: { userId: user.id } }), 0);
    const audits = await readAudits(scenario.observer, user.id);
    assert.equal(audits.length, 2);
    assert.equal(auditsWithAction(audits, "application-execution-token.create").length, 0);
    assertBulkRevocationAudit(requireSingleAudit(audits, "application-execution-token.revoke-bulk"), {
      userId: user.id,
      revokedCount: 0,
      revokedAt: policyChangeTime
    });
    assertPolicyChangeAudit(requireSingleAudit(audits, "application-automation-policy.update"), {
      action: "application-automation-policy.update",
      policyId: policy.id,
      changedFields: ["enabled"],
      enabled: false,
      revokedExecutionTokenCount: 0,
      changedAt: policyChangeTime
    });
    await assertNoApplicationEvents(scenario.observer, user.id);
    patchHooks.assertExpectedHooksReached();
    issuanceHooks.assertExpectedHooksReached();
    await assertScenarioSessionsPinned(scenario, "patch-first-complete");
  });
});

test("cleanup continues exact fixture deletion after a non-observer actor is poisoned", async () => {
  const primarySentinel = new Error("C5.3 primary failure sentinel");
  const primaryTrace = createCleanupTrace();
  primaryTrace.failures.push({ phase: "actor-a-pin", error: new Error("secondary cleanup sentinel") });
  assert.throws(
    () => throwCleanupOutcome({ present: true, error: primarySentinel }, primaryTrace),
    (error: unknown) => error === primarySentinel
  );
  assert.ok((primarySentinel as Error & { cause?: unknown }).cause instanceof AggregateError);

  const scenario = await createScenario("cleanup-nonobserver");
  const trace = createCleanupTrace();
  let cleanupFinished = false;
  try {
    const user = await createSyntheticUser(scenario, "user");
    const audit = await scenario.observer.client.auditLog.create({
      data: {
        userId: user.id,
        action: "commit5.postgres-cleanup-regression",
        resource: "User",
        resourceId: user.id,
        metadata: { kind: "non-observer-pin-failure" }
      },
      select: { id: true }
    });
    const terminationRows = await scenario.observer.client.$queryRaw<Array<{ terminated: boolean }>>`
      SELECT pg_terminate_backend(${scenario.actorA.backendPid}::integer) AS "terminated"
    `;
    assert.equal(terminationRows[0]?.terminated, true);
    const injectedPinResult = await Promise.allSettled([
      assertActorSessionPinned(scenario.actorA, "cleanup-regression-inject-nonobserver-poison")
    ]);
    const injectedPinError = requireRejected(
      injectedPinResult[0],
      scenario.actorA,
      "cleanup-regression-inject-nonobserver-poison"
    );
    assert.ok(injectedPinError instanceof PostgresTestActorSessionChangedError);

    const cleanupResult = await Promise.allSettled([
      cleanupScenario(scenario, NO_CAPTURED_FAILURE, trace)
    ]);
    cleanupFinished = true;
    const cleanupError = requireRejected(
      cleanupResult[0],
      scenario.actorA,
      "cleanup-regression-nonobserver"
    );
    assert.strictEqual(cleanupError, injectedPinError);
    assert.equal(trace.databaseCleanupAttempted, true);
    assert.deepEqual(trace.deletedAuditIds, [audit.id]);
    assert.deepEqual(trace.deletedUserIds, [user.id]);
    assert.strictEqual(trace.failures[0]?.error, injectedPinError);
    assert.deepEqual(
      [...trace.disconnectedActors].sort(),
      scenario.actors.map(({ actorName }) => actorName).sort()
    );
  } finally {
    if (!cleanupFinished) {
      try {
        await cleanupScenario(scenario);
      } catch {
        // Preserve the infrastructure regression's original setup/assertion failure.
      }
    }
  }
});

test("cleanup fails closed without a database fallback when the observer is poisoned", async () => {
  const scenario = await createScenario("cleanup-observer");
  const trace = createCleanupTrace();
  let cleanupFinished = false;
  try {
    const user = await createSyntheticUser(scenario, "user");
    await scenario.observer.client.auditLog.create({
      data: {
        userId: user.id,
        action: "commit5.postgres-cleanup-regression",
        resource: "User",
        resourceId: user.id,
        metadata: { kind: "observer-pin-failure" }
      },
      select: { id: true }
    });
    const terminationRows = await scenario.actorA.client.$queryRaw<Array<{ terminated: boolean }>>`
      SELECT pg_terminate_backend(${scenario.observer.backendPid}::integer) AS "terminated"
    `;
    assert.equal(terminationRows[0]?.terminated, true);
    const injectedPinResult = await Promise.allSettled([
      assertActorSessionPinned(scenario.observer, "cleanup-regression-inject-observer-poison")
    ]);
    const injectedPinError = requireRejected(
      injectedPinResult[0],
      scenario.observer,
      "cleanup-regression-inject-observer-poison"
    );
    assert.ok(injectedPinError instanceof PostgresTestActorSessionChangedError);

    const cleanupResult = await Promise.allSettled([
      cleanupScenario(scenario, NO_CAPTURED_FAILURE, trace)
    ]);
    cleanupFinished = true;
    const cleanupError = requireRejected(cleanupResult[0], scenario.observer, "cleanup-regression-observer");
    assert.strictEqual(cleanupError, injectedPinError);
    assert.equal(trace.databaseCleanupAttempted, false);
    assert.deepEqual(trace.deletedAuditIds, []);
    assert.deepEqual(trace.deletedUserIds, []);
    assert.strictEqual(trace.failures[0]?.error, injectedPinError);
    assert.deepEqual(
      [...trace.disconnectedActors].sort(),
      scenario.actors.map(({ actorName }) => actorName).sort()
    );
  } finally {
    if (!cleanupFinished) {
      try {
        await cleanupScenario(scenario);
      } catch {
        // A poisoned observer must never trigger an uncontrolled cleanup fallback.
      }
    }
  }
});
