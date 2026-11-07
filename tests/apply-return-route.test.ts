import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { after, test, type TestContext } from "node:test";

import type { NextRequest } from "next/server";

import { readApplyReturnRecord, resolveApplyReturn, type ApplyReturnEvent } from "@/lib/applications/apply-return";

// Exercises the real /api/jobs/[id]/apply-return route against an in-memory, owner-checking fake
// transaction. The demo-user fallback is the signed-in user; "user-other" owns the foreign job.

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

function initialStore() {
  return {
    jobs: [
      { id: JOB, userId: OWNER, status: "ACTIVE", company: "Example Co", applyUrl: "https://jobs.example.test/apply/123", sourceUrl: "https://jobs.example.test/postings/123" },
      { id: OTHER_JOB, userId: OTHER, status: "ACTIVE", company: "Other Co", applyUrl: "https://jobs.example.test/apply/999", sourceUrl: "https://jobs.example.test/postings/999" }
    ] as Row[],
    applications: [] as Row[],
    events: [] as Row[],
    audits: [] as Row[]
  };
}

type Store = ReturnType<typeof initialStore>;

function readPath(value: unknown, path: readonly string[]) {
  return path.reduce<unknown>((current, key) => (current && typeof current === "object" ? (current as Row)[key] : undefined), value);
}

// Evaluates the subset of Prisma filters the route uses, so a missing owner filter fails here.
function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (key === "userId_jobPostingId") {
      const compound = value as Row;
      return row.userId === compound.userId && row.jobPostingId === compound.jobPostingId;
    }
    if (key === "metadata") {
      const filter = value as { path: string[]; equals: unknown };
      return readPath(row.metadata, filter.path) === filter.equals;
    }
    if (value && typeof value === "object" && "in" in (value as Row)) return ((value as { in: unknown[] }).in).includes(row[key]);
    return row[key] === value;
  });
}

function newestFirst(left: Row, right: Row) {
  return (right.occurredAt as Date).getTime() - (left.occurredAt as Date).getTime() || String(right.id).localeCompare(String(left.id));
}

