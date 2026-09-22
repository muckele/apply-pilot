import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";
import { after, test, type TestContext } from "node:test";
import type { NextRequest } from "next/server";

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

function setEnv(t: TestContext, changes: Record<string, string | undefined>) {
  for (const [name, value] of Object.entries(changes)) {
    const prior = process.env[name];
    t.after(() => {
      if (prior === undefined) delete process.env[name];
      else process.env[name] = prior;
    });
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

function stub(t: TestContext, owner: object, name: string, replacement: unknown) {
  const methods = owner as Record<string, unknown>;
  const original = methods[name];
  methods[name] = replacement;
  t.after(() => { methods[name] = original; });
}

function route(path: string) {
  return readFileSync(new URL("../" + path, import.meta.url), "utf8");
}

async function localRouteSetup(t: TestContext) {
  setEnv(t, {
    OPENAI_API_KEY: undefined,
    OPENAI_MOCK_MODE: undefined,
    AUTH_SECRET: "local-route-test-secret-with-no-real-session",
    ALLOW_DEMO_USER: "true",
    NODE_ENV: "test"
  });
  const { prisma } = await import("@/lib/prisma");
  stub(t, prisma.user, "upsert", async () => ({ id: "demo-user" }));
  stub(t, prisma, "$queryRaw", async () => [{ count: 1 }]);
  stub(t, prisma.rateLimitBucket, "deleteMany", async () => ({ count: 0 }));
  return prisma;
}

async function invokeRoute(path: string, handler: () => Promise<Response>) {
  const { workAsyncStorage } = await import("next/dist/server/app-render/work-async-storage.external.js");
  const { workUnitAsyncStorage } = await import("next/dist/server/app-render/work-unit-async-storage.external.js");
  return workAsyncStorage.run({ route: path } as never, () =>
    workUnitAsyncStorage.run(
      { type: "request", phase: "action", headers: new Headers(), cookies: {} } as never,
      handler
    ));
}

test("resume parsing reports its actual local model to persistence", async (t) => {
  setEnv(t, { OPENAI_API_KEY: undefined, OPENAI_MOCK_MODE: undefined });
  const { parseResumeTextWithMeta } = await import("@/lib/ai/resume");
  const parsed = await parseResumeTextWithMeta("Alice Example\nPython");
  assert.equal(parsed.meta.model, "heuristic-local");
  const source = route("app/api/resumes/parse/route.ts");
  assert.match(source, /model: parsedResult\.meta\.model/);
  assert.match(source, /confidence: parsedResult\.meta\.mocked \? null : 70/);
});

test("successful local drafts and feedback do not claim numeric AI confidence", () => {
  assert.match(route("app/api/jobs/[id]/cover-letter/route.ts"), /confidence: drafted\.usage\.mocked \? null : 78/);
  assert.match(route("app/api/interviews/route.ts"), /confidence: prep\.usage\.mocked \? null : 76/);
  assert.match(route("app/api/interviews/[id]/feedback/route.ts"), /confidence: feedback\.usage\.mocked \? null : 76/);
});

test("unavailable personalized match writes no job scores or AI analysis", async (t) => {
  setEnv(t, { OPENAI_API_KEY: undefined, OPENAI_MOCK_MODE: undefined });
  const { prisma } = await import("@/lib/prisma");
  const { runJobMatch } = await import("@/lib/jobs");
  const { LocalAiUnavailableError } = await import("@/lib/ai/client");
  const job = {
    id: "job-1", title: "Engineer", company: "Acme", description: "React SQL AWS",
    location: null, remoteStatus: null, salaryMin: null, salaryMax: null,
    requirements: [], preferredQualifications: [], detectedTechStack: [], overallFitScore: 78
  };
  let jobWrites = 0;
  let analysisWrites = 0;
  let transactions = 0;
  const update = async () => { jobWrites++; return job; };
  const create = async () => { analysisWrites++; return {}; };
  stub(t, prisma.jobPosting, "findFirstOrThrow", async () => job);
  stub(t, prisma.resume, "findFirst", async () => null);
  stub(t, prisma.userProfile, "findUnique", async () => null);
  stub(t, prisma.aIAnalysis, "findFirst", async () => null);
  stub(t, prisma.jobPosting, "update", update);
  stub(t, prisma.aIAnalysis, "create", create);
  stub(t, prisma, "$transaction", async (action: (tx: unknown) => unknown) => {
    transactions++;
    return action({ jobPosting: { update }, aIAnalysis: { create } });
  });

  await assert.rejects(runJobMatch("user-1", job.id), LocalAiUnavailableError);
  assert.deepEqual({ jobWrites, analysisWrites, transactions }, {
    jobWrites: 0, analysisWrites: 0, transactions: 0
  });
});

test("unavailable tailoring returns 503 without a resume version or AI analysis", async (t) => {
  const prisma = await localRouteSetup(t);
  const job = { id: "job-1", title: "Engineer", company: "Acme" };
  let versions = 0;
  let analyses = 0;
  let audits = 0;
  stub(t, prisma.jobPosting, "findFirstOrThrow", async () => job);
  stub(t, prisma.resume, "findFirst", async () => ({ id: "resume-1", rawText: "Alice Example\nExcel" }));
  stub(t, prisma.userProfile, "findUnique", async () => null);
  stub(t, prisma.resumeVersion, "create", async () => { versions++; return { id: "version-1" }; });
  stub(t, prisma.aIAnalysis, "create", async () => { analyses++; return { id: "analysis-1" }; });
  stub(t, prisma.auditLog, "create", async () => { audits++; return { id: "audit-1" }; });
  const { POST } = await import("../app/api/jobs/[id]/tailored-resume/route");

  const response = await invokeRoute("/api/jobs/job-1/tailored-resume", () =>
    POST(new Request("http://localhost/api/jobs/job-1/tailored-resume") as NextRequest,
      { params: Promise.resolve({ id: job.id }) }));
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /unavailable in local mode/);
  assert.deepEqual({ versions, analyses, audits }, { versions: 0, analyses: 0, audits: 0 });
});

test("unavailable email reply returns 503 without updating or creating generated output", async (t) => {
  const prisma = await localRouteSetup(t);
  let emailUpdates = 0;
  let documents = 0;
  let audits = 0;
  stub(t, prisma.emailMessage, "findFirst", async () => ({
    id: "email-1", body: "Your application was rejected.", applicationId: null
  }));
  stub(t, prisma.emailMessage, "update", async () => { emailUpdates++; return { id: "email-1" }; });
  stub(t, prisma.generatedDocument, "create", async () => { documents++; return { id: "document-1" }; });
  stub(t, prisma.auditLog, "create", async () => { audits++; return { id: "audit-1" }; });
  const { POST } = await import("../app/api/email/draft-reply/route");
  const request = new Request("http://localhost/api/email/draft-reply", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      emailMessageId: "email-1",
      emailText: "Your application was rejected.",
      tone: "professional"
    })
  });

  const response = await invokeRoute("/api/email/draft-reply", () => POST(request as NextRequest));
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /unavailable in local mode/);
  assert.deepEqual({ emailUpdates, documents, audits }, {
    emailUpdates: 0, documents: 0, audits: 0
  });
});
