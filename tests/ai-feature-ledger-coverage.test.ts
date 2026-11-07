import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test, type TestContext } from "node:test";

import { PublicApiError } from "@/lib/api-errors";
import { AI_MAX_REQUEST_COST_CENTS } from "@/lib/ai/config";
import { activeAiFeatures, AI_FEATURE_REGISTRY } from "@/lib/ai/feature-registry";
import { AI_FEATURE_POLICIES, type AiFeature } from "@/lib/ai/policy";
import { prisma } from "@/lib/prisma";

// Table-driven proof that every active AI feature runs on Gemini through the single
// hard budget ledger: each entry point must reserve before dispatch, reconcile after,
// and make zero provider calls when the ledger refuses the reservation.

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
    AI_PROVIDER: undefined,
    GEMINI_API_KEY: "synthetic-never-log",
    OPENAI_API_KEY: undefined,
    OPENAI_MOCK_MODE: undefined,
    AI_MAX_REQUEST_COST_CENTS: undefined,
    AI_CONFIRMATION_THRESHOLD_CENTS: undefined
  })) {
    const previous = process.env[name];
    t.after(() => { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; });
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
}

type LedgerEvent = "reserve" | "dispatch" | "reconcile";

function installLedger(t: TestContext, mode: "allow" | "deny") {
  const events: LedgerEvent[] = [];
  const reservations: Array<Record<string, unknown>> = [];
  const reconciliations: Array<Record<string, unknown>> = [];
  let reservation: Record<string, unknown> | null = null;

  stub(t, prisma.aIResponseCache, "findFirst", async () => null);
  stub(t, prisma.aIBudgetReservation, "findMany", async () => []);
  stub(t, prisma.aIBudgetReservation, "findFirst", async () => null);
  stub(t, prisma.aISettings, "upsert", async () => ({
    monthlyBudgetCents: 500,
    automationBudgetCents: 150,
    maxAnalysesPerSync: 5,
    modelOverride: null
  }));
  const tx = {
    aIBudgetLedger: {
      upsert: async () => ({ id: "ledger-1" }),
      updateMany: async () => ({ count: mode === "allow" ? 1 : 0 })
    },
    aIBudgetReservation: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        events.push("reserve");
        reservations.push(data);
        reservation = { id: "reservation-1", ledgerId: "ledger-1", status: "RESERVED", ...data };
        return reservation;
      },
      findUniqueOrThrow: async () => reservation,
      update: async ({ data }: { data: Record<string, unknown> }) => {
        events.push("reconcile");
        reconciliations.push(data);
        reservation = { ...reservation, ...data };
        return reservation;
      }
    },
    aIUsageEvent: { create: async () => ({}) },
    aIResponseCache: { upsert: async ({ create }: { create: unknown }) => create },
    $executeRaw: async () => 1
  };
  stub(t, prisma, "$transaction", async (callback: (transaction: typeof tx) => unknown) => callback(tx));
  let dispatches = 0;
  const requests: string[] = [];
  stub(t, globalThis, "fetch", async (input: unknown) => {
    dispatches += 1;
    events.push("dispatch");
    requests.push(String(input));
    // A schema-invalid but well-formed provider answer: every feature must still
    // reconcile its reservation instead of leaving it open.
    return new Response(JSON.stringify({
      candidates: [{ finishReason: "STOP", content: { parts: [{ text: "{}" }] } }],
      usageMetadata: {
        promptTokenCount: 100,
        candidatesTokenCount: 10,
        thoughtsTokenCount: 0,
        totalTokenCount: 110
      }
    }), { status: 200, headers: { "content-type": "application/json" } });
  });
  return { events, reservations, reconciliations, requests, dispatches: () => dispatches };
}

const confirmed = { highCostConfirmed: true, dataSharingConfirmed: true };
const job = {
  title: "Platform Engineer",
  company: "Example Co",
  description: "Build reliable TypeScript services.",
  requirements: ["TypeScript"]
};
const resume = {
  summary: "Platform engineer building reliable services.",
  skills: ["TypeScript"],
  achievements: ["Reduced deploy time by 30% across 4 teams."],
  workHistory: [{ title: "Platform Engineer", company: "Prior Co", bullets: ["Built reliable TypeScript services."] }]
};

