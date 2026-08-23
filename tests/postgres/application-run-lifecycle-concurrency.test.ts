import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "node:test";

import type { Prisma } from "@prisma/client";

import { PublicApiError } from "@/lib/api-errors";
import { createApplicationRunService } from "@/lib/application-runs/service";
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

const RUN_ROW_LOCK = {
  kind: "queryRaw",
  includes: ['FROM "ApplicationRun"', "FOR UPDATE"]
} as const;

const ANSWER_ROW_LOCK = {
  kind: "queryRaw",
  includes: ['FROM "ApplicationRunAnswer"', "FOR UPDATE"]
} as const;

const SYNTHETIC_HOST = "jobs.example.test";
const GLOBAL_AUTOMATION_ENABLED = { APPLICATION_AUTOMATION_ENABLED: "true" } as const;
const OPERATION_TIMEOUT_MS = 12_000;
const CLEANUP_OPERATION_TIMEOUT_MS = 5_000;
const CLEANUP_DISCONNECT_TIMEOUT_MS = 3_000;

const RUN_SELECT = {
  id: true,
  userId: true,
  jobPostingId: true,
  applicationId: true,
  state: true,
  idempotencyKey: true,
  activeRunKey: true,
  stateVersion: true,
  prepareAttemptId: true,
  prepareLeaseExpiresAt: true,
  firstPreparingAt: true,
  applyHost: true,
  reviewReasons: true,
  reviewAcknowledgedAt: true,
  blockingReason: true,
  errorCategory: true,
  preparedAt: true,
  cancelledAt: true,
  createdAt: true,
  updatedAt: true
} as const satisfies Prisma.ApplicationRunSelect;

const ANSWER_SELECT = {
  id: true,
  runId: true,
  userId: true,
  normalizedFieldKey: true,
  valueRedacted: true,
  sensitive: true,
  required: true,
  requiresReview: true,
  status: true,
  reviewedByUser: true,
  reviewedAt: true,
  finalValueHash: true,
  createdAt: true,
  updatedAt: true
} as const satisfies Prisma.ApplicationRunAnswerSelect;

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
type AnswerRow = Prisma.ApplicationRunAnswerGetPayload<{ select: typeof ANSWER_SELECT }>;
type SafeAudit = Prisma.AuditLogGetPayload<{ select: typeof SAFE_AUDIT_SELECT }>;
type SafeEvent = Prisma.ApplicationEventGetPayload<{ select: typeof SAFE_EVENT_SELECT }>;
type CapturedFailure = { present: false } | { present: true; error: unknown };
type CleanupFailure = { phase: string; error: unknown };
type CleanupPhaseResult<T> = { ok: true; value: T } | { ok: false };

type CleanupTrace = {
  databaseCleanupAttempted: boolean;
  deletedAuditIds: string[];
  deletedUserIds: string[];
  disconnectedActors: string[];
  failures: CleanupFailure[];
};

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

type BaseFixture = {
  userId: string;
  jobPostingId: string;
  applicationId: string;
  applyUrl: string;
};

const NO_CAPTURED_FAILURE: CapturedFailure = { present: false };

async function createScenario(label: string): Promise<Scenario> {
  const actors: PostgresTestActor[] = [];
  try {
    const observer = await createPostgresTestActor(label + "-observer");
    actors.push(observer);
    const actorA = await createPostgresTestActor(label + "-a");
    actors.push(actorA);
    const actorB = await createPostgresTestActor(label + "-b");
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
        ({ phase }) => new Error("Secondary C5.6 cleanup phase failed: " + phase + ".")
      );
      try {
        Object.defineProperty(primaryFailure.error, "cause", {
          value: new AggregateError(summaries, "One or more secondary C5.6 cleanup phases failed."),
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
        withTimeout(settlement, CLEANUP_OPERATION_TIMEOUT_MS, scenario.label + " operation cleanup")
      )
    ).ok;
  }

  let observerHealthy = (
    await captureCleanupPhase(trace, "observer-pin", () =>
      assertActorSessionPinned(scenario.observer, scenario.label + "-cleanup-observer")
    )
  ).ok;
  const competitorsToStop = new Set<PostgresTestActor>();
  if (!operationsSettled) {
    for (const actor of competitors) competitorsToStop.add(actor);
  }

  for (const [index, actor] of competitors.entries()) {
    const actorLabel = index === 0 ? "actor-a" : "actor-b";
    if (observerHealthy) {
      const idleResult = await captureCleanupPhase(trace, actorLabel + "-idle", () =>
        assertNoIdleTransactions(scenario.observer, [actor])
      );
      if (!idleResult.ok) {
        competitorsToStop.add(actor);
        observerHealthy = (
          await captureCleanupPhase(trace, "observer-repin-after-" + actorLabel + "-idle", () =>
            assertActorSessionPinned(scenario.observer, scenario.label + "-cleanup-observer-repin")
          )
        ).ok;
      }
    }

    const pinResult = await captureCleanupPhase(trace, actorLabel + "-pin", () =>
      assertActorSessionPinned(actor, scenario.label + "-cleanup-" + actorLabel)
    );
    if (!pinResult.ok) competitorsToStop.add(actor);
  }

  const earlyDisconnectAttempted = new Set<PostgresTestActor>();
  const earlyDisconnectSucceeded = new Set<PostgresTestActor>();
  for (const [index, actor] of competitors.entries()) {
    if (!competitorsToStop.has(actor)) continue;
    const actorLabel = index === 0 ? "actor-a" : "actor-b";
    earlyDisconnectAttempted.add(actor);
    const disconnected = await captureCleanupPhase(trace, actorLabel + "-early-disconnect", () =>
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
        withTimeout(
          settlement,
          CLEANUP_OPERATION_TIMEOUT_MS,
          scenario.label + " operation cleanup after disconnect"
        )
      )
    ).ok;
  }

  const unsafeCompetitorRemains = [...competitorsToStop].some(
    (actor) => !earlyDisconnectSucceeded.has(actor)
  );
  if (observerHealthy) {
    observerHealthy = (
      await captureCleanupPhase(trace, "observer-final-pin", () =>
        assertActorSessionPinned(scenario.observer, scenario.label + "-cleanup-observer-final")
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
    const disconnected = await captureCleanupPhase(trace, actorLabel + "-disconnect", () =>
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

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    assert.fail(label + " must be a record.");
  }
  return value as Record<string, unknown>;
}

function optionalRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function metadataValue(data: Record<string, unknown>, key: string): unknown {
  return optionalRecord(data.metadata)?.[key];
}

function jsonRecord(value: Prisma.JsonValue | null): Record<string, Prisma.JsonValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    assert.fail("Expected safe JSON metadata record.");
  }
  return value as Record<string, Prisma.JsonValue>;
}

