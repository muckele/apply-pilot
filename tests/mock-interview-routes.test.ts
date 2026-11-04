import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";
import { after, test, type TestContext } from "node:test";
import type { NextRequest } from "next/server";

// Route tests for text mock interviews (WP1.8). Prisma and the Gemini transport are
// stubbed: no database, no paid call. Every new route has an owner-scoping test that
// proves another user's records are refused before any AI work or write.

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
const OTHER = "other-user";

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

async function routeSetup(t: TestContext, { gemini = true } = {}) {
  setEnv(t, {
    AUTH_SECRET: "local-route-test-secret-with-no-real-session",
    ALLOW_DEMO_USER: "true",
    NODE_ENV: "test",
    AI_ENABLED: "true",
    AI_MOCK_MODE: "false",
    AI_PROVIDER: undefined,
    GEMINI_API_KEY: gemini ? "synthetic-never-log" : undefined,
    OPENAI_API_KEY: undefined,
    AI_MAX_REQUEST_COST_CENTS: undefined,
    AI_CONFIRMATION_THRESHOLD_CENTS: undefined
  });
  const { prisma } = await import("@/lib/prisma");
  stub(t, prisma.user, "upsert", async () => ({ id: OWNER }));
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

type Writes = Record<string, Array<Record<string, unknown>>>;

// One transaction stub serves the hard budget ledger and the routes' own writes.
function installLedger(t: TestContext, prisma: typeof import("@/lib/prisma").prisma, sessionStore: SessionStore) {
  const writes: Writes = {};
  const record = (name: string, result: (args: Record<string, unknown>) => unknown = (args) =>
    ({ id: `${name}-1`, ...((args.data ?? {}) as Record<string, unknown>) })) => async (args: Record<string, unknown>) => {
    (writes[name] ??= []).push(args);
    return result(args);
  };
  let reservation: Record<string, unknown> | null = null;
  stub(t, prisma.aIResponseCache, "findFirst", async () => null);
  stub(t, prisma.aIBudgetReservation, "findMany", async () => []);
  stub(t, prisma.aIBudgetReservation, "findFirst", async () => null);
  stub(t, prisma.aISettings, "upsert", async () => ({
    monthlyBudgetCents: 500, automationBudgetCents: 150, maxAnalysesPerSync: 5, modelOverride: null
  }));
  const mockInterviewSession = {
    create: record("mockInterviewSession.create", (args) => ({
      id: "session-new",
      revision: 0,
      completedAt: null,
      createdAt: new Date("2026-11-03T10:00:00.000Z"),
      updatedAt: new Date("2026-11-03T10:00:00.000Z"),
      ...(args.data as Record<string, unknown>)
    })),
    updateMany: record("mockInterviewSession.updateMany", (args) => sessionStore.updateMany(args)),
    deleteMany: record("mockInterviewSession.deleteMany", (args) => sessionStore.deleteMany(args)),
    findFirst: async (args: Record<string, unknown>) => sessionStore.findFirst(args)
  };
  const tx = {
    aIBudgetLedger: { upsert: async () => ({ id: "ledger-1" }), updateMany: async () => ({ count: 1 }) },
    aIBudgetReservation: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        (writes.reservation ??= []).push(data);
        reservation = { id: "reservation-1", ledgerId: "ledger-1", status: "RESERVED", ...data };
        return reservation;
      },
      findUniqueOrThrow: async () => reservation,
      update: async ({ data }: { data: Record<string, unknown> }) => {
        (writes.reconciliation ??= []).push(data);
        reservation = { ...reservation, ...data };
        return reservation;
      }
    },
    aIUsageEvent: { create: async () => ({}) },
    aIResponseCache: {
      upsert: async ({ create }: { create: unknown }) => create,
      deleteMany: record("aIResponseCache.deleteMany", () => ({ count: 1 }))
    },
    $executeRaw: async () => 1,
    mockInterviewSession,
    starStory: {
      create: record("starStory.create", (args) => ({ id: "story-new", ...(args.data as Record<string, unknown>) }))
    },
    auditLog: { create: record("auditLog.create") }
  };
  stub(t, prisma, "$transaction", async (callback: (transaction: typeof tx) => unknown) => callback(tx));
  stub(t, prisma.auditLog, "create", record("auditLog.create"));
  for (const [name, value] of Object.entries(mockInterviewSession)) stub(t, prisma.mockInterviewSession, name, value);
  return writes;
}

