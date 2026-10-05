import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { access, readFile } from "node:fs/promises";
import { test, type TestContext } from "node:test";
import type { NextRequest } from "next/server";

import { prisma } from "@/lib/prisma";
import { buildApplicationPlanPayload } from "@/lib/ai/application-plan";
import { getJobMatchEvidenceReferences, type MatchInput } from "@/lib/ai/job-match";
import { buildResumeTailoringPayload } from "@/lib/ai/resume-tailoring-payload";
import { deletePrivateLocalFilesForUser } from "@/lib/storage/private-files";
import {
  syntheticDocxExtractedText,
  syntheticDocxProviderOutput
} from "@/tests/fixtures/resume-contract-v5-data";
import {
  fullSizeSyntheticDocxExtractedText,
  fullSizeSyntheticProviderOutput
} from "@/tests/fixtures/resume-estimator-boundary-data";
import { providerV9FromCanonical } from "@/tests/fixtures/resume-v9-provider-data";
import {
  resumeV9StructuralTwinCanonical,
  resumeV9StructuralTwinDocxText
} from "@/tests/fixtures/resume-v9-structural-twin-data";
import type { ResumeParseProviderV9 } from "@/lib/ai/resume";

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
  contractVersion: "5",
  sourceSections: [
    {
      section: "contactInfo",
      heading: null,
      sourceText: "Jordan Example\njordan@example.test",
      recordBlocks: ["Jordan Example\njordan@example.test"]
    },
    {
      section: "summary",
      heading: "SUMMARY",
      sourceText: "Customer success manager supporting technical onboarding.",
      recordBlocks: ["Customer success manager supporting technical onboarding."]
    },
    {
      section: "workHistory",
      heading: "EXPERIENCE",
      sourceText: "Customer Success Manager\nExample Co\nRemote\n2022 - Present\nLed customer onboarding.",
      recordBlocks: ["Customer Success Manager\nExample Co\nRemote\n2022 - Present\nLed customer onboarding."]
    },
    {
      section: "education",
      heading: "EDUCATION",
      sourceText: "Example University\nB.S. Business\n2021",
      recordBlocks: ["Example University\nB.S. Business\n2021"]
    }
  ],
  contactInfo: {
    sourceText: "Jordan Example\njordan@example.test",
    name: "Jordan Example",
    headline: null,
    email: "jordan@example.test", phone: null, location: null,
    linkedin: null, github: null, portfolio: null
  },
  summary: "Customer success manager supporting technical onboarding.",
  skills: [],
  workHistory: [{
    sourceText: "Customer Success Manager\nExample Co\nRemote\n2022 - Present\nLed customer onboarding.",
    company: "Example Co", title: "Customer Success Manager", location: "Remote",
    startDate: "2022", endDate: "Present", bullets: ["Led customer onboarding."]
  }],
  projects: [],
  education: [{
    sourceText: "Example University\nB.S. Business\n2021",
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

const SUBMISSION_ID_1 = "00000000-0000-4000-8000-000000000001";
const SUBMISSION_ID_2 = "00000000-0000-4000-8000-000000000002";

function stub(t: TestContext, owner: object, name: string, replacement: unknown) {
  const methods = owner as Record<string, unknown>;
  const original = methods[name];
  methods[name] = replacement;
  t.after(() => { methods[name] = original; });
}

function environment(t: TestContext, fileStorageDriver = "database") {
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
    FILE_STORAGE_DRIVER: fileStorageDriver
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
  const requestBody = body instanceof FormData
    ? body
    : { submissionId: SUBMISSION_ID_1, ...(body as Record<string, unknown>) };
  return workAsyncStorage.run({ route: "/api/resumes/parse" } as never, () =>
    workUnitAsyncStorage.run(
      { type: "request", phase: "action", headers: new Headers(), cookies: {} } as never,
      () => POST(new Request("http://localhost/api/resumes/parse", {
        method: "POST",
        headers: requestBody instanceof FormData ? headers : { "content-type": "application/json", ...headers },
        body: requestBody instanceof FormData ? requestBody : JSON.stringify(requestBody)
      }) as NextRequest)
    ));
}

function setup(t: TestContext, output: unknown = parsedOutput, cached = true, options: {
  throwAfterCommitOnce?: boolean;
  simulateLocalLoserRace?: boolean;
} = {}) {
  environment(t, options.simulateLocalLoserRace ? "local" : "database");
  const resumes: Array<Record<string, unknown>> = [];
  const analyses: Array<Record<string, unknown>> = [];
  const audits: Array<Record<string, unknown>> = [];
  const storedFiles: Array<Record<string, unknown>> = [];
  const aiCacheWrites: Array<Record<string, unknown>> = [];
  let transactions = 0;
  let demotions = 0;
  let throwAfterCommit = options.throwAfterCommitOnce === true;
  let rolledBackFilePath: string | null = null;
  let reservation: Record<string, unknown> | null = null;

  function findAnalysis({ where }: { where: { input?: { path?: string[]; equals?: unknown } } }) {
    const field = where.input?.path?.[0];
    const expected = where.input?.equals;
    return [...analyses].reverse().find((analysis) =>
      field && (analysis.input as Record<string, unknown> | undefined)?.[field] === expected) ?? null;
  }

  stub(t, prisma.user, "upsert", async () => ({ id: "demo-user" }));
  stub(t, prisma, "$queryRaw", async () => [{ count: 1 }]);
  stub(t, prisma.rateLimitBucket, "deleteMany", async () => ({ count: 0 }));
  stub(t, prisma.aISettings, "upsert", async () => ({
    monthlyBudgetCents: 500, automationBudgetCents: 150,
    maxAnalysesPerSync: 5, modelOverride: null
  }));
  stub(t, prisma.aIResponseCache, "findFirst", async () => cached ? { output } : null);
  stub(t, prisma.aIBudgetReservation, "findMany", async () => []);
  stub(t, prisma.aIBudgetReservation, "findFirst", async () => null);
  stub(t, prisma.aIAnalysis, "findFirst", async (args: { where: { input?: { path?: string[]; equals?: unknown } } }) => findAnalysis(args));
  stub(t, prisma.resume, "findFirst", async ({ where }: { where: { id?: string; userId: string } }) =>
    resumes.find((resume) => resume.id === where.id && resume.userId === where.userId) ?? null);

  const tx = {
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
        reservation = { ...reservation, ...data };
        return reservation;
      }
    },
    aIUsageEvent: { create: async ({ data }: { data: Record<string, unknown> }) => data },
    aIResponseCache: {
      upsert: async ({ create }: { create: Record<string, unknown> }) => {
        aiCacheWrites.push(create);
        return create;
      }
    },
    $executeRaw: async () => 1,
    aIAnalysis: {
      findFirst: async (args: { where: { input?: { path?: string[]; equals?: unknown } } }) => findAnalysis(args),
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
    if (options.simulateLocalLoserRace) {
      const loserResume = (result as { resume: Record<string, unknown> }).resume;
      const loserAnalysis = analyses.at(-1);
      rolledBackFilePath = typeof loserResume.filePath === "string" ? loserResume.filePath : null;
      resumes.splice(resumes.indexOf(loserResume), 1);
      if (loserAnalysis) analyses.splice(analyses.indexOf(loserAnalysis), 1);
      audits.length = 0;
      const winnerResume = { ...loserResume, id: "resume-winner", filePath: null };
      resumes.push(winnerResume);
      if (loserAnalysis) {
        analyses.push({
          ...loserAnalysis,
          id: "analysis-winner",
          input: {
            ...(loserAnalysis.input as Record<string, unknown>),
            resumeId: winnerResume.id
          }
        });
      }
      throw new Error("synthetic serializable loser after local file write");
    }
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
    aiCacheWrites,
    get rolledBackFilePath() { return rolledBackFilePath; },
    get transactions() { return transactions; },
    get demotions() { return demotions; }
  };
}

function providerResponse(value: unknown) {
  return new Response(JSON.stringify({
    candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(value) }] } }],
    usageMetadata: {
      promptTokenCount: 4_000,
      candidatesTokenCount: 7_500,
      thoughtsTokenCount: 100,
      totalTokenCount: 11_600
    }
  }), { status: 200, headers: { "content-type": "application/json" } });
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
  assert.equal(state.analyses[0]?.promptVersion, "11");
  assert.equal((state.analyses[0]?.input as Record<string, unknown>).resumeId, body.resume.id);
  assert.equal(typeof (state.analyses[0]?.input as Record<string, unknown>).submissionHash, "string");
});

