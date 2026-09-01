import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import { Prisma } from "@prisma/client";

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