function installGemini(t: TestContext, respond: (payload: Record<string, unknown>) => unknown) {
  let calls = 0;
  stub(t, globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
    calls += 1;
    const body = JSON.parse(String(init?.body)) as { contents: Array<{ parts: Array<{ text: string }> }> };
    const payload = JSON.parse(body.contents[0].parts[0].text) as Record<string, unknown>;
    return new Response(JSON.stringify({
      candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(respond(payload)) }] } }],
      usageMetadata: { promptTokenCount: 500, candidatesTokenCount: 200, thoughtsTokenCount: 0, totalTokenCount: 700 }
    }), { status: 200, headers: { "content-type": "application/json" } });
  });
  return () => calls;
}

function captureLogs(t: TestContext) {
  const lines: string[] = [];
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    stub(t, console, method, (...args: unknown[]) => { lines.push(args.map((arg) => typeof arg === "string" ? arg : JSON.stringify(arg)).join(" ")); });
  }
  return lines;
}

const confirmedHeaders = {
  "content-type": "application/json",
  "x-ai-cost-confirmed": "true",
  "x-ai-data-confirmed": "true"
};

const jobRecord = {
  id: "job-1",
  userId: OWNER,
  title: "Platform Engineer",
  company: "Example Co",
  location: "Remote",
  description: "We build payment infrastructure that small businesses rely on every day.\n- You will own deployment reliability for our core services.",
  requirements: ["TypeScript", "Incident response experience"],
  preferredQualifications: [],
  detectedTechStack: []
};

const resumeRecord = {
  id: "resume-1",
  userId: OWNER,
  isMaster: true,
  summary: "Platform engineer building reliable services.",
  skills: ["TypeScript"],
  achievements: ["Reduced deploy time by 30% across 4 teams."],
  workHistory: [{ title: "Platform Engineer", company: "Prior Co", bullets: ["Led incident response for payment services."] }],
  rawText: "private raw resume text",
  contactInfo: { email: "private@example.test" }
};

function ownedFinder<T extends { id: string; userId: string }>(records: T[], queries: Array<Record<string, unknown>> = []) {
  return async (args: { where: Record<string, unknown> }) => {
    queries.push(args.where);
    return records.find((item) => item.id === args.where.id && item.userId === args.where.userId) ?? null;
  };
}

function questionsResponse(payload: Record<string, unknown>) {
  const lines = payload.jobLines as Array<{ lineId: string; text: string }>;
  const line = (needle: string) => lines.find((entry) => entry.text.includes(needle))!.lineId;
  return {
    questions: [
      { category: "BEHAVIORAL", question: "Tell me about a time you led an incident response.", sourceLineId: line("Incident"), lookingFor: "Ownership.", factIds: [] },
      { category: "BEHAVIORAL", question: "Tell me about a time you disagreed with a teammate.", sourceLineId: line("deployment reliability"), lookingFor: "Collaboration.", factIds: [] },
      { category: "ROLE_SPECIFIC", question: "How would you improve deployment reliability?", sourceLineId: line("deployment reliability"), lookingFor: "A plan.", factIds: [] },
      { category: "ROLE_SPECIFIC", question: "Walk me through a TypeScript service you built.", sourceLineId: line("TypeScript"), lookingFor: "Depth.", factIds: [] },
      { category: "ROLE_SPECIFIC", question: "What do you alert on first?", sourceLineId: line("Incident"), lookingFor: "Judgment.", factIds: [] },
      { category: "WHY_COMPANY", question: "Why do you want to build payment infrastructure?", sourceLineId: line("payment infrastructure"), lookingFor: "Motivation.", factIds: [] }
    ]
  };
}

const ANSWER_TEXT = "SECRET-ANSWER At Prior Co our payment services had an outage. I was on call. I led incident response and rolled back the release. Service recovered within the hour.";

