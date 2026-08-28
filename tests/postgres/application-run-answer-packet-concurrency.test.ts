import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "node:test";

import { PublicApiError } from "@/lib/api-errors";
import {
  createApplicationRunAnswerPacketService
} from "@/lib/application-runs/answer-packet-service";
import { computeApplicationAnswerProposalHash } from "@/lib/application-runs/answer-packet-domain";
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
  lateFailureSentinel,
  waitForActorLockWait,
  withTimeout,
  type Deferred,
  type HookedPrismaClient,
  type PostgresTestActor,
  type PrismaOperationHook
} from "@/tests/postgres/postgres-test-harness";

const TEST_TIMEOUT_MS = 30_000;
const PAIR_TIMEOUT_MS = 12_000;
const CLEANUP_TIMEOUT_MS = 5_000;
const APPLY_HOST = "jobs.example.test";
const AUTOMATION_ENV = { APPLICATION_AUTOMATION_ENABLED: "true" } as const;
const REVIEW_REASONS = ["evidence_gaps_present"] as const;

const RUN_ROW_LOCK = {
  kind: "queryRaw",
  includes: ['FROM "ApplicationRun"', "FOR UPDATE"]
} as const;

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
type CleanupPhaseResult<T> = { ok: true; value: T } | { ok: false };

type Fixture = {
  userId: string;
  applicationId: string;
  runId: string;
  vaultId: string;
  applyUrl: string;
};

type PacketResult = Awaited<ReturnType<ReturnType<typeof createApplicationRunAnswerPacketService>["publishFormInspectionAndAnswerPacket"]>>;
type PacketRead = Awaited<ReturnType<ReturnType<typeof createApplicationRunAnswerPacketService>["getCurrentAnswerPacket"]>>;

type RecordCounts = {
  totalAudits: number;
  totalEvents: number;
  publishAudits: number;
  revokeAudits: number;
  reviewAudits: number;
  resolveAudits: number;
  preparedEvents: number;
  updatedEvents: number;
  resolvedEvents: number;
};

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function formReport(required: boolean) {
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

function trackRelease(scenario: Scenario, release: Deferred<void>): Deferred<void> {
  scenario.releases.push(release);
  return release;
}

function trackOperation<T>(scenario: Scenario, operation: Promise<T>): Promise<T> {
  scenario.operations.push(operation);
  return operation;
}

async function captureCleanupPhase<T>(
  failures: CleanupFailure[],
  phase: string,
  action: () => Promise<T>
): Promise<CleanupPhaseResult<T>> {
  try {
    return { ok: true, value: await action() };
  } catch (error) {
    failures.push({ phase, error });
    return { ok: false };
  }
}

function throwCleanupOutcome(primary: CapturedFailure, failures: CleanupFailure[]): void {
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
            failures.map(({ phase }) => new Error(`Secondary F5 cleanup phase failed: ${phase}.`)),
            "One or more secondary F5 cleanup phases failed."
          ),
          configurable: true
        });
      } catch {
        // The original scenario failure remains authoritative.
      }
    }
    throw primary.error;
  }
  if (failures.length > 0) throw failures[0].error;
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
    operationsSettled = (await captureCleanupPhase(failures, "operation-settlement", () =>
      withTimeout(settlement, CLEANUP_TIMEOUT_MS, `${scenario.label} operation cleanup`)
    )).ok;
  }

  let observerHealthy = (await captureCleanupPhase(failures, "observer-pin", () =>
    assertActorSessionPinned(scenario.observer, `${scenario.label}-cleanup-observer`)
  )).ok;
  const competitors = [scenario.actorA, scenario.actorB] as const;
  const competitorsToStop = new Set<PostgresTestActor>();
  if (!operationsSettled) {
    for (const actor of competitors) competitorsToStop.add(actor);
  }

  for (const actor of competitors) {
    if (observerHealthy) {
      const idle = await captureCleanupPhase(failures, `${actor.actorName}-idle`, () =>
        assertNoIdleTransactions(scenario.observer, [actor])
      );
      if (!idle.ok) {
        competitorsToStop.add(actor);
        observerHealthy = (await captureCleanupPhase(failures, "observer-repin", () =>
          assertActorSessionPinned(scenario.observer, `${scenario.label}-cleanup-observer-repin`)
        )).ok;
      }
    }
    const pinned = await captureCleanupPhase(failures, `${actor.actorName}-pin`, () =>
      assertActorSessionPinned(actor, `${scenario.label}-cleanup-${actor.actorName}`)
    );
    if (!pinned.ok) competitorsToStop.add(actor);
  }

  const earlyDisconnectAttempted = new Set<PostgresTestActor>();
  const earlyDisconnectSucceeded = new Set<PostgresTestActor>();
  for (const actor of competitors) {
    if (!competitorsToStop.has(actor)) continue;
    earlyDisconnectAttempted.add(actor);
    const disconnected = await captureCleanupPhase(failures, `${actor.actorName}-early-disconnect`, () =>
      disconnectPostgresTestActors([actor])
    );
    if (disconnected.ok) earlyDisconnectSucceeded.add(actor);
  }

  if (!operationsSettled) {
    operationsSettled = (await captureCleanupPhase(failures, "operation-resettlement", () =>
      withTimeout(settlement, CLEANUP_TIMEOUT_MS, `${scenario.label} operation cleanup after disconnect`)
    )).ok;
  }
  const unsafeCompetitorRemains = [...competitorsToStop].some(
    (actor) => !earlyDisconnectSucceeded.has(actor)
  );
  if (observerHealthy) {
    observerHealthy = (await captureCleanupPhase(failures, "observer-final-pin", () =>
      assertActorSessionPinned(scenario.observer, `${scenario.label}-cleanup-observer-final`)
    )).ok;
  }

  const userIds = [...new Set(scenario.userIds)].sort();
  if (observerHealthy && operationsSettled && !unsafeCompetitorRemains && userIds.length > 0) {
    const auditSelection = await captureCleanupPhase(failures, "audit-id-selection", () =>
      scenario.observer.client.auditLog.findMany({
        where: { userId: { in: userIds } },
        select: { id: true }
      })
    );
    if (auditSelection.ok) {
      const auditIds = auditSelection.value.map(({ id }) => id);
      let auditDeletionSucceeded = true;
      if (auditIds.length > 0) {
        auditDeletionSucceeded = (await captureCleanupPhase(failures, "audit-id-deletion", async () => {
          const deleted = await scenario.observer.client.auditLog.deleteMany({
            where: { id: { in: auditIds } }
          });
          assert.equal(deleted.count, auditIds.length);
        })).ok;
      }
      if (auditDeletionSucceeded) {
        await captureCleanupPhase(failures, "synthetic-user-deletion", () =>
          deleteSyntheticTestUsers(scenario.observer, userIds)
        );
      }
    }
  }

  for (const actor of competitors) {
    if (earlyDisconnectAttempted.has(actor)) continue;
    await captureCleanupPhase(failures, `${actor.actorName}-disconnect`, () =>
      disconnectPostgresTestActors([actor])
    );
  }
  await captureCleanupPhase(failures, "observer-disconnect", () =>
    disconnectPostgresTestActors([scenario.observer])
  );
  throwCleanupOutcome(primary, failures);
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

