import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { test, type TestContext } from "node:test";

import { toApplicationExportRow, type ApplicationExportRecord, type ApplicationExportRow } from "@/lib/applications/csv-export";
import { PublicApiError } from "@/lib/api-errors";
import { buildCurrentJobMatchContext, currentJobMatchInputHash } from "@/lib/jobs/current-job-match";
import { prisma } from "@/lib/prisma";

// Route modules load Next's request storage, so they are imported only after environment() installs AsyncLocalStorage.

function stub(t: TestContext, owner: object, name: string, replacement: unknown) {
  const methods = owner as Record<string, unknown>;
  const original = methods[name];
  methods[name] = replacement;
  t.after(() => { methods[name] = original; });
}

function environment(t: TestContext) {
  const changes: Record<string, string | undefined> = {
    DATABASE_URL: "postgresql://invalid:invalid@127.0.0.1:1/invalid",
    DIRECT_URL: "postgresql://invalid:invalid@127.0.0.1:1/invalid",
    AUTH_SECRET: "synthetic-test-secret",
    ALLOW_DEMO_USER: "true",
    DEFAULT_DEMO_USER_ID: "owner-1",
    NODE_ENV: "test"
  };
  for (const [name, value] of Object.entries(changes)) {
    const prior = process.env[name];
    t.after(() => { if (prior === undefined) delete process.env[name]; else process.env[name] = prior; });
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  const priorStorage = globalThis.AsyncLocalStorage;
  globalThis.AsyncLocalStorage = AsyncLocalStorage;
  t.after(() => { globalThis.AsyncLocalStorage = priorStorage; });
}

/** Minimal RFC 4180 parser used only to read the response back. */
function parseCsv(text: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === "\"" && text[index + 1] === "\"") { cell += "\""; index += 1; }
      else if (char === "\"") quoted = false;
      else cell += char;
    } else if (char === "\"") quoted = true;
    else if (char === ",") { row.push(cell); cell = ""; }
    else if (char === "\r" && text[index + 1] === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; index += 1; }
    else cell += char;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

async function csvText(response: Response) {
  const bytes = new Uint8Array(await response.arrayBuffer());
  assert.deepEqual([...bytes.slice(0, 3)], [0xef, 0xbb, 0xbf], "CSV starts with a UTF-8 BOM");
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes.slice(3));
}

function exportRecord(overrides: Partial<ApplicationExportRecord> = {}): ApplicationExportRecord {
  return {
    id: "app-1",
    userId: "owner-1",
    status: "APPLIED",
    createdAt: new Date("2026-10-01T15:00:00.000Z"),
    dateApplied: new Date("2026-10-03T18:30:00.000Z"),
    followUpDueAt: new Date("2026-10-10T00:00:00.000Z"),
    jobPosting: {
      company: "Acme, Inc.",
      title: "Solutions Engineer",
      sourceUrl: "https://boards.example.test/acme/jobs/1",
      applyUrl: null
    },
    resumeVersion: { id: "resume-v1", title: "Owner tailored resume", userId: "owner-1" },
    coverLetterVersion: { id: "letter-v1", title: "Owner cover letter", userId: "owner-1" },
    events: [{ title: "Status changed to APPLIED", occurredAt: new Date("2026-10-03T18:30:00.000Z") }],
    ...overrides
  };
}

type HandlerDependencies = {
  requireUserId: () => Promise<string>;
  checkRateLimit: (key: string, limit: number, windowMs: number) => Promise<void>;
  readApplicationExportRows: (userId: string) => Promise<ApplicationExportRow[]>;
  now: () => Date;
};

async function exportHandlers(t: TestContext, overrides: Partial<HandlerDependencies> = {}) {
  environment(t);
  const { createApplicationsExportRouteHandlers } = await import("@/lib/applications/export-route");
  return createApplicationsExportRouteHandlers({
    requireUserId: async () => "owner-1",
    checkRateLimit: async () => undefined,
    readApplicationExportRows: async () => [toApplicationExportRow(exportRecord(), { userId: "owner-1", fitScore: 84 })],
    now: () => new Date("2026-11-03T12:00:00.000Z"),
    ...overrides
  });
}