function feedbackResponse(payload: Record<string, unknown>) {
  assert.equal(payload.answerText, ANSWER_TEXT);
  return {
    scores: {
      structure: { score: 4, note: "Clear STAR shape." },
      specificity: { score: 4, note: "Good detail." },
      relevance: { score: 4, note: "On topic." },
      evidence: { score: 4, note: "Matches your resume." }
    },
    starCoverage: { situation: true, task: true, action: true, result: true },
    strengths: ["You owned the response."],
    tips: [
      { dimension: "specificity", tip: "Name the alert that fired." },
      { dimension: "evidence", tip: "Add the recovery time to your resume if accurate." }
    ],
    unsupportedClaims: [],
    starBreakdown: {
      situation: "Our payment services had an outage.",
      task: "I was on call.",
      action: "I led incident response and rolled back the release.",
      result: "Service recovered within the hour."
    },
    strongerVersion: "",
    strongerVersionFactIds: []
  };
}

const sessionQuestions = questionsResponse({
  jobLines: [
    { lineId: "L1", text: "TypeScript" },
    { lineId: "L2", text: "Incident response experience" },
    { lineId: "L3", text: "We build payment infrastructure that small businesses rely on every day." },
    { lineId: "L4", text: "You will own deployment reliability for our core services." }
  ]
}).questions.map((question, index) => ({
  questionId: `q${index + 1}`,
  category: question.category,
  question: question.question,
  lookingFor: question.lookingFor,
  jobLine: { lineId: question.sourceLineId, text: "Incident response experience", source: "requirement" },
  factIds: []
}));

type SessionRecord = Record<string, unknown> & { id: string; userId: string; revision: number; answers: Record<string, unknown> };

type SessionStore = ReturnType<typeof createSessionStore>;

function createSessionStore(records: SessionRecord[]) {
  const queries: Array<Record<string, unknown>> = [];
  return {
    records,
    queries,
    async findFirst(args: Record<string, unknown>) {
      const where = args.where as Record<string, unknown>;
      queries.push(where);
      return records.find((item) => item.id === where.id && item.userId === where.userId) ?? null;
    },
    async updateMany(args: Record<string, unknown>) {
      const where = args.where as Record<string, unknown>;
      const target = records.find((item) => item.id === where.id && item.userId === where.userId &&
        (where.revision === undefined || item.revision === where.revision));
      if (!target) return { count: 0 };
      const data = args.data as Record<string, unknown>;
      if (data.answers) target.answers = data.answers as Record<string, unknown>;
      if ("completedAt" in data) target.completedAt = data.completedAt;
      if (data.revision) target.revision += 1;
      return { count: 1 };
    },
    async deleteMany(args: Record<string, unknown>) {
      const where = args.where as Record<string, unknown>;
      const index = records.findIndex((item) => item.id === where.id && item.userId === where.userId);
      if (index < 0) return { count: 0 };
      records.splice(index, 1);
      return { count: 1 };
    }
  };
}

function sessionRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "session-1",
    userId: OWNER,
    interviewId: "interview-1",
    applicationId: null,
    jobPostingId: "job-1",
    title: "Example Co - Platform Engineer",
    questions: sessionQuestions,
    answers: {},
    revision: 0,
    model: "gemini-3.8-flash",
    promptVersion: "1",
    requestHash: "f".repeat(64),
    completedAt: null,
    createdAt: new Date("2026-11-03T10:00:00.000Z"),
    updatedAt: new Date("2026-11-03T10:00:00.000Z"),
    interview: null,
    application: null,
    jobPosting: jobRecord,
    ...overrides
  };
}

function strongAnswerRecord(overrides: Record<string, unknown> = {}) {
  return {
    answer: ANSWER_TEXT,
    answeredAt: "2026-11-03T10:01:00.000Z",
    attempts: 1,
    savedStoryId: null,
    savedStoryAttempt: null,
    requestHash: "a".repeat(64),
    feedback: {
      ...feedbackResponse({ answerText: ANSWER_TEXT }),
      unverifiedNumbers: [],
      strongerVersion: null
    },
    ...overrides
  };
}

async function postJson(path: string, handler: (request: NextRequest, context: never) => Promise<Response>, body: unknown, params?: Record<string, string>, headers: Record<string, string> = confirmedHeaders) {
  return invokeRoute(path, () => handler(
    new Request(`http://localhost${path}`, { method: "POST", headers, body: JSON.stringify(body) }) as NextRequest,
    { params: Promise.resolve(params ?? {}) } as never
  ));
}

// ---------------------------------------------------------------- create session

