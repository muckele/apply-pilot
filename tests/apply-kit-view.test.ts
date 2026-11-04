import assert from "node:assert/strict";
import { test } from "node:test";

import { loadApplyKitView, parseApplyLink } from "@/lib/apply-kit/apply-kit-view";
import { loadSentDocumentsView, type SentDocumentsDb } from "@/lib/apply-kit/sent-documents-view";
import { SENT_DOCUMENTS_METADATA_KEY, buildSentDocumentsSnapshot } from "@/lib/apply-kit/sent-documents";
import { documentContentHash } from "@/lib/documents/document-review";
import {
  CURRENT_SNAPSHOT,
  editedConfirmed,
  editedCoverText,
  generatedCoverMetadata,
  generatedCoverText,
  generatedResumeText
} from "@/tests/fixtures/apply-kit-documents";
import { JOB, OTHER, OWNER, fakeDb, fixtures, type Where } from "@/tests/fixtures/apply-kit-db";

test("another user's job is not found and every query is scoped to the signed-in user", async () => {
  const { db, calls } = fakeDb(fixtures());
  assert.equal(await loadApplyKitView(db, { userId: OTHER, jobId: JOB, aiGenerationAvailable: true }), null);
  const view = await loadApplyKitView(db, { userId: OWNER, jobId: JOB, aiGenerationAvailable: true });
  assert.ok(view);
  for (const call of calls) {
    const where = call.where as Record<string, unknown>;
    const scoped = where.userId ?? (where.userId_jobPostingId as { userId?: string } | undefined)?.userId;
    assert.ok(scoped === OWNER || scoped === OTHER, `${call.model} query must be user scoped`);
  }
  const serialized = JSON.stringify(view);
  for (const leaked of ["OTHER USER PRIVATE", "OTHER-PRIVATE", "resume-foreign", "cover-foreign"]) {
    assert.equal(serialized.includes(leaked), false, leaked);
  }
});

test("documents carry their D031 state, version number, hash, and the ready version is selected", async () => {
  const { db } = fakeDb(fixtures());
  const view = (await loadApplyKitView(db, { userId: OWNER, jobId: JOB, aiGenerationAvailable: true }))!;
  assert.deepEqual(view.resumes.map((document) => [document.id, document.versionNumber, document.status]), [
    ["resume-v2", 2, "AI_GROUNDED"],
    ["resume-v1", 1, "NEEDS_REGENERATION"]
  ]);
  assert.equal(view.resumes[0]!.contentHash, documentContentHash(generatedResumeText));
  assert.equal(view.resumes[0]!.exportReady, true);
  assert.equal(view.resumes[0]!.editorHref, "/resumes/resume-v2");
  assert.deepEqual(view.coverLetters.map((document) => [document.id, document.versionNumber, document.status, document.exportReady]), [
    ["cover-edited", 2, "NEEDS_REVIEW", false],
    ["cover-legacy", 1, "LEGACY_CONFIRMED", true]
  ]);
  assert.equal(view.coverLetters[0]!.review.flags.length > 0, true);
  // Without an application selection, the newest export-ready version is preselected.
  assert.equal(view.selectedResumeId, "resume-v2");
  assert.equal(view.selectedCoverLetterId, "cover-legacy");
  assert.equal(view.generation.available, true);
  assert.deepEqual(view.applyLink, { href: "https://boards.greenhouse.io/exampleco/jobs/123", hostname: "boards.greenhouse.io", secure: true });
  assert.equal(view.application, null);
  assert.equal(view.canRecordApplied, true);
});

test("an edited-and-confirmed document is shown as ready", async () => {
  const data = fixtures();
  const confirmed = editedConfirmed("COVER_LETTER", { evidenceSnapshotId: CURRENT_SNAPSHOT, content: generatedCoverText, metadata: generatedCoverMetadata }, editedCoverText);
  Object.assign(data.generatedDocument[0]!, { content: confirmed.content, metadata: confirmed.metadata });
  const view = (await loadApplyKitView(fakeDb(data).db, { userId: OWNER, jobId: JOB, aiGenerationAvailable: true }))!;
  assert.equal(view.coverLetters[0]!.status, "EDITED_CONFIRMED");
  assert.equal(view.selectedCoverLetterId, "cover-edited");
});

