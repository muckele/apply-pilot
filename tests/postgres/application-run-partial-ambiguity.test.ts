import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import { Prisma } from "@prisma/client";

import { PublicApiError } from "@/lib/api-errors";
import { computeApplicationAnswerPacketHash } from "@/lib/application-runs/answer-packet-domain";
import {
  createApplicationRunAnswerPacketService,
  loadVerifiedCurrentAnswerPacketForLockedRunInTransaction
} from "@/lib/application-runs/answer-packet-service";
import { createApplicationRunFillAttemptService } from "@/lib/application-runs/fill-attempt";
import {
  FORM_INSPECTION_SCHEMA_VERSION,
  canonicalizeFormComparisonText,
  computeFormFingerprint,
  hashDomainSeparated,
  type NormalizedApplicationFormSnapshot
} from "@/lib/application-runs/form-inspection";
import { createApplicationRunService } from "@/lib/application-runs/service";
import {
  createHookedPrismaClient,
  createPostgresTestActor,
  createSyntheticTestUser,
  deleteSyntheticTestUsers,
  disconnectPostgresTestActors,
  type PostgresTestActor
} from "@/tests/postgres/postgres-test-harness";

const APPLY_HOST = "jobs.example.test";
const AUTOMATION_ENV = { APPLICATION_AUTOMATION_ENABLED: "true" } as const;
const REVIEW_REASONS = ["evidence_gaps_present"] as const;
const INITIAL_STATE_VERSION = 4;
const TEST_TIMEOUT_MS = 30_000;

function field(question: string, helpText: string | null = null) {
  return {
    question,
    helpText,
    fieldType: "URL",
    unsupportedReason: null,
    required: true,
    autocomplete: "url",
    constraints: {
      minLength: null, maxLength: null, min: null, max: null, step: null,
      acceptedFileTypes: [] as string[], multiple: false
    },
    choices: []
  };
}

function report(fields: ReturnType<typeof field>[]) {
  return {
    schemaVersion: FORM_INSPECTION_SCHEMA_VERSION,
    forms: [{ title: "Application", sections: [{ heading: "Candidate", fields }] }]
  };
}

type Fixture = { actor: PostgresTestActor; userId: string; runId: string; applyUrl: string };

async function withFixture(label: string, body: (fixture: Fixture) => Promise<void>): Promise<void> {
  const actor = await createPostgresTestActor(label);
  let userId: string | null = null;
  try {
    const user = await createSyntheticTestUser(actor, label);
    userId = user.id;
    const key = randomUUID();
    const applyUrl = `https://${APPLY_HOST}/apply/${key}`;
    const job = await actor.client.jobPosting.create({
      data: {
        userId, title: `Partial ambiguity ${key}`, normalizedTitle: `partial-ambiguity-${key}`,
        company: "Disposable Employer", normalizedCompany: `disposable-employer-${key}`,
        location: "Remote", normalizedLocation: `remote-${key}`, remoteStatus: "REMOTE",
        sourceUrl: `https://${APPLY_HOST}/jobs/${key}`, applyUrl, normalizedApplyUrl: applyUrl,
        description: "Disposable partial ambiguity database fixture.", requirements: [],
        preferredQualifications: [], benefits: [], detectedTechStack: [], missingKeywords: [],
        supportedKeywords: [], concerns: [], sourceType: "MANUAL"
      }, select: { id: true }
    });
    const application = await actor.client.application.create({
      data: { userId, jobPostingId: job.id }, select: { id: true }
    });
    const run = await actor.client.applicationRun.create({
      data: {
        userId, jobPostingId: job.id, applicationId: application.id, state: "READY",
        stateVersion: INITIAL_STATE_VERSION, activeRunKey: application.id,
        idempotencyKey: `partial-ambiguity:${key}`, applyUrlSnapshot: applyUrl,
        applyHost: APPLY_HOST, reviewReasons: [...REVIEW_REASONS]
      }, select: { id: true }
    });
    await actor.client.applicationAutomationPolicy.create({
      data: {
        userId, enabled: true, mode: "FILL_AND_REVIEW", allowedHosts: [APPLY_HOST],
        blockedHosts: [], sensitiveAnswerPolicy: "EXCLUDE", finalReviewRequired: true
      }
    });
    await actor.client.applicationAnswer.create({
      data: {
        userId, category: "LINKS", question: "LinkedIn profile URL",
        normalizedQuestion: `linkedin-profile-url-${key}`,
        answer: `https://www.linkedin.com/in/${key}`
      }
    });
    await body({ actor, userId, runId: run.id, applyUrl });
  } finally {
    try {
      if (userId !== null) {
        await actor.client.auditLog.deleteMany({ where: { userId } });
        await deleteSyntheticTestUsers(actor, [userId]);
      }
    } finally {
      await disconnectPostgresTestActors([actor]);
    }
  }
}