test("starting a mock session from the owner's interview generates linked questions and saves the session", async (t) => {
  const prisma = await routeSetup(t);
  const store = createSessionStore([]);
  const writes = installLedger(t, prisma, store);
  const interviewQueries: Array<Record<string, unknown>> = [];
  stub(t, prisma.interview, "findFirst", ownedFinder([{
    id: "interview-1",
    userId: OWNER,
    type: "TECHNICAL",
    likelyQuestions: ["Tell me about a time you improved deployments."],
    jobPosting: jobRecord,
    application: null
  }], interviewQueries));
  stub(t, prisma.resume, "findFirst", async ({ where }: { where: Record<string, unknown> }) =>
    where.userId === OWNER && where.isMaster === true ? resumeRecord : null);
  let seenPayload: Record<string, unknown> | null = null;
  const calls = installGemini(t, (payload) => { seenPayload = payload; return questionsResponse(payload); });
  const { POST } = await import("../app/api/interviews/mock-sessions/route");

  const response = await postJson("/api/interviews/mock-sessions", POST, { interviewId: "interview-1" });

  assert.equal(response.status, 201);
  assert.equal(calls(), 1);
  assert.equal(interviewQueries[0].userId, OWNER);
  assert.deepEqual((seenPayload as Record<string, unknown> | null)?.prepQuestions, ["Tell me about a time you improved deployments."]);
  assert.doesNotMatch(JSON.stringify(seenPayload), /private raw resume text|private@example\.test/u);
  assert.equal(writes.reservation[0].feature, "MOCK_INTERVIEW_QUESTIONS");
  const created = writes["mockInterviewSession.create"][0].data as Record<string, unknown>;
  assert.equal(created.userId, OWNER);
  assert.equal(created.interviewId, "interview-1");
  assert.equal(created.jobPostingId, "job-1");
  assert.equal(created.title, "Example Co - Platform Engineer");
  const questions = created.questions as Array<{ jobLine: { text: string } }>;
  assert.equal(questions.length, 6);
  assert.ok(questions.every((question) => question.jobLine.text.length > 0), "every question links to a posting line");
  const body = await response.json();
  assert.equal(body.session.id, "session-new");
  const audit = writes["auditLog.create"][0].data as Record<string, unknown>;
  assert.equal(audit.action, "interview.mock.create");
  assert.deepEqual(audit.metadata, { source: "interview", questionCount: 6, model: "gemini-3.8-flash" });
});

test("a mock session can start from the owner's application or saved job without an interview", async (t) => {
  const prisma = await routeSetup(t);
  const store = createSessionStore([]);
  const writes = installLedger(t, prisma, store);
  stub(t, prisma.application, "findFirst", ownedFinder([{ id: "application-1", userId: OWNER, jobPostingId: "job-1", jobPosting: jobRecord }]));
  stub(t, prisma.jobPosting, "findFirst", ownedFinder([jobRecord]));
  stub(t, prisma.resume, "findFirst", async () => resumeRecord);
  installGemini(t, questionsResponse);
  const { POST } = await import("../app/api/interviews/mock-sessions/route");

  const fromApplication = await postJson("/api/interviews/mock-sessions", POST, { applicationId: "application-1" });
  const fromJob = await postJson("/api/interviews/mock-sessions", POST, { jobPostingId: "job-1" });

  assert.equal(fromApplication.status, 201);
  assert.equal(fromJob.status, 201);
  const [applicationSession, jobSession] = writes["mockInterviewSession.create"].map((entry) => entry.data as Record<string, unknown>);
  assert.deepEqual(
    [applicationSession.interviewId, applicationSession.applicationId, applicationSession.jobPostingId],
    [null, "application-1", "job-1"]
  );
  assert.deepEqual([jobSession.interviewId, jobSession.applicationId, jobSession.jobPostingId], [null, null, "job-1"]);
});

