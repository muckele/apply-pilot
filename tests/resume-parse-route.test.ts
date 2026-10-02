import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { test, type TestContext } from "node:test";
import type { NextRequest } from "next/server";

import { prisma } from "@/lib/prisma";

const resumeText = `Jordan Example
jordan@example.test

SUMMARY
Customer success manager supporting technical onboarding.

EXPERIENCE
Customer Success Manager
Example Co
Remote
2022 - Present
Led customer onboarding.

EDUCATION
Example University
B.S. Business
2021`;

const parsedOutput = {
  contractVersion: "3",
  contactInfo: {
    email: "jordan@example.test", phone: null, location: null,
    linkedin: null, github: null, portfolio: null
  },
  summary: "Customer success manager supporting technical onboarding.",
  skills: [],
  workHistory: [{
    company: "Example Co", title: "Customer Success Manager", location: "Remote",
    startDate: "2022", endDate: "Present", bullets: ["Led customer onboarding."]
  }],
  projects: [],
  education: [{
    institution: "Example University", credential: "B.S.", fieldOfStudy: "Business",
    startDate: null, endDate: "2021", details: []
  }],
  certifications: [],
  achievements: [],
  sectionStatus: {
    summary: "present", skills: "absent", workHistory: "present", projects: "absent",
    education: "present", certifications: "absent", achievements: "absent"
  },
  warnings: []
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
    AUTH_SECRET: "synthetic-test-secret",
    ALLOW_DEMO_USER: "true",
    NODE_ENV: "test",
    AI_ENABLED: "true",
    AI_PROVIDER: "gemini",
    AI_MOCK_MODE: "false",
    GEMINI_API_KEY: "synthetic-never-log",
    GEMINI_FAST_MODEL: "gemini-3.8-flash",
    OPENAI_API_KEY: undefined,
    OPENAI_MOCK_MODE: undefined,
    FILE_STORAGE_DRIVER: "database"
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

async function invoke(body: unknown, headers: Record<string, string> = {}) {
  const { POST } = await import("@/app/api/resumes/parse/route");
  const { workAsyncStorage } = await import("next/dist/server/app-render/work-async-storage.external.js");
  const { workUnitAsyncStorage } = await import("next/dist/server/app-render/work-unit-async-storage.external.js");
  return workAsyncStorage.run({ route: "/api/resumes/parse" } as never, () =>
    workUnitAsyncStorage.run(
      { type: "request", phase: "action", headers: new Headers(), cookies: {} } as never,
      () => POST(new Request("http://localhost/api/resumes/parse", {
        method: "POST",
        headers: body instanceof FormData ? headers : { "content-type": "application/json", ...headers },
        body: body instanceof FormData ? body : JSON.stringify(body)
      }) as NextRequest)
    ));
}

function setup(t: TestContext, output: unknown = parsedOutput, cached = true, options: {
  throwAfterCommitOnce?: boolean;
} = {}) {
  environment(t);
  const resumes: Array<Record<string, unknown>> = [];
  const analyses: Array<Record<string, unknown>> = [];
  const audits: Array<Record<string, unknown>> = [];
  const storedFiles: Array<Record<string, unknown>> = [];
  let transactions = 0;
  let demotions = 0;
  let throwAfterCommit = options.throwAfterCommitOnce === true;

  function findAnalysis({ where }: { where: { input?: { equals?: unknown } } }) {
    const submissionHash = where.input?.equals;
    return [...analyses].reverse().find((analysis) =>
      (analysis.input as Record<string, unknown> | undefined)?.submissionHash === submissionHash) ?? null;
  }

  stub(t, prisma.user, "upsert", async () => ({ id: "demo-user" }));
  stub(t, prisma, "$queryRaw", async () => [{ count: 1 }]);
  stub(t, prisma.rateLimitBucket, "deleteMany", async () => ({ count: 0 }));
  stub(t, prisma.aISettings, "upsert", async () => ({
    monthlyBudgetCents: 500, automationBudgetCents: 150,
    maxAnalysesPerSync: 5, modelOverride: null
  }));
  stub(t, prisma.aIResponseCache, "findFirst", async () => cached ? { output } : null);
  stub(t, prisma.aIBudgetReservation, "findFirst", async () => null);
  stub(t, prisma.aIAnalysis, "findFirst", async (args: { where: { input?: { equals?: unknown } } }) => findAnalysis(args));
  stub(t, prisma.resume, "findFirst", async ({ where }: { where: { id?: string; userId: string } }) =>
    resumes.find((resume) => resume.id === where.id && resume.userId === where.userId) ?? null);

  const tx = {
    aIAnalysis: {
      findFirst: async (args: { where: { input?: { equals?: unknown } } }) => findAnalysis(args),
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const analysis = { id: `analysis-${analyses.length + 1}`, createdAt: new Date(), ...data };
        analyses.push(analysis);
        return analysis;
      }
    },
    resume: {
      findFirst: async ({ where }: { where: { id?: string; userId: string } }) =>
        resumes.find((resume) => resume.id === where.id && resume.userId === where.userId) ?? null,
      updateMany: async () => {
        demotions += 1;
        let count = 0;
        resumes.forEach((resume) => {
          if (resume.isMaster === true) {
            resume.isMaster = false;
            count += 1;
          }
        });
        return { count };
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const resume = { id: `resume-${resumes.length + 1}`, ...data };
        resumes.push(resume);
        return resume;
      }
    },
    auditLog: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        audits.push(data);
        return { id: `audit-${audits.length}`, ...data };
      }
    },
    storedFile: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const stored = { id: `stored-${storedFiles.length + 1}`, ...data };
        storedFiles.push(stored);
        return { id: stored.id };
      }
    }
  };
  stub(t, prisma, "$transaction", async (callback: (client: typeof tx) => unknown) => {
    transactions += 1;
    const result = await callback(tx);
    if (throwAfterCommit) {
      throwAfterCommit = false;
      throw new Error("synthetic lost commit acknowledgement");
    }
    return result;
  });

  stub(t, prisma.resume, "updateMany", async () => { throw new Error("master switch must be transactional"); });
  stub(t, prisma.resume, "create", async () => { throw new Error("resume create must be transactional"); });
  stub(t, prisma.aIAnalysis, "create", async () => { throw new Error("analysis create must be transactional"); });
  stub(t, prisma.auditLog, "create", async () => { throw new Error("audit create must be transactional"); });
  stub(t, prisma.storedFile, "create", async () => { throw new Error("stored file create must be transactional"); });
  stub(t, prisma.storedFile, "deleteMany", async ({ where }: { where: { id: string; userId: string } }) => {
    const index = storedFiles.findIndex((file) => file.id === where.id && file.userId === where.userId);
    if (index >= 0) storedFiles.splice(index, 1);
    return { count: index >= 0 ? 1 : 0 };
  });

  return {
    resumes,
    analyses,
    audits,
    storedFiles,
    get transactions() { return transactions; },
    get demotions() { return demotions; }
  };
}

