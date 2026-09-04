import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import { Prisma, type PrismaClient } from "@prisma/client";

import { PublicApiError } from "@/lib/api-errors";
import { createApplicationRunAnswerPacketService } from "@/lib/application-runs/answer-packet-service";
import { createApplicationRunFillAttemptService } from "@/lib/application-runs/fill-attempt";
import { FORM_INSPECTION_SCHEMA_VERSION } from "@/lib/application-runs/form-inspection";
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
  type HookedPrismaClient,
  type PostgresTestActor,
  type PrismaHookMatcher,
  type PrismaOperationHook
} from "@/tests/postgres/postgres-test-harness";

/*
 * Increment 3 Commit 6 PostgreSQL proof matrix
 *
 *  1. two simultaneous starts                              NEW IN COMMIT 6 (this file)
 *  2. start vs answer review                               NEW IN COMMIT 6 (this file)
 *  3. start vs review resolution                           NEW IN COMMIT 6 (this file)
 *  4. start vs policy mutation                             NEW IN COMMIT 6 (this file)
 *  5. start vs material reinspection                       NEW IN COMMIT 6 (this file)
 *  6. start vs cancellation                                NEW IN COMMIT 6 (this file)
 *  7. FINALIZE vs cancellation                             NEW IN COMMIT 6 (this file)
 *  8. RECOVER vs FINALIZE                                  ALREADY FROZEN IN
 *     tests/postgres/application-run-fill-attempt-clock.test.ts
 *  9. RECOVER vs cancellation                              NEW IN COMMIT 6 (this file)
 * 10. material reinspection vs post-Fill review resolution NEW IN COMMIT 6 (this file)
 * 11. exact replay vs relevant lifecycle mutation          NEW IN COMMIT 6 (this file)
 * 12. acquisition waits on policy/run lock                 ALREADY FROZEN IN
 *     tests/postgres/application-run-fill-attempt-clock.test.ts
 * 13. recovery crosses expiry while waiting                ALREADY FROZEN IN
 *     tests/postgres/application-run-fill-attempt-clock.test.ts
 * 14. RepeatableRead GET coherent snapshot                 NEW IN COMMIT 6 (this file)
 * 15. missing-policy GET no-write persistence              NEW IN COMMIT 6 (this file)
 */

const TEST_TIMEOUT_MS = 30_000;
const OPERATION_TIMEOUT_MS = 12_000;
const CLEANUP_TIMEOUT_MS = 5_000;
const APPLY_HOST = "jobs.example.test";
const AUTOMATION_ENV = { APPLICATION_AUTOMATION_ENABLED: "true" } as const;
const REVIEW_REASONS = ["evidence_gaps_present"] as const;
const INITIAL_STATE_VERSION = 4;

const RUN_ROW_LOCK = {
  kind: "queryRaw",
  includes: ['FROM "ApplicationRun"', "FOR UPDATE"]
} as const satisfies PrismaHookMatcher;

type Scenario = {
  label: string;
  observer: PostgresTestActor;
  actorA: PostgresTestActor;
  actorB: PostgresTestActor;
  actors: PostgresTestActor[];
  releases: Deferred<void>[];
  operations: Promise<unknown>[];
  userIds: string[];
};

type CapturedFailure = { present: false } | { present: true; error: unknown };
type CleanupFailure = { phase: string; error: unknown };

type Fixture = {
  userId: string;
  applicationId: string;
  runId: string;
  policyId: string;
  vaultId: string;
  applyUrl: string;
};

type PacketResult = Awaited<
  ReturnType<ReturnType<typeof createApplicationRunAnswerPacketService>["publishFormInspectionAndAnswerPacket"]>
>;

type ReadyFixture = Fixture & {
  packet: PacketResult;
  stateVersion: number;
};

type FillingFixture = ReadyFixture & {
  fillAttemptId: string;
  fillingStateVersion: number;
  stepKeys: string[];
  leaseExpiresAt: Date;
};

type PostFillFixture = FillingFixture & {
  readyForSubmissionStateVersion: number;
};

type PostFillReviewFixture = PostFillFixture & {
  reviewPacket: PacketResult;
  reviewStateVersion: number;
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
    return { label, observer, actorA, actorB, actors, releases: [], operations: [], userIds: [] };
  } catch (error) {
    await disconnectPostgresTestActors(actors);
    throw error;
  }
}

function trackRelease(scenario: Scenario, barrier: Deferred<void>): Deferred<void> {
  scenario.releases.push(barrier);
  return barrier;
}

function trackOperation<T>(scenario: Scenario, operation: Promise<T>): Promise<T> {
  scenario.operations.push(operation);
  return operation;
}

async function cleanupScenario(scenario: Scenario, primary: CapturedFailure): Promise<void> {
  const failures: CleanupFailure[] = [];
  for (const release of scenario.releases) {
    try {
      release.resolve();
    } catch (error) {
      failures.push({ phase: "release-barrier", error });
    }
  }

  const settlement = Promise.allSettled(scenario.operations);
  let operationsSettled = scenario.operations.length === 0;
  if (!operationsSettled) {
    try {
      await withTimeout(settlement, CLEANUP_TIMEOUT_MS, `${scenario.label} cleanup settlement`);
      operationsSettled = true;
    } catch (error) {
      failures.push({ phase: "operation-settlement", error });
    }
  }

  if (!operationsSettled) {
    try {
      await disconnectPostgresTestActors([scenario.actorA, scenario.actorB]);
    } catch (error) {
      failures.push({ phase: "early-competitor-disconnect", error });
    }
    try {
      await withTimeout(settlement, CLEANUP_TIMEOUT_MS, `${scenario.label} cleanup resettlement`);
      operationsSettled = true;
    } catch (error) {
      failures.push({ phase: "operation-resettlement", error });
    }
  }

  let observerHealthy = false;
  try {
    await assertActorSessionPinned(scenario.observer, `${scenario.label}-cleanup-observer`);
    await assertNoIdleTransactions(scenario.observer, scenario.actors);
    observerHealthy = true;
  } catch (error) {
    failures.push({ phase: "actor-health", error });
  }

  if (observerHealthy && operationsSettled && scenario.userIds.length > 0) {
    const userIds = [...new Set(scenario.userIds)].sort();
    try {
      await scenario.observer.client.auditLog.deleteMany({ where: { userId: { in: userIds } } });
      await deleteSyntheticTestUsers(scenario.observer, userIds);
    } catch (error) {
      failures.push({ phase: "fixture-deletion", error });
    }
  }

  try {
    await disconnectPostgresTestActors(scenario.actors);
  } catch (error) {
    failures.push({ phase: "actor-disconnect", error });
  }

  if (primary.present) {
    if (
      failures.length > 0 &&
      primary.error instanceof Error &&
      Object.isExtensible(primary.error) &&
      !("cause" in primary.error)
    ) {
      try {
        Object.defineProperty(primary.error, "cause", {
          value: new AggregateError(
            failures.map(({ phase }) => new Error(`Secondary Commit 6 cleanup failure: ${phase}.`)),
            "One or more secondary Commit 6 cleanup phases failed."
          ),
          configurable: true
        });
      } catch {
        // The primary scenario failure remains authoritative.
      }
    }
    throw primary.error;
  }
  if (failures.length > 0) throw failures[0].error;
}

async function runScenario(label: string, body: (scenario: Scenario) => Promise<void>): Promise<void> {
  const scenario = await createScenario(label);
  let primary: CapturedFailure = { present: false };
  try {
    await body(scenario);
  } catch (error) {
    primary = { present: true, error };
  }
  await cleanupScenario(scenario, primary);
}

