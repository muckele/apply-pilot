import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { PrismaClient } from "@prisma/client";
import type { NextRequest } from "next/server";

import { loadApplyKitView } from "@/lib/apply-kit/apply-kit-view";
import { readSentDocumentsSnapshot } from "@/lib/apply-kit/sent-documents";
import { loadSentDocumentsView } from "@/lib/apply-kit/sent-documents-view";
import { documentContentHash } from "@/lib/documents/document-review";
import {
  editedConfirmed,
  editedCoverText,
  generatedCoverMetadata,
  generatedCoverText,
  generatedResumeMetadata,
  generatedResumeText
} from "@/tests/fixtures/apply-kit-documents";
import {
  assertPostgresTestMajorVersion,
  validatePostgresTestEnvironment,
  verifyLivePostgresTestDatabase
} from "@/tests/postgres/postgres-test-harness";

// WP1.5 end to end on the disposable PostgreSQL database: the real POST /api/applications route
// records "I applied" with a frozen sent snapshot, the Apply Kit and snapshot loaders read it back
// (including the JSON-path event filter), later edits do not change it, and other users see nothing.

async function invokeRoute(path: string, handler: () => Promise<Response>) {
  const { workAsyncStorage } = await import("next/dist/server/app-render/work-async-storage.external.js");
  const { workUnitAsyncStorage } = await import("next/dist/server/app-render/work-unit-async-storage.external.js");
  return workAsyncStorage.run({ route: path } as never, () =>
    workUnitAsyncStorage.run({ type: "request", phase: "action", headers: new Headers(), cookies: {} } as never, handler));
}

function jobData(userId: string, key: string) {
  const url = `https://jobs.example.test/apply/${key}`;
  return {
    userId,
    title: "Synthetic Platform Engineer",
    normalizedTitle: `synthetic-platform-engineer-${key}`,
    company: "Synthetic Example Co",
    normalizedCompany: `synthetic-example-co-${key}`,
    location: "Remote",
    normalizedLocation: `remote-${key}`,
    sourceUrl: url,
    applyUrl: url,
    normalizedApplyUrl: url,
    description: "Disposable Apply Kit fixture.",
    requirements: [],
    preferredQualifications: [],
    benefits: [],
    detectedTechStack: [],
    missingKeywords: [],
    supportedKeywords: [],
    concerns: [],
    sourceType: "MANUAL" as const
  };
}