test("starting a mock session refuses another user's interview, application, or job before any AI work", async (t) => {
  const prisma = await routeSetup(t);
  const store = createSessionStore([]);
  const writes = installLedger(t, prisma, store);
  stub(t, prisma.interview, "findFirst", ownedFinder([{ id: "interview-x", userId: OTHER, type: "TECHNICAL", likelyQuestions: [], jobPosting: { ...jobRecord, userId: OTHER }, application: null }]));
  stub(t, prisma.application, "findFirst", ownedFinder([{ id: "application-x", userId: OTHER, jobPostingId: "job-x", jobPosting: { ...jobRecord, id: "job-x", userId: OTHER } }]));
  stub(t, prisma.jobPosting, "findFirst", ownedFinder([{ ...jobRecord, id: "job-x", userId: OTHER }]));
  stub(t, prisma.resume, "findFirst", async () => resumeRecord);
  const calls = installGemini(t, questionsResponse);
  const { POST } = await import("../app/api/interviews/mock-sessions/route");

  for (const body of [{ interviewId: "interview-x" }, { applicationId: "application-x" }, { jobPostingId: "job-x" }]) {
    const response = await postJson("/api/interviews/mock-sessions", POST, body);
    assert.equal(response.status, 404, JSON.stringify(body));
  }
  for (const body of [{}, { interviewId: "interview-x", jobPostingId: "job-x" }]) {
    const response = await postJson("/api/interviews/mock-sessions", POST, body);
    assert.equal(response.status, 422, "exactly one source is required");
  }
  assert.equal(calls(), 0);
  assert.equal(writes.reservation, undefined);
  assert.equal(writes["mockInterviewSession.create"], undefined);
});

test("starting a mock session without Gemini shows AI unavailable and saves nothing", async (t) => {
  const prisma = await routeSetup(t, { gemini: false });
  const store = createSessionStore([]);
  const writes = installLedger(t, prisma, store);
  stub(t, prisma.jobPosting, "findFirst", ownedFinder([jobRecord]));
  stub(t, prisma.resume, "findFirst", async () => resumeRecord);
  const calls = installGemini(t, questionsResponse);
  const { POST } = await import("../app/api/interviews/mock-sessions/route");

  const response = await postJson("/api/interviews/mock-sessions", POST, { jobPostingId: "job-1" });

  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, "AI_UNAVAILABLE");
  assert.equal(calls(), 0);
  assert.equal(writes["mockInterviewSession.create"], undefined);
});

test("listing mock sessions is owner-scoped and never returns answer text", async (t) => {
  const prisma = await routeSetup(t);
  const queries: Array<Record<string, unknown>> = [];
  stub(t, prisma.mockInterviewSession, "findMany", async (args: { where: Record<string, unknown>; select: Record<string, unknown> }) => {
    queries.push(args.where);
    assert.equal(args.select.answers, undefined, "the list never selects answers");
    return [{ id: "session-1", title: "Example Co - Platform Engineer", interviewId: "interview-1", applicationId: null, jobPostingId: "job-1", questions: sessionQuestions, completedAt: null, createdAt: new Date(), updatedAt: new Date() }];
  });
  const { GET } = await import("../app/api/interviews/mock-sessions/route");

  const response = await invokeRoute("/api/interviews/mock-sessions", () =>
    GET(new Request("http://localhost/api/interviews/mock-sessions?interviewId=interview-1") as NextRequest));

  assert.equal(response.status, 200);
  assert.deepEqual(queries[0], { userId: OWNER, interviewId: "interview-1" });
  const body = await response.json();
  assert.equal(body.sessions[0].questionCount, 6);
  assert.equal(body.sessions[0].answers, undefined);
});

// ---------------------------------------------------------------- read / finish / delete

test("reading, finishing, and deleting a mock session refuse another user's session", async (t) => {
  const prisma = await routeSetup(t);
  const store = createSessionStore([sessionRecord({ id: "session-x", userId: OTHER })]);
  const writes = installLedger(t, prisma, store);
  const route = await import("../app/api/interviews/mock-sessions/[sessionId]/route");
  const context = { params: Promise.resolve({ sessionId: "session-x" }) };

  const read = await invokeRoute("/api/interviews/mock-sessions/session-x", () =>
    route.GET(new Request("http://localhost/api/interviews/mock-sessions/session-x") as NextRequest, context));
  const finish = await invokeRoute("/api/interviews/mock-sessions/session-x", () =>
    route.PATCH(new Request("http://localhost/api/interviews/mock-sessions/session-x", {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ completed: true })
    }) as NextRequest, context));
  const removed = await invokeRoute("/api/interviews/mock-sessions/session-x", () =>
    route.DELETE(new Request("http://localhost/api/interviews/mock-sessions/session-x", { method: "DELETE" }) as NextRequest, context));

  assert.deepEqual([read.status, finish.status, removed.status], [404, 404, 404]);
  assert.ok(store.queries.every((where) => where.userId === OWNER));
  assert.equal(store.records.length, 1, "another user's session is untouched");
  assert.equal(store.records[0].completedAt, null);
  assert.equal(writes["aIResponseCache.deleteMany"], undefined);
});