test("export GET authenticates, rate-limits per user, and returns a private CSV attachment", async (t) => {
  const calls: string[] = [];
  const handlers = await exportHandlers(t, {
    requireUserId: async () => { calls.push("auth"); return "owner-1"; },
    checkRateLimit: async (key) => { calls.push(`limit:${key}`); },
    readApplicationExportRows: async (userId) => { calls.push(`read:${userId}`); return []; }
  });
  const response = await handlers.GET();
  assert.deepEqual(calls, ["auth", "limit:applications:export:owner-1", "read:owner-1"]);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/csv; charset=utf-8");
  assert.equal(response.headers.get("content-disposition"), "attachment; filename=\"apply-pilot-applications-2026-11-03.csv\"");
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.match(await csvText(response), /^Company,Title,Status/);
});

test("export GET reads nothing when unauthenticated or rate-limited, and hides unexpected errors", async (t) => {
  let reads = 0;
  const { UnauthorizedError } = await import("@/lib/user-context");
  const unauthorized = await (await exportHandlers(t, {
    requireUserId: async () => { throw new UnauthorizedError(); },
    readApplicationExportRows: async () => { reads += 1; return []; }
  })).GET();
  assert.equal(unauthorized.status, 401);
  assert.equal(unauthorized.headers.get("cache-control"), "private, no-store");

  const limited = await (await exportHandlers(t, {
    checkRateLimit: async () => { throw new PublicApiError("Rate limit exceeded. Try again shortly.", 429); },
    readApplicationExportRows: async () => { reads += 1; return []; }
  })).GET();
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("cache-control"), "private, no-store");
  assert.equal(reads, 0);

  const failed = await (await exportHandlers(t, {
    readApplicationExportRows: async () => { throw new Error("connect ECONNREFUSED 10.0.0.5:5432 secret-host"); }
  })).GET();
  assert.equal(failed.status, 500);
  assert.equal(failed.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(await failed.json(), { error: "Applications could not be exported." });
});

async function invokeExportRoute() {
  const { GET } = await import("@/app/api/applications/export/route");
  const { workAsyncStorage } = await import("next/dist/server/app-render/work-async-storage.external.js");
  const { workUnitAsyncStorage } = await import("next/dist/server/app-render/work-unit-async-storage.external.js");
  return workAsyncStorage.run({ route: "/api/applications/export" } as never, () =>
    workUnitAsyncStorage.run(
      { type: "request", phase: "action", headers: new Headers(), cookies: {} } as never,
      () => GET()
    ));
}

const RESUME_UPDATED_AT = new Date("2026-09-30T00:00:00.000Z");
const OWNER_RESUME = {
  id: "resume-owner-1",
  updatedAt: RESUME_UPDATED_AT,
  summary: null,
  rawText: "Synthetic owner resume",
  skills: [],
  achievements: [],
  workHistory: [],
  projects: [],
  education: [],
  certifications: []
};

function storedJob(company: string, title: string) {
  return {
    title,
    company,
    location: "Remote",
    remoteStatus: "Remote",
    salaryMin: null,
    salaryMax: null,
    description: `${company} synthetic description`,
    requirements: [],
    preferredQualifications: [],
    detectedTechStack: [],
    sourceUrl: `https://${company.toLowerCase()}.example.test/jobs/1`,
    applyUrl: null,
    overallFitScore: 77,
    currentEvidenceSnapshotId: "snapshot-1",
    evidenceSnapshotGeneration: 1,
    currentEvidenceSnapshot: {
      id: "snapshot-1",
      resumeId: OWNER_RESUME.id,
      sourceResumeUpdatedAt: RESUME_UPDATED_AT,
      snapshotHash: "a".repeat(64),
      reviewPayload: { schema: "apply-pilot/evidence-snapshot-payload/v2", facts: [], unresolvedGapIds: [] }
    },
    aiAnalyses: [] as Array<{ id: string; inputHash: string; evidenceSnapshotId: string | null }>
  };
}