async function createFixture(scenario: Scenario, label: string): Promise<Fixture> {
  const user = await createSyntheticTestUser(scenario.observer, `${scenario.label}-${label}`);
  scenario.userIds.push(user.id);
  const key = `${label}-${randomUUID()}`;
  const applyUrl = `https://${APPLY_HOST}/apply/${key}`;
  const job = await scenario.observer.client.jobPosting.create({
    data: {
      userId: user.id,
      title: `F5 concurrency role ${key}`,
      normalizedTitle: `f5-concurrency-role-${key}`,
      company: "F5 Synthetic Employer",
      normalizedCompany: `f5-synthetic-employer-${key}`,
      location: "Remote",
      normalizedLocation: `remote-${key}`,
      remoteStatus: "REMOTE",
      sourceUrl: `https://${APPLY_HOST}/jobs/${key}`,
      applyUrl,
      normalizedApplyUrl: applyUrl,
      description: "Disposable F5 answer-packet concurrency fixture.",
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
      stateVersion: 4,
      activeRunKey: application.id,
      idempotencyKey: `f5:${key}`,
      applyUrlSnapshot: applyUrl,
      applyHost: APPLY_HOST,
      reviewReasons: [...REVIEW_REASONS]
    },
    select: { id: true }
  });
  await scenario.observer.client.applicationAutomationPolicy.create({
    data: {
      userId: user.id,
      enabled: true,
      allowedHosts: [APPLY_HOST],
      sensitiveAnswerPolicy: "EXCLUDE",
      finalReviewRequired: true
    }
  });
  const vault = await scenario.observer.client.applicationAnswer.create({
    data: {
      userId: user.id,
      category: "LINKS",
      question: "LinkedIn profile URL",
      normalizedQuestion: `linkedin-profile-url-${key}`,
      answer: `https://www.linkedin.com/in/${key}`
    },
    select: { id: true }
  });
  return {
    userId: user.id,
    applicationId: application.id,
    runId: run.id,
    vaultId: vault.id,
    applyUrl
  };
}

function packetService(client: PostgresTestActor["client"], clock?: () => Date) {
  return createApplicationRunAnswerPacketService({
    prismaClient: client,
    env: AUTOMATION_ENV,
    ...(clock ? { clock } : {})
  });
}

function runService(client: PostgresTestActor["client"], clock?: () => Date) {
  return createApplicationRunService({
    prismaClient: client,
    env: AUTOMATION_ENV,
    ...(clock ? { clock } : {})
  });
}

function publicationRequest(
  fixture: Fixture,
  input: {
    stateVersion: number;
    inspectionVersion: number;
    packetVersion: number;
    required: boolean;
  }
) {
  return {
    userId: fixture.userId,
    runId: fixture.runId,
    expectedStateVersion: input.stateVersion,
    expectedFormInspectionVersion: input.inspectionVersion,
    expectedAnswerPacketVersion: input.packetVersion,
    observedUrl: `${fixture.applyUrl}#f5-observation`,
    inspectionReport: formReport(input.required)
  };
}

function reviewRequest(fixture: Fixture, packet: PacketResult) {
  const answer = packet.packet.answers[0];
  assert.ok(answer);
  return {
    userId: fixture.userId,
    runId: fixture.runId,
    answerId: answer.id,
    status: "APPROVED" as const,
    answerPacketVersion: packet.packetVersion
  };
}

async function publishInitial(fixture: Fixture, actor: PostgresTestActor): Promise<PacketResult> {
  return packetService(actor.client).publishFormInspectionAndAnswerPacket(
    publicationRequest(fixture, {
      stateVersion: 4,
      inspectionVersion: 0,
      packetVersion: 0,
      required: true
    })
  );
}

async function fullyReview(fixture: Fixture, packet: PacketResult, actor: PostgresTestActor) {
  return runService(actor.client, () => new Date("2039-05-05T00:00:00.000Z"))
    .reviewApplicationRunAnswer(reviewRequest(fixture, packet));
}

function resolveRequest(fixture: Fixture, packet: PacketResult) {
  return {
    userId: fixture.userId,
    runId: fixture.runId,
    stateVersion: packet.stateVersion,
    acknowledgedReviewReasons: [...REVIEW_REASONS],
    answerPacketVersion: packet.packetVersion,
    packetHash: packet.packetHash
  };
}

async function currentPacket(fixture: Fixture): Promise<PacketRead> {
  return createApplicationRunAnswerPacketService().getCurrentAnswerPacket({
    userId: fixture.userId,
    runId: fixture.runId
  });
}

function hookedActor(actor: PostgresTestActor, hooks: readonly PrismaOperationHook[]): HookedPrismaClient {
  return createHookedPrismaClient(actor, hooks);
}

async function observeWait(
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
  return withTimeout(Promise.allSettled([first, second]), PAIR_TIMEOUT_MS, label) as Promise<[
    PromiseSettledResult<T>,
    PromiseSettledResult<U>
  ]>;
}

function fulfilled<T>(result: PromiseSettledResult<T>, actor: PostgresTestActor, phase: string): T {
  if (result.status === "fulfilled") return result.value;
  assertNoUnexpectedConcurrencyError(result.reason, actor.actorName, phase);
  assert.fail(`${actor.actorName} unexpectedly rejected during ${phase}.`);
}

function rejected(result: PromiseSettledResult<unknown>, actor: PostgresTestActor, phase: string): unknown {
  if (result.status === "rejected") {
    assertNoUnexpectedConcurrencyError(result.reason, actor.actorName, phase);
    return result.reason;
  }
  assert.fail(`${actor.actorName} unexpectedly fulfilled during ${phase}.`);
}

function assertPublicError(error: unknown, code: string): void {
  assert.ok(error instanceof PublicApiError);
  assert.equal(error.status, 409);
  assert.equal(error.details?.code, code);
}