test("the owner can revisit, finish, and delete a session, and deleting removes its cached AI output", async (t) => {
  const prisma = await routeSetup(t);
  const store = createSessionStore([sessionRecord({ answers: { q1: strongAnswerRecord() } })]);
  const writes = installLedger(t, prisma, store);
  const route = await import("../app/api/interviews/mock-sessions/[sessionId]/route");
  const context = { params: Promise.resolve({ sessionId: "session-1" }) };

  const read = await invokeRoute("/api/interviews/mock-sessions/session-1", () =>
    route.GET(new Request("http://localhost/api/interviews/mock-sessions/session-1") as NextRequest, context));
  assert.equal(read.status, 200);
  const readBody = await read.json();
  assert.equal(readBody.session.answers.q1.answer, ANSWER_TEXT);
  assert.equal(readBody.session.questions.length, 6);

  const finish = await invokeRoute("/api/interviews/mock-sessions/session-1", () =>
    route.PATCH(new Request("http://localhost/api/interviews/mock-sessions/session-1", {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ completed: true })
    }) as NextRequest, context));
  assert.equal(finish.status, 200);
  assert.ok(store.records[0].completedAt instanceof Date);

  const removed = await invokeRoute("/api/interviews/mock-sessions/session-1", () =>
    route.DELETE(new Request("http://localhost/api/interviews/mock-sessions/session-1", { method: "DELETE" }) as NextRequest, context));
  assert.equal(removed.status, 200);
  assert.equal(store.records.length, 0);
  const cacheDelete = writes["aIResponseCache.deleteMany"][0].where as Record<string, unknown>;
  assert.equal(cacheDelete.userId, OWNER);
  assert.deepEqual((cacheDelete.requestHash as { in: string[] }).in.sort(), ["a".repeat(64), "f".repeat(64)]);
  const audit = writes["auditLog.create"].at(-1)!.data as Record<string, unknown>;
  assert.equal(audit.action, "interview.mock.delete");
  assert.doesNotMatch(JSON.stringify(writes["auditLog.create"]), /SECRET-ANSWER/u);
});

// ---------------------------------------------------------------- answers

test("answering a question runs Gemini feedback, saves it on the owner's session, and never logs the answer", async (t) => {
  const prisma = await routeSetup(t);
  const store = createSessionStore([sessionRecord()]);
  const writes = installLedger(t, prisma, store);
  stub(t, prisma.resume, "findFirst", async ({ where }: { where: Record<string, unknown> }) =>
    where.userId === OWNER ? resumeRecord : null);
  const calls = installGemini(t, feedbackResponse);
  const logs = captureLogs(t);
  const { POST } = await import("../app/api/interviews/mock-sessions/[sessionId]/answers/route");

  const response = await postJson("/api/interviews/mock-sessions/session-1/answers", POST,
    { questionId: "q1", answer: ANSWER_TEXT }, { sessionId: "session-1" });

  assert.equal(response.status, 200);
  assert.equal(calls(), 1);
  assert.equal(writes.reservation[0].feature, "MOCK_INTERVIEW_FEEDBACK");
  const update = writes["mockInterviewSession.updateMany"][0] as { where: Record<string, unknown> };
  assert.deepEqual(update.where, { id: "session-1", userId: OWNER, revision: 0 }, "saves are owner-scoped and revision-guarded");
  const saved = store.records[0].answers.q1 as Record<string, unknown>;
  assert.equal(saved.answer, ANSWER_TEXT);
  assert.equal(saved.attempts, 1);
  assert.equal((saved.feedback as { scores: { structure: { score: number } } }).scores.structure.score, 4);
  const body = await response.json();
  assert.equal(body.answer.feedback.tips.length, 2);
  assert.doesNotMatch(logs.join("\n"), /SECRET-ANSWER/u);
  assert.doesNotMatch(JSON.stringify(writes["auditLog.create"]), /SECRET-ANSWER/u);
});

