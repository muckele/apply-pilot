import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";

import { PublicApiError } from "@/lib/api-errors";
import {
  JOB_MATCH_MODEL,
  scoreJobMatch,
  type JobMatchModelOutput,
  type MatchInput
} from "@/lib/ai/job-match";
import { prisma } from "@/lib/prisma";

const input: MatchInput = {
  job: {
    title: "Platform Engineer",
    company: "Example Co",
    description: "Build reliable TypeScript services.",
    requirements: ["TypeScript"],
    preferredQualifications: ["Kubernetes"],
    detectedTechStack: ["TypeScript"],
    salaryMin: 120_000,
    salaryMax: 150_000
  },
  resume: {
    summary: "Platform engineer",
    rawText: "Built reliable TypeScript services.",
    skills: ["TypeScript"],
    achievements: []
  },
  profile: {
    salaryTargetMin: 125_000,
    salaryTargetMax: 145_000,
    skillsToEmphasize: ["TypeScript"],
    skillsNotToExaggerate: ["Kubernetes"]
  }
};

const output: JobMatchModelOutput = {
  contractVersion: "3",
  overallFitScore: 82,
  resumeKeywordScore: 80,
  skillsMatchScore: 84,
  experienceMatchScore: 78,
  careerGoalScore: 75,
  locationWorkStyleScore: 70,
  compensationScore: 76,
  confidenceScore: 79,
  confidenceBasis: "Based on the cited submitted evidence and its limited scope.",
  factualMatches: [{
    applicantEvidence: [{ ref: "resume.skills[0]", excerpt: "TypeScript" }],
    jobEvidence: [{ ref: "job.requirements[0]", excerpt: "TypeScript" }],
    supportedKeywords: ["TypeScript"]
  }],
  requirementGaps: [{
    requirement: "Kubernetes",
    jobRequirement: { ref: "job.preferredQualifications[0]", excerpt: "Kubernetes" },
    missingKeywords: ["Kubernetes"]
  }],
  advice: {
    keywordsToEmphasize: ["TypeScript"],
    resumeAngle: "Describe the supported TypeScript work clearly.",
    coverLetterAngle: "Discuss interest without claiming Kubernetes experience."
  },
  recommendation: "consider"
};

function stub(t: TestContext, owner: object, name: string, replacement: unknown) {
  const methods = owner as Record<string, unknown>;
  const original = methods[name];
  methods[name] = replacement;
  t.after(() => { methods[name] = original; });
}

function paidEnvironment(t: TestContext) {
  for (const [name, value] of Object.entries({
    AI_ENABLED: "true",
    AI_MOCK_MODE: "false",
    GEMINI_API_KEY: "synthetic-never-log",
    OPENAI_API_KEY: "synthetic-openai-must-not-be-used",
    OPENAI_MOCK_MODE: "false",
    AI_MAX_REQUEST_COST_CENTS: undefined,
    AI_CONFIRMATION_THRESHOLD_CENTS: undefined
  })) {
    const previous = process.env[name];
    t.after(() => { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; });
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
}

function providerResponse(value: unknown, usage = {
  promptTokenCount: 100,
  candidatesTokenCount: 20,
  thoughtsTokenCount: 30,
  totalTokenCount: 150
}) {
  return new Response(JSON.stringify({
    candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(value) }] } }],
    usageMetadata: usage
  }), { status: 200, headers: { "content-type": "application/json" } });
}

function installLedger(t: TestContext) {
  let reservation: Record<string, unknown> | null = null;
  const reservations: Array<Record<string, unknown>> = [];
  const reconciliations: Array<Record<string, unknown>> = [];
  const usageEvents: Array<Record<string, unknown>> = [];
  const cacheWrites: Array<Record<string, unknown>> = [];

  stub(t, prisma.aIResponseCache, "findFirst", async () => null);
  stub(t, prisma.aIBudgetReservation, "findMany", async () => []);
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
    aIUsageEvent: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        usageEvents.push(data);
        return data;
      }
    },
    aIResponseCache: {
      upsert: async ({ create }: { create: Record<string, unknown> }) => {
        cacheWrites.push(create);
        return create;
      }
    },
    $executeRaw: async () => 1
  };
  stub(t, prisma, "$transaction", async (callback: (transaction: typeof tx) => unknown) => callback(tx));

  return { reservations, reconciliations, usageEvents, cacheWrites };
}

test("JOB_MATCH is Gemini-only and a stored OpenAI key cannot activate it", async (t) => {
  paidEnvironment(t);
  delete process.env.GEMINI_API_KEY;
  let calls = 0;
  stub(t, globalThis, "fetch", async () => { calls += 1; throw new Error("must not call"); });

  await assert.rejects(scoreJobMatch(input, "user-1", { highCostConfirmed: true }), /unavailable in local mode/);
  assert.equal(calls, 0);
});

