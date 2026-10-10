import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { after, test, type TestContext } from "node:test";
import type { NextRequest } from "next/server";
import { buildApplicationDocumentFactCatalog } from "@/lib/ai/application-document-facts";

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

function stub(t: TestContext, owner: object, name: string, replacement: unknown) {
  const methods = owner as Record<string, unknown>;
  const original = methods[name];
  methods[name] = replacement;
  t.after(() => { methods[name] = original; });
}

function setEnv(t: TestContext) {
  const changes: Record<string, string> = {
    AI_ENABLED: "true",
    AI_MOCK_MODE: "false",
    AI_PROVIDER: "gemini",
    AI_PROVIDER_OVERRIDES: "",
    GEMINI_API_KEY: "synthetic-never-log",
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

function geminiResponse(value: unknown, outputTokens: number) {
  return new Response(JSON.stringify({
    candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(value) }] } }],
    usageMetadata: {
      promptTokenCount: 100,
      cachedContentTokenCount: 0,
      candidatesTokenCount: outputTokens,
      thoughtsTokenCount: 0,
      totalTokenCount: 100 + outputTokens
    }
  }), { status: 200, headers: { "content-type": "application/json" } });
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

const reviewedAt = new Date("2026-10-08T12:00:00.000Z");
const job = {
  id: "job-1",
  userId: "demo-user",
  title: "Platform Engineer",
  company: "Example Co",
  location: "Remote",
  remoteStatus: "Remote",
  salaryMin: null,
  salaryMax: null,
  description: "Build reliable TypeScript services.",
  requirements: ["TypeScript"],
  preferredQualifications: ["Kubernetes"],
  detectedTechStack: ["TypeScript", "Kubernetes"],
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

const resume = {
  id: "resume-1",
  userId: "demo-user",
  updatedAt: reviewedAt,
  rawText: [
    "Synthetic Applicant",
    "Platform Engineer",
    "TypeScript",
    "Example Co | Platform Engineer",
    "Built reliable TypeScript services."
  ].join("\n"),
  summary: "Platform engineer who built reliable TypeScript services.",
  skills: ["TypeScript"],
  achievements: [],
  workHistory: [{
    sourceText: "Example Co | Platform Engineer\nBuilt reliable TypeScript services.",
    company: "Example Co",
    title: "Platform Engineer",
    location: "Remote",
    startDate: "2024",
    endDate: "Present",
    bullets: ["Built reliable TypeScript services."]
  }],
  projects: [],
  education: [],
  certifications: []
};

const profile = {
  id: "profile-1",
  userId: "demo-user",
  careerGoals: "Continue building reliable systems.",
  preferredRoles: ["Platform Engineer"],
  preferredLocations: ["Remote"],
  remotePreference: "Remote",
  salaryTargetMin: null,
  salaryTargetMax: null,
  skillsToEmphasize: ["TypeScript"],
  skillsNotToExaggerate: ["Kubernetes"]
};

function documentFactId(excerpt: string) {
  const fact = buildApplicationDocumentFactCatalog({
    job,
    resume,
    profile,
    reviewedEvidence: { facts: [] }
  }).find((entry) => entry.excerpt === excerpt);
  assert.ok(fact, `missing document fact: ${excerpt}`);
  return fact.factId;
}

async function setup(t: TestContext) {
  setEnv(t);
  const { prisma } = await import("@/lib/prisma");
  stub(t, prisma.user, "upsert", async () => ({ id: "demo-user" }));
  stub(t, prisma, "$queryRaw", async () => [{ count: 1 }]);
  stub(t, prisma.rateLimitBucket, "deleteMany", async () => ({ count: 0 }));
  stub(t, prisma.jobPosting, "findFirstOrThrow", async () => job);
  stub(t, prisma.resume, "findFirst", async () => resume);
  stub(t, prisma.userProfile, "findUnique", async () => profile);
  stub(t, prisma.aIResponseCache, "findFirst", async () => null);
  stub(t, prisma.aIBudgetReservation, "findMany", async () => []);
  stub(t, prisma.aIBudgetReservation, "findFirst", async () => null);
  stub(t, prisma.aISettings, "upsert", async () => ({
    monthlyBudgetCents: 500,
    automationBudgetCents: 150,
    maxAnalysesPerSync: 5,
    modelOverride: null
  }));
  return prisma;
}

function installLedger(t: TestContext, prisma: Awaited<ReturnType<typeof setup>>) {
  let reservation: Record<string, unknown> | null = null;
  const reconciliations: Array<Record<string, unknown>> = [];
  const cacheWrites: Array<Record<string, unknown>> = [];
  const tx = {
    jobPosting: {
      findFirstOrThrow: (args: unknown) => prisma.jobPosting.findFirstOrThrow(args as never)
    },
    resume: {
      findFirst: (args: unknown) => prisma.resume.findFirst(args as never)
    },
    userProfile: {
      findUnique: (args: unknown) => prisma.userProfile.findUnique(args as never)
    },
    resumeVersion: {
      create: (args: unknown) => prisma.resumeVersion.create(args as never)
    },
    generatedDocument: {
      create: (args: unknown) => prisma.generatedDocument.create(args as never)
    },
    aIAnalysis: {
      create: (args: unknown) => prisma.aIAnalysis.create(args as never)
    },
    aIBudgetLedger: {
      upsert: async () => ({ id: "ledger-1" }),
      updateMany: async () => ({ count: 1 })
    },
    aIBudgetReservation: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        reservation = { id: "reservation-1", ledgerId: "ledger-1", status: "RESERVED", ...data };
        return reservation;
      },
      findUniqueOrThrow: async () => reservation,
      update: async ({ data }: { data: Record<string, unknown> }) => {
        reconciliations.push(data);
        reservation = { ...reservation, ...data };
        return reservation;
      }
    },
    aIUsageEvent: { create: async () => ({}) },
    aIResponseCache: {
      upsert: async ({ create }: { create: Record<string, unknown> }) => {
        cacheWrites.push(create);
        return create;
      }
    },
    $executeRaw: async () => 1,
    $queryRaw: async () => [{ id: job.id }]
  };
  stub(t, prisma, "$transaction", async (callback: (transaction: typeof tx) => unknown) => callback(tx));
  return { reconciliations, cacheWrites };
}

