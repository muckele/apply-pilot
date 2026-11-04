import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import { PrismaClient } from "@prisma/client";

import {
  assertPostgresTestMajorVersion,
  validatePostgresTestEnvironment,
  verifyLivePostgresTestDatabase
} from "@/tests/postgres/postgres-test-harness";

// Runs only through the guarded `npm run test:postgres` runner against the disposable
// local apply_pilot_commit5_test database. Proves the additive MockInterviewSession
// migration: cascades on user and interview delete, SET NULL on application/job delete,
// and JSON-shape constraints.

const migrationName = "20261103120000_add_mock_interview_sessions";

async function guardedClient() {
  const config = validatePostgresTestEnvironment(process.env);
  const liveDatabase = await verifyLivePostgresTestDatabase(config);
  assertPostgresTestMajorVersion(liveDatabase);
  return new PrismaClient({ datasources: { db: { url: config.url } } });
}

async function createGraph(client: PrismaClient, label: string) {
  const suffix = randomUUID();
  const user = await client.user.create({ data: { email: `${label}-${suffix}@example.test` }, select: { id: true } });
  const job = await client.jobPosting.create({
    data: {
      userId: user.id,
      title: `${label} synthetic role`,
      normalizedTitle: `${label}-synthetic-role-${suffix}`,
      company: `${label} Synthetic Company`,
      normalizedCompany: `${label}-synthetic-company-${suffix}`,
      normalizedLocation: `remote-${suffix}`,
      sourceUrl: `https://example.test/jobs/${suffix}`,
      normalizedApplyUrl: `https://example.test/apply/${suffix}`,
      description: "Synthetic mock interview migration fixture.",
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
  const application = await client.application.create({
    data: { userId: user.id, jobPostingId: job.id },
    select: { id: true }
  });
  const interview = await client.interview.create({
    data: { userId: user.id, jobPostingId: job.id, applicationId: application.id, type: "TECHNICAL" },
    select: { id: true }
  });
  return { userId: user.id, jobId: job.id, applicationId: application.id, interviewId: interview.id };
}

const questions = [{
  questionId: "q1",
  category: "BEHAVIORAL",
  question: "Tell me about a time you led an incident response.",
  lookingFor: "Ownership.",
  jobLine: { lineId: "L1", text: "Incident response experience", source: "requirement" },
  factIds: []
}];

function sessionData(graph: Awaited<ReturnType<typeof createGraph>>, links: { interview?: boolean; application?: boolean }) {
  return {
    userId: graph.userId,
    interviewId: links.interview ? graph.interviewId : null,
    applicationId: links.application ? graph.applicationId : null,
    jobPostingId: graph.jobId,
    title: "Synthetic Company - Synthetic role",
    questions,
    model: "gemini-3.8-flash",
    promptVersion: "1",
    requestHash: "f".repeat(64)
  };
}

test("the mock interview migration is applied with an additive table and defaults", async () => {
  const client = await guardedClient();
  try {
    const migrationRows = await client.$queryRawUnsafe<Array<{ count: bigint }>>(
      'SELECT COUNT(*)::bigint AS count FROM "_prisma_migrations" WHERE migration_name = $1 AND finished_at IS NOT NULL',
      migrationName
    );
    assert.equal(migrationRows[0]?.count, 1n);

    const graph = await createGraph(client, "mock-defaults");
    const session = await client.mockInterviewSession.create({ data: sessionData(graph, { interview: true }) });
    assert.deepEqual(session.answers, {});
    assert.equal(session.revision, 0);
    assert.equal(session.completedAt, null);
    await client.user.delete({ where: { id: graph.userId } });
  } finally {
    await client.$disconnect();
  }
});

test("deleting an interview or the user cascades to their mock sessions", async () => {
  const client = await guardedClient();
  try {
    const graph = await createGraph(client, "mock-cascade");
    const linked = await client.mockInterviewSession.create({ data: sessionData(graph, { interview: true }) });
    const unlinked = await client.mockInterviewSession.create({ data: sessionData(graph, { application: true }) });

    await client.interview.delete({ where: { id: graph.interviewId } });
    assert.equal(await client.mockInterviewSession.count({ where: { id: linked.id } }), 0);
    assert.equal(await client.mockInterviewSession.count({ where: { id: unlinked.id } }), 1);

    await client.user.delete({ where: { id: graph.userId } });
    assert.equal(await client.mockInterviewSession.count({ where: { userId: graph.userId } }), 0);
  } finally {
    await client.$disconnect();
  }
});

test("deleting an application or job keeps the session and clears the link", async () => {
  const client = await guardedClient();
  try {
    const graph = await createGraph(client, "mock-set-null");
    const session = await client.mockInterviewSession.create({ data: sessionData(graph, { application: true }) });

    await client.application.delete({ where: { id: graph.applicationId } });
    const afterApplication = await client.mockInterviewSession.findUniqueOrThrow({ where: { id: session.id } });
    assert.equal(afterApplication.applicationId, null);
    assert.equal(afterApplication.jobPostingId, graph.jobId);

    await client.jobPosting.delete({ where: { id: graph.jobId } });
    const afterJob = await client.mockInterviewSession.findUniqueOrThrow({ where: { id: session.id } });
    assert.equal(afterJob.jobPostingId, null);
    assert.deepEqual(afterJob.questions, questions, "the stored questions keep their posting lines");

    await client.user.delete({ where: { id: graph.userId } });
  } finally {
    await client.$disconnect();
  }
});

test("JSON shape and revision constraints reject malformed rows", async () => {
  const client = await guardedClient();
  try {
    const graph = await createGraph(client, "mock-checks");
    const base = sessionData(graph, { interview: true });
    await assert.rejects(client.mockInterviewSession.create({ data: { ...base, questions: { not: "an array" } } }));
    await assert.rejects(client.mockInterviewSession.create({ data: { ...base, answers: ["not", "an", "object"] } }));
    await assert.rejects(client.mockInterviewSession.create({ data: { ...base, revision: -1 } }));
    await assert.rejects(client.mockInterviewSession.create({ data: { ...base, requestHash: "not-a-hash" } }));
    assert.equal(await client.mockInterviewSession.count({ where: { userId: graph.userId } }), 0);
    await client.user.delete({ where: { id: graph.userId } });
  } finally {
    await client.$disconnect();
  }
});