function formReport(variant = "initial") {
  const required = variant !== "postfill-refresh-first" && variant !== "postfill-resolution-first";
  return {
    schemaVersion: FORM_INSPECTION_SCHEMA_VERSION,
    forms: [{
      title: "Application",
      sections: [{
        heading: "Candidate",
        fields: [{
          question: "LinkedIn profile URL",
          helpText: variant === "initial" ? null : "Provide your current professional profile URL.",
          fieldType: "URL",
          unsupportedReason: null,
          required,
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

async function createFixture(scenario: Scenario, label: string): Promise<Fixture> {
  const user = await createSyntheticTestUser(scenario.observer, `${scenario.label}-${label}`);
  scenario.userIds.push(user.id);
  const key = `${label}-${randomUUID()}`;
  const applyUrl = `https://${APPLY_HOST}/apply/${key}`;
  const job = await scenario.observer.client.jobPosting.create({
    data: {
      userId: user.id,
      title: `Commit 6 concurrency role ${key}`,
      normalizedTitle: `commit-6-concurrency-role-${key}`,
      company: "Commit 6 Synthetic Employer",
      normalizedCompany: `commit-6-synthetic-employer-${key}`,
      location: "Remote",
      normalizedLocation: `remote-${key}`,
      remoteStatus: "REMOTE",
      sourceUrl: `https://${APPLY_HOST}/jobs/${key}`,
      applyUrl,
      normalizedApplyUrl: applyUrl,
      description: "Disposable production Fill concurrency fixture.",
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
  const application = await scenario.observer.client.application.create({
    data: { userId: user.id, jobPostingId: job.id },
    select: { id: true }
  });
  const run = await scenario.observer.client.applicationRun.create({
    data: {
      userId: user.id,
      jobPostingId: job.id,
      applicationId: application.id,
      state: "READY",
      stateVersion: INITIAL_STATE_VERSION,
      activeRunKey: application.id,
      idempotencyKey: `commit6:${key}`,
      applyUrlSnapshot: applyUrl,
      applyHost: APPLY_HOST,
      reviewReasons: [...REVIEW_REASONS]
    },
    select: { id: true }
  });
  const policy = await scenario.observer.client.applicationAutomationPolicy.create({
    data: {
      userId: user.id,
      enabled: true,
      mode: "FILL_AND_REVIEW",
      allowedHosts: [APPLY_HOST],
      blockedHosts: [],
      sensitiveAnswerPolicy: "EXCLUDE",
      finalReviewRequired: true
    },
    select: { id: true }
  });
  const vault = await scenario.observer.client.applicationAnswer.create({
    data: {
      userId: user.id,
      category: "LINKS",
      question: "LinkedIn profile URL",
      normalizedQuestion: `linkedin-profile-url-${key}`,
      answer: `https://www.linkedin.com/in/${randomUUID()}`
    },
    select: { id: true }
  });
  return {
    userId: user.id,
    applicationId: application.id,
    runId: run.id,
    policyId: policy.id,
    vaultId: vault.id,
    applyUrl
  };
}

function packetService(client: PrismaClient) {
  return createApplicationRunAnswerPacketService({ prismaClient: client, env: AUTOMATION_ENV });
}

function runService(client: PrismaClient) {
  return createApplicationRunService({ prismaClient: client, env: AUTOMATION_ENV });
}

function fillService(client: PrismaClient, attemptId?: string) {
  return createApplicationRunFillAttemptService({
    prismaClient: client,
    env: AUTOMATION_ENV,
    ...(attemptId ? { attemptIdGenerator: () => attemptId } : {})
  });
}

function repeatableReadFillService(actor: PostgresTestActor, hooks: readonly PrismaOperationHook[] = []) {
  const controlled = createHookedPrismaClient(actor, hooks, {
    requiredInteractiveTransactionIsolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead
  });
  return { controlled, service: fillService(controlled.prismaClient) };
}

async function publishPacket(
  fixture: Fixture,
  actor: PostgresTestActor,
  input: {
    stateVersion: number;
    inspectionVersion: number;
    packetVersion: number;
    variant?: string;
  }
): Promise<PacketResult> {
  return packetService(actor.client).publishFormInspectionAndAnswerPacket({
    userId: fixture.userId,
    runId: fixture.runId,
    expectedStateVersion: input.stateVersion,
    expectedFormInspectionVersion: input.inspectionVersion,
    expectedAnswerPacketVersion: input.packetVersion,
    observedUrl: `${fixture.applyUrl}#${input.variant ?? "initial"}`,
    inspectionReport: formReport(input.variant)
  });
}

async function reviewPacket(
  fixture: Fixture,
  packet: PacketResult,
  actor: PostgresTestActor
): Promise<void> {
  const answers = await actor.client.applicationRunAnswer.findMany({
    where: {
      runId: fixture.runId,
      userId: fixture.userId,
      answerPacket: { version: packet.packetVersion },
      status: "PENDING"
    },
    select: { id: true, disposition: true, proposal: true, sensitive: true, valueRedacted: true }
  });
  assert.ok(answers.length > 0);
  for (const answer of answers) {
    const status = answer.disposition === "PROPOSABLE" && answer.proposal !== null &&
      !answer.sensitive && !answer.valueRedacted ? "APPROVED" : "REJECTED";
    await runService(actor.client).reviewApplicationRunAnswer({
      userId: fixture.userId,
      runId: fixture.runId,
      answerId: answer.id,
      status,
      answerPacketVersion: packet.packetVersion
    });
  }
}

async function createPendingReviewFixture(scenario: Scenario, label: string): Promise<Fixture & { packet: PacketResult }> {
  const fixture = await createFixture(scenario, label);
  const packet = await publishPacket(fixture, scenario.observer, {
    stateVersion: INITIAL_STATE_VERSION,
    inspectionVersion: 0,
    packetVersion: 0
  });
  return { ...fixture, packet };
}

async function createApprovedReviewFixture(scenario: Scenario, label: string): Promise<Fixture & { packet: PacketResult }> {
  const fixture = await createPendingReviewFixture(scenario, label);
  await reviewPacket(fixture, fixture.packet, scenario.observer);
  return fixture;
}

async function createReadyFixture(scenario: Scenario, label: string): Promise<ReadyFixture> {
  const fixture = await createApprovedReviewFixture(scenario, label);
  const resolved = await runService(scenario.observer.client).resolveApplicationRunReview({
    userId: fixture.userId,
    runId: fixture.runId,
    stateVersion: fixture.packet.stateVersion,
    acknowledgedReviewReasons: [...REVIEW_REASONS],
    answerPacketVersion: fixture.packet.packetVersion,
    packetHash: fixture.packet.packetHash
  });
  assert.equal(resolved.state, "READY");
  return { ...fixture, stateVersion: resolved.stateVersion };
}

async function createFillingFixture(scenario: Scenario, label: string): Promise<FillingFixture> {
  const fixture = await createReadyFixture(scenario, label);
  const fillAttemptId = randomUUID();
  const acquired = await fillService(scenario.observer.client, fillAttemptId).acquireFillAttempt({
    userId: fixture.userId,
    runId: fixture.runId,
    expectedStateVersion: fixture.stateVersion
  });
  const stepKeys = acquired.eligibleFields.map(
    (field) => `fill:${fillAttemptId}:${field.normalizedFieldKey}`
  );
  assert.ok(stepKeys.length > 0);
  return {
    ...fixture,
    fillAttemptId,
    fillingStateVersion: acquired.runStateVersion,
    stepKeys,
    leaseExpiresAt: acquired.leaseExpiresAt
  };
}

async function createPostFillFixture(scenario: Scenario, label: string): Promise<PostFillFixture> {
  const fixture = await createFillingFixture(scenario, label);
  const finalized = await fillService(scenario.observer.client).finalizeFillAttempt({
    userId: fixture.userId,
    runId: fixture.runId,
    fillAttemptId: fixture.fillAttemptId,
    expectedStateVersion: fixture.fillingStateVersion,
    outcome: "COMPLETED",
    errorCode: null,
    steps: fixture.stepKeys.map((stepKey) => ({ stepKey, result: "FILLED" as const, errorCode: null }))
  });
  assert.equal(finalized.state, "READY_FOR_USER_SUBMISSION");
  return { ...fixture, readyForSubmissionStateVersion: finalized.stateVersion };
}

async function createPostFillReviewFixture(scenario: Scenario, label: string): Promise<PostFillReviewFixture> {
  const fixture = await createPostFillFixture(scenario, label);
  const before = await scenario.observer.client.applicationRun.findUniqueOrThrow({
    where: { id: fixture.runId }
  });
  const materialPacket = await publishPacket(fixture, scenario.observer, {
    stateVersion: before.stateVersion,
    inspectionVersion: before.currentFormInspectionVersion,
    packetVersion: before.currentAnswerPacketVersion,
    variant: "post-fill-review"
  });
  await reviewPacket(fixture, materialPacket, scenario.observer);
  return {
    ...fixture,
    reviewPacket: materialPacket,
    reviewStateVersion: materialPacket.stateVersion
  };
}

function pauseAfter(
  scenario: Scenario,
  actor: PostgresTestActor,
  name: string,
  matcher: PrismaHookMatcher
): { hooks: HookedPrismaClient; reached: Deferred<void>; release: Deferred<void> } {
  const reached = deferred(`${name} reached`);
  const release = trackRelease(scenario, deferred(`release ${name}`));
  const hooks = createHookedPrismaClient(actor, [{
    name,
    match: matcher,
    expectedMatches: 1,
    after: async () => {
      reached.resolve();
      await release.wait();
    }
  }]);
  return { hooks, reached, release };
}

async function assertObservedWait(
  scenario: Scenario,
  waiter: PostgresTestActor,
  blocker: PostgresTestActor
): Promise<void> {
  const observed = await waitForActorLockWait(scenario.observer, waiter, blocker);
  assert.equal(observed.waiterPid, waiter.backendPid);
  assert.equal(observed.waiterApplicationName, waiter.applicationName);
  assert.equal(observed.waitEventType, "Lock");
  assert.equal(observed.hasUngrantedLock, true);
  assert.ok(observed.blockingPids.includes(blocker.backendPid));
}

async function settlePair<T, U>(
  first: Promise<T>,
  second: Promise<U>,
  label: string
): Promise<[PromiseSettledResult<T>, PromiseSettledResult<U>]> {
  return withTimeout(Promise.allSettled([first, second]), OPERATION_TIMEOUT_MS, label) as Promise<[
    PromiseSettledResult<T>,
    PromiseSettledResult<U>
  ]>;
}

function fulfilled<T>(result: PromiseSettledResult<T>, actor: PostgresTestActor, phase: string): T {
  if (result.status === "fulfilled") return result.value;
  assertNoUnexpectedConcurrencyError(result.reason, actor.actorName, phase);
  assert.fail(`${actor.actorName} unexpectedly rejected during ${phase}: ${String(result.reason)}`);
}

function rejected(result: PromiseSettledResult<unknown>, actor: PostgresTestActor, phase: string): unknown {
  if (result.status === "rejected") {
    assertNoUnexpectedConcurrencyError(result.reason, actor.actorName, phase);
    return result.reason;
  }
  assert.fail(`${actor.actorName} unexpectedly fulfilled during ${phase}.`);
}

function assertPublicError(error: unknown, status: number, code: string): void {
  assert.ok(error instanceof PublicApiError);
  assert.equal(error.status, status);
  assert.equal(error.details?.code, code);
}

async function actionCount(scenario: Scenario, fixture: Fixture, action: string): Promise<number> {
  return scenario.observer.client.auditLog.count({
    where: { userId: fixture.userId, action }
  });
}

async function eventCount(scenario: Scenario, fixture: Fixture): Promise<number> {
  return scenario.observer.client.applicationEvent.count({
    where: { userId: fixture.userId, applicationId: fixture.applicationId }
  });
}

async function assertHealthy(scenario: Scenario, phase: string): Promise<void> {
  await assertNoIdleTransactions(scenario.observer, scenario.actors);
  for (const actor of scenario.actors) {
    await assertActorSessionPinned(actor, `${scenario.label}-${phase}-${actor.actorName}`);
  }
}

async function databaseClock(actor: PostgresTestActor): Promise<Date> {
  const rows = await actor.client.$queryRaw<Array<{ now: Date }>>(Prisma.sql`
    SELECT clock_timestamp() AS "now"
  `);
  assert.equal(rows.length, 1);
  assert.ok(rows[0]?.now instanceof Date);
  return rows[0].now;
}

async function waitForDatabaseClockAtLeast(actor: PostgresTestActor, target: Date): Promise<Date> {
  const deadline = Date.now() + OPERATION_TIMEOUT_MS;
  let observed = await databaseClock(actor);
  while (observed.getTime() < target.getTime()) {
    if (Date.now() >= deadline) {
      throw new Error(`Database clock did not reach ${target.toISOString()}.`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    observed = await databaseClock(actor);
  }
  return observed;
}

test("two simultaneous production starts consume exactly one permanent Fill attempt", {
  timeout: TEST_TIMEOUT_MS
}, async () => {
  await runScenario("commit6-two-starts", async (scenario) => {
    const fixture = await createReadyFixture(scenario, "user");
    const baselineEvents = await eventCount(scenario, fixture);
    const winnerPause = pauseAfter(
      scenario,
      scenario.actorA,
      "two-start winner run mutation",
      { kind: "model", model: "applicationRun", method: "updateMany" }
    );
    const attemptA = randomUUID();
    const attemptB = randomUUID();
    assert.notEqual(attemptA, attemptB);

    const winner = trackOperation(
      scenario,
      fillService(winnerPause.hooks.prismaClient, attemptA).acquireFillAttempt({
        userId: fixture.userId,
        runId: fixture.runId,
        expectedStateVersion: fixture.stateVersion
      })
    );
    await winnerPause.reached.wait();
    const contender = trackOperation(
      scenario,
      fillService(scenario.actorB.client, attemptB).acquireFillAttempt({
        userId: fixture.userId,
        runId: fixture.runId,
        expectedStateVersion: fixture.stateVersion
      })
    );
    await assertObservedWait(scenario, scenario.actorB, scenario.actorA);

    winnerPause.release.resolve();
    const [winnerSettled, contenderSettled] = await settlePair(
      winner,
      contender,
      "two production Fill starts"
    );
    const acquired = fulfilled(winnerSettled, scenario.actorA, "two-start winner");
    assertPublicError(
      rejected(contenderSettled, scenario.actorB, "two-start contender"),
      409,
      "FILL_ALREADY_IN_PROGRESS"
    );
    winnerPause.hooks.assertExpectedHooksReached();

    assert.equal(acquired.attemptId, attemptA);
    assert.equal(acquired.runStateVersion, fixture.stateVersion + 1);
    const run = await scenario.observer.client.applicationRun.findUniqueOrThrow({
      where: { id: fixture.runId }
    });
    assert.equal(run.state, "FILLING");
    assert.equal(run.stateVersion, fixture.stateVersion + 1);
    assert.equal(run.fillAttemptId, attemptA);
    assert.ok(run.fillLeaseExpiresAt instanceof Date);
    assert.equal(run.fillLeaseExpiresAt.getTime(), acquired.leaseExpiresAt.getTime());
    const steps = await scenario.observer.client.applicationRunStep.findMany({
      where: { runId: fixture.runId, userId: fixture.userId, action: "FILL_FIELD" },
      orderBy: { sequence: "asc" }
    });
    assert.equal(steps.length, acquired.eligibleFields.length);
    assert.ok(steps.length > 0);
    assert.equal(new Set(steps.map(({ stepKey }) => stepKey)).size, steps.length);
    assert.deepEqual(steps.map((step) => ({
      stepKey: step.stepKey,
      sequence: step.sequence,
      status: step.status,
      attemptNumber: step.attemptNumber
    })), acquired.eligibleFields.map((field, sequence) => ({
      stepKey: `fill:${attemptA}:${field.normalizedFieldKey}`,
      sequence,
      status: "PENDING",
      attemptNumber: 1
    })));
    assert.equal(await actionCount(scenario, fixture, "application-run-fill-attempt.acquire"), 1);
    assert.equal(await eventCount(scenario, fixture), baselineEvents);
    await assertHealthy(scenario, "complete");
  });
});

test("answer-review-first makes a queued start re-read unresolved review authority", {
  timeout: TEST_TIMEOUT_MS
}, async () => {
  await runScenario("commit6-review-first-start", async (scenario) => {
    const fixture = await createPendingReviewFixture(scenario, "user");
    const answer = fixture.packet.packet.answers[0];
    assert.ok(answer);
    const reviewAuditsBefore = await actionCount(scenario, fixture, "application-run-answer.review");
    const acquisitionAuditsBefore = await actionCount(
      scenario,
      fixture,
      "application-run-fill-attempt.acquire"
    );
    const totalAuditsBefore = await scenario.observer.client.auditLog.count({
      where: { userId: fixture.userId }
    });
    assert.equal(reviewAuditsBefore, 0);
    assert.equal(acquisitionAuditsBefore, 0);
    const reviewPause = pauseAfter(
      scenario,
      scenario.actorA,
      "answer-review-first mutation",
      { kind: "model", model: "applicationRunAnswer", method: "updateMany" }
    );
    const review = trackOperation(
      scenario,
      runService(reviewPause.hooks.prismaClient).reviewApplicationRunAnswer({
        userId: fixture.userId,
        runId: fixture.runId,
        answerId: answer.id,
        status: "APPROVED",
        answerPacketVersion: fixture.packet.packetVersion
      })
    );
    await reviewPause.reached.wait();
    const start = trackOperation(
      scenario,
      fillService(scenario.actorB.client).acquireFillAttempt({
        userId: fixture.userId,
        runId: fixture.runId,
        expectedStateVersion: fixture.packet.stateVersion
      })
    );
    await assertObservedWait(scenario, scenario.actorB, scenario.actorA);

    reviewPause.release.resolve();
    const [reviewSettled, startSettled] = await settlePair(review, start, "answer review before start");
    const reviewed = fulfilled(reviewSettled, scenario.actorA, "answer review first");
    assert.equal(reviewed.status, "APPROVED");
    assertPublicError(rejected(startSettled, scenario.actorB, "queued Fill start"), 409, "FILL_REVIEW_REQUIRED");
    reviewPause.hooks.assertExpectedHooksReached();

    const run = await scenario.observer.client.applicationRun.findUniqueOrThrow({ where: { id: fixture.runId } });
    const persistedAnswer = await scenario.observer.client.applicationRunAnswer.findUniqueOrThrow({
      where: { id: answer.id }
    });
    assert.equal(run.state, "REVIEW_REQUIRED");
    assert.equal(run.stateVersion, fixture.packet.stateVersion);
    assert.equal(run.fillAttemptId, null);
    assert.equal(run.fillLeaseExpiresAt, null);
    assert.equal(persistedAnswer.status, "APPROVED");
    assert.equal(persistedAnswer.reviewedByUser, true);
    assert.ok(persistedAnswer.reviewedAt instanceof Date);
    assert.equal(await scenario.observer.client.applicationRunStep.count({ where: { runId: fixture.runId } }), 0);
    const reviewAuditsAfter = await actionCount(scenario, fixture, "application-run-answer.review");
    const acquisitionAuditsAfter = await actionCount(
      scenario,
      fixture,
      "application-run-fill-attempt.acquire"
    );
    assert.equal(reviewAuditsAfter, 1);
    assert.equal(reviewAuditsAfter - reviewAuditsBefore, 1);
    assert.equal(acquisitionAuditsAfter, 0);
    assert.equal(acquisitionAuditsAfter - acquisitionAuditsBefore, 0);
    assert.equal(
      await scenario.observer.client.auditLog.count({ where: { userId: fixture.userId } }),
      totalAuditsBefore + 1
    );
    await assertHealthy(scenario, "complete");
  });
});

test("start-lock-first rejects unresolved review before queued answer review commits", {
  timeout: TEST_TIMEOUT_MS
}, async () => {
  await runScenario("commit6-start-first-review", async (scenario) => {
    const fixture = await createPendingReviewFixture(scenario, "user");
    const answer = fixture.packet.packet.answers[0];
    assert.ok(answer);
    const startPause = pauseAfter(scenario, scenario.actorA, "start-first review run lock", RUN_ROW_LOCK);
    const start = trackOperation(
      scenario,
      fillService(startPause.hooks.prismaClient).acquireFillAttempt({
        userId: fixture.userId,
        runId: fixture.runId,
        expectedStateVersion: fixture.packet.stateVersion
      })
    );
    await startPause.reached.wait();
    const review = trackOperation(
      scenario,
      runService(scenario.actorB.client).reviewApplicationRunAnswer({
        userId: fixture.userId,
        runId: fixture.runId,
        answerId: answer.id,
        status: "APPROVED",
        answerPacketVersion: fixture.packet.packetVersion
      })
    );
    await assertObservedWait(scenario, scenario.actorB, scenario.actorA);

    startPause.release.resolve();
    const [startSettled, reviewSettled] = await settlePair(start, review, "start lock before answer review");
    assertPublicError(rejected(startSettled, scenario.actorA, "start from unresolved review"), 409, "FILL_REVIEW_REQUIRED");
    const reviewed = fulfilled(reviewSettled, scenario.actorB, "queued answer review");
    assert.equal(reviewed.status, "APPROVED");
    startPause.hooks.assertExpectedHooksReached();

    const run = await scenario.observer.client.applicationRun.findUniqueOrThrow({ where: { id: fixture.runId } });
    assert.equal(run.state, "REVIEW_REQUIRED");
    assert.equal(run.stateVersion, fixture.packet.stateVersion);
    assert.equal(run.fillAttemptId, null);
    assert.equal(run.fillLeaseExpiresAt, null);
    assert.equal(await scenario.observer.client.applicationRunStep.count({ where: { runId: fixture.runId } }), 0);
    assert.equal(await actionCount(scenario, fixture, "application-run-fill-attempt.acquire"), 0);
    assert.equal(await actionCount(scenario, fixture, "application-run-answer.review"), 1);
    await assertHealthy(scenario, "complete");
  });
});

test("review-resolution-first makes a same-version queued start fail stale without acquisition", {
  timeout: TEST_TIMEOUT_MS
}, async () => {
  await runScenario("commit6-resolution-first-start", async (scenario) => {
    const fixture = await createApprovedReviewFixture(scenario, "user");
    const baselineEvents = await eventCount(scenario, fixture);
    const resolutionPause = pauseAfter(
      scenario,
      scenario.actorA,
      "resolution-first run mutation",
      { kind: "model", model: "applicationRun", method: "updateMany" }
    );
    const resolution = trackOperation(
      scenario,
      runService(resolutionPause.hooks.prismaClient).resolveApplicationRunReview({
        userId: fixture.userId,
        runId: fixture.runId,
        stateVersion: fixture.packet.stateVersion,
        acknowledgedReviewReasons: [...REVIEW_REASONS],
        answerPacketVersion: fixture.packet.packetVersion,
        packetHash: fixture.packet.packetHash
      })
    );
    await resolutionPause.reached.wait();
    const start = trackOperation(
      scenario,
      fillService(scenario.actorB.client).acquireFillAttempt({
        userId: fixture.userId,
        runId: fixture.runId,
        expectedStateVersion: fixture.packet.stateVersion
      })
    );
    await assertObservedWait(scenario, scenario.actorB, scenario.actorA);

    resolutionPause.release.resolve();
    const [resolutionSettled, startSettled] = await settlePair(
      resolution,
      start,
      "review resolution before Fill start"
    );
    const resolved = fulfilled(resolutionSettled, scenario.actorA, "review resolution first");
    assert.equal(resolved.state, "READY");
    assertPublicError(rejected(startSettled, scenario.actorB, "stale queued start"), 409, "FILL_STALE");
    resolutionPause.hooks.assertExpectedHooksReached();

    const run = await scenario.observer.client.applicationRun.findUniqueOrThrow({ where: { id: fixture.runId } });
    assert.equal(run.state, "READY");
    assert.equal(run.stateVersion, fixture.packet.stateVersion + 1);
    assert.equal(run.fillAttemptId, null);
    assert.equal(run.fillLeaseExpiresAt, null);
    assert.equal(await scenario.observer.client.applicationRunStep.count({ where: { runId: fixture.runId } }), 0);
    assert.equal(await actionCount(scenario, fixture, "application-run-fill-attempt.acquire"), 0);
    assert.equal(await actionCount(scenario, fixture, "application-run.review.resolve"), 1);
    assert.equal(await eventCount(scenario, fixture), baselineEvents + 1);
    await assertHealthy(scenario, "complete");
  });
});

test("start-lock-first rejects REVIEW_REQUIRED before queued review resolution restores READY", {
  timeout: TEST_TIMEOUT_MS
}, async () => {
  await runScenario("commit6-start-first-resolution", async (scenario) => {
    const fixture = await createApprovedReviewFixture(scenario, "user");
    const baselineEvents = await eventCount(scenario, fixture);
    const startPause = pauseAfter(scenario, scenario.actorA, "start-first resolution run lock", RUN_ROW_LOCK);
    const start = trackOperation(
      scenario,
      fillService(startPause.hooks.prismaClient).acquireFillAttempt({
        userId: fixture.userId,
        runId: fixture.runId,
        expectedStateVersion: fixture.packet.stateVersion
      })
    );
    await startPause.reached.wait();
    const resolution = trackOperation(
      scenario,
      runService(scenario.actorB.client).resolveApplicationRunReview({
        userId: fixture.userId,
        runId: fixture.runId,
        stateVersion: fixture.packet.stateVersion,
        acknowledgedReviewReasons: [...REVIEW_REASONS],
        answerPacketVersion: fixture.packet.packetVersion,
        packetHash: fixture.packet.packetHash
      })
    );
    await assertObservedWait(scenario, scenario.actorB, scenario.actorA);

    startPause.release.resolve();
    const [startSettled, resolutionSettled] = await settlePair(
      start,
      resolution,
      "Fill start lock before review resolution"
    );
    assertPublicError(rejected(startSettled, scenario.actorA, "start from review-required"), 409, "FILL_REVIEW_REQUIRED");
    const resolved = fulfilled(resolutionSettled, scenario.actorB, "queued review resolution");
    assert.equal(resolved.state, "READY");
    startPause.hooks.assertExpectedHooksReached();

    const run = await scenario.observer.client.applicationRun.findUniqueOrThrow({ where: { id: fixture.runId } });
    assert.equal(run.state, "READY");
    assert.equal(run.stateVersion, fixture.packet.stateVersion + 1);
    assert.equal(run.fillAttemptId, null);
    assert.equal(run.fillLeaseExpiresAt, null);
    assert.equal(await scenario.observer.client.applicationRunStep.count({ where: { runId: fixture.runId } }), 0);
    assert.equal(await actionCount(scenario, fixture, "application-run-fill-attempt.acquire"), 0);
    assert.equal(await actionCount(scenario, fixture, "application-run.review.resolve"), 1);
    assert.equal(await eventCount(scenario, fixture), baselineEvents + 1);
    await assertHealthy(scenario, "complete");
  });
});

test("policy-disable-first makes queued Fill acquisition fail closed without persistence", {
  timeout: TEST_TIMEOUT_MS
}, async () => {
  await runScenario("commit6-policy-first-start", async (scenario) => {
    const fixture = await createReadyFixture(scenario, "user");
    const baselineEvents = await eventCount(scenario, fixture);
    const policyPause = pauseAfter(
      scenario,
      scenario.actorA,
      "policy-disable-first mutation",
      { kind: "model", model: "applicationAutomationPolicy", method: "update" }
    );
    const policyChange = trackOperation(
      scenario,
      runService(policyPause.hooks.prismaClient).updateAutomationPolicy(fixture.userId, { enabled: false })
    );
    await policyPause.reached.wait();
    const start = trackOperation(
      scenario,
      fillService(scenario.actorB.client).acquireFillAttempt({
        userId: fixture.userId,
        runId: fixture.runId,
        expectedStateVersion: fixture.stateVersion
      })
    );
    await assertObservedWait(scenario, scenario.actorB, scenario.actorA);

    policyPause.release.resolve();
    const [policySettled, startSettled] = await settlePair(
      policyChange,
      start,
      "policy disable before Fill acquisition"
    );
    const policy = fulfilled(policySettled, scenario.actorA, "policy disable first");
    assert.equal(policy.enabled, false);
    assert.equal(policy.changed, true);
    assertPublicError(rejected(startSettled, scenario.actorB, "queued denied acquisition"), 403, "FILL_POLICY_DENIED");
    policyPause.hooks.assertExpectedHooksReached();

    const run = await scenario.observer.client.applicationRun.findUniqueOrThrow({ where: { id: fixture.runId } });
    const persistedPolicy = await scenario.observer.client.applicationAutomationPolicy.findUniqueOrThrow({
      where: { userId: fixture.userId }
    });
    assert.equal(persistedPolicy.enabled, false);
    assert.equal(persistedPolicy.mode, "FILL_AND_REVIEW");
    assert.equal(run.state, "READY");
    assert.equal(run.stateVersion, fixture.stateVersion);
    assert.equal(run.fillAttemptId, null);
    assert.equal(run.fillLeaseExpiresAt, null);
    assert.equal(await scenario.observer.client.applicationRunStep.count({ where: { runId: fixture.runId } }), 0);
    assert.equal(await actionCount(scenario, fixture, "application-run-fill-attempt.acquire"), 0);
    assert.equal(await actionCount(scenario, fixture, "application-automation-policy.update"), 1);
    assert.equal(await eventCount(scenario, fixture), baselineEvents);
    await assertHealthy(scenario, "complete");
  });
});

test("Fill-acquisition-first retains its attempt when queued policy disable commits", {
  timeout: TEST_TIMEOUT_MS
}, async () => {
  await runScenario("commit6-start-first-policy", async (scenario) => {
    const fixture = await createReadyFixture(scenario, "user");
    const attemptId = randomUUID();
    const startPause = pauseAfter(
      scenario,
      scenario.actorA,
      "start-first policy run mutation",
      { kind: "model", model: "applicationRun", method: "updateMany" }
    );
    const start = trackOperation(
      scenario,
      fillService(startPause.hooks.prismaClient, attemptId).acquireFillAttempt({
        userId: fixture.userId,
        runId: fixture.runId,
        expectedStateVersion: fixture.stateVersion
      })
    );
    await startPause.reached.wait();
    const policyChange = trackOperation(
      scenario,
      runService(scenario.actorB.client).updateAutomationPolicy(fixture.userId, { enabled: false })
    );
    await assertObservedWait(scenario, scenario.actorB, scenario.actorA);

    startPause.release.resolve();
    const [startSettled, policySettled] = await settlePair(
      start,
      policyChange,
      "Fill acquisition before policy disable"
    );
    const acquired = fulfilled(startSettled, scenario.actorA, "acquisition before policy disable");
    const policy = fulfilled(policySettled, scenario.actorB, "queued policy disable");
    assert.equal(acquired.attemptId, attemptId);
    assert.equal(policy.enabled, false);
    startPause.hooks.assertExpectedHooksReached();

    const run = await scenario.observer.client.applicationRun.findUniqueOrThrow({ where: { id: fixture.runId } });
    const persistedPolicy = await scenario.observer.client.applicationAutomationPolicy.findUniqueOrThrow({
      where: { userId: fixture.userId }
    });
    assert.equal(run.state, "FILLING");
    assert.equal(run.stateVersion, fixture.stateVersion + 1);
    assert.equal(run.fillAttemptId, attemptId);
    assert.equal(run.fillLeaseExpiresAt?.getTime(), acquired.leaseExpiresAt.getTime());
    assert.equal(persistedPolicy.enabled, false);
    const statusReader = repeatableReadFillService(scenario.observer);
    const status = await statusReader.service.getFillAttemptStatus({
      userId: fixture.userId,
      runId: fixture.runId
    });
    statusReader.controlled.assertExpectedHooksReached();
    assert.equal(status.state, "FILLING");
    assert.equal(status.fillAttemptId, attemptId);
    assert.equal(status.leaseLive, true);
    assert.equal(status.fieldOperationAllowed, false);
    assert.equal(await actionCount(scenario, fixture, "application-run-fill-attempt.acquire"), 1);
    assert.equal(await actionCount(scenario, fixture, "application-automation-policy.update"), 1);
    await assertHealthy(scenario, "complete");
  });
});

test("Fill-acquisition-first excludes queued material reinspection from FILLING", {
  timeout: TEST_TIMEOUT_MS
}, async () => {
  await runScenario("commit6-start-first-material", async (scenario) => {
    const fixture = await createReadyFixture(scenario, "user");
    const baselineEvents = await eventCount(scenario, fixture);
    const publicationAuditsBefore = await actionCount(
      scenario,
      fixture,
      "application-run-answer-packet.publish"
    );
    const acquisitionAuditsBefore = await actionCount(
      scenario,
      fixture,
      "application-run-fill-attempt.acquire"
    );
    const totalAuditsBefore = await scenario.observer.client.auditLog.count({
      where: { userId: fixture.userId }
    });
    assert.equal(acquisitionAuditsBefore, 0);
    const attemptId = randomUUID();
    const packetCountBefore = await scenario.observer.client.applicationRunAnswerPacket.count({
      where: { runId: fixture.runId }
    });
    const inspectionCountBefore = await scenario.observer.client.applicationRunFormInspection.count({
      where: { runId: fixture.runId }
    });
    const startPause = pauseAfter(
      scenario,
      scenario.actorA,
      "start-first material run mutation",
      { kind: "model", model: "applicationRun", method: "updateMany" }
    );
    const start = trackOperation(
      scenario,
      fillService(startPause.hooks.prismaClient, attemptId).acquireFillAttempt({
        userId: fixture.userId,
        runId: fixture.runId,
        expectedStateVersion: fixture.stateVersion
      })
    );
    await startPause.reached.wait();
    const material = trackOperation(
      scenario,
      publishPacket(fixture, scenario.actorB, {
        stateVersion: fixture.stateVersion,
        inspectionVersion: fixture.packet.inspectionVersion,
        packetVersion: fixture.packet.packetVersion,
        variant: "start-first-material"
      })
    );
    await assertObservedWait(scenario, scenario.actorB, scenario.actorA);

    startPause.release.resolve();
    const [startSettled, materialSettled] = await settlePair(start, material, "Fill acquisition before material reinspection");
    const acquired = fulfilled(startSettled, scenario.actorA, "acquisition before material publication");
    assertPublicError(rejected(materialSettled, scenario.actorB, "queued material publication"), 409, "RUN_INVALID_STATE");
    assert.equal(acquired.attemptId, attemptId);
    startPause.hooks.assertExpectedHooksReached();

    const run = await scenario.observer.client.applicationRun.findUniqueOrThrow({ where: { id: fixture.runId } });
    assert.equal(run.state, "FILLING");
    assert.equal(run.stateVersion, fixture.stateVersion + 1);
    assert.equal(run.fillAttemptId, attemptId);
    assert.ok(run.fillLeaseExpiresAt instanceof Date);
    assert.equal(run.fillLeaseExpiresAt.getTime(), acquired.leaseExpiresAt.getTime());
    assert.equal(run.currentFormInspectionVersion, fixture.packet.inspectionVersion);
    assert.equal(run.currentAnswerPacketVersion, fixture.packet.packetVersion);
    assert.equal(await scenario.observer.client.applicationRunFormInspection.count({ where: { runId: fixture.runId } }), inspectionCountBefore);
    assert.equal(await scenario.observer.client.applicationRunAnswerPacket.count({ where: { runId: fixture.runId } }), packetCountBefore);
    const publicationAuditsAfter = await actionCount(
      scenario,
      fixture,
      "application-run-answer-packet.publish"
    );
    const acquisitionAuditsAfter = await actionCount(
      scenario,
      fixture,
      "application-run-fill-attempt.acquire"
    );
    assert.equal(publicationAuditsAfter - publicationAuditsBefore, 0);
    assert.equal(acquisitionAuditsAfter, 1);
    assert.equal(acquisitionAuditsAfter - acquisitionAuditsBefore, 1);
    assert.equal(
      await scenario.observer.client.auditLog.count({ where: { userId: fixture.userId } }),
      totalAuditsBefore + 1
    );
    assert.equal(await eventCount(scenario, fixture), baselineEvents);
    await assertHealthy(scenario, "complete");
  });
});

test("material-reinspection-first moves READY to REVIEW_REQUIRED and rejects queued Fill", {
  timeout: TEST_TIMEOUT_MS
}, async () => {
  await runScenario("commit6-material-first-start", async (scenario) => {
    const fixture = await createReadyFixture(scenario, "user");
    const baselineEvents = await eventCount(scenario, fixture);
    const materialPause = pauseAfter(
      scenario,
      scenario.actorA,
      "material-first run mutation",
      { kind: "model", model: "applicationRun", method: "updateMany" }
    );
    const material = trackOperation(
      scenario,
      packetService(materialPause.hooks.prismaClient).publishFormInspectionAndAnswerPacket({
        userId: fixture.userId,
        runId: fixture.runId,
        expectedStateVersion: fixture.stateVersion,
        expectedFormInspectionVersion: fixture.packet.inspectionVersion,
        expectedAnswerPacketVersion: fixture.packet.packetVersion,
        observedUrl: `${fixture.applyUrl}#material-first-start`,
        inspectionReport: formReport("material-first-start")
      })
    );
    await materialPause.reached.wait();
    const start = trackOperation(
      scenario,
      fillService(scenario.actorB.client).acquireFillAttempt({
        userId: fixture.userId,
        runId: fixture.runId,
        expectedStateVersion: fixture.stateVersion
      })
    );
    await assertObservedWait(scenario, scenario.actorB, scenario.actorA);

    materialPause.release.resolve();
    const [materialSettled, startSettled] = await settlePair(material, start, "material reinspection before Fill acquisition");
    const published = fulfilled(materialSettled, scenario.actorA, "material publication first");
    assert.equal(published.replayed, false);
    assertPublicError(rejected(startSettled, scenario.actorB, "queued Fill after material publication"), 409, "FILL_REVIEW_REQUIRED");
    materialPause.hooks.assertExpectedHooksReached();

    const run = await scenario.observer.client.applicationRun.findUniqueOrThrow({ where: { id: fixture.runId } });
    const currentPacket = await scenario.observer.client.applicationRunAnswerPacket.findUniqueOrThrow({
      where: { runId_version: { runId: fixture.runId, version: published.packetVersion } }
    });
    assert.equal(run.state, "REVIEW_REQUIRED");
    assert.equal(run.stateVersion, fixture.stateVersion + 1);
    assert.equal(run.fillAttemptId, null);
    assert.equal(run.fillLeaseExpiresAt, null);
    assert.equal(run.currentFormInspectionVersion, published.inspectionVersion);
    assert.equal(run.currentAnswerPacketVersion, published.packetVersion);
    assert.equal(currentPacket.reviewedAt, null);
    assert.equal(await scenario.observer.client.applicationRunStep.count({ where: { runId: fixture.runId } }), 0);
    assert.equal(await actionCount(scenario, fixture, "application-run-fill-attempt.acquire"), 0);
    assert.equal(await actionCount(scenario, fixture, "application-run-answer-packet.publish"), 2);
    assert.equal(await eventCount(scenario, fixture), baselineEvents + 1);
    await assertHealthy(scenario, "complete");
  });
});

test("cancellation-first clears READY authority and makes queued Fill start stale", {
  timeout: TEST_TIMEOUT_MS
}, async () => {
  await runScenario("commit6-cancel-first-start", async (scenario) => {
    const fixture = await createReadyFixture(scenario, "user");
    const baselineEvents = await eventCount(scenario, fixture);
    const cancelPause = pauseAfter(
      scenario,
      scenario.actorA,
      "cancel-first run mutation",
      { kind: "model", model: "applicationRun", method: "updateMany" }
    );
    const cancellation = trackOperation(
      scenario,
      runService(cancelPause.hooks.prismaClient).cancelApplicationRun({
        userId: fixture.userId,
        runId: fixture.runId
      })
    );
    await cancelPause.reached.wait();
    const start = trackOperation(
      scenario,
      fillService(scenario.actorB.client).acquireFillAttempt({
        userId: fixture.userId,
        runId: fixture.runId,
        expectedStateVersion: fixture.stateVersion
      })
    );
    await assertObservedWait(scenario, scenario.actorB, scenario.actorA);

    cancelPause.release.resolve();
    const [cancelSettled, startSettled] = await settlePair(cancellation, start, "cancellation before Fill acquisition");
    const cancelled = fulfilled(cancelSettled, scenario.actorA, "cancellation first");
    assert.equal(cancelled.run.state, "CANCELLED");
    assertPublicError(rejected(startSettled, scenario.actorB, "queued stale Fill start"), 409, "FILL_STALE");
    cancelPause.hooks.assertExpectedHooksReached();

    const run = await scenario.observer.client.applicationRun.findUniqueOrThrow({ where: { id: fixture.runId } });
    assert.equal(run.state, "CANCELLED");
    assert.equal(run.stateVersion, fixture.stateVersion + 1);
    assert.equal(run.fillAttemptId, null);
    assert.equal(run.fillLeaseExpiresAt, null);
    assert.equal(await scenario.observer.client.applicationRunStep.count({ where: { runId: fixture.runId } }), 0);
    assert.equal(await actionCount(scenario, fixture, "application-run-fill-attempt.acquire"), 0);
    assert.equal(await actionCount(scenario, fixture, "application-run.cancel"), 1);
    assert.equal(await eventCount(scenario, fixture), baselineEvents + 1);
    await assertHealthy(scenario, "complete");
  });
});

test("Fill-acquisition-first permits queued cancellation while retaining the permanent attempt", {
  timeout: TEST_TIMEOUT_MS
}, async () => {
  await runScenario("commit6-start-first-cancel", async (scenario) => {
    const fixture = await createReadyFixture(scenario, "user");
    const baselineEvents = await eventCount(scenario, fixture);
    const attemptId = randomUUID();
    const startPause = pauseAfter(
      scenario,
      scenario.actorA,
      "start-first cancellation run mutation",
      { kind: "model", model: "applicationRun", method: "updateMany" }
    );
    const start = trackOperation(
      scenario,
      fillService(startPause.hooks.prismaClient, attemptId).acquireFillAttempt({
        userId: fixture.userId,
        runId: fixture.runId,
        expectedStateVersion: fixture.stateVersion
      })
    );
    await startPause.reached.wait();
    const cancellation = trackOperation(
      scenario,
      runService(scenario.actorB.client).cancelApplicationRun({
        userId: fixture.userId,
        runId: fixture.runId
      })
    );
    await assertObservedWait(scenario, scenario.actorB, scenario.actorA);

    startPause.release.resolve();
    const [startSettled, cancelSettled] = await settlePair(start, cancellation, "Fill acquisition before cancellation");
    const acquired = fulfilled(startSettled, scenario.actorA, "acquisition before cancellation");
    const cancelled = fulfilled(cancelSettled, scenario.actorB, "queued cancellation");
    assert.equal(acquired.attemptId, attemptId);
    assert.equal(cancelled.run.state, "CANCELLED");
    startPause.hooks.assertExpectedHooksReached();

    const run = await scenario.observer.client.applicationRun.findUniqueOrThrow({ where: { id: fixture.runId } });
    const steps = await scenario.observer.client.applicationRunStep.findMany({
      where: { runId: fixture.runId, userId: fixture.userId },
      orderBy: { sequence: "asc" }
    });
    assert.equal(run.state, "CANCELLED");
    assert.equal(run.stateVersion, fixture.stateVersion + 2);
    assert.equal(run.fillAttemptId, attemptId);
    assert.equal(run.fillLeaseExpiresAt, null);
    assert.equal(steps.length, acquired.eligibleFields.length);
    assert.ok(steps.every((step) => step.status === "PENDING" && step.redactedValueSummary === null));
    assert.equal(await actionCount(scenario, fixture, "application-run-fill-attempt.acquire"), 1);
    assert.equal(await actionCount(scenario, fixture, "application-run.cancel"), 1);
    assert.equal(await eventCount(scenario, fixture), baselineEvents + 1);
    const statusReader = repeatableReadFillService(scenario.observer);
    const status = await statusReader.service.getFillAttemptStatus({ userId: fixture.userId, runId: fixture.runId });
    statusReader.controlled.assertExpectedHooksReached();
    assert.deepEqual(status, {
      state: "CANCELLED",
      stateVersion: fixture.stateVersion + 2,
      fillAttemptId: attemptId,
      fillLeaseExpiresAt: null,
      leaseLive: false,
      expiredRecoveryRequired: false,
      fieldOperationAllowed: false,
      outcome: null,
      errorCode: null,
      steps: []
    });
    await assertHealthy(scenario, "complete");
  });
});

test("FINALIZE-first persists one terminal step set before queued cancellation", {
  timeout: TEST_TIMEOUT_MS
}, async () => {
  await runScenario("commit6-finalize-first-cancel", async (scenario) => {
    const fixture = await createFillingFixture(scenario, "user");
    const baselineEvents = await eventCount(scenario, fixture);
    const finalizePause = pauseAfter(
      scenario,
      scenario.actorA,
      "finalize-first run mutation",
      { kind: "model", model: "applicationRun", method: "updateMany" }
    );
    const finalization = trackOperation(
      scenario,
      fillService(finalizePause.hooks.prismaClient).finalizeFillAttempt({
        userId: fixture.userId,
        runId: fixture.runId,
        fillAttemptId: fixture.fillAttemptId,
        expectedStateVersion: fixture.fillingStateVersion,
        outcome: "COMPLETED",
        errorCode: null,
        steps: fixture.stepKeys.map((stepKey) => ({
          stepKey,
          result: "FILLED" as const,
          errorCode: null
        }))
      })
    );
    await finalizePause.reached.wait();
    const cancellation = trackOperation(
      scenario,
      runService(scenario.actorB.client).cancelApplicationRun({
        userId: fixture.userId,
        runId: fixture.runId
      })
    );
    await assertObservedWait(scenario, scenario.actorB, scenario.actorA);

    finalizePause.release.resolve();
    const [finalizeSettled, cancelSettled] = await settlePair(
      finalization,
      cancellation,
      "FINALIZE before cancellation"
    );
    const finalized = fulfilled(finalizeSettled, scenario.actorA, "FINALIZE first");
    const cancelled = fulfilled(cancelSettled, scenario.actorB, "queued cancellation after FINALIZE");
    assert.equal(finalized.state, "READY_FOR_USER_SUBMISSION");
    assert.equal(cancelled.run.state, "CANCELLED");
    finalizePause.hooks.assertExpectedHooksReached();

    const run = await scenario.observer.client.applicationRun.findUniqueOrThrow({ where: { id: fixture.runId } });
    const steps = await scenario.observer.client.applicationRunStep.findMany({
      where: { runId: fixture.runId, userId: fixture.userId },
      orderBy: { sequence: "asc" }
    });
    assert.equal(run.state, "CANCELLED");
    assert.equal(run.stateVersion, fixture.fillingStateVersion + 2);
    assert.equal(run.fillAttemptId, fixture.fillAttemptId);
    assert.equal(run.fillLeaseExpiresAt, null);
    assert.equal(run.errorCategory, null);
    assert.deepEqual(steps.map((step) => ({
      stepKey: step.stepKey,
      status: step.status,
      result: step.redactedValueSummary,
      error: step.errorCategory
    })), fixture.stepKeys.map((stepKey) => ({
      stepKey,
      status: "SUCCEEDED",
      result: "FILLED",
      error: null
    })));
    assert.ok(steps.every((step) => step.completedAt instanceof Date));
    assert.equal(await actionCount(scenario, fixture, "application-run-fill-attempt.finalize"), 1);
    assert.equal(await actionCount(scenario, fixture, "application-run.cancel"), 1);
    assert.equal(await eventCount(scenario, fixture), baselineEvents + 1);
    await assertHealthy(scenario, "complete");
  });
});

test("cancellation-first leaves pending Fill steps untouched and makes queued FINALIZE stale", {
  timeout: TEST_TIMEOUT_MS
}, async () => {
  await runScenario("commit6-cancel-first-finalize", async (scenario) => {
    const fixture = await createFillingFixture(scenario, "user");
    const baselineEvents = await eventCount(scenario, fixture);
    const cancelPause = pauseAfter(
      scenario,
      scenario.actorA,
      "cancel-first finalize run mutation",
      { kind: "model", model: "applicationRun", method: "updateMany" }
    );
    const cancellation = trackOperation(
      scenario,
      runService(cancelPause.hooks.prismaClient).cancelApplicationRun({
        userId: fixture.userId,
        runId: fixture.runId
      })
    );
    await cancelPause.reached.wait();
    const finalization = trackOperation(
      scenario,
      fillService(scenario.actorB.client).finalizeFillAttempt({
        userId: fixture.userId,
        runId: fixture.runId,
        fillAttemptId: fixture.fillAttemptId,
        expectedStateVersion: fixture.fillingStateVersion,
        outcome: "COMPLETED",
        errorCode: null,
        steps: fixture.stepKeys.map((stepKey) => ({
          stepKey,
          result: "FILLED" as const,
          errorCode: null
        }))
      })
    );
    await assertObservedWait(scenario, scenario.actorB, scenario.actorA);

    cancelPause.release.resolve();
    const [cancelSettled, finalizeSettled] = await settlePair(
      cancellation,
      finalization,
      "cancellation before FINALIZE"
    );
    const cancelled = fulfilled(cancelSettled, scenario.actorA, "cancellation first");
    assert.equal(cancelled.run.state, "CANCELLED");
    assertPublicError(rejected(finalizeSettled, scenario.actorB, "queued FINALIZE"), 409, "FILL_STALE");
    cancelPause.hooks.assertExpectedHooksReached();

    const run = await scenario.observer.client.applicationRun.findUniqueOrThrow({ where: { id: fixture.runId } });
    const steps = await scenario.observer.client.applicationRunStep.findMany({
      where: { runId: fixture.runId, userId: fixture.userId },
      orderBy: { sequence: "asc" }
    });
    assert.equal(run.state, "CANCELLED");
    assert.equal(run.stateVersion, fixture.fillingStateVersion + 1);
    assert.equal(run.fillAttemptId, fixture.fillAttemptId);
    assert.equal(run.fillLeaseExpiresAt, null);
    assert.equal(run.errorCategory, null);
    assert.deepEqual(steps.map((step) => ({
      stepKey: step.stepKey,
      status: step.status,
      result: step.redactedValueSummary,
      error: step.errorCategory,
      completedAt: step.completedAt
    })), fixture.stepKeys.map((stepKey) => ({
      stepKey,
      status: "PENDING",
      result: null,
      error: null,
      completedAt: null
    })));
    assert.equal(await actionCount(scenario, fixture, "application-run-fill-attempt.finalize"), 0);
    assert.equal(await actionCount(scenario, fixture, "application-run.cancel"), 1);
    assert.equal(await eventCount(scenario, fixture), baselineEvents + 1);
    await assertHealthy(scenario, "complete");
  });
});

async function expireFixtureLease(scenario: Scenario, fixture: FillingFixture): Promise<Date> {
  const expiredAt = new Date((await databaseClock(scenario.observer)).getTime() - 1_000);
  const updated = await scenario.observer.client.applicationRun.updateMany({
    where: {
      id: fixture.runId,
      userId: fixture.userId,
      state: "FILLING",
      stateVersion: fixture.fillingStateVersion,
      fillAttemptId: fixture.fillAttemptId
    },
    data: { fillLeaseExpiresAt: expiredAt }
  });
  assert.equal(updated.count, 1);
  return expiredAt;
}

test("RECOVER-first terminalizes unresolved steps before queued cancellation", {
  timeout: TEST_TIMEOUT_MS
}, async () => {
  await runScenario("commit6-recover-first-cancel", async (scenario) => {
    const fixture = await createFillingFixture(scenario, "user");
    const baselineEvents = await eventCount(scenario, fixture);
    await expireFixtureLease(scenario, fixture);
    const recoveryPause = pauseAfter(
      scenario,
      scenario.actorA,
      "recover-first run mutation",
      { kind: "model", model: "applicationRun", method: "updateMany" }
    );
    const recovery = trackOperation(
      scenario,
      fillService(recoveryPause.hooks.prismaClient).recoverExpiredFillAttempt({
        userId: fixture.userId,
        runId: fixture.runId,
        fillAttemptId: fixture.fillAttemptId,
        expectedStateVersion: fixture.fillingStateVersion
      })
    );
    await recoveryPause.reached.wait();
    const cancellation = trackOperation(
      scenario,
      runService(scenario.actorB.client).cancelApplicationRun({
        userId: fixture.userId,
        runId: fixture.runId
      })
    );
    await assertObservedWait(scenario, scenario.actorB, scenario.actorA);

    recoveryPause.release.resolve();
    const [recoverySettled, cancelSettled] = await settlePair(
      recovery,
      cancellation,
      "expired recovery before cancellation"
    );
    const recovered = fulfilled(recoverySettled, scenario.actorA, "RECOVER first");
    const cancelled = fulfilled(cancelSettled, scenario.actorB, "queued cancellation after RECOVER");
    assert.equal(recovered.outcome, "RECOVERED_AFTER_LOSS");
    assert.equal(cancelled.run.state, "CANCELLED");
    recoveryPause.hooks.assertExpectedHooksReached();

    const run = await scenario.observer.client.applicationRun.findUniqueOrThrow({ where: { id: fixture.runId } });
    const steps = await scenario.observer.client.applicationRunStep.findMany({
      where: { runId: fixture.runId, userId: fixture.userId },
      orderBy: { sequence: "asc" }
    });
    assert.equal(run.state, "CANCELLED");
    assert.equal(run.stateVersion, fixture.fillingStateVersion + 2);
    assert.equal(run.fillAttemptId, fixture.fillAttemptId);
    assert.equal(run.fillLeaseExpiresAt, null);
    assert.equal(run.errorCategory, "FILL_STALE");
    assert.deepEqual(steps.map((step) => ({
      stepKey: step.stepKey,
      status: step.status,
      result: step.redactedValueSummary,
      error: step.errorCategory
    })), fixture.stepKeys.map((stepKey) => ({
      stepKey,
      status: "FAILED",
      result: "FAILED",
      error: "FILL_STALE"
    })));
    assert.ok(steps.every((step) => step.completedAt instanceof Date));
    assert.equal(await actionCount(scenario, fixture, "application-run-fill-attempt.recover"), 1);
    assert.equal(await actionCount(scenario, fixture, "application-run.cancel"), 1);
    assert.equal(await eventCount(scenario, fixture), baselineEvents + 1);
    await assertHealthy(scenario, "complete");
  });
});

test("cancellation-first retains unresolved steps and makes queued RECOVER stale", {
  timeout: TEST_TIMEOUT_MS
}, async () => {
  await runScenario("commit6-cancel-first-recover", async (scenario) => {
    const fixture = await createFillingFixture(scenario, "user");
    const baselineEvents = await eventCount(scenario, fixture);
    await expireFixtureLease(scenario, fixture);
    const cancelPause = pauseAfter(
      scenario,
      scenario.actorA,
      "cancel-first recovery run mutation",
      { kind: "model", model: "applicationRun", method: "updateMany" }
    );
    const cancellation = trackOperation(
      scenario,
      runService(cancelPause.hooks.prismaClient).cancelApplicationRun({
        userId: fixture.userId,
        runId: fixture.runId
      })
    );
    await cancelPause.reached.wait();
    const recovery = trackOperation(
      scenario,
      fillService(scenario.actorB.client).recoverExpiredFillAttempt({
        userId: fixture.userId,
        runId: fixture.runId,
        fillAttemptId: fixture.fillAttemptId,
        expectedStateVersion: fixture.fillingStateVersion
      })
    );
    await assertObservedWait(scenario, scenario.actorB, scenario.actorA);

    cancelPause.release.resolve();
    const [cancelSettled, recoverySettled] = await settlePair(
      cancellation,
      recovery,
      "cancellation before expired recovery"
    );
    const cancelled = fulfilled(cancelSettled, scenario.actorA, "cancellation before RECOVER");
    assert.equal(cancelled.run.state, "CANCELLED");
    assertPublicError(rejected(recoverySettled, scenario.actorB, "queued RECOVER"), 409, "FILL_STALE");
    cancelPause.hooks.assertExpectedHooksReached();

    const run = await scenario.observer.client.applicationRun.findUniqueOrThrow({ where: { id: fixture.runId } });
    const steps = await scenario.observer.client.applicationRunStep.findMany({
      where: { runId: fixture.runId, userId: fixture.userId },
      orderBy: { sequence: "asc" }
    });
    assert.equal(run.state, "CANCELLED");
    assert.equal(run.stateVersion, fixture.fillingStateVersion + 1);
    assert.equal(run.fillAttemptId, fixture.fillAttemptId);
    assert.equal(run.fillLeaseExpiresAt, null);
    assert.equal(run.errorCategory, null);
    assert.ok(steps.every((step) =>
      step.status === "PENDING" &&
      step.redactedValueSummary === null &&
      step.errorCategory === null &&
      step.completedAt === null
    ));
    assert.equal(await actionCount(scenario, fixture, "application-run-fill-attempt.recover"), 0);
    assert.equal(await actionCount(scenario, fixture, "application-run.cancel"), 1);
    assert.equal(await eventCount(scenario, fixture), baselineEvents + 1);
    await assertHealthy(scenario, "complete");
  });
});

test("post-Fill material-refresh-first stales review resolution without restoring READY", {
  timeout: TEST_TIMEOUT_MS
}, async () => {
  await runScenario("commit6-refresh-first-postfill-resolution", async (scenario) => {
    const fixture = await createPostFillReviewFixture(scenario, "user");
    const baselineEvents = await eventCount(scenario, fixture);
    const packetCountBefore = await scenario.observer.client.applicationRunAnswerPacket.count({
      where: { runId: fixture.runId }
    });
    const publishAuditsBefore = await actionCount(scenario, fixture, "application-run-answer-packet.publish");
    const resolveAuditsBefore = await actionCount(scenario, fixture, "application-run.review.resolve");
    const refreshPause = pauseAfter(
      scenario,
      scenario.actorA,
      "postfill refresh-first run mutation",
      { kind: "model", model: "applicationRun", method: "updateMany" }
    );
    const refresh = trackOperation(
      scenario,
      packetService(refreshPause.hooks.prismaClient).publishFormInspectionAndAnswerPacket({
        userId: fixture.userId,
        runId: fixture.runId,
        expectedStateVersion: fixture.reviewStateVersion,
        expectedFormInspectionVersion: fixture.reviewPacket.inspectionVersion,
        expectedAnswerPacketVersion: fixture.reviewPacket.packetVersion,
        observedUrl: `${fixture.applyUrl}#postfill-refresh-first`,
        inspectionReport: formReport("postfill-refresh-first")
      })
    );
    await refreshPause.reached.wait();
    const resolution = trackOperation(
      scenario,
      runService(scenario.actorB.client).resolveApplicationRunReview({
        userId: fixture.userId,
        runId: fixture.runId,
        stateVersion: fixture.reviewStateVersion,
        acknowledgedReviewReasons: [...REVIEW_REASONS],
        answerPacketVersion: fixture.reviewPacket.packetVersion,
        packetHash: fixture.reviewPacket.packetHash
      })
    );
    await assertObservedWait(scenario, scenario.actorB, scenario.actorA);

    refreshPause.release.resolve();
    const [refreshSettled, resolutionSettled] = await settlePair(
      refresh,
      resolution,
      "post-Fill material refresh before review resolution"
    );
    const refreshed = fulfilled(refreshSettled, scenario.actorA, "post-Fill material refresh first");
    assert.equal(refreshed.replayed, false);
    assertPublicError(rejected(resolutionSettled, scenario.actorB, "stale post-Fill resolution"), 409, "RUN_PACKET_STALE");
    refreshPause.hooks.assertExpectedHooksReached();

    const run = await scenario.observer.client.applicationRun.findUniqueOrThrow({ where: { id: fixture.runId } });
    const currentPacket = await scenario.observer.client.applicationRunAnswerPacket.findUniqueOrThrow({
      where: { runId_version: { runId: fixture.runId, version: refreshed.packetVersion } }
    });
    assert.equal(run.state, "REVIEW_REQUIRED");
    assert.equal(run.stateVersion, fixture.reviewStateVersion);
    assert.equal(run.fillAttemptId, fixture.fillAttemptId);
    assert.equal(run.fillLeaseExpiresAt, null);
    assert.equal(run.currentFormInspectionVersion, refreshed.inspectionVersion);
    assert.equal(run.currentAnswerPacketVersion, refreshed.packetVersion);
    assert.equal(currentPacket.reviewedAt, null);
    assert.equal(await scenario.observer.client.applicationRunAnswerPacket.count({ where: { runId: fixture.runId } }), packetCountBefore + 1);
    assert.equal(await actionCount(scenario, fixture, "application-run-answer-packet.publish"), publishAuditsBefore + 1);
    assert.equal(await actionCount(scenario, fixture, "application-run.review.resolve"), resolveAuditsBefore);
    assert.equal(await eventCount(scenario, fixture), baselineEvents + 1);
    assert.notEqual(run.state, "READY");
    await assertHealthy(scenario, "complete");
  });
});

test("post-Fill review-resolution-first makes queued old-currentness material refresh stale", {
  timeout: TEST_TIMEOUT_MS
}, async () => {
  await runScenario("commit6-resolution-first-postfill-refresh", async (scenario) => {
    const fixture = await createPostFillReviewFixture(scenario, "user");
    const baselineEvents = await eventCount(scenario, fixture);
    const packetCountBefore = await scenario.observer.client.applicationRunAnswerPacket.count({
      where: { runId: fixture.runId }
    });
    const publishAuditsBefore = await actionCount(scenario, fixture, "application-run-answer-packet.publish");
    const resolveAuditsBefore = await actionCount(scenario, fixture, "application-run.review.resolve");
    const resolutionPause = pauseAfter(
      scenario,
      scenario.actorA,
      "postfill resolution-first run mutation",
      { kind: "model", model: "applicationRun", method: "updateMany" }
    );
    const resolution = trackOperation(
      scenario,
      runService(resolutionPause.hooks.prismaClient).resolveApplicationRunReview({
        userId: fixture.userId,
        runId: fixture.runId,
        stateVersion: fixture.reviewStateVersion,
        acknowledgedReviewReasons: [...REVIEW_REASONS],
        answerPacketVersion: fixture.reviewPacket.packetVersion,
        packetHash: fixture.reviewPacket.packetHash
      })
    );
    await resolutionPause.reached.wait();
    const refresh = trackOperation(
      scenario,
      publishPacket(fixture, scenario.actorB, {
        stateVersion: fixture.reviewStateVersion,
        inspectionVersion: fixture.reviewPacket.inspectionVersion,
        packetVersion: fixture.reviewPacket.packetVersion,
        variant: "postfill-resolution-first"
      })
    );
    await assertObservedWait(scenario, scenario.actorB, scenario.actorA);

    resolutionPause.release.resolve();
    const [resolutionSettled, refreshSettled] = await settlePair(
      resolution,
      refresh,
      "post-Fill review resolution before material refresh"
    );
    const resolved = fulfilled(resolutionSettled, scenario.actorA, "post-Fill review resolution first");
    assert.equal(resolved.state, "READY_FOR_USER_SUBMISSION");
    assertPublicError(rejected(refreshSettled, scenario.actorB, "queued stale material refresh"), 409, "RUN_LIFECYCLE_STALE");
    resolutionPause.hooks.assertExpectedHooksReached();

    const run = await scenario.observer.client.applicationRun.findUniqueOrThrow({ where: { id: fixture.runId } });
    const packet = await scenario.observer.client.applicationRunAnswerPacket.findUniqueOrThrow({
      where: { runId_version: { runId: fixture.runId, version: fixture.reviewPacket.packetVersion } }
    });
    assert.equal(run.state, "READY_FOR_USER_SUBMISSION");
    assert.equal(run.stateVersion, fixture.reviewStateVersion + 1);
    assert.equal(run.fillAttemptId, fixture.fillAttemptId);
    assert.equal(run.fillLeaseExpiresAt, null);
    assert.equal(run.currentFormInspectionVersion, fixture.reviewPacket.inspectionVersion);
    assert.equal(run.currentAnswerPacketVersion, fixture.reviewPacket.packetVersion);
    assert.ok(packet.reviewedAt instanceof Date);
    assert.equal(await scenario.observer.client.applicationRunAnswerPacket.count({ where: { runId: fixture.runId } }), packetCountBefore);
    assert.equal(await actionCount(scenario, fixture, "application-run-answer-packet.publish"), publishAuditsBefore);
    assert.equal(await actionCount(scenario, fixture, "application-run.review.resolve"), resolveAuditsBefore + 1);
    assert.equal(await eventCount(scenario, fixture), baselineEvents + 1);
    assert.notEqual(run.state, "READY");
    await assertHealthy(scenario, "complete");
  });
});

test("exact-replay-first is a true no-op before queued READY_FOR_USER_SUBMISSION cancellation", {
  timeout: TEST_TIMEOUT_MS
}, async () => {
  await runScenario("commit6-replay-first-cancel", async (scenario) => {
    const fixture = await createPostFillFixture(scenario, "user");
    const baselineEvents = await eventCount(scenario, fixture);
    const beforeRun = await scenario.observer.client.applicationRun.findUniqueOrThrow({ where: { id: fixture.runId } });
    const packetCountBefore = await scenario.observer.client.applicationRunAnswerPacket.count({ where: { runId: fixture.runId } });
    const inspectionCountBefore = await scenario.observer.client.applicationRunFormInspection.count({ where: { runId: fixture.runId } });
    const publishAuditsBefore = await actionCount(scenario, fixture, "application-run-answer-packet.publish");
    const replayPause = pauseAfter(scenario, scenario.actorA, "exact replay-first run lock", RUN_ROW_LOCK);
    const replay = trackOperation(
      scenario,
      packetService(replayPause.hooks.prismaClient).publishFormInspectionAndAnswerPacket({
        userId: fixture.userId,
        runId: fixture.runId,
        expectedStateVersion: beforeRun.stateVersion,
        expectedFormInspectionVersion: beforeRun.currentFormInspectionVersion,
        expectedAnswerPacketVersion: beforeRun.currentAnswerPacketVersion,
        observedUrl: `${fixture.applyUrl}#exact-replay-first`,
        inspectionReport: formReport("initial")
      })
    );
    await replayPause.reached.wait();
    const cancellation = trackOperation(
      scenario,
      runService(scenario.actorB.client).cancelApplicationRun({
        userId: fixture.userId,
        runId: fixture.runId
      })
    );
    await assertObservedWait(scenario, scenario.actorB, scenario.actorA);

    replayPause.release.resolve();
    const [replaySettled, cancelSettled] = await settlePair(replay, cancellation, "exact replay before cancellation");
    const replayed = fulfilled(replaySettled, scenario.actorA, "exact replay first");
    const cancelled = fulfilled(cancelSettled, scenario.actorB, "queued cancellation after replay");
    assert.equal(replayed.replayed, true);
    assert.equal(cancelled.run.state, "CANCELLED");
    replayPause.hooks.assertExpectedHooksReached();

    const run = await scenario.observer.client.applicationRun.findUniqueOrThrow({ where: { id: fixture.runId } });
    assert.equal(run.state, "CANCELLED");
    assert.equal(run.stateVersion, beforeRun.stateVersion + 1);
    assert.equal(run.fillAttemptId, fixture.fillAttemptId);
    assert.equal(run.fillLeaseExpiresAt, null);
    assert.equal(run.currentFormInspectionVersion, beforeRun.currentFormInspectionVersion);
    assert.equal(run.currentAnswerPacketVersion, beforeRun.currentAnswerPacketVersion);
    assert.equal(await scenario.observer.client.applicationRunAnswerPacket.count({ where: { runId: fixture.runId } }), packetCountBefore);
    assert.equal(await scenario.observer.client.applicationRunFormInspection.count({ where: { runId: fixture.runId } }), inspectionCountBefore);
    assert.equal(await actionCount(scenario, fixture, "application-run-answer-packet.publish"), publishAuditsBefore);
    assert.equal(await actionCount(scenario, fixture, "application-run.cancel"), 1);
    assert.equal(await eventCount(scenario, fixture), baselineEvents + 1);
    await assertHealthy(scenario, "complete");
  });
});

test("cancellation-first denies queued exact replay without stale pointer rewrite", {
  timeout: TEST_TIMEOUT_MS
}, async () => {
  await runScenario("commit6-cancel-first-replay", async (scenario) => {
    const fixture = await createPostFillFixture(scenario, "user");
    const baselineEvents = await eventCount(scenario, fixture);
    const beforeRun = await scenario.observer.client.applicationRun.findUniqueOrThrow({ where: { id: fixture.runId } });
    const packetCountBefore = await scenario.observer.client.applicationRunAnswerPacket.count({ where: { runId: fixture.runId } });
    const inspectionCountBefore = await scenario.observer.client.applicationRunFormInspection.count({ where: { runId: fixture.runId } });
    const publishAuditsBefore = await actionCount(scenario, fixture, "application-run-answer-packet.publish");
    const cancelPause = pauseAfter(
      scenario,
      scenario.actorA,
      "cancel-first exact replay run mutation",
      { kind: "model", model: "applicationRun", method: "updateMany" }
    );
    const cancellation = trackOperation(
      scenario,
      runService(cancelPause.hooks.prismaClient).cancelApplicationRun({
        userId: fixture.userId,
        runId: fixture.runId
      })
    );
    await cancelPause.reached.wait();
    const replay = trackOperation(
      scenario,
      publishPacket(fixture, scenario.actorB, {
        stateVersion: beforeRun.stateVersion,
        inspectionVersion: beforeRun.currentFormInspectionVersion,
        packetVersion: beforeRun.currentAnswerPacketVersion,
        variant: "initial"
      })
    );
    await assertObservedWait(scenario, scenario.actorB, scenario.actorA);

    cancelPause.release.resolve();
    const [cancelSettled, replaySettled] = await settlePair(cancellation, replay, "cancellation before exact replay");
    const cancelled = fulfilled(cancelSettled, scenario.actorA, "cancellation before replay");
    assert.equal(cancelled.run.state, "CANCELLED");
    assertPublicError(rejected(replaySettled, scenario.actorB, "queued exact replay"), 409, "RUN_INVALID_STATE");
    cancelPause.hooks.assertExpectedHooksReached();

    const run = await scenario.observer.client.applicationRun.findUniqueOrThrow({ where: { id: fixture.runId } });
    assert.equal(run.state, "CANCELLED");
    assert.equal(run.stateVersion, beforeRun.stateVersion + 1);
    assert.equal(run.fillAttemptId, fixture.fillAttemptId);
    assert.equal(run.fillLeaseExpiresAt, null);
    assert.equal(run.currentFormInspectionVersion, beforeRun.currentFormInspectionVersion);
    assert.equal(run.currentAnswerPacketVersion, beforeRun.currentAnswerPacketVersion);
    assert.equal(await scenario.observer.client.applicationRunAnswerPacket.count({ where: { runId: fixture.runId } }), packetCountBefore);
    assert.equal(await scenario.observer.client.applicationRunFormInspection.count({ where: { runId: fixture.runId } }), inspectionCountBefore);
    assert.equal(await actionCount(scenario, fixture, "application-run-answer-packet.publish"), publishAuditsBefore);
    assert.equal(await actionCount(scenario, fixture, "application-run.cancel"), 1);
    assert.equal(await eventCount(scenario, fixture), baselineEvents + 1);
    await assertHealthy(scenario, "complete");
  });
});

test("production GET keeps one OLD RepeatableRead relational snapshot while clock_timestamp advances", {
  timeout: TEST_TIMEOUT_MS
}, async () => {
  await runScenario("commit6-repeatable-read-status", async (scenario) => {
    const fixture = await createFillingFixture(scenario, "user");
    const leaseExpiresAt = new Date((await databaseClock(scenario.observer)).getTime() + 1_500);
    const leaseUpdate = await scenario.observer.client.applicationRun.updateMany({
      where: {
        id: fixture.runId,
        userId: fixture.userId,
        state: "FILLING",
        stateVersion: fixture.fillingStateVersion,
        fillAttemptId: fixture.fillAttemptId
      },
      data: { fillLeaseExpiresAt: leaseExpiresAt }
    });
    assert.equal(leaseUpdate.count, 1);
    const auditCountBefore = await scenario.observer.client.auditLog.count({ where: { userId: fixture.userId } });
    const eventCountBefore = await scenario.observer.client.applicationEvent.count({ where: { userId: fixture.userId } });
    const policyReadCompleted = deferred("RepeatableRead policy query completed");
    const releaseReader = trackRelease(scenario, deferred("release RepeatableRead status reader"));
    let capturedPolicy: { enabled: boolean; mode: string } | null = null;
    const readerControl = createHookedPrismaClient(
      scenario.actorA,
      [
        {
          name: "RepeatableRead transaction entry",
          match: { kind: "transaction" },
          expectedMatches: 1
        },
        {
          name: "RepeatableRead policy after-query pause",
          match: { kind: "model", model: "applicationAutomationPolicy", method: "findUnique" },
          expectedMatches: 1,
          after: async () => {
            policyReadCompleted.resolve();
            await releaseReader.wait();
          }
        }
      ],
      {
        requiredInteractiveTransactionIsolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead
      }
    );
    const capturingReader = readerControl.prismaClient.$extends({
      name: "commit6CaptureStatusPolicy",
      query: {
        applicationAutomationPolicy: {
          async findUnique({ args, query }) {
            const result = await query(args);
            capturedPolicy = result ? { enabled: result.enabled!, mode: result.mode! } : null;
            return result;
          }
        }
      }
    }) as unknown as PrismaClient;
    let readerSettled = false;
    const reader = trackOperation(
      scenario,
      fillService(capturingReader).getFillAttemptStatus({
        userId: fixture.userId,
        runId: fixture.runId
      }).finally(() => {
        readerSettled = true;
      })
    );
    await policyReadCompleted.wait();
    assert.equal(readerSettled, false);

    const writer = trackOperation(
      scenario,
      scenario.actorB.client.$transaction(async (transaction) => {
        const policy = await transaction.applicationAutomationPolicy.updateMany({
          where: { id: fixture.policyId, userId: fixture.userId, enabled: true },
          data: { enabled: false }
        });
        assert.equal(policy.count, 1);
        const run = await transaction.applicationRun.updateMany({
          where: {
            id: fixture.runId,
            userId: fixture.userId,
            state: "FILLING",
            stateVersion: fixture.fillingStateVersion,
            fillAttemptId: fixture.fillAttemptId,
            fillLeaseExpiresAt: leaseExpiresAt
          },
          data: {
            state: "CANCELLED",
            stateVersion: { increment: 1 },
            fillLeaseExpiresAt: null,
            activeRunKey: null
          }
        });
        assert.equal(run.count, 1);
      })
    );
    await withTimeout(writer, OPERATION_TIMEOUT_MS, "atomic snapshot writer commit");
    assert.equal(readerSettled, false, "writer must commit while the reader transaction remains paused");

    const expiredClock = await waitForDatabaseClockAtLeast(scenario.observer, leaseExpiresAt);
    assert.ok(expiredClock.getTime() >= leaseExpiresAt.getTime());
    assert.equal(readerSettled, false);
    releaseReader.resolve();
    const status = await withTimeout(reader, OPERATION_TIMEOUT_MS, "RepeatableRead status completion");
    readerControl.assertExpectedHooksReached();

    assert.deepEqual(capturedPolicy, { enabled: true, mode: "FILL_AND_REVIEW" });
    // A weaker READ COMMITTED service transaction could observe the writer's CANCELLED run here.
    assert.equal(status.state, "FILLING");
    assert.equal(status.stateVersion, fixture.fillingStateVersion);
    assert.equal(status.fillAttemptId, fixture.fillAttemptId);
    assert.equal(status.fillLeaseExpiresAt?.getTime(), leaseExpiresAt.getTime());
    assert.equal(status.leaseLive, false);
    assert.equal(status.expiredRecoveryRequired, true);
    assert.equal(status.fieldOperationAllowed, false);
    assert.equal(status.outcome, null);
    assert.equal(status.errorCode, null);
    assert.deepEqual(status.steps, []);

    const persistedPolicy = await scenario.observer.client.applicationAutomationPolicy.findUniqueOrThrow({
      where: { userId: fixture.userId }
    });
    const persistedRun = await scenario.observer.client.applicationRun.findUniqueOrThrow({
      where: { id: fixture.runId }
    });
    assert.equal(persistedPolicy.enabled, false);
    assert.equal(persistedRun.state, "CANCELLED");
    assert.equal(persistedRun.stateVersion, fixture.fillingStateVersion + 1);
    assert.equal(persistedRun.fillAttemptId, fixture.fillAttemptId);
    assert.equal(persistedRun.fillLeaseExpiresAt, null);
    assert.equal(await scenario.observer.client.auditLog.count({ where: { userId: fixture.userId } }), auditCountBefore);
    assert.equal(await scenario.observer.client.applicationEvent.count({ where: { userId: fixture.userId } }), eventCountBefore);
    await assertHealthy(scenario, "complete");
  });
});

test("repeated production GET with a missing policy remains strictly read only", {
  timeout: TEST_TIMEOUT_MS
}, async () => {
  await runScenario("commit6-missing-policy-status", async (scenario) => {
    const fixture = await createFixture(scenario, "user");
    await scenario.observer.client.applicationAutomationPolicy.delete({ where: { id: fixture.policyId } });
    const before = {
      policyCount: await scenario.observer.client.applicationAutomationPolicy.count({
        where: { userId: fixture.userId }
      }),
      run: await scenario.observer.client.applicationRun.findUniqueOrThrow({ where: { id: fixture.runId } }),
      steps: await scenario.observer.client.applicationRunStep.findMany({
        where: { runId: fixture.runId, userId: fixture.userId },
        orderBy: [{ sequence: "asc" }, { id: "asc" }]
      }),
      audits: await scenario.observer.client.auditLog.findMany({
        where: { userId: fixture.userId },
        orderBy: { id: "asc" }
      }),
      events: await scenario.observer.client.applicationEvent.findMany({
        where: { userId: fixture.userId, applicationId: fixture.applicationId },
        orderBy: { id: "asc" }
      })
    };
    assert.equal(before.policyCount, 0);
    const statusReader = repeatableReadFillService(scenario.actorA, [{
      name: "missing-policy RepeatableRead GET transactions",
      match: { kind: "transaction" },
      expectedMatches: 3
    }]);
    const responses = [];
    for (let index = 0; index < 3; index += 1) {
      responses.push(await statusReader.service.getFillAttemptStatus({
        userId: fixture.userId,
        runId: fixture.runId
      }));
    }
    statusReader.controlled.assertExpectedHooksReached();
    assert.equal(responses.length, 3);
    for (const status of responses) {
      assert.equal(status.state, "READY");
      assert.equal(status.stateVersion, INITIAL_STATE_VERSION);
      assert.equal(status.fillAttemptId, null);
      assert.equal(status.fillLeaseExpiresAt, null);
      assert.equal(status.leaseLive, false);
      assert.equal(status.expiredRecoveryRequired, false);
      assert.equal(status.fieldOperationAllowed, false);
      assert.equal(status.outcome, null);
      assert.equal(status.errorCode, null);
      assert.deepEqual(status.steps, []);
    }

    const after = {
      policyCount: await scenario.observer.client.applicationAutomationPolicy.count({
        where: { userId: fixture.userId }
      }),
      run: await scenario.observer.client.applicationRun.findUniqueOrThrow({ where: { id: fixture.runId } }),
      steps: await scenario.observer.client.applicationRunStep.findMany({
        where: { runId: fixture.runId, userId: fixture.userId },
        orderBy: [{ sequence: "asc" }, { id: "asc" }]
      }),
      audits: await scenario.observer.client.auditLog.findMany({
        where: { userId: fixture.userId },
        orderBy: { id: "asc" }
      }),
      events: await scenario.observer.client.applicationEvent.findMany({
        where: { userId: fixture.userId, applicationId: fixture.applicationId },
        orderBy: { id: "asc" }
      })
    };
    assert.equal(after.policyCount, 0);
    assert.deepEqual(after.run, before.run);
    assert.deepEqual(after.steps, before.steps);
    assert.deepEqual(after.audits, before.audits);
    assert.deepEqual(after.events, before.events);
    await assertHealthy(scenario, "complete");
  });
});