async function recordCounts(fixture: Fixture, actor: PostgresTestActor): Promise<RecordCounts> {
  const audits = await actor.client.auditLog.groupBy({
    by: ["action"],
    where: { userId: fixture.userId },
    _count: { _all: true }
  });
  const events = await actor.client.applicationEvent.groupBy({
    by: ["title"],
    where: { userId: fixture.userId },
    _count: { _all: true }
  });
  const auditCount = (action: string) => audits.find((row) => row.action === action)?._count._all ?? 0;
  const eventCount = (title: string) => events.find((row) => row.title === title)?._count._all ?? 0;
  return {
    totalAudits: audits.reduce((total, row) => total + row._count._all, 0),
    totalEvents: events.reduce((total, row) => total + row._count._all, 0),
    publishAudits: auditCount("application-run-answer-packet.publish"),
    revokeAudits: auditCount("application-execution-token.revoke-bulk"),
    reviewAudits: auditCount("application-run-answer.review"),
    resolveAudits: auditCount("application-run.review.resolve"),
    preparedEvents: eventCount("Application answer packet prepared"),
    updatedEvents: eventCount("Application answer packet updated"),
    resolvedEvents: eventCount("Application run review resolved")
  };
}

function plus(base: RecordCounts, delta: Partial<RecordCounts>): RecordCounts {
  return Object.fromEntries(
    Object.entries(base).map(([key, value]) => [key, value + (delta[key as keyof RecordCounts] ?? 0)])
  ) as RecordCounts;
}

async function assertHealthy(scenario: Scenario, phase: string): Promise<void> {
  await assertNoIdleTransactions(scenario.observer, scenario.actors);
  for (const actor of scenario.actors) {
    await assertActorSessionPinned(actor, `${scenario.label}-${phase}`);
  }
}

test("different material publications serialize and the loser receives RUN_LIFECYCLE_STALE", { timeout: TEST_TIMEOUT_MS }, async () => {
  await runScenario("f5-publication-v-publication", async (scenario) => {
    const fixture = await createFixture(scenario, "user");
    const baseline = await recordCounts(fixture, scenario.observer);
    const winnerReached = deferred("publication winner updated run");
    const releaseWinner = trackRelease(scenario, deferred("release publication winner"));
    const winnerHooks = hookedActor(scenario.actorA, [{
      name: "publication winner run CAS",
      match: { kind: "model", model: "applicationRun", method: "updateMany" },
      expectedMatches: 1,
      after: async () => {
        winnerReached.resolve();
        await releaseWinner.wait();
      }
    }]);
    const winner = packetService(winnerHooks.prismaClient).publishFormInspectionAndAnswerPacket(
      publicationRequest(fixture, {
        stateVersion: 4,
        inspectionVersion: 0,
        packetVersion: 0,
        required: true
      })
    );
    trackOperation(scenario, winner);
    await winnerReached.wait();

    const contender = packetService(scenario.actorB.client).publishFormInspectionAndAnswerPacket(
      publicationRequest(fixture, {
        stateVersion: 4,
        inspectionVersion: 0,
        packetVersion: 0,
        required: false
      })
    );
    trackOperation(scenario, contender);
    await observeWait(scenario, scenario.actorB, scenario.actorA);

    releaseWinner.resolve();
    const [winnerSettled, contenderSettled] = await settlePair(winner, contender, "publication race");
    const result = fulfilled(winnerSettled, scenario.actorA, "publication winner");
    assertPublicError(rejected(contenderSettled, scenario.actorB, "publication contender"), "RUN_LIFECYCLE_STALE");
    winnerHooks.assertExpectedHooksReached();

    assert.equal(result.replayed, false);
    assert.equal(result.state, "REVIEW_REQUIRED");
    assert.equal(result.stateVersion, 5);
    assert.equal(result.inspectionVersion, 1);
    assert.equal(result.packetVersion, 1);
    const run = await scenario.observer.client.applicationRun.findUniqueOrThrow({ where: { id: fixture.runId } });
    assert.equal(run.state, "REVIEW_REQUIRED");
    assert.equal(run.stateVersion, 5);
    assert.equal(run.currentFormInspectionVersion, 1);
    assert.equal(run.currentAnswerPacketVersion, 1);
    assert.equal(await scenario.observer.client.applicationRunFormInspection.count({ where: { runId: fixture.runId } }), 1);
    assert.equal(await scenario.observer.client.applicationRunAnswerPacket.count({ where: { runId: fixture.runId } }), 1);
    assert.equal(await scenario.observer.client.applicationRunAnswer.count({ where: { runId: fixture.runId } }), 1);
    const read = await currentPacket(fixture);
    assert.ok(read.current);
    assert.equal(read.current.inspectionVersion, 1);
    assert.equal(read.current.packetVersion, 1);
    assert.equal(read.current.packetHash, result.packetHash);
    assert.equal(read.current.answers[0]?.required, true);
    assert.deepEqual(await recordCounts(fixture, scenario.observer), plus(baseline, {
      totalAudits: 2,
      totalEvents: 1,
      publishAudits: 1,
      revokeAudits: 1,
      preparedEvents: 1
    }));
    await assertHealthy(scenario, "complete");
  });
});