test("validated parsing switches the master and records analysis plus audit in one transaction", async (t) => {
  const state = setup(t);
  const response = await invoke({ title: "Jordan Master Resume", pastedText: resumeText, isMaster: true });

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.replayed, false);
  assert.equal(body.resume.title, "Jordan Master Resume");
  assert.equal(body.resume.rawText, resumeText);
  assert.equal(body.resume.isMaster, true);
  assert.equal(state.transactions, 1);
  assert.equal(state.demotions, 1);
  assert.equal(state.resumes.length, 1);
  assert.equal(state.analyses.length, 1);
  assert.equal(state.audits.length, 1);
  assert.equal(state.analyses[0]?.model, "gemini-3.8-flash");
  assert.equal(state.analyses[0]?.promptVersion, "3");
  assert.equal((state.analyses[0]?.input as Record<string, unknown>).resumeId, body.resume.id);
  assert.equal(typeof (state.analyses[0]?.input as Record<string, unknown>).submissionHash, "string");
});

test("an ambiguous client retry replays the committed resume without another master record", async (t) => {
  const state = setup(t);
  const request = { title: "Jordan Master Resume", pastedText: resumeText, isMaster: true };
  const first = await invoke(request);
  assert.equal(first.status, 200);
  const firstBody = await first.json();

  const replay = await invoke(request);
  assert.equal(replay.status, 200);
  const replayBody = await replay.json();
  assert.equal(replayBody.replayed, true);
  assert.equal(replayBody.resume.id, firstBody.resume.id);
  assert.equal(state.resumes.length, 1);
  assert.equal(state.analyses.length, 1);
  assert.equal(state.transactions, 1);
});