const invalidV9RouteCases: Array<{
  name: string;
  mutate: (output: ResumeParseProviderV9) => void;
}> = [
  {
    name: "omitted server-owned record projection",
    mutate: (output) => {
      output.workHistory.splice(0, 1);
    }
  },
  {
    name: "invented record identity",
    mutate: (output) => { output.workHistory[0]!.recordId = "section-4-record-999"; }
  },
  {
    name: "reordered record identity",
    mutate: (output) => {
      [output.workHistory[0]!.recordId, output.workHistory[1]!.recordId] = [
        output.workHistory[1]!.recordId,
        output.workHistory[0]!.recordId
      ];
    }
  },
  {
    name: "duplicated adjacent record reference",
    mutate: (output) => {
      output.workHistory[1]!.recordId = output.workHistory[0]!.recordId;
    }
  }
];

for (const invalidCase of invalidV9RouteCases) {
  test(`v9 ${invalidCase.name} writes no resume, analysis, audit, or cache`, async (t) => {
    const state = setup(t, undefined, false);
    const output = providerV9FromCanonical(
      fullSizeSyntheticDocxExtractedText,
      fullSizeSyntheticProviderOutput()
    );
    invalidCase.mutate(output);
    stub(t, globalThis, "fetch", async () => providerResponse(output));

    const response = await invoke({
      title: "Rejected Synthetic Resume",
      pastedText: fullSizeSyntheticDocxExtractedText,
      isMaster: true
    }, {
      "x-ai-cost-confirmed": "true",
      "x-ai-data-confirmed": "true"
    });

    assert.equal(response.status, 422);
    assert.equal(state.resumes.length, 0);
    assert.equal(state.analyses.length, 0);
    assert.equal(state.audits.length, 0);
    assert.equal(state.aiCacheWrites.length, 0);
  });
}