test("material publication wins over rebuild and the rebuild exact-replays the winner", { timeout: TEST_TIMEOUT_MS }, async () => {
  await runScenario("f5-publication-v-rebuild", async (scenario) => {
    const fixture = await createFixture(scenario, "user");
    const initial = await publishInitial(fixture, scenario.observer);
    assert.equal(initial.packetVersion, 1);
    await scenario.observer.client.applicationExecutionToken.create({
      data: {
        userId: fixture.userId,
        runId: fixture.runId,
        tokenHash: sha256(`f5-token-${randomUUID()}`),
        tokenPrefix: "aet_f5token...",
        host: APPLY_HOST,
        scope: "APPLICATION_READ",
        singleUse: false,
        expiresAt: new Date(Date.now() + 60_000)
      }
    });
    assert.equal(await scenario.observer.client.applicationExecutionToken.count({
      where: { runId: fixture.runId, revokedAt: null, consumedAt: null }
    }), 1);
    const baseline = await recordCounts(fixture, scenario.observer);
    await scenario.observer.client.applicationAnswer.update({
      where: { id: fixture.vaultId },
      data: { answer: `https://www.linkedin.com/in/rebuilt-${randomUUID()}` }
    });

    const winnerReached = deferred("replacement publication updated run");
    const releaseWinner = trackRelease(scenario, deferred("release replacement publication"));
    const winnerHooks = hookedActor(scenario.actorA, [{
      name: "replacement publication run CAS",
      match: { kind: "model", model: "applicationRun", method: "updateMany" },
      expectedMatches: 1,
      after: async () => {
        winnerReached.resolve();
        await releaseWinner.wait();
      }
    }]);
    const publication = packetService(winnerHooks.prismaClient).publishFormInspectionAndAnswerPacket(
      publicationRequest(fixture, {
        stateVersion: initial.stateVersion,
        inspectionVersion: initial.inspectionVersion,
        packetVersion: initial.packetVersion,
        required: false
      })
    );
    trackOperation(scenario, publication);
    await winnerReached.wait();

    const rebuildHooks = hookedActor(scenario.actorB, [
      {
        name: "replay inspection create",
        match: { kind: "model", model: "applicationRunFormInspection", method: "create" },
        expectedMatches: 0
      },
      {
        name: "replay packet create",
        match: { kind: "model", model: "applicationRunAnswerPacket", method: "create" },
        expectedMatches: 0
      },
      {
        name: "replay answer createMany",
        match: { kind: "model", model: "applicationRunAnswer", method: "createMany" },
        expectedMatches: 0
      },
      {
        name: "replay run CAS",
        match: { kind: "model", model: "applicationRun", method: "updateMany" },
        expectedMatches: 0
      },
      {
        name: "replay token revocation",
        match: { kind: "model", model: "applicationExecutionToken", method: "updateMany" },
        expectedMatches: 0
      },
      {
        name: "replay audit create",
        match: { kind: "model", model: "auditLog", method: "create" },
        expectedMatches: 0
      },
      {
        name: "replay event create",
        match: { kind: "model", model: "applicationEvent", method: "create" },
        expectedMatches: 0
      }
    ]);
    const rebuild = packetService(rebuildHooks.prismaClient).rebuildCurrentAnswerPacket({
      userId: fixture.userId,
      runId: fixture.runId,
      expectedStateVersion: initial.stateVersion,
      expectedFormInspectionVersion: initial.inspectionVersion,
      expectedAnswerPacketVersion: initial.packetVersion
    });
    trackOperation(scenario, rebuild);
    await observeWait(scenario, scenario.actorB, scenario.actorA);

    releaseWinner.resolve();
    const [publicationSettled, rebuildSettled] = await settlePair(
      publication,
      rebuild,
      "publication versus rebuild"
    );
    const published = fulfilled(publicationSettled, scenario.actorA, "material publication");
    const replayed = fulfilled(rebuildSettled, scenario.actorB, "rebuild replay");
    winnerHooks.assertExpectedHooksReached();
    rebuildHooks.assertExpectedHooksReached();
    assert.equal(published.replayed, false);
    assert.equal(replayed.replayed, true);
    assert.deepEqual(replayed, { ...published, replayed: true });
    assert.equal(published.inspectionVersion, 2);
    assert.equal(published.packetVersion, 2);
    assert.equal(await scenario.observer.client.applicationRunFormInspection.count({ where: { runId: fixture.runId } }), 2);
    assert.equal(await scenario.observer.client.applicationRunAnswerPacket.count({ where: { runId: fixture.runId } }), 2);
    assert.equal(await scenario.observer.client.applicationRunAnswer.count({ where: { runId: fixture.runId } }), 2);
    const tokens = await scenario.observer.client.applicationExecutionToken.findMany({ where: { runId: fixture.runId } });
    assert.equal(tokens.length, 1);
    assert.ok(tokens[0]?.revokedAt);
    assert.equal(await scenario.observer.client.applicationExecutionToken.count({
      where: { runId: fixture.runId, revokedAt: null, consumedAt: null }
    }), 0);
    assert.deepEqual(await recordCounts(fixture, scenario.observer), plus(baseline, {
      totalAudits: 2,
      totalEvents: 1,
      publishAudits: 1,
      revokeAudits: 1,
      updatedEvents: 1
    }));
    const read = await currentPacket(fixture);
    assert.ok(read.current);
    assert.equal(read.current.inspectionVersion, 2);
    assert.equal(read.current.packetVersion, 2);
    assert.equal(read.current.packetHash, published.packetHash);
    await assertHealthy(scenario, "complete");
  });
});

test("material replacement wins over a packet-N answer review", { timeout: TEST_TIMEOUT_MS }, async () => {
  await runScenario("f5-replacement-v-answer-review", async (scenario) => {
    const fixture = await createFixture(scenario, "user");
    const initial = await publishInitial(fixture, scenario.observer);
    const oldAnswer = initial.packet.answers[0];
    assert.ok(oldAnswer);
    const baseline = await recordCounts(fixture, scenario.observer);
    await scenario.observer.client.applicationAnswer.update({
      where: { id: fixture.vaultId },
      data: { answer: `https://www.linkedin.com/in/replacement-${randomUUID()}` }
    });

    const winnerReached = deferred("replacement winner updated run");
    const releaseWinner = trackRelease(scenario, deferred("release replacement winner"));
    const winnerHooks = hookedActor(scenario.actorA, [{
      name: "replacement winner run CAS",
      match: { kind: "model", model: "applicationRun", method: "updateMany" },
      expectedMatches: 1,
      after: async () => {
        winnerReached.resolve();
        await releaseWinner.wait();
      }
    }]);
    const replacement = packetService(winnerHooks.prismaClient).publishFormInspectionAndAnswerPacket(
      publicationRequest(fixture, {
        stateVersion: initial.stateVersion,
        inspectionVersion: initial.inspectionVersion,
        packetVersion: initial.packetVersion,
        required: true
      })
    );
    trackOperation(scenario, replacement);
    await winnerReached.wait();

    const review = runService(scenario.actorB.client).reviewApplicationRunAnswer(reviewRequest(fixture, initial));
    trackOperation(scenario, review);
    await observeWait(scenario, scenario.actorB, scenario.actorA);
    releaseWinner.resolve();

    const [replacementSettled, reviewSettled] = await settlePair(
      replacement,
      review,
      "replacement versus old answer review"
    );
    const material = fulfilled(replacementSettled, scenario.actorA, "material replacement");
    assertPublicError(rejected(reviewSettled, scenario.actorB, "old answer review"), "RUN_PACKET_STALE");
    winnerHooks.assertExpectedHooksReached();
    assert.equal(material.packetVersion, 2);

    const answers = await scenario.observer.client.applicationRunAnswer.findMany({
      where: { runId: fixture.runId },
      orderBy: { createdAt: "asc" }
    });
    assert.equal(answers.length, 2);
    const persistedOld = answers.find(({ id }) => id === oldAnswer.id);
    const persistedNew = answers.find(({ answerPacketId }) => answerPacketId !== persistedOld?.answerPacketId);
    assert.ok(persistedOld);
    assert.ok(persistedNew);
    assert.equal(persistedOld.status, "PENDING");
    assert.equal(persistedOld.reviewedByUser, false);
    assert.equal(persistedOld.reviewedAt, null);
    assert.equal(persistedOld.finalValueHash, null);
    assert.equal(persistedOld.reviewHashVersion, null);
    assert.equal(persistedNew.status, "PENDING");
    assert.equal(persistedNew.reviewedByUser, false);
    assert.equal(persistedNew.reviewedAt, null);
    assert.equal(persistedNew.finalValueHash, null);
    assert.equal(persistedNew.reviewHashVersion, null);
    assert.deepEqual(await recordCounts(fixture, scenario.observer), plus(baseline, {
      totalAudits: 2,
      totalEvents: 1,
      publishAudits: 1,
      revokeAudits: 1,
      updatedEvents: 1
    }));
    const read = await currentPacket(fixture);
    assert.ok(read.current);
    assert.equal(read.current.packetVersion, 2);
    assert.equal(read.current.answers[0]?.status, "PENDING");
    await assertHealthy(scenario, "complete");
  });
});