// One invoker per active feature. The registry test below fails if a feature is
// activated without a matching ledger proof here.
const FEATURE_INVOKERS: Record<string, (userId: string) => Promise<unknown>> = {
  RESUME_PARSE: async (userId) => {
    const { parseResumeTextWithMeta } = await import("@/lib/ai/resume");
    return parseResumeTextWithMeta(
      "Jordan Example\n\nSUMMARY\nPlatform engineer.\n\nEXPERIENCE\nPlatform Engineer\nPrior Co\n2022 - Present\nBuilt reliable services.\n\nSKILLS\nTypeScript\n",
      userId,
      confirmed
    );
  },
  JOB_MATCH: async (userId) => {
    const { scoreJobMatch } = await import("@/lib/ai/job-match");
    return scoreJobMatch({ job, resume: { ...resume, rawText: "Built reliable TypeScript services." } }, userId, confirmed);
  },
  RESUME_TAILOR: async (userId) => {
    const { tailorResume } = await import("@/lib/ai/resume");
    return tailorResume({ job, resume }, "", userId, confirmed);
  },
  COVER_LETTER: async (userId) => {
    const { draftCoverLetter } = await import("@/lib/ai/documents");
    return draftCoverLetter({ job, resume }, userId, confirmed);
  },
  INTERVIEW_PREP: async (userId) => {
    const { generateInterviewPrep } = await import("@/lib/ai/interview-prep");
    return generateInterviewPrep({ interview: { type: "TECHNICAL" }, job, resume, profile: null }, userId, confirmed);
  },
  INTERVIEW_FEEDBACK: async (userId) => {
    const { generateInterviewFeedback } = await import("@/lib/ai/interview-feedback");
    return generateInterviewFeedback({
      interview: { type: "TECHNICAL" },
      job,
      resume,
      notes: ["They asked about deployment reliability."],
      transcript: null
    }, userId, confirmed);
  },
  EMAIL_REPLY: async (userId) => {
    const { draftEmailReply } = await import("@/lib/ai/email-reply");
    return draftEmailReply({
      emailText: "Could you share your availability for a call next week?",
      tone: "professional",
      job
    }, userId, confirmed);
  },
  APPLICATION_PLAN: async (userId) => {
    const { planApplication } = await import("@/lib/ai/application-plan");
    return planApplication({ job, resume }, userId, { automation: true, highCostConfirmed: true });
  },
  MOCK_INTERVIEW_QUESTIONS: async (userId) => {
    const { generateMockInterviewQuestions } = await import("@/lib/ai/mock-interview");
    return generateMockInterviewQuestions({
      interviewType: "TECHNICAL",
      job: {
        ...job,
        description: "You will build reliable TypeScript services for payment teams.\nYou will lead incident response for core systems."
      },
      resume
    }, userId, confirmed);
  },
  MOCK_INTERVIEW_FEEDBACK: async (userId) => {
    const { generateMockAnswerFeedback } = await import("@/lib/ai/mock-interview");
    return generateMockAnswerFeedback({
      question: {
        questionId: "q1",
        category: "BEHAVIORAL",
        question: "Tell me about a time you made a service more reliable.",
        lookingFor: "A clear result.",
        jobLine: { lineId: "L1", text: "TypeScript", source: "requirement" },
        factIds: []
      },
      job,
      resume,
      answer: "At Prior Co I rebuilt our deploy pipeline in TypeScript so releases stopped failing."
    }, userId, confirmed);
  }
};