function sameDate(value: unknown, expected: Date): boolean {
  return value instanceof Date && value.getTime() === expected.getTime();
}

function isIncrementOne(value: unknown): boolean {
  const record = optionalRecord(value);
  return record?.increment === 1;
}

function isP2002(error: unknown): boolean {
  return optionalRecord(error)?.code === "P2002";
}

function queuedClock(label: string, values: readonly Date[]) {
  let calls = 0;
  return {
    clock: () => {
      const value = values[calls];
      if (!value) throw new Error("C5.6 clock " + label + " received an unexpected call.");
      calls += 1;
      return new Date(value.getTime());
    },
    assertCalls: (expected: number) => assert.equal(calls, expected, label + " clock calls")
  };
}

function createService(prismaClient: PostgresTestActor["client"], clock?: () => Date) {
  return createApplicationRunService({
    prismaClient,
    env: GLOBAL_AUTOMATION_ENABLED,
    ...(clock ? { clock } : {})
  });
}

function requireFulfilled<T>(
  result: PromiseSettledResult<T>,
  actor: PostgresTestActor,
  phase: string
): T {
  if (result.status === "fulfilled") return result.value;
  assertNoUnexpectedConcurrencyError(result.reason, actor.actorName, phase);
  assert.fail("PostgreSQL actor " + actor.actorName + " failed during " + phase + ".");
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
  assert.fail("PostgreSQL actor " + actor.actorName + " unexpectedly fulfilled during " + phase + ".");
}

function assertPublicError(
  error: unknown,
  expected: { code: string; status: number; details?: Record<string, unknown> }
): void {
  assert.ok(error instanceof PublicApiError);
  assert.equal(error.status, expected.status);
  assert.equal(error.details?.code, expected.code);
  if (expected.details) assert.deepEqual(error.details, expected.details);
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
    await assertActorSessionPinned(actor, scenario.label + "-" + phase);
  }
}

async function settlePair<T, U>(
  first: Promise<T>,
  second: Promise<U>,
  label: string
): Promise<[PromiseSettledResult<T>, PromiseSettledResult<U>]> {
  return withTimeout(Promise.allSettled([first, second]), OPERATION_TIMEOUT_MS, label) as
    Promise<[PromiseSettledResult<T>, PromiseSettledResult<U>]>;
}