test("packet-N answer review commits before material replacement without carrying review state", { timeout: TEST_TIMEOUT_MS }, async () => {
  await runScenario("f5-answer-review-v-replacement", async (scenario) => {
    const fixture = await createFixture(scenario, "user");
    const initial = await publishInitial(fixture, scenario.observer);
    const oldAnswer = initial.packet.answers[0];
    assert.ok(oldAnswer?.proposal);
    const expectedHash = computeApplicationAnswerProposalHash(oldAnswer.proposal);
    const baseline = await recordCounts(fixture, scenario.observer);
    await scenario.observer.client.applicationAnswer.update({
      where: { id: fixture.vaultId },
      data: { answer: `https://www.linkedin.com/in/post-review-${randomUUID()}` }
    });

    const reviewReached = deferred("answer review updated packet-N answer");
    const releaseReview = trackRelease(scenario, deferred("release answer review"));
    const reviewHooks = hookedActor(scenario.actorA, [{
      name: "answer review updateMany",
      match: { kind: "model", model: "applicationRunAnswer", method: "updateMany" },
      expectedMatches: 1,
      after: async () => {
        reviewReached.resolve();
        await releaseReview.wait();
      }
    }]);
    const review = runService(
      reviewHooks.prismaClient,
      () => new Date("2039-04-04T00:00:00.000Z")
    ).reviewApplicationRunAnswer(reviewRequest(fixture, initial));
    trackOperation(scenario, review);
    await reviewReached.wait();

    const replacement = packetService(scenario.actorB.client).publishFormInspectionAndAnswerPacket(
      publicationRequest(fixture, {
        stateVersion: initial.stateVersion,
        inspectionVersion: initial.inspectionVersion,
        packetVersion: initial.packetVersion,
        required: true
      })
    );
    trackOperation(scenario, replacement);
    await observeWait(scenario, scenario.actorB, scenario.actorA);
    releaseReview.resolve();

    const [reviewSettled, replacementSettled] = await settlePair(
      review,
      replacement,
      "answer review versus replacement"
    );
    const reviewed = fulfilled(reviewSettled, scenario.actorA, "answer review");
    const material = fulfilled(replacementSettled, scenario.actorB, "material replacement");
    reviewHooks.assertExpectedHooksReached();
    assert.equal(reviewed.status, "APPROVED");
    assert.equal(material.packetVersion, 2);

    const oldRow = await scenario.observer.client.applicationRunAnswer.findUniqueOrThrow({
      where: { id: oldAnswer.id }
    });
    const newPacket = await scenario.observer.client.applicationRunAnswerPacket.findUniqueOrThrow({
      where: { runId_version: { runId: fixture.runId, version: 2 } }
    });
    const newRow = await scenario.observer.client.applicationRunAnswer.findFirstOrThrow({
      where: { answerPacketId: newPacket.id }
    });
    assert.equal(oldRow.status, "APPROVED");
    assert.equal(oldRow.reviewedByUser, true);
    assert.ok(oldRow.reviewedAt);
    assert.equal(oldRow.finalValueHash, expectedHash);
    assert.equal(oldRow.reviewHashVersion, "CANONICAL_PROPOSAL_V1");
    assert.equal(newRow.status, "PENDING");
    assert.equal(newRow.reviewedByUser, false);
    assert.equal(newRow.reviewedAt, null);
    assert.equal(newRow.finalValueHash, null);
    assert.equal(newRow.reviewHashVersion, null);
    assert.deepEqual(await recordCounts(fixture, scenario.observer), plus(baseline, {
      totalAudits: 3,
      totalEvents: 1,
      reviewAudits: 1,
      publishAudits: 1,
      revokeAudits: 1,
      updatedEvents: 1
    }));
    const read = await currentPacket(fixture);
    assert.ok(read.current);
    assert.equal(read.current.packetVersion, 2);
    assert.equal(read.current.answers[0]?.status, "PENDING");
    await assertHealthy(scenario, "complete");
  });
});

