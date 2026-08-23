import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "node:test";

import type { Prisma } from "@prisma/client";

import { PublicApiError } from "@/lib/api-errors";
import {
  createExecutionTokenService,
  hashExecutionToken,
  isTokenLive,
  READ_TOKEN_TTL_MS,
  type ExecutionTokenBindingInput,
  type ExecutionTokenServiceDependencies
} from "@/lib/application-runs/execution-token";
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

const SYNTHETIC_HOST = "jobs.example.test";
const GLOBAL_AUTOMATION_ENABLED = { APPLICATION_AUTOMATION_ENABLED: "true" } as const;
const OPERATION_TIMEOUT_MS = 12_000;
const CLEANUP_OPERATION_TIMEOUT_MS = 5_000;
const CLEANUP_DISCONNECT_TIMEOUT_MS = 3_000;

const SAFE_TOKEN_SELECT = {
  id: true,
  userId: true,
  runId: true,
  host: true,
  scope: true,
  singleUse: true,
  consumedAt: true,
  lastUsedAt: true,
  expiresAt: true,
  revokedAt: true,
  createdAt: true
} as const satisfies Prisma.ApplicationExecutionTokenSelect;

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
  preparedAt: true,
  cancelledAt: true,
  blockingReason: true,
  errorCategory: true,
  createdAt: true,
  updatedAt: true
} as const satisfies Prisma.ApplicationRunSelect;

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

type SafeToken = Prisma.ApplicationExecutionTokenGetPayload<{ select: typeof SAFE_TOKEN_SELECT }>;
type RunRow = Prisma.ApplicationRunGetPayload<{ select: typeof RUN_SELECT }>;
type SafeAudit = Prisma.AuditLogGetPayload<{ select: typeof SAFE_AUDIT_SELECT }>;
type SafeEvent = Prisma.ApplicationEventGetPayload<{ select: typeof SAFE_EVENT_SELECT }>;
type TokenServiceClient = NonNullable<ExecutionTokenServiceDependencies["prismaClient"]>;

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

type ReadyRunFixture = {
  userId: string;
  policyId: string;
  jobPostingId: string;
  applicationId: string;
  runId: string;
};

type DeterministicTokenMaterial = {
  token: string;
  tokenHash: string;
  tokenPrefix: string;
};

type SingleUseFixture = {
  tokenId: string;
  rawToken: string;
};