async function createBaseFixture(scenario: Scenario, label: string): Promise<BaseFixture> {
  const user = await createSyntheticTestUser(scenario.observer, scenario.label + "-" + label);
  scenario.syntheticUserIds.push(user.id);
  const fixtureKey = label + "-" + randomUUID();
  const applyUrl = "https://" + SYNTHETIC_HOST + "/apply/" + fixtureKey;
  const jobPosting = await scenario.observer.client.jobPosting.create({
    data: {
      userId: user.id,
      title: "C5.6 synthetic role " + fixtureKey,
      normalizedTitle: "c56-synthetic-role-" + fixtureKey,
      company: "C5.6 Synthetic Employer",
      normalizedCompany: "c56-synthetic-employer-" + fixtureKey,
      location: "Remote",
      normalizedLocation: "remote-" + fixtureKey,
      remoteStatus: "REMOTE",
      sourceUrl: "https://" + SYNTHETIC_HOST + "/jobs/" + fixtureKey,
      applyUrl,
      normalizedApplyUrl: applyUrl,
      description: "Synthetic lifecycle concurrency fixture.",
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
  return {
    userId: user.id,
    jobPostingId: jobPosting.id,
    applicationId: application.id,
    applyUrl
  };
}

async function createLifecycleRun(
  observer: PostgresTestActor,
  fixture: BaseFixture,
  input: {
    idempotencyKey: string;
    state: "READY" | "REVIEW_REQUIRED";
    stateVersion: number;
    firstPreparingAt: Date;
    preparedAt: Date;
    reviewReasons?: string[];
  }
): Promise<string> {
  const run = await observer.client.applicationRun.create({
    data: {
      userId: fixture.userId,
      jobPostingId: fixture.jobPostingId,
      applicationId: fixture.applicationId,
      state: input.state,
      stateVersion: input.stateVersion,
      activeRunKey: fixture.applicationId,
      idempotencyKey: input.idempotencyKey,
      applyUrlSnapshot: fixture.applyUrl,
      applyHost: SYNTHETIC_HOST,
      prepareAttemptId: null,
      prepareLeaseExpiresAt: null,
      firstPreparingAt: input.firstPreparingAt,
      preparedAt: input.preparedAt,
      reviewReasons: input.reviewReasons ?? []
    },
    select: { id: true }
  });
  return run.id;
}

async function readRuns(observer: PostgresTestActor, fixture: BaseFixture): Promise<RunRow[]> {
  return observer.client.applicationRun.findMany({
    where: { userId: fixture.userId, applicationId: fixture.applicationId },
    orderBy: { createdAt: "asc" },
    select: RUN_SELECT
  }) as Promise<RunRow[]>;
}

async function requireRun(observer: PostgresTestActor, fixture: BaseFixture, runId: string): Promise<RunRow> {
  const run = await observer.client.applicationRun.findFirst({
    where: { id: runId, userId: fixture.userId },
    select: RUN_SELECT
  }) as RunRow | null;
  assert.ok(run);
  return run;
}

async function requireAnswer(
  observer: PostgresTestActor,
  fixture: BaseFixture,
  runId: string,
  answerId: string
): Promise<AnswerRow> {
  const answer = await observer.client.applicationRunAnswer.findFirst({
    where: { id: answerId, runId, userId: fixture.userId },
    select: ANSWER_SELECT
  }) as AnswerRow | null;
  assert.ok(answer);
  return answer;
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

function matchingAudits(
  audits: readonly SafeAudit[],
  action: string,
  resource: string,
  resourceId: string
): SafeAudit[] {
  return audits.filter(
    (audit) =>
      audit.action === action &&
      audit.resource === resource &&
      audit.resourceId === resourceId
  );
}

function requireSingleAudit(
  audits: readonly SafeAudit[],
  action: string,
  resource: string,
  resourceId: string
): SafeAudit {
  const matches = matchingAudits(audits, action, resource, resourceId);
  assert.equal(matches.length, 1, action);
  return matches[0];
}

function requireSingleEvent(
  events: readonly SafeEvent[],
  applicationId: string,
  title: string
): SafeEvent {
  const matches = events.filter(
    (event) => event.applicationId === applicationId && event.title === title
  );
  assert.equal(matches.length, 1, title);
  return matches[0];
}

function assertCreationRecords(
  audits: readonly SafeAudit[],
  events: readonly SafeEvent[],
  fixture: BaseFixture,
  run: RunRow
): void {
  assert.equal(audits.length, 1);
  const audit = requireSingleAudit(audits, "application-run.create", "ApplicationRun", run.id);
  assert.equal(audit.userId, fixture.userId);
  assert.deepEqual(jsonRecord(audit.metadata), {
    applicationId: fixture.applicationId,
    jobPostingId: fixture.jobPostingId,
    state: "DRAFT",
    applyHost: SYNTHETIC_HOST
  });
  assert.equal(events.length, 1);
  const event = requireSingleEvent(events, fixture.applicationId, "Application run created");
  assert.equal(event.userId, fixture.userId);
  assert.equal(event.type, "APPLICATION_RUN_EVENT");
  assert.deepEqual(jsonRecord(event.metadata), { runId: run.id, state: "DRAFT" });
}

function assertReviewRecords(
  audits: readonly SafeAudit[],
  events: readonly SafeEvent[],
  fixture: BaseFixture,
  runId: string,
  reasons: readonly string[],
  acknowledgedAt: Date
): void {
  assert.equal(audits.length, 1);
  const audit = requireSingleAudit(audits, "application-run.review.resolve", "ApplicationRun", runId);
  assert.equal(audit.userId, fixture.userId);
  assert.deepEqual(jsonRecord(audit.metadata), {
    runId,
    reviewReasons: [...reasons],
    previousStateVersion: 8,
    nextStateVersion: 9,
    acknowledgedAt: acknowledgedAt.toISOString()
  });
  assert.equal(events.length, 1);
  const event = requireSingleEvent(events, fixture.applicationId, "Application run review resolved");
  assert.equal(event.userId, fixture.userId);
  assert.equal(event.type, "APPLICATION_RUN_EVENT");
  assert.deepEqual(jsonRecord(event.metadata), {
    runId,
    reviewReasons: [...reasons],
    previousStateVersion: 8,
    nextStateVersion: 9
  });
}

function assertAnswerReviewRecords(
  audits: readonly SafeAudit[],
  fixture: BaseFixture,
  runId: string,
  answerId: string,
  reviewedAt: Date
): void {
  assert.equal(audits.length, 1);
  const audit = requireSingleAudit(
    audits,
    "application-run-answer.review",
    "ApplicationRunAnswer",
    answerId
  );
  assert.equal(audit.userId, fixture.userId);
  assert.deepEqual(jsonRecord(audit.metadata), {
    runId,
    answerId,
    status: "APPROVED",
    finalValueHashStored: true,
    reviewedAt: reviewedAt.toISOString()
  });
}

function assertCancellationRecords(
  audits: readonly SafeAudit[],
  events: readonly SafeEvent[],
  fixture: BaseFixture,
  runId: string,
  cancelledAt: Date
): void {
  assert.equal(audits.length, 2);
  const bulk = requireSingleAudit(
    audits,
    "application-execution-token.revoke-bulk",
    "ApplicationRun",
    runId
  );
  assert.equal(bulk.userId, fixture.userId);
  assert.deepEqual(jsonRecord(bulk.metadata), {
    runId,
    reason: "run_cancelled",
    revokedCount: 0,
    revokedAt: cancelledAt.toISOString()
  });
  const cancelled = requireSingleAudit(audits, "application-run.cancel", "ApplicationRun", runId);
  assert.equal(cancelled.userId, fixture.userId);
  assert.deepEqual(jsonRecord(cancelled.metadata), {
    runId,
    previousState: "READY",
    nextState: "CANCELLED",
    previousStateVersion: 2,
    nextStateVersion: 3,
    revokedExecutionTokenCount: 0,
    cancelledAt: cancelledAt.toISOString()
  });
  assert.equal(events.length, 1);
  const event = requireSingleEvent(events, fixture.applicationId, "Application run cancelled");
  assert.equal(event.userId, fixture.userId);
  assert.equal(event.type, "APPLICATION_RUN_EVENT");
  assert.deepEqual(jsonRecord(event.metadata), {
    runId,
    previousState: "READY",
    nextState: "CANCELLED",
    previousStateVersion: 2,
    nextStateVersion: 3,
    revokedExecutionTokenCount: 0
  });
}

function extendCreationWinnerPause(
  prismaClient: PostgresTestActor["client"],
  name: string,
  expected: BaseFixture & { idempotencyKey: string },
  reached: Deferred<void>,
  release: Deferred<void>
): {
  prismaClient: PostgresTestActor["client"];
  assertMatches: () => void;
} {
  let runCreates = 0;
  let eventCreates = 0;
  let auditCreates = 0;
  let createdRunId: string | null = null;
  const extended = prismaClient.$extends({
    name,
    query: {
      applicationRun: {
        async create({ args, query }) {
          const data = requireRecord(args.data, "C5.6 run create data");
          const matches =
            data.userId === expected.userId &&
            data.jobPostingId === expected.jobPostingId &&
            data.applicationId === expected.applicationId &&
            data.idempotencyKey === expected.idempotencyKey &&
            data.activeRunKey === expected.applicationId &&
            data.state === "DRAFT" &&
            data.applyUrlSnapshot === expected.applyUrl &&
            data.applyHost === SYNTHETIC_HOST;
          const result = await query(args);
          if (matches) {
            const safeResult = requireRecord(result, "C5.6 run create result");
            if (typeof safeResult.id !== "string") assert.fail("C5.6 run create did not return a safe ID.");
            assert.equal(safeResult.applicationId, expected.applicationId);
            assert.equal(safeResult.jobPostingId, expected.jobPostingId);
            assert.equal(safeResult.state, "DRAFT");
            assert.equal(safeResult.stateVersion, 0);
            createdRunId = safeResult.id;
            runCreates += 1;
          }
          return result;
        }
      },
      applicationEvent: {
        async create({ args, query }) {
          const data = requireRecord(args.data, "C5.6 creation event data");
          const matches =
            data.userId === expected.userId &&
            data.applicationId === expected.applicationId &&
            data.type === "APPLICATION_RUN_EVENT" &&
            data.title === "Application run created" &&
            metadataValue(data, "runId") === createdRunId &&
            metadataValue(data, "state") === "DRAFT";
          const result = await query(args);
          if (matches) {
            assert.equal(runCreates, 1);
            eventCreates += 1;
          }
          return result;
        }
      },
      auditLog: {
        async create({ args, query }) {
          const data = requireRecord(args.data, "C5.6 creation audit data");
          const matches =
            data.userId === expected.userId &&
            data.action === "application-run.create" &&
            data.resource === "ApplicationRun" &&
            data.resourceId === createdRunId &&
            metadataValue(data, "applicationId") === expected.applicationId &&
            metadataValue(data, "jobPostingId") === expected.jobPostingId &&
            metadataValue(data, "state") === "DRAFT" &&
            metadataValue(data, "applyHost") === SYNTHETIC_HOST;
          const result = await query(args);
          if (matches) {
            assert.equal(runCreates, 1);
            assert.equal(eventCreates, 1);
            auditCreates += 1;
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
      assert.equal(runCreates, 1, name + " run creates");
      assert.equal(eventCreates, 1, name + " event creates");
      assert.equal(auditCreates, 1, name + " audit creates");
      assert.ok(createdRunId);
    }
  };
}

function extendCreationContenderTrace(
  prismaClient: PostgresTestActor["client"],
  name: string,
  expected: BaseFixture & { idempotencyKey: string },
  attempted: Deferred<void>
): {
  prismaClient: PostgresTestActor["client"];
  createCompleted: () => boolean;
  assertTrace: (trace: { idempotency: Array<string | null>; active: Array<string | null> }) => void;
} {
  const idempotencyResults: Array<string | null> = [];
  const activeResults: Array<string | null> = [];
  let createStarts = 0;
  let createCompletions = 0;
  let p2002Count = 0;
  let completed = false;
  const extended = prismaClient.$extends({
    name,
    query: {
      applicationRun: {
        async findUnique({ args, query }) {
          const where = requireRecord(args.where, "C5.6 contender lookup where");
          const compound = optionalRecord(where.userId_idempotencyKey);
          const isIdempotencyLookup =
            compound?.userId === expected.userId &&
            compound.idempotencyKey === expected.idempotencyKey;
          const isActiveLookup = where.activeRunKey === expected.applicationId;
          const result = await query(args);
          if (isIdempotencyLookup || isActiveLookup) {
            const safeResult = result === null ? null : requireRecord(result, "C5.6 contender lookup result");
            if (safeResult) {
              assert.equal(safeResult.applicationId, expected.applicationId);
              if (typeof safeResult.id !== "string") assert.fail("C5.6 lookup did not return a safe run ID.");
            }
            const safeId = safeResult ? safeResult.id as string : null;
            if (isIdempotencyLookup) idempotencyResults.push(safeId);
            if (isActiveLookup) activeResults.push(safeId);
          }
          return result;
        },
        async create({ args, query }) {
          const data = requireRecord(args.data, "C5.6 contender create data");
          const matches =
            data.userId === expected.userId &&
            data.jobPostingId === expected.jobPostingId &&
            data.applicationId === expected.applicationId &&
            data.idempotencyKey === expected.idempotencyKey &&
            data.activeRunKey === expected.applicationId &&
            data.state === "DRAFT" &&
            data.applyHost === SYNTHETIC_HOST;
          if (!matches) return query(args);
          createStarts += 1;
          attempted.resolve();
          try {
            return await query(args);
          } catch (error) {
            if (isP2002(error)) p2002Count += 1;
            throw error;
          } finally {
            createCompletions += 1;
            completed = true;
          }
        }
      }
    }
  }) as unknown as PostgresTestActor["client"];
  return {
    prismaClient: extended,
    createCompleted: () => completed,
    assertTrace: (trace) => {
      assert.equal(createStarts, 1, name + " create starts");
      assert.equal(createCompletions, 1, name + " create completions");
      assert.equal(p2002Count, 1, name + " internal P2002 count");
      assert.deepEqual(idempotencyResults, trace.idempotency);
      assert.deepEqual(activeResults, trace.active);
    }
  };
}

function extendReviewMutationPause(
  prismaClient: PostgresTestActor["client"],
  name: string,
  expected: { userId: string; runId: string; acknowledgedAt: Date },
  reached: Deferred<void>,
  release: Deferred<void>
): { prismaClient: PostgresTestActor["client"]; assertMatches: () => void } {
  let matches = 0;
  const extended = prismaClient.$extends({
    name,
    query: {
      applicationRun: {
        async updateMany({ args, query }) {
          const where = requireRecord(args.where, "C5.6 review mutation where");
          const data = requireRecord(args.data, "C5.6 review mutation data");
          const matchesTarget =
            where.id === expected.runId &&
            where.userId === expected.userId &&
            where.state === "REVIEW_REQUIRED" &&
            where.stateVersion === 8 &&
            data.state === "READY" &&
            isIncrementOne(data.stateVersion) &&
            sameDate(data.reviewAcknowledgedAt, expected.acknowledgedAt);
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
  return {
    prismaClient: extended,
    assertMatches: () => assert.equal(matches, 1, name + " matches")
  };
}

function extendAnswerMutationPause(
  prismaClient: PostgresTestActor["client"],
  name: string,
  expected: {
    userId: string;
    runId: string;
    answerId: string;
    reviewedAt: Date;
    finalValueHash: string;
  },
  reached: Deferred<void>,
  release: Deferred<void>
): { prismaClient: PostgresTestActor["client"]; assertMatches: () => void } {
  let matches = 0;
  const extended = prismaClient.$extends({
    name,
    query: {
      applicationRunAnswer: {
        async updateMany({ args, query }) {
          const where = requireRecord(args.where, "C5.6 answer mutation where");
          const data = requireRecord(args.data, "C5.6 answer mutation data");
          const matchesTarget =
            where.id === expected.answerId &&
            where.runId === expected.runId &&
            where.userId === expected.userId &&
            where.status === "PENDING" &&
            data.status === "APPROVED" &&
            data.reviewedByUser === true &&
            sameDate(data.reviewedAt, expected.reviewedAt) &&
            data.finalValueHash === expected.finalValueHash;
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
  return {
    prismaClient: extended,
    assertMatches: () => assert.equal(matches, 1, name + " matches")
  };
}

function extendCancellationMutationPause(
  prismaClient: PostgresTestActor["client"],
  name: string,
  expected: { userId: string; runId: string; cancelledAt: Date },
  reached: Deferred<void>,
  release: Deferred<void>
): { prismaClient: PostgresTestActor["client"]; assertMatches: () => void } {
  let matches = 0;
  const extended = prismaClient.$extends({
    name,
    query: {
      applicationRun: {
        async updateMany({ args, query }) {
          const where = requireRecord(args.where, "C5.6 cancellation mutation where");
          const data = requireRecord(args.data, "C5.6 cancellation mutation data");
          const matchesTarget =
            where.id === expected.runId &&
            where.userId === expected.userId &&
            where.state === "READY" &&
            where.stateVersion === 2 &&
            where.prepareAttemptId === null &&
            data.state === "CANCELLED" &&
            isIncrementOne(data.stateVersion) &&
            data.activeRunKey === null &&
            data.prepareAttemptId === null &&
            data.prepareLeaseExpiresAt === null &&
            sameDate(data.cancelledAt, expected.cancelledAt);
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
  return {
    prismaClient: extended,
    assertMatches: () => assert.equal(matches, 1, name + " matches")
  };
}

test("concurrent identical run creation converges through the production idempotency replay", async () => {
  const scenario = await createScenario("lifecycle-idempotent-create");
  await runScenarioBody(scenario, async () => {
    const fixture = await createBaseFixture(scenario, "user");
    const idempotencyKey = "c56:idempotent:" + randomUUID();
    const winnerCommittedSideEffects = deferred("idempotent winner side effects written");
    const releaseWinner = trackRelease(scenario, deferred("release idempotent creation winner"));
    const contenderCreateAttempted = deferred("idempotent contender create attempted");
    const winnerPause = extendCreationWinnerPause(
      scenario.actorA.client,
      "c56IdempotentCreationWinnerPause",
      { ...fixture, idempotencyKey },
      winnerCommittedSideEffects,
      releaseWinner
    );
    const contenderTrace = extendCreationContenderTrace(
      scenario.actorB.client,
      "c56IdempotentCreationContenderTrace",
      { ...fixture, idempotencyKey },
      contenderCreateAttempted
    );
    const winnerService = createService(winnerPause.prismaClient);
    const contenderService = createService(contenderTrace.prismaClient);

    const winnerOperation = trackOperation(
      scenario,
      winnerService.createApplicationRun(fixture.userId, {
        applicationId: fixture.applicationId,
        idempotencyKey
      })
    );
    await winnerCommittedSideEffects.wait();

    const contenderOperation = trackOperation(
      scenario,
      contenderService.createApplicationRun(fixture.userId, {
        applicationId: fixture.applicationId,
        idempotencyKey
      })
    );
    await contenderCreateAttempted.wait();
    await assertObservedLockWait(scenario.observer, scenario.actorB, scenario.actorA);
    assert.equal(
      contenderTrace.createCompleted(),
      false,
      "idempotent contender create must still be in flight during the observed wait"
    );

    releaseWinner.resolve();
    const [winnerSettled, contenderSettled] = await settlePair(
      winnerOperation,
      contenderOperation,
      "idempotent creation operations"
    );
    const winner = requireFulfilled(winnerSettled, scenario.actorA, "idempotent creation winner");
    const contender = requireFulfilled(contenderSettled, scenario.actorB, "idempotent creation contender");
    assert.equal(
      contenderTrace.createCompleted(),
      true,
      "idempotent contender create must complete after winner release"
    );
    assert.equal(winner.replayed, false);
    assert.equal(contender.replayed, true);
    assert.equal(contender.run.id, winner.run.id);

    const runs = await readRuns(scenario.observer, fixture);
    assert.equal(runs.length, 1);
    const run = runs[0];
    assert.equal(run.id, winner.run.id);
    assert.equal(run.userId, fixture.userId);
    assert.equal(run.applicationId, fixture.applicationId);
    assert.equal(run.jobPostingId, fixture.jobPostingId);
    assert.equal(run.state, "DRAFT");
    assert.equal(run.stateVersion, 0);
    assert.equal(run.idempotencyKey, idempotencyKey);
    assert.equal(run.activeRunKey, fixture.applicationId);
    assert.equal(run.applyHost, SYNTHETIC_HOST);
    assert.equal(run.prepareAttemptId, null);
    assert.equal(run.prepareLeaseExpiresAt, null);
    assert.equal(run.firstPreparingAt, null);
    assert.equal(run.preparedAt, null);
    assert.equal(run.cancelledAt, null);
    assert.deepEqual(run.reviewReasons, []);

    const audits = await readAudits(scenario.observer, fixture.userId);
    const events = await readEvents(scenario.observer, fixture.userId);
    assertCreationRecords(audits, events, fixture, run);
    winnerPause.assertMatches();
    contenderTrace.assertTrace({
      idempotency: [null, run.id],
      active: [null]
    });
    await assertScenarioSessionsPinned(scenario, "complete");
  });
});

test("concurrent distinct run creation preserves one active run and rejects the competing identity", async () => {
  const scenario = await createScenario("lifecycle-active-create");
  await runScenarioBody(scenario, async () => {
    const fixture = await createBaseFixture(scenario, "user");
    const winnerIdempotencyKey = "c56:active:winner:" + randomUUID();
    const contenderIdempotencyKey = "c56:active:contender:" + randomUUID();
    assert.notEqual(winnerIdempotencyKey, contenderIdempotencyKey);
    const winnerCommittedSideEffects = deferred("active winner side effects written");
    const releaseWinner = trackRelease(scenario, deferred("release active creation winner"));
    const contenderCreateAttempted = deferred("active contender create attempted");
    const winnerPause = extendCreationWinnerPause(
      scenario.actorA.client,
      "c56ActiveCreationWinnerPause",
      { ...fixture, idempotencyKey: winnerIdempotencyKey },
      winnerCommittedSideEffects,
      releaseWinner
    );
    const contenderTrace = extendCreationContenderTrace(
      scenario.actorB.client,
      "c56ActiveCreationContenderTrace",
      { ...fixture, idempotencyKey: contenderIdempotencyKey },
      contenderCreateAttempted
    );
    const winnerService = createService(winnerPause.prismaClient);
    const contenderService = createService(contenderTrace.prismaClient);

    const winnerOperation = trackOperation(
      scenario,
      winnerService.createApplicationRun(fixture.userId, {
        applicationId: fixture.applicationId,
        idempotencyKey: winnerIdempotencyKey
      })
    );
    await winnerCommittedSideEffects.wait();

    const contenderOperation = trackOperation(
      scenario,
      contenderService.createApplicationRun(fixture.userId, {
        applicationId: fixture.applicationId,
        idempotencyKey: contenderIdempotencyKey
      })
    );
    await contenderCreateAttempted.wait();
    await assertObservedLockWait(scenario.observer, scenario.actorB, scenario.actorA);
    assert.equal(
      contenderTrace.createCompleted(),
      false,
      "active contender create must still be in flight during the observed wait"
    );

    releaseWinner.resolve();
    const [winnerSettled, contenderSettled] = await settlePair(
      winnerOperation,
      contenderOperation,
      "active creation operations"
    );
    const winner = requireFulfilled(winnerSettled, scenario.actorA, "active creation winner");
    const contenderError = requireRejected(contenderSettled, scenario.actorB, "active creation contender");
    assertPublicError(contenderError, { code: "APPLICATION_RUN_ACTIVE", status: 409 });
    assert.equal(
      contenderTrace.createCompleted(),
      true,
      "active contender create must complete after winner release"
    );
    assert.equal(winner.replayed, false);

    const runs = await readRuns(scenario.observer, fixture);
    assert.equal(runs.length, 1);
    const run = runs[0];
    assert.equal(run.id, winner.run.id);
    assert.equal(run.userId, fixture.userId);
    assert.equal(run.applicationId, fixture.applicationId);
    assert.equal(run.jobPostingId, fixture.jobPostingId);
    assert.equal(run.state, "DRAFT");
    assert.equal(run.stateVersion, 0);
    assert.equal(run.idempotencyKey, winnerIdempotencyKey);
    assert.notEqual(run.idempotencyKey, contenderIdempotencyKey);
    assert.equal(run.activeRunKey, fixture.applicationId);
    assert.equal(run.applyHost, SYNTHETIC_HOST);
    assert.equal(run.prepareAttemptId, null);
    assert.equal(run.prepareLeaseExpiresAt, null);
    assert.equal(run.firstPreparingAt, null);
    assert.equal(run.preparedAt, null);
    assert.equal(run.cancelledAt, null);

    const audits = await readAudits(scenario.observer, fixture.userId);
    const events = await readEvents(scenario.observer, fixture.userId);
    assertCreationRecords(audits, events, fixture, run);
    winnerPause.assertMatches();
    contenderTrace.assertTrace({
      idempotency: [null, null],
      active: [null, run.id]
    });
    await assertScenarioSessionsPinned(scenario, "complete");
  });
});

test("concurrent review resolution permits exactly one REVIEW_REQUIRED to READY transition", async () => {
  const scenario = await createScenario("lifecycle-review-resolution");
  await runScenarioBody(scenario, async () => {
    const fixture = await createBaseFixture(scenario, "user");
    const firstPreparingAt = new Date("2037-03-03T00:00:00.000Z");
    const preparedAt = new Date("2037-03-03T00:00:01.000Z");
    const acknowledgedAt = new Date("2037-03-03T00:00:02.000Z");
    const unusedContenderAt = new Date("2037-03-03T00:00:03.000Z");
    const reviewReasons = ["unknown_requirement_ids", "evidence_gaps_present"] as const;
    const runId = await createLifecycleRun(scenario.observer, fixture, {
      idempotencyKey: "c56:review:" + randomUUID(),
      state: "REVIEW_REQUIRED",
      stateVersion: 8,
      firstPreparingAt,
      preparedAt,
      reviewReasons: [...reviewReasons]
    });
    const winnerClock = queuedClock("review-resolution winner", [acknowledgedAt]);
    const contenderClock = queuedClock("review-resolution contender", [unusedContenderAt]);
    const winnerMutationCompleted = deferred("review winner mutation completed");
    const releaseWinner = trackRelease(scenario, deferred("release review winner"));
    const contenderRunLockAttempted = deferred("review contender run lock attempted");
    const winnerLockSequence: string[] = [];
    const contenderLockSequence: string[] = [];
    let contenderRunLockCompleted = false;

    const winnerHooks = createHookedPrismaClient(scenario.actorA, [
      {
        name: "review winner run lock",
        match: RUN_ROW_LOCK,
        before: () => {
          winnerLockSequence.push("run-before");
        },
        after: () => {
          winnerLockSequence.push("run-after");
        }
      }
    ]);
    const winnerPause = extendReviewMutationPause(
      winnerHooks.prismaClient,
      "c56ReviewWinnerMutationPause",
      { userId: fixture.userId, runId, acknowledgedAt },
      winnerMutationCompleted,
      releaseWinner
    );
    const contenderHooks = createHookedPrismaClient(scenario.actorB, [
      {
        name: "review contender run lock",
        match: RUN_ROW_LOCK,
        before: () => {
          contenderLockSequence.push("run-before");
          contenderRunLockAttempted.resolve();
        },
        after: () => {
          contenderLockSequence.push("run-after");
          contenderRunLockCompleted = true;
        }
      },
      {
        name: "review contender lifecycle mutation",
        match: { kind: "model", model: "applicationRun", method: "updateMany" },
        expectedMatches: 0
      }
    ]);
    const winnerService = createService(winnerPause.prismaClient, winnerClock.clock);
    const contenderService = createService(contenderHooks.prismaClient, contenderClock.clock);
    const request = {
      userId: fixture.userId,
      runId,
      stateVersion: 8,
      acknowledgedReviewReasons: [...reviewReasons]
    };

    const winnerOperation = trackOperation(
      scenario,
      winnerService.resolveApplicationRunReview(request)
    );
    await winnerMutationCompleted.wait();
    assert.deepEqual(winnerLockSequence, ["run-before", "run-after"]);

    const contenderOperation = trackOperation(
      scenario,
      contenderService.resolveApplicationRunReview(request)
    );
    await contenderRunLockAttempted.wait();
    await assertObservedLockWait(scenario.observer, scenario.actorB, scenario.actorA);
    assert.equal(
      contenderRunLockCompleted,
      false,
      "review contender run lock must still be in flight during the observed wait"
    );
    assert.deepEqual(contenderLockSequence, ["run-before"]);

    releaseWinner.resolve();
    const [winnerSettled, contenderSettled] = await settlePair(
      winnerOperation,
      contenderOperation,
      "review-resolution operations"
    );
    const winner = requireFulfilled(winnerSettled, scenario.actorA, "review-resolution winner");
    const contenderError = requireRejected(contenderSettled, scenario.actorB, "review-resolution contender");
    assertPublicError(contenderError, { code: "RUN_INVALID_STATE", status: 409 });
    assert.equal(
      contenderRunLockCompleted,
      true,
      "review contender run lock must complete after winner release"
    );
    assert.deepEqual(contenderLockSequence, ["run-before", "run-after"]);
    assert.equal(winner.id, runId);
    assert.equal(winner.state, "READY");
    assert.equal(winner.stateVersion, 9);
    assert.deepEqual(winner.reviewReasons, [...reviewReasons]);
    assert.equal(winner.reviewAcknowledgedAt?.getTime(), acknowledgedAt.getTime());

    const run = await requireRun(scenario.observer, fixture, runId);
    assert.equal(run.state, "READY");
    assert.equal(run.stateVersion, 9);
    assert.equal(run.activeRunKey, fixture.applicationId);
    assert.equal(run.prepareAttemptId, null);
    assert.equal(run.prepareLeaseExpiresAt, null);
    assert.equal(run.firstPreparingAt?.getTime(), firstPreparingAt.getTime());
    assert.equal(run.preparedAt?.getTime(), preparedAt.getTime());
    assert.deepEqual(run.reviewReasons, [...reviewReasons]);
    assert.equal(run.reviewAcknowledgedAt?.getTime(), acknowledgedAt.getTime());
    assert.equal(run.cancelledAt, null);
    assert.equal(run.blockingReason, null);
    assert.equal(run.errorCategory, null);

    const audits = await readAudits(scenario.observer, fixture.userId);
    const events = await readEvents(scenario.observer, fixture.userId);
    assertReviewRecords(audits, events, fixture, runId, reviewReasons, acknowledgedAt);
    winnerClock.assertCalls(1);
    contenderClock.assertCalls(0);
    winnerPause.assertMatches();
    winnerHooks.assertExpectedHooksReached();
    contenderHooks.assertExpectedHooksReached();
    await assertScenarioSessionsPinned(scenario, "complete");
  });
});

test("concurrent opposing answer review preserves the first PENDING decision", async () => {
  const scenario = await createScenario("lifecycle-answer-review");
  await runScenarioBody(scenario, async () => {
    const fixture = await createBaseFixture(scenario, "user");
    const firstPreparingAt = new Date("2037-03-04T00:00:00.000Z");
    const preparedAt = new Date("2037-03-04T00:00:01.000Z");
    const reviewedAt = new Date("2037-03-04T00:00:02.000Z");
    const unusedContenderAt = new Date("2037-03-04T00:00:03.000Z");
    const runId = await createLifecycleRun(scenario.observer, fixture, {
      idempotencyKey: "c56:answer:" + randomUUID(),
      state: "READY",
      stateVersion: 2,
      firstPreparingAt,
      preparedAt
    });
    const syntheticProposedValue = "  Synthetic affirmative response for lifecycle testing  ";
    const expectedFinalValueHash = createHash("sha256").update(syntheticProposedValue).digest("hex");
    const createdAnswer = await scenario.observer.client.applicationRunAnswer.create({
      data: {
        runId,
        userId: fixture.userId,
        normalizedFieldKey: "synthetic-work-authorization",
        originalQuestion: "Synthetic non-sensitive question",
        proposedValue: syntheticProposedValue,
        valueRedacted: false,
        sourceType: "USER_PROVIDED",
        sourceIds: [],
        evidenceIds: [],
        confidence: 100,
        sensitive: false,
        required: true,
        requiresReview: true,
        status: "PENDING",
        reviewedByUser: false,
        reviewedAt: null,
        finalValueHash: null
      },
      select: { id: true }
    });
    const answerId = createdAnswer.id;
    const winnerClock = queuedClock("answer-review winner", [reviewedAt]);
    const contenderClock = queuedClock("answer-review contender", [unusedContenderAt]);
    const winnerMutationCompleted = deferred("answer winner mutation completed");
    const releaseWinner = trackRelease(scenario, deferred("release answer winner"));
    const contenderRunLockAttempted = deferred("answer contender run lock attempted");
    const winnerLockSequence: string[] = [];
    const contenderLockSequence: string[] = [];
    let contenderRunLockCompleted = false;

    const winnerHooks = createHookedPrismaClient(scenario.actorA, [
      {
        name: "answer winner run lock",
        match: RUN_ROW_LOCK,
        before: () => {
          winnerLockSequence.push("run-before");
        },
        after: () => {
          winnerLockSequence.push("run-after");
        }
      },
      {
        name: "answer winner answer lock",
        match: ANSWER_ROW_LOCK,
        before: () => {
          winnerLockSequence.push("answer-before");
        },
        after: () => {
          winnerLockSequence.push("answer-after");
        }
      }
    ]);
    const winnerPause = extendAnswerMutationPause(
      winnerHooks.prismaClient,
      "c56AnswerWinnerMutationPause",
      {
        userId: fixture.userId,
        runId,
        answerId,
        reviewedAt,
        finalValueHash: expectedFinalValueHash
      },
      winnerMutationCompleted,
      releaseWinner
    );
    const contenderHooks = createHookedPrismaClient(scenario.actorB, [
      {
        name: "answer contender run lock",
        match: RUN_ROW_LOCK,
        before: () => {
          contenderLockSequence.push("run-before");
          contenderRunLockAttempted.resolve();
        },
        after: () => {
          contenderLockSequence.push("run-after");
          contenderRunLockCompleted = true;
        }
      },
      {
        name: "answer contender answer lock",
        match: ANSWER_ROW_LOCK,
        before: () => {
          contenderLockSequence.push("answer-before");
        },
        after: () => {
          contenderLockSequence.push("answer-after");
        }
      },
      {
        name: "answer contender status mutation",
        match: { kind: "model", model: "applicationRunAnswer", method: "updateMany" },
        expectedMatches: 0
      }
    ]);
    const winnerService = createService(winnerPause.prismaClient, winnerClock.clock);
    const contenderService = createService(contenderHooks.prismaClient, contenderClock.clock);

    const winnerOperation = trackOperation(
      scenario,
      winnerService.reviewApplicationRunAnswer({
        userId: fixture.userId,
        runId,
        answerId,
        status: "APPROVED"
      })
    );
    await winnerMutationCompleted.wait();
    assert.deepEqual(winnerLockSequence, ["run-before", "run-after", "answer-before", "answer-after"]);

    const contenderOperation = trackOperation(
      scenario,
      contenderService.reviewApplicationRunAnswer({
        userId: fixture.userId,
        runId,
        answerId,
        status: "REJECTED"
      })
    );
    await contenderRunLockAttempted.wait();
    await assertObservedLockWait(scenario.observer, scenario.actorB, scenario.actorA);
    assert.equal(
      contenderRunLockCompleted,
      false,
      "answer contender run lock must still be in flight during the observed wait"
    );
    assert.deepEqual(contenderLockSequence, ["run-before"]);

    releaseWinner.resolve();
    const [winnerSettled, contenderSettled] = await settlePair(
      winnerOperation,
      contenderOperation,
      "answer-review operations"
    );
    const winner = requireFulfilled(winnerSettled, scenario.actorA, "answer-review winner");
    const contenderError = requireRejected(contenderSettled, scenario.actorB, "answer-review contender");
    assertPublicError(contenderError, { code: "RUN_ANSWER_ALREADY_REVIEWED", status: 409 });
    assert.equal(
      contenderRunLockCompleted,
      true,
      "answer contender run lock must complete after winner release"
    );
    assert.deepEqual(contenderLockSequence, ["run-before", "run-after", "answer-before", "answer-after"]);
    assert.equal(winner.id, answerId);
    assert.equal(winner.runId, runId);
    assert.equal(winner.status, "APPROVED");
    assert.equal(winner.reviewedByUser, true);
    assert.equal(winner.reviewedAt?.getTime(), reviewedAt.getTime());
    assert.equal(winner.sensitive, false);
    assert.equal(winner.valueRedacted, false);

    const answer = await requireAnswer(scenario.observer, fixture, runId, answerId);
    assert.equal(answer.status, "APPROVED");
    assert.equal(answer.reviewedByUser, true);
    assert.equal(answer.reviewedAt?.getTime(), reviewedAt.getTime());
    assert.equal(answer.sensitive, false);
    assert.equal(answer.valueRedacted, false);
    assert.equal(answer.required, true);
    assert.equal(answer.requiresReview, true);
    assert.equal(
      answer.finalValueHash === expectedFinalValueHash,
      true,
      "approved synthetic answer must store the expected final-value hash"
    );
    const run = await requireRun(scenario.observer, fixture, runId);
    assert.equal(run.state, "READY");
    assert.equal(run.stateVersion, 2);
    assert.equal(run.activeRunKey, fixture.applicationId);
    assert.equal(run.firstPreparingAt?.getTime(), firstPreparingAt.getTime());
    assert.equal(run.preparedAt?.getTime(), preparedAt.getTime());
    assert.equal(run.cancelledAt, null);

    const audits = await readAudits(scenario.observer, fixture.userId);
    const events = await readEvents(scenario.observer, fixture.userId);
    assertAnswerReviewRecords(audits, fixture, runId, answerId, reviewedAt);
    assert.deepEqual(events, []);
    winnerClock.assertCalls(1);
    contenderClock.assertCalls(0);
    winnerPause.assertMatches();
    winnerHooks.assertExpectedHooksReached();
    contenderHooks.assertExpectedHooksReached();
    await assertScenarioSessionsPinned(scenario, "complete");
  });
});

test("concurrent double cancellation performs one physical lifecycle transition", async () => {
  const scenario = await createScenario("lifecycle-double-cancel");
  await runScenarioBody(scenario, async () => {
    const fixture = await createBaseFixture(scenario, "user");
    const firstPreparingAt = new Date("2037-03-05T00:00:00.000Z");
    const preparedAt = new Date("2037-03-05T00:00:01.000Z");
    const cancelledAt = new Date("2037-03-05T00:00:02.000Z");
    const unusedContenderAt = new Date("2037-03-05T00:00:03.000Z");
    const runId = await createLifecycleRun(scenario.observer, fixture, {
      idempotencyKey: "c56:cancel:" + randomUUID(),
      state: "READY",
      stateVersion: 2,
      firstPreparingAt,
      preparedAt
    });
    const winnerClock = queuedClock("double-cancel winner", [cancelledAt]);
    const contenderClock = queuedClock("double-cancel contender", [unusedContenderAt]);
    const winnerMutationCompleted = deferred("double-cancel winner mutation completed");
    const releaseWinner = trackRelease(scenario, deferred("release double-cancel winner"));
    const contenderRunLockAttempted = deferred("double-cancel contender run lock attempted");
    const winnerLockSequence: string[] = [];
    const contenderLockSequence: string[] = [];
    let contenderRunLockCompleted = false;

    const winnerHooks = createHookedPrismaClient(scenario.actorA, [
      {
        name: "double-cancel winner run lock",
        match: RUN_ROW_LOCK,
        before: () => {
          winnerLockSequence.push("run-before");
        },
        after: () => {
          winnerLockSequence.push("run-after");
        }
      }
    ]);
    const winnerPause = extendCancellationMutationPause(
      winnerHooks.prismaClient,
      "c56DoubleCancelWinnerMutationPause",
      { userId: fixture.userId, runId, cancelledAt },
      winnerMutationCompleted,
      releaseWinner
    );
    const contenderHooks = createHookedPrismaClient(scenario.actorB, [
      {
        name: "double-cancel contender run lock",
        match: RUN_ROW_LOCK,
        before: () => {
          contenderLockSequence.push("run-before");
          contenderRunLockAttempted.resolve();
        },
        after: () => {
          contenderLockSequence.push("run-after");
          contenderRunLockCompleted = true;
        }
      },
      {
        name: "double-cancel contender lifecycle mutation",
        match: { kind: "model", model: "applicationRun", method: "updateMany" },
        expectedMatches: 0
      }
    ]);
    const winnerService = createService(winnerPause.prismaClient, winnerClock.clock);
    const contenderService = createService(contenderHooks.prismaClient, contenderClock.clock);

    const winnerOperation = trackOperation(
      scenario,
      winnerService.cancelApplicationRun({ userId: fixture.userId, runId })
    );
    await winnerMutationCompleted.wait();
    assert.deepEqual(winnerLockSequence, ["run-before", "run-after"]);

    const contenderOperation = trackOperation(
      scenario,
      contenderService.cancelApplicationRun({ userId: fixture.userId, runId })
    );
    await contenderRunLockAttempted.wait();
    await assertObservedLockWait(scenario.observer, scenario.actorB, scenario.actorA);
    assert.equal(
      contenderRunLockCompleted,
      false,
      "double-cancel contender run lock must still be in flight during the observed wait"
    );
    assert.deepEqual(contenderLockSequence, ["run-before"]);

    releaseWinner.resolve();
    const [winnerSettled, contenderSettled] = await settlePair(
      winnerOperation,
      contenderOperation,
      "double-cancellation operations"
    );
    const winner = requireFulfilled(winnerSettled, scenario.actorA, "double-cancel winner");
    const contenderError = requireRejected(contenderSettled, scenario.actorB, "double-cancel contender");
    assertPublicError(contenderError, {
      code: "RUN_INVALID_STATE",
      status: 409,
      details: { code: "RUN_INVALID_STATE", from: "CANCELLED", to: "CANCELLED" }
    });
    assert.equal(
      contenderRunLockCompleted,
      true,
      "double-cancel contender run lock must complete after winner release"
    );
    assert.deepEqual(contenderLockSequence, ["run-before", "run-after"]);
    assert.equal(winner.run.id, runId);
    assert.equal(winner.run.state, "CANCELLED");
    assert.equal(winner.run.stateVersion, 3);
    assert.equal(winner.run.cancelledAt?.getTime(), cancelledAt.getTime());
    assert.equal(winner.revokedExecutionTokenCount, 0);

    const runs = await readRuns(scenario.observer, fixture);
    assert.equal(runs.length, 1);
    const run = runs[0];
    assert.equal(run.id, runId);
    assert.equal(run.state, "CANCELLED");
    assert.equal(run.stateVersion, 3);
    assert.equal(run.activeRunKey, null);
    assert.equal(run.prepareAttemptId, null);
    assert.equal(run.prepareLeaseExpiresAt, null);
    assert.equal(run.firstPreparingAt?.getTime(), firstPreparingAt.getTime());
    assert.equal(run.preparedAt?.getTime(), preparedAt.getTime());
    assert.equal(run.cancelledAt?.getTime(), cancelledAt.getTime());
    assert.deepEqual(run.reviewReasons, []);
    assert.equal(run.reviewAcknowledgedAt, null);
    assert.equal(run.blockingReason, null);
    assert.equal(run.errorCategory, null);
    assert.deepEqual(
      await scenario.observer.client.applicationExecutionToken.findMany({
        where: { userId: fixture.userId, runId },
        select: { id: true }
      }),
      []
    );

    const audits = await readAudits(scenario.observer, fixture.userId);
    const events = await readEvents(scenario.observer, fixture.userId);
    assertCancellationRecords(audits, events, fixture, runId, cancelledAt);
    winnerClock.assertCalls(1);
    contenderClock.assertCalls(0);
    winnerPause.assertMatches();
    winnerHooks.assertExpectedHooksReached();
    contenderHooks.assertExpectedHooksReached();
    await assertScenarioSessionsPinned(scenario, "complete");
  });
});