test("an ambiguous client retry replays the committed resume without another master record", async (t) => {
  const state = setup(t);
  const request = { submissionId: SUBMISSION_ID_1, title: "Jordan Master Resume", pastedText: resumeText, isMaster: true };
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

test("an attempt identifier cannot be reused for different resume source data", async (t) => {
  const state = setup(t);
  const first = await invoke({
    submissionId: SUBMISSION_ID_1,
    title: "Jordan Master Resume",
    pastedText: resumeText,
    isMaster: true
  });
  assert.equal(first.status, 200);

  const conflict = await invoke({
    submissionId: SUBMISSION_ID_1,
    title: "Jordan Master Resume",
    pastedText: `${resumeText}\nChanged source`,
    isMaster: true
  });

  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).code, "RESUME_PARSE_IDEMPOTENCY_CONFLICT");
  assert.equal(state.resumes.length, 1);
  assert.equal(state.transactions, 1);
});

test("the same committed attempt cannot silently restore a superseded master", async (t) => {
  const state = setup(t);
  const request = {
    submissionId: SUBMISSION_ID_1,
    title: "Jordan Master Resume",
    pastedText: resumeText,
    isMaster: true
  };
  assert.equal((await invoke(request)).status, 200);
  state.resumes[0]!.isMaster = false;

  const conflict = await invoke(request);

  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).code, "RESUME_PARSE_COMMITTED_STATE_CHANGED");
  assert.equal(state.resumes.length, 1);
  assert.equal(state.transactions, 1);
});

test("content replay remains durable beyond the former fifteen-minute window", async (t) => {
  const state = setup(t);
  const first = await invoke({
    submissionId: SUBMISSION_ID_1,
    title: "Jordan Master Resume",
    pastedText: resumeText,
    isMaster: true
  });
  assert.equal(first.status, 200);
  state.analyses[0]!.createdAt = new Date("2020-01-01T00:00:00.000Z");

  const replay = await invoke({
    submissionId: SUBMISSION_ID_2,
    title: "Jordan Master Resume",
    pastedText: resumeText,
    isMaster: true
  });

  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).replayed, true);
  assert.equal(state.resumes.length, 1);
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
  const request = { submissionId: SUBMISSION_ID_1, title: "Jordan Master Resume", pastedText: resumeText, isMaster: true };
  const first = await invoke(request);
  assert.equal(first.status, 200);
  state.resumes[0]!.isMaster = false;

  const restored = await invoke({ ...request, submissionId: SUBMISSION_ID_2 });
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
  form.set("submissionId", SUBMISSION_ID_2);
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

