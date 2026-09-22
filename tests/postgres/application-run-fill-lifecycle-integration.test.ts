import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import { PublicApiError } from "@/lib/api-errors";
import { createApplicationRunAnswerPacketService } from "@/lib/application-runs/answer-packet-service";
import { createApplicationRunFillAttemptService } from "@/lib/application-runs/fill-attempt";
import { FORM_INSPECTION_SCHEMA_VERSION } from "@/lib/application-runs/form-inspection";
import { createApplicationRunService } from "@/lib/application-runs/service";
import {
  createPostgresTestActor,
  createSyntheticTestUser,
  deleteSyntheticTestUsers,
  disconnectPostgresTestActors
} from "@/tests/postgres/postgres-test-harness";

const TEST_TIMEOUT_MS = 30_000;
const APPLY_HOST = "jobs.example.test";
const AUTOMATION_ENV = { APPLICATION_AUTOMATION_ENABLED: "true" } as const;
const REVIEW_REASONS = ["evidence_gaps_present"] as const;
const INITIAL_STATE_VERSION = 4;

function formReport(material = false) {
  const constraints = {
    minLength: null,
    maxLength: null,
    min: null,
    max: null,
    step: null,
    acceptedFileTypes: [] as string[],
    multiple: false
  };
  return {
    schemaVersion: FORM_INSPECTION_SCHEMA_VERSION,
    forms: [{
      title: "Application",
      sections: [{
        heading: "Candidate",
        fields: [
          {
            question: "LinkedIn profile URL",
            helpText: material ? "Provide your current professional profile URL." : null,
            fieldType: "URL",
            unsupportedReason: null,
            required: true,
            autocomplete: "url",
            constraints,
            choices: []
          }
        ]
      }]
    }]
  };
}

async function reviewCurrentPacket(
  runService: ReturnType<typeof createApplicationRunService>,
  prismaClient: Awaited<ReturnType<typeof createPostgresTestActor>>["client"],
  userId: string,
  runId: string,
  packetVersion: number
): Promise<void> {
  const pendingAnswers = await prismaClient.applicationRunAnswer.findMany({
    where: { runId, userId, status: "PENDING", answerPacket: { version: packetVersion } },
    select: {
      id: true,
      disposition: true,
      proposal: true,
      sensitive: true,
      valueRedacted: true,
      fieldFingerprint: true,
      fieldType: true
    }
  });
  assert.ok(pendingAnswers.length > 0);
  for (const answer of pendingAnswers) {
    const approvable = (
      answer.disposition === "PROPOSABLE" &&
      answer.proposal !== null &&
      !answer.sensitive &&
      !answer.valueRedacted &&
      answer.fieldFingerprint !== null &&
      answer.fieldType !== null
    );
    await runService.reviewApplicationRunAnswer({
      userId,
      runId,
      answerId: answer.id,
      status: approvable ? "APPROVED" : "REJECTED",
      answerPacketVersion: packetVersion
    });
  }
}