test("material replacement wins over a packet-N resolver", { timeout: TEST_TIMEOUT_MS }, async () => {
  await runScenario("f5-replacement-v-resolver", async (scenario) => {
    const fixture = await createFixture(scenario, "user");
    const initial = await publishInitial(fixture, scenario.observer);
    await fullyReview(fixture, initial, scenario.observer);
    const baseline = await recordCounts(fixture, scenario.observer);
    await scenario.observer.client.applicationAnswer.update({
      where: { id: fixture.vaultId },
      data: { answer: `https://www.linkedin.com/in/resolver-stale-${randomUUID()}` }
    });

    const replacementReached = deferred("resolver-staling replacement updated run");
    const releaseReplacement = trackRelease(scenario, deferred("release resolver-staling replacement"));
    const replacementHooks = hookedActor(scenario.actorA, [{
      name: "resolver-staling replacement run CAS",
      match: { kind: "model", model: "applicationRun", method: "updateMany" },
      expectedMatches: 1,
      after: async () => {
        replacementReached.resolve();
        await releaseReplacement.wait();
      }
    }]);
    const replacement = packetService(replacementHooks.prismaClient).publishFormInspectionAndAnswerPacket(
      publicationRequest(fixture, {
        stateVersion: initial.stateVersion,
        inspectionVersion: initial.inspectionVersion,
        packetVersion: initial.packetVersion,
        required: true
      })
    );
    trackOperation(scenario, replacement);
    await replacementReached.wait();

    const resolver = runService(scenario.actorB.client).resolveApplicationRunReview(resolveRequest(fixture, initial));
    trackOperation(scenario, resolver);
    await observeWait(scenario, scenario.actorB, scenario.actorA);
    releaseReplacement.resolve();

    const [replacementSettled, resolverSettled] = await settlePair(
      replacement,
      resolver,
      "replacement versus packet-N resolver"
    );
    const material = fulfilled(replacementSettled, scenario.actorA, "material replacement");
    assertPublicError(rejected(resolverSettled, scenario.actorB, "packet-N resolver"), "RUN_PACKET_STALE");
    replacementHooks.assertExpectedHooksReached();
    assert.equal(material.packetVersion, 2);

    const run = await scenario.observer.client.applicationRun.findUniqueOrThrow({ where: { id: fixture.runId } });
    assert.equal(run.state, "REVIEW_REQUIRED");
    assert.equal(run.stateVersion, initial.stateVersion);
    assert.equal(run.currentAnswerPacketVersion, 2);
    const packets = await scenario.observer.client.applicationRunAnswerPacket.findMany({
      where: { runId: fixture.runId },
      orderBy: { version: "asc" }
    });
    assert.equal(packets.length, 2);
    assert.equal(packets[0]?.reviewedAt, null);
    assert.equal(packets[1]?.reviewedAt, null);
    assert.deepEqual(await recordCounts(fixture, scenario.observer), plus(baseline, {
      totalAudits: 2,
      totalEvents: 1,
      publishAudits: 1,
      revokeAudits: 1,
      updatedEvents: 1
    }));
    const read = await currentPacket(fixture);
    assert.ok(read.current);
    assert.equal(read.current.packetVersion, 2);
    assert.equal(read.current.reviewedAt, null);
    await assertHealthy(scenario, "complete");
  });
});

test("packet-N resolver commits before old-state material replacement", { timeout: TEST_TIMEOUT_MS }, async () => {
  await runScenario("f5-resolver-v-replacement", async (scenario) => {
    const fixture = await createFixture(scenario, "user");
    const initial = await publishInitial(fixture, scenario.observer);
    await fullyReview(fixture, initial, scenario.observer);
    await scenario.observer.client.applicationAnswer.update({
      where: { id: fixture.vaultId },
      data: { answer: `https://www.linkedin.com/in/after-resolution-${randomUUID()}` }
    });
    const baseline = await recordCounts(fixture, scenario.observer);

    const resolverReached = deferred("resolver updated run");
    const releaseResolver = trackRelease(scenario, deferred("release resolver"));
    const resolverHooks = hookedActor(scenario.actorA, [{
      name: "resolver run CAS",
      match: { kind: "model", model: "applicationRun", method: "updateMany" },
      expectedMatches: 1,
      after: async () => {
        resolverReached.resolve();
        await releaseResolver.wait();
      }
    }]);
    const resolver = runService(resolverHooks.prismaClient).resolveApplicationRunReview(
      resolveRequest(fixture, initial)
    );
    trackOperation(scenario, resolver);
    await resolverReached.wait();

    const replacement = packetService(scenario.actorB.client).publishFormInspectionAndAnswerPacket(
      publicationRequest(fixture, {
        stateVersion: initial.stateVersion,
        inspectionVersion: initial.inspectionVersion,
        packetVersion: initial.packetVersion,
        required: true
      })
    );
    trackOperation(scenario, replacement);
    await observeWait(scenario, scenario.actorB, scenario.actorA);
    releaseResolver.resolve();

    const [resolverSettled, replacementSettled] = await settlePair(
      resolver,
      replacement,
      "resolver versus old-state replacement"
    );
    const resolved = fulfilled(resolverSettled, scenario.actorA, "packet-N resolver");
    assertPublicError(rejected(replacementSettled, scenario.actorB, "old-state replacement"), "RUN_LIFECYCLE_STALE");
    resolverHooks.assertExpectedHooksReached();
    assert.equal(resolved.state, "READY");
    assert.equal(resolved.stateVersion, initial.stateVersion + 1);

    const run = await scenario.observer.client.applicationRun.findUniqueOrThrow({ where: { id: fixture.runId } });
    const packet = await scenario.observer.client.applicationRunAnswerPacket.findUniqueOrThrow({
      where: { runId_version: { runId: fixture.runId, version: initial.packetVersion } }
    });
    assert.equal(run.state, "READY");
    assert.equal(run.stateVersion, initial.stateVersion + 1);
    assert.equal(run.currentFormInspectionVersion, initial.inspectionVersion);
    assert.equal(run.currentAnswerPacketVersion, initial.packetVersion);
    assert.ok(packet.reviewedAt);
    assert.equal(await scenario.observer.client.applicationRunAnswerPacket.count({ where: { runId: fixture.runId } }), 1);
    assert.deepEqual(await recordCounts(fixture, scenario.observer), plus(baseline, {
      totalAudits: 1,
      totalEvents: 1,
      resolveAudits: 1,
      resolvedEvents: 1
    }));
    const read = await currentPacket(fixture);
    assert.ok(read.current);
    assert.equal(read.current.packetVersion, 1);
    assert.ok(read.current.reviewedAt);
    await assertHealthy(scenario, "complete");
  });
});

