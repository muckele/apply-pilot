import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { getAiFinancialPolicy, getAiRuntimeMode } from "@/lib/ai/config";
import { enforceJobMatchEvidence, type JobMatchOutput, type MatchInput } from "@/lib/ai/job-match";
import { AI_FEATURE_POLICIES, assertAiInputWithinLimits, splitTranscriptSections } from "@/lib/ai/policy";
import { estimateAiCostMicros, getModelPricing, MODEL_PRICING_REGISTRY } from "@/lib/ai/pricing";
import { PublicApiError } from "@/lib/api-errors";

const trackedEnvironment = [
  "AI_ENABLED",
  "AI_PROVIDER",
  "AI_MOCK_MODE",
  "OPENAI_MOCK_MODE",
  "GEMINI_API_KEY",
  "AI_HARD_CAP_CENTS",
  "AI_AUTOMATION_CAP_CENTS",
  "AI_MAX_REQUEST_COST_CENTS",
  "AI_CONFIRMATION_THRESHOLD_CENTS"
] as const;
const originalEnvironment = Object.fromEntries(trackedEnvironment.map((name) => [name, process.env[name]]));

afterEach(() => {
  for (const name of trackedEnvironment) {
    const original = originalEnvironment[name];
    if (original === undefined) delete process.env[name];
    else process.env[name] = original;
  }
});

test("AI feature output limits match the production policy", () => {
  assert.equal(AI_FEATURE_POLICIES.RESUME_PARSE.maxOutputTokens, 4_000);
  assert.equal(AI_FEATURE_POLICIES.JOB_MATCH.maxOutputTokens, 2_500);
  assert.equal(AI_FEATURE_POLICIES.EMAIL_CLASSIFICATION.maxOutputTokens, 800);
  assert.equal(AI_FEATURE_POLICIES.RESUME_TAILOR.maxOutputTokens, 6_000);
  assert.equal(AI_FEATURE_POLICIES.COVER_LETTER.maxOutputTokens, 1_500);
  assert.equal(AI_FEATURE_POLICIES.EMAIL_REPLY.maxOutputTokens, 1_000);
  assert.equal(AI_FEATURE_POLICIES.INTERVIEW_PREP.maxOutputTokens, 4_000);
  assert.equal(AI_FEATURE_POLICIES.INTERVIEW_FEEDBACK.maxOutputTokens, 5_000);
});

test("oversized resume text is rejected before a provider call", () => {
  assert.throws(
    () => assertAiInputWithinLimits("RESUME_PARSE", "Parse honestly.", { resumeText: "x".repeat(90_100) }),
    (error) => error instanceof PublicApiError && error.status === 413
  );
});

test("interview transcripts are split into bounded sections", () => {
  const result = splitTranscriptSections("Sentence. ".repeat(14_000), 2);
  assert.equal(result.sections.length, 2);
  assert.equal(result.truncated, true);
  assert.ok(result.sections.every((section) => Buffer.byteLength(section, "utf8") <= 24_000));
});

test("unregistered model pricing fails closed", () => {
  assert.throws(
    () => getModelPricing("unregistered-model"),
    (error) => error instanceof PublicApiError && error.details?.code === "AI_MODEL_PRICING_UNKNOWN"
  );
});

test("server financial settings cannot raise the layered caps", () => {
  process.env.AI_HARD_CAP_CENTS = "999";
  process.env.AI_AUTOMATION_CAP_CENTS = "999";
  process.env.AI_MAX_REQUEST_COST_CENTS = "999";
  process.env.AI_CONFIRMATION_THRESHOLD_CENTS = "999";

  assert.deepEqual(getAiFinancialPolicy(), {
    hardCapCents: 500,
    automationCapCents: 150,
    maximumRequestCents: 10,
    confirmationThresholdCents: 5
  });
  const maximumTailorCost = estimateAiCostMicros({
    model: "gemini-3.5-flash-lite",
    inputTokens: AI_FEATURE_POLICIES.RESUME_TAILOR.maxInputTokens,
    outputTokens: AI_FEATURE_POLICIES.RESUME_TAILOR.maxOutputTokens
  });
  assert.ok(maximumTailorCost > 30_000);
  assert.ok(maximumTailorCost <= 100_000);
});