test("a permanent Fill attempt survives material reinspection and blocks a second production acquisition", {
  timeout: TEST_TIMEOUT_MS
}, async () => {
  const actors = [] as Awaited<ReturnType<typeof createPostgresTestActor>>[];
  let userId: string | null = null;

  try {
    const actor = await createPostgresTestActor("fill-lifecycle-integration");
    actors.push(actor);
    const user = await createSyntheticTestUser(actor, "fill-lifecycle-integration");
    userId = user.id;
    const key = randomUUID();
    const applyUrl = `https://${APPLY_HOST}/apply/${key}`;
    const job = await actor.client.jobPosting.create({
      data: {
        userId: user.id,
        title: `Fill lifecycle role ${key}`,
        normalizedTitle: `fill-lifecycle-role-${key}`,
        company: "Fill Lifecycle Employer",
        normalizedCompany: `fill-lifecycle-employer-${key}`,
        location: "Remote",
        normalizedLocation: `remote-${key}`,
        remoteStatus: "REMOTE",
        sourceUrl: `https://${APPLY_HOST}/jobs/${key}`,
        applyUrl,
        normalizedApplyUrl: applyUrl,
        description: "Disposable Commit 5 permanent Fill-attempt lifecycle fixture.",
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
    const application = await actor.client.application.create({
      data: { userId: user.id, jobPostingId: job.id },
      select: { id: true }
    });
    const run = await actor.client.applicationRun.create({
      data: {
        userId: user.id,
        jobPostingId: job.id,
        applicationId: application.id,
        state: "READY",
        stateVersion: INITIAL_STATE_VERSION,
        activeRunKey: application.id,
        idempotencyKey: `fill-lifecycle:${key}`,
        applyUrlSnapshot: applyUrl,
        applyHost: APPLY_HOST,
        reviewReasons: [...REVIEW_REASONS]
      },
      select: { id: true }
    });
    await actor.client.applicationAutomationPolicy.create({
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
    await actor.client.applicationAnswer.create({
      data: {
        userId: user.id,
        category: "LINKS",
        question: "LinkedIn profile URL",
        normalizedQuestion: `linkedin-profile-url-${key}`,
        answer: `https://www.linkedin.com/in/${key}`
      }
    });

    const packetService = createApplicationRunAnswerPacketService({
      prismaClient: actor.client,
      env: AUTOMATION_ENV
    });
    const runService = createApplicationRunService({ prismaClient: actor.client, env: AUTOMATION_ENV });
    const attemptId = randomUUID();
    const fillService = createApplicationRunFillAttemptService({
      prismaClient: actor.client,
      env: AUTOMATION_ENV,
      attemptIdGenerator: () => attemptId
    });

    const initialPacket = await packetService.publishFormInspectionAndAnswerPacket({
      userId: user.id,
      runId: run.id,
      expectedStateVersion: INITIAL_STATE_VERSION,
      expectedFormInspectionVersion: 0,
      expectedAnswerPacketVersion: 0,
      observedUrl: `${applyUrl}#initial`,
      inspectionReport: formReport()
    });
    await reviewCurrentPacket(runService, actor.client, user.id, run.id, initialPacket.packetVersion);
    const ready = await runService.resolveApplicationRunReview({
      userId: user.id,
      runId: run.id,
      stateVersion: initialPacket.stateVersion,
      acknowledgedReviewReasons: [...REVIEW_REASONS],
      answerPacketVersion: initialPacket.packetVersion,
      packetHash: initialPacket.packetHash
    });
    assert.equal(ready.state, "READY");

    const acquired = await fillService.acquireFillAttempt({
      userId: user.id,
      runId: run.id,
      expectedStateVersion: ready.stateVersion
    });
    const finalized = await fillService.finalizeFillAttempt({
      userId: user.id,
      runId: run.id,
      fillAttemptId: attemptId,
      expectedStateVersion: acquired.runStateVersion,
      outcome: "COMPLETED",
      errorCode: null,
      steps: acquired.eligibleFields.map((field) => ({
        stepKey: `fill:${attemptId}:${field.normalizedFieldKey}`,
        result: "FILLED" as const,
        errorCode: null
      }))
    });
    assert.equal(finalized.state, "READY_FOR_USER_SUBMISSION");
    const initial = await actor.client.applicationRun.findUniqueOrThrow({ where: { id: run.id } });
    const initialPacketRecord = await actor.client.applicationRunAnswerPacket.findUniqueOrThrow({
      where: { runId_version: { runId: run.id, version: initial.currentAnswerPacketVersion } }
    });
    assert.equal(initial.state, "READY_FOR_USER_SUBMISSION");
    assert.equal(initial.fillAttemptId, attemptId);
    assert.equal(initial.fillLeaseExpiresAt, null);
    assert.ok(initial.currentFormInspectionVersion > 0);
    assert.ok(initial.currentAnswerPacketVersion > 0);
    assert.ok(initialPacketRecord.reviewedAt instanceof Date);

    const material = await packetService.publishFormInspectionAndAnswerPacket({
      userId: user.id,
      runId: run.id,
      expectedStateVersion: initial.stateVersion,
      expectedFormInspectionVersion: initial.currentFormInspectionVersion,
      expectedAnswerPacketVersion: initial.currentAnswerPacketVersion,
      observedUrl: `${applyUrl}#material-reinspection`,
      inspectionReport: formReport(true)
    });
    const reinspected = await actor.client.applicationRun.findUniqueOrThrow({ where: { id: run.id } });
    const materialPacket = await actor.client.applicationRunAnswerPacket.findUniqueOrThrow({
      where: { runId_version: { runId: run.id, version: material.packetVersion } }
    });
    assert.equal(material.replayed, false);
    assert.equal(reinspected.state, "REVIEW_REQUIRED");
    assert.equal(reinspected.stateVersion, initial.stateVersion + 1);
    assert.equal(reinspected.fillAttemptId, attemptId);
    assert.equal(reinspected.fillLeaseExpiresAt, null);
    assert.equal(reinspected.currentFormInspectionVersion, initial.currentFormInspectionVersion + 1);
    assert.equal(reinspected.currentAnswerPacketVersion, initial.currentAnswerPacketVersion + 1);
    assert.equal(materialPacket.reviewedAt, null);

    await reviewCurrentPacket(runService, actor.client, user.id, run.id, material.packetVersion);
    const resolved = await runService.resolveApplicationRunReview({
      userId: user.id,
      runId: run.id,
      stateVersion: reinspected.stateVersion,
      acknowledgedReviewReasons: [...REVIEW_REASONS],
      answerPacketVersion: material.packetVersion,
      packetHash: material.packetHash
    });
    const postResolution = await actor.client.applicationRun.findUniqueOrThrow({ where: { id: run.id } });
    const postResolutionCurrentPacket = await actor.client.applicationRunAnswerPacket.findUniqueOrThrow({
      where: { runId_version: { runId: run.id, version: postResolution.currentAnswerPacketVersion } }
    });
    assert.equal(resolved.state, "READY_FOR_USER_SUBMISSION");
    assert.equal(postResolution.state, "READY_FOR_USER_SUBMISSION");
    assert.equal(postResolution.stateVersion, reinspected.stateVersion + 1);
    assert.equal(postResolution.fillAttemptId, attemptId);
    assert.equal(postResolution.fillLeaseExpiresAt, null);
    assert.equal(postResolution.currentFormInspectionVersion, reinspected.currentFormInspectionVersion);
    assert.equal(postResolution.currentAnswerPacketVersion, reinspected.currentAnswerPacketVersion);
    assert.equal(postResolution.currentAnswerPacketVersion, material.packetVersion);
    assert.equal(postResolutionCurrentPacket.id, materialPacket.id);
    assert.equal(postResolutionCurrentPacket.version, materialPacket.version);
    assert.ok(postResolutionCurrentPacket.reviewedAt instanceof Date);

    const currentPacketBeforeDeniedAcquire = await actor.client.applicationRunAnswerPacket.findUniqueOrThrow({
      where: { runId_version: { runId: run.id, version: postResolution.currentAnswerPacketVersion } }
    });
    const currentPacketAnswersBeforeDeniedAcquire = await actor.client.applicationRunAnswer.findMany({
      where: { runId: run.id, userId: user.id, answerPacketId: currentPacketBeforeDeniedAcquire.id },
      orderBy: [{ normalizedFieldKey: "asc" }, { id: "asc" }]
    });
    const beforeDeniedAcquire = {
      currentFormInspectionVersion: postResolution.currentFormInspectionVersion,
      currentAnswerPacketVersion: postResolution.currentAnswerPacketVersion,
      currentPacket: currentPacketBeforeDeniedAcquire,
      currentPacketAnswers: currentPacketAnswersBeforeDeniedAcquire,
      zeroMutationCounts: {
        steps: await actor.client.applicationRunStep.count({ where: { runId: run.id, userId: user.id } }),
        acquisitionAudits: await actor.client.auditLog.count({
          where: { userId: user.id, resourceId: run.id, action: "application-run-fill-attempt.acquire" }
        }),
        events: await actor.client.applicationEvent.count({ where: { userId: user.id, applicationId: application.id } }),
        packets: await actor.client.applicationRunAnswerPacket.count({ where: { runId: run.id, userId: user.id } })
      }
    };
    await assert.rejects(
      fillService.acquireFillAttempt({
        userId: user.id,
        runId: run.id,
        expectedStateVersion: postResolution.stateVersion
      }),
      (error: unknown) => {
        assert.ok(error instanceof PublicApiError);
        assert.equal(error.status, 409);
        assert.equal(error.details?.code, "FILL_ALREADY_IN_PROGRESS");
        return true;
      }
    );
    const afterDeniedAcquire = await actor.client.applicationRun.findUniqueOrThrow({ where: { id: run.id } });
    assert.equal(afterDeniedAcquire.state, "READY_FOR_USER_SUBMISSION");
    assert.equal(afterDeniedAcquire.stateVersion, postResolution.stateVersion);
    assert.equal(afterDeniedAcquire.fillAttemptId, attemptId);
    assert.equal(afterDeniedAcquire.fillLeaseExpiresAt, null);
    assert.equal(afterDeniedAcquire.currentFormInspectionVersion, beforeDeniedAcquire.currentFormInspectionVersion);
    assert.equal(afterDeniedAcquire.currentAnswerPacketVersion, beforeDeniedAcquire.currentAnswerPacketVersion);
    const currentPacketAfterDeniedAcquire = await actor.client.applicationRunAnswerPacket.findUniqueOrThrow({
      where: { runId_version: { runId: run.id, version: afterDeniedAcquire.currentAnswerPacketVersion } }
    });
    const currentPacketAnswersAfterDeniedAcquire = await actor.client.applicationRunAnswer.findMany({
      where: { runId: run.id, userId: user.id, answerPacketId: currentPacketAfterDeniedAcquire.id },
      orderBy: [{ normalizedFieldKey: "asc" }, { id: "asc" }]
    });
    assert.deepEqual(currentPacketAfterDeniedAcquire, beforeDeniedAcquire.currentPacket);
    assert.deepEqual(currentPacketAnswersAfterDeniedAcquire, beforeDeniedAcquire.currentPacketAnswers);
    assert.deepEqual({
      steps: await actor.client.applicationRunStep.count({ where: { runId: run.id, userId: user.id } }),
      acquisitionAudits: await actor.client.auditLog.count({
        where: { userId: user.id, resourceId: run.id, action: "application-run-fill-attempt.acquire" }
      }),
      events: await actor.client.applicationEvent.count({ where: { userId: user.id, applicationId: application.id } }),
      packets: await actor.client.applicationRunAnswerPacket.count({ where: { runId: run.id, userId: user.id } })
    }, beforeDeniedAcquire.zeroMutationCounts);
    assert.deepEqual([
      initial.fillAttemptId,
      reinspected.fillAttemptId,
      postResolution.fillAttemptId,
      afterDeniedAcquire.fillAttemptId
    ], [attemptId, attemptId, attemptId, attemptId]);
  } finally {
    try {
      if (userId !== null && actors[0]) {
        await actors[0].client.auditLog.deleteMany({ where: { userId } });
        await deleteSyntheticTestUsers(actors[0], [userId]);
      }
    } finally {
      await disconnectPostgresTestActors(actors);
    }
  }
});