test("both application-document routes require the private-data consent contract before any provider call or write", async (t) => {
  const prisma = await setup(t);
  let providerCalls = 0;
  let writes = 0;
  stub(t, globalThis, "fetch", async () => { providerCalls += 1; throw new Error("must not call"); });
  stub(t, prisma.resumeVersion, "create", async () => { writes += 1; return {}; });
  stub(t, prisma.generatedDocument, "create", async () => { writes += 1; return {}; });
  stub(t, prisma.aIAnalysis, "create", async () => { writes += 1; return {}; });
  stub(t, prisma.auditLog, "create", async () => { writes += 1; return {}; });
  const resumeRoute = await import("../app/api/jobs/[id]/tailored-resume/route");
  const coverRoute = await import("../app/api/jobs/[id]/cover-letter/route");

  for (const [path, post] of [
    ["/api/jobs/job-1/tailored-resume", resumeRoute.POST],
    ["/api/jobs/job-1/cover-letter", coverRoute.POST]
  ] as const) {
    const response = await invokeRoute(path, () => post(
      new Request(`http://localhost${path}`, { method: "POST" }) as NextRequest,
      { params: Promise.resolve({ id: job.id }) }
    ));
    assert.equal(response.status, 428);
    const body = await response.json();
    assert.equal(body.dataType, "application_packet");
    assert.equal(body.provider, "gemini");
    assert.equal(body.model, "gemini-3.8-flash");
    assert.equal(body.promptVersion, "8");
  }
  assert.equal(providerCalls, 0);
  assert.equal(writes, 0);
});