test("synthetic mixed-contact DOCX runs extraction through stubbed v9 parsing, persistence, and all canonical consumers", async (t) => {
  const providerOutput = syntheticDocxProviderOutput();
  const state = setup(t, undefined, false);
  let providerCalls = 0;
  stub(t, globalThis, "fetch", async () => {
    providerCalls += 1;
    return providerResponse(providerV9FromCanonical(syntheticDocxExtractedText, providerOutput));
  });
  const fixture = await readFile(new URL("./fixtures/synthetic-resume-contract-v5.docx", import.meta.url));
  const form = new FormData();
  form.set("submissionId", SUBMISSION_ID_2);
  form.set("title", "Complete Synthetic Resume");
  form.set("file", new File([fixture], "synthetic-resume-contract-v5.docx", {
    type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  }));

  const response = await invoke(form, {
    "x-ai-cost-confirmed": "true",
    "x-ai-data-confirmed": "true"
  });

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(providerCalls, 1);
  assert.equal(body.resume.rawText, syntheticDocxExtractedText);
  assert.equal(body.parsed.contractVersion, "9");
  assert.equal(body.parsed.education[1].fieldOfStudy, "Business Administration");
  assert.equal(body.parsed.education[0].details[0].includes("480-hour"), true);
  assert.equal(body.parsed.certifications[0].details[0], "Credential ID: SYN-12345");
  assert.equal(body.parsed.sourceSections.at(-1).section, "additional");
  assert.deepEqual(body.parsed.contactInfo, {
    sourceText: syntheticDocxProviderOutput().contactInfo.sourceText,
    name: "Jordan Example",
    headline: "Systems Operations Analyst",
    email: "jordan@example.test",
    phone: "(555) 010-1000",
    location: "Riverton, CA",
    linkedin: "https://www.linkedin.com/in/jordan-example",
    github: "https://github.com/jordan-example",
    portfolio: "https://portfolio.example.test/jordan"
  });
  assert.deepEqual(body.resume.contactInfo, body.parsed.contactInfo);
  assert.equal(state.resumes.length, 1);
  assert.deepEqual(state.resumes[0]?.contactInfo, body.parsed.contactInfo);
  assert.equal(state.analyses.length, 1);
  assert.equal((state.analyses[0]?.output as { contractVersion: string }).contractVersion, "9");
  assert.equal(state.audits.length, 1);

  const reachableSource = body.parsed.sourceSections.flatMap((section: {
    heading: string | null;
    sourceText: string;
  }) => [section.heading, section.sourceText]).filter(Boolean).join("\n");
  for (const line of syntheticDocxExtractedText.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)) {
    assert.ok(reachableSource.includes(line), `unreachable source line: ${line}`);
  }

  const resumeInput = {
    rawText: body.resume.rawText,
    summary: body.resume.summary,
    skills: body.resume.skills,
    achievements: body.resume.achievements,
    workHistory: body.resume.workHistory,
    projects: body.resume.projects,
    education: body.resume.education,
    certifications: body.resume.certifications
  };
  const planner = buildApplicationPlanPayload({
    job: {
      title: "Operations Engineer",
      company: "Example Co",
      description: "Build TypeScript and SQL workflows.",
      requirements: ["TypeScript", "SQL"]
    },
    resume: resumeInput
  });
  assert.ok(planner.evidenceCatalog.some((item) => item.id === "project-1-highlight-1"));
  assert.ok(planner.evidenceCatalog.some((item) => item.id === "education-2" && item.text.includes("Business Administration")));
  assert.ok(planner.evidenceCatalog.some((item) => item.id === "certification-1-detail-1"));
  assert.ok(planner.evidenceCatalog.some((item) => item.id === "raw-source-1"));

  const matchInput: MatchInput = {
    job: {
      title: "Operations Engineer",
      company: "Example Co",
      description: "Build TypeScript and SQL workflows.",
      requirements: ["TypeScript", "SQL"]
    },
    resume: resumeInput
  };
  const refs = getJobMatchEvidenceReferences(matchInput).applicant;
  assert.ok(refs.includes("resume.projects[0]"));
  assert.ok(refs.includes("resume.education[1]"));
  assert.ok(refs.includes("resume.certifications[0]"));
  assert.ok(refs.includes("resume.rawText"));

  const tailoring = buildResumeTailoringPayload(
    matchInput.job,
    { ...resumeInput, filePath: "/private/synthetic.docx", contactInfo: body.resume.contactInfo },
    { careerGoals: "Reliable operations", email: "private@example.test" }
  );
  assert.ok(tailoring.resume);
  assert.equal(tailoring.resume.rawText, syntheticDocxExtractedText);
  assert.deepEqual(tailoring.resume.projects, body.resume.projects);
  assert.ok(!("filePath" in tailoring.resume));
  assert.ok(!("contactInfo" in tailoring.resume));

});

