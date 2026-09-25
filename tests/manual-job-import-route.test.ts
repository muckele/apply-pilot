import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { test, type TestContext } from "node:test";
import type { NextRequest } from "next/server";

import { prisma } from "@/lib/prisma";

const posting = {
  title: "Solutions Engineer", company: "Example Co", location: "Remote",
  sourceUrl: "https://example.test/jobs/123", description: "A synthetic role requiring customer discovery and SQL experience.",
  runMatch: true
};

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
    OPENAI_API_KEY: undefined, OPENAI_MOCK_MODE: undefined,
    AUTH_SECRET: "synthetic-test-secret", ALLOW_DEMO_USER: "true", NODE_ENV: "test"
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

async function invoke(body: unknown) {
  const { POST } = await import("@/app/api/jobs/import/route");
  const { workAsyncStorage } = await import("next/dist/server/app-render/work-async-storage.external.js");
  const { workUnitAsyncStorage } = await import("next/dist/server/app-render/work-unit-async-storage.external.js");
  return workAsyncStorage.run({ route: "/api/jobs/import" } as never, () =>
    workUnitAsyncStorage.run(
      { type: "request", phase: "action", headers: new Headers(), cookies: {} } as never,
      () => POST(new Request("http://localhost/api/jobs/import", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body)
      }) as NextRequest)
    ));
}

async function invokeStandaloneScore() {
  const { POST } = await import("@/app/api/jobs/[id]/match/route");
  const { workAsyncStorage } = await import("next/dist/server/app-render/work-async-storage.external.js");
  const { workUnitAsyncStorage } = await import("next/dist/server/app-render/work-unit-async-storage.external.js");
  return workAsyncStorage.run({ route: "/api/jobs/job-1/match" } as never, () =>
    workUnitAsyncStorage.run(
      { type: "request", phase: "action", headers: new Headers(), cookies: {} } as never,
      () => POST(new Request("http://localhost/api/jobs/job-1/match", { method: "POST" }) as NextRequest,
        { params: Promise.resolve({ id: "job-1" }) })
    ));
}

function setup(t: TestContext, options: { cachedScore?: boolean; unexpectedError?: boolean; auditFailure?: boolean } = {}) {
  environment(t);
  const jobs = new Map<string, Record<string, unknown>>();
  const applications = new Map<string, Record<string, unknown>>();
  let scoreWrites = 0;
  stub(t, prisma.user, "upsert", async () => ({ id: "demo-user" }));
  stub(t, prisma, "$queryRaw", async () => [{ count: 1 }]);
  stub(t, prisma.rateLimitBucket, "deleteMany", async () => ({ count: 0 }));
  stub(t, prisma.auditLog, "create", async () => {
    if (options.auditFailure) throw new Error("synthetic audit failure");
    return { id: "audit-1" };
  });
  stub(t, prisma.jobPosting, "upsert", async (args: { where: Record<string, Record<string, string>>; create: Record<string, unknown> }) => {
    const key = JSON.stringify(args.where.userId_normalizedCompany_normalizedTitle_normalizedLocation_normalizedApplyUrl);
    if (!jobs.has(key)) jobs.set(key, {
      ...args.create, id: "job-1", overallFitScore: options.cachedScore ? 81 : null,
      confidenceScore: options.cachedScore ? 90 : null
    });
    return jobs.get(key);
  });
  stub(t, prisma.application, "upsert", async (args: { where: { userId_jobPostingId: { userId: string; jobPostingId: string } }; create: Record<string, unknown> }) => {
    const key = JSON.stringify(args.where.userId_jobPostingId);
    if (!applications.has(key)) applications.set(key, { ...args.create, id: "application-1" });
    return applications.get(key);
  });
  stub(t, prisma.jobPosting, "findFirstOrThrow", async ({ where }: { where: { id: string; userId: string } }) => {
    assert.deepEqual(where, { id: "job-1", userId: "demo-user" });
    if (options.unexpectedError) throw new Error("synthetic scoring failure");
    return [...jobs.values()][0];
  });
  stub(t, prisma.resume, "findFirst", async () => null);
  stub(t, prisma.userProfile, "findUnique", async () => null);
  stub(t, prisma.aIAnalysis, "findFirst", async () => options.cachedScore ? {
    model: "gpt-4o-mini", output: { overallFitScore: 81, confidenceScore: 90 }
  } : null);
  stub(t, prisma.jobPosting, "update", async () => { scoreWrites++; throw new Error("unexpected score write"); });
  return { jobs, applications, get scoreWrites() { return scoreWrites; } };
}

test("manual import returns persisted job, application and real cached match", async (t) => {
  const state = setup(t, { cachedScore: true });
  const response = await invoke(posting);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.scoring.status, "scored");
  assert.equal(result.job.id, [...state.jobs.values()][0]?.id);
  assert.equal(result.application.id, [...state.applications.values()][0]?.id);
  assert.equal(result.job.userId, "demo-user");
  assert.equal(result.application.userId, "demo-user");
  assert.equal(result.match.match.overallFitScore, 81);
});

test("unavailable scoring returns partial success, null scores and deduplicated identities", async (t) => {
  const state = setup(t);
  const first = await invoke(posting);
  assert.equal(first.status, 200);
  const firstResult = await first.json();
  assert.equal(firstResult.scoring.status, "unavailable");
  assert.equal(firstResult.match, null);
  assert.equal(firstResult.job.id, [...state.jobs.values()][0]?.id);
  assert.equal(firstResult.application.id, [...state.applications.values()][0]?.id);
  assert.equal(firstResult.job.userId, "demo-user");
  assert.equal(firstResult.application.userId, "demo-user");
  assert.equal(firstResult.job.overallFitScore, null);
  assert.equal(firstResult.job.confidenceScore, null);
  const second = await invoke(posting);
  assert.equal(second.status, 200);
  const secondResult = await second.json();
  assert.equal(secondResult.job.id, firstResult.job.id);
  assert.equal(secondResult.application.id, firstResult.application.id);
  assert.equal(state.jobs.size, 1);
  assert.equal(state.applications.size, 1);
  assert.equal(state.scoreWrites, 0);
});

test("standalone score match still returns unavailable and cannot write scores", async (t) => {
  const state = setup(t);
  await invoke({ ...posting, runMatch: false });
  const response = await invokeStandaloneScore();
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /unavailable in local mode/);
  assert.equal(state.scoreWrites, 0);
  assert.equal([...state.jobs.values()][0]?.overallFitScore, null);
  assert.equal([...state.jobs.values()][0]?.confidenceScore, null);
});

test("an audit write failure after persistence cannot turn a real import into an error", async (t) => {
  const state = setup(t, { auditFailure: true });
  const response = await invoke({ ...posting, runMatch: false });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.scoring.status, "not_requested");
  assert.equal(result.job.id, [...state.jobs.values()][0]?.id);
  assert.equal(result.application.id, [...state.applications.values()][0]?.id);
});

test("unexpected scoring error preserves import identity and reports scoring failure", async (t) => {
  const state = setup(t, { unexpectedError: true });
  const response = await invoke(posting);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.scoring.status, "failed");
  assert.equal(result.match, null);
  assert.equal(result.job.id, [...state.jobs.values()][0]?.id);
  assert.equal(result.application.id, [...state.applications.values()][0]?.id);
  assert.equal(state.scoreWrites, 0);
});

test("invalid import fails before persistence", async (t) => {
  const state = setup(t);
  const response = await invoke({ ...posting, description: "short" });
  assert.equal(response.status, 422);
  assert.equal(state.jobs.size, 0);
  assert.equal(state.applications.size, 0);
});
