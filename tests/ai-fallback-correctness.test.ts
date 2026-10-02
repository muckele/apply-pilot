import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { z } from "zod";

import { generateJson, getOpenAIClient, LocalAiUnavailableError } from "@/lib/ai/client";
import { scoreJobMatch, validateAndNormalizeJobMatchOutput } from "@/lib/ai/job-match";
import { draftCoverLetter, draftEmailReply, generateInterviewPrep, generateInterviewFeedback } from "@/lib/ai/documents";
import { parseResumeText, tailorResume } from "@/lib/ai/resume";
import { hashAiInput } from "@/lib/ai/usage";
import { prisma } from "@/lib/prisma";

const oldKey = process.env.OPENAI_API_KEY;
const oldMock = process.env.OPENAI_MOCK_MODE;
const oldModel = process.env.OPENAI_MODEL;
const oldGeminiKey = process.env.GEMINI_API_KEY;
const oldAiEnabled = process.env.AI_ENABLED;
const oldAiMock = process.env.AI_MOCK_MODE;
afterEach(() => {
  if (oldKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = oldKey;
  if (oldMock === undefined) delete process.env.OPENAI_MOCK_MODE; else process.env.OPENAI_MOCK_MODE = oldMock;
  if (oldModel === undefined) delete process.env.OPENAI_MODEL; else process.env.OPENAI_MODEL = oldModel;
  if (oldGeminiKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = oldGeminiKey;
  if (oldAiEnabled === undefined) delete process.env.AI_ENABLED; else process.env.AI_ENABLED = oldAiEnabled;
  if (oldAiMock === undefined) delete process.env.AI_MOCK_MODE; else process.env.AI_MOCK_MODE = oldAiMock;
});
function local(mock = false) {
  delete process.env.GEMINI_API_KEY;
  process.env.AI_ENABLED = "false";
  process.env.AI_MOCK_MODE = mock ? "true" : "false";
  if (mock) { process.env.OPENAI_API_KEY = "test-key"; process.env.OPENAI_MOCK_MODE = "true"; }
  else { delete process.env.OPENAI_API_KEY; delete process.env.OPENAI_MOCK_MODE; }
}
const job = { title: "Software Engineer", company: "Acme", description: "React SQL AWS operations implementation Excel" };
const alice = { job, resume: { summary: "Alice Example", skills: ["Excel"] } };
const bob = { job, resume: { summary: "Bob Example", skills: ["Python"] } };

test("central contract keeps safe local fallback but rejects absent fallback with a typed error", async () => {
  local();
  const input = { promptName: "safe", systemPrompt: "test", payload: { a: 1 }, schema: z.object({ value: z.string() }) };
  const safe = await generateJson({ ...input, fallback: { value: "from input" } });
  assert.equal(safe.meta.model, "heuristic-local");
  assert.equal(safe.meta.mocked, true);
  assert.equal(safe.meta.inputTokens, 0);
  assert.equal(safe.meta.requestHash, hashAiInput("safe", "1", { a: 1 }));
  await assert.rejects(generateJson(input), (error) => error instanceof LocalAiUnavailableError);
  local(true);
  await assert.rejects(generateJson(input), (error) => error instanceof LocalAiUnavailableError);
});

test("the job-match boundary accepts and normalizes a schema-valid v3 response", () => {
  const output = {
    contractVersion: "3",
    overallFitScore: 81, resumeKeywordScore: 70, skillsMatchScore: 70,
    experienceMatchScore: 80, careerGoalScore: 85, locationWorkStyleScore: 90,
    compensationScore: null, confidenceScore: 75,
    confidenceBasis: "Based on cited submitted fields.",
    factualMatches: [{
      applicantEvidence: [{ ref: "resume.skills[0]", excerpt: "Excel" }],
      jobEvidence: [{ ref: "job.description", excerpt: "Excel" }],
      supportedKeywords: ["Excel"]
    }],
    requirementGaps: [],
    advice: {
      keywordsToEmphasize: ["Excel"],
      resumeAngle: "Emphasize supported Excel work.",
      coverLetterAngle: "Discuss the cited evidence."
    },
    recommendation: "consider"
  };
  const result = validateAndNormalizeJobMatchOutput(alice, output).normalized;
  assert.equal(result.overallFitScore, 81);
  assert.deepEqual(result.supportedKeywords, ["Excel"]);
});

test("budget denial occurs before a real model call", async () => {
  process.env.OPENAI_API_KEY = "test-key";
  process.env.OPENAI_MOCK_MODE = "false";
  const settings = prisma.aISettings;
  const usage = prisma.aIUsageEvent;
  const originalUpsert = settings.upsert;
  const originalAggregate = usage.aggregate;
  const originalCount = usage.count;
  const client = getOpenAIClient()!;
  const originalCreate = client.chat.completions.create;
  let called = false;
  try {
    settings.upsert = (async () => ({ monthlyBudgetCents: 0 })) as unknown as typeof originalUpsert;
    usage.aggregate = (async () => ({ _sum: { estimatedCostMicros: 0 } })) as unknown as typeof originalAggregate;
    usage.count = (async () => 0) as unknown as typeof originalCount;
    client.chat.completions.create = (async () => { called = true; throw new Error("must not call"); }) as unknown as typeof originalCreate;
    await assert.rejects(generateJson({
      promptName: "budget", systemPrompt: "test", payload: {}, schema: z.object({ value: z.string() }),
      context: { userId: "test-user", feature: "TEST" }
    }), /monthly AI budget/);
    assert.equal(called, false);
  } finally {
    settings.upsert = originalUpsert;
    usage.aggregate = originalAggregate;
    usage.count = originalCount;
    client.chat.completions.create = originalCreate;
  }
});

test("job match fails closed for Alice, Bob, and no applicant evidence in local and mock mode", async () => {
  for (const mock of [false, true]) {
    local(mock);
    for (const input of [alice, bob, { job, resume: null }]) {
      await assert.rejects(scoreJobMatch(input), LocalAiUnavailableError);
    }
  }
});

test("local cover letter is claim-free and cross-applicant safe", async () => {
  local();
  for (const resume of [alice.resume, bob.resume]) {
    const draft = await draftCoverLetter({ job, resume });
    assert.match(draft.coverLetter, /Acme/);
    assert.match(draft.coverLetter, /Software Engineer/);
    assert.doesNotMatch(JSON.stringify(draft), /Mathew|Uckele|General Assembly|Golden Behavior Connection|payer|billing|compliance|operations leadership|full-stack/i);
    assert.deepEqual(draft.claimsUsed, []);
    assert.match(draft.angle, /generic|personaliz|review/i);
  }
});

test("local email reply fails closed for arbitrary email content", async () => {
  local();
  await assert.rejects(draftEmailReply({ emailText: "Your application was rejected.", tone: "professional" }), LocalAiUnavailableError);
});

test("local interview prep contains no invented applicant history", async () => {
  local();
  for (const resume of [alice.resume, bob.resume]) {
    const prep = await generateInterviewPrep({ job, resume });
    assert.deepEqual(prep.starStories, []);
    assert.doesNotMatch(JSON.stringify(prep), /Mathew|Uckele|payer|billing|compliance|operations ownership|transition into technical|engineering depth/i);
  }
});

test("local interview feedback contains no invented applicant history", async () => {
  local();
  for (const resume of [alice.resume, bob.resume]) {
    const feedback = await generateInterviewFeedback({ job, resume });
    assert.deepEqual(feedback.questionsAsked, []);
    assert.deepEqual(feedback.strongMoments, []);
    assert.deepEqual(feedback.weakAnswers, []);
    assert.deepEqual(feedback.betterAnswers, []);
    assert.doesNotMatch(JSON.stringify(feedback), /Mathew|Uckele|technical problem solving|customer communication|operational follow-through/i);
  }
});

test("local tailoring cannot assign a fixed persona or scores to Alice or Bob", async () => {
  local();
  for (const resume of [alice.resume, bob.resume]) {
    await assert.rejects(tailorResume({ job, resume }, resume.summary), LocalAiUnavailableError);
  }
});

test("resume parsing fails closed instead of replacing structured sections with a local heuristic", async () => {
  local();
  await assert.rejects(
    parseResumeText("EXPERIENCE\nEngineer — Example Co\nEDUCATION\nExample University"),
    LocalAiUnavailableError
  );
});

test("real client failures and invalid responses never become local fallback", async () => {
  process.env.OPENAI_API_KEY = "test-key";
  process.env.OPENAI_MOCK_MODE = "false";
  process.env.OPENAI_MODEL = "gpt-test";
  const client = getOpenAIClient()!;
  const original = client.chat.completions.create;
  const input = { promptName: "probe", systemPrompt: "test", payload: { a: 1 }, fallback: { value: "fallback" }, schema: z.object({ value: z.string() }) };
  try {
    client.chat.completions.create = (async () => { throw new Error("remote failed"); }) as unknown as typeof original;
    await assert.rejects(generateJson(input), /remote failed/);
    client.chat.completions.create = (async () => ({ choices: [{ message: { content: "bad json" } }] })) as unknown as typeof original;
    await assert.rejects(generateJson(input), SyntaxError);
    client.chat.completions.create = (async () => ({ choices: [{ message: { content: "{}" } }] })) as unknown as typeof original;
    await assert.rejects(generateJson(input), /expected schema/);
    client.chat.completions.create = (async () => ({ choices: [{ message: { content: '{"value":"real"}' } }], usage: { prompt_tokens: 3, completion_tokens: 2 } })) as unknown as typeof original;
    const result = await generateJson(input);
    assert.equal(result.data.value, "real");
    assert.equal(result.meta.model, "gpt-test");
    assert.equal(result.meta.mocked, false);
    assert.equal(result.meta.inputTokens, 3);
  } finally { client.chat.completions.create = original; }
});
