import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { test, type TestContext } from "node:test";
import type { JobSource } from "@prisma/client";
import type { NextRequest } from "next/server";

import { prisma } from "@/lib/prisma";

function stub(t: TestContext, owner: object, name: string, replacement: unknown) {
  const methods = owner as Record<string, unknown>;
  const original = methods[name];
  methods[name] = replacement;
  t.after(() => { methods[name] = original; });
}

function environment(t: TestContext, userId: string, allowDemoUser = true) {
  const changes: Record<string, string | undefined> = {
    DATABASE_URL: "postgresql://invalid:invalid@127.0.0.1:1/invalid",
    DIRECT_URL: "postgresql://invalid:invalid@127.0.0.1:1/invalid",
    AUTH_SECRET: "synthetic-test-secret",
    ALLOW_DEMO_USER: allowDemoUser ? "true" : "false",
    DEFAULT_DEMO_USER_ID: userId,
    NODE_ENV: "test",
    LOG_LEVEL: "error"
  };
  for (const [name, value] of Object.entries(changes)) {
    const prior = process.env[name];
    t.after(() => { if (prior === undefined) delete process.env[name]; else process.env[name] = prior; });
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  const priorStorage = globalThis.AsyncLocalStorage;
  globalThis.AsyncLocalStorage = AsyncLocalStorage;
  t.after(() => { globalThis.AsyncLocalStorage = priorStorage; });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    throw new Error(`Following a board must not fetch anything: ${String(input)}`);
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
}

async function follow(body: unknown) {
  const { POST } = await import("@/app/api/job-sources/follow/route");
  const { workAsyncStorage } = await import("next/dist/server/app-render/work-async-storage.external.js");
  const { workUnitAsyncStorage } = await import("next/dist/server/app-render/work-unit-async-storage.external.js");
  return workAsyncStorage.run({ route: "/api/job-sources/follow" } as never, () =>
    workUnitAsyncStorage.run(
      { type: "request", phase: "action", headers: new Headers(), cookies: {} } as never,
      () => POST(new Request("http://localhost/api/job-sources/follow", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body)
      }) as NextRequest)
    ));
}

function row(overrides: Partial<JobSource>): JobSource {
  return {
    id: "source",
    userId: "user-b",
    name: "Stripe",
    type: "GREENHOUSE",
    baseUrl: "https://boards.greenhouse.io/stripe",
    boardToken: "stripe",
    allowlisted: true,
    robotsChecked: true,
    lastSyncedAt: null,
    lastSyncStatus: null,
    lastSyncError: null,
    syncEnabled: true,
    notes: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides
  };
}

/** A two-user JobSource table: every query must carry the signed-in user's id. */
function database(t: TestContext, seed: JobSource[]) {
  const rows = [...seed];
  const writes: Array<{ op: string; userId?: string; id?: string }> = [];
  stub(t, prisma.user, "upsert", async () => ({}));
  stub(t, prisma, "$queryRaw", async () => [{ count: 1 }]);
  stub(t, prisma.rateLimitBucket, "deleteMany", async () => ({ count: 0 }));
  stub(t, prisma.auditLog, "create", async (args: { data: { userId: string } }) => {
    writes.push({ op: "audit", userId: args.data.userId });
    return { id: "audit" };
  });
  stub(t, prisma.jobSource, "findFirst", async ({ where }: { where: { userId: string; type: string; boardToken: { equals: string; mode: string } } }) => {
    assert.ok(where.userId, "lookups are always scoped to a user");
    assert.equal(where.boardToken.mode, "insensitive");
    return rows.find((candidate) =>
      candidate.userId === where.userId &&
      candidate.type === where.type &&
      candidate.boardToken?.toLowerCase() === where.boardToken.equals.toLowerCase()
    ) ?? null;
  });
  stub(t, prisma.jobSource, "create", async ({ data }: { data: Partial<JobSource> }) => {
    const created = row({ ...data, id: `created-${rows.length}` } as Partial<JobSource>);
    rows.push(created);
    writes.push({ op: "create", userId: data.userId, id: created.id });
    return created;
  });
  stub(t, prisma.jobSource, "update", async ({ where, data }: { where: { id: string }; data: Partial<JobSource> }) => {
    const target = rows.find((candidate) => candidate.id === where.id);
    assert.ok(target);
    Object.assign(target, data);
    writes.push({ op: "update", userId: target.userId, id: target.id });
    return target;
  });
  return { rows, writes };
}

