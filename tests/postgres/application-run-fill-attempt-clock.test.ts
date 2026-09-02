import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import { Prisma } from "@prisma/client";

import { PublicApiError } from "@/lib/api-errors";
import { createApplicationRunAnswerPacketService } from "@/lib/application-runs/answer-packet-service";
import { createApplicationRunFillAttemptService } from "@/lib/application-runs/fill-attempt";
import { FORM_INSPECTION_SCHEMA_VERSION } from "@/lib/application-runs/form-inspection";
import { createApplicationRunService } from "@/lib/application-runs/service";
import {
  assertDistinctActorSessions,
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

const TEST_TIMEOUT_MS = 30_000;
const OPERATION_TIMEOUT_MS = 12_000;
const APPLY_HOST = "jobs.example.test";
const AUTOMATION_ENV = { APPLICATION_AUTOMATION_ENABLED: "true" } as const;
const REVIEW_REASONS = ["evidence_gaps_present"] as const;
const FILLING_STATE_VERSION = 17;
const FIRST_FIELD_KEY = "a".repeat(64);
const SECOND_FIELD_KEY = "b".repeat(64);

type FillingFixture = {
  userId: string;
  runId: string;
  fillAttemptId: string;
  fillLeaseExpiresAt: Date;
  stateVersion: number;
  stepKeys: [string, string];
};

function formReport() {
  return {
    schemaVersion: FORM_INSPECTION_SCHEMA_VERSION,
    forms: [{
      title: "Application",
      sections: [{
        heading: "Candidate",
        fields: [{
          question: "LinkedIn profile URL",
          helpText: null,
          fieldType: "URL",
          unsupportedReason: null,
          required: true,
          autocomplete: "url",
          constraints: {
            minLength: null,
            maxLength: null,
            min: null,
            max: null,
            step: null,
            acceptedFileTypes: [] as string[],
            multiple: false
          },
          choices: []
        }]
      }]
    }]
  };
}

async function databaseClock(actor: PostgresTestActor): Promise<Date> {
  const rows = await actor.client.$queryRaw<Array<{ now: Date }>>(Prisma.sql`
    SELECT clock_timestamp() AS "now"
  `);
  assert.equal(rows.length, 1);
  assert.ok(rows[0].now instanceof Date);
  return rows[0].now;
}

async function advanceObservedDatabaseClock(actor: PostgresTestActor, minimumMs: number): Promise<Date> {
  const startedAt = await databaseClock(actor);
  let observed = startedAt;
  while (observed.getTime() - startedAt.getTime() < minimumMs) {
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    observed = await databaseClock(actor);
  }
  return observed;
}

async function waitForDatabaseClockAtLeast(
  actor: PostgresTestActor,
  target: Date,
  timeoutMs = OPERATION_TIMEOUT_MS
): Promise<Date> {
  const deadline = Date.now() + timeoutMs;
  let observed = await databaseClock(actor);
  while (observed.getTime() < target.getTime()) {
    if (Date.now() >= deadline) {
      throw new Error(
        `Database clock did not reach ${target.toISOString()}; last observed ${observed.toISOString()}.`
      );
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    observed = await databaseClock(actor);
  }
  return observed;
}

async function createFillingFixture(
  observer: PostgresTestActor,
  label: string,
  leaseOffsetMs: number,
  syntheticUserIds: string[]
): Promise<FillingFixture> {
  const user = await createSyntheticTestUser(observer, label);
  syntheticUserIds.push(user.id);
  const key = randomUUID();
  const applyUrl = `https://${APPLY_HOST}/apply/${key}`;
  const job = await observer.client.jobPosting.create({
    data: {
      userId: user.id,
      title: `Fill serialization role ${key}`,
      normalizedTitle: `fill-serialization-role-${key}`,
      company: "Fill Serialization Employer",
      normalizedCompany: `fill-serialization-employer-${key}`,
      location: "Remote",
      normalizedLocation: `remote-${key}`,
      remoteStatus: "REMOTE",
      sourceUrl: `https://${APPLY_HOST}/jobs/${key}`,
      applyUrl,
      normalizedApplyUrl: applyUrl,
      description: "Disposable production Fill finalization and recovery fixture.",
      requirements: [],
      preferredQualifications: [],
      benefits: [],
      detectedTechStack: [],
      missingKeywords: [],
      supportedKeywords: [],
      concerns: [],
      sourceType: "MANUAL"
    },
    select: { id: true }
  });
  const application = await observer.client.application.create({
    data: { userId: user.id, jobPostingId: job.id },
    select: { id: true }
  });
  const fillAttemptId = randomUUID();
  const fillLeaseExpiresAt = new Date((await databaseClock(observer)).getTime() + leaseOffsetMs);
  const run = await observer.client.applicationRun.create({
    data: {
      userId: user.id,
      jobPostingId: job.id,
      applicationId: application.id,
      state: "FILLING",
      stateVersion: FILLING_STATE_VERSION,
      currentFormInspectionVersion: 1,
      currentAnswerPacketVersion: 1,
      activeRunKey: application.id,
      idempotencyKey: `fill-serialization:${key}`,
      applyUrlSnapshot: applyUrl,
      applyHost: APPLY_HOST,
      fillAttemptId,
      fillLeaseExpiresAt,
      reviewReasons: [...REVIEW_REASONS]
    },
    select: { id: true }
  });
  const stepKeys: [string, string] = [
    `fill:${fillAttemptId}:${FIRST_FIELD_KEY}`,
    `fill:${fillAttemptId}:${SECOND_FIELD_KEY}`
  ];
  await observer.client.applicationRunStep.createMany({
    data: stepKeys.map((stepKey, sequence) => ({
      runId: run.id,
      userId: user.id,
      stepKey,
      sequence,
      action: "FILL_FIELD",
      semanticFieldKey: null,
      adapter: null,
      status: "PENDING",
      attemptNumber: 1,
      redactedValueSummary: null,
      errorCategory: null,
      artifactReference: null,
      startedAt: null,
      completedAt: null
    }))
  });
  return {
    userId: user.id,
    runId: run.id,
    fillAttemptId,
    fillLeaseExpiresAt,
    stateVersion: FILLING_STATE_VERSION,
    stepKeys
  };
}

function holdRunLock(
  actor: PostgresTestActor,
  fixture: FillingFixture,
  label: string
): { held: Deferred<void>; release: Deferred<void>; operation: Promise<void> } {
  const held = deferred(`${label} run lock held`);
  const release = deferred(`release ${label} run lock`);
  const operation = actor.client.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id" FROM "ApplicationRun"
      WHERE "id" = ${fixture.runId} AND "userId" = ${fixture.userId}
      FOR UPDATE
    `);
    assert.deepEqual(rows, [{ id: fixture.runId }]);
    held.resolve();
    await release.wait();
  });
  return { held, release, operation };
}

function assertLockWait(
  wait: Awaited<ReturnType<typeof waitForActorLockWait>>,
  waiter: PostgresTestActor,
  blocker: PostgresTestActor
): void {
  assert.equal(wait.waiterPid, waiter.backendPid);
  assert.equal(wait.waiterApplicationName, waiter.applicationName);
  assert.equal(wait.waitEventType, "Lock");
  assert.equal(wait.hasUngrantedLock, true);
  assert.ok(wait.blockingPids.includes(blocker.backendPid));
}

function requireFulfilled<T>(result: PromiseSettledResult<T>, label: string): T {
  if (result.status === "fulfilled") return result.value;
  assert.fail(`${label} unexpectedly rejected: ${String(result.reason)}`);
}

function assertFillStaleRejection(result: PromiseSettledResult<unknown>, label: string): void {
  if (result.status === "fulfilled") assert.fail(`${label} unexpectedly fulfilled.`);
  assert.ok(result.reason instanceof PublicApiError);
  assert.equal(result.reason.status, 409);
  assert.equal(result.reason.details?.code, "FILL_STALE");
}

async function readPersistedFillState(observer: PostgresTestActor, fixture: FillingFixture) {
  const run = await observer.client.applicationRun.findUniqueOrThrow({ where: { id: fixture.runId } });
  const steps = await observer.client.applicationRunStep.findMany({
    where: { runId: fixture.runId, userId: fixture.userId },
    orderBy: { sequence: "asc" }
  });
  const auditCounts = {
    total: await observer.client.auditLog.count({
      where: { userId: fixture.userId, resourceId: fixture.runId }
    }),
    finalize: await observer.client.auditLog.count({
      where: {
        userId: fixture.userId,
        resourceId: fixture.runId,
        action: "application-run-fill-attempt.finalize"
      }
    }),
    recover: await observer.client.auditLog.count({
      where: {
        userId: fixture.userId,
        resourceId: fixture.runId,
        action: "application-run-fill-attempt.recover"
      }
    })
  };
  return { run, steps, auditCounts };
}

test("Fill acquisition derives its full lease from clock_timestamp after a proven run-lock wait", {
  timeout: TEST_TIMEOUT_MS
}, async (context) => {
  const actors: PostgresTestActor[] = [];
  let userId: string | null = null;
  let releaseRunLock: Deferred<void> | null = null;
  const operations: Promise<unknown>[] = [];

  try {
    const observer = await createPostgresTestActor("fill-clock-observer");
    actors.push(observer);
    const actorA = await createPostgresTestActor("fill-clock-blocker");
    actors.push(actorA);
    const actorB = await createPostgresTestActor("fill-clock-acquirer");
    actors.push(actorB);
    assertDistinctActorSessions(actors);

    const user = await createSyntheticTestUser(observer, "fill-clock");
    userId = user.id;
    const key = randomUUID();
    const applyUrl = `https://${APPLY_HOST}/apply/${key}`;
    const job = await observer.client.jobPosting.create({
      data: {
        userId: user.id,
        title: `Fill clock role ${key}`,
        normalizedTitle: `fill-clock-role-${key}`,
        company: "Fill Clock Employer",
        normalizedCompany: `fill-clock-employer-${key}`,
        location: "Remote",
        normalizedLocation: `remote-${key}`,
        remoteStatus: "REMOTE",
        sourceUrl: `https://${APPLY_HOST}/jobs/${key}`,
        applyUrl,
        normalizedApplyUrl: applyUrl,
        description: "Disposable Fill acquisition database-clock fixture.",
        requirements: [],
        preferredQualifications: [],
        benefits: [],
        detectedTechStack: [],
        missingKeywords: [],
        supportedKeywords: [],
        concerns: [],
        sourceType: "MANUAL"
      },
      select: { id: true }
    });
    const application = await observer.client.application.create({
      data: { userId: user.id, jobPostingId: job.id },
      select: { id: true }
    });
    const run = await observer.client.applicationRun.create({
      data: {
        userId: user.id,
        jobPostingId: job.id,
        applicationId: application.id,
        state: "READY",
        stateVersion: 4,
        activeRunKey: application.id,
        idempotencyKey: `fill-clock:${key}`,
        applyUrlSnapshot: applyUrl,
        applyHost: APPLY_HOST,
        reviewReasons: [...REVIEW_REASONS]
      },
      select: { id: true }
    });
    await observer.client.applicationAutomationPolicy.create({
      data: {
        userId: user.id,
        enabled: true,
        mode: "FILL_AND_REVIEW",
        allowedHosts: [APPLY_HOST],
        blockedHosts: [],
        sensitiveAnswerPolicy: "EXCLUDE",
        finalReviewRequired: true
      }
    });
    await observer.client.applicationAnswer.create({
      data: {
        userId: user.id,
        category: "LINKS",
        question: "LinkedIn profile URL",
        normalizedQuestion: `linkedin-profile-url-${key}`,
        answer: `https://www.linkedin.com/in/${key}`
      }
    });

    const packet = await createApplicationRunAnswerPacketService({
      prismaClient: observer.client,
      env: AUTOMATION_ENV
    }).publishFormInspectionAndAnswerPacket({
      userId: user.id,
      runId: run.id,
      expectedStateVersion: 4,
      expectedFormInspectionVersion: 0,
      expectedAnswerPacketVersion: 0,
      observedUrl: `${applyUrl}#observed`,
      inspectionReport: formReport()
    });
    const answer = packet.packet.answers[0];
    assert.ok(answer);
    const runService = createApplicationRunService({ prismaClient: observer.client, env: AUTOMATION_ENV });
    await runService.reviewApplicationRunAnswer({
      userId: user.id,
      runId: run.id,
      answerId: answer.id,
      status: "APPROVED",
      answerPacketVersion: packet.packetVersion
    });
    const ready = await runService.resolveApplicationRunReview({
      userId: user.id,
      runId: run.id,
      stateVersion: packet.stateVersion,
      acknowledgedReviewReasons: [...REVIEW_REASONS],
      answerPacketVersion: packet.packetVersion,
      packetHash: packet.packetHash
    });
    assert.equal(ready.state, "READY");

    const runLockHeld = deferred("Fill clock run lock held");
    releaseRunLock = deferred("release Fill clock run lock");
    const blocker = actorA.client.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id" FROM "ApplicationRun"
        WHERE "id" = ${run.id} AND "userId" = ${user.id}
        FOR UPDATE
      `);
      assert.deepEqual(rows, [{ id: run.id }]);
      runLockHeld.resolve();
      await releaseRunLock?.wait();
    });
    operations.push(blocker);
    await runLockHeld.wait();

    const acquisition = createApplicationRunFillAttemptService({
      prismaClient: actorB.client,
      env: AUTOMATION_ENV
    }).acquireFillAttempt({
      userId: user.id,
      runId: run.id,
      expectedStateVersion: ready.stateVersion
    });
    operations.push(acquisition);

    const wait = await waitForActorLockWait(observer, actorB, actorA);
    assert.equal(wait.waiterPid, actorB.backendPid);
    assert.equal(wait.waitEventType, "Lock");
    assert.equal(wait.hasUngrantedLock, true);
    assert.ok(wait.blockingPids.includes(actorA.backendPid));

    const postWaitDatabaseClock = await advanceObservedDatabaseClock(observer, 2_500);
    releaseRunLock.resolve();
    const [blockerResult, acquisitionResult] = await withTimeout(
      Promise.all([blocker, acquisition]),
      OPERATION_TIMEOUT_MS,
      "Fill clock blocker/acquisition settlement"
    );
    assert.equal(blockerResult, undefined);

    const leaseDeltaMs = acquisitionResult.leaseExpiresAt.getTime() - postWaitDatabaseClock.getTime();
    context.diagnostic(
      `observed waiterPid=${wait.waiterPid} blockedBy=${actorA.backendPid} postWaitLeaseDeltaMs=${leaseDeltaMs}`
    );
    assert.ok(
      leaseDeltaMs >= 599_000 && leaseDeltaMs <= 602_000,
      `Expected post-wait lease delta in [599000, 602000]ms, received ${leaseDeltaMs}ms.`
    );

    const persistedRun = await observer.client.applicationRun.findUniqueOrThrow({ where: { id: run.id } });
    assert.equal(persistedRun.state, "FILLING");
    assert.equal(persistedRun.fillAttemptId, acquisitionResult.attemptId);
    assert.equal(persistedRun.fillLeaseExpiresAt?.getTime(), acquisitionResult.leaseExpiresAt.getTime());
    const steps = await observer.client.applicationRunStep.findMany({
      where: { runId: run.id, action: "FILL_FIELD" },
      orderBy: { sequence: "asc" }
    });
    assert.equal(steps.length, acquisitionResult.eligibleFields.length);
    assert.ok(steps.length >= 1);
    assert.deepEqual(steps.map((step) => ({
      stepKey: step.stepKey,
      sequence: step.sequence,
      semanticFieldKey: step.semanticFieldKey
    })), acquisitionResult.eligibleFields.map((field, sequence) => ({
      stepKey: `fill:${acquisitionResult.attemptId}:${field.normalizedFieldKey}`,
      sequence,
      semanticFieldKey: null
    })));
    assert.equal(await observer.client.auditLog.count({
      where: { userId: user.id, action: "application-run-fill-attempt.acquire", resourceId: run.id }
    }), 1);
  } finally {
    releaseRunLock?.resolve();
    await Promise.allSettled(operations);
    if (userId !== null && actors[0]) {
      await actors[0].client.auditLog.deleteMany({ where: { userId } });
      await deleteSyntheticTestUsers(actors[0], [userId]);
    }
    await disconnectPostgresTestActors(actors);
  }
});

test("Recovery crosses database-clock expiry while queued on the run lock", {
  timeout: TEST_TIMEOUT_MS
}, async (context) => {
  const actors: PostgresTestActor[] = [];
  const syntheticUserIds: string[] = [];
  const operations: Promise<unknown>[] = [];
  let releaseRunLock: Deferred<void> | null = null;

  try {
    const observer = await createPostgresTestActor("recover-expiry-observer");
    actors.push(observer);
    const blocker = await createPostgresTestActor("recover-expiry-blocker");
    actors.push(blocker);
    const recoverer = await createPostgresTestActor("recover-expiry-worker");
    actors.push(recoverer);
    assertDistinctActorSessions(actors);

    const fixture = await createFillingFixture(observer, "recover-expiry", 3_000, syntheticUserIds);
    const runLock = holdRunLock(blocker, fixture, "recover expiry");
    releaseRunLock = runLock.release;
    operations.push(runLock.operation);
    await runLock.held.wait();

    const preCallAt = await databaseClock(observer);
    assert.ok(
      preCallAt.getTime() < fixture.fillLeaseExpiresAt.getTime(),
      "Recovery must be called before the seeded lease expires."
    );
    const recovery = createApplicationRunFillAttemptService({
      prismaClient: recoverer.client,
      env: AUTOMATION_ENV
    }).recoverExpiredFillAttempt({
      userId: fixture.userId,
      runId: fixture.runId,
      fillAttemptId: fixture.fillAttemptId,
      expectedStateVersion: fixture.stateVersion
    });
    operations.push(recovery);

    const preExpiryWait = await waitForActorLockWait(observer, recoverer, blocker);
    assertLockWait(preExpiryWait, recoverer, blocker);
    const queuedBeforeExpiryClock = await databaseClock(observer);
    assert.ok(
      queuedBeforeExpiryClock.getTime() < fixture.fillLeaseExpiresAt.getTime(),
      "Recovery must be observably queued before the seeded lease expires."
    );
    const expiryClock = await waitForDatabaseClockAtLeast(observer, fixture.fillLeaseExpiresAt);
    assert.ok(expiryClock.getTime() >= fixture.fillLeaseExpiresAt.getTime());
    const postExpiryWait = await waitForActorLockWait(observer, recoverer, blocker);
    assertLockWait(postExpiryWait, recoverer, blocker);

    releaseRunLock.resolve();
    const [blockerSettlement, recoverySettlement] = await withTimeout(
      Promise.allSettled([runLock.operation, recovery]),
      OPERATION_TIMEOUT_MS,
      "recovery-crosses-expiry settlement"
    );
    requireFulfilled(blockerSettlement, "Recovery expiry blocker");
    const result = requireFulfilled(recoverySettlement, "Queued recovery");
    assert.deepEqual(result, {
      state: "READY_FOR_USER_SUBMISSION",
      stateVersion: fixture.stateVersion + 1,
      fillAttemptId: fixture.fillAttemptId,
      fillLeaseExpiresAt: null,
      leaseLive: false,
      expiredRecoveryRequired: false,
      fieldOperationAllowed: false,
      outcome: "RECOVERED_AFTER_LOSS",
      errorCode: "FILL_STALE",
      steps: fixture.stepKeys.map((stepKey) => ({
        stepKey,
        result: "FAILED",
        errorCode: "FILL_STALE"
      }))
    });

    const persisted = await readPersistedFillState(observer, fixture);
    assert.equal(persisted.run.state, "READY_FOR_USER_SUBMISSION");
    assert.equal(persisted.run.stateVersion, fixture.stateVersion + 1);
    assert.equal(persisted.run.fillAttemptId, fixture.fillAttemptId);
    assert.equal(persisted.run.fillLeaseExpiresAt, null);
    assert.equal(persisted.run.errorCategory, "FILL_STALE");
    assert.deepEqual(persisted.steps.map((step) => ({
      stepKey: step.stepKey,
      sequence: step.sequence,
      status: step.status,
      redactedValueSummary: step.redactedValueSummary,
      errorCategory: step.errorCategory,
      startedAt: step.startedAt
    })), fixture.stepKeys.map((stepKey, sequence) => ({
      stepKey,
      sequence,
      status: "FAILED",
      redactedValueSummary: "FAILED",
      errorCategory: "FILL_STALE",
      startedAt: null
    })));
    assert.ok(persisted.steps.every((step) => step.completedAt instanceof Date));
    assert.deepEqual(persisted.auditCounts, { total: 1, finalize: 0, recover: 1 });
    context.diagnostic(
      `recovery waiterPid=${recoverer.backendPid} blockedBy=${blocker.backendPid} ` +
      `preCallAt=${preCallAt.toISOString()} queuedAt=${queuedBeforeExpiryClock.toISOString()} ` +
      `lease=${fixture.fillLeaseExpiresAt.toISOString()} ` +
      `expiredAt=${expiryClock.toISOString()}`
    );
  } finally {
    releaseRunLock?.resolve();
    await Promise.allSettled(operations);
    try {
      if (actors[0] && syntheticUserIds.length > 0) {
        await actors[0].client.auditLog.deleteMany({ where: { userId: { in: syntheticUserIds } } });
        await deleteSyntheticTestUsers(actors[0], syntheticUserIds);
      }
    } finally {
      await disconnectPostgresTestActors(actors);
    }
  }
});

test("FINALIZE-first serialization commits once and queued RECOVER fails stale", {
  timeout: TEST_TIMEOUT_MS
}, async (context) => {
  const actors: PostgresTestActor[] = [];
  const syntheticUserIds: string[] = [];
  const operations: Promise<unknown>[] = [];
  let releaseRunLock: Deferred<void> | null = null;

  try {
    const observer = await createPostgresTestActor("finalize-first-observer");
    actors.push(observer);
    const blocker = await createPostgresTestActor("finalize-first-blocker");
    actors.push(blocker);
    const finalizer = await createPostgresTestActor("finalize-first-worker");
    actors.push(finalizer);
    const recoverer = await createPostgresTestActor("finalize-second-worker");
    actors.push(recoverer);
    assertDistinctActorSessions(actors);

    const fixture = await createFillingFixture(observer, "finalize-first", 60_000, syntheticUserIds);
    const runLock = holdRunLock(blocker, fixture, "FINALIZE-first");
    releaseRunLock = runLock.release;
    operations.push(runLock.operation);
    await runLock.held.wait();

    const finalization = createApplicationRunFillAttemptService({
      prismaClient: finalizer.client,
      env: AUTOMATION_ENV
    }).finalizeFillAttempt({
      userId: fixture.userId,
      runId: fixture.runId,
      fillAttemptId: fixture.fillAttemptId,
      expectedStateVersion: fixture.stateVersion,
      outcome: "COMPLETED",
      errorCode: null,
      steps: [
        { stepKey: fixture.stepKeys[0], result: "FILLED", errorCode: null },
        { stepKey: fixture.stepKeys[1], result: "MANUAL", errorCode: null }
      ]
    });
    operations.push(finalization);
    const finalizerWait = await waitForActorLockWait(observer, finalizer, blocker);
    assertLockWait(finalizerWait, finalizer, blocker);

    const recovery = createApplicationRunFillAttemptService({
      prismaClient: recoverer.client,
      env: AUTOMATION_ENV
    }).recoverExpiredFillAttempt({
      userId: fixture.userId,
      runId: fixture.runId,
      fillAttemptId: fixture.fillAttemptId,
      expectedStateVersion: fixture.stateVersion
    });
    operations.push(recovery);
    const recovererWait = await waitForActorLockWait(observer, recoverer, finalizer);
    assertLockWait(recovererWait, recoverer, finalizer);

    releaseRunLock.resolve();
    const [blockerSettlement, finalizationSettlement, recoverySettlement] = await withTimeout(
      Promise.allSettled([runLock.operation, finalization, recovery]),
      OPERATION_TIMEOUT_MS,
      "FINALIZE-first settlement"
    );
    requireFulfilled(blockerSettlement, "FINALIZE-first blocker");
    const result = requireFulfilled(finalizationSettlement, "First-queued finalization");
    assertFillStaleRejection(recoverySettlement, "Second-queued recovery");
    assert.deepEqual(result, {
      state: "READY_FOR_USER_SUBMISSION",
      stateVersion: fixture.stateVersion + 1,
      fillAttemptId: fixture.fillAttemptId,
      fillLeaseExpiresAt: null,
      leaseLive: false,
      expiredRecoveryRequired: false,
      fieldOperationAllowed: false,
      outcome: "COMPLETED",
      errorCode: null,
      steps: [
        { stepKey: fixture.stepKeys[0], result: "FILLED", errorCode: null },
        { stepKey: fixture.stepKeys[1], result: "MANUAL", errorCode: null }
      ]
    });

    const persisted = await readPersistedFillState(observer, fixture);
    assert.equal(persisted.run.state, "READY_FOR_USER_SUBMISSION");
    assert.equal(persisted.run.stateVersion, fixture.stateVersion + 1);
    assert.equal(persisted.run.fillAttemptId, fixture.fillAttemptId);
    assert.equal(persisted.run.fillLeaseExpiresAt, null);
    assert.equal(persisted.run.errorCategory, null);
    assert.deepEqual(persisted.steps.map((step) => ({
      stepKey: step.stepKey,
      sequence: step.sequence,
      status: step.status,
      redactedValueSummary: step.redactedValueSummary,
      errorCategory: step.errorCategory,
      startedAt: step.startedAt
    })), [
      {
        stepKey: fixture.stepKeys[0],
        sequence: 0,
        status: "SUCCEEDED",
        redactedValueSummary: "FILLED",
        errorCategory: null,
        startedAt: null
      },
      {
        stepKey: fixture.stepKeys[1],
        sequence: 1,
        status: "SKIPPED",
        redactedValueSummary: "MANUAL",
        errorCategory: null,
        startedAt: null
      }
    ]);
    assert.ok(persisted.steps.every((step) => step.completedAt instanceof Date));
    assert.deepEqual(persisted.auditCounts, { total: 1, finalize: 1, recover: 0 });
    context.diagnostic(
      `FINALIZE-first finalizerPid=${finalizer.backendPid} queuedOn=${blocker.backendPid}; ` +
      `recovererPid=${recoverer.backendPid} queuedBehind=${finalizer.backendPid}`
    );
  } finally {
    releaseRunLock?.resolve();
    await Promise.allSettled(operations);
    try {
      if (actors[0] && syntheticUserIds.length > 0) {
        await actors[0].client.auditLog.deleteMany({ where: { userId: { in: syntheticUserIds } } });
        await deleteSyntheticTestUsers(actors[0], syntheticUserIds);
      }
    } finally {
      await disconnectPostgresTestActors(actors);
    }
  }
});

test("RECOVER-first serialization commits once and queued FINALIZE fails stale", {
  timeout: TEST_TIMEOUT_MS
}, async (context) => {
  const actors: PostgresTestActor[] = [];
  const syntheticUserIds: string[] = [];
  const operations: Promise<unknown>[] = [];
  let releaseRunLock: Deferred<void> | null = null;

  try {
    const observer = await createPostgresTestActor("recover-first-observer");
    actors.push(observer);
    const blocker = await createPostgresTestActor("recover-first-blocker");
    actors.push(blocker);
    const recoverer = await createPostgresTestActor("recover-first-worker");
    actors.push(recoverer);
    const finalizer = await createPostgresTestActor("recover-second-worker");
    actors.push(finalizer);
    assertDistinctActorSessions(actors);

    const fixture = await createFillingFixture(observer, "recover-first", -1_000, syntheticUserIds);
    const runLock = holdRunLock(blocker, fixture, "RECOVER-first");
    releaseRunLock = runLock.release;
    operations.push(runLock.operation);
    await runLock.held.wait();

    const recovery = createApplicationRunFillAttemptService({
      prismaClient: recoverer.client,
      env: AUTOMATION_ENV
    }).recoverExpiredFillAttempt({
      userId: fixture.userId,
      runId: fixture.runId,
      fillAttemptId: fixture.fillAttemptId,
      expectedStateVersion: fixture.stateVersion
    });
    operations.push(recovery);
    const recovererWait = await waitForActorLockWait(observer, recoverer, blocker);
    assertLockWait(recovererWait, recoverer, blocker);

    const finalization = createApplicationRunFillAttemptService({
      prismaClient: finalizer.client,
      env: AUTOMATION_ENV
    }).finalizeFillAttempt({
      userId: fixture.userId,
      runId: fixture.runId,
      fillAttemptId: fixture.fillAttemptId,
      expectedStateVersion: fixture.stateVersion,
      outcome: "COMPLETED",
      errorCode: null,
      steps: [
        { stepKey: fixture.stepKeys[0], result: "FILLED", errorCode: null },
        { stepKey: fixture.stepKeys[1], result: "MANUAL", errorCode: null }
      ]
    });
    operations.push(finalization);
    const finalizerWait = await waitForActorLockWait(observer, finalizer, recoverer);
    assertLockWait(finalizerWait, finalizer, recoverer);

    releaseRunLock.resolve();
    const [blockerSettlement, recoverySettlement, finalizationSettlement] = await withTimeout(
      Promise.allSettled([runLock.operation, recovery, finalization]),
      OPERATION_TIMEOUT_MS,
      "RECOVER-first settlement"
    );
    requireFulfilled(blockerSettlement, "RECOVER-first blocker");
    const result = requireFulfilled(recoverySettlement, "First-queued recovery");
    assertFillStaleRejection(finalizationSettlement, "Second-queued finalization");
    assert.deepEqual(result, {
      state: "READY_FOR_USER_SUBMISSION",
      stateVersion: fixture.stateVersion + 1,
      fillAttemptId: fixture.fillAttemptId,
      fillLeaseExpiresAt: null,
      leaseLive: false,
      expiredRecoveryRequired: false,
      fieldOperationAllowed: false,
      outcome: "RECOVERED_AFTER_LOSS",
      errorCode: "FILL_STALE",
      steps: fixture.stepKeys.map((stepKey) => ({
        stepKey,
        result: "FAILED",
        errorCode: "FILL_STALE"
      }))
    });

    const persisted = await readPersistedFillState(observer, fixture);
    assert.equal(persisted.run.state, "READY_FOR_USER_SUBMISSION");
    assert.equal(persisted.run.stateVersion, fixture.stateVersion + 1);
    assert.equal(persisted.run.fillAttemptId, fixture.fillAttemptId);
    assert.equal(persisted.run.fillLeaseExpiresAt, null);
    assert.equal(persisted.run.errorCategory, "FILL_STALE");
    assert.deepEqual(persisted.steps.map((step) => ({
      stepKey: step.stepKey,
      sequence: step.sequence,
      status: step.status,
      redactedValueSummary: step.redactedValueSummary,
      errorCategory: step.errorCategory,
      startedAt: step.startedAt
    })), fixture.stepKeys.map((stepKey, sequence) => ({
      stepKey,
      sequence,
      status: "FAILED",
      redactedValueSummary: "FAILED",
      errorCategory: "FILL_STALE",
      startedAt: null
    })));
    assert.ok(persisted.steps.every((step) => step.completedAt instanceof Date));
    assert.deepEqual(persisted.auditCounts, { total: 1, finalize: 0, recover: 1 });
    context.diagnostic(
      `RECOVER-first recovererPid=${recoverer.backendPid} queuedOn=${blocker.backendPid}; ` +
      `finalizerPid=${finalizer.backendPid} queuedBehind=${recoverer.backendPid}`
    );
  } finally {
    releaseRunLock?.resolve();
    await Promise.allSettled(operations);
    try {
      if (actors[0] && syntheticUserIds.length > 0) {
        await actors[0].client.auditLog.deleteMany({ where: { userId: { in: syntheticUserIds } } });
        await deleteSyntheticTestUsers(actors[0], syntheticUserIds);
      }
    } finally {
      await disconnectPostgresTestActors(actors);
    }
  }
});