test("the wired export route only ever returns the signed-in user's applications", async (t) => {
  environment(t);
  const ownerJob = storedJob("OwnerCo", "Owner Role");
  const matchInput = buildCurrentJobMatchContext({ job: ownerJob, resume: OWNER_RESUME, profile: null }).matchInput;
  ownerJob.aiAnalyses = [{ id: "analysis-1", inputHash: currentJobMatchInputHash(matchInput), evidenceSnapshotId: "snapshot-1" }];
  const intruderJob = storedJob("IntruderCo", "Intruder Secret Role");
  intruderJob.aiAnalyses = ownerJob.aiAnalyses;
  const store = [
    { ...exportRecord({ id: "owner-app", userId: "owner-1" }), jobPosting: ownerJob },
    {
      ...exportRecord({
        id: "intruder-app",
        userId: "intruder-2",
        resumeVersion: { id: "intruder-resume", title: "Intruder resume", userId: "intruder-2" },
        coverLetterVersion: { id: "intruder-letter", title: "Intruder letter", userId: "intruder-2" },
        events: [{ title: "Intruder private event", occurredAt: new Date("2026-10-04T00:00:00.000Z") }]
      }),
      jobPosting: intruderJob
    }
  ];
  const queries: unknown[] = [];
  const scopedReads: string[] = [];
  stub(t, prisma.user, "upsert", async () => ({ id: "owner-1" }));
  stub(t, prisma, "$queryRaw", async () => [{ count: 1 }]);
  stub(t, prisma.rateLimitBucket, "deleteMany", async () => ({ count: 0 }));
  stub(t, prisma.resume, "findFirst", async ({ where }: { where: { userId: string } }) => {
    scopedReads.push(`resume:${where.userId}`);
    return where.userId === "owner-1" ? OWNER_RESUME : null;
  });
  stub(t, prisma.userProfile, "findUnique", async ({ where }: { where: { userId: string } }) => {
    scopedReads.push(`profile:${where.userId}`);
    return null;
  });
  stub(t, prisma.application, "findMany", async (args: { where?: { userId?: string } }) => {
    queries.push(args);
    // Behaves like the database: an unscoped query would return every user's rows.
    return store.filter((item) => args.where?.userId === undefined || item.userId === args.where.userId);
  });

  const response = await invokeExportRoute();
  assert.equal(response.status, 200);
  const csv = await csvText(response);

  const { applicationExportQuery } = await import("@/lib/applications/export-route");
  assert.equal(queries.length, 1);
  assert.deepEqual(queries[0], applicationExportQuery("owner-1"));
  assert.deepEqual((queries[0] as { where: unknown }).where, { userId: "owner-1" });
  assert.deepEqual(scopedReads.sort(), ["profile:owner-1", "resume:owner-1"]);

  const rows = parseCsv(csv);
  assert.equal(rows.length, 2);
  assert.equal(rows[1][0], "OwnerCo");
  assert.equal(rows[1][7], "77", "a current, hash-matched analysis keeps its fit score");
  assert.equal(rows[1][9], "resume-v1");
  assert.doesNotMatch(csv, /Intruder|intruder/);
});

test("a stale analysis exports a blank fit score instead of the denormalized number", async (t) => {
  environment(t);
  const job = storedJob("OwnerCo", "Owner Role");
  job.aiAnalyses = [{ id: "analysis-old", inputHash: "stale-hash", evidenceSnapshotId: "snapshot-1" }];
  stub(t, prisma.resume, "findFirst", async () => OWNER_RESUME);
  stub(t, prisma.userProfile, "findUnique", async () => null);
  stub(t, prisma.application, "findMany", async () => [{ ...exportRecord(), jobPosting: job }]);
  const { readApplicationExportRows } = await import("@/lib/applications/export-route");
  const [row] = await readApplicationExportRows("owner-1");
  assert.equal(row.fitScore, null);
});

test("the export query scopes nested events to the owner and selects no private notes or contact fields", async (t) => {
  environment(t);
  const { applicationExportQuery } = await import("@/lib/applications/export-route");
  const query = applicationExportQuery("owner-1");
  assert.deepEqual(query.where, { userId: "owner-1" });
  const select = query.select as Record<string, unknown>;
  for (const excluded of ["notes", "contactName", "contactEmail", "lessonsLearned", "outcome", "contacts", "emails", "nextAction"]) {
    assert.equal(Object.hasOwn(select, excluded), false, `${excluded} must not be exported`);
  }
  const events = select.events as { where: unknown; take: number; orderBy: unknown; select: Record<string, boolean> };
  assert.deepEqual(events.where, { userId: "owner-1" });
  assert.equal(events.take, 1);
  assert.deepEqual(events.orderBy, [{ occurredAt: "desc" }, { id: "desc" }]);
  assert.deepEqual(Object.keys(events.select).sort(), ["occurredAt", "title"]);
  for (const relation of ["resumeVersion", "coverLetterVersion"]) {
    const selected = (select[relation] as { select: Record<string, boolean> }).select;
    assert.deepEqual(Object.keys(selected).sort(), ["id", "title", "userId"]);
  }
});