type SafeTokenMutationView = {
  id: unknown;
  userId: unknown;
  runId: unknown;
  host: unknown;
  scope: unknown;
  singleUse: unknown;
  consumedAtPredicate: unknown;
  revokedAtPredicate: unknown;
  expiresAfter: unknown;
  consumedAtWrite: unknown;
  lastUsedAtWrite: unknown;
  revokedAtWrite: unknown;
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
        ({ phase }) => new Error(`Secondary C5.5 cleanup phase failed: ${phase}.`)
      );
      try {
        Object.defineProperty(primaryFailure.error, "cause", {
          value: new AggregateError(summaries, "One or more secondary C5.5 cleanup phases failed."),
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

async function createReadyRunFixture(scenario: Scenario, label: string): Promise<ReadyRunFixture> {
  const user = await createSyntheticUser(scenario, label);
  const fixtureKey = `${label}-${randomUUID()}`;
  const applyUrl = `https://${SYNTHETIC_HOST}/apply/${fixtureKey}`;
  const policy = await scenario.observer.client.applicationAutomationPolicy.create({
    data: {
      userId: user.id,
      ...automationPolicyDefaultValues(),
      enabled: true,
      allowedHosts: [SYNTHETIC_HOST],
      blockedHosts: []
    },
    select: { id: true }
  });
  const jobPosting = await scenario.observer.client.jobPosting.create({
    data: {
      userId: user.id,
      title: `C5.5 synthetic role ${fixtureKey}`,
      normalizedTitle: `c55-synthetic-role-${fixtureKey}`,
      company: "C5.5 Synthetic Employer",
      normalizedCompany: `c55-synthetic-employer-${fixtureKey}`,
      location: "Remote",
      normalizedLocation: `remote-${fixtureKey}`,
      remoteStatus: "REMOTE",
      sourceUrl: `https://${SYNTHETIC_HOST}/jobs/${fixtureKey}`,
      applyUrl,
      normalizedApplyUrl: applyUrl,
      description: "Synthetic execution-token concurrency fixture.",
      requirements: [],
      preferredQualifications: [],
      benefits: [],
      detectedTechStack: [],
      sourceType: "MANUAL",
      overallFitScore: 95,
      confidenceScore: 95,
      missingKeywords: [],
      supportedKeywords: [],
      concerns: []
    },
    select: { id: true }
  });
  const application = await scenario.observer.client.application.create({
    data: { userId: user.id, jobPostingId: jobPosting.id },
    select: { id: true }
  });
  const run = await scenario.observer.client.applicationRun.create({
    data: {
      userId: user.id,
      jobPostingId: jobPosting.id,
      applicationId: application.id,
      state: "READY",
      stateVersion: 2,
      activeRunKey: application.id,
      idempotencyKey: `c55:${fixtureKey}`,
      applyUrlSnapshot: applyUrl,
      applyHost: SYNTHETIC_HOST,
      preparedAt: new Date("2026-01-01T00:00:00.000Z")
    },
    select: { id: true }
  });
  return {
    userId: user.id,
    policyId: policy.id,
    jobPostingId: jobPosting.id,
    applicationId: application.id,
    runId: run.id
  };
}

function deterministicTokenMaterial(label: string): DeterministicTokenMaterial {
  const token = `aet_${createHash("sha256").update(`commit5-c55-${label}`).digest("base64url")}`;
  assert.equal(/^aet_[A-Za-z0-9_-]{43}$/.test(token), true, "deterministic token shape");
  return {
    token,
    tokenHash: hashExecutionToken(token),
    tokenPrefix: `${token.slice(0, 12)}...`
  };
}

function trackedTokenGenerator(label: string) {
  const material = deterministicTokenMaterial(label);
  let calls = 0;
  return {
    generate: () => {
      if (calls !== 0) throw new Error(`C5.5 token generator ${label} received an unexpected call.`);
      calls += 1;
      return { ...material };
    },
    assertCalls: (expected: number) => assert.equal(calls, expected, `${label} token-generator calls`)
  };
}

function queuedClock(label: string, values: readonly Date[]) {
  let calls = 0;
  return {
    clock: () => {
      const value = values[calls];
      if (!value) throw new Error(`C5.5 clock ${label} received an unexpected call.`);
      calls += 1;
      return new Date(value.getTime());
    },
    assertCalls: (expected: number) => assert.equal(calls, expected, `${label} clock calls`)
  };
}

function createTokenService(
  prismaClient: TokenServiceClient,
  clock: () => Date,
  tokenGenerator?: NonNullable<ExecutionTokenServiceDependencies["tokenGenerator"]>
) {
  return createExecutionTokenService({
    prismaClient,
    clock,
    ...(tokenGenerator ? { tokenGenerator } : {}),
    env: GLOBAL_AUTOMATION_ENABLED
  });
}

function createCancellationService(prismaClient: PostgresTestActor["client"], clock: () => Date) {
  return createApplicationRunService({
    prismaClient,
    clock,
    env: GLOBAL_AUTOMATION_ENABLED
  });
}

function bindingInput(rawToken: string, fixture: ReadyRunFixture, scope: "APPLICATION_READ" | "APPLICATION_FILL"):
  ExecutionTokenBindingInput {
  return {
    rawToken,
    expected: {
      userId: fixture.userId,
      runId: fixture.runId,
      host: SYNTHETIC_HOST,
      scope
    }
  };
}

async function createSingleUseFixture(
  scenario: Scenario,
  fixture: ReadyRunFixture,
  label: string,
  expiresAt: Date
): Promise<SingleUseFixture> {
  const material = deterministicTokenMaterial(label);
  const token = await scenario.observer.client.applicationExecutionToken.create({
    data: {
      userId: fixture.userId,
      runId: fixture.runId,
      tokenHash: material.tokenHash,
      tokenPrefix: material.tokenPrefix,
      host: SYNTHETIC_HOST,
      scope: "APPLICATION_FILL",
      singleUse: true,
      consumedAt: null,
      lastUsedAt: null,
      revokedAt: null,
      expiresAt
    },
    select: { id: true }
  });
  return { tokenId: token.id, rawToken: material.token };
}

async function readSafeTokens(observer: PostgresTestActor, fixture: ReadyRunFixture): Promise<SafeToken[]> {
  return observer.client.applicationExecutionToken.findMany({
    where: { userId: fixture.userId, runId: fixture.runId },
    orderBy: { createdAt: "asc" },
    select: SAFE_TOKEN_SELECT
  }) as Promise<SafeToken[]>;
}

async function requireSafeToken(observer: PostgresTestActor, tokenId: string): Promise<SafeToken> {
  const token = await observer.client.applicationExecutionToken.findUnique({
    where: { id: tokenId },
    select: SAFE_TOKEN_SELECT
  }) as SafeToken | null;
  assert.ok(token);
  return token;
}

async function readRun(observer: PostgresTestActor, fixture: ReadyRunFixture): Promise<RunRow> {
  const run = await observer.client.applicationRun.findUnique({
    where: { id: fixture.runId },
    select: RUN_SELECT
  }) as RunRow | null;
  assert.ok(run);
  return run;
}

async function readAudits(observer: PostgresTestActor, userId: string): Promise<SafeAudit[]> {
  return observer.client.auditLog.findMany({
    where: { userId },
    select: SAFE_AUDIT_SELECT
  }) as Promise<SafeAudit[]>;
}

async function readEvents(observer: PostgresTestActor, userId: string): Promise<SafeEvent[]> {
  return observer.client.applicationEvent.findMany({
    where: { userId },
    select: SAFE_EVENT_SELECT
  }) as Promise<SafeEvent[]>;
}

function metadataRecord(audit: SafeAudit): Record<string, Prisma.JsonValue> {
  assert.ok(audit.metadata && typeof audit.metadata === "object" && !Array.isArray(audit.metadata));
  return audit.metadata as Record<string, Prisma.JsonValue>;
}

function eventMetadataRecord(event: SafeEvent): Record<string, Prisma.JsonValue> {
  assert.ok(event.metadata && typeof event.metadata === "object" && !Array.isArray(event.metadata));
  return event.metadata as Record<string, Prisma.JsonValue>;
}

function matchingAudits(
  audits: readonly SafeAudit[],
  action: string,
  resource?: string,
  resourceId?: string
): SafeAudit[] {
  return audits.filter(
    (audit) =>
      audit.action === action &&
      (resource === undefined || audit.resource === resource) &&
      (resourceId === undefined || audit.resourceId === resourceId)
  );
}

function requireSingleAudit(
  audits: readonly SafeAudit[],
  action: string,
  resource?: string,
  resourceId?: string
): SafeAudit {
  const matching = matchingAudits(audits, action, resource, resourceId);
  assert.equal(matching.length, 1, action);
  return matching[0];
}

function assertReusableToken(token: SafeToken, fixture: ReadyRunFixture): void {
  assert.equal(token.userId, fixture.userId);
  assert.equal(token.runId, fixture.runId);
  assert.equal(token.host, SYNTHETIC_HOST);
  assert.equal(token.scope, "APPLICATION_READ");
  assert.equal(token.singleUse, false);
  assert.equal(token.consumedAt, null);
}

function assertSingleUseToken(token: SafeToken, fixture: ReadyRunFixture): void {
  assert.equal(token.userId, fixture.userId);
  assert.equal(token.runId, fixture.runId);
  assert.equal(token.host, SYNTHETIC_HOST);
  assert.equal(token.scope, "APPLICATION_FILL");
  assert.equal(token.singleUse, true);
}

function assertTokenCreateAudit(
  audit: SafeAudit,
  fixture: ReadyRunFixture,
  token: SafeToken,
  supersededCount: number,
  issuedAt: Date
): void {
  const expectedExpiresAt = new Date(issuedAt.getTime() + READ_TOKEN_TTL_MS);
  assert.equal(token.expiresAt.getTime(), expectedExpiresAt.getTime());
  assert.equal(audit.userId, fixture.userId);
  assert.equal(audit.action, "application-execution-token.create");
  assert.equal(audit.resource, "ApplicationExecutionToken");
  assert.equal(audit.resourceId, token.id);
  assert.deepEqual(metadataRecord(audit), {
    runId: fixture.runId,
    applicationId: fixture.applicationId,
    jobPostingId: fixture.jobPostingId,
    scope: "APPLICATION_READ",
    host: SYNTHETIC_HOST,
    expiresAt: expectedExpiresAt.toISOString(),
    supersededCount
  });
}

function assertConsumeAudit(audit: SafeAudit, fixture: ReadyRunFixture, tokenId: string, consumedAt: Date): void {
  assert.equal(audit.userId, fixture.userId);
  assert.equal(audit.resource, "ApplicationExecutionToken");
  assert.equal(audit.resourceId, tokenId);
  assert.deepEqual(metadataRecord(audit), {
    tokenId,
    runId: fixture.runId,
    applicationId: fixture.applicationId,
    jobPostingId: fixture.jobPostingId,
    scope: "APPLICATION_FILL",
    host: SYNTHETIC_HOST,
    consumedAt: consumedAt.toISOString()
  });
}

function assertRevokeAudit(
  audit: SafeAudit,
  fixture: ReadyRunFixture,
  tokenId: string,
  scope: "APPLICATION_READ" | "APPLICATION_FILL",
  revokedAt: Date
): void {
  assert.equal(audit.userId, fixture.userId);
  assert.equal(audit.resource, "ApplicationExecutionToken");
  assert.equal(audit.resourceId, tokenId);
  assert.deepEqual(metadataRecord(audit), {
    tokenId,
    runId: fixture.runId,
    applicationId: fixture.applicationId,
    jobPostingId: fixture.jobPostingId,
    scope,
    host: SYNTHETIC_HOST,
    revokedAt: revokedAt.toISOString()
  });
}

function assertCancellationRecords(
  audits: readonly SafeAudit[],
  events: readonly SafeEvent[],
  fixture: ReadyRunFixture,
  cancelledAt: Date,
  revokedCount: number
): void {
  const bulk = requireSingleAudit(
    audits,
    "application-execution-token.revoke-bulk",
    "ApplicationRun",
    fixture.runId
  );
  assert.deepEqual(metadataRecord(bulk), {
    runId: fixture.runId,
    reason: "run_cancelled",
    revokedCount,
    revokedAt: cancelledAt.toISOString()
  });
  const cancelled = requireSingleAudit(audits, "application-run.cancel", "ApplicationRun", fixture.runId);
  assert.deepEqual(metadataRecord(cancelled), {
    runId: fixture.runId,
    previousState: "READY",
    nextState: "CANCELLED",
    previousStateVersion: 2,
    nextStateVersion: 3,
    revokedExecutionTokenCount: revokedCount,
    cancelledAt: cancelledAt.toISOString()
  });
  assert.equal(events.length, 1);
  const event = events[0];
  assert.equal(event.userId, fixture.userId);
  assert.equal(event.applicationId, fixture.applicationId);
  assert.equal(event.type, "APPLICATION_RUN_EVENT");
  assert.equal(event.title, "Application run cancelled");
  assert.deepEqual(eventMetadataRecord(event), {
    runId: fixture.runId,
    previousState: "READY",
    nextState: "CANCELLED",
    previousStateVersion: 2,
    nextStateVersion: 3,
    revokedExecutionTokenCount: revokedCount
  });
}

function assertCancelledRun(run: RunRow, fixture: ReadyRunFixture, cancelledAt: Date): void {
  assert.equal(run.id, fixture.runId);
  assert.equal(run.state, "CANCELLED");
  assert.equal(run.stateVersion, 3);
  assert.equal(run.activeRunKey, null);
  assert.equal(run.prepareAttemptId, null);
  assert.equal(run.prepareLeaseExpiresAt, null);
  assert.equal(run.cancelledAt?.getTime(), cancelledAt.getTime());
}

function metadataString(data: Record<string, unknown>, key: string): unknown {
  const metadata = data.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return undefined;
  return (metadata as Record<string, unknown>)[key];
}

function extendTokenCreateAuditPause(
  prismaClient: PostgresTestActor["client"],
  name: string,
  expected: { userId: string; runId: string; issuedAt: Date; supersededCount: number },
  reached: Deferred<void>,
  release: Deferred<void>
): { prismaClient: PostgresTestActor["client"]; assertMatches: () => void } {
  let replacementMatches = 0;
  let createMatches = 0;
  let auditMatches = 0;
  let createdTokenId: string | null = null;
  const extended = prismaClient.$extends({
    name,
    query: {
      applicationExecutionToken: {
        async updateMany({ args, query }) {
          const view = safeTokenMutationView(
            (args.where ?? {}) as unknown as Record<string, unknown>,
            args.data as unknown as Record<string, unknown>
          );
          const matchesTarget = matchesTokenMutation(view, {
            kind: "replacement",
            userId: expected.userId,
            runId: expected.runId,
            at: expected.issuedAt
          });
          const result = await query(args);
          if (matchesTarget) {
            assert.equal(result.count, expected.supersededCount);
            replacementMatches += 1;
          }
          return result;
        },
        async create({ args, query }) {
          const data = args.data as unknown as Record<string, unknown>;
          const expectedExpiry = expected.issuedAt.getTime() + READ_TOKEN_TTL_MS;
          const matchesTarget =
            data.userId === expected.userId &&
            data.runId === expected.runId &&
            data.host === SYNTHETIC_HOST &&
            data.scope === "APPLICATION_READ" &&
            data.singleUse === false &&
            data.expiresAt instanceof Date &&
            data.expiresAt.getTime() === expectedExpiry;
          const result = await query(args);
          if (matchesTarget) {
            if (typeof result.id !== "string") assert.fail("C5.5 issuance create did not return a safe token ID.");
            createdTokenId = result.id;
            createMatches += 1;
          }
          return result;
        }
      },
      auditLog: {
        async create({ args, query }) {
          const data = args.data as unknown as Record<string, unknown>;
          const matchesTarget =
            data.userId === expected.userId &&
            data.action === "application-execution-token.create" &&
            data.resource === "ApplicationExecutionToken" &&
            typeof data.resourceId === "string" &&
            metadataString(data, "runId") === expected.runId;
          const result = await query(args);
          if (matchesTarget) {
            assert.equal(replacementMatches, 1);
            assert.equal(createMatches, 1);
            assert.ok(createdTokenId);
            assert.equal(data.resourceId, createdTokenId);
            auditMatches += 1;
            reached.resolve();
            await release.wait();
          }
          return result;
        }
      }
    }
  }) as unknown as PostgresTestActor["client"];
  return {
    prismaClient: extended,
    assertMatches: () => {
      assert.equal(replacementMatches, 1, `${name} replacement matches`);
      assert.equal(createMatches, 1, `${name} create matches`);
      assert.equal(auditMatches, 1, `${name} audit matches`);
    }
  };
}

function extendCancellationPause(
  prismaClient: PostgresTestActor["client"],
  name: string,
  expected: {
    userId: string;
    runId: string;
    previousState: "READY";
    previousStateVersion: number;
    previousAttemptId: string | null;
    cancelledAt: Date;
  },
  reached: Deferred<void>,
  release: Deferred<void>
): { prismaClient: PostgresTestActor["client"]; assertMatches: () => void } {
  let matches = 0;
  const extended = prismaClient.$extends({
    name,
    query: {
      applicationRun: {
        async updateMany({ args, query }) {
          const where = args.where as unknown as Record<string, unknown>;
          const data = args.data as unknown as Record<string, unknown>;
          const matchesTarget =
            where.id === expected.runId &&
            where.userId === expected.userId &&
            where.state === expected.previousState &&
            where.stateVersion === expected.previousStateVersion &&
            where.prepareAttemptId === expected.previousAttemptId &&
            data.state === "CANCELLED" &&
            isIncrementOne(data.stateVersion) &&
            data.activeRunKey === null &&
            data.prepareAttemptId === null &&
            data.prepareLeaseExpiresAt === null &&
            data.cancelledAt instanceof Date &&
            data.cancelledAt.getTime() === expected.cancelledAt.getTime();
          const result = await query(args);
          if (matchesTarget) {
            assert.equal(result.count, 1);
            matches += 1;
            reached.resolve();
            await release.wait();
          }
          return result;
        }
      }
    }
  }) as unknown as PostgresTestActor["client"];
  return { prismaClient: extended, assertMatches: () => assert.equal(matches, 1, `${name} matches`) };
}

type TokenMutationExpectation =
  | {
      kind: "replacement";
      userId: string;
      runId: string;
      at: Date;
    }
  | {
      kind: "authorization";
      userId: string;
      runId: string;
      at: Date;
    }
  | {
      kind: "consume";
      userId: string;
      runId: string;
      at: Date;
    }
  | {
      kind: "revoke";
      userId: string;
      tokenId: string;
      at: Date;
    };

function sameDate(value: unknown, expected: Date): boolean {
  return value instanceof Date && value.getTime() === expected.getTime();
}

function isIncrementOne(value: unknown): boolean {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).increment === 1
  );
}

function safeTokenMutationView(
  where: Record<string, unknown>,
  data: Record<string, unknown>
): SafeTokenMutationView {
  const expiresAt = where.expiresAt;
  const expiresAfter =
    expiresAt && typeof expiresAt === "object" && !Array.isArray(expiresAt)
      ? (expiresAt as Record<string, unknown>).gt
      : undefined;
  return {
    id: where.id,
    userId: where.userId,
    runId: where.runId,
    host: where.host,
    scope: where.scope,
    singleUse: where.singleUse,
    consumedAtPredicate: where.consumedAt,
    revokedAtPredicate: where.revokedAt,
    expiresAfter,
    consumedAtWrite: data.consumedAt,
    lastUsedAtWrite: data.lastUsedAt,
    revokedAtWrite: data.revokedAt
  };
}

function matchesTokenMutation(
  view: SafeTokenMutationView,
  expected: TokenMutationExpectation
): boolean {
  if (expected.kind === "revoke") {
    return view.id === expected.tokenId && view.userId === expected.userId &&
      view.revokedAtPredicate === null && sameDate(view.revokedAtWrite, expected.at);
  }
  const bindingMatches =
    view.userId === expected.userId &&
    view.runId === expected.runId &&
    view.host === SYNTHETIC_HOST &&
    view.revokedAtPredicate === null;
  if (!bindingMatches) return false;
  if (expected.kind === "replacement") {
    return view.scope === "APPLICATION_READ" && view.singleUse === false && view.consumedAtPredicate === null &&
      sameDate(view.revokedAtWrite, expected.at) && view.lastUsedAtWrite === undefined &&
      view.consumedAtWrite === undefined;
  }
  if (expected.kind === "authorization") {
    return view.scope === "APPLICATION_READ" && view.singleUse === false && view.expiresAfter instanceof Date &&
      sameDate(view.lastUsedAtWrite, expected.at) && view.consumedAtWrite === undefined &&
      view.revokedAtWrite === undefined;
  }
  return view.scope === "APPLICATION_FILL" && view.singleUse === true && view.consumedAtPredicate === null &&
    view.expiresAfter instanceof Date && sameDate(view.consumedAtWrite, expected.at) &&
    sameDate(view.lastUsedAtWrite, expected.at) && view.revokedAtWrite === undefined;
}

function extendTokenMutationClient(
  prismaClient: PostgresTestActor["client"],
  name: string,
  expected: TokenMutationExpectation,
  callbacks: {
    before?: () => void | Promise<void>;
    after?: (count: number) => void | Promise<void>;
  } = {}
): { prismaClient: PostgresTestActor["client"]; assertMatches: (expectedCount?: number) => void } {
  let matches = 0;
  const extended = prismaClient.$extends({
    name,
    query: {
      applicationExecutionToken: {
        async updateMany({ args, query }) {
          const where = (args.where ?? {}) as unknown as Record<string, unknown>;
          const data = args.data as unknown as Record<string, unknown>;
          const matchesTarget = matchesTokenMutation(
            safeTokenMutationView(where, data),
            expected
          );
          if (matchesTarget) {
            matches += 1;
            await callbacks.before?.();
          }
          const result = await query(args);
          if (matchesTarget) await callbacks.after?.(result.count);
          return result;
        }
      }
    }
  }) as unknown as PostgresTestActor["client"];
  return {
    prismaClient: extended,
    assertMatches: (expectedCount = 1) => assert.equal(matches, expectedCount, `${name} matches`)
  };
}

async function settlePair<T, U>(
  first: Promise<T>,
  second: Promise<U>,
  label: string
): Promise<[PromiseSettledResult<T>, PromiseSettledResult<U>]> {
  return withTimeout(Promise.allSettled([first, second]), OPERATION_TIMEOUT_MS, label) as
    Promise<[PromiseSettledResult<T>, PromiseSettledResult<U>]>;
}

test("execution-token issuance commits before cancellation and cancellation revokes it", async () => {
  const scenario = await createScenario("issue-before-cancel");
  await runScenarioBody(scenario, async () => {
    const fixture = await createReadyRunFixture(scenario, "user");
    const issuedAt = new Date("2026-02-01T00:00:00.000Z");
    const cancelledAt = new Date("2026-02-01T00:01:00.000Z");
    const rejectedAuthAt = new Date("2026-02-01T00:02:00.000Z");
    const issueClock = queuedClock("issue-before-cancel issuer", [issuedAt]);
    const cancelClock = queuedClock("issue-before-cancel cancellation", [cancelledAt]);
    const authClock = queuedClock("issue-before-cancel rejected authorization", [rejectedAuthAt]);
    const generator = trackedTokenGenerator("issue-before-cancel");
    const issueAuditWritten = deferred("issue-before-cancel token audit written");
    const releaseIssuer = trackRelease(scenario, deferred("release issue-before-cancel issuer"));
    const cancelRunLockAttempted = deferred("issue-before-cancel cancellation run lock attempted");
    let cancellationRunLockCompleted = false;

    const issuerHooks = createHookedPrismaClient(scenario.actorA, []);
    const issuerPause = extendTokenCreateAuditPause(
      issuerHooks.prismaClient,
      "c55IssueBeforeCancelAuditPause",
      { userId: fixture.userId, runId: fixture.runId, issuedAt, supersededCount: 0 },
      issueAuditWritten,
      releaseIssuer
    );
    const cancellationHooks = createHookedPrismaClient(scenario.actorB, [
      {
        name: "issue-before-cancel cancellation run lock",
        match: RUN_ROW_LOCK,
        before: () => cancelRunLockAttempted.resolve(),
        after: () => {
          cancellationRunLockCompleted = true;
        }
      }
    ]);
    const issueService = createTokenService(issuerPause.prismaClient, issueClock.clock, generator.generate);
    const cancellationService = createCancellationService(cancellationHooks.prismaClient, cancelClock.clock);

    const issuance = trackOperation(
      scenario,
      issueService.issueExecutionToken({
        userId: fixture.userId,
        runId: fixture.runId,
        scope: "APPLICATION_READ"
      })
    );
    await withTimeout(issueAuditWritten.wait(), OPERATION_TIMEOUT_MS, "issuer token audit barrier");

    const cancellation = trackOperation(
      scenario,
      cancellationService.cancelApplicationRun({ userId: fixture.userId, runId: fixture.runId })
    );
    await withTimeout(cancelRunLockAttempted.wait(), OPERATION_TIMEOUT_MS, "cancellation run-lock attempt");
    await assertObservedLockWait(scenario.observer, scenario.actorB, scenario.actorA);
    assert.equal(cancellationRunLockCompleted, false, "cancellation run lock must still be in flight");

    releaseIssuer.resolve();
    const [issuanceResult, cancellationResult] = await settlePair(
      issuance,
      cancellation,
      "issue-before-cancel operations"
    );
    const issued = requireFulfilled(issuanceResult, scenario.actorA, "token issuance");
    const cancelled = requireFulfilled(cancellationResult, scenario.actorB, "run cancellation");
    assert.equal(cancellationRunLockCompleted, true, "cancellation run lock must complete after issuer release");
    const issuedTokenId = issued.tokenRecord.id;
    const issuedRawToken = issued.token;
    assert.equal(issued.tokenRecord.scope, "APPLICATION_READ");
    assert.equal(issued.tokenRecord.singleUse, false);
    assert.equal(issued.tokenRecord.expiresAt.getTime(), issuedAt.getTime() + READ_TOKEN_TTL_MS);
    assert.equal(cancelled.revokedExecutionTokenCount, 1);
    assert.equal(cancelled.run.state, "CANCELLED");
    assert.equal(cancelled.run.stateVersion, 3);

    const tokens = await readSafeTokens(scenario.observer, fixture);
    assert.equal(tokens.length, 1);
    const token = tokens[0];
    assert.equal(token.id, issuedTokenId);
    assertReusableToken(token, fixture);
    assert.equal(token.revokedAt?.getTime(), cancelledAt.getTime());
    assert.equal(token.lastUsedAt, null);
    assert.equal(isTokenLive(token, rejectedAuthAt), false);
    assertCancelledRun(await readRun(scenario.observer, fixture), fixture, cancelledAt);

    const rejectedAuthorization = await Promise.allSettled([
      createTokenService(scenario.actorA.client, authClock.clock)
        .authorizeReusableExecutionToken(bindingInput(issuedRawToken, fixture, "APPLICATION_READ"))
    ]);
    assertPublicError(
      requireRejected(rejectedAuthorization[0], scenario.actorA, "post-cancellation authorization"),
      { code: "EXECUTION_TOKEN_INVALID", status: 401 }
    );

    const audits = await readAudits(scenario.observer, fixture.userId);
    const events = await readEvents(scenario.observer, fixture.userId);
    assert.equal(audits.length, 3);
    assertTokenCreateAudit(
      requireSingleAudit(audits, "application-execution-token.create", "ApplicationExecutionToken", token.id),
      fixture,
      token,
      0,
      issuedAt
    );
    assertCancellationRecords(audits, events, fixture, cancelledAt, 1);
    assert.equal(matchingAudits(audits, "application-execution-token.consume").length, 0);
    assert.equal(matchingAudits(audits, "application-execution-token.revoke").length, 0);

    issueClock.assertCalls(1);
    cancelClock.assertCalls(1);
    authClock.assertCalls(1);
    generator.assertCalls(1);
    issuerPause.assertMatches();
    issuerHooks.assertExpectedHooksReached();
    cancellationHooks.assertExpectedHooksReached();
    await assertScenarioSessionsPinned(scenario, "complete");
  });
});

test("cancellation commits before issuance and issuance rejects the cancelled run", async () => {
  const scenario = await createScenario("cancel-before-issue");
  await runScenarioBody(scenario, async () => {
    const fixture = await createReadyRunFixture(scenario, "user");
    const cancelledAt = new Date("2026-02-02T00:00:00.000Z");
    const unusedIssuanceAt = new Date("2026-02-02T00:01:00.000Z");
    const cancelClock = queuedClock("cancel-before-issue cancellation", [cancelledAt]);
    const issueClock = queuedClock("cancel-before-issue issuer", [unusedIssuanceAt]);
    const generator = trackedTokenGenerator("cancel-before-issue");
    const cancellationUpdated = deferred("cancel-before-issue lifecycle updated");
    const releaseCancellation = trackRelease(scenario, deferred("release cancel-before-issue cancellation"));
    const issuerPolicyLockGranted = deferred("cancel-before-issue issuer policy lock granted");
    const issuerRunLockAttempted = deferred("cancel-before-issue issuer run lock attempted");
    let issuanceRunLockCompleted = false;

    const cancellationHooks = createHookedPrismaClient(scenario.actorA, []);
    const cancellationPause = extendCancellationPause(
      cancellationHooks.prismaClient,
      "c55CancelBeforeIssueLifecyclePause",
      {
        userId: fixture.userId,
        runId: fixture.runId,
        previousState: "READY",
        previousStateVersion: 2,
        previousAttemptId: null,
        cancelledAt
      },
      cancellationUpdated,
      releaseCancellation
    );
    const issuerHooks = createHookedPrismaClient(scenario.actorB, [
      {
        name: "cancel-before-issue issuer policy lock",
        match: POLICY_ROW_LOCK,
        after: () => issuerPolicyLockGranted.resolve()
      },
      {
        name: "cancel-before-issue issuer run lock",
        match: RUN_ROW_LOCK,
        before: () => issuerRunLockAttempted.resolve(),
        after: () => {
          issuanceRunLockCompleted = true;
        }
      }
    ]);
    const cancellationService = createCancellationService(cancellationPause.prismaClient, cancelClock.clock);
    const issueService = createTokenService(issuerHooks.prismaClient, issueClock.clock, generator.generate);

    const cancellation = trackOperation(
      scenario,
      cancellationService.cancelApplicationRun({ userId: fixture.userId, runId: fixture.runId })
    );
    await withTimeout(cancellationUpdated.wait(), OPERATION_TIMEOUT_MS, "cancellation lifecycle barrier");

    const issuance = trackOperation(
      scenario,
      issueService.issueExecutionToken({
        userId: fixture.userId,
        runId: fixture.runId,
        scope: "APPLICATION_READ"
      })
    );
    await withTimeout(issuerPolicyLockGranted.wait(), OPERATION_TIMEOUT_MS, "issuer policy lock");
    await withTimeout(issuerRunLockAttempted.wait(), OPERATION_TIMEOUT_MS, "issuer run-lock attempt");
    await assertObservedLockWait(scenario.observer, scenario.actorB, scenario.actorA);
    assert.equal(issuanceRunLockCompleted, false, "issuance run lock must still be in flight");

    releaseCancellation.resolve();
    const [cancellationResult, issuanceResult] = await settlePair(
      cancellation,
      issuance,
      "cancel-before-issue operations"
    );
    const cancelled = requireFulfilled(cancellationResult, scenario.actorA, "run cancellation");
    assert.equal(cancelled.revokedExecutionTokenCount, 0);
    assertPublicError(requireRejected(issuanceResult, scenario.actorB, "post-cancel issuance"), {
      code: "RUN_INVALID_STATE",
      status: 409
    });
    assert.equal(issuanceRunLockCompleted, true, "issuance run lock must complete after cancellation release");

    assertCancelledRun(await readRun(scenario.observer, fixture), fixture, cancelledAt);
    assert.deepEqual(await readSafeTokens(scenario.observer, fixture), []);
    const audits = await readAudits(scenario.observer, fixture.userId);
    const events = await readEvents(scenario.observer, fixture.userId);
    assert.equal(audits.length, 2);
    assert.equal(matchingAudits(audits, "application-execution-token.create").length, 0);
    assertCancellationRecords(audits, events, fixture, cancelledAt, 0);

    cancelClock.assertCalls(1);
    issueClock.assertCalls(0);
    generator.assertCalls(0);
    cancellationPause.assertMatches();
    cancellationHooks.assertExpectedHooksReached();
    issuerHooks.assertExpectedHooksReached();
    await assertScenarioSessionsPinned(scenario, "complete");
  });
});

test("simultaneous replacement issuance leaves exactly one live successor", async () => {
  const scenario = await createScenario("replacement-issuance");
  await runScenarioBody(scenario, async () => {
    const fixture = await createReadyRunFixture(scenario, "user");
    const initialAt = new Date("2026-02-03T00:00:00.000Z");
    const successorAAt = new Date("2026-02-03T00:01:00.000Z");
    const successorBAt = new Date("2026-02-03T00:02:00.000Z");
    const observationAt = new Date("2026-02-03T00:03:00.000Z");
    const initialClock = queuedClock("replacement initial", [initialAt]);
    const aClock = queuedClock("replacement A", [successorAAt]);
    const bClock = queuedClock("replacement B", [successorBAt]);
    const initialGenerator = trackedTokenGenerator("replacement-initial");
    const aGenerator = trackedTokenGenerator("replacement-a");
    const bGenerator = trackedTokenGenerator("replacement-b");

    const initialIssued = await createTokenService(
      scenario.observer.client,
      initialClock.clock,
      initialGenerator.generate
    ).issueExecutionToken({ userId: fixture.userId, runId: fixture.runId, scope: "APPLICATION_READ" });
    const initialTokenId = initialIssued.tokenRecord.id;

    const aAuditWritten = deferred("replacement A token audit written");
    const releaseA = trackRelease(scenario, deferred("release replacement A"));
    const bPolicyLockAttempted = deferred("replacement B policy lock attempted");
    let issuerBPolicyLockCompleted = false;
    const aHooks = createHookedPrismaClient(scenario.actorA, []);
    const aPause = extendTokenCreateAuditPause(
      aHooks.prismaClient,
      "c55ReplacementAAuditPause",
      { userId: fixture.userId, runId: fixture.runId, issuedAt: successorAAt, supersededCount: 1 },
      aAuditWritten,
      releaseA
    );
    const bHooks = createHookedPrismaClient(scenario.actorB, [
      {
        name: "replacement B policy serialization lock",
        match: POLICY_ROW_LOCK,
        before: () => bPolicyLockAttempted.resolve(),
        after: () => {
          issuerBPolicyLockCompleted = true;
        }
      }
    ]);
    const serviceA = createTokenService(aPause.prismaClient, aClock.clock, aGenerator.generate);
    const serviceB = createTokenService(bHooks.prismaClient, bClock.clock, bGenerator.generate);

    const operationA = trackOperation(
      scenario,
      serviceA.issueExecutionToken({ userId: fixture.userId, runId: fixture.runId, scope: "APPLICATION_READ" })
    );
    await withTimeout(aAuditWritten.wait(), OPERATION_TIMEOUT_MS, "replacement A audit barrier");
    const operationB = trackOperation(
      scenario,
      serviceB.issueExecutionToken({ userId: fixture.userId, runId: fixture.runId, scope: "APPLICATION_READ" })
    );
    await withTimeout(bPolicyLockAttempted.wait(), OPERATION_TIMEOUT_MS, "replacement B policy lock attempt");
    await assertObservedLockWait(scenario.observer, scenario.actorB, scenario.actorA);
    assert.equal(issuerBPolicyLockCompleted, false, "replacement B policy lock must still be in flight");

    releaseA.resolve();
    const [resultA, resultB] = await settlePair(operationA, operationB, "replacement issuance operations");
    const issuedA = requireFulfilled(resultA, scenario.actorA, "replacement issuance A");
    const issuedB = requireFulfilled(resultB, scenario.actorB, "replacement issuance B");
    assert.equal(issuerBPolicyLockCompleted, true, "replacement B policy lock must complete after A release");
    const successorAId = issuedA.tokenRecord.id;
    const successorBId = issuedB.tokenRecord.id;
    assert.notEqual(initialTokenId, successorAId);
    assert.notEqual(successorAId, successorBId);

    const tokens = await readSafeTokens(scenario.observer, fixture);
    assert.equal(tokens.length, 3);
    const initial = tokens.find(({ id }) => id === initialTokenId);
    const successorA = tokens.find(({ id }) => id === successorAId);
    const successorB = tokens.find(({ id }) => id === successorBId);
    assert.ok(initial);
    assert.ok(successorA);
    assert.ok(successorB);
    for (const token of tokens) {
      assertReusableToken(token, fixture);
      assert.equal(token.lastUsedAt, null);
    }
    assert.equal(initial.revokedAt?.getTime(), successorAAt.getTime());
    assert.equal(successorA.revokedAt?.getTime(), successorBAt.getTime());
    assert.equal(successorB.revokedAt, null);
    assert.equal(tokens.filter((token) => isTokenLive(token, observationAt)).length, 1);
    assert.equal(isTokenLive(successorB, observationAt), true);

    const audits = await readAudits(scenario.observer, fixture.userId);
    const createAudits = matchingAudits(audits, "application-execution-token.create");
    assert.equal(audits.length, 3);
    assert.equal(createAudits.length, 3);
    assertTokenCreateAudit(
      requireSingleAudit(createAudits, "application-execution-token.create", "ApplicationExecutionToken", initial.id),
      fixture,
      initial,
      0,
      initialAt
    );
    assertTokenCreateAudit(
      requireSingleAudit(createAudits, "application-execution-token.create", "ApplicationExecutionToken", successorA.id),
      fixture,
      successorA,
      1,
      successorAAt
    );
    assertTokenCreateAudit(
      requireSingleAudit(createAudits, "application-execution-token.create", "ApplicationExecutionToken", successorB.id),
      fixture,
      successorB,
      1,
      successorBAt
    );
    assert.deepEqual(await readEvents(scenario.observer, fixture.userId), []);

    initialClock.assertCalls(1);
    aClock.assertCalls(1);
    bClock.assertCalls(1);
    initialGenerator.assertCalls(1);
    aGenerator.assertCalls(1);
    bGenerator.assertCalls(1);
    aPause.assertMatches();
    aHooks.assertExpectedHooksReached();
    bHooks.assertExpectedHooksReached();
    await assertScenarioSessionsPinned(scenario, "complete");
  });
});

test("reusable authorization waits for individual revocation and then fails closed", async () => {
  const scenario = await createScenario("authorization-vs-revoke");
  await runScenarioBody(scenario, async () => {
    const fixture = await createReadyRunFixture(scenario, "user");
    const issuedAt = new Date("2026-02-04T00:00:00.000Z");
    const preAuthorizedAt = new Date("2026-02-04T00:01:00.000Z");
    const revokedAt = new Date("2026-02-04T00:02:00.000Z");
    const blockedAuthAt = new Date("2026-02-04T00:03:00.000Z");
    const postRevokeAuthAt = new Date("2026-02-04T00:04:00.000Z");
    const issueClock = queuedClock("authorization-vs-revoke issue", [issuedAt]);
    const preAuthClock = queuedClock("authorization-vs-revoke pre-auth", [preAuthorizedAt]);
    const revokeClock = queuedClock("authorization-vs-revoke revoke", [revokedAt]);
    const blockedAuthClock = queuedClock("authorization-vs-revoke blocked auth", [blockedAuthAt]);
    const postAuthClock = queuedClock("authorization-vs-revoke post auth", [postRevokeAuthAt]);
    const generator = trackedTokenGenerator("authorization-vs-revoke");
    const issued = await createTokenService(
      scenario.observer.client,
      issueClock.clock,
      generator.generate
    ).issueExecutionToken({ userId: fixture.userId, runId: fixture.runId, scope: "APPLICATION_READ" });
    const tokenId = issued.tokenRecord.id;
    const rawToken = issued.token;

    const preAuthorized = await createTokenService(scenario.actorB.client, preAuthClock.clock)
      .authorizeReusableExecutionToken(bindingInput(rawToken, fixture, "APPLICATION_READ"));
    assert.equal(preAuthorized.id, tokenId);
    let token = await requireSafeToken(scenario.observer, tokenId);
    assert.equal(token.lastUsedAt?.getTime(), preAuthorizedAt.getTime());

    const revokeUpdated = deferred("authorization-vs-revoke revocation updated");
    const releaseRevoke = trackRelease(scenario, deferred("release authorization-vs-revoke revocation"));
    const authorizationAttempted = deferred("authorization-vs-revoke authorization attempted");
    const revokeMutation = extendTokenMutationClient(
      scenario.actorA.client,
      "c55AuthorizationVsRevokeHolder",
      { kind: "revoke", userId: fixture.userId, tokenId, at: revokedAt },
      {
        after: async (count) => {
          assert.equal(count, 1);
          revokeUpdated.resolve();
          await releaseRevoke.wait();
        }
      }
    );
    const authorizationMutation = extendTokenMutationClient(
      scenario.actorB.client,
      "c55AuthorizationVsRevokeWaiter",
      { kind: "authorization", userId: fixture.userId, runId: fixture.runId, at: blockedAuthAt },
      {
        before: () => authorizationAttempted.resolve(),
        after: (count) => assert.equal(count, 0)
      }
    );
    const revokeService = createTokenService(revokeMutation.prismaClient, revokeClock.clock);
    const authorizationService = createTokenService(authorizationMutation.prismaClient, blockedAuthClock.clock);

    const revoke = trackOperation(
      scenario,
      revokeService.revokeExecutionToken({ userId: fixture.userId, tokenId })
    );
    await withTimeout(revokeUpdated.wait(), OPERATION_TIMEOUT_MS, "revocation update barrier");
    const authorization = trackOperation(
      scenario,
      authorizationService.authorizeReusableExecutionToken(bindingInput(rawToken, fixture, "APPLICATION_READ"))
    );
    await withTimeout(authorizationAttempted.wait(), OPERATION_TIMEOUT_MS, "authorization mutation attempt");
    await assertObservedLockWait(scenario.observer, scenario.actorB, scenario.actorA);

    releaseRevoke.resolve();
    const [revokeResult, authorizationResult] = await settlePair(
      revoke,
      authorization,
      "authorization-vs-revoke operations"
    );
    assert.deepEqual(requireFulfilled(revokeResult, scenario.actorA, "individual revoke"), {
      revoked: true,
      alreadyRevoked: false
    });
    assertPublicError(requireRejected(authorizationResult, scenario.actorB, "blocked authorization"), {
      code: "EXECUTION_TOKEN_INVALID",
      status: 401
    });

    const postAuthorization = await Promise.allSettled([
      createTokenService(scenario.actorB.client, postAuthClock.clock)
        .authorizeReusableExecutionToken(bindingInput(rawToken, fixture, "APPLICATION_READ"))
    ]);
    assertPublicError(
      requireRejected(postAuthorization[0], scenario.actorB, "post-revocation authorization"),
      { code: "EXECUTION_TOKEN_INVALID", status: 401 }
    );

    token = await requireSafeToken(scenario.observer, tokenId);
    assertReusableToken(token, fixture);
    assert.equal(token.lastUsedAt?.getTime(), preAuthorizedAt.getTime());
    assert.equal(token.revokedAt?.getTime(), revokedAt.getTime());
    const audits = await readAudits(scenario.observer, fixture.userId);
    assert.equal(audits.length, 2);
    assertTokenCreateAudit(
      requireSingleAudit(audits, "application-execution-token.create", "ApplicationExecutionToken", tokenId),
      fixture,
      token,
      0,
      issuedAt
    );
    assertRevokeAudit(
      requireSingleAudit(audits, "application-execution-token.revoke", "ApplicationExecutionToken", tokenId),
      fixture,
      tokenId,
      "APPLICATION_READ",
      revokedAt
    );
    assert.equal(matchingAudits(audits, "application-execution-token.consume").length, 0);
    assert.deepEqual(await readEvents(scenario.observer, fixture.userId), []);

    issueClock.assertCalls(1);
    preAuthClock.assertCalls(1);
    revokeClock.assertCalls(1);
    blockedAuthClock.assertCalls(1);
    postAuthClock.assertCalls(1);
    generator.assertCalls(1);
    revokeMutation.assertMatches();
    authorizationMutation.assertMatches();
    await assertScenarioSessionsPinned(scenario, "complete");
  });
});

test("predecessor authorization waits for atomic replacement and successor alone authorizes", async () => {
  const scenario = await createScenario("authorization-during-replacement");
  await runScenarioBody(scenario, async () => {
    const fixture = await createReadyRunFixture(scenario, "user");
    const initialAt = new Date("2026-02-05T00:00:00.000Z");
    const replacementAt = new Date("2026-02-05T00:01:00.000Z");
    const blockedOldAuthAt = new Date("2026-02-05T00:02:00.000Z");
    const rejectedOldAuthAt = new Date("2026-02-05T00:03:00.000Z");
    const newAuthAt = new Date("2026-02-05T00:04:00.000Z");
    const observationAt = new Date("2026-02-05T00:05:00.000Z");
    const initialClock = queuedClock("authorization-during-replacement initial", [initialAt]);
    const replacementClock = queuedClock("authorization-during-replacement issuer", [replacementAt]);
    const blockedOldClock = queuedClock("authorization-during-replacement blocked old", [blockedOldAuthAt]);
    const rejectedOldClock = queuedClock("authorization-during-replacement rejected old", [rejectedOldAuthAt]);
    const newAuthClock = queuedClock("authorization-during-replacement new", [newAuthAt]);
    const initialGenerator = trackedTokenGenerator("authorization-during-replacement-initial");
    const replacementGenerator = trackedTokenGenerator("authorization-during-replacement-new");
    const initialIssued = await createTokenService(
      scenario.observer.client,
      initialClock.clock,
      initialGenerator.generate
    ).issueExecutionToken({ userId: fixture.userId, runId: fixture.runId, scope: "APPLICATION_READ" });
    const predecessorId = initialIssued.tokenRecord.id;
    const predecessorRawToken = initialIssued.token;

    const replacementAuditWritten = deferred("replacement visibility audit written");
    const releaseReplacement = trackRelease(scenario, deferred("release replacement visibility issuer"));
    const oldAuthorizationAttempted = deferred("old authorization mutation attempted");
    const issuerHooks = createHookedPrismaClient(scenario.actorA, []);
    const issuerPause = extendTokenCreateAuditPause(
      issuerHooks.prismaClient,
      "c55ReplacementVisibilityAuditPause",
      { userId: fixture.userId, runId: fixture.runId, issuedAt: replacementAt, supersededCount: 1 },
      replacementAuditWritten,
      releaseReplacement
    );
    const oldAuthorizationMutation = extendTokenMutationClient(
      scenario.actorB.client,
      "c55ReplacementVisibilityOldAuthorization",
      { kind: "authorization", userId: fixture.userId, runId: fixture.runId, at: blockedOldAuthAt },
      {
        before: () => oldAuthorizationAttempted.resolve(),
        after: (count) => assert.equal(count, 0)
      }
    );
    const replacementService = createTokenService(
      issuerPause.prismaClient,
      replacementClock.clock,
      replacementGenerator.generate
    );
    const blockedAuthorizationService = createTokenService(
      oldAuthorizationMutation.prismaClient,
      blockedOldClock.clock
    );

    const replacement = trackOperation(
      scenario,
      replacementService.issueExecutionToken({
        userId: fixture.userId,
        runId: fixture.runId,
        scope: "APPLICATION_READ"
      })
    );
    await withTimeout(replacementAuditWritten.wait(), OPERATION_TIMEOUT_MS, "replacement visibility audit barrier");
    const visibleBeforeCommit = await readSafeTokens(scenario.observer, fixture);
    assert.equal(visibleBeforeCommit.length, 1);
    assert.equal(visibleBeforeCommit[0].id, predecessorId);
    assert.equal(visibleBeforeCommit[0].revokedAt, null);
    assert.equal(visibleBeforeCommit[0].lastUsedAt, null);

    const oldAuthorization = trackOperation(
      scenario,
      blockedAuthorizationService.authorizeReusableExecutionToken(
        bindingInput(predecessorRawToken, fixture, "APPLICATION_READ")
      )
    );
    await withTimeout(oldAuthorizationAttempted.wait(), OPERATION_TIMEOUT_MS, "old authorization attempt");
    await assertObservedLockWait(scenario.observer, scenario.actorB, scenario.actorA);

    releaseReplacement.resolve();
    const [replacementResult, oldAuthorizationResult] = await settlePair(
      replacement,
      oldAuthorization,
      "replacement visibility operations"
    );
    const successorIssued = requireFulfilled(replacementResult, scenario.actorA, "replacement issuance");
    const successorId = successorIssued.tokenRecord.id;
    const successorRawToken = successorIssued.token;
    assertPublicError(
      requireRejected(oldAuthorizationResult, scenario.actorB, "blocked predecessor authorization"),
      { code: "EXECUTION_TOKEN_INVALID", status: 401 }
    );

    const postCommitOldMutation = extendTokenMutationClient(
      scenario.actorB.client,
      "c55PostReplacementOldAuthorization",
      { kind: "authorization", userId: fixture.userId, runId: fixture.runId, at: rejectedOldAuthAt },
      { after: (count) => assert.equal(count, 0) }
    );
    const postCommitOldAuthorization = await Promise.allSettled([
      createTokenService(postCommitOldMutation.prismaClient, rejectedOldClock.clock)
        .authorizeReusableExecutionToken(bindingInput(predecessorRawToken, fixture, "APPLICATION_READ"))
    ]);
    assertPublicError(
      requireRejected(postCommitOldAuthorization[0], scenario.actorB, "post-replacement predecessor authorization"),
      { code: "EXECUTION_TOKEN_INVALID", status: 401 }
    );
    postCommitOldMutation.assertMatches();
    const rowsAfterOldAuthorization = await readSafeTokens(scenario.observer, fixture);
    assert.equal(rowsAfterOldAuthorization.length, 2);
    const predecessorAfterOldAuthorization = rowsAfterOldAuthorization.find(({ id }) => id === predecessorId);
    const successorAfterOldAuthorization = rowsAfterOldAuthorization.find(({ id }) => id === successorId);
    assert.ok(predecessorAfterOldAuthorization);
    assert.ok(successorAfterOldAuthorization);
    assert.equal(predecessorAfterOldAuthorization.lastUsedAt, null);
    assert.equal(predecessorAfterOldAuthorization.revokedAt?.getTime(), replacementAt.getTime());
    assert.equal(successorAfterOldAuthorization.lastUsedAt, null);
    assert.equal(successorAfterOldAuthorization.revokedAt, null);

    const successorBinding = await createTokenService(scenario.actorB.client, newAuthClock.clock)
      .authorizeReusableExecutionToken(bindingInput(successorRawToken, fixture, "APPLICATION_READ"));
    assert.equal(successorBinding.id, successorId);

    const tokens = await readSafeTokens(scenario.observer, fixture);
    assert.equal(tokens.length, 2);
    const predecessor = tokens.find(({ id }) => id === predecessorId);
    const successor = tokens.find(({ id }) => id === successorId);
    assert.ok(predecessor);
    assert.ok(successor);
    assertReusableToken(predecessor, fixture);
    assertReusableToken(successor, fixture);
    assert.equal(predecessor.revokedAt?.getTime(), replacementAt.getTime());
    assert.equal(predecessor.lastUsedAt, null);
    assert.equal(successor.revokedAt, null);
    assert.equal(successor.lastUsedAt?.getTime(), newAuthAt.getTime());
    assert.equal(tokens.filter((token) => isTokenLive(token, observationAt)).length, 1);
    assert.equal(isTokenLive(successor, observationAt), true);

    const audits = await readAudits(scenario.observer, fixture.userId);
    assert.equal(audits.length, 2);
    assertTokenCreateAudit(
      requireSingleAudit(audits, "application-execution-token.create", "ApplicationExecutionToken", predecessorId),
      fixture,
      predecessor,
      0,
      initialAt
    );
    assertTokenCreateAudit(
      requireSingleAudit(audits, "application-execution-token.create", "ApplicationExecutionToken", successorId),
      fixture,
      successor,
      1,
      replacementAt
    );
    assert.equal(matchingAudits(audits, "application-execution-token.consume").length, 0);
    assert.equal(matchingAudits(audits, "application-execution-token.revoke").length, 0);
    assert.deepEqual(await readEvents(scenario.observer, fixture.userId), []);

    initialClock.assertCalls(1);
    replacementClock.assertCalls(1);
    blockedOldClock.assertCalls(1);
    rejectedOldClock.assertCalls(1);
    newAuthClock.assertCalls(1);
    initialGenerator.assertCalls(1);
    replacementGenerator.assertCalls(1);
    issuerPause.assertMatches();
    oldAuthorizationMutation.assertMatches();
    issuerHooks.assertExpectedHooksReached();
    await assertScenarioSessionsPinned(scenario, "complete");
  });
});

test("simultaneous single-use consumption permits exactly one atomic winner", async () => {
  const scenario = await createScenario("double-consume");
  await runScenarioBody(scenario, async () => {
    const fixture = await createReadyRunFixture(scenario, "user");
    const consumedByAAt = new Date("2026-02-06T00:00:00.000Z");
    const attemptedByBAt = new Date("2026-02-06T00:00:01.000Z");
    const expiresAt = new Date("2026-02-06T01:00:00.000Z");
    const singleUse = await createSingleUseFixture(scenario, fixture, "double-consume", expiresAt);
    const clockA = queuedClock("double-consume A", [consumedByAAt]);
    const clockB = queuedClock("double-consume B", [attemptedByBAt]);
    const aConsumed = deferred("double-consume A mutation completed");
    const releaseA = trackRelease(scenario, deferred("release double-consume A"));
    const bAttempted = deferred("double-consume B mutation attempted");
    const mutationA = extendTokenMutationClient(
      scenario.actorA.client,
      "c55DoubleConsumeWinner",
      { kind: "consume", userId: fixture.userId, runId: fixture.runId, at: consumedByAAt },
      {
        after: async (count) => {
          assert.equal(count, 1);
          aConsumed.resolve();
          await releaseA.wait();
        }
      }
    );
    const mutationB = extendTokenMutationClient(
      scenario.actorB.client,
      "c55DoubleConsumeLoser",
      { kind: "consume", userId: fixture.userId, runId: fixture.runId, at: attemptedByBAt },
      {
        before: () => bAttempted.resolve(),
        after: (count) => assert.equal(count, 0)
      }
    );
    const serviceA = createTokenService(mutationA.prismaClient, clockA.clock);
    const serviceB = createTokenService(mutationB.prismaClient, clockB.clock);

    const operationA = trackOperation(
      scenario,
      serviceA.consumeSingleUseExecutionToken(bindingInput(singleUse.rawToken, fixture, "APPLICATION_FILL"))
    );
    await withTimeout(aConsumed.wait(), OPERATION_TIMEOUT_MS, "double-consume winner mutation");
    const operationB = trackOperation(
      scenario,
      serviceB.consumeSingleUseExecutionToken(bindingInput(singleUse.rawToken, fixture, "APPLICATION_FILL"))
    );
    await withTimeout(bAttempted.wait(), OPERATION_TIMEOUT_MS, "double-consume loser attempt");
    await assertObservedLockWait(scenario.observer, scenario.actorB, scenario.actorA);

    releaseA.resolve();
    const [resultA, resultB] = await settlePair(operationA, operationB, "double-consume operations");
    const winner = requireFulfilled(resultA, scenario.actorA, "single-use consume winner");
    assert.equal(winner.id, singleUse.tokenId);
    assert.equal(winner.singleUse, true);
    assertPublicError(requireRejected(resultB, scenario.actorB, "single-use consume loser"), {
      code: "EXECUTION_TOKEN_INVALID",
      status: 401
    });

    const token = await requireSafeToken(scenario.observer, singleUse.tokenId);
    assertSingleUseToken(token, fixture);
    assert.equal(token.consumedAt?.getTime(), consumedByAAt.getTime());
    assert.equal(token.lastUsedAt?.getTime(), consumedByAAt.getTime());
    assert.equal(token.revokedAt, null);
    assert.equal(isTokenLive(token, attemptedByBAt), false);
    const audits = await readAudits(scenario.observer, fixture.userId);
    assert.equal(audits.length, 1);
    assertConsumeAudit(
      requireSingleAudit(audits, "application-execution-token.consume", "ApplicationExecutionToken", token.id),
      fixture,
      token.id,
      consumedByAAt
    );
    assert.deepEqual(await readEvents(scenario.observer, fixture.userId), []);

    clockA.assertCalls(1);
    clockB.assertCalls(1);
    mutationA.assertMatches();
    mutationB.assertMatches();
    await assertScenarioSessionsPinned(scenario, "complete");
  });
});

test("single-use consume commits before individual revoke and both states remain monotonic", async () => {
  const scenario = await createScenario("consume-before-revoke");
  await runScenarioBody(scenario, async () => {
    const fixture = await createReadyRunFixture(scenario, "user");
    const consumedAt = new Date("2026-02-07T00:00:00.000Z");
    const revokedAt = new Date("2026-02-07T00:00:01.000Z");
    const rejectedConsumeAt = new Date("2026-02-07T00:00:02.000Z");
    const expiresAt = new Date("2026-02-07T01:00:00.000Z");
    const singleUse = await createSingleUseFixture(scenario, fixture, "consume-before-revoke", expiresAt);
    const consumeClock = queuedClock("consume-before-revoke consume", [consumedAt]);
    const revokeClock = queuedClock("consume-before-revoke revoke", [revokedAt]);
    const rejectedConsumeClock = queuedClock("consume-before-revoke repeated consume", [rejectedConsumeAt]);
    const consumeUpdated = deferred("consume-before-revoke consume updated");
    const releaseConsume = trackRelease(scenario, deferred("release consume-before-revoke consume"));
    const revokeAttempted = deferred("consume-before-revoke revoke attempted");
    const consumeMutation = extendTokenMutationClient(
      scenario.actorA.client,
      "c55ConsumeBeforeRevokeHolder",
      { kind: "consume", userId: fixture.userId, runId: fixture.runId, at: consumedAt },
      {
        after: async (count) => {
          assert.equal(count, 1);
          consumeUpdated.resolve();
          await releaseConsume.wait();
        }
      }
    );
    const revokeMutation = extendTokenMutationClient(
      scenario.actorB.client,
      "c55ConsumeBeforeRevokeWaiter",
      { kind: "revoke", userId: fixture.userId, tokenId: singleUse.tokenId, at: revokedAt },
      {
        before: () => revokeAttempted.resolve(),
        after: (count) => assert.equal(count, 1)
      }
    );
    const consumeService = createTokenService(consumeMutation.prismaClient, consumeClock.clock);
    const revokeService = createTokenService(revokeMutation.prismaClient, revokeClock.clock);

    const consume = trackOperation(
      scenario,
      consumeService.consumeSingleUseExecutionToken(bindingInput(singleUse.rawToken, fixture, "APPLICATION_FILL"))
    );
    await withTimeout(consumeUpdated.wait(), OPERATION_TIMEOUT_MS, "consume-before-revoke consume mutation");
    const revoke = trackOperation(
      scenario,
      revokeService.revokeExecutionToken({ userId: fixture.userId, tokenId: singleUse.tokenId })
    );
    await withTimeout(revokeAttempted.wait(), OPERATION_TIMEOUT_MS, "consume-before-revoke revoke attempt");
    await assertObservedLockWait(scenario.observer, scenario.actorB, scenario.actorA);

    releaseConsume.resolve();
    const [consumeResult, revokeResult] = await settlePair(consume, revoke, "consume-before-revoke operations");
    assert.equal(requireFulfilled(consumeResult, scenario.actorA, "single-use consumption").id, singleUse.tokenId);
    assert.deepEqual(requireFulfilled(revokeResult, scenario.actorB, "individual revocation"), {
      revoked: true,
      alreadyRevoked: false
    });

    const repeatedConsume = await Promise.allSettled([
      createTokenService(scenario.actorA.client, rejectedConsumeClock.clock)
        .consumeSingleUseExecutionToken(bindingInput(singleUse.rawToken, fixture, "APPLICATION_FILL"))
    ]);
    assertPublicError(requireRejected(repeatedConsume[0], scenario.actorA, "repeated single-use consume"), {
      code: "EXECUTION_TOKEN_INVALID",
      status: 401
    });

    const token = await requireSafeToken(scenario.observer, singleUse.tokenId);
    assertSingleUseToken(token, fixture);
    assert.equal(token.consumedAt?.getTime(), consumedAt.getTime());
    assert.equal(token.lastUsedAt?.getTime(), consumedAt.getTime());
    assert.equal(token.revokedAt?.getTime(), revokedAt.getTime());
    const audits = await readAudits(scenario.observer, fixture.userId);
    assert.equal(audits.length, 2);
    assertConsumeAudit(
      requireSingleAudit(audits, "application-execution-token.consume", "ApplicationExecutionToken", token.id),
      fixture,
      token.id,
      consumedAt
    );
    assertRevokeAudit(
      requireSingleAudit(audits, "application-execution-token.revoke", "ApplicationExecutionToken", token.id),
      fixture,
      token.id,
      "APPLICATION_FILL",
      revokedAt
    );
    assert.deepEqual(await readEvents(scenario.observer, fixture.userId), []);

    consumeClock.assertCalls(1);
    revokeClock.assertCalls(1);
    rejectedConsumeClock.assertCalls(1);
    consumeMutation.assertMatches();
    revokeMutation.assertMatches();
    await assertScenarioSessionsPinned(scenario, "complete");
  });
});

test("individual revoke commits before single-use consume and consume fails closed", async () => {
  const scenario = await createScenario("revoke-before-consume");
  await runScenarioBody(scenario, async () => {
    const fixture = await createReadyRunFixture(scenario, "user");
    const revokedAt = new Date("2026-02-08T00:00:00.000Z");
    const attemptedConsumeAt = new Date("2026-02-08T00:00:01.000Z");
    const expiresAt = new Date("2026-02-08T01:00:00.000Z");
    const singleUse = await createSingleUseFixture(scenario, fixture, "revoke-before-consume", expiresAt);
    const revokeClock = queuedClock("revoke-before-consume revoke", [revokedAt]);
    const consumeClock = queuedClock("revoke-before-consume consume", [attemptedConsumeAt]);
    const revokeUpdated = deferred("revoke-before-consume revoke updated");
    const releaseRevoke = trackRelease(scenario, deferred("release revoke-before-consume revoke"));
    const consumeAttempted = deferred("revoke-before-consume consume attempted");
    const revokeMutation = extendTokenMutationClient(
      scenario.actorA.client,
      "c55RevokeBeforeConsumeHolder",
      { kind: "revoke", userId: fixture.userId, tokenId: singleUse.tokenId, at: revokedAt },
      {
        after: async (count) => {
          assert.equal(count, 1);
          revokeUpdated.resolve();
          await releaseRevoke.wait();
        }
      }
    );
    const consumeMutation = extendTokenMutationClient(
      scenario.actorB.client,
      "c55RevokeBeforeConsumeWaiter",
      { kind: "consume", userId: fixture.userId, runId: fixture.runId, at: attemptedConsumeAt },
      {
        before: () => consumeAttempted.resolve(),
        after: (count) => assert.equal(count, 0)
      }
    );
    const revokeService = createTokenService(revokeMutation.prismaClient, revokeClock.clock);
    const consumeService = createTokenService(consumeMutation.prismaClient, consumeClock.clock);

    const revoke = trackOperation(
      scenario,
      revokeService.revokeExecutionToken({ userId: fixture.userId, tokenId: singleUse.tokenId })
    );
    await withTimeout(revokeUpdated.wait(), OPERATION_TIMEOUT_MS, "revoke-before-consume revoke mutation");
    const consume = trackOperation(
      scenario,
      consumeService.consumeSingleUseExecutionToken(bindingInput(singleUse.rawToken, fixture, "APPLICATION_FILL"))
    );
    await withTimeout(consumeAttempted.wait(), OPERATION_TIMEOUT_MS, "revoke-before-consume consume attempt");
    await assertObservedLockWait(scenario.observer, scenario.actorB, scenario.actorA);

    releaseRevoke.resolve();
    const [revokeResult, consumeResult] = await settlePair(revoke, consume, "revoke-before-consume operations");
    assert.deepEqual(requireFulfilled(revokeResult, scenario.actorA, "individual revocation"), {
      revoked: true,
      alreadyRevoked: false
    });
    assertPublicError(requireRejected(consumeResult, scenario.actorB, "single-use consumption"), {
      code: "EXECUTION_TOKEN_INVALID",
      status: 401
    });

    const token = await requireSafeToken(scenario.observer, singleUse.tokenId);
    assertSingleUseToken(token, fixture);
    assert.equal(token.revokedAt?.getTime(), revokedAt.getTime());
    assert.equal(token.consumedAt, null);
    assert.equal(token.lastUsedAt, null);
    const audits = await readAudits(scenario.observer, fixture.userId);
    assert.equal(audits.length, 1);
    assertRevokeAudit(
      requireSingleAudit(audits, "application-execution-token.revoke", "ApplicationExecutionToken", token.id),
      fixture,
      token.id,
      "APPLICATION_FILL",
      revokedAt
    );
    assert.equal(matchingAudits(audits, "application-execution-token.consume").length, 0);
    assert.deepEqual(await readEvents(scenario.observer, fixture.userId), []);

    revokeClock.assertCalls(1);
    consumeClock.assertCalls(1);
    revokeMutation.assertMatches();
    consumeMutation.assertMatches();
    await assertScenarioSessionsPinned(scenario, "complete");
  });
});