test("answering refuses another user's session, an unknown question, and missing confirmation before any provider call", async (t) => {
  const prisma = await routeSetup(t);
  const store = createSessionStore([sessionRecord(), sessionRecord({ id: "session-x", userId: OTHER })]);
  const writes = installLedger(t, prisma, store);
  stub(t, prisma.resume, "findFirst", async () => resumeRecord);
  const calls = installGemini(t, feedbackResponse);
  const { POST } = await import("../app/api/interviews/mock-sessions/[sessionId]/answers/route");

  const other = await postJson("/api/interviews/mock-sessions/session-x/answers", POST,
    { questionId: "q1", answer: ANSWER_TEXT }, { sessionId: "session-x" });
  const unknown = await postJson("/api/interviews/mock-sessions/session-1/answers", POST,
    { questionId: "q99", answer: ANSWER_TEXT }, { sessionId: "session-1" });
  const unconfirmed = await postJson("/api/interviews/mock-sessions/session-1/answers", POST,
    { questionId: "q1", answer: ANSWER_TEXT }, { sessionId: "session-1" }, { "content-type": "application/json" });

  assert.equal(other.status, 404);
  assert.equal(unknown.status, 404);
  assert.equal(unconfirmed.status, 428);
  assert.equal((await unconfirmed.json()).dataType, "mock_interview_answer_packet");
  assert.equal(calls(), 0);
  assert.equal(writes.reservation, undefined);
  assert.equal(writes["mockInterviewSession.updateMany"], undefined);
  assert.deepEqual(store.records.map((item) => item.answers), [{}, {}]);
});

test("answering without Gemini returns AI unavailable and keeps the session unchanged", async (t) => {
  const prisma = await routeSetup(t, { gemini: false });
  const store = createSessionStore([sessionRecord()]);
  const writes = installLedger(t, prisma, store);
  stub(t, prisma.resume, "findFirst", async () => resumeRecord);
  const calls = installGemini(t, feedbackResponse);
  const { POST } = await import("../app/api/interviews/mock-sessions/[sessionId]/answers/route");

  const response = await postJson("/api/interviews/mock-sessions/session-1/answers", POST,
    { questionId: "q1", answer: ANSWER_TEXT }, { sessionId: "session-1" });

  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, "AI_UNAVAILABLE");
  assert.equal(calls(), 0);
  assert.equal(writes["mockInterviewSession.updateMany"], undefined);
});

test("a concurrent save is retried against the latest revision without dropping the other answer", async (t) => {
  const prisma = await routeSetup(t);
  const store = createSessionStore([sessionRecord()]);
  const writes = installLedger(t, prisma, store);
  stub(t, prisma.resume, "findFirst", async () => resumeRecord);
  installGemini(t, (payload) => {
    // Another tab saves q2 while this request waits on Gemini.
    store.records[0].answers = { q2: strongAnswerRecord({ requestHash: "b".repeat(64) }) };
    store.records[0].revision = 1;
    return feedbackResponse(payload);
  });
  const { POST } = await import("../app/api/interviews/mock-sessions/[sessionId]/answers/route");

  const response = await postJson("/api/interviews/mock-sessions/session-1/answers", POST,
    { questionId: "q1", answer: ANSWER_TEXT }, { sessionId: "session-1" });

  assert.equal(response.status, 200);
  assert.deepEqual(Object.keys(store.records[0].answers).sort(), ["q1", "q2"]);
  assert.equal(store.records[0].revision, 2);
  assert.ok(writes["mockInterviewSession.updateMany"].length >= 1);
});

// ---------------------------------------------------------------- save as STAR story