test("following a pasted job link creates the signed-in user's board source", async (t) => {
  environment(t, "user-a");
  const db = database(t, []);

  const response = await follow({ url: "https://job-boards.greenhouse.io/stripe/jobs/7012345?gh_jid=7012345" });
  const result = await response.json();

  assert.equal(response.status, 201);
  assert.equal(result.created, true);
  assert.equal(result.source.userId, "user-a");
  assert.equal(result.source.type, "GREENHOUSE");
  assert.equal(result.source.boardToken, "stripe");
  assert.equal(result.source.baseUrl, "https://boards.greenhouse.io/stripe");
  assert.equal(result.source.name, "Stripe", "known boards take the directory company name");
  assert.equal(result.source.syncEnabled, true);
  assert.deepEqual(db.writes.map((write) => [write.op, write.userId]), [["create", "user-a"], ["audit", "user-a"]]);
});

test("another user's identical board never satisfies or changes this user's follow", async (t) => {
  environment(t, "user-a");
  const otherUsersRow = row({ id: "user-b-stripe", userId: "user-b", syncEnabled: false });
  const db = database(t, [otherUsersRow]);

  const response = await follow({ url: "https://boards.greenhouse.io/stripe" });
  const result = await response.json();

  assert.equal(response.status, 201);
  assert.equal(result.created, true);
  assert.notEqual(result.source.id, "user-b-stripe");
  assert.equal(result.source.userId, "user-a");
  assert.equal(otherUsersRow.syncEnabled, false, "user B's disabled row is untouched");
  assert.ok(db.writes.every((write) => write.userId === "user-a"), JSON.stringify(db.writes));
});

test("following the same board twice returns the existing source, and re-enables it if disabled", async (t) => {
  environment(t, "user-a");
  const existing = row({ id: "user-a-ramp", userId: "user-a", name: "Ramp", type: "ASHBY", boardToken: "ramp", syncEnabled: false });
  const db = database(t, [existing]);

  const response = await follow({ url: "https://jobs.ashbyhq.com/RAMP/0b1c2d3e-aaaa-bbbb-cccc-ddddeeeeffff" });
  const result = await response.json();

  assert.equal(response.status, 200);
  assert.equal(result.created, false);
  assert.equal(result.reenabled, true);
  assert.equal(result.source.id, "user-a-ramp");
  assert.equal(existing.syncEnabled, true);
  assert.deepEqual(db.writes.map((write) => [write.op, write.userId, write.id]), [
    ["update", "user-a", "user-a-ramp"],
    ["audit", "user-a", undefined]
  ]);

  const again = await follow({ url: "https://jobs.ashbyhq.com/ramp" });
  const againResult = await again.json();
  assert.equal(again.status, 200);
  assert.equal(againResult.reenabled, false);
  assert.equal(db.rows.length, 1, "no duplicate source");
});

test("unsupported or hostile links are rejected before any database write", async (t) => {
  environment(t, "user-a");
  const db = database(t, []);

  for (const url of ["https://www.linkedin.com/jobs/view/1", "https://boards.greenhouse.io@evil.example/stripe", "javascript:alert(1)", ""]) {
    const response = await follow({ url });
    assert.equal(response.status === 422 || response.status === 400, true, `${url} -> ${response.status}`);
    const body = await response.json();
    assert.ok(typeof body.error === "string" && body.error.length > 0);
  }
  const tooLong = await follow({ url: `https://boards.greenhouse.io/${"a".repeat(5000)}` });
  assert.equal(tooLong.status, 422);
  assert.deepEqual(db.writes, []);
});

test("a custom name is used for a board that is not in the directory", async (t) => {
  environment(t, "user-a");
  database(t, []);

  const named = await follow({ url: "https://jobs.lever.co/example-startup", name: "Example Startup Inc" });
  assert.equal((await named.json()).source.name, "Example Startup Inc");

  const unnamed = await follow({ url: "https://jobs.eu.lever.co/another-co/3f1b2c4d-1111-2222-3333-444455556666" });
  const unnamedResult = await unnamed.json();
  assert.equal(unnamedResult.source.name, "Another Co");
  assert.equal(unnamedResult.source.baseUrl, "https://jobs.eu.lever.co/another-co", "the EU region is kept for syncing");
});

test("following requires a signed-in user", async (t) => {
  environment(t, "user-a", false);
  const db = database(t, []);

  const response = await follow({ url: "https://boards.greenhouse.io/stripe" });

  assert.equal(response.status, 401);
  assert.deepEqual(db.writes, []);
});