test("manual JOB_MATCH requires confirmation before reservation or provider call", async (t) => {
  paidEnvironment(t);
  stub(t, prisma.aIResponseCache, "findFirst", async () => null);
  let calls = 0;
  stub(t, globalThis, "fetch", async () => { calls += 1; throw new Error("must not call"); });

  await assert.rejects(
    scoreJobMatch(input, "user-1"),
    (error: unknown) => error instanceof PublicApiError &&
      error.status === 428 && error.details?.code === "AI_COST_CONFIRMATION_REQUIRED" &&
      error.details.maximumCostMicros === 72_720
  );
  assert.equal(calls, 0);
});

test("confirmed JOB_MATCH reserves exact cost, validates v3 evidence, bills thinking and caches raw output", async (t) => {
  paidEnvironment(t);
  const ledger = installLedger(t);
  let calls = 0;
  stub(t, globalThis, "fetch", async () => { calls += 1; return providerResponse(output); });

  const result = await scoreJobMatch(input, "user-1", { highCostConfirmed: true });

  assert.equal(calls, 1);
  assert.equal(result.model, JOB_MATCH_MODEL);
  assert.equal(result.usage.provider, "gemini");
  assert.equal(result.usage.outputTokens, 50);
  assert.equal(result.usage.estimatedCostMicros, 263);
  assert.deepEqual(result.supportedKeywords, ["TypeScript"]);
  assert.equal(ledger.reservations.length, 1);
  assert.deepEqual({
    provider: ledger.reservations[0].provider,
    model: ledger.reservations[0].model,
    maximumCostMicros: ledger.reservations[0].maximumCostMicros,
    automation: ledger.reservations[0].automation
  }, {
    provider: "gemini",
    model: JOB_MATCH_MODEL,
    maximumCostMicros: 72_720,
    automation: false
  });
  assert.equal(ledger.reconciliations[0].status, "SUCCEEDED");
  assert.equal(ledger.usageEvents[0].outputTokens, 50);
  assert.equal(ledger.cacheWrites.length, 1);
  assert.deepEqual(ledger.cacheWrites[0].output, output);
  assert.equal(Object.hasOwn(ledger.cacheWrites[0].output as object, "whyGoodMatch"), false);
});

test("unsupported factual evidence is charged as FAILED and never cached", async (t) => {
  paidEnvironment(t);
  const ledger = installLedger(t);
  const invalid = structuredClone(output);
  invalid.factualMatches[0].applicantEvidence[0].ref = "resume.skills[99]";
  stub(t, globalThis, "fetch", async () => providerResponse(invalid));

  await assert.rejects(
    scoreJobMatch(input, "user-1", { highCostConfirmed: true }),
    /unknown applicant evidence reference/i
  );
  assert.equal(ledger.reconciliations[0].status, "FAILED");
  assert.equal(ledger.reconciliations[0].actualCostMicros, 263);
  assert.equal(ledger.cacheWrites.length, 0);
});

test("uncertain transport outcome consumes the reservation and is not retried", async (t) => {
  paidEnvironment(t);
  const ledger = installLedger(t);
  let calls = 0;
  stub(t, globalThis, "fetch", async () => { calls += 1; throw new Error("synthetic disconnect"); });

  await assert.rejects(
    scoreJobMatch(input, "user-1", { highCostConfirmed: true }),
    /outcome is uncertain/i
  );
  assert.equal(calls, 1);
  assert.equal(ledger.reconciliations[0].status, "UNCERTAIN");
  assert.equal(ledger.usageEvents[0].estimatedCostMicros, 72_720);
  assert.equal(ledger.cacheWrites.length, 0);
});

test("a definite Gemini HTTP rejection is FAILED at zero cost and is not retried", async (t) => {
  paidEnvironment(t);
  const ledger = installLedger(t);
  let calls = 0;
  stub(t, globalThis, "fetch", async () => {
    calls += 1;
    return new Response("upstream unavailable", { status: 503 });
  });

  await assert.rejects(
    scoreJobMatch(input, "user-1", { highCostConfirmed: true }),
    /HTTP 503/
  );
  assert.equal(calls, 1);
  assert.equal(ledger.reconciliations[0].status, "FAILED");
  assert.equal(ledger.reconciliations[0].actualCostMicros, 0);
  assert.equal(ledger.usageEvents[0].estimatedCostMicros, 0);
  assert.equal(ledger.cacheWrites.length, 0);
});

test("automated JOB_MATCH uses the automation ledger without an interactive confirmation", async (t) => {
  paidEnvironment(t);
  const ledger = installLedger(t);
  stub(t, globalThis, "fetch", async () => providerResponse(output));

  await scoreJobMatch(input, "user-1", { automation: true });

  assert.equal(ledger.reservations[0].automation, true);
  assert.equal(ledger.usageEvents[0].automation, true);
});