test("complete V9 structural-twin DOCX preserves lossless parse authority and explicit consumer bounds", async (t) => {
  const canonical = resumeV9StructuralTwinCanonical();
  const state = setup(t, undefined, false);
  let providerCalls = 0;
  stub(t, globalThis, "fetch", async () => {
    providerCalls += 1;
    return providerResponse(providerV9FromCanonical(resumeV9StructuralTwinDocxText, canonical));
  });
  const fixture = await readFile(new URL(
    "./fixtures/synthetic-resume-v9-structural-twin.docx",
    import.meta.url
  ));
  const form = new FormData();
  form.set("submissionId", SUBMISSION_ID_2);
  form.set("title", "V9 Structural Twin");
  form.set("file", new File([fixture], "synthetic-resume-v9-structural-twin.docx", {
    type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  }));

  const response = await invoke(form, {
    "x-ai-cost-confirmed": "true",
    "x-ai-data-confirmed": "true"
  });

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(providerCalls, 1);
  assert.equal(body.resume.rawText, resumeV9StructuralTwinDocxText);
  assert.equal(body.parsed.contractVersion, "9");
  for (const key of [
    "contactInfo",
    "summary",
    "skills",
    "workHistory",
    "projects",
    "education",
    "certifications",
    "achievements",
    "sectionStatus"
  ] as const) {
    assert.deepEqual(body.parsed[key], canonical[key], `canonical typed field mismatch: ${key}`);
  }
  assert.equal(state.resumes.length, 1);
  assert.equal(state.analyses.length, 1);
  assert.equal(state.audits.length, 1);

  const reachableSource = body.parsed.sourceSections.flatMap((section: {
    heading: string | null;
    sourceText: string;
    recordBlocks: string[];
  }) => [section.heading, section.sourceText, ...section.recordBlocks])
    .filter(Boolean)
    .join("\n");
  for (const line of resumeV9StructuralTwinDocxText
    .split(/\r?\n/u)
    .map((item) => item.trim())
    .filter(Boolean)) {
    assert.ok(reachableSource.includes(line), `unreachable source line: ${line}`);
  }

  const resumeInput = {
    rawText: body.resume.rawText,
    summary: body.resume.summary,
    skills: body.resume.skills,
    achievements: body.resume.achievements,
    workHistory: body.resume.workHistory,
    projects: body.resume.projects,
    education: body.resume.education,
    certifications: body.resume.certifications
  };
  const job = {
    title: "Service Operations Director",
    company: "Synthetic Employer",
    description: "Lead TypeScript, PostgreSQL, service delivery, and reporting programs.",
    requirements: ["TypeScript", "PostgreSQL", "service delivery"]
  };
  const planner = buildApplicationPlanPayload({ job, resume: resumeInput });
  assert.ok(planner.evidenceCatalog.some((item) =>
    item.id === "education-2" && item.text.includes("Business Administration")));
  assert.ok(planner.evidenceCatalog.some((item) =>
    item.id === "project-1-highlight-1" && item.text.includes("TypeScript")));
  assert.ok(planner.evidenceCatalog.some((item) =>
    item.id === "certification-1-detail-1" && item.text.includes("SYNTHETIC-ONLY-4821")));
  const boundedRawEvidence = planner.evidenceCatalog.find((item) => item.id === "raw-source-1");
  assert.equal(
    boundedRawEvidence?.text,
    resumeV9StructuralTwinDocxText.trim().slice(0, 2_500)
  );
  assert.doesNotMatch(boundedRawEvidence?.text ?? "", /Languages: English and Spanish/u);
  assert.deepEqual(
    planner.projectionOmissions.find((item) => item.sourcePath === "resume.rawText"),
    {
      sourcePath: "resume.rawText",
      omittedIds: [],
      omittedCount: 0,
      truncatedIds: ["raw-source-1"]
    }
  );

  const matchInput: MatchInput = { job, resume: resumeInput };
  const refs = getJobMatchEvidenceReferences(matchInput).applicant;
  assert.ok(refs.includes("resume.projects[0]"));
  assert.ok(refs.includes("resume.education[1]"));
  assert.ok(refs.includes("resume.certifications[0]"));
  assert.ok(refs.includes("resume.rawText"));

  const tailoring = buildResumeTailoringPayload(
    job,
    { ...resumeInput, filePath: "/private/never-expose.docx", contactInfo: body.resume.contactInfo },
    { careerGoals: "Reliable operations", email: "private@example.test" }
  );
  assert.deepEqual(tailoring.resume?.projects, body.resume.projects);
  assert.deepEqual(tailoring.resume?.education, body.resume.education);
  assert.deepEqual(tailoring.resume?.certifications, body.resume.certifications);
  assert.equal(tailoring.resume?.rawText, resumeV9StructuralTwinDocxText);
  assert.match(tailoring.resume?.rawText ?? "", /Languages: English and Spanish/u);
  assert.ok(tailoring.resume && !("filePath" in tailoring.resume));
  assert.ok(tailoring.resume && !("contactInfo" in tailoring.resume));
});