test("resolver reaches a PENDING packet before answer review and rolls back cleanly", { timeout: TEST_TIMEOUT_MS }, async () => {
  await runScenario("f5-pending-resolver-v-review", async (scenario) => {
    const fixture = await createFixture(scenario, "user");
    const initial = await publishInitial(fixture, scenario.observer);
    const baseline = await recordCounts(fixture, scenario.observer);

    const resolverLockedRun = deferred("pending resolver locked run");
    const releaseResolver = trackRelease(scenario, deferred("release pending resolver"));
    const resolverHooks = hookedActor(scenario.actorA, [
      {
        name: "pending resolver run lock",
        match: RUN_ROW_LOCK,
        expectedMatches: 1,
        after: async () => {
          resolverLockedRun.resolve();
          await releaseResolver.wait();
        }
      },
      {
        name: "pending resolver database timestamp",
        match: { kind: "queryRaw", includes: ["SELECT CURRENT_TIMESTAMP"] },
        expectedMatches: 0
      },
      {
        name: "pending resolver packet update",
        match: { kind: "model", model: "applicationRunAnswerPacket", method: "updateMany" },
        expectedMatches: 0
      },
      {
        name: "pending resolver run update",
        match: { kind: "model", model: "applicationRun", method: "updateMany" },
        expectedMatches: 0
      },
      {
        name: "pending resolver audit",
        match: { kind: "model", model: "auditLog", method: "create" },
        expectedMatches: 0
      },
      {
        name: "pending resolver event",
        match: { kind: "model", model: "applicationEvent", method: "create" },
        expectedMatches: 0
      }
    ]);
    const resolver = runService(resolverHooks.prismaClient).resolveApplicationRunReview(
      resolveRequest(fixture, initial)
    );
    trackOperation(scenario, resolver);
    await resolverLockedRun.wait();

    const review = runService(
      scenario.actorB.client,
      () => new Date("2039-07-07T00:00:00.000Z")
    ).reviewApplicationRunAnswer(reviewRequest(fixture, initial));
    trackOperation(scenario, review);
    await observeWait(scenario, scenario.actorB, scenario.actorA);
    releaseResolver.resolve();

    const [resolverSettled, reviewSettled] = await settlePair(
      resolver,
      review,
      "pending resolver versus answer review"
    );
    assertPublicError(
      rejected(resolverSettled, scenario.actorA, "pending resolver"),
      "RUN_PACKET_REVIEW_INCOMPLETE"
    );
    const reviewed = fulfilled(reviewSettled, scenario.actorB, "answer review after resolver rollback");
    resolverHooks.assertExpectedHooksReached();
    assert.equal(reviewed.status, "APPROVED");

    const run = await scenario.observer.client.applicationRun.findUniqueOrThrow({ where: { id: fixture.runId } });
    const packet = await scenario.observer.client.applicationRunAnswerPacket.findUniqueOrThrow({
      where: { runId_version: { runId: fixture.runId, version: 1 } }
    });
    assert.equal(run.state, "REVIEW_REQUIRED");
    assert.equal(run.stateVersion, initial.stateVersion);
    assert.equal(run.reviewAcknowledgedAt, null);
    assert.equal(packet.reviewedAt, null);
    assert.deepEqual(await recordCounts(fixture, scenario.observer), plus(baseline, {
      totalAudits: 1,
      reviewAudits: 1
    }));
    await assertHealthy(scenario, "complete");
  });
});

test("answer review commits before resolver verification and resolution uses database time", { timeout: TEST_TIMEOUT_MS }, async () => {
  await runScenario("f5-answer-review-v-resolver", async (scenario) => {
    const fixture = await createFixture(scenario, "user");
    const initial = await publishInitial(fixture, scenario.observer);
    const baseline = await recordCounts(fixture, scenario.observer);

    const reviewReached = deferred("resolver-enabling answer review updated answer");
    const releaseReview = trackRelease(scenario, deferred("release resolver-enabling answer review"));
    const reviewHooks = hookedActor(scenario.actorA, [{
      name: "resolver-enabling answer review",
      match: { kind: "model", model: "applicationRunAnswer", method: "updateMany" },
      expectedMatches: 1,
      after: async () => {
        reviewReached.resolve();
        await releaseReview.wait();
      }
    }]);
    const review = runService(
      reviewHooks.prismaClient,
      () => new Date("2039-08-08T00:00:00.000Z")
    ).reviewApplicationRunAnswer(reviewRequest(fixture, initial));
    trackOperation(scenario, review);
    await reviewReached.wait();

    const injectedResolverTime = new Date("1999-01-01T00:00:00.000Z");
    let resolverClockCalls = 0;
    const resolver = runService(scenario.actorB.client, () => {
      resolverClockCalls += 1;
      return injectedResolverTime;
    }).resolveApplicationRunReview(resolveRequest(fixture, initial));
    trackOperation(scenario, resolver);
    await observeWait(scenario, scenario.actorB, scenario.actorA);
    releaseReview.resolve();

    const [reviewSettled, resolverSettled] = await settlePair(
      review,
      resolver,
      "answer review versus resolver verification"
    );
    const reviewed = fulfilled(reviewSettled, scenario.actorA, "answer review");
    const resolved = fulfilled(resolverSettled, scenario.actorB, "resolver after answer review");
    reviewHooks.assertExpectedHooksReached();
    assert.equal(reviewed.status, "APPROVED");
    assert.equal(resolved.state, "READY");
    assert.equal(resolverClockCalls, 0);

    const run = await scenario.observer.client.applicationRun.findUniqueOrThrow({ where: { id: fixture.runId } });
    const packet = await scenario.observer.client.applicationRunAnswerPacket.findUniqueOrThrow({
      where: { runId_version: { runId: fixture.runId, version: 1 } }
    });
    const answer = await scenario.observer.client.applicationRunAnswer.findFirstOrThrow({
      where: { answerPacketId: packet.id }
    });
    const resolveAudit = await scenario.observer.client.auditLog.findFirstOrThrow({
      where: { userId: fixture.userId, action: "application-run.review.resolve" },
      orderBy: { createdAt: "desc" }
    });
    assert.equal(run.state, "READY");
    assert.equal(run.stateVersion, initial.stateVersion + 1);
    assert.deepEqual(run.reviewReasons, [...REVIEW_REASONS]);
    assert.ok(run.reviewAcknowledgedAt);
    assert.equal(answer.status, "APPROVED");
    assert.ok(answer.reviewedAt);
    assert.ok(packet.reviewedAt);
    assert.equal(run.reviewAcknowledgedAt.getTime(), packet.reviewedAt.getTime());
    assert.notEqual(packet.reviewedAt.getTime(), injectedResolverTime.getTime());
    const resolveMetadata = resolveAudit.metadata as Record<string, unknown>;
    assert.equal(resolveMetadata.acknowledgedAt, packet.reviewedAt.toISOString());
    assert.deepEqual(await recordCounts(fixture, scenario.observer), plus(baseline, {
      totalAudits: 2,
      totalEvents: 1,
      reviewAudits: 1,
      resolveAudits: 1,
      resolvedEvents: 1
    }));
    const read = await currentPacket(fixture);
    assert.ok(read.current);
    assert.ok(read.current.reviewedAt);
    assert.equal(read.current.reviewedAt.getTime(), packet.reviewedAt.getTime());
    await assertHealthy(scenario, "complete");
  });
});

