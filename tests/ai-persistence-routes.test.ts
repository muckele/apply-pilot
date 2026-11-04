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

test("unavailable resume parsing fails closed and cannot persist heuristic output", async (t) => {
  setEnv(t, {
    OPENAI_API_KEY: undefined,
    OPENAI_MOCK_MODE: undefined,
    GEMINI_API_KEY: undefined,
    AI_ENABLED: "false"
  });
  const { parseResumeTextWithMeta } = await import("@/lib/ai/resume");
  const { LocalAiUnavailableError } = await import("@/lib/ai/client");
  await assert.rejects(
    parseResumeTextWithMeta("EXPERIENCE\nEngineer — Example Co\nEDUCATION\nExample University"),
    LocalAiUnavailableError
  );
  const source = route("app/api/resumes/parse/route.ts");
  assert.match(source, /model: parsedResult\.meta\.model/);
  assert.match(source, /confidence: null/);
  assert.doesNotMatch(source, /heuristic-local|confidence: parsedResult\.meta\.mocked \? null : 70/);
});

test("application document routes use one explicit projection and never persist model self-scores", () => {
  const resumeRoute = route("app/api/jobs/[id]/tailored-resume/route.ts");
  const coverRoute = route("app/api/jobs/[id]/cover-letter/route.ts");
  const handlers = route("lib/jobs/application-document-generation-routes.ts");
  assert.match(handlers, /dependencies\.readApplicationDocumentEvidence\(dependencies\.prismaClient, userId, id\)/);
  assert.match(resumeRoute, /createTailoredResumeRouteHandler\(\{/);
  assert.match(coverRoute, /createCoverLetterRouteHandler\(\{/);
  assert.match(resumeRoute, /createTailoredResumeRouteHandler\(\{[\s\S]*prismaClient: prisma,[\s\S]*readApplicationDocumentEvidence/);
  assert.match(coverRoute, /createCoverLetterRouteHandler\(\{[\s\S]*prismaClient: prisma,[\s\S]*readApplicationDocumentEvidence/);
  assert.match(handlers, /evidenceSnapshotId: fresh\.job\.currentEvidenceSnapshotId/);
  assert.match(handlers, /APPLICATION_DOCUMENT_INPUT_STALE/);
  assert.match(handlers, /PrismaClientKnownRequestError[\s\S]*P2034[\s\S]*APPLICATION_DOCUMENT_INPUT_STALE/);
  assert.doesNotMatch(handlers, /draftCoverLetter\(\{ job, resume, profile \}/);
  assert.match(handlers, /atsCompatibility: null/);
  assert.match(handlers, /jobFitScore: null/);
  assert.match(handlers, /confidence: null/);
  const interviewCreateRoute = route("app/api/interviews/route.ts");
  const interviewPrepRoute = route("app/api/interviews/[id]/prep/route.ts");
  const interviewFeedbackRoute = route("app/api/interviews/[id]/feedback/route.ts");
  const emailDraftRoute = route("app/api/email/draft-reply/route.ts");
  const interviewCreateForm = route("components/interview-create-form.tsx");
  // Saving an interview never calls AI; prep, feedback, and email drafts run on Gemini.
  assert.doesNotMatch(interviewCreateRoute, /generateInterviewPrep|aIAnalysis|deferred/);
  assert.match(interviewPrepRoute, /generateInterviewPrep\(/);
  assert.match(interviewPrepRoute, /aiInvocationFromRequest\(request\)/);
  assert.match(interviewPrepRoute, /confidence: null/);
  assert.match(interviewFeedbackRoute, /generateInterviewFeedback\(/);
  assert.match(interviewFeedbackRoute, /transcriptConsentConfirmed/);
  assert.match(interviewFeedbackRoute, /confidence: null/);
  assert.match(emailDraftRoute, /draftEmailReply\(/);
  assert.match(emailDraftRoute, /requiresApprovalBeforeSending: true/);
  assert.doesNotMatch(interviewCreateForm, /deferred/);
});

test("unavailable personalized match writes no job scores or AI analysis", async (t) => {
  setEnv(t, {
    OPENAI_API_KEY: undefined,
    OPENAI_MOCK_MODE: undefined,
    GEMINI_API_KEY: undefined,
    AI_ENABLED: "false"
  });
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
  const reviewedAt = new Date("2026-10-08T12:00:00.000Z");
  const job = {
    id: "job-1",
    title: "Engineer",
    company: "Acme",
    currentEvidenceSnapshotId: "snapshot-1",
    evidenceSnapshotGeneration: 1,
    currentEvidenceSnapshot: {
      id: "snapshot-1",
      resumeId: "resume-1",
      sourceResumeUpdatedAt: reviewedAt,
      snapshotHash: "a".repeat(64),
      reviewPayload: { schema: "apply-pilot/evidence-snapshot-payload/v1", decisions: [] }
    }
  };
  let versions = 0;
  let analyses = 0;
  let audits = 0;
  stub(t, prisma.jobPosting, "findFirstOrThrow", async () => job);
  stub(t, prisma.resume, "findFirst", async () => ({
    id: "resume-1",
    updatedAt: reviewedAt,
    rawText: "Alice Example\nExcel"
  }));
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

function paidGeminiEnvironment(t: TestContext) {
  setEnv(t, {
    AI_ENABLED: "true",
    AI_MOCK_MODE: "false",
    AI_PROVIDER: undefined,
    GEMINI_API_KEY: "synthetic-never-log",
    OPENAI_API_KEY: "synthetic-openai-must-not-be-used",
    AI_MAX_REQUEST_COST_CENTS: undefined,
    AI_CONFIRMATION_THRESHOLD_CENTS: undefined
  });
}

type TxRecorder = Record<string, Array<Record<string, unknown>>>;

// One transaction stub serves both the hard budget ledger and the route's own writes.
function installRouteLedger(t: TestContext, prisma: typeof import("@/lib/prisma").prisma) {
  const writes: TxRecorder = {};
  const record = (name: string) => async (args: Record<string, unknown>) => {
    (writes[name] ??= []).push(args);
    return { id: `${name}-1`, ...((args.data ?? args.create ?? {}) as Record<string, unknown>) };
  };
  let reservation: Record<string, unknown> | null = null;
  stub(t, prisma.aIResponseCache, "findFirst", async () => null);
  stub(t, prisma.aIBudgetReservation, "findMany", async () => []);
  stub(t, prisma.aIBudgetReservation, "findFirst", async () => null);
  stub(t, prisma.aISettings, "upsert", async () => ({
    monthlyBudgetCents: 500, automationBudgetCents: 150, maxAnalysesPerSync: 5, modelOverride: null
  }));
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
    aIResponseCache: { upsert: async ({ create }: { create: unknown }) => create },
    $executeRaw: async () => 1,
    interview: { update: record("interview.update") },
    interviewQuestion: { upsert: record("interviewQuestion.upsert") },
    starStory: { findFirst: async () => null, create: record("starStory.create") },
    aIAnalysis: { create: record("aIAnalysis.create") },
    auditLog: { create: record("auditLog.create") },
    emailMessage: { update: record("emailMessage.update") },
    generatedDocument: { create: record("generatedDocument.create") }
  };
  stub(t, prisma, "$transaction", async (callback: (transaction: typeof tx) => unknown) => callback(tx));
  stub(t, prisma.auditLog, "create", record("auditLog.create"));
  return writes;
}

function installGeminiResponse(t: TestContext, respond: (payload: Record<string, unknown>) => unknown) {
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

const confirmedHeaders = {
  "content-type": "application/json",
  "x-ai-cost-confirmed": "true",
  "x-ai-data-confirmed": "true"
};

test("email drafting runs on Gemini, persists a review-only draft, and never sends", async (t) => {
  const prisma = await localRouteSetup(t);
  paidGeminiEnvironment(t);
  const writes = installRouteLedger(t, prisma);
  const calls = installGeminiResponse(t, () => ({
    summary: "Recruiter asks for availability.",
    requestedAction: "Share availability.",
    deadline: "Friday",
    draftResponse: "Hi,\n\nThanks for reaching out. I am available [your availability].\n\nBest,\n[Your name]",
    suggestedFollowUpTask: "Reply by Friday.",
    placeholders: ["[your availability]", "[Your name]"]
  }));
  stub(t, prisma.emailMessage, "findFirst", async () => null);
  stub(t, prisma.jobPosting, "findFirst", async () => null);
  const { POST } = await import("../app/api/email/draft-reply/route");

  const response = await invokeRoute("/api/email/draft-reply", () => POST(new Request("http://localhost/api/email/draft-reply", {
    method: "POST",
    headers: confirmedHeaders,
    body: JSON.stringify({ emailText: "Could you share your availability next week?", tone: "warm" })
  }) as NextRequest));

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.requiresApprovalBeforeSending, true);
  assert.equal(body.drafted.deadline, "Friday");
  assert.equal(body.drafted.provider, "gemini");
  assert.equal(calls(), 1);
  assert.equal(writes.reservation[0].feature, "EMAIL_REPLY");
  assert.equal(writes["generatedDocument.create"].length, 1);
  assert.equal(writes["emailMessage.update"], undefined);
});

test("email drafting refuses another user's email before any AI work", async (t) => {
  const prisma = await localRouteSetup(t);
  paidGeminiEnvironment(t);
  const writes = installRouteLedger(t, prisma);
  const calls = installGeminiResponse(t, () => ({}));
  const queries: Array<Record<string, unknown>> = [];
  stub(t, prisma.emailMessage, "findFirst", async (query: Record<string, unknown>) => { queries.push(query); return null; });
  stub(t, prisma.jobPosting, "findFirst", async () => null);
  const { POST } = await import("../app/api/email/draft-reply/route");

  const response = await invokeRoute("/api/email/draft-reply", () => POST(new Request("http://localhost/api/email/draft-reply", {
    method: "POST",
    headers: confirmedHeaders,
    body: JSON.stringify({ emailMessageId: "other-users-email", emailText: "Hello there recruiter", tone: "concise" })
  }) as NextRequest));

  assert.equal(response.status, 404);
  assert.equal((queries[0].where as Record<string, unknown>).id, "other-users-email");
  assert.equal(typeof (queries[0].where as Record<string, unknown>).userId, "string");
  assert.equal(calls(), 0);
  assert.equal(writes.reservation, undefined);
});

test("interview prep runs on Gemini for the owner's interview and saves prep, questions, and STAR stories", async (t) => {
  const prisma = await localRouteSetup(t);
  paidGeminiEnvironment(t);
  const writes = installRouteLedger(t, prisma);
  stub(t, prisma.interview, "findFirst", async () => ({
    id: "interview-1",
    type: "TECHNICAL",
    jobPosting: { id: "job-1", title: "Platform Engineer", company: "Example Co", description: "TypeScript", requirements: [] },
    application: null
  }));
  stub(t, prisma.resume, "findFirst", async () => ({
    id: "resume-1",
    summary: "Platform engineer.",
    skills: ["TypeScript"],
    achievements: ["Reduced deploy time by 30%."],
    workHistory: [],
    rawText: "private raw text",
    contactInfo: { email: "private@example.test" }
  }));
  stub(t, prisma.userProfile, "findUnique", async () => ({ workAuthorizationNotes: "private note", skillsNotToExaggerate: [] }));
  const calls = installGeminiResponse(t, (payload) => {
    assert.doesNotMatch(JSON.stringify(payload), /private raw text|private@example\.test|private note/u);
    const facts = payload.applicantFacts as Array<{ factId: string; text: string }>;
    return {
      prepBrief: "Discuss TypeScript reliability.",
      likelyQuestions: [{ question: "Tell me about a time you improved deployments?", basis: "applicant_history" }],
      starStories: [{
        theme: "Faster deploys",
        situation: "Deploys were slow.",
        task: "Speed them up.",
        action: "Rebuilt the pipeline.",
        result: "Reduced deploy time by 30%.",
        factIds: [facts.find((fact) => fact.text.includes("30%"))!.factId]
      }],
      questionsToAsk: ["What does success look like?"],
      risksToPrepareFor: []
    };
  });
  const { POST } = await import("../app/api/interviews/[id]/prep/route");

  const response = await invokeRoute("/api/interviews/interview-1/prep", () => POST(
    new Request("http://localhost/api/interviews/interview-1/prep", { method: "POST", headers: confirmedHeaders, body: "{}" }) as NextRequest,
    { params: Promise.resolve({ id: "interview-1" }) }
  ));

  assert.equal(response.status, 200);
  assert.equal(calls(), 1);
  assert.equal(writes.reservation[0].feature, "INTERVIEW_PREP");
  const update = writes["interview.update"][0].data as Record<string, unknown>;
  assert.equal(update.prepBrief, "Discuss TypeScript reliability.");
  assert.equal(writes["interviewQuestion.upsert"].length, 1);
  assert.equal(writes["starStory.create"].length, 1);
  const analysis = writes["aIAnalysis.create"][0].data as Record<string, unknown>;
  assert.equal(analysis.type, "INTERVIEW_PREP");
  assert.equal(analysis.confidence, null);
});

test("interview prep without confirmation returns 428 and makes no reservation or provider call", async (t) => {
  const prisma = await localRouteSetup(t);
  paidGeminiEnvironment(t);
  const writes = installRouteLedger(t, prisma);
  stub(t, prisma.interview, "findFirst", async () => ({ id: "interview-1", type: "RECRUITER", jobPosting: null, application: null }));
  stub(t, prisma.resume, "findFirst", async () => null);
  stub(t, prisma.userProfile, "findUnique", async () => null);
  const calls = installGeminiResponse(t, () => ({}));
  const { POST } = await import("../app/api/interviews/[id]/prep/route");

  const response = await invokeRoute("/api/interviews/interview-1/prep", () => POST(
    new Request("http://localhost/api/interviews/interview-1/prep", { method: "POST", body: "{}" }) as NextRequest,
    { params: Promise.resolve({ id: "interview-1" }) }
  ));

  assert.equal(response.status, 428);
  const body = await response.json();
  assert.equal(body.code, "AI_COST_CONFIRMATION_REQUIRED");
  assert.equal(body.dataType, "interview_prep_packet");
  assert.equal(calls(), 0);
  assert.equal(writes.reservation, undefined);
});

test("interview feedback is owner-scoped and refuses an unconsented pasted transcript before AI work", async (t) => {
  const prisma = await localRouteSetup(t);
  paidGeminiEnvironment(t);
  const writes = installRouteLedger(t, prisma);
  const calls = installGeminiResponse(t, () => ({}));
  const queries: Array<Record<string, unknown>> = [];
  let found = false;
  stub(t, prisma.interview, "findFirst", async (query: Record<string, unknown>) => {
    queries.push(query);
    return found
      ? { id: "interview-1", type: "TECHNICAL", notes: "Asked about incidents.", notesList: [], jobPosting: null, application: null }
      : null;
  });
  stub(t, prisma.resume, "findFirst", async () => null);
  const { POST } = await import("../app/api/interviews/[id]/feedback/route");
  const send = (body: unknown) => invokeRoute("/api/interviews/interview-1/feedback", () => POST(
    new Request("http://localhost/api/interviews/interview-1/feedback", {
      method: "POST", headers: confirmedHeaders, body: JSON.stringify(body)
    }) as NextRequest,
    { params: Promise.resolve({ id: "interview-1" }) }
  ));

  const missing = await send({});
  assert.equal(missing.status, 404);
  assert.equal(typeof (queries[0].where as Record<string, unknown>).userId, "string");

  found = true;
  const unconsented = await send({ transcript: "Interviewer: hello" });
  assert.equal(unconsented.status, 422);
  assert.equal((await unconsented.json()).code, "INTERVIEW_TRANSCRIPT_CONSENT_REQUIRED");
  assert.equal(calls(), 0);
  assert.equal(writes.reservation, undefined);
});

test("interview feedback runs on Gemini and saves a thank-you draft for the user to send", async (t) => {
  const prisma = await localRouteSetup(t);
  paidGeminiEnvironment(t);
  const writes = installRouteLedger(t, prisma);
  stub(t, prisma.interview, "findFirst", async () => ({
    id: "interview-1", type: "TECHNICAL", notes: "Asked about incidents.",
    notesList: [{ body: "Asked about incidents." }], jobPosting: null, application: null
  }));
  stub(t, prisma.resume, "findFirst", async () => null);
  const calls = installGeminiResponse(t, (payload) => {
    assert.deepEqual(payload.notes, [{ noteId: "note-1", text: "Asked about incidents." }]);
    assert.deepEqual(payload.transcriptSections, ["Interviewer: How do you handle incidents?"]);
    return {
      summary: "Good discussion.",
      questionsAsked: ["How do you handle incidents?"],
      strongMoments: [],
      weakAnswers: [],
      betterAnswers: [],
      thankYouEmailDraft: "Hi [Interviewer name], thank you for your time. [Your name]"
    };
  });
  const { POST } = await import("../app/api/interviews/[id]/feedback/route");

  const response = await invokeRoute("/api/interviews/interview-1/feedback", () => POST(
    new Request("http://localhost/api/interviews/interview-1/feedback", {
      method: "POST",
      headers: confirmedHeaders,
      body: JSON.stringify({ transcript: "Interviewer: How do you handle incidents?", transcriptConsentConfirmed: true })
    }) as NextRequest,
    { params: Promise.resolve({ id: "interview-1" }) }
  ));

  assert.equal(response.status, 200);
  assert.equal((await response.json()).requiresApprovalBeforeSending, true);
  assert.equal(calls(), 1);
  assert.equal(writes.reservation[0].feature, "INTERVIEW_FEEDBACK");
  assert.match(String((writes["interview.update"][0].data as Record<string, unknown>).followUpEmailDraft), /\[Interviewer name\]/u);
  assert.doesNotMatch(JSON.stringify(writes["aIAnalysis.create"][0]), /Interviewer: How/u, "the transcript is not stored");
});

test("interview scheduling saves without any AI call", async (t) => {
  const prisma = await localRouteSetup(t);
  paidGeminiEnvironment(t);
  let providerCalls = 0;
  let profileReads = 0;
  let resumeReads = 0;
  let interviewWrites = 0;
  let audits = 0;
  stub(t, globalThis, "fetch", async () => {
    providerCalls++;
    throw new Error("Saving an interview must not call AI");
  });
  stub(t, prisma.jobPosting, "findFirstOrThrow", async () => ({ id: "job-1" }));
  stub(t, prisma.userProfile, "findUnique", async () => { profileReads++; return null; });
  stub(t, prisma.resume, "findFirst", async () => { resumeReads++; return null; });
  stub(t, prisma, "$transaction", async (action: (tx: unknown) => Promise<unknown>) => action({
    interview: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        interviewWrites++;
        return { id: "interview-1", ...data };
      }
    },
    auditLog: { create: async () => { audits++; return { id: "audit-1" }; } }
  }));
  const { POST } = await import("../app/api/interviews/route");
  const request = new Request("http://localhost/api/interviews", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jobPostingId: "job-1", type: "RECRUITER", generatePrep: true })
  });

  const response = await invokeRoute("/api/interviews", () => POST(request as NextRequest));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.interview.id, "interview-1");
  assert.equal(body.prep, null);
  assert.equal(body.aiGeneration, undefined);
  assert.deepEqual({ providerCalls, profileReads, resumeReads, interviewWrites, audits }, {
    providerCalls: 0, profileReads: 0, resumeReads: 0, interviewWrites: 1, audits: 1
  });
});
