import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";

import { scoreJobMatch, type JobMatchModelOutput, type MatchInput } from "@/lib/ai/job-match";
import { PublicApiError } from "@/lib/api-errors";
import { prisma } from "@/lib/prisma";
import { apiErrorResponse } from "@/lib/user-context";

// Production 2026-11-12 03:05Z: a re-score with reviewed owner lines was charged, then refused by
// JOB_MATCH output validation, and the person saw only "The request could not be completed." with
// no charge status. A paid output that still fails validation now says so plainly and carries
// billingStatus and actualCostMicros, the fields the Apply page already reads. Runs the production
// scoreJobMatch path with a stubbed Gemini transport and stubbed ledger; no network or database.
// All text is invented.

const FACT = "Ran the synthetic billing migration to Kubernetes for 40 services; cut deploy time from two hours to ten minutes.";
const MESSAGE = "Gemini's answer couldn't be checked against your résumé, so it wasn't used.";

const input: MatchInput = {
  job: {
    title: "Synthetic platform engineer",
    company: "Example Co",
    description: "Run synthetic services on Kubernetes.",
    requirements: ["Kubernetes experience"],
    preferredQualifications: [],
    detectedTechStack: []
  },
  resume: { summary: "Synthetic operator", rawText: "Wrote synthetic runbooks.", skills: ["Runbooks"], achievements: [] },
  profile: null,
  reviewedEvidence: {
    schema: "apply-pilot/job-match-reviewed-evidence/v1",
    snapshotId: "snapshot-1",
    snapshotHash: "a".repeat(64),
    facts: [{ gapId: "gap:0", fact: FACT, provenance: "OWNER_ATTESTED", sourceRef: null }],
    unresolvedGapIds: []
  }
};

function outputQuoting(excerpt: string): JobMatchModelOutput {
  return {
    contractVersion: "3",
    overallFitScore: 70,
    resumeKeywordScore: 70,
    skillsMatchScore: 70,
    experienceMatchScore: 70,
    careerGoalScore: 70,
    locationWorkStyleScore: 70,
    compensationScore: null,
    confidenceScore: 60,
    confidenceBasis: "Based on the cited fields.",
    factualMatches: [{
      applicantEvidence: [{ ref: "reviewedEvidence.facts[0]", excerpt }],
      jobEvidence: [{ ref: "job.requirements[0]", excerpt: "Kubernetes experience" }],
      supportedKeywords: ["Kubernetes"]
    }],
    requirementGaps: [],
    advice: { keywordsToEmphasize: [], resumeAngle: "Lead with the platform work.", coverLetterAngle: "Name the migration." },
    recommendation: "consider"
  };
}

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
  const state: { reservation: Record<string, unknown>; cacheWrites: Array<Record<string, unknown>> } = { reservation: {}, cacheWrites: [] };
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
        (state.reservation = { id: "reservation-1", ledgerId: "ledger-1", status: "RESERVED", ...data }),
      findUniqueOrThrow: async () => state.reservation,
      update: async ({ data }: { data: Record<string, unknown> }) => (state.reservation = { ...state.reservation, ...data })
    },
    aIUsageEvent: { create: async ({ data }: { data: Record<string, unknown> }) => data },
    aIResponseCache: {
      upsert: async ({ create }: { create: Record<string, unknown> }) => {
        state.cacheWrites.push(create);
        return create;
      }
    },
    $executeRaw: async () => 1
  };
  stub(t, prisma, "$transaction", async (callback: (transaction: typeof tx) => unknown) => callback(tx));
  return state;
}

function geminiReturns(t: TestContext, output: unknown) {
  const calls = { count: 0 };
  stub(t, globalThis, "fetch", async () => {
    calls.count += 1;
    return new Response(JSON.stringify({
      candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(output) }] } }],
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, thoughtsTokenCount: 30, totalTokenCount: 150 }
    }), { status: 200, headers: { "content-type": "application/json" } });
  });
  return calls;
}

test("a paid re-score quoting part of an owner line is kept, and the cache holds the full line", async (t) => {
  paidEnvironment(t);
  const ledger = installLedger(t);
  geminiReturns(t, outputQuoting("migration to Kubernetes for 40 services"));
  const result = await scoreJobMatch(input, "user-1", { highCostConfirmed: true });
  assert.equal(result.factualMatches[0]!.applicantEvidence[0]!.excerpt, FACT);
  assert.equal(ledger.reservation.status, "SUCCEEDED");
  assert.equal(ledger.cacheWrites.length, 1);
  const cachedOutput = ledger.cacheWrites[0]!.output as JobMatchModelOutput;
  assert.equal(cachedOutput.factualMatches[0]!.applicantEvidence[0]!.excerpt, FACT);
});

test("a paid output that fails validation says so plainly and reports the recorded charge", async (t) => {
  paidEnvironment(t);
  const ledger = installLedger(t);
  geminiReturns(t, outputQuoting("migration to Kubernetes for 400 services"));
  const error = await scoreJobMatch(input, "user-1", { highCostConfirmed: true }).then(
    () => assert.fail("expected a refusal"),
    (caught: unknown) => caught
  );
  assert.ok(error instanceof PublicApiError, String(error));
  assert.equal(error.status, 502);
  assert.equal(error.message, MESSAGE);
  assert.equal(ledger.reservation.status, "FAILED");
  const charged = ledger.reservation.actualCostMicros;
  assert.equal(typeof charged === "number" && charged > 0, true);
  assert.deepEqual(error.details, {
    code: "JOB_MATCH_OUTPUT_INVALID",
    validationCode: "UNSUPPORTED_APPLICANT_EXCERPT",
    fieldPath: "factualMatches[0].applicantEvidence[0].excerpt",
    billingStatus: "known",
    actualCostMicros: charged,
    retryable: false
  });
  assert.equal(ledger.cacheWrites.length, 0);

  // What the browser receives, and what the log keeps (codes only, never the quoted text).
  const lines: string[] = [];
  const original = console.warn;
  console.warn = (line: string) => { lines.push(String(line)); };
  t.after(() => { console.warn = original; });
  const response = apiErrorResponse(error);
  assert.equal(response.status, 502);
  const body = await response.json() as Record<string, unknown>;
  assert.equal(body.error, MESSAGE);
  assert.equal(body.billingStatus, "known");
  assert.equal(body.actualCostMicros, charged);
  const entry = JSON.parse(lines.at(-1)!);
  assert.equal(entry.error.code, "JOB_MATCH_OUTPUT_INVALID");
  assert.equal(entry.error.validationCode, "UNSUPPORTED_APPLICANT_EXCERPT");
  assert.equal(entry.error.billingStatus, "known");
  assert.doesNotMatch(lines.at(-1)!, /400 services/u);
});

test("a cached output that fails validation says so and reports no charge", async (t) => {
  paidEnvironment(t);
  installLedger(t, { output: outputQuoting("migration to Kubernetes for 400 services") });
  const calls = geminiReturns(t, outputQuoting("unused"));
  await assert.rejects(
    scoreJobMatch(input, "user-1", { highCostConfirmed: true }),
    (error: unknown) => error instanceof PublicApiError &&
      error.message === MESSAGE &&
      error.details?.billingStatus === "not_charged" &&
      error.details?.actualCostMicros === 0
  );
  assert.equal(calls.count, 0);
});
