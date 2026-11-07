import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { z } from "zod";

import { generateJson, LocalAiUnavailableError } from "@/lib/ai/client";
import { draftCoverLetter } from "@/lib/ai/documents";
import { draftEmailReply } from "@/lib/ai/email-reply";
import { generateInterviewFeedback } from "@/lib/ai/interview-feedback";
import { generateInterviewPrep } from "@/lib/ai/interview-prep";
import { scoreJobMatch, validateAndNormalizeJobMatchOutput } from "@/lib/ai/job-match";
import { parseResumeText, tailorResume } from "@/lib/ai/resume";

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

test("the central contract has no local template fallback and fails closed with a typed error", async () => {
  for (const mock of [false, true]) {
    local(mock);
    const input = {
      promptName: "safe",
      systemPrompt: "test",
      payload: { a: 1 },
      schema: z.object({ value: z.string() }),
      responseJsonSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
      context: { userId: "user-1", feature: "COVER_LETTER" as const, promptVersion: "1" }
    };
    await assert.rejects(generateJson(input), (error) => error instanceof LocalAiUnavailableError);
  }
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

test("job match fails closed for Alice, Bob, and no applicant evidence in local and mock mode", async () => {
  for (const mock of [false, true]) {
    local(mock);
    for (const input of [alice, bob, { job, resume: null }]) {
      await assert.rejects(scoreJobMatch(input), LocalAiUnavailableError);
    }
  }
});

test("cover letters fail closed instead of producing a generic template", async () => {
  for (const mock of [false, true]) {
    local(mock);
    for (const resume of [alice.resume, bob.resume]) {
      await assert.rejects(draftCoverLetter({ job, resume }, "user-1"), LocalAiUnavailableError);
    }
  }
});

test("email drafting, interview prep, and interview feedback fail closed without Gemini", async () => {
  for (const mock of [false, true]) {
    local(mock);
    await assert.rejects(
      draftEmailReply({ emailText: "Your application was rejected.", tone: "professional", job: null }, "user-1"),
      LocalAiUnavailableError
    );
    for (const resume of [alice.resume, bob.resume]) {
      await assert.rejects(
        generateInterviewPrep({ interview: { type: "RECRUITER" }, job, resume, profile: null }, "user-1"),
        LocalAiUnavailableError
      );
      await assert.rejects(
        generateInterviewFeedback({
          interview: { type: "RECRUITER" }, job, resume, notes: ["Asked about Excel."], transcript: null
        }, "user-1"),
        LocalAiUnavailableError
      );
    }
  }
});

test("local tailoring cannot assign a fixed persona or scores to Alice or Bob", async () => {
  local();
  for (const resume of [alice.resume, bob.resume]) {
    await assert.rejects(tailorResume({ job, resume }, resume.summary, "user-1"), LocalAiUnavailableError);
  }
});

test("resume parsing fails closed instead of replacing structured sections with a local heuristic", async () => {
  local();
  await assert.rejects(
    parseResumeText("EXPERIENCE\nEngineer — Example Co\nEDUCATION\nExample University"),
    LocalAiUnavailableError
  );
});
