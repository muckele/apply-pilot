import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";

import { scoreJobMatch, type JobMatchModelOutput, type MatchInput } from "@/lib/ai/job-match";
import { prisma } from "@/lib/prisma";

// Gusto-shaped synthetic posting and applicant, run through the production
// scoreJobMatch path with a stubbed Gemini transport and stubbed ledger. No
// network and no database are reached.
const TENURE_REQUIREMENT = "Demonstrated 5+ years of hands-on experience in a customer-facing technical role such as Forward Deployed Engineer, Solutions Engineer, AI Engineer, Implementation Engineer, Solutions Architect, Technical Consultant, or similar.";

const input: MatchInput = {
  job: {
    title: "Sales Engineer",
    company: "Synthetic Payroll Co",
    description: "Run technical discovery and demos for small-business payroll customers.",
    requirements: [
      TENURE_REQUIREMENT,
      "Experience designing and shipping agentic workflows with LLM tools.",
      "Working knowledge of REST APIs, webhooks, and idempotency.",
      "Comfort writing runbooks and handing off implementations to support teams."
    ],
    preferredQualifications: [],
    detectedTechStack: []
  },
  resume: {
    summary: "Revenue and operations professional with 8+ years in sales, account management, and operations.",
    rawText: "Technical Consultant | Northwind Studio | Mar 2026 – Jun 2026\nSenior Account Manager | Contoso Payroll | Mar 2018 – Feb 2026",
    skills: ["Zapier", "Python"],
    achievements: [],
    workHistory: [
      {
        sourceText: "Technical Consultant | Northwind Studio | Mar 2026 – Jun 2026",
        company: "Northwind Studio",
        title: "Technical Consultant",
        location: "Remote",
        startDate: "Mar 2026",
        endDate: "Jun 2026",
        bullets: ["Built Zapier and Python automations for small-business clients."]
      },
      {
        sourceText: "Senior Account Manager | Contoso Payroll | Mar 2018 – Feb 2026",
        company: "Contoso Payroll",
        title: "Senior Account Manager",
        location: "Remote",
        startDate: "Mar 2018",
        endDate: "Feb 2026",
        bullets: ["Partnered with Solutions Engineers on technical demos."]
      }
    ]
  },
  profile: null
};

function gap(index: number, missingKeywords: string[]) {
  const requirement = input.job.requirements![index];
  return { requirement, jobRequirement: { ref: `job.requirements[${index}]`, excerpt: requirement }, missingKeywords };
}

const modelOutput: JobMatchModelOutput = {
  contractVersion: "3",
  overallFitScore: 38,
  resumeKeywordScore: 35,
  skillsMatchScore: 40,
  experienceMatchScore: 30,
  careerGoalScore: 60,
  locationWorkStyleScore: 80,
  compensationScore: null,
  confidenceScore: 55,
  confidenceBasis: "Based on the cited submitted fields; limitations include sparse technical detail.",
  factualMatches: [],
  requirementGaps: [gap(1, ["agentic"]), gap(2, ["webhooks", "idempotency"]), gap(3, ["runbooks"])],
  advice: {
    keywordsToEmphasize: [],
    resumeAngle: "Lead with supported automation work.",
    coverLetterAngle: "Explain the move into technical consulting honestly."
  },
  recommendation: "consider"
};

const EXPECTED_TENURE_SUMMARY = "Your résumé shows about 4 months in a customer-facing technical role; this job asks for 5+ years.";

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
    OPENAI_MOCK_MODE: "false",
    AI_MAX_REQUEST_COST_CENTS: undefined,
    AI_CONFIRMATION_THRESHOLD_CENTS: undefined
  })) {
    const previous = process.env[name];
    t.after(() => { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; });
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
}

function installLedger(t: TestContext, cached: unknown = null) {
  let reservation: Record<string, unknown> = {};
  const cacheWrites: Array<Record<string, unknown>> = [];
  stub(t, prisma.aIResponseCache, "findFirst", async () => cached);
  stub(t, prisma.aIBudgetReservation, "findMany", async () => []);
  stub(t, prisma.aISettings, "upsert", async () => ({
    monthlyBudgetCents: 500,
    automationBudgetCents: 150,
    maxAnalysesPerSync: 5,
    modelOverride: null
  }));
  const tx = {
    aIBudgetLedger: { upsert: async () => ({ id: "ledger-1" }), updateMany: async () => ({ count: 1 }) },
    aIBudgetReservation: {
      create: async ({ data }: { data: Record<string, unknown> }) =>
        (reservation = { id: "reservation-1", ledgerId: "ledger-1", status: "RESERVED", ...data }),
      findUniqueOrThrow: async () => reservation,
      update: async ({ data }: { data: Record<string, unknown> }) => (reservation = { ...reservation, ...data })
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
  return { cacheWrites };
}

test("Gusto-shaped posting: scoring adds the 5+ years gap the live run missed and caches only raw model output", async (t) => {
  paidEnvironment(t);
  const ledger = installLedger(t);
  let calls = 0;
  stub(t, globalThis, "fetch", async () => {
    calls += 1;
    return new Response(JSON.stringify({
      candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(modelOutput) }] } }],
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, thoughtsTokenCount: 30, totalTokenCount: 150 }
    }), { status: 200, headers: { "content-type": "application/json" } });
  });

  const result = await scoreJobMatch(input, "user-1", { highCostConfirmed: true });

  assert.equal(calls, 1);
  assert.deepEqual(result.requirementGaps.map((entry) => entry.jobRequirement.ref), [
    "job.requirements[1]",
    "job.requirements[2]",
    "job.requirements[3]",
    "job.requirements[0]"
  ]);
  const tenureGap = result.requirementGaps[3];
  assert.equal(tenureGap.requirement, TENURE_REQUIREMENT);
  assert.equal(tenureGap.tenure?.summary, EXPECTED_TENURE_SUMMARY);
  assert.deepEqual(tenureGap.tenure?.countedRoles.map((role) => [role.ref, role.excerpt]), [
    ["resume.workHistory[0]", "Technical Consultant"]
  ]);
  assert.deepEqual(result.missingKeywords, ["agentic", "webhooks", "idempotency", "runbooks"]);
  assert.equal(result.concerns.at(-1), TENURE_REQUIREMENT);
  assert.equal(result.overallFitScore, 38);
  assert.equal(result.recommendation, "consider");

  assert.equal(ledger.cacheWrites.length, 1);
  assert.deepEqual(ledger.cacheWrites[0].output, modelOutput);
});

test("a response-cache hit re-applies the tenure check without a provider call", async (t) => {
  paidEnvironment(t);
  installLedger(t, { output: modelOutput });
  let calls = 0;
  stub(t, globalThis, "fetch", async () => { calls += 1; throw new Error("must not call"); });

  const result = await scoreJobMatch(input, "user-1", { highCostConfirmed: true });

  assert.equal(calls, 0);
  assert.equal(result.usage.estimatedCostMicros, 0);
  assert.equal(result.requirementGaps.at(-1)?.tenure?.summary, EXPECTED_TENURE_SUMMARY);
});