test("a lost commit acknowledgement is recovered as a committed replay, not a false no-change error", async (t) => {
  const state = setup(t, parsedOutput, true, { throwAfterCommitOnce: true });
  const response = await invoke({ title: "Jordan Master Resume", pastedText: resumeText, isMaster: true });

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.replayed, true);
  assert.equal(body.resume.isMaster, true);
  assert.equal(state.resumes.length, 1);
  assert.equal(state.analyses.length, 1);
});

test("a historical non-master replay creates a fresh current master", async (t) => {
  const state = setup(t);
  const request = { title: "Jordan Master Resume", pastedText: resumeText, isMaster: true };
  const first = await invoke(request);
  assert.equal(first.status, 200);
  state.resumes[0]!.isMaster = false;

  const restored = await invoke(request);
  assert.equal(restored.status, 200);
  const body = await restored.json();
  assert.equal(body.replayed, false);
  assert.equal(body.resume.isMaster, true);
  assert.equal(state.resumes.length, 2);
  assert.equal(state.analyses.length, 2);
});

test("a file with pasted-equivalent text has distinct replay identity and private storage provenance", async (t) => {
  const state = setup(t);
  const first = await invoke({ title: "Jordan Master Resume", pastedText: resumeText, isMaster: true });
  assert.equal(first.status, 200);

  const form = new FormData();
  form.set("title", "Jordan Master Resume");
  form.set("file", new File([resumeText], "jordan-resume.txt", { type: "text/plain" }));
  const uploaded = await invoke(form);

  assert.equal(uploaded.status, 200);
  const body = await uploaded.json();
  assert.equal(body.replayed, false);
  assert.equal(body.resume.originalName, "jordan-resume.txt");
  assert.equal(body.resume.filePath, "db://stored-1");
  assert.equal(state.resumes.length, 2);
  assert.equal(state.storedFiles.length, 1);
});

test("incomplete provider output leaves the old master untouched and surfaces the failed section", async (t) => {
  const incomplete = structuredClone(parsedOutput);
  incomplete.workHistory = [];
  incomplete.sectionStatus.workHistory = "absent";
  const state = setup(t, incomplete);

  const response = await invoke({ title: "Jordan Master Resume", pastedText: resumeText, isMaster: true });

  assert.equal(response.status, 422);
  const body = await response.json();
  assert.equal(body.code, "RESUME_PARSE_INCOMPLETE");
  assert.equal(body.section, "workHistory");
  assert.equal(body.retryable, false);
  assert.equal(state.transactions, 0);
  assert.equal(state.demotions, 0);
  assert.equal(state.resumes.length, 0);
  assert.equal(state.analyses.length, 0);
  assert.equal(state.audits.length, 0);
});

test("the paid parse confirmation gate runs before any master-resume transaction", async (t) => {
  const state = setup(t, parsedOutput, false);
  const response = await invoke({ title: "Jordan Master Resume", pastedText: resumeText, isMaster: true });

  assert.equal(response.status, 428);
  const body = await response.json();
  assert.equal(body.code, "AI_COST_CONFIRMATION_REQUIRED");
  assert.equal(body.dataType, "resume_text");
  assert.equal(state.transactions, 0);
  assert.equal(state.demotions, 0);
  assert.equal(state.resumes.length, 0);
  assert.equal(state.analyses.length, 0);
  assert.equal(state.audits.length, 0);
});