test("Apply Kit 'I applied' freezes what was sent through the real route and database", { timeout: 60_000 }, async () => {
  const config = validatePostgresTestEnvironment(process.env);
  assertPostgresTestMajorVersion(await verifyLivePostgresTestDatabase(config));
  const client = new PrismaClient({ datasources: { db: { url: config.url } } });
  const owner = await client.user.create({ data: { email: `apply-kit-${randomUUID()}@example.test`, name: "Synthetic Apply Kit Owner" } });
  const other = await client.user.create({ data: { email: `apply-kit-other-${randomUUID()}@example.test`, name: "Synthetic Other User" } });
  const priorEnv = {
    ALLOW_DEMO_USER: process.env.ALLOW_DEMO_USER,
    DEFAULT_DEMO_USER_ID: process.env.DEFAULT_DEMO_USER_ID,
    AUTH_SECRET: process.env.AUTH_SECRET
  };
  const priorAsyncLocalStorage = globalThis.AsyncLocalStorage;
  Object.assign(process.env, { ALLOW_DEMO_USER: "true", DEFAULT_DEMO_USER_ID: owner.id, AUTH_SECRET: "synthetic-apply-kit-local-secret" });
  globalThis.AsyncLocalStorage = AsyncLocalStorage;
  try {
    const key = randomUUID();
    const job = await client.jobPosting.create({ data: jobData(owner.id, key) });
    const otherJob = await client.jobPosting.create({ data: jobData(other.id, `other-${key}`) });
    const master = await client.resume.create({ data: {
      userId: owner.id, isMaster: true, title: "Synthetic master", rawText: "Synthetic experience.", skills: [], achievements: []
    } });
    const analysis = await client.aIAnalysis.create({ data: {
      userId: owner.id, jobPostingId: job.id, type: "JOB_MATCH", model: "gemini-3.8-flash",
      promptName: "jobMatchPrompt", promptVersion: "3.5", input: {}, output: {}
    } });
    const snapshot = await client.evidenceSnapshot.create({ data: {
      userId: owner.id, jobPostingId: job.id, resumeId: master.id, reviewedAnalysisId: analysis.id,
      requestId: randomUUID(), requestHash: "a".repeat(64), sourceResumeUpdatedAt: master.updatedAt,
      snapshotHash: "b".repeat(64), sourceProjectionHash: "c".repeat(64), gapProjectionHash: "d".repeat(64),
      reviewPayload: { schema: "apply-pilot/evidence-snapshot-payload/v1", decisions: [] }
    } });
    await client.jobPosting.update({ where: { id: job.id }, data: { currentEvidenceSnapshotId: snapshot.id, evidenceSnapshotGeneration: 1 } });
    const resume = await client.resumeVersion.create({ data: {
      userId: owner.id, jobPostingId: job.id, resumeId: master.id, evidenceSnapshotId: snapshot.id,
      title: "Synthetic tailored resume", skills: [], fullText: generatedResumeText, metadata: generatedResumeMetadata
    } });
    const edited = editedConfirmed("COVER_LETTER", { evidenceSnapshotId: snapshot.id, content: generatedCoverText, metadata: generatedCoverMetadata }, editedCoverText);
    const cover = await client.generatedDocument.create({ data: {
      userId: owner.id, jobPostingId: job.id, type: "COVER_LETTER", title: "Synthetic cover letter",
      content: edited.content, evidenceSnapshotId: null, metadata: edited.metadata as object
    } });

    const before = await loadApplyKitView(client, { userId: owner.id, jobId: job.id, aiGenerationAvailable: false });
    assert.ok(before);
    assert.deepEqual([before.resumes[0]?.status, before.coverLetters[0]?.status], ["AI_GROUNDED", "EDITED_CONFIRMED"]);
    assert.equal(before.sent, null);
    assert.equal(await loadApplyKitView(client, { userId: other.id, jobId: job.id, aiGenerationAvailable: false }), null);

    const { POST } = await import("../../app/api/applications/route");
    const post = (body: Record<string, unknown>) => invokeRoute("/api/applications", () => POST(new Request("http://localhost/api/applications", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    }) as NextRequest));

    const foreign = await post({ jobPostingId: otherJob.id, status: "APPLIED" });
    assert.equal(foreign.status, 404);

    const response = await post({
      jobPostingId: job.id,
      status: "APPLIED",
      resumeVersionId: resume.id,
      coverLetterVersionId: cover.id,
      expectedResumeContentHash: documentContentHash(generatedResumeText),
      expectedCoverLetterContentHash: documentContentHash(editedCoverText)
    });
    assert.equal(response.status, 200, await response.clone().text());
    const application = await client.application.findUniqueOrThrow({
      where: { userId_jobPostingId: { userId: owner.id, jobPostingId: job.id } },
      include: { events: true }
    });
    assert.equal(application.status, "APPLIED");
    assert.ok(application.dateApplied);
    const frozen = readSentDocumentsSnapshot(application.events[0]?.metadata);
    assert.ok(frozen);
    assert.equal(frozen.resume?.contentHash, documentContentHash(generatedResumeText));
    assert.equal(frozen.coverLetter?.readinessState, "EDITED_READY");

    // Editing the live cover letter afterwards does not change what the tracker says was sent.
    await client.generatedDocument.update({ where: { id: cover.id }, data: { content: "Edited after sending." } });
    const after = await loadApplyKitView(client, { userId: owner.id, jobId: job.id, aiGenerationAvailable: false });
    assert.equal(after?.canRecordApplied, false);
    assert.equal(after?.sent?.coverLetter?.shortHash, documentContentHash(editedCoverText).slice(0, 12));
    const eventId = application.events[0]!.id;
    const sentView = await loadSentDocumentsView(client, { userId: owner.id, applicationId: application.id, eventId });
    assert.equal(sentView?.snapshot.coverLetter?.content, editedCoverText);
    assert.equal(await loadSentDocumentsView(client, { userId: other.id, applicationId: application.id, eventId }), null);
  } finally {
    for (const [name, value] of Object.entries(priorEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    globalThis.AsyncLocalStorage = priorAsyncLocalStorage;
    await client.user.deleteMany({ where: { id: { in: [owner.id, other.id] } } });
    await client.$disconnect();
  }
});