test("the registry covers every AI feature policy and every active feature has a ledger proof", () => {
  assert.deepEqual(
    Object.keys(AI_FEATURE_REGISTRY).sort(),
    Object.keys(AI_FEATURE_POLICIES).sort()
  );
  assert.deepEqual(activeAiFeatures().sort(), Object.keys(FEATURE_INVOKERS).sort());
  for (const feature of activeAiFeatures()) {
    const registration = AI_FEATURE_REGISTRY[feature];
    assert.equal(registration.provider, "gemini", feature);
    assert.ok(registration.entryPoint, feature);
  }
  // The retired legacy features the MVP needs (interview, email, planning) are active.
  for (const feature of ["INTERVIEW_PREP", "INTERVIEW_FEEDBACK", "EMAIL_REPLY", "APPLICATION_PLAN"] as AiFeature[]) {
    assert.equal(AI_FEATURE_REGISTRY[feature].status, "active", feature);
  }
  // Text mock interviews (WP1.8) send the user's own answers, so both calls need
  // explicit data and cost confirmation.
  for (const feature of ["MOCK_INTERVIEW_QUESTIONS", "MOCK_INTERVIEW_FEEDBACK"] as AiFeature[]) {
    assert.equal(AI_FEATURE_REGISTRY[feature].status, "active", feature);
    assert.equal(AI_FEATURE_REGISTRY[feature].confirmation, "data_and_cost", feature);
    assert.match(AI_FEATURE_REGISTRY[feature].entryPoint ?? "", /^lib\/ai\/mock-interview\.ts#/u, feature);
  }
});

for (const feature of Object.keys(FEATURE_INVOKERS)) {
  test(`${feature} reserves against the hard Gemini ledger before dispatch and reconciles after`, async (t) => {
    paidEnvironment(t);
    const ledger = installLedger(t, "allow");

    await FEATURE_INVOKERS[feature]("ledger-user").catch(() => undefined);

    assert.equal(ledger.reservations.length, 1, `${feature} must reserve exactly once`);
    const reservation = ledger.reservations[0];
    assert.equal(reservation.feature, feature);
    assert.equal(reservation.provider, "gemini");
    assert.equal(reservation.userId, "ledger-user");
    assert.ok(Number(reservation.maximumCostMicros) > 0);
    assert.ok(Number(reservation.maximumCostMicros) <= AI_MAX_REQUEST_COST_CENTS * 10_000, "within the per-request maximum");
    assert.equal(ledger.dispatches(), 1);
    assert.match(ledger.requests[0], /^https:\/\/generativelanguage\.googleapis\.com\//u);
    assert.deepEqual(ledger.events.slice(0, 3), ["reserve", "dispatch", "reconcile"]);
    assert.equal(ledger.reconciliations.length, 1);
  });

  // Google's Standard price for Gemini 3.8 Flash doubles on 2027-01-01 (decision D032).
  test(`${feature} still reserves and dispatches at Google's January 2027 price`, async (t) => {
    paidEnvironment(t);
    t.mock.timers.enable({ apis: ["Date"], now: new Date("2027-01-01T00:00:00.000Z") });
    const ledger = installLedger(t, "allow");

    await FEATURE_INVOKERS[feature]("ledger-user").catch(() => undefined);

    assert.equal(ledger.reservations.length, 1, `${feature} must reserve exactly once`);
    assert.ok(
      Number(ledger.reservations[0].maximumCostMicros) <= AI_MAX_REQUEST_COST_CENTS * 10_000,
      "within the per-request maximum"
    );
    assert.equal(ledger.dispatches(), 1);
  });

  test(`${feature} makes no provider call when the hard ledger refuses the reservation`, async (t) => {
    paidEnvironment(t);
    const ledger = installLedger(t, "deny");

    await assert.rejects(
      FEATURE_INVOKERS[feature]("ledger-user"),
      (error: unknown) => error instanceof PublicApiError &&
        error.status === 429 && error.details?.code === "AI_BUDGET_EXCEEDED"
    );
    assert.equal(ledger.dispatches(), 0);
    assert.equal(ledger.reservations.length, 0);
  });

  test(`${feature} is unavailable without Gemini and never falls back to a template`, async (t) => {
    paidEnvironment(t);
    delete process.env.GEMINI_API_KEY;
    process.env.OPENAI_API_KEY = "synthetic-openai-must-not-be-used";
    const ledger = installLedger(t, "allow");

    if (feature === "APPLICATION_PLAN") {
      // Planning is the one deterministic, evidence-derived path: it is labeled local,
      // costs nothing, contacts no provider, and never claims AI output.
      const { planApplication } = await import("@/lib/ai/application-plan");
      const plan = await planApplication({ job, resume }, "ledger-user", { automation: true });
      assert.equal(plan.provider, "local");
      assert.equal(plan.usage.mocked, true);
    } else {
      await assert.rejects(
        FEATURE_INVOKERS[feature]("ledger-user"),
        (error: unknown) => error instanceof PublicApiError && error.status === 503 &&
          /unavailable in local mode/u.test(error.message)
      );
    }
    assert.equal(ledger.dispatches(), 0);
    assert.equal(ledger.reservations.length, 0);
  });
}

function sourceFiles(root: string): string[] {
  return readdirSync(root).flatMap((entry) => {
    const path = join(root, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(?:ts|tsx)$/u.test(entry) ? [path] : [];
  });
}

const repositoryRoot = new URL("..", import.meta.url).pathname;
const productSources = ["app", "lib", "components"].flatMap((directory) =>
  sourceFiles(join(repositoryRoot, directory)));

test("no product source reaches OpenAI, Kimi, or a second AI key", () => {
  for (const path of productSources) {
    const source = readFileSync(path, "utf8");
    const name = relative(repositoryRoot, path);
    assert.doesNotMatch(source, /from ["']openai(?:\/[^"']*)?["']/u, `${name} imports the OpenAI SDK`);
    assert.doesNotMatch(source, /api\.openai\.com|api\.moonshot|chat\.completions/u, `${name} calls a retired provider`);
    assert.doesNotMatch(source, /process\.env\.(?:OPENAI_API_KEY|MOONSHOT_API_KEY)/u, `${name} reads a retired AI key`);
  }
});

test("only ledger-guarded modules and owner-gated diagnostics dispatch to Gemini", () => {
  const callers = productSources
    .filter((path) => /callGeminiJsonProvider\(/u.test(readFileSync(path, "utf8")))
    .map((path) => relative(repositoryRoot, path))
    .filter((path) => path !== "lib/ai/gemini.ts")
    .sort();
  assert.deepEqual(callers, [
    // Owner-gated, separately budgeted qualification and correction-flow harnesses.
    "lib/ai/correction-flow-document-diagnostic.ts",
    "lib/ai/correction-flow-provider-adapter.ts",
    "lib/ai/correction-flow-resume-diagnostic.ts",
    // The one shared product engine plus the two features with bespoke ledgers.
    "lib/ai/guarded-gemini.ts",
    "lib/ai/job-match-qualification.ts",
    "lib/ai/job-match.ts",
    "lib/ai/resume.ts"
  ]);
});