test("full-size synthetic DOCX passes extraction, stubbed v9 provider, persistence, and all canonical consumers", async (t) => {
  const canonicalV5 = fullSizeSyntheticProviderOutput();
  const state = setup(t, undefined, false);
  let providerCalls = 0;
  stub(t, globalThis, "fetch", async () => {
    providerCalls += 1;
    return providerResponse(providerV9FromCanonical(fullSizeSyntheticDocxExtractedText, canonicalV5));
  });
  const fixture = await readFile(new URL(
    "./fixtures/synthetic-resume-estimator-boundary.docx",
    import.meta.url
  ));
  const form = new FormData();
  form.set("submissionId", SUBMISSION_ID_2);
  form.set("title", "Full-Size Synthetic Resume");
  form.set("file", new File([fixture], "synthetic-resume-estimator-boundary.docx", {
    type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  }));

  const response = await invoke(form, {
    "x-ai-cost-confirmed": "true",
    "x-ai-data-confirmed": "true"
  });

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(providerCalls, 1);
  assert.equal(body.parsed.contractVersion, "9");
  assert.equal(body.resume.rawText, fullSizeSyntheticDocxExtractedText);
  assert.equal(body.parsed.sourceSections[2].heading, "CORE SKILLS");
  assert.equal(body.parsed.sourceSections[4].heading, "SELECTED TECHNICAL PROJECTS");
  assert.equal(body.parsed.workHistory.length, 5);
  assert.equal(body.parsed.projects.length, 2);
  assert.equal(body.parsed.education.length, 2);
  assert.equal(body.parsed.certifications.length, 1);
  assert.equal(body.parsed.certifications[0].details[0], "Credential ID: SYN-OPS-6403");
  assert.equal(body.parsed.achievements.length, 2);
  assert.equal(body.parsed.sourceSections.at(-1).section, "additional");
  assert.equal(state.resumes.length, 1);
  assert.equal(state.analyses.length, 1);
  assert.equal((state.analyses[0]?.output as { contractVersion: string }).contractVersion, "9");
  assert.equal(state.audits.length, 1);

  const reachableSource = body.parsed.sourceSections.flatMap((section: {
    heading: string | null;
    sourceText: string;
  }) => [section.heading, section.sourceText]).filter(Boolean).join("\n");
  for (const line of fullSizeSyntheticDocxExtractedText.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)) {
    assert.ok(reachableSource.includes(line), `unreachable source line: ${line}`);
  }

  const resumeInput = {
    rawText: body.resume.rawText,
    summary: body.resume.summary,
    skills: body.resume.skills,
    achievements: body.resume.achievements,
    workHistory: body.resume.workHistory,
    projects: body.resume.projects,
    education: body.resume.education,
    certifications: body.resume.certifications
  };
  const job = {
    title: "Service Operations Director",
    company: "Synthetic Employer",
    description: "Lead TypeScript, PostgreSQL, service delivery, and reporting programs.",
    requirements: ["TypeScript", "PostgreSQL", "service delivery"]
  };
  const planner = buildApplicationPlanPayload({ job, resume: resumeInput });
  assert.ok(planner.evidenceCatalog.some((item) => item.id === "project-1-highlight-1"));
  assert.ok(planner.evidenceCatalog.some((item) =>
    item.id === "education-2" && item.text.includes("Business Administration")
  ));
  assert.ok(planner.evidenceCatalog.some((item) => item.id === "certification-1-detail-1"));
  assert.ok(planner.evidenceCatalog.some((item) => item.id === "raw-source-1"));

  const matchInput: MatchInput = { job, resume: resumeInput };
  const refs = getJobMatchEvidenceReferences(matchInput).applicant;
  assert.ok(refs.includes("resume.projects[0]"));
  assert.ok(refs.includes("resume.education[1]"));
  assert.ok(refs.includes("resume.certifications[0]"));
  assert.ok(refs.includes("resume.rawText"));

  const tailoring = buildResumeTailoringPayload(
    job,
    { ...resumeInput, filePath: "/private/full-size-synthetic.docx", contactInfo: body.resume.contactInfo },
    { careerGoals: "Reliable service operations", email: "private@example.test" }
  );
  assert.ok(tailoring.resume);
  assert.equal(tailoring.resume.rawText, fullSizeSyntheticDocxExtractedText);
  assert.deepEqual(tailoring.resume.projects, body.resume.projects);
  assert.ok(!("filePath" in tailoring.resume));
  assert.ok(!("contactInfo" in tailoring.resume));

  const replayForm = new FormData();
  replayForm.set("submissionId", SUBMISSION_ID_2);
  replayForm.set("title", "Full-Size Synthetic Resume");
  replayForm.set("file", new File([fixture], "synthetic-resume-estimator-boundary.docx", {
    type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  }));
  const replay = await invoke(replayForm);
  assert.equal(replay.status, 200);
  const replayBody = await replay.json();
  assert.equal(replayBody.replayed, true);
  assert.equal(replayBody.parsed.contractVersion, "9");
  assert.equal(providerCalls, 1);
  assert.equal(state.resumes.length, 1);
  assert.equal(state.analyses.length, 1);
});