function packetService(actor: PostgresTestActor) {
  return createApplicationRunAnswerPacketService({ prismaClient: actor.client, env: AUTOMATION_ENV });
}

function packetReadService(actor: PostgresTestActor) {
  return createApplicationRunAnswerPacketService({
    prismaClient: createHookedPrismaClient(actor, [], {
      requiredInteractiveTransactionIsolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead
    }).prismaClient,
    env: AUTOMATION_ENV
  });
}

function runService(actor: PostgresTestActor) {
  return createApplicationRunService({ prismaClient: actor.client, env: AUTOMATION_ENV });
}

function assertCode(code: string) {
  return (error: unknown) => {
    assert.ok(error instanceof PublicApiError);
    assert.equal(error.status, 409);
    assert.equal(error.details?.code, code);
    return true;
  };
}

test("real PostgreSQL keeps only unique answer authority across changed ambiguity and exact review", {
  timeout: TEST_TIMEOUT_MS
}, async () => withFixture("partial-ambiguity-mixed", async ({ actor, userId, runId, applyUrl }) => {
  const packets = packetService(actor);
  const runs = runService(actor);
  const duplicate = field("Portfolio URL");
  const unique = field("LinkedIn profile URL");
  const first = await packets.publishFormInspectionAndAnswerPacket({
    userId, runId, expectedStateVersion: INITIAL_STATE_VERSION,
    expectedFormInspectionVersion: 0, expectedAnswerPacketVersion: 0,
    observedUrl: applyUrl, inspectionReport: report([duplicate, duplicate, unique])
  });
  const inspection = await actor.client.applicationRunFormInspection.findUniqueOrThrow({
    where: { runId_version: { runId, version: first.inspectionVersion } }
  });
  const snapshot = inspection.normalizedSnapshot as unknown as NormalizedApplicationFormSnapshot;
  assert.equal(inspection.schemaVersion, 2);
  assert.equal(snapshot.ambiguityGroups?.length, 1);
  assert.equal(snapshot.forms[0].sections[0].ambiguousMembers?.length, 2);
  assert.equal(snapshot.forms[0].sections[0].fields.length, 1);
  const firstRows = await actor.client.applicationRunAnswer.findMany({
    where: { runId, answerPacket: { version: first.packetVersion } }
  });
  assert.equal(firstRows.length, 1);
  assert.equal(firstRows[0].originalQuestion, unique.question);
  assert.equal(first.packet.summary.observedFieldCount, 3);
  assert.equal(first.packet.summary.ambiguousQuestionCount, 2);
  assert.equal(first.packet.summary.manualRequiredCount, 2);
  const reloaded = await packetReadService(actor).getCurrentAnswerPacket({ userId, runId });
  assert.equal(reloaded.current?.packetHash, first.packetHash);
  assert.equal(reloaded.current?.answers.length, 1);

  await runs.reviewApplicationRunAnswer({
    userId, runId, answerId: firstRows[0].id, status: "APPROVED",
    answerPacketVersion: first.packetVersion
  });
  const baseReview = {
    userId, runId, stateVersion: first.stateVersion,
    acknowledgedReviewReasons: [...REVIEW_REASONS],
    answerPacketVersion: first.packetVersion, packetHash: first.packetHash
  };
  await assert.rejects(runs.resolveApplicationRunReview(baseReview), assertCode("RUN_PACKET_STALE"));
  await assert.rejects(runs.resolveApplicationRunReview({
    ...baseReview, acknowledgedAmbiguousQuestionCount: 1
  }), assertCode("RUN_PACKET_STALE"));
  const ready = await runs.resolveApplicationRunReview({
    ...baseReview, acknowledgedAmbiguousQuestionCount: 2
  });
  assert.equal(ready.state, "READY");

  const second = await packets.publishFormInspectionAndAnswerPacket({
    userId, runId, expectedStateVersion: ready.stateVersion,
    expectedFormInspectionVersion: first.inspectionVersion,
    expectedAnswerPacketVersion: first.packetVersion,
    observedUrl: applyUrl,
    inspectionReport: report([duplicate, field("Portfolio URL", "Optional portfolio"), unique])
  });
  assert.equal(second.replayed, false);
  assert.notEqual(second.packetHash, first.packetHash);
  assert.equal(second.inspectionVersion, first.inspectionVersion + 1);
  assert.equal(second.packetVersion, first.packetVersion + 1);
  assert.equal(second.state, "REVIEW_REQUIRED");
  await assert.rejects(runs.resolveApplicationRunReview(baseReview), assertCode("RUN_REVIEW_STALE"));
  const secondRows = await actor.client.applicationRunAnswer.findMany({
    where: { runId, answerPacket: { version: second.packetVersion } }
  });
  assert.equal(secondRows.length, 1);
  assert.equal(secondRows[0].normalizedFieldKey, firstRows[0].normalizedFieldKey);
  assert.equal(secondRows[0].status, "PENDING");
  await runs.reviewApplicationRunAnswer({
    userId, runId, answerId: secondRows[0].id, status: "APPROVED",
    answerPacketVersion: second.packetVersion
  });
  const secondReady = await runs.resolveApplicationRunReview({
    userId, runId, stateVersion: second.stateVersion,
    acknowledgedReviewReasons: [...REVIEW_REASONS],
    acknowledgedAmbiguousQuestionCount: 2,
    answerPacketVersion: second.packetVersion, packetHash: second.packetHash
  });
  assert.equal(secondReady.state, "READY");
  const acquired = await createApplicationRunFillAttemptService({
    prismaClient: actor.client, env: AUTOMATION_ENV, attemptIdGenerator: randomUUID
  }).acquireFillAttempt({ userId, runId, expectedStateVersion: secondReady.stateVersion });
  assert.equal(acquired.eligibleFields.length, 1);
  assert.equal(acquired.eligibleFields[0].normalizedFieldKey, secondRows[0].normalizedFieldKey);
  assert.equal(await actor.client.applicationRunStep.count({ where: { runId } }), 1);
}));