function fakeTransaction(store: Store) {
  return {
    async $queryRaw(strings: TemplateStringsArray, ...values: unknown[]) {
      assert.match(strings.join("?"), /FROM "JobPosting"[\s\S]*"userId"[\s\S]*FOR UPDATE/u);
      return store.jobs.filter((row) => row.id === values[0] && row.userId === values[1]).map((row) => ({ id: row.id }));
    },
    jobPosting: {
      async findFirst({ where }: { where: Row }) {
        assert.ok(where.userId, "job reads are owner-scoped");
        return structuredClone(store.jobs.find((row) => matches(row, where)) ?? null);
      },
      async update({ where, data }: { where: Row; data: Row }) {
        const row = store.jobs.find((candidate) => candidate.id === where.id)!;
        Object.assign(row, data);
        return structuredClone(row);
      }
    },
    application: {
      async findUnique({ where }: { where: Row }) {
        return structuredClone(store.applications.find((row) => matches(row, where)) ?? null);
      },
      async create({ data }: { data: Row }) {
        const created = { id: `application-${store.applications.length + 1}`, dateApplied: null, ...structuredClone(data) };
        store.applications.push(created);
        return structuredClone(created);
      },
      async update({ where, data }: { where: Row; data: Row }) {
        const row = store.applications.find((candidate) => candidate.id === where.id)!;
        Object.assign(row, data);
        return structuredClone(row);
      }
    },
    applicationEvent: {
      async findFirst({ where }: { where: Row }) {
        assert.ok(where.userId, "event reads are owner-scoped");
        return structuredClone(store.events.filter((row) => matches(row, where)).sort(newestFirst)[0] ?? null);
      },
      async create({ data }: { data: Row }) {
        // Like the database default, each later request gets a later timestamp.
        const previous = (store.events.at(-1)?.occurredAt as Date | undefined)?.getTime() ?? 0;
        const occurredAt = new Date(Math.max(Date.now(), previous + 1));
        const created = { id: `event-${store.events.length + 1}`, occurredAt, ...structuredClone(data) };
        store.events.push(created);
        return structuredClone(created);
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

async function act(jobId: string, body: unknown) {
  const { POST } = await import("../app/api/jobs/[id]/apply-return/route");
  return invokeRoute(`/api/jobs/${jobId}/apply-return`, () => POST(new Request(`http://localhost/api/jobs/${jobId}/apply-return`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  }) as NextRequest, { params: Promise.resolve({ id: jobId }) }));
}

function stateOf(store: Store) {
  const application = store.applications.find((row) => row.userId === OWNER && row.jobPostingId === JOB);
  return resolveApplyReturn({
    userId: OWNER,
    status: (application?.status ?? null) as never,
    events: store.events.filter((row) => row.applicationId === application?.id) as unknown as ApplyReturnEvent[]
  });
}

test("opening an unsaved job's application saves it to the tracker as Saved, never Applied, and records the opened moment", async (t) => {
  const db = await setup(t);
  const response = await act(JOB, { action: "OPENED" });
  assert.equal(response.status, 200, await response.clone().text());
  const body = await response.json();

  assert.equal(db.store.applications.length, 1);
  const application = db.store.applications[0]!;
  assert.equal(application.userId, OWNER);
  assert.equal(application.status, "SAVED");
  assert.equal(application.dateApplied, null, "opening a link is not applying");
  assert.equal(db.store.jobs[0]!.status, "ACTIVE", "the posting status is unchanged");

  assert.equal(db.store.events.length, 1);
  const event = db.store.events[0]!;
  assert.equal(event.type, "CREATED");
  assert.equal(event.userId, OWNER);
  assert.match(String(event.title), /opened the employer's application/iu);
  assert.doesNotMatch(String(event.title), /applied/iu);
  const record = readApplyReturnRecord(event.metadata);
  assert.equal(record?.kind, "OPENED");
  assert.equal(record?.kind === "OPENED" ? record.applyHost : null, "jobs.example.test");
  assert.deepEqual(body.opened, { eventId: event.id, openedAt: record?.kind === "OPENED" ? record.openedAt : null });
  assert.equal(db.store.audits[0]?.action, "application.opened");

  assert.equal(stateOf(db.store).pending?.openedEventId, event.id, "the question is now pending");
});

test("opening again from a saved application adds a timeline note and keeps the status", async (t) => {
  const db = await setup(t);
  await act(JOB, { action: "OPENED" });
  const second = await act(JOB, { action: "OPENED" });
  assert.equal(second.status, 200);
  assert.equal(db.store.applications.length, 1);
  assert.equal(db.store.applications[0]!.status, "SAVED");
  assert.equal(db.store.events.at(-1)!.type, "NOTE_ADDED");
  assert.equal(stateOf(db.store).pending?.openedEventId, db.store.events.at(-1)!.id, "the newest opened moment is asked about");
});

test("opening an application already recorded as applied records nothing and asks nothing", async (t) => {
  const db = await setup(t);
  db.mutate((store) => store.applications.push({ id: "application-applied", userId: OWNER, jobPostingId: JOB, status: "APPLIED", dateApplied: new Date("2026-11-05T12:00:00.000Z") }));
  const response = await act(JOB, { action: "OPENED" });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { opened: null });
  assert.deepEqual([db.store.events.length, db.store.audits.length], [0, 0]);
  assert.equal(db.store.applications[0]!.status, "APPLIED");
});

test("'Not applying' archives the application and the posting, remembering what it was, and closes the question", async (t) => {
  const db = await setup(t);
  await act(JOB, { action: "OPENED" });
  const openedEventId = db.store.events[0]!.id;
  db.mutate((store) => { store.applications[0]!.status = "INTERESTED"; });

  const response = await act(JOB, { action: "NOT_APPLYING" });
  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual((await response.json()).application, { id: db.store.applications[0]!.id, status: "ARCHIVED" });
  const application = db.store.applications[0]!;
  assert.equal(application.status, "ARCHIVED");
  assert.equal(application.dateApplied, null);
  assert.equal(application.followUpDueAt, null, "no follow-up for an archived application");
  assert.equal(db.store.jobs[0]!.status, "ARCHIVED");

  const event = db.store.events.at(-1)!;
  assert.equal(event.type, "STATUS_CHANGED");
  assert.equal(event.title, "Status changed to Archived");
  const record = readApplyReturnRecord(event.metadata);
  assert.deepEqual(
    record?.kind === "NOT_APPLYING" ? [record.openedEventId, record.previousStatus, record.previousPostingStatus] : null,
    [openedEventId, "INTERESTED", "ACTIVE"]
  );
  assert.equal(db.store.audits.at(-1)?.action, "application.not_applying");

  const state = stateOf(db.store);
  assert.equal(state.pending, null);
  assert.equal(state.declined?.eventId, event.id);

  const again = await act(JOB, { action: "NOT_APPLYING" });
  assert.equal(again.status, 409);
  assert.equal((await again.json()).code, "APPLY_RETURN_NOT_PENDING");
});

test("'Not applying' without an open question (never opened, or already applied elsewhere) is refused and changes nothing", async (t) => {
  const db = await setup(t);
  const never = await act(JOB, { action: "NOT_APPLYING" });
  assert.equal(never.status, 409);
  assert.equal((await never.json()).code, "APPLY_RETURN_NOT_PENDING");
  assert.deepEqual([db.store.applications.length, db.store.events.length, db.store.jobs[0]!.status], [0, 0, "ACTIVE"]);

  await act(JOB, { action: "OPENED" });
  // Recorded as applied on another device in the meantime.
  db.mutate((store) => { Object.assign(store.applications[0]!, { status: "APPLIED", dateApplied: new Date() }); store.jobs[0]!.status = "APPLIED"; });
  const stale = await act(JOB, { action: "NOT_APPLYING" });
  assert.equal(stale.status, 409);
  assert.equal(db.store.applications[0]!.status, "APPLIED");
  assert.equal(db.store.jobs[0]!.status, "APPLIED");
});

test("undoing 'Not applying' restores the earlier status and posting status and reopens the question", async (t) => {
  const db = await setup(t);
  await act(JOB, { action: "OPENED" });
  const openedEventId = db.store.events[0]!.id;
  await act(JOB, { action: "NOT_APPLYING" });
  const declineEventId = db.store.events.at(-1)!.id;

  const response = await act(JOB, { action: "UNDO_NOT_APPLYING" });
  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual((await response.json()).application, { id: db.store.applications[0]!.id, status: "SAVED" });
  assert.equal(db.store.applications[0]!.status, "SAVED");
  assert.ok(db.store.applications[0]!.followUpDueAt instanceof Date, "the Saved follow-up is scheduled again");
  assert.equal(db.store.jobs[0]!.status, "ACTIVE");
  const event = db.store.events.at(-1)!;
  assert.equal(event.type, "STATUS_CHANGED");
  assert.equal(event.title, "Status changed to Saved");
  const record = readApplyReturnRecord(event.metadata);
  assert.equal(record?.kind === "NOT_APPLYING_UNDONE" ? record.declineEventId : null, declineEventId);
  assert.equal(db.store.audits.at(-1)?.action, "application.not_applying_undone");
  assert.equal(stateOf(db.store).pending?.openedEventId, openedEventId);

  const again = await act(JOB, { action: "UNDO_NOT_APPLYING" });
  assert.equal(again.status, 409);
  assert.equal((await again.json()).code, "APPLY_RETURN_NOT_DECLINED");
});

test("undo leaves a posting status that changed after 'Not applying' alone", async (t) => {
  const db = await setup(t);
  await act(JOB, { action: "OPENED" });
  await act(JOB, { action: "NOT_APPLYING" });
  db.mutate((store) => { store.jobs[0]!.status = "EXPIRED"; });
  const response = await act(JOB, { action: "UNDO_NOT_APPLYING" });
  assert.equal(response.status, 200);
  assert.equal(db.store.jobs[0]!.status, "EXPIRED");
  assert.equal(db.store.applications[0]!.status, "SAVED");
});

test("another user's job cannot be opened, declined or undone, and nothing is written", async (t) => {
  const db = await setup(t);
  db.mutate((store) => {
    store.applications.push({ id: "application-foreign", userId: OTHER, jobPostingId: OTHER_JOB, status: "SAVED", dateApplied: null });
    store.events.push({
      id: "event-foreign",
      userId: OTHER,
      applicationId: "application-foreign",
      type: "CREATED",
      title: "Saved",
      occurredAt: new Date("2026-11-05T10:00:00.000Z"),
      metadata: { applyReturn: { schema: "apply-pilot/apply-return/v1", kind: "OPENED", openedAt: "2026-11-05T10:00:00.000Z", applyHost: "jobs.example.test" } }
    });
  });
  for (const action of ["OPENED", "NOT_APPLYING", "UNDO_NOT_APPLYING"]) {
    const response = await act(OTHER_JOB, { action });
    assert.equal(response.status, 404, action);
  }
  assert.equal(db.store.applications.find((row) => row.id === "application-foreign")?.status, "SAVED");
  assert.equal(db.store.jobs[1]!.status, "ACTIVE");
  assert.deepEqual([db.store.events.length, db.store.audits.length], [1, 0]);
});

test("unknown actions and extra fields are rejected", async (t) => {
  const db = await setup(t);
  for (const body of [{}, { action: "APPLIED" }, { action: "OPENED", status: "APPLIED" }]) {
    const response = await act(JOB, body);
    assert.equal(response.status, 422, JSON.stringify(body));
  }
  assert.deepEqual([db.store.applications.length, db.store.events.length], [0, 0]);
});
