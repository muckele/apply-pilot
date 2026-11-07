import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { after, test, type TestContext } from "node:test";

import type { NextRequest } from "next/server";

import {
  APPLY_RETURN_METADATA_KEY,
  buildApplicationOpenedRecord,
  resolveApplyReturn,
  type ApplyReturnEvent
} from "@/lib/applications/apply-return";
import { latestSelfReportedEffort, readSelfReportedEffort } from "@/lib/applications/self-reported-effort";
import { SENT_DOCUMENTS_METADATA_KEY, readSentDocumentsSnapshot } from "@/lib/apply-kit/sent-documents";
import { documentContentHash } from "@/lib/documents/document-review";
import {
  CURRENT_SNAPSHOT,
  editedConfirmed,
  editedCoverText,
  editedUnconfirmed,
  generatedCoverMetadata,
  generatedCoverText,
  generatedResumeMetadata,
  generatedResumeText
} from "@/tests/fixtures/apply-kit-documents";

// Exercises the real /api/applications route modules against an in-memory, owner-checking fake
// transaction. The demo-user fallback is the signed-in user; "user-other" owns foreign rows.

const priorDatabaseUrl = process.env.DATABASE_URL;
const priorDirectUrl = process.env.DIRECT_URL;
const priorAsyncLocalStorage = globalThis.AsyncLocalStorage;
process.env.DATABASE_URL = "postgresql://invalid:invalid@127.0.0.1:1/invalid";
process.env.DIRECT_URL = "postgresql://invalid:invalid@127.0.0.1:1/invalid";
globalThis.AsyncLocalStorage = AsyncLocalStorage;
after(() => {
  if (priorDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = priorDatabaseUrl;
  if (priorDirectUrl === undefined) delete process.env.DIRECT_URL;
  else process.env.DIRECT_URL = priorDirectUrl;
  globalThis.AsyncLocalStorage = priorAsyncLocalStorage;
});

const OWNER = "demo-user";
const OTHER = "user-other";
const JOB = "job-owner";
const OTHER_JOB = "job-other";
const MASTER_UPDATED = new Date("2026-11-01T00:00:00.000Z");
const format = { template: "CLASSIC", pageSize: "LETTER", fontFamily: "ARIAL", accentColor: "#0F766E", fontSize: 10, lineSpacing: 115 };

type Row = Record<string, unknown>;

function stub(t: TestContext, owner: object, name: string, replacement: unknown) {
  const methods = owner as Record<string, unknown>;
  const original = methods[name];
  methods[name] = replacement;
  t.after(() => { methods[name] = original; });
}

function setEnv(t: TestContext) {
  const changes: Record<string, string> = {
    AUTH_SECRET: "synthetic-route-secret-without-session",
    ALLOW_DEMO_USER: "true",
    NODE_ENV: "test"
  };
  for (const [name, value] of Object.entries(changes)) {
    const prior = process.env[name];
    t.after(() => { if (prior === undefined) delete process.env[name]; else process.env[name] = prior; });
    process.env[name] = value;
  }
}

async function invokeRoute(path: string, handler: () => Promise<Response>) {
  const { workAsyncStorage } = await import("next/dist/server/app-render/work-async-storage.external.js");
  const { workUnitAsyncStorage } = await import("next/dist/server/app-render/work-unit-async-storage.external.js");
  return workAsyncStorage.run({ route: path } as never, () =>
    workUnitAsyncStorage.run({ type: "request", phase: "action", headers: new Headers(), cookies: {} } as never, handler));
}

function job(id: string, userId: string) {
  return {
    id,
    userId,
    status: "ACTIVE",
    currentEvidenceSnapshotId: CURRENT_SNAPSHOT,
    evidenceSnapshotGeneration: 1,
    currentEvidenceSnapshot: {
      id: CURRENT_SNAPSHOT,
      resumeId: `master-${userId}`,
      sourceResumeUpdatedAt: MASTER_UPDATED,
      snapshotHash: "a".repeat(64),
      reviewPayload: { schema: "apply-pilot/evidence-snapshot-payload/v1", decisions: [] }
    }
  };
}

function initialStore() {
  return {
    jobs: [job(JOB, OWNER), job(OTHER_JOB, OTHER)] as Row[],
    masters: [
      { id: `master-${OWNER}`, userId: OWNER, isMaster: true, updatedAt: MASTER_UPDATED },
      { id: `master-${OTHER}`, userId: OTHER, isMaster: true, updatedAt: MASTER_UPDATED }
    ] as Row[],
    resumeVersions: [
      { id: "resume-v1", userId: OWNER, jobPostingId: JOB, title: "Resume one", fullText: "Older resume text.", evidenceSnapshotId: "snapshot-old", metadata: null, createdAt: new Date("2026-11-01T01:00:00.000Z"), ...format },
      { id: "resume-v2", userId: OWNER, jobPostingId: JOB, title: "Resume two", fullText: generatedResumeText, evidenceSnapshotId: CURRENT_SNAPSHOT, metadata: generatedResumeMetadata, createdAt: new Date("2026-11-02T01:00:00.000Z"), ...format },
      { id: "resume-foreign", userId: OTHER, jobPostingId: OTHER_JOB, title: "Foreign", fullText: "Foreign private resume.", evidenceSnapshotId: CURRENT_SNAPSHOT, metadata: null, createdAt: new Date("2026-11-02T01:00:00.000Z"), ...format }
    ] as Row[],
    coverLetters: [
      { id: "cover-v1", userId: OWNER, jobPostingId: JOB, type: "COVER_LETTER", title: "Cover one", content: generatedCoverText, evidenceSnapshotId: CURRENT_SNAPSHOT, metadata: generatedCoverMetadata, createdAt: new Date("2026-11-02T02:00:00.000Z") }
    ] as Row[],
    applications: [] as Row[],
    events: [] as Row[],
    audits: [] as Row[]
  };
}

type Store = ReturnType<typeof initialStore>;

function notFound() {
  return new Error("No record was found for a query.");
}

function scopedMatch(row: Row, where: Row) {
  return Object.entries(where).every(([key, value]) => key === "OR" || row[key] === value);
}

function ordinalCount(rows: Row[], where: Row) {
  const or = where.OR as [{ createdAt: { lt: Date } }, { createdAt: Date; id: { lte: string } }];
  return rows.filter((row) => scopedMatch(row, where) && (
    (row.createdAt as Date) < or[0].createdAt.lt ||
    ((row.createdAt as Date).getTime() === or[1].createdAt.getTime() && String(row.id) <= or[1].id.lte)
  )).length;
}

function fakeTransaction(store: Store) {
  return {
    async $queryRaw(strings: TemplateStringsArray, ...values: unknown[]) {
      const sql = strings.join("?");
      assert.match(sql, /FROM "JobPosting"/u);
      return store.jobs.filter((row) => row.id === values[0] && row.userId === values[1]).map((row) => ({ id: row.id }));
    },
    jobPosting: {
      async findUniqueOrThrow({ where }: { where: Row }) {
        const row = store.jobs.find((candidate) => candidate.id === where.id);
        if (!row) throw notFound();
        return structuredClone(row);
      },
      async update({ where, data }: { where: Row; data: Row }) {
        const row = store.jobs.find((candidate) => candidate.id === where.id)!;
        Object.assign(row, data);
        return row;
      }
    },
    resume: {
      async findFirst({ where }: { where: Row }) {
        return structuredClone(store.masters.find((row) => row.userId === where.userId && row.isMaster === true) ?? null);
      }
    },
    application: {
      async findUnique({ where }: { where: { userId_jobPostingId: Row } }) {
        const key = where.userId_jobPostingId;
        return structuredClone(store.applications.find((row) => row.userId === key.userId && row.jobPostingId === key.jobPostingId) ?? null);
      },
      async findFirstOrThrow({ where }: { where: Row }) {
        const row = store.applications.find((candidate) => scopedMatch(candidate, where));
        if (!row) throw notFound();
        return structuredClone(row);
      },
      async findFirst({ where }: { where: Row }) {
        return structuredClone(store.applications.find((candidate) => scopedMatch(candidate, where)) ?? null);
      },
      async upsert({ where, create, update }: { where: { userId_jobPostingId: Row }; create: Row; update: Row }) {
        const key = where.userId_jobPostingId;
        const existing = store.applications.find((row) => row.userId === key.userId && row.jobPostingId === key.jobPostingId);
        const clean = (data: Row) => Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined));
        if (existing) {
          Object.assign(existing, clean(update));
          return structuredClone(existing);
        }
        const created = { id: `application-${store.applications.length + 1}`, dateApplied: null, ...clean(create) };
        store.applications.push(created);
        return structuredClone(created);
      },
      async update({ where, data }: { where: Row; data: Row }) {
        const row = store.applications.find((candidate) => candidate.id === where.id)!;
        Object.assign(row, Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined)));
        return structuredClone(row);
      }
    },
    resumeVersion: {
      async findFirstOrThrow({ where }: { where: Row }) {
        const row = store.resumeVersions.find((candidate) => scopedMatch(candidate, where));
        if (!row) throw notFound();
        return structuredClone(row);
      },
      async count({ where }: { where: Row }) {
        return ordinalCount(store.resumeVersions, where);
      }
    },
    generatedDocument: {
      async findFirstOrThrow({ where }: { where: Row }) {
        const row = store.coverLetters.find((candidate) => scopedMatch(candidate, where));
        if (!row) throw notFound();
        return structuredClone(row);
      },
      async count({ where }: { where: Row }) {
        return ordinalCount(store.coverLetters, where);
      }
    },
    applicationEvent: {
      async create({ data }: { data: Row }) {
        // Like the database default, each later request gets a later timestamp, even within one millisecond.
        const previous = (store.events.at(-1)?.occurredAt as Date | undefined)?.getTime() ?? 0;
        const occurredAt = new Date(Math.max(Date.now(), previous + 1));
        const created = { id: `event-${store.events.length + 1}`, occurredAt, ...structuredClone(data) };
        store.events.push(created);
        return created;
      }
    },
    auditLog: {
      async create({ data }: { data: Row }) {
        store.audits.push(structuredClone(data));
        return data;
      }
    }
  };
}