test("real PostgreSQL stores verified all-ambiguous empty packet and refuses Fill without mutation", {
  timeout: TEST_TIMEOUT_MS
}, async () => withFixture("partial-ambiguity-empty", async ({ actor, userId, runId, applyUrl }) => {
  const packets = packetService(actor);
  const runs = runService(actor);
  const duplicate = field("Portfolio URL");
  const published = await packets.publishFormInspectionAndAnswerPacket({
    userId, runId, expectedStateVersion: INITIAL_STATE_VERSION,
    expectedFormInspectionVersion: 0, expectedAnswerPacketVersion: 0,
    observedUrl: applyUrl, inspectionReport: report([duplicate, duplicate])
  });
  assert.equal(published.packet.answers.length, 0);
  assert.equal(published.packet.summary.observedFieldCount, 2);
  assert.equal(published.packet.summary.manualRequiredCount, 2);
  assert.equal(await actor.client.applicationRunAnswer.count({ where: { runId } }), 0);
  assert.equal((await packetReadService(actor).getCurrentAnswerPacket({ userId, runId })).current?.answers.length, 0);
  const review = {
    userId, runId, stateVersion: published.stateVersion,
    acknowledgedReviewReasons: [...REVIEW_REASONS],
    answerPacketVersion: published.packetVersion, packetHash: published.packetHash
  };
  await assert.rejects(runs.resolveApplicationRunReview(review), assertCode("RUN_PACKET_STALE"));
  const ready = await runs.resolveApplicationRunReview({
    ...review, acknowledgedAmbiguousQuestionCount: 2
  });
  assert.equal(ready.state, "READY");
  const before = await actor.client.applicationRun.findUniqueOrThrow({ where: { id: runId } });
  await assert.rejects(createApplicationRunFillAttemptService({
    prismaClient: actor.client, env: AUTOMATION_ENV, attemptIdGenerator: randomUUID
  }).acquireFillAttempt({ userId, runId, expectedStateVersion: ready.stateVersion }),
  assertCode("FILL_NO_ELIGIBLE_FIELDS"));
  const after = await actor.client.applicationRun.findUniqueOrThrow({ where: { id: runId } });
  assert.equal(after.state, before.state);
  assert.equal(after.stateVersion, before.stateVersion);
  assert.equal(after.fillAttemptId, null);
  assert.equal(await actor.client.applicationRunStep.count({ where: { runId } }), 0);
  assert.equal(await actor.client.auditLog.count({
    where: { userId, resourceId: runId, action: "application-run-fill-attempt.acquire" }
  }), 0);
}));