test("Gemini pricing registry uses standard real-time rates", () => {
  assert.deepEqual(getModelPricing("gemini-3.1-flash-lite"), {
    provider: "gemini",
    inputUsdPerMillion: 0.25,
    outputUsdPerMillion: 1.5
  });
  assert.deepEqual(getModelPricing("gemini-3.5-flash"), {
    provider: "gemini",
    inputUsdPerMillion: 1.5,
    outputUsdPerMillion: 9,
    cachedInputUsdPerMillion: 0.15
  });
});

test("legacy OpenAI mock mode does not disable an explicitly enabled Gemini provider", () => {
  process.env.AI_ENABLED = "true";
  process.env.AI_PROVIDER = "gemini";
  process.env.AI_MOCK_MODE = "false";
  process.env.OPENAI_MOCK_MODE = "true";
  process.env.GEMINI_API_KEY = "configured";

  assert.equal(getAiRuntimeMode(), "gemini");
});

test("job match evidence enforcement demotes inferred keywords", () => {
  const input: MatchInput = {
    job: { title: "Technical Account Manager", company: "Example", description: "Customer support and SQL" },
    resume: { summary: "Customer-facing engineer", skills: ["SQL"] },
    profile: null
  };
  const output = {
    overallFitScore: 80,
    resumeKeywordScore: 80,
    skillsMatchScore: 80,
    experienceMatchScore: 80,
    careerGoalScore: 80,
    locationWorkStyleScore: 80,
    compensationScore: null,
    confidenceScore: 80,
    whyGoodMatch: [],
    concerns: [],
    missingKeywords: [],
    supportedKeywords: ["Customer support", "SQL"],
    keywordsToEmphasize: ["Customer support", "SQL"],
    suggestedResumeAngle: "",
    suggestedCoverLetterAngle: "",
    recommendation: "apply now"
  } satisfies JobMatchOutput;

  const verified = enforceJobMatchEvidence(output, input);
  assert.deepEqual(verified.supportedKeywords, ["SQL"]);
  assert.deepEqual(verified.keywordsToEmphasize, ["SQL"]);
  assert.deepEqual(verified.missingKeywords, ["Customer support"]);
  assert.match(verified.concerns[0], /Customer support/);
});

test("Kimi K3 pricing is registered at the current standard rates", () => {
  assert.deepEqual(getModelPricing("kimi-k3"), {
    provider: "kimi",
    inputUsdPerMillion: 3,
    cachedInputUsdPerMillion: 0.3,
    outputUsdPerMillion: 15
  });
});

test("deprecated Kimi K2 preview models are absent and fail closed", () => {
  assert.equal(MODEL_PRICING_REGISTRY["kimi-k2-0905-preview"], undefined);
  assert.ok(Object.keys(MODEL_PRICING_REGISTRY).every((model) => !model.startsWith("kimi-k2")));
  assert.throws(
    () => getModelPricing("kimi-k2-0905-preview"),
    (error) => error instanceof PublicApiError && error.details?.code === "AI_MODEL_PRICING_UNKNOWN"
  );
});

test("the application plan policy fits the compiled per-request cost ceiling", () => {
  assert.deepEqual(AI_FEATURE_POLICIES.APPLICATION_PLAN, {
    maxOutputTokens: 4_000,
    maxInputTokens: 12_000,
    modelTier: "quality"
  });

  const ceilingMicros = getAiFinancialPolicy().maximumRequestCents * 10_000;
  assert.equal(ceilingMicros, 100_000);

  const worstCase = estimateAiCostMicros({ model: "kimi-k3", inputTokens: 12_000, outputTokens: 4_000 });
  assert.equal(worstCase, 96_000);
  assert.ok(worstCase <= ceilingMicros);

  const fullyCachedInput = estimateAiCostMicros({
    model: "kimi-k3",
    inputTokens: 12_000,
    cachedInputTokens: 12_000,
    outputTokens: 4_000
  });
  assert.equal(fullyCachedInput, 63_600);
});

test("the rejected 56k-input plan sizing would exceed the per-request ceiling", () => {
  const rejected = estimateAiCostMicros({ model: "kimi-k3", inputTokens: 56_000, outputTokens: 4_000 });
  assert.equal(rejected, 228_000);
  assert.ok(rejected > getAiFinancialPolicy().maximumRequestCents * 10_000);
});