async function setup(t: TestContext) {
  setEnv(t);
  const { prisma } = await import("@/lib/prisma");
  let store = initialStore();
  stub(t, prisma.user, "upsert", async () => ({ id: OWNER }));
  stub(t, prisma, "$queryRaw", async () => [{ count: 1 }]);
  stub(t, prisma.rateLimitBucket, "deleteMany", async () => ({ count: 0 }));
  stub(t, prisma.application, "findFirstOrThrow", async (args: { where: Row }) => fakeTransaction(store).application.findFirstOrThrow(args));
  // Each transaction works on a copy that is committed only on success, like a rollback.
  stub(t, prisma, "$transaction", async (work: (tx: unknown) => Promise<unknown>) => {
    const working = structuredClone(store);
    const result = await work(fakeTransaction(working));
    store = working;
    return result;
  });
  return {
    get store() { return store; },
    mutate(change: (current: Store) => void) { change(store); }
  };
}

async function post(body: Record<string, unknown>) {
  const { POST } = await import("../app/api/applications/route");
  return invokeRoute("/api/applications", () => POST(new Request("http://localhost/api/applications", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  }) as NextRequest));
}

async function patch(id: string, body: Record<string, unknown>) {
  const { PATCH } = await import("../app/api/applications/[id]/route");
  return invokeRoute(`/api/applications/${id}`, () => PATCH(new Request(`http://localhost/api/applications/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  }) as NextRequest, { params: Promise.resolve({ id }) }));
}

async function postEffort(id: string, body: unknown) {
  const { POST } = await import("../app/api/applications/[id]/effort/route");
  return invokeRoute(`/api/applications/${id}/effort`, () => POST(new Request(`http://localhost/api/applications/${id}/effort`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  }) as NextRequest, { params: Promise.resolve({ id }) }));
}

function appliedBody(overrides: Record<string, unknown> = {}) {
  return {
    jobPostingId: JOB,
    status: "APPLIED",
    resumeVersionId: "resume-v2",
    coverLetterVersionId: "cover-v1",
    expectedResumeContentHash: documentContentHash(generatedResumeText),
    expectedCoverLetterContentHash: documentContentHash(generatedCoverText),
    ...overrides
  };
}

test("'I applied' creates the application as APPLIED and freezes exactly which versions were sent", async (t) => {
  const db = await setup(t);
  const response = await post(appliedBody());
  assert.equal(response.status, 200, await response.clone().text());
  const [application] = db.store.applications;
  assert.equal(application?.status, "APPLIED");
  assert.ok(application?.dateApplied instanceof Date);
  assert.ok(application?.followUpDueAt instanceof Date, "APPLIED schedules the default follow-up");
  assert.equal(application?.resumeVersionId, "resume-v2");
  assert.equal(application?.coverLetterVersionId, "cover-v1");
  assert.equal(db.store.events.length, 1);
  const event = db.store.events[0]!;
  assert.equal(event.type, "CREATED");
  const snapshot = readSentDocumentsSnapshot(event.metadata);
  assert.ok(snapshot, "the APPLIED event carries a valid sent snapshot");
  assert.deepEqual(
    [snapshot.resume?.documentId, snapshot.resume?.versionNumber, snapshot.resume?.contentHash, snapshot.resume?.readinessState],
    ["resume-v2", 2, documentContentHash(generatedResumeText), "EVIDENCE_CURRENT"]
  );
  assert.deepEqual(
    [snapshot.coverLetter?.documentId, snapshot.coverLetter?.versionNumber, snapshot.coverLetter?.contentHash],
    ["cover-v1", 1, documentContentHash(generatedCoverText)]
  );
  assert.equal(db.store.audits[0]?.action, "application.mark_applied");

  // A later edit of the live document does not change what the tracker says was sent.
  db.mutate((store) => { store.coverLetters[0]!.content = "Edited after sending."; });
  const frozen = readSentDocumentsSnapshot(db.store.events[0]!.metadata);
  assert.equal(frozen?.coverLetter?.content, generatedCoverText);
  assert.equal(frozen?.coverLetter?.contentHash, documentContentHash(generatedCoverText));

  // Marking applied again does not record a second snapshot.
  const again = await post(appliedBody({ expectedCoverLetterContentHash: undefined }));
  assert.equal(again.status, 200);
  assert.equal(db.store.events.filter((entry) => readSentDocumentsSnapshot(entry.metadata)).length, 1);
});

test("an edited-and-confirmed cover letter can be recorded as sent", async (t) => {
  const db = await setup(t);
  const confirmed = editedConfirmed("COVER_LETTER", { evidenceSnapshotId: CURRENT_SNAPSHOT, content: generatedCoverText, metadata: generatedCoverMetadata }, editedCoverText);
  db.mutate((store) => Object.assign(store.coverLetters[0]!, confirmed));
  const response = await post(appliedBody({ expectedCoverLetterContentHash: documentContentHash(editedCoverText) }));
  assert.equal(response.status, 200, await response.clone().text());
  const snapshot = readSentDocumentsSnapshot(db.store.events[0]!.metadata);
  assert.equal(snapshot?.coverLetter?.readinessState, "EDITED_READY");
  assert.equal(snapshot?.coverLetter?.content, editedCoverText);
});

test("documents that are stale, unreviewed or changed since the kit loaded are refused with 409 and nothing is written", async (t) => {
  const cases: Array<{ name: string; mutate: (store: Store) => void; body: Record<string, unknown>; code: string }> = [
    {
      name: "unconfirmed edited cover letter",
      mutate: (store) => Object.assign(store.coverLetters[0]!, editedUnconfirmed("COVER_LETTER", { evidenceSnapshotId: CURRENT_SNAPSHOT, content: generatedCoverText, metadata: generatedCoverMetadata }, editedCoverText)),
      body: appliedBody({ expectedCoverLetterContentHash: undefined }),
      code: "APPLICATION_DOCUMENT_REVIEW_REQUIRED"
    },
    {
      name: "résumé from older reviewed evidence",
      mutate: () => undefined,
      body: appliedBody({ resumeVersionId: "resume-v1", expectedResumeContentHash: undefined }),
      code: "APPLICATION_DOCUMENT_EVIDENCE_STALE"
    },
    {
      name: "document changed after the kit loaded",
      mutate: (store) => { store.resumeVersions[1]!.fullText = `${generatedResumeText}\n`; store.resumeVersions[1]!.evidenceSnapshotId = CURRENT_SNAPSHOT; },
      body: appliedBody(),
      code: "APPLICATION_SENT_DOCUMENT_CHANGED"
    }
  ];
  for (const item of cases) {
    await t.test(item.name, async (sub) => {
      const db = await setup(sub);
      db.mutate(item.mutate);
      const response = await post(item.body);
      assert.equal(response.status, 409);
      assert.equal((await response.json()).code, item.code);
      assert.deepEqual([db.store.applications.length, db.store.events.length, db.store.audits.length], [0, 0, 0]);
    });
  }
});

test("another user's job, résumé or application cannot be used or changed", async (t) => {
  const db = await setup(t);
  const foreignJob = await post(appliedBody({ jobPostingId: OTHER_JOB, resumeVersionId: undefined, coverLetterVersionId: null, expectedResumeContentHash: undefined, expectedCoverLetterContentHash: undefined }));
  assert.equal(foreignJob.status, 404);
  const foreignResume = await post(appliedBody({ resumeVersionId: "resume-foreign", expectedResumeContentHash: undefined }));
  assert.ok(foreignResume.status >= 400 && foreignResume.status < 500);
  db.mutate((store) => store.applications.push({ id: "application-foreign", userId: OTHER, jobPostingId: OTHER_JOB, status: "SAVED", dateApplied: null, resumeVersionId: null, coverLetterVersionId: null }));
  const foreignPatch = await patch("application-foreign", { status: "APPLIED" });
  assert.ok(foreignPatch.status >= 400 && foreignPatch.status < 500);
  assert.equal(db.store.applications.find((row) => row.id === "application-foreign")?.status, "SAVED");
  assert.deepEqual([db.store.events.length, db.store.audits.length], [0, 0]);
  assert.equal(db.store.applications.filter((row) => row.userId === OWNER).length, 0);
});

test("saving a packet records no sent snapshot; moving it to APPLIED through PATCH does", async (t) => {
  const db = await setup(t);
  const saved = await post({ jobPostingId: JOB, status: "SAVED", resumeVersionId: "resume-v2", coverLetterVersionId: null });
  assert.equal(saved.status, 200, await saved.clone().text());
  assert.equal(readSentDocumentsSnapshot(db.store.events[0]!.metadata), null);
  const id = String(db.store.applications[0]!.id);
  const applied = await patch(id, { status: "APPLIED" });
  assert.equal(applied.status, 200, await applied.clone().text());
  const event = db.store.events.at(-1)!;
  assert.equal(event.type, "STATUS_CHANGED");
  const snapshot = readSentDocumentsSnapshot(event.metadata);
  assert.equal(snapshot?.resume?.documentId, "resume-v2");
  assert.equal(snapshot?.coverLetter, null);
  assert.equal((event.metadata as Row)[SENT_DOCUMENTS_METADATA_KEY] !== undefined, true);
  // A later tracker update on an applied application records no new snapshot.
  const later = await patch(id, { status: "RECRUITER_SCREEN" });
  assert.equal(later.status, 200);
  assert.equal(readSentDocumentsSnapshot(db.store.events.at(-1)!.metadata), null);
});

test("a PATCH status change titles its timeline event with the readable status label", async (t) => {
  const db = await setup(t);
  const saved = await post({ jobPostingId: JOB, status: "SAVED", resumeVersionId: "resume-v2", coverLetterVersionId: null });
  assert.equal(saved.status, 200, await saved.clone().text());
  const id = String(db.store.applications[0]!.id);
  const moved = await patch(id, { status: "HIRING_MANAGER_SCREEN" });
  assert.equal(moved.status, 200, await moved.clone().text());
  assert.equal(db.store.events.at(-1)!.title, "Status changed to Hiring manager");
});

test("'I applied' keeps self-reported minutes on the APPLIED event, once, beside what was sent", async (t) => {
  const db = await setup(t);
  const response = await post(appliedBody({ effortMinutes: 45 }));
  assert.equal(response.status, 200, await response.clone().text());
  const event = db.store.events[0]!;
  assert.equal(readSelfReportedEffort(event.metadata)?.minutes, 45);
  assert.ok(readSentDocumentsSnapshot(event.metadata), "the same event still freezes what was sent");

  // Recording "I applied" again neither adds nor replaces the minutes.
  const again = await post(appliedBody({ effortMinutes: 90, expectedCoverLetterContentHash: undefined }));
  assert.equal(again.status, 200);
  const records = db.store.events.map((entry) => readSelfReportedEffort(entry.metadata)).filter(Boolean);
  assert.deepEqual(records.map((record) => record?.minutes), [45]);
});

test("minutes are optional and are only recorded when the application enters Applied", async (t) => {
  const db = await setup(t);
  const saved = await post({ jobPostingId: JOB, status: "SAVED", resumeVersionId: "resume-v2", coverLetterVersionId: null, effortMinutes: 20 });
  assert.equal(saved.status, 200, await saved.clone().text());
  assert.equal(readSelfReportedEffort(db.store.events[0]!.metadata), null);
  const applied = await post(appliedBody());
  assert.equal(applied.status, 200, await applied.clone().text());
  assert.equal(readSelfReportedEffort(db.store.events.at(-1)!.metadata), null);
  assert.ok(readSentDocumentsSnapshot(db.store.events.at(-1)!.metadata));
});

test("minutes that are not 1 to 600 whole minutes are refused and nothing is written", async (t) => {
  for (const effortMinutes of [0, -5, 12.5, 601, "45"]) {
    await t.test(JSON.stringify(effortMinutes), async (sub) => {
      const db = await setup(sub);
      const response = await post(appliedBody({ effortMinutes }));
      assert.equal(response.status, 422);
      assert.deepEqual([db.store.applications.length, db.store.events.length, db.store.audits.length], [0, 0, 0]);
    });
  }
});

test("minutes can be added later from the tracker, and a correction replaces the earlier answer", async (t) => {
  const db = await setup(t);
  assert.equal((await post(appliedBody())).status, 200);
  const id = String(db.store.applications[0]!.id);
  const timeline = () => db.store.events as Array<{ occurredAt: Date; metadata: unknown }>;
  assert.equal(latestSelfReportedEffort(timeline()), null);

  const added = await postEffort(id, { minutes: 50 });
  assert.equal(added.status, 200, await added.clone().text());
  assert.equal((await added.json()).effort.minutes, 50);
  const event = db.store.events.at(-1)!;
  assert.deepEqual([event.type, event.title, event.applicationId, event.userId], ["NOTE_ADDED", "Minutes this application took: 50", id, OWNER]);
  assert.equal(readSelfReportedEffort(event.metadata)?.minutes, 50);
  assert.equal(readSentDocumentsSnapshot(event.metadata), null, "a minutes correction never records a sent snapshot");
  assert.equal(db.store.audits.at(-1)?.action, "application.effort_recorded");

  const corrected = await postEffort(id, { minutes: 35 });
  assert.equal(corrected.status, 200);
  assert.equal(latestSelfReportedEffort(timeline())?.minutes, 35);
  assert.equal(db.store.applications[0]!.status, "APPLIED", "recording minutes changes nothing else");
});

test("minutes need an applied date, whole minutes in range, and the user's own application", async (t) => {
  const cases: Array<{ name: string; prepare: (store: Store) => string; body: unknown; status: number }> = [
    {
      name: "not applied yet",
      prepare: (store) => {
        store.applications.push({ id: "application-saved", userId: OWNER, jobPostingId: JOB, status: "SAVED", dateApplied: null });
        return "application-saved";
      },
      body: { minutes: 30 },
      status: 409
    },
    ...[0, 601, 12.5, "45", null].map((minutes) => ({
      name: `minutes ${JSON.stringify(minutes)}`,
      prepare: (store: Store) => {
        store.applications.push({ id: "application-applied", userId: OWNER, jobPostingId: JOB, status: "APPLIED", dateApplied: new Date("2026-11-03T18:00:00Z") });
        return "application-applied";
      },
      body: { minutes },
      status: 422
    })),
    {
      name: "another user's application",
      prepare: (store) => {
        store.applications.push({ id: "application-foreign", userId: OTHER, jobPostingId: OTHER_JOB, status: "APPLIED", dateApplied: new Date("2026-11-03T18:00:00Z") });
        return "application-foreign";
      },
      body: { minutes: 30 },
      status: 404
    }
  ];
  for (const item of cases) {
    await t.test(item.name, async (sub) => {
      const db = await setup(sub);
      let id = "";
      db.mutate((store) => { id = item.prepare(store); });
      const response = await postEffort(id, item.body);
      assert.equal(response.status, item.status, await response.clone().text());
      assert.deepEqual([db.store.events.length, db.store.audits.length], [0, 0]);
    });
  }
});

test("'Yes, I applied' after opening the application goes through this unchanged route and closes the question", async (t) => {
  const db = await setup(t);
  // The state "Did you apply?" leaves behind: a Saved application whose timeline holds an opened moment.
  db.mutate((store) => {
    store.applications.push({ id: "application-opened", userId: OWNER, jobPostingId: JOB, status: "SAVED", dateApplied: null, resumeVersionId: null, coverLetterVersionId: null });
    store.events.push({
      id: "event-opened",
      userId: OWNER,
      applicationId: "application-opened",
      type: "CREATED",
      title: "Saved when you opened the employer's application",
      occurredAt: new Date("2026-11-06T10:00:00.000Z"),
      metadata: { [APPLY_RETURN_METADATA_KEY]: buildApplicationOpenedRecord({ openedAt: new Date("2026-11-06T10:00:00.000Z"), applyHost: "jobs.example.test" }) }
    });
  });
  const events = () => db.store.events as unknown as ApplyReturnEvent[];
  assert.ok(resolveApplyReturn({ userId: OWNER, status: "SAVED", events: events() }).pending, "the question is open before the answer");

  const response = await post(appliedBody({ effortMinutes: 23 }));
  assert.equal(response.status, 200, await response.clone().text());
  const application = db.store.applications[0]!;
  assert.equal(application.status, "APPLIED");
  assert.ok(application.dateApplied instanceof Date);
  const appliedEvent = db.store.events.at(-1)!;
  assert.equal(appliedEvent.type, "STATUS_CHANGED");
  assert.ok(readSentDocumentsSnapshot(appliedEvent.metadata), "the exact documents are still frozen");
  assert.equal(readSelfReportedEffort(appliedEvent.metadata)?.minutes, 23);
  assert.equal(resolveApplyReturn({ userId: OWNER, status: "APPLIED", events: events() }).pending, null);
});