test("a supported stubbed résumé result is persisted only after v8 atomic-fact validation", async (t) => {
  const prisma = await setup(t);
  const ledger = installLedger(t, prisma);
  const facts = buildApplicationDocumentFactCatalog({ job, resume, profile, reviewedEvidence: { facts: [] } });
  const output = {
    professionalSummary: resume.summary,
    professionalSummaryFactId: documentFactId(resume.summary),
    skillsSection: [{ text: "TypeScript", factId: documentFactId("TypeScript") }],
    bulletRewrites: [{
      factId: documentFactId("Built reliable TypeScript services."),
      rewrite: "Built reliable TypeScript services.",
      reason: "Preserves the supported result."
    }],
    rolesOrProjectsToEmphasize: [{
      text: "Platform Engineer",
      factId: documentFactId("Platform Engineer")
    }],
    resumeTextClaims: facts.map((fact) => ({ claim: fact.excerpt, factId: fact.factId })),
    unsupportedKeywords: ["Kubernetes"],
    formattingWarnings: [],
    resumeText: `${resume.rawText}\n\nSUMMARY\n${resume.summary}\n\n${facts.map((fact) => fact.excerpt).join("\n")}`
  };
  let providerCalls = 0;
  let versionData: Record<string, unknown> | null = null;
  let analysisData: Record<string, unknown> | null = null;
  stub(t, globalThis, "fetch", async () => {
    providerCalls += 1;
    return geminiResponse(output, 200);
  });
  stub(t, prisma.resumeVersion, "create", async ({ data }: { data: Record<string, unknown> }) => {
    versionData = data;
    return { id: "version-1", ...data };
  });
  stub(t, prisma.aIAnalysis, "create", async ({ data }: { data: Record<string, unknown> }) => {
    analysisData = data;
    return { id: "analysis-1", ...data };
  });
  stub(t, prisma.auditLog, "create", async () => ({ id: "audit-1" }));
  const { POST } = await import("../app/api/jobs/[id]/tailored-resume/route");
  const response = await invokeRoute("/api/jobs/job-1/tailored-resume", () => POST(
    new Request("http://localhost/api/jobs/job-1/tailored-resume", {
      method: "POST",
      headers: { "x-ai-cost-confirmed": "true", "x-ai-data-confirmed": "true" }
    }) as NextRequest,
    { params: Promise.resolve({ id: job.id }) }
  ));

  assert.equal(response.status, 200);
  assert.equal(providerCalls, 1);
  const persistedVersion = versionData as unknown as Record<string, unknown>;
  const persistedAnalysis = analysisData as unknown as Record<string, unknown>;
  assert.equal(persistedVersion.atsCompatibility, null);
  assert.equal(persistedVersion.jobFitScore, null);
  assert.equal(persistedAnalysis.confidence, null);
  assert.equal(persistedAnalysis.promptVersion, "8");
  assert.equal(ledger.reconciliations[0].status, "SUCCEEDED");
  assert.equal(ledger.cacheWrites.length, 1);
});

test("an unsupported stubbed cover-letter claim is billed as failed and never persisted or cached", async (t) => {
  const prisma = await setup(t);
  const ledger = installLedger(t, prisma);
  let writes = 0;
  stub(t, globalThis, "fetch", async () => geminiResponse({
        title: "Example Co cover letter",
        coverLetter: "Dear Example Co,\n\nI led a Kubernetes migration for 14 engineers.\n\nSincerely,\nSynthetic Applicant",
        angle: "Invented synthetic claim that must be rejected.",
        claimsUsed: [{
          claim: "I led a Kubernetes migration for 14 engineers.",
          factId: documentFactId("TypeScript")
        }]
      }, 80));
  stub(t, prisma.generatedDocument, "create", async () => { writes += 1; return {}; });
  stub(t, prisma.aIAnalysis, "create", async () => { writes += 1; return {}; });
  stub(t, prisma.auditLog, "create", async () => { writes += 1; return {}; });
  const { POST } = await import("../app/api/jobs/[id]/cover-letter/route");
  const response = await invokeRoute("/api/jobs/job-1/cover-letter", () => POST(
    new Request("http://localhost/api/jobs/job-1/cover-letter", {
      method: "POST",
      headers: { "x-ai-cost-confirmed": "true", "x-ai-data-confirmed": "true" }
    }) as NextRequest,
    { params: Promise.resolve({ id: job.id }) }
  ));

  assert.equal(response.status, 422);
  const body = await response.json();
  assert.equal(body.code, "APPLICATION_DOCUMENT_UNSUPPORTED_CLAIM");
  assert.equal(body.fieldPath, "claimsUsed[0].claim");
  assert.equal(body.billingStatus, "known");
  assert.equal(body.actualCostMicros, 375);
  assert.doesNotMatch(JSON.stringify(body), /14 engineers/);
  assert.equal(writes, 0);
  assert.equal(ledger.reconciliations[0].status, "FAILED");
  assert.equal(ledger.cacheWrites.length, 0);
});
