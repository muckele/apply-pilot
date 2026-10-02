import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";

import { parseResumeTextWithMeta } from "@/lib/ai/resume";
import { getOpenAIClient } from "@/lib/ai/client";
import { PublicApiError } from "@/lib/api-errors";
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
Improved retention by 10%.

SKILLS
Customer Success
SQL

EDUCATION
Example University
B.S. Business
2021`;

const parsedOutput = {
  contractVersion: "3",
  contactInfo: {
    email: "jordan@example.test",
    phone: null,
    location: null,
    linkedin: null,
    github: null,
    portfolio: null
  },
  summary: "Customer success manager supporting technical onboarding.",
  skills: ["Customer Success", "SQL"],
  workHistory: [{
    company: "Example Co",
    title: "Customer Success Manager",
    location: "Remote",
    startDate: "2022",
    endDate: "Present",
    bullets: ["Led customer onboarding.", "Improved retention by 10%."]
  }],
  projects: [],
  education: [{
    institution: "Example University",
    credential: "B.S.",
    fieldOfStudy: "Business",
    startDate: null,
    endDate: "2021",
    details: []
  }],
  certifications: [],
  achievements: ["Improved retention by 10%."],
  sectionStatus: {
    workHistory: "present",
    projects: "absent",
    education: "present",
    certifications: "absent"
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
    AI_ENABLED: "true",
    AI_PROVIDER: "gemini",
    AI_MOCK_MODE: "false",
    GEMINI_API_KEY: "synthetic-never-log",
    GEMINI_FAST_MODEL: "gemini-3.8-flash",
    OPENAI_API_KEY: undefined,
    OPENAI_MOCK_MODE: undefined,
    AI_MAX_REQUEST_COST_CENTS: undefined,
    AI_CONFIRMATION_THRESHOLD_CENTS: undefined
  };
  for (const [name, value] of Object.entries(changes)) {
    const prior = process.env[name];
    t.after(() => { if (prior === undefined) delete process.env[name]; else process.env[name] = prior; });
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
}

function providerResponse(value: unknown, usage = {
  promptTokenCount: 160,
  candidatesTokenCount: 80,
  thoughtsTokenCount: 20,
  totalTokenCount: 260
}) {
  return new Response(JSON.stringify({
    candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(value) }] } }],
    usageMetadata: usage
  }), { status: 200, headers: { "content-type": "application/json" } });
}

function installLedger(t: TestContext, cachedOutput?: unknown) {
  let reservation: Record<string, unknown> | null = null;
  const reservations: Array<Record<string, unknown>> = [];
  const reconciliations: Array<Record<string, unknown>> = [];
  const cacheWrites: Array<Record<string, unknown>> = [];

  stub(t, prisma.aIResponseCache, "findFirst", async () => cachedOutput ? { output: cachedOutput } : null);
  stub(t, prisma.aIBudgetReservation, "findMany", async () => []);
  stub(t, prisma.aIBudgetReservation, "findFirst", async () =>
    reservation?.status === "UNCERTAIN" ? reservation : null);
  stub(t, prisma.aISettings, "upsert", async () => ({
    monthlyBudgetCents: 500,
    automationBudgetCents: 150,
    maxAnalysesPerSync: 5,
    modelOverride: null
  }));

  const tx = {
    aIBudgetLedger: {
      upsert: async () => ({ id: "ledger-1" }),
      updateMany: async () => ({ count: 1 })
    },
    aIBudgetReservation: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        reservation = { id: "reservation-1", ledgerId: "ledger-1", status: "RESERVED", ...data };
        reservations.push(data);
        return reservation;
      },
      findUniqueOrThrow: async () => reservation,
      update: async ({ data }: { data: Record<string, unknown> }) => {
        reconciliations.push(data);
        reservation = { ...reservation, ...data };
        return reservation;
      }
    },
    aIUsageEvent: { create: async ({ data }: { data: Record<string, unknown> }) => data },
    aIResponseCache: {
      upsert: async ({ create }: { create: Record<string, unknown> }) => {
        cacheWrites.push(create);
        return create;
      }
    },
    $executeRaw: async () => 1
  };
  stub(t, prisma, "$transaction", async (callback: (transaction: typeof tx) => unknown) => callback(tx));

  return { reservations, reconciliations, cacheWrites };
}

test("Gemini resume parsing requires combined data and maximum-cost confirmation before any paid call", async (t) => {
  environment(t);
  installLedger(t);
  let providerCalls = 0;
  stub(t, globalThis, "fetch", async () => { providerCalls += 1; throw new Error("must not call"); });

  await assert.rejects(
    parseResumeTextWithMeta(resumeText, "user-1"),
    (error: unknown) => error instanceof PublicApiError &&
      error.status === 428 &&
      error.details?.code === "AI_COST_CONFIRMATION_REQUIRED" &&
      error.details.maximumCostMicros === 38_250 &&
      error.details.provider === "gemini" &&
      error.details.dataType === "resume_text"
  );
  assert.equal(providerCalls, 0);
});

test("confirmed Gemini parsing uses the configured model, typed response schema, reservation, and source-backed v3 output", async (t) => {
  environment(t);
  const ledger = installLedger(t);
  const requests: Array<Record<string, unknown>> = [];
  stub(t, globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return providerResponse(parsedOutput);
  });

  const result = await parseResumeTextWithMeta(resumeText, "user-1", {
    highCostConfirmed: true,
    dataSharingConfirmed: true
  });

  assert.equal(result.meta.provider, "gemini");
  assert.equal(result.meta.model, "gemini-3.8-flash");
  assert.equal(result.meta.promptVersion, "3");
  assert.equal(result.meta.outputTokens, 100);
  assert.deepEqual(result.data.workHistory, parsedOutput.workHistory);
  assert.deepEqual(result.data.education, parsedOutput.education);
  const generationConfig = requests[0]?.generationConfig as Record<string, unknown>;
  const responseSchema = generationConfig.responseJsonSchema as Record<string, unknown>;
  assert.equal(responseSchema.additionalProperties, false);
  assert.equal(ledger.reservations[0]?.provider, "gemini");
  assert.equal(ledger.reservations[0]?.feature, "RESUME_PARSE");
  assert.equal(ledger.reservations[0]?.maximumCostMicros, 38_250);
  assert.equal(ledger.reconciliations[0]?.status, "SUCCEEDED");
  assert.equal(ledger.cacheWrites.length, 1);
});

test("unsupported parsed facts fail validation, consume only known usage, and are never cached", async (t) => {
  environment(t);
  const ledger = installLedger(t);
  const unsupported = structuredClone(parsedOutput);
  unsupported.workHistory[0].bullets[0] = "Invented unsupported accomplishment.";
  stub(t, globalThis, "fetch", async () => providerResponse(unsupported));

  await assert.rejects(
    parseResumeTextWithMeta(resumeText, "user-1", {
      highCostConfirmed: true,
      dataSharingConfirmed: true
    }),
    /not supported by the submitted resume source/i
  );
  assert.equal(ledger.reconciliations[0]?.status, "FAILED");
  assert.equal(ledger.cacheWrites.length, 0);
});

test("a source section heading cannot be silently replaced with an empty structured section", async (t) => {
  environment(t);
  const ledger = installLedger(t);
  const incomplete = structuredClone(parsedOutput);
  incomplete.workHistory = [];
  incomplete.sectionStatus.workHistory = "absent";
  stub(t, globalThis, "fetch", async () => providerResponse(incomplete));

  await assert.rejects(
    parseResumeTextWithMeta(resumeText, "user-1", {
      highCostConfirmed: true,
      dataSharingConfirmed: true
    }),
    /incomplete.*work history/i
  );
  assert.equal(ledger.reconciliations[0]?.status, "FAILED");
  assert.equal(ledger.cacheWrites.length, 0);
});

test("a validated cache replay avoids confirmation, reservation, and a duplicate provider call", async (t) => {
  environment(t);
  const ledger = installLedger(t, parsedOutput);
  let providerCalls = 0;
  stub(t, globalThis, "fetch", async () => { providerCalls += 1; throw new Error("must not call"); });

  const result = await parseResumeTextWithMeta(resumeText, "user-1");

  assert.equal(result.meta.estimatedCostMicros, 0);
  assert.equal(result.data.workHistory.length, 1);
  assert.equal(providerCalls, 0);
  assert.equal(ledger.reservations.length, 0);
});

test("an uncertain provider outcome durably blocks an identical second paid call", async (t) => {
  environment(t);
  const ledger = installLedger(t);
  let providerCalls = 0;
  stub(t, globalThis, "fetch", async () => {
    providerCalls += 1;
    throw new TypeError("synthetic connection loss");
  });

  await assert.rejects(
    parseResumeTextWithMeta(resumeText, "user-1", {
      highCostConfirmed: true,
      dataSharingConfirmed: true
    }),
    (error: unknown) => error instanceof PublicApiError &&
      error.status === 503 &&
      error.details?.code === "RESUME_PARSE_PROVIDER_UNCERTAIN" &&
      error.details.retryable === false
  );
  assert.equal(ledger.reconciliations[0]?.status, "UNCERTAIN");

  await assert.rejects(
    parseResumeTextWithMeta(resumeText, "user-1", {
      highCostConfirmed: true,
      dataSharingConfirmed: true
    }),
    (error: unknown) => error instanceof PublicApiError &&
      error.status === 409 &&
      error.details?.code === "RESUME_PARSE_PRIOR_OUTCOME_UNCERTAIN" &&
      error.details.retryable === false
  );
  assert.equal(providerCalls, 1);
  assert.equal(ledger.reservations.length, 1);
});

test("OpenAI configuration retains the same confirmation, validation, and reservation contract", async (t) => {
  environment(t);
  process.env.AI_PROVIDER = "openai";
  process.env.OPENAI_API_KEY = "synthetic-never-log";
  process.env.OPENAI_MODEL = "gpt-4o-mini";
  delete process.env.GEMINI_API_KEY;
  const ledger = installLedger(t);
  const client = getOpenAIClient();
  assert.ok(client);
  stub(t, client.chat.completions, "create", async () => ({
    choices: [{ message: { content: JSON.stringify(parsedOutput) } }],
    usage: {
      prompt_tokens: 160,
      completion_tokens: 80,
      prompt_tokens_details: { cached_tokens: 0 }
    }
  }));
  stub(t, globalThis, "fetch", async () => { throw new Error("Gemini transport must not be used"); });

  const result = await parseResumeTextWithMeta(resumeText, "user-1", {
    highCostConfirmed: true,
    dataSharingConfirmed: true
  });

  assert.equal(result.meta.provider, "openai");
  assert.equal(result.meta.model, "gpt-4o-mini");
  assert.equal(ledger.reservations[0]?.provider, "openai");
  assert.equal(ledger.reservations[0]?.maximumCostMicros, 7_050);
  assert.equal(ledger.reconciliations[0]?.status, "SUCCEEDED");
});
