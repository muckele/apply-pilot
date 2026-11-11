import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { after, test, type TestContext } from "node:test";

import type { NextRequest } from "next/server";

import { CURRENT_SNAPSHOT, generatedResumeMetadata, generatedResumeText } from "@/tests/fixtures/apply-kit-documents";

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

type Row = Record<string, unknown>;
const OWNER = "demo-user";
const JOB = "job-owner";
const MASTER_UPDATED = new Date("2026-11-01T00:00:00.000Z");
const FOLLOW_UP = new Date("2026-11-20T00:00:00.000Z");
const APPLIED = new Date("2026-11-05T00:00:00.000Z");

function stub(t: TestContext, owner: object, name: string, replacement: unknown) {
  const methods = owner as Record<string, unknown>;
  const original = methods[name];
  methods[name] = replacement;
  t.after(() => { methods[name] = original; });
}

function setEnv(t: TestContext) {
  const changes: Record<string, string> = { AUTH_SECRET: "synthetic-route-secret-without-session", ALLOW_DEMO_USER: "true", NODE_ENV: "test" };
  for (const [name, value] of Object.entries(changes)) {
    const prior = process.env[name];
    t.after(() => { if (prior === undefined) delete process.env[name]; else process.env[name] = prior; });
    process.env[name] = value;
  }
}

test("PATCH with only resumeVersionId keeps status, dateApplied and followUpDueAt", async (t) => {
  setEnv(t);
  const { prisma } = await import("@/lib/prisma");
  const application: Row = {
    id: "app-1", userId: OWNER, jobPostingId: JOB, status: "INTERESTED", dateApplied: APPLIED,
    followUpDueAt: FOLLOW_UP, nextAction: "Review the posting", resumeVersionId: null, coverLetterVersionId: null
  };
  const updates: Row[] = [];
  const tx = {
    async $queryRaw() { return [{ id: JOB }]; },
    jobPosting: {
      async findUniqueOrThrow() {
        return {
          id: JOB, userId: OWNER, status: "ACTIVE", currentEvidenceSnapshotId: CURRENT_SNAPSHOT, evidenceSnapshotGeneration: 1,
          currentEvidenceSnapshot: { id: CURRENT_SNAPSHOT, resumeId: `master-${OWNER}`, sourceResumeUpdatedAt: MASTER_UPDATED, snapshotHash: "a".repeat(64), reviewPayload: { schema: "apply-pilot/evidence-snapshot-payload/v1", decisions: [] } }
        };
      },
      async update() { throw new Error("posting status must not change"); }
    },
    resume: { async findFirst() { return { id: `master-${OWNER}`, updatedAt: MASTER_UPDATED }; } },
    application: {
      async findFirstOrThrow() { return structuredClone(application); },
      async update({ data }: { data: Row }) { updates.push(structuredClone(data)); return { ...application, ...data }; }
    },
    resumeVersion: {
      async findFirstOrThrow() {
        return { id: "resume-v2", userId: OWNER, jobPostingId: JOB, title: "Resume two", fullText: generatedResumeText, evidenceSnapshotId: CURRENT_SNAPSHOT, metadata: generatedResumeMetadata, createdAt: new Date("2026-11-02T01:00:00.000Z"), template: "CLASSIC", pageSize: "LETTER", fontFamily: "ARIAL", accentColor: "#0F766E", fontSize: 10, lineSpacing: 115 };
      }
    },
    generatedDocument: { async findFirstOrThrow() { throw new Error("no cover letter expected"); } },
    applicationEvent: { async create() { return {}; } },
    auditLog: { async create() { return {}; } }
  };
  stub(t, prisma.user, "upsert", async () => ({ id: OWNER }));
  stub(t, prisma, "$queryRaw", async () => [{ count: 1 }]);
  stub(t, prisma.rateLimitBucket, "deleteMany", async () => ({ count: 0 }));
  stub(t, prisma.application, "findFirstOrThrow", async () => ({ jobPostingId: JOB }));
  stub(t, prisma, "$transaction", async (work: (client: unknown) => Promise<unknown>) => work(tx));

  const { PATCH } = await import("../app/api/applications/[id]/route");
  const { workAsyncStorage } = await import("next/dist/server/app-render/work-async-storage.external.js");
  const { workUnitAsyncStorage } = await import("next/dist/server/app-render/work-unit-async-storage.external.js");
  const response = await workAsyncStorage.run({ route: "/api/applications/app-1" } as never, () =>
    workUnitAsyncStorage.run({ type: "request", phase: "action", headers: new Headers(), cookies: {} } as never, () =>
      PATCH(new Request("http://localhost/api/applications/app-1", {
        method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ resumeVersionId: "resume-v2" })
      }) as NextRequest, { params: Promise.resolve({ id: "app-1" }) })));
  assert.equal(response.status, 200);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].resumeVersionId, "resume-v2");
  assert.equal(updates[0].status, "INTERESTED");
  assert.equal(updates[0].dateApplied, undefined);
  assert.equal(updates[0].followUpDueAt, undefined);
  assert.equal(updates[0].nextAction, undefined);
});
