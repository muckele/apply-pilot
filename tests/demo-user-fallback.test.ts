import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";
import { after, test, type TestContext } from "node:test";

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

// Identifiers of the real owner persona that used to be hard-coded in demo data.
const OWNER_PERSONA = /Mathew|Uckele|muckele|Fontana|Golden Behavior|General Assembly|payer coordination/i;
const DEMO_SOURCES = ["../lib/user-context.ts", "../prisma/seed.ts"];

function setEnv(t: TestContext, changes: Record<string, string | undefined>) {
  for (const [name, value] of Object.entries(changes)) {
    const prior = process.env[name];
    t.after(() => {
      if (prior === undefined) Reflect.deleteProperty(process.env, name);
      else Reflect.set(process.env, name, prior);
    });
    if (value === undefined) Reflect.deleteProperty(process.env, name);
    else Reflect.set(process.env, name, value);
  }
}

async function captureDemoUpsert(t: TestContext) {
  const { prisma } = await import("@/lib/prisma");
  const users = prisma.user as unknown as Record<string, unknown>;
  const original = users.upsert;
  t.after(() => {
    users.upsert = original;
  });
  const calls: Array<{ create: Record<string, unknown> }> = [];
  users.upsert = async (args: { create: Record<string, unknown> }) => {
    calls.push(args);
    return { id: args.create.id };
  };
  return calls;
}

// requireUserId calls auth(), which reads request headers; run it inside an anonymous request scope.
async function anonymousRequest<T>(handler: () => Promise<T>) {
  const { workAsyncStorage } = await import("next/dist/server/app-render/work-async-storage.external.js");
  const { workUnitAsyncStorage } = await import("next/dist/server/app-render/work-unit-async-storage.external.js");
  return workAsyncStorage.run({ route: "/api/demo-fallback-test" } as never, () =>
    workUnitAsyncStorage.run(
      { type: "request", phase: "action", headers: new Headers(), cookies: {} } as never,
      handler
    ));
}

test("the local demo fallback creates only the fictional sample persona", async (t) => {
  setEnv(t, {
    NODE_ENV: "development",
    ALLOW_DEMO_USER: "true",
    DEFAULT_DEMO_USER_ID: undefined,
    AUTH_SECRET: "local-demo-fallback-test-secret"
  });
  const calls = await captureDemoUpsert(t);
  const { requireUserId } = await import("@/lib/user-context");

  const userId = await anonymousRequest(() => requireUserId());

  assert.equal(userId, "demo-user");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].create.name, "Sample User");
  assert.equal(calls[0].create.email, "sample@example.com");
  assert.doesNotMatch(JSON.stringify(calls[0]), OWNER_PERSONA);
});

test("production never activates the demo fallback, even with ALLOW_DEMO_USER=true", async (t) => {
  setEnv(t, {
    NODE_ENV: "production",
    ALLOW_DEMO_USER: "true",
    AUTH_SECRET: "production-demo-fallback-test-secret",
    AUTH_URL: "https://applypilot.test",
    LOG_LEVEL: "error"
  });
  const calls = await captureDemoUpsert(t);
  const { requireUserId, UnauthorizedError } = await import("@/lib/user-context");

  await assert.rejects(anonymousRequest(() => requireUserId()), UnauthorizedError);
  assert.equal(calls.length, 0, "no demo user may be created in production");
});

test("demo fallback and seed contain no real owner data", () => {
  for (const file of DEMO_SOURCES) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    const match = OWNER_PERSONA.exec(source);
    assert.ok(!match, `${file} still contains owner data: ${match?.[0]}`);
    for (const email of source.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? []) {
      assert.match(email, /@example\.(?:com|org|net)$/, `${file} contains a non-example email address`);
    }
  }
});