test("a losing local-storage transaction removes its unreferenced private file", async (t) => {
  const state = setup(t, parsedOutput, true, { simulateLocalLoserRace: true });
  t.after(async () => { await deletePrivateLocalFilesForUser("demo-user"); });
  const form = new FormData();
  form.set("submissionId", SUBMISSION_ID_1);
  form.set("title", "Jordan Master Resume");
  form.set("file", new File([resumeText], "synthetic-resume.txt", { type: "text/plain" }));

  const response = await invoke(form);

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.replayed, true);
  assert.equal(body.resume.id, "resume-winner");
  assert.ok(state.rolledBackFilePath);
  await assert.rejects(access(state.rolledBackFilePath));
});

test("incomplete provider output leaves the old master untouched and surfaces the failed record boundary", async (t) => {
  const incomplete = structuredClone(parsedOutput);
  incomplete.workHistory = [];
  incomplete.sectionStatus.workHistory = "absent";
  const state = setup(t, incomplete);

  const response = await invoke({ title: "Jordan Master Resume", pastedText: resumeText, isMaster: true });

  assert.equal(response.status, 422);
  const body = await response.json();
  assert.equal(body.code, "RESUME_PARSE_STRUCTURE_AMBIGUOUS");
  assert.equal(body.section, "workHistory");
  assert.equal(body.fieldPath, "sourceSections[2].recordBlocks[0]");
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