test("the application's own selections win and a recorded sent snapshot is summarized", async () => {
  const data = fixtures();
  const snapshot = buildSentDocumentsSnapshot({
    currentEvidenceSnapshotId: CURRENT_SNAPSHOT,
    currentEvidenceSourceValid: true,
    recordedAt: new Date("2026-11-03T12:00:00.000Z"),
    resume: { row: data.resumeVersion[1]! as never, versionNumber: 2 },
    coverLetter: null
  });
  data.application.push({
    id: "application-1",
    userId: OWNER,
    jobPostingId: JOB,
    status: "APPLIED",
    dateApplied: new Date("2026-11-03T12:00:00.000Z"),
    resumeVersionId: "resume-v1",
    coverLetterVersionId: null,
    events: [{ id: "event-applied", occurredAt: new Date("2026-11-03T12:00:00.000Z"), metadata: { [SENT_DOCUMENTS_METADATA_KEY]: snapshot } }]
  });
  const view = (await loadApplyKitView(fakeDb(data).db, { userId: OWNER, jobId: JOB, aiGenerationAvailable: true }))!;
  assert.equal(view.selectedResumeId, "resume-v1");
  assert.equal(view.selectedCoverLetterId, null);
  assert.equal(view.application?.status, "APPLIED");
  assert.equal(view.canRecordApplied, false);
  assert.equal(view.sent?.href, "/applications/application-1/sent/event-applied");
  assert.deepEqual(view.sent?.resume && [view.sent.resume.versionNumber, view.sent.resume.shortHash], [2, documentContentHash(generatedResumeText).slice(0, 12)]);
  assert.equal(view.sent?.coverLetter, null);
});

test("empty and error states: no apply link, expired posting, no master résumé, AI unavailable", async () => {
  const data = fixtures();
  Object.assign(data.jobPosting[0]!, { applyUrl: null, sourceUrl: "", status: "EXPIRED" });
  data.resume = data.resume.filter((row) => row.userId !== OWNER);
  data.resumeVersion = [];
  data.generatedDocument = [];
  const view = (await loadApplyKitView(fakeDb(data).db, { userId: OWNER, jobId: JOB, aiGenerationAvailable: false }))!;
  assert.equal(view.applyLink, null);
  assert.equal(view.job.notice?.tone, "warning");
  assert.match(view.job.notice?.text ?? "", /expired/u);
  assert.deepEqual(view.resumes, []);
  assert.equal(view.generation.available, false);
  assert.match(view.generation.reason ?? "", /master résumé/u);

  const withResume = fixtures();
  withResume.resumeVersion = [];
  const noAi = (await loadApplyKitView(fakeDb(withResume).db, { userId: OWNER, jobId: JOB, aiGenerationAvailable: false }))!;
  assert.equal(noAi.generation.available, false);
  assert.match(noAi.generation.reason ?? "", /unavailable/u);
});

test("apply links must be http(s) without credentials and show their hostname", () => {
  assert.deepEqual(parseApplyLink("https://jobs.lever.co/example/abc/apply", ""), { href: "https://jobs.lever.co/example/abc/apply", hostname: "jobs.lever.co", secure: true });
  assert.deepEqual(parseApplyLink(null, "http://careers.example.com/role"), { href: "http://careers.example.com/role", hostname: "careers.example.com", secure: false });
  for (const value of ["javascript:alert(1)", "mailto:jobs@example.com", "ftp://example.com/a", "https://user:pass@example.com/x", "not a url", "", "data:text/html,hi"]) {
    assert.equal(parseApplyLink(value, ""), null, value);
  }
});

