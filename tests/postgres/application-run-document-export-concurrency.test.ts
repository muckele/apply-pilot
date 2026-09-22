import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "node:test";

import { Prisma } from "@prisma/client";

import { PublicApiError } from "@/lib/api-errors";
import { createApplicationRunAnswerPacketService } from "@/lib/application-runs/answer-packet-service";
import { createApplicationRunDocumentExportService } from "@/lib/application-runs/document-export";
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
  type ActorLockWait,
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

type ArtifactType = "RESUME" | "COVER_LETTER";

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

type AuthorizedFixture = {
  userId: string;
  applicationId: string;
  jobPostingId: string;
  runId: string;
  sourceId: string;
  artifactType: ArtifactType;
  content: string;
  applyUrl: string;
  stateVersion: number;
  inspectionVersion: number;
  packetVersion: number;
  packetHash: string;
  answerId: string;
};

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function formReport(artifactType: ArtifactType, required: boolean) {
  return {
    schemaVersion: FORM_INSPECTION_SCHEMA_VERSION,
    forms: [{
      title: "Application",
      sections: [{
        heading: "Documents",
        fields: [{
          question: artifactType === "RESUME" ? "Upload your resume" : "Upload your cover letter",
          helpText: null,
          fieldType: "FILE_UPLOAD",
          unsupportedReason: null,
          required,
          autocomplete: null,
          constraints: {
            minLength: null,
            maxLength: null,
            min: null,
            max: null,
            step: null,
            acceptedFileTypes: ["DOCX"],
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

async function captureCleanup(
  failures: CleanupFailure[],
  phase: string,
  action: () => Promise<unknown>
): Promise<boolean> {
  try {
    await action();
    return true;
  } catch (error) {
    failures.push({ phase, error });
    return false;
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
            failures.map(({ phase }) => new Error(`Secondary Repair B cleanup phase failed: ${phase}.`)),
            "One or more secondary Repair B cleanup phases failed."
          ),
          configurable: true
        });
      } catch {
        // Preserve the primary scenario failure.
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
  let operationsSettled = scenario.operations.length === 0 || await captureCleanup(
    failures,
    "operation-settlement",
    () => withTimeout(settlement, CLEANUP_TIMEOUT_MS, `${scenario.label} operation cleanup`)
  );
  let observerHealthy = await captureCleanup(
    failures,
    "observer-pin",
    () => assertActorSessionPinned(scenario.observer, `${scenario.label}-cleanup-observer`)
  );
  const competitors = [scenario.actorA, scenario.actorB] as const;
  const competitorsToStop = new Set<PostgresTestActor>();
  if (!operationsSettled) competitors.forEach((actor) => competitorsToStop.add(actor));

  for (const actor of competitors) {
    if (observerHealthy) {
      const idle = await captureCleanup(
        failures,
        `${actor.actorName}-idle`,
        () => assertNoIdleTransactions(scenario.observer, [actor])
      );
      if (!idle) competitorsToStop.add(actor);
    }
    const pinned = await captureCleanup(
      failures,
      `${actor.actorName}-pin`,
      () => assertActorSessionPinned(actor, `${scenario.label}-cleanup-${actor.actorName}`)
    );
    if (!pinned) competitorsToStop.add(actor);
  }

  const disconnected = new Set<PostgresTestActor>();
  for (const actor of competitorsToStop) {
    if (await captureCleanup(
      failures,
      `${actor.actorName}-early-disconnect`,
      () => disconnectPostgresTestActors([actor])
    )) disconnected.add(actor);
  }
  if (!operationsSettled) {
    operationsSettled = await captureCleanup(
      failures,
      "operation-resettlement",
      () => withTimeout(settlement, CLEANUP_TIMEOUT_MS, `${scenario.label} operation cleanup after disconnect`)
    );
  }
  if (observerHealthy) {
    observerHealthy = await captureCleanup(
      failures,
      "observer-final-pin",
      () => assertActorSessionPinned(scenario.observer, `${scenario.label}-cleanup-observer-final`)
    );
  }

  const userIds = [...new Set(scenario.userIds)].sort();
  if (observerHealthy && operationsSettled && userIds.length > 0) {
    let auditIds: string[] = [];
    const selected = await captureCleanup(failures, "audit-id-selection", async () => {
      auditIds = (await scenario.observer.client.auditLog.findMany({
        where: { userId: { in: userIds } },
        select: { id: true }
      })).map(({ id }) => id);
    });
    if (selected) {
      const deleted = auditIds.length === 0 || await captureCleanup(failures, "audit-id-deletion", async () => {
        const result = await scenario.observer.client.auditLog.deleteMany({ where: { id: { in: auditIds } } });
        assert.equal(result.count, auditIds.length);
      });
      if (deleted) {
        await captureCleanup(
          failures,
          "synthetic-user-deletion",
          () => deleteSyntheticTestUsers(scenario.observer, userIds)
        );
      }
    }
  }

  for (const actor of competitors) {
    if (disconnected.has(actor)) continue;
    await captureCleanup(
      failures,
      `${actor.actorName}-disconnect`,
      () => disconnectPostgresTestActors([actor])
    );
  }
  await captureCleanup(
    failures,
    "observer-disconnect",
    () => disconnectPostgresTestActors([scenario.observer])
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

function packetService(client: PostgresTestActor["client"]) {
  return createApplicationRunAnswerPacketService({ prismaClient: client, env: AUTOMATION_ENV });
}

function runService(client: PostgresTestActor["client"]) {
  return createApplicationRunService({ prismaClient: client, env: AUTOMATION_ENV });
}

function documentExportService(
  client: PostgresTestActor["client"],
  renderedInputs: Array<{ artifactType: ArtifactType; content: string }> = []
) {
  return createApplicationRunDocumentExportService({
    prismaClient: client,
    renderCanonicalApplicationDocumentV1: async (input) => {
      renderedInputs.push({ ...input });
      return Buffer.from(`rendered:${input.artifactType}:${input.content}`, "utf8");
    }
  });
}

async function createAuthorizedFixture(
  scenario: Scenario,
  artifactType: ArtifactType,
  label: string
): Promise<AuthorizedFixture> {
  const user = await createSyntheticTestUser(scenario.observer, `${scenario.label}-${label}`);
  scenario.userIds.push(user.id);
  const key = `${label}-${randomUUID()}`;
  const applyUrl = `https://${APPLY_HOST}/apply/${key}`;
  const job = await scenario.observer.client.jobPosting.create({
    data: {
      userId: user.id,
      title: `Repair B concurrency role ${key}`,
      normalizedTitle: `repair-b-concurrency-role-${key}`,
      company: "Repair B Synthetic Employer",
      normalizedCompany: `repair-b-synthetic-employer-${key}`,
      location: "Remote",
      normalizedLocation: `remote-${key}`,
      remoteStatus: "REMOTE",
      sourceUrl: `https://${APPLY_HOST}/jobs/${key}`,
      applyUrl,
      normalizedApplyUrl: applyUrl,
      description: "Disposable Repair B document-export concurrency fixture.",
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
  const content = artifactType === "RESUME"
    ? `Approved résumé ${key} 中文 🚀`
    : `Approved cover letter ${key} 中文 🚀`;
  const source = artifactType === "RESUME"
    ? await scenario.observer.client.resumeVersion.create({
        data: {
          userId: user.id,
          jobPostingId: job.id,
          title: `Mutable résumé ${key}`,
          skills: [],
          fullText: content,
          template: "MODERN",
          pageSize: "A4",
          fontFamily: "GEORGIA",
          accentColor: "#ABCDEF",
          fontSize: 12,
          lineSpacing: 130
        },
        select: { id: true }
      })
    : await scenario.observer.client.generatedDocument.create({
        data: {
          userId: user.id,
          jobPostingId: job.id,
          type: "COVER_LETTER",
          title: `Mutable cover title ${key}`,
          content
        },
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
      idempotencyKey: `repair-b:${key}`,
      applyUrlSnapshot: applyUrl,
      applyHost: APPLY_HOST,
      reviewReasons: [...REVIEW_REASONS],
      ...(artifactType === "RESUME"
        ? { resumeVersionId: source.id, resumeContentHash: sha256(content) }
        : { coverLetterVersionId: source.id, coverLetterContentHash: sha256(content) })
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

  const packet = await packetService(scenario.observer.client).publishFormInspectionAndAnswerPacket({
    userId: user.id,
    runId: run.id,
    expectedStateVersion: 4,
    expectedFormInspectionVersion: 0,
    expectedAnswerPacketVersion: 0,
    observedUrl: `${applyUrl}#repair-b-observation`,
    inspectionReport: formReport(artifactType, true)
  });
  const answer = packet.packet.answers[0];
  assert.ok(answer);
  assert.equal(answer.proposal?.kind, "DOCUMENT_REFERENCE");
  assert.equal(answer.proposal.artifactType, artifactType);
  await runService(scenario.observer.client).reviewApplicationRunAnswer({
    userId: user.id,
    runId: run.id,
    answerId: answer.id,
    status: "APPROVED",
    answerPacketVersion: packet.packetVersion
  });
  const resolved = await runService(scenario.observer.client).resolveApplicationRunReview({
    userId: user.id,
    runId: run.id,
    stateVersion: packet.stateVersion,
    acknowledgedReviewReasons: [...REVIEW_REASONS],
    answerPacketVersion: packet.packetVersion,
    packetHash: packet.packetHash
  });
  assert.equal(resolved.state, "READY");

  return {
    userId: user.id,
    applicationId: application.id,
    jobPostingId: job.id,
    runId: run.id,
    sourceId: source.id,
    artifactType,
    content,
    applyUrl,
    stateVersion: resolved.stateVersion,
    inspectionVersion: packet.inspectionVersion,
    packetVersion: packet.packetVersion,
    packetHash: packet.packetHash,
    answerId: answer.id
  };
}

function exportRequest(fixture: AuthorizedFixture) {
  return {
    userId: fixture.userId,
    runId: fixture.runId,
    answerId: fixture.answerId,
    expectedStateVersion: fixture.stateVersion,
    answerPacketVersion: fixture.packetVersion,
    packetHash: fixture.packetHash,
    format: "docx"
  };
}

function replacementRequest(fixture: AuthorizedFixture) {
  return {
    userId: fixture.userId,
    runId: fixture.runId,
    expectedStateVersion: fixture.stateVersion,
    expectedFormInspectionVersion: fixture.inspectionVersion,
    expectedAnswerPacketVersion: fixture.packetVersion,
    observedUrl: `${fixture.applyUrl}#replacement`,
    inspectionReport: formReport(fixture.artifactType, false)
  };
}

function hookedActor(actor: PostgresTestActor, hooks: readonly PrismaOperationHook[]): HookedPrismaClient {
  return createHookedPrismaClient(actor, hooks);
}

async function observeWait(
  scenario: Scenario,
  waiter: PostgresTestActor,
  blocker: PostgresTestActor
): Promise<ActorLockWait> {
  const observed = await waitForActorLockWait(scenario.observer, waiter, blocker);
  assert.equal(observed.waiterPid, waiter.backendPid);
  assert.equal(observed.waiterApplicationName, waiter.applicationName);
  assert.equal(observed.waitEventType, "Lock");
  assert.equal(observed.hasUngrantedLock, true);
  assert.ok(observed.blockingPids.includes(blocker.backendPid));
  return observed;
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

function assertPublicError(error: unknown, code: string): void {
  assert.ok(error instanceof PublicApiError);
  assert.equal(error.details?.code, code);
}

async function counts(scenario: Scenario, fixture: AuthorizedFixture) {
  return {
    audits: await scenario.observer.client.auditLog.count({ where: { userId: fixture.userId } }),
    events: await scenario.observer.client.applicationEvent.count({ where: { userId: fixture.userId } })
  };
}

async function assertHealthy(scenario: Scenario, phase: string): Promise<void> {
  await assertNoIdleTransactions(scenario.observer, scenario.actors);
  for (const actor of scenario.actors) {
    await assertActorSessionPinned(actor, `${scenario.label}-${phase}`);
  }
}

test("race A: committed cover-letter edit wins before export authorization", { timeout: TEST_TIMEOUT_MS }, async () => {
  await runScenario("repair-b-edit-first", async (scenario) => {
    const fixture = await createAuthorizedFixture(scenario, "COVER_LETTER", "cover");
    const beforeCounts = await counts(scenario, fixture);
    const editedContent = `${fixture.content} edited first`;
    await scenario.actorB.client.generatedDocument.update({
      where: { id: fixture.sourceId },
      data: { content: editedContent }
    });
    const renderedInputs: Array<{ artifactType: ArtifactType; content: string }> = [];

    await assert.rejects(
      documentExportService(scenario.actorA.client, renderedInputs)
        .exportApprovedApplicationRunDocument(exportRequest(fixture)),
      (error) => {
        assertPublicError(error, "RUN_DOCUMENT_STALE");
        return true;
      }
    );

    assert.deepEqual(renderedInputs, []);
    const run = await scenario.observer.client.applicationRun.findUniqueOrThrow({ where: { id: fixture.runId } });
    assert.equal(run.coverLetterContentHash, sha256(fixture.content));
    assert.equal(run.currentAnswerPacketVersion, fixture.packetVersion);
    assert.equal((await scenario.observer.client.generatedDocument.findUniqueOrThrow({
      where: { id: fixture.sourceId }
    })).content, editedContent);
    assert.deepEqual(await counts(scenario, fixture), beforeCounts);
    await assertHealthy(scenario, "race-a-complete");
  });
});

for (const artifactType of ["RESUME", "COVER_LETTER"] as const) {
  test(`race B: ${artifactType} source update waits on export FOR SHARE and later exports stale`, {
    timeout: TEST_TIMEOUT_MS
  }, async () => {
    await runScenario(`repair-b-source-lock-${artifactType.toLowerCase()}`, async (scenario) => {
      const fixture = await createAuthorizedFixture(scenario, artifactType, artifactType.toLowerCase());
      const sourceLocked = deferred(`${artifactType} export source locked`);
      const releaseExport = trackRelease(scenario, deferred(`release ${artifactType} export source lock`));
      const exportHooks = hookedActor(scenario.actorA, [{
        name: `${artifactType} source FOR SHARE`,
        match: {
          kind: "queryRaw",
          includes: [
            artifactType === "RESUME" ? 'FROM "ResumeVersion"' : 'FROM "GeneratedDocument"',
            "FOR SHARE"
          ]
        },
        expectedMatches: 1,
        after: async () => {
          sourceLocked.resolve();
          await releaseExport.wait();
        }
      }]);
      const renderedInputs: Array<{ artifactType: ArtifactType; content: string }> = [];
      const exporting = trackOperation(
        scenario,
        documentExportService(exportHooks.prismaClient, renderedInputs)
          .exportApprovedApplicationRunDocument(exportRequest(fixture))
      );
      await sourceLocked.wait();
      const exportActivity = await scenario.observer.client.$queryRaw<Array<{
        state: string;
        transactionOpen: boolean;
      }>>(Prisma.sql`
        SELECT
          state,
          (xact_start IS NOT NULL) AS "transactionOpen"
        FROM pg_stat_activity
        WHERE pid = ${scenario.actorA.backendPid}
          AND application_name = ${scenario.actorA.applicationName}
      `);
      assert.deepEqual(exportActivity, [{ state: "idle in transaction", transactionOpen: true }]);

      const editedContent = `${fixture.content} edited after source lock`;
      const editing = trackOperation(
        scenario,
        Promise.resolve(artifactType === "RESUME"
          ? scenario.actorB.client.$queryRaw<Array<{ id: string }>>(Prisma.sql`
              UPDATE "ResumeVersion"
              SET "fullText" = ${editedContent}
              WHERE "id" = ${fixture.sourceId}
              RETURNING "id"
            `)
          : scenario.actorB.client.$queryRaw<Array<{ id: string }>>(Prisma.sql`
              UPDATE "GeneratedDocument"
              SET "content" = ${editedContent}, "updatedAt" = CURRENT_TIMESTAMP
              WHERE "id" = ${fixture.sourceId}
              RETURNING "id"
            `)
        )
      );
      const observed = await observeWait(scenario, scenario.actorB, scenario.actorA);
      assert.deepEqual(observed.blockingPids, [scenario.actorA.backendPid]);
      releaseExport.resolve();

      const [exportSettled, editSettled] = await settlePair(
        exporting,
        editing,
        `${artifactType} export versus source update`
      );
      const exported = fulfilled(exportSettled, scenario.actorA, `${artifactType} approved export`);
      fulfilled(editSettled, scenario.actorB, `${artifactType} source editor`);
      exportHooks.assertExpectedHooksReached();
      assert.deepEqual(renderedInputs, [{ artifactType, content: fixture.content }]);
      assert.equal(
        exported.bytes.toString("utf8"),
        `rendered:${artifactType}:${fixture.content}`
      );

      await assert.rejects(
        documentExportService(scenario.observer.client)
          .exportApprovedApplicationRunDocument(exportRequest(fixture)),
        (error) => {
          assertPublicError(error, "RUN_DOCUMENT_STALE");
          return true;
        }
      );
      const storedContent = artifactType === "RESUME"
        ? (await scenario.observer.client.resumeVersion.findUniqueOrThrow({ where: { id: fixture.sourceId } })).fullText
        : (await scenario.observer.client.generatedDocument.findUniqueOrThrow({ where: { id: fixture.sourceId } })).content;
      assert.equal(storedContent, editedContent);
      await assertHealthy(scenario, `race-b-${artifactType.toLowerCase()}-complete`);
    });
  });
}

test("race C: committed packet N+1 rejects an old packet-N export before source snapshot", {
  timeout: TEST_TIMEOUT_MS
}, async () => {
  await runScenario("repair-b-replacement-first", async (scenario) => {
    const fixture = await createAuthorizedFixture(scenario, "RESUME", "resume");
    const replacement = await packetService(scenario.actorB.client)
      .publishFormInspectionAndAnswerPacket(replacementRequest(fixture));
    assert.equal(replacement.packetVersion, fixture.packetVersion + 1);
    const oldExportHooks = hookedActor(scenario.actorA, [{
      name: "stale export does not lock source",
      match: { kind: "queryRaw", includes: ['FROM "ResumeVersion"', "FOR SHARE"] },
      expectedMatches: 0
    }]);
    const renderedInputs: Array<{ artifactType: ArtifactType; content: string }> = [];

    await assert.rejects(
      documentExportService(oldExportHooks.prismaClient, renderedInputs)
        .exportApprovedApplicationRunDocument(exportRequest(fixture)),
      (error) => {
        assertPublicError(error, "RUN_PACKET_STALE");
        return true;
      }
    );

    oldExportHooks.assertExpectedHooksReached();
    assert.deepEqual(renderedInputs, []);
    const run = await scenario.observer.client.applicationRun.findUniqueOrThrow({ where: { id: fixture.runId } });
    assert.equal(run.currentAnswerPacketVersion, fixture.packetVersion + 1);
    assert.equal(await scenario.observer.client.applicationRunAnswerPacket.count({
      where: { runId: fixture.runId }
    }), 2);
    await assertHealthy(scenario, "race-c-complete");
  });
});

test("race D: packet replacement waits on export run FOR SHARE and export keeps packet-N snapshot", {
  timeout: TEST_TIMEOUT_MS
}, async () => {
  await runScenario("repair-b-run-lock-first", async (scenario) => {
    const fixture = await createAuthorizedFixture(scenario, "COVER_LETTER", "cover");
    const runLocked = deferred("export run locked FOR SHARE");
    const releaseExport = trackRelease(scenario, deferred("release export run lock"));
    const exportHooks = hookedActor(scenario.actorA, [{
      name: "export ApplicationRun FOR SHARE",
      match: { kind: "queryRaw", includes: ['FROM "ApplicationRun"', "FOR SHARE"] },
      expectedMatches: 1,
      after: async () => {
        runLocked.resolve();
        await releaseExport.wait();
      }
    }]);
    const renderedInputs: Array<{ artifactType: ArtifactType; content: string }> = [];
    const exporting = trackOperation(
      scenario,
      documentExportService(exportHooks.prismaClient, renderedInputs)
        .exportApprovedApplicationRunDocument(exportRequest(fixture))
    );
    await runLocked.wait();

    const replacing = trackOperation(
      scenario,
      packetService(scenario.actorB.client).publishFormInspectionAndAnswerPacket(replacementRequest(fixture))
    );
    const observed = await observeWait(scenario, scenario.actorB, scenario.actorA);
    assert.deepEqual(observed.blockingPids, [scenario.actorA.backendPid]);
    releaseExport.resolve();

    const [exportSettled, replacementSettled] = await settlePair(
      exporting,
      replacing,
      "packet-N export versus material packet replacement"
    );
    const exported = fulfilled(exportSettled, scenario.actorA, "packet-N approved export");
    const replacement = fulfilled(replacementSettled, scenario.actorB, "packet N+1 replacement");
    exportHooks.assertExpectedHooksReached();
    assert.equal(replacement.packetVersion, fixture.packetVersion + 1);
    assert.deepEqual(renderedInputs, [{ artifactType: "COVER_LETTER", content: fixture.content }]);
    assert.equal(exported.bytes.toString("utf8"), `rendered:COVER_LETTER:${fixture.content}`);

    await assert.rejects(
      documentExportService(scenario.observer.client)
        .exportApprovedApplicationRunDocument(exportRequest(fixture)),
      (error) => {
        assertPublicError(error, "RUN_PACKET_STALE");
        return true;
      }
    );
    const run = await scenario.observer.client.applicationRun.findUniqueOrThrow({ where: { id: fixture.runId } });
    assert.equal(run.currentAnswerPacketVersion, fixture.packetVersion + 1);
    await assertHealthy(scenario, "race-d-complete");
  });
});