test("dual packet-backed resolvers permit exactly one resolution", { timeout: TEST_TIMEOUT_MS }, async () => {
  await runScenario("f5-dual-packet-resolver", async (scenario) => {
    const fixture = await createFixture(scenario, "user");
    const initial = await publishInitial(fixture, scenario.observer);
    await fullyReview(fixture, initial, scenario.observer);
    const baseline = await recordCounts(fixture, scenario.observer);

    const winnerReached = deferred("dual resolver winner updated packet");
    const releaseWinner = trackRelease(scenario, deferred("release dual resolver winner"));
    const winnerHooks = hookedActor(scenario.actorA, [{
      name: "dual resolver winner packet update",
      match: { kind: "model", model: "applicationRunAnswerPacket", method: "updateMany" },
      expectedMatches: 1,
      after: async () => {
        winnerReached.resolve();
        await releaseWinner.wait();
      }
    }]);
    const request = resolveRequest(fixture, initial);
    const winner = runService(winnerHooks.prismaClient).resolveApplicationRunReview(request);
    trackOperation(scenario, winner);
    await winnerReached.wait();

    const contender = runService(scenario.actorB.client).resolveApplicationRunReview(request);
    trackOperation(scenario, contender);
    await observeWait(scenario, scenario.actorB, scenario.actorA);
    releaseWinner.resolve();

    const [winnerSettled, contenderSettled] = await settlePair(
      winner,
      contender,
      "dual packet-backed resolvers"
    );
    const resolved = fulfilled(winnerSettled, scenario.actorA, "dual resolver winner");
    assertPublicError(rejected(contenderSettled, scenario.actorB, "dual resolver contender"), "RUN_INVALID_STATE");
    winnerHooks.assertExpectedHooksReached();
    assert.equal(resolved.state, "READY");
    assert.equal(resolved.stateVersion, initial.stateVersion + 1);

    const run = await scenario.observer.client.applicationRun.findUniqueOrThrow({ where: { id: fixture.runId } });
    const packet = await scenario.observer.client.applicationRunAnswerPacket.findUniqueOrThrow({
      where: { runId_version: { runId: fixture.runId, version: initial.packetVersion } }
    });
    assert.equal(run.state, "READY");
    assert.equal(run.stateVersion, initial.stateVersion + 1);
    assert.ok(run.reviewAcknowledgedAt);
    assert.ok(packet.reviewedAt);
    assert.equal(await scenario.observer.client.applicationRunAnswerPacket.count({
      where: { runId: fixture.runId, reviewedAt: { not: null } }
    }), 1);
    assert.deepEqual(await recordCounts(fixture, scenario.observer), plus(baseline, {
      totalAudits: 1,
      totalEvents: 1,
      resolveAudits: 1,
      resolvedEvents: 1
    }));
    await assertHealthy(scenario, "complete");
  });
});

test("late resolver event failure rolls back the real PostgreSQL transaction", { timeout: TEST_TIMEOUT_MS }, async () => {
  await runScenario("f5-late-resolver-rollback", async (scenario) => {
    const fixture = await createFixture(scenario, "user");
    const initial = await publishInitial(fixture, scenario.observer);
    await fullyReview(fixture, initial, scenario.observer);
    const baseline = await recordCounts(fixture, scenario.observer);
    const beforeRun = await scenario.observer.client.applicationRun.findUniqueOrThrow({
      where: { id: fixture.runId }
    });
    const beforePacket = await scenario.observer.client.applicationRunAnswerPacket.findUniqueOrThrow({
      where: { runId_version: { runId: fixture.runId, version: initial.packetVersion } }
    });
    const beforeAnswer = await scenario.observer.client.applicationRunAnswer.findFirstOrThrow({
      where: { answerPacketId: beforePacket.id }
    });
    assert.equal(beforeAnswer.status, "APPROVED");
    assert.equal(beforePacket.reviewedAt, null);

    const injectedFailure = lateFailureSentinel("resolver event create");
    const resolverHooks = hookedActor(scenario.actorA, [{
      name: "late resolver application event failure",
      match: { kind: "model", model: "applicationEvent", method: "create" },
      expectedMatches: 1,
      throwAfter: injectedFailure
    }]);
    const operation = runService(resolverHooks.prismaClient).resolveApplicationRunReview(
      resolveRequest(fixture, initial)
    );
    trackOperation(scenario, operation);
    const [settled] = await withTimeout(
      Promise.allSettled([operation]),
      PAIR_TIMEOUT_MS,
      "late resolver rollback"
    );
    const error = rejected(settled, scenario.actorA, "late resolver failure");
    assert.equal(error, injectedFailure);
    assert.equal((error as { code?: unknown }).code, "POSTGRES_TEST_LATE_FAILURE");
    resolverHooks.assertExpectedHooksReached();

    const afterRun = await scenario.observer.client.applicationRun.findUniqueOrThrow({
      where: { id: fixture.runId }
    });
    const afterPacket = await scenario.observer.client.applicationRunAnswerPacket.findUniqueOrThrow({
      where: { runId_version: { runId: fixture.runId, version: initial.packetVersion } }
    });
    const afterAnswer = await scenario.observer.client.applicationRunAnswer.findUniqueOrThrow({
      where: { id: beforeAnswer.id }
    });
    assert.equal(afterRun.state, "REVIEW_REQUIRED");
    assert.equal(afterRun.stateVersion, beforeRun.stateVersion);
    assert.equal(afterRun.currentFormInspectionVersion, beforeRun.currentFormInspectionVersion);
    assert.equal(afterRun.currentAnswerPacketVersion, beforeRun.currentAnswerPacketVersion);
    assert.equal(afterRun.reviewAcknowledgedAt, null);
    assert.equal(afterPacket.id, beforePacket.id);
    assert.equal(afterPacket.packetHash, beforePacket.packetHash);
    assert.equal(afterPacket.reviewedAt, null);
    assert.equal(afterAnswer.status, "APPROVED");
    assert.equal(afterAnswer.reviewedByUser, true);
    assert.equal(afterAnswer.reviewedAt?.getTime(), beforeAnswer.reviewedAt?.getTime());
    assert.equal(afterAnswer.finalValueHash, beforeAnswer.finalValueHash);
    assert.equal(afterAnswer.reviewHashVersion, beforeAnswer.reviewHashVersion);
    assert.deepEqual(await recordCounts(fixture, scenario.observer), baseline);
    const read = await currentPacket(fixture);
    assert.ok(read.current);
    assert.equal(read.current.reviewedAt, null);
    assert.equal(read.current.answers[0]?.status, "APPROVED");
    await assertHealthy(scenario, "complete");
  });
});