test("a sent snapshot page is owner-scoped and reads the frozen bytes, not the live document", async () => {
  const snapshot = buildSentDocumentsSnapshot({
    currentEvidenceSnapshotId: CURRENT_SNAPSHOT,
    currentEvidenceSourceValid: true,
    recordedAt: new Date("2026-11-03T12:00:00.000Z"),
    resume: null,
    coverLetter: { row: { id: "cover-1", title: "Cover", content: generatedCoverText, evidenceSnapshotId: CURRENT_SNAPSHOT, metadata: generatedCoverMetadata, createdAt: new Date("2026-11-02T00:00:00.000Z") }, versionNumber: 1 }
  });
  const events = [
    { id: "event-1", userId: OWNER, applicationId: "application-1", occurredAt: new Date("2026-11-03T12:00:00.000Z"), metadata: { [SENT_DOCUMENTS_METADATA_KEY]: snapshot }, application: { id: "application-1", userId: OWNER, jobPostingId: JOB, jobPosting: { title: "Platform Engineer", company: "Example Co" } } },
    { id: "event-plain", userId: OWNER, applicationId: "application-1", occurredAt: new Date("2026-11-03T12:00:00.000Z"), metadata: { resumeVersionId: null }, application: { id: "application-1", userId: OWNER, jobPostingId: JOB, jobPosting: { title: "Platform Engineer", company: "Example Co" } } }
  ];
  const wheres: Where[] = [];
  const db = {
    applicationEvent: {
      async findFirst(args: { where: Where }) {
        wheres.push(args.where);
        const application = args.where.application as { userId?: string } | undefined;
        return structuredClone(events.find((event) =>
          event.id === args.where.id && event.userId === args.where.userId &&
          event.applicationId === args.where.applicationId && (!application?.userId || application.userId === event.application.userId)) ?? null);
      }
    }
  } as unknown as SentDocumentsDb;
  assert.equal(await loadSentDocumentsView(db, { userId: OTHER, applicationId: "application-1", eventId: "event-1" }), null);
  assert.equal(await loadSentDocumentsView(db, { userId: OWNER, applicationId: "application-other", eventId: "event-1" }), null);
  assert.equal(await loadSentDocumentsView(db, { userId: OWNER, applicationId: "application-1", eventId: "event-plain" }), null);
  const view = await loadSentDocumentsView(db, { userId: OWNER, applicationId: "application-1", eventId: "event-1" });
  assert.equal(view?.snapshot.coverLetter?.content, generatedCoverText);
  assert.equal(view?.jobTitle, "Platform Engineer");
  for (const where of wheres) assert.ok(where.userId === OWNER || where.userId === OTHER);
});

test("document generation is offered only when a real provider is configured for both document features", async (t) => {
  const { isDocumentGenerationAvailable } = await import("@/lib/apply-kit/generation-availability");
  const names = ["AI_ENABLED", "AI_MOCK_MODE", "AI_PROVIDER", "AI_PROVIDER_OVERRIDES", "GEMINI_API_KEY"] as const;
  const prior = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  t.after(() => {
    for (const name of names) {
      if (prior[name] === undefined) delete process.env[name];
      else process.env[name] = prior[name];
    }
  });
  const set = (values: Partial<Record<(typeof names)[number], string>>) => {
    for (const name of names) delete process.env[name];
    Object.assign(process.env, values);
  };
  set({});
  assert.equal(isDocumentGenerationAvailable(), false);
  set({ AI_ENABLED: "true", AI_PROVIDER: "gemini" });
  assert.equal(isDocumentGenerationAvailable(), false, "no key");
  set({ AI_ENABLED: "true", AI_PROVIDER: "gemini", GEMINI_API_KEY: "synthetic-never-used", AI_MOCK_MODE: "true" });
  assert.equal(isDocumentGenerationAvailable(), false, "mock mode");
  set({ AI_ENABLED: "true", AI_PROVIDER: "gemini", GEMINI_API_KEY: "synthetic-never-used" });
  assert.equal(isDocumentGenerationAvailable(), true);
  set({ AI_ENABLED: "true", AI_PROVIDER: "kimi", GEMINI_API_KEY: "synthetic-never-used" });
  assert.equal(isDocumentGenerationAvailable(), false, "invalid provider fails closed");
});