test("stored v1 inspection and builder-1 packet remain readable but require fresh inspection to rebuild", {
  timeout: TEST_TIMEOUT_MS
}, async () => withFixture("partial-ambiguity-legacy", async ({ actor, userId, runId, applyUrl }) => {
  const packets = packetService(actor);
  const published = await packets.publishFormInspectionAndAnswerPacket({
    userId, runId, expectedStateVersion: INITIAL_STATE_VERSION,
    expectedFormInspectionVersion: 0, expectedAnswerPacketVersion: 0,
    observedUrl: applyUrl, inspectionReport: report([field("LinkedIn profile URL")])
  });
  const run = await actor.client.applicationRun.findUniqueOrThrow({ where: { id: runId } });
  const verified = await actor.client.$transaction(async (tx) =>
    loadVerifiedCurrentAnswerPacketForLockedRunInTransaction(tx as never, {
      userId, run: run as never
    })
  );
  assert.ok(verified);
  const originalForm = verified.snapshot.forms[0];
  const originalSection = originalForm.sections[0];
  const sectionKey = hashDomainSeparated("application-form-section-key:v1\0", {
    fieldKeys: originalSection.fields.map((entry) => entry.normalizedFieldKey),
    heading: canonicalizeFormComparisonText(originalSection.heading ?? "")
  });
  const formKey = hashDomainSeparated("application-form-form-key:v1\0", {
    sectionKeys: [sectionKey], title: canonicalizeFormComparisonText(originalForm.title ?? "")
  });
  const v1 = {
    schemaVersion: 1 as const, normalizerVersion: 1 as const,
    classifierVersion: verified.snapshot.classifierVersion, fingerprintVersion: 1 as const,
    forms: [{ formKey, title: originalForm.title, sections: [{
      sectionKey, heading: originalSection.heading, fields: originalSection.fields
    }] }]
  };
  const formFingerprint = computeFormFingerprint(APPLY_HOST, v1);
  const packetHash = computeApplicationAnswerPacketHash({
    ...verified.packet, formFingerprint, builderVersion: 1
  }, verified.validationContext);
  await actor.client.applicationRunFormInspection.update({
    where: { id: verified.inspection.id },
    data: {
      schemaVersion: 1, normalizerVersion: 1, fingerprintVersion: 1,
      formFingerprint, normalizedSnapshot: v1 as Prisma.InputJsonValue
    }
  });
  await actor.client.applicationRunAnswerPacket.update({
    where: { id: verified.packetRecord.id }, data: { builderVersion: 1, packetHash }
  });
  const loaded = await packetReadService(actor).getCurrentAnswerPacket({ userId, runId });
  assert.equal(loaded.current?.packetHash, packetHash);
  assert.equal(loaded.current?.answers.length, 1);
  await assert.rejects(packets.rebuildCurrentAnswerPacket({
    userId, runId, expectedStateVersion: published.stateVersion,
    expectedFormInspectionVersion: published.inspectionVersion,
    expectedAnswerPacketVersion: published.packetVersion
  }), assertCode("RUN_INSPECTION_STALE"));
  assert.equal(await actor.client.applicationRunAnswerPacket.count({ where: { runId } }), 1);
}));