test("saving a strong answer creates one STAR story in the owner's library", async (t) => {
  const prisma = await routeSetup(t);
  const store = createSessionStore([sessionRecord({ answers: { q1: strongAnswerRecord() } })]);
  const writes = installLedger(t, prisma, store);
  const storyLookups: Array<Record<string, unknown>> = [];
  stub(t, prisma.starStory, "findFirst", async ({ where }: { where: Record<string, unknown> }) => {
    storyLookups.push(where);
    return where.id === "story-new" && where.userId === OWNER ? { id: "story-new", userId: OWNER, title: "saved" } : null;
  });
  const { POST } = await import("../app/api/interviews/mock-sessions/[sessionId]/star-story/route");

  const first = await postJson("/api/interviews/mock-sessions/session-1/star-story", POST, { questionId: "q1" }, { sessionId: "session-1" });
  const second = await postJson("/api/interviews/mock-sessions/session-1/star-story", POST, { questionId: "q1" }, { sessionId: "session-1" });

  assert.equal(first.status, 201);
  assert.equal(second.status, 200, "saving twice returns the existing story");
  assert.equal((await second.json()).alreadySaved, true);
  assert.equal(writes["starStory.create"].length, 1);
  const story = writes["starStory.create"][0].data as Record<string, unknown>;
  assert.equal(story.userId, OWNER);
  assert.equal(story.title, "Tell me about a time you led an incident response.");
  assert.equal(story.situation, "Our payment services had an outage.");
  assert.equal(story.result, "Service recovered within the hour.");
  assert.equal(story.roleContext, "Example Co - Platform Engineer");
  const saved = store.records[0].answers.q1 as Record<string, unknown>;
  assert.equal(saved.savedStoryId, "story-new");
  assert.equal(saved.savedStoryAttempt, 1);
  assert.ok(storyLookups.every((where) => where.userId === OWNER));
});

test("saving a STAR story refuses another user's session and answers that are not strong yet", async (t) => {
  const prisma = await routeSetup(t);
  const weak = strongAnswerRecord();
  (weak.feedback as Record<string, unknown>).starCoverage = { situation: true, task: false, action: true, result: false };
  const store = createSessionStore([
    sessionRecord({ answers: { q1: weak } }),
    sessionRecord({ id: "session-x", userId: OTHER, answers: { q1: strongAnswerRecord() } })
  ]);
  const writes = installLedger(t, prisma, store);
  stub(t, prisma.starStory, "findFirst", async () => null);
  const { POST } = await import("../app/api/interviews/mock-sessions/[sessionId]/star-story/route");

  const other = await postJson("/api/interviews/mock-sessions/session-x/star-story", POST, { questionId: "q1" }, { sessionId: "session-x" });
  const notStrong = await postJson("/api/interviews/mock-sessions/session-1/star-story", POST, { questionId: "q1" }, { sessionId: "session-1" });
  const unanswered = await postJson("/api/interviews/mock-sessions/session-1/star-story", POST, { questionId: "q2" }, { sessionId: "session-1" });

  assert.equal(other.status, 404);
  assert.equal(notStrong.status, 422);
  assert.equal((await notStrong.json()).code, "MOCK_INTERVIEW_ANSWER_NOT_STRONG");
  assert.equal(unanswered.status, 404);
  assert.equal(writes["starStory.create"], undefined);
});

// ---------------------------------------------------------------- privacy and wiring

test("account export includes mock interview sessions and account deletion cascades them", () => {
  const exportRoute = readFileSync(new URL("../app/api/account/export/route.ts", import.meta.url), "utf8");
  assert.match(exportRoute, /prisma\.mockInterviewSession\.findMany\(\{ where: \{ userId \}/u);
  assert.match(exportRoute, /\n      mockInterviewSessions,\n/u);
  const schema = readFileSync(new URL("../prisma/schema.prisma", import.meta.url), "utf8");
  const model = schema.match(/model MockInterviewSession \{[\s\S]*?\n\}/u)?.[0] ?? "";
  assert.match(model, /user\s+User\s+@relation\(fields: \[userId\], references: \[id\], onDelete: Cascade\)/u);
  assert.match(model, /interview\s+Interview\?\s+@relation\(fields: \[interviewId\], references: \[id\], onDelete: Cascade\)/u);
});

test("the interview pages carry the practice-only notice and the AI-unavailable state", () => {
  const notice = "For practice before your interview. Don't use AI during a live interview unless the employer allows it.";
  const component = readFileSync(new URL("../components/mock-interview.tsx", import.meta.url), "utf8");
  assert.ok(component.includes(notice));
  assert.match(component, /AI unavailable/u);
  for (const page of ["app/(product)/interviews/[id]/page.tsx", "app/(product)/interviews/page.tsx", "app/(product)/interviews/mock/[sessionId]/page.tsx"]) {
    const source = readFileSync(new URL(`../${page}`, import.meta.url), "utf8");
    assert.match(source, /MockInterviewPracticeNotice|MockInterviewSessionRunner/u, page);
    assert.match(source, /getAiAvailability\(\)/u, page);
  }
});
