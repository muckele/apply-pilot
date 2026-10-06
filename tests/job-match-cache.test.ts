import assert from "node:assert/strict";
import { test } from "node:test";

import { runJobMatch } from "@/lib/jobs";
import { JOB_MATCH_MODEL } from "@/lib/ai/job-match";
import { prisma } from "@/lib/prisma";

test("runJobMatch reuses only current v3.2 rows from the pinned Gemini JOB_MATCH model", async () => {
  const job = {
    id: "job-1", title: "Engineer", company: "Acme", description: "React",
    location: null, remoteStatus: null, salaryMin: null, salaryMax: null,
    requirements: [], preferredQualifications: [], detectedTechStack: [], overallFitScore: 78
  };
  const originalJob = prisma.jobPosting.findFirstOrThrow;
  const originalResume = prisma.resume.findFirst;
  const originalProfile = prisma.userProfile.findUnique;
  const originalAnalysis = prisma.aIAnalysis.findFirst;
  const oldKey = process.env.OPENAI_API_KEY;
  const oldGeminiKey = process.env.GEMINI_API_KEY;
  const oldAiEnabled = process.env.AI_ENABLED;
  let modelFilter: unknown;
  let promptVersion: unknown;
  try {
    delete process.env.OPENAI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    process.env.AI_ENABLED = "false";
    prisma.jobPosting.findFirstOrThrow = (async () => job) as unknown as typeof originalJob;
    prisma.resume.findFirst = (async () => null) as unknown as typeof originalResume;
    prisma.userProfile.findUnique = (async () => null) as unknown as typeof originalProfile;
    prisma.aIAnalysis.findFirst = (async (args: { where: { model: unknown; promptVersion: unknown } }) => {
      modelFilter = args.where.model;
      promptVersion = args.where.promptVersion;
      return null;
    }) as unknown as typeof originalAnalysis;
    await assert.rejects(runJobMatch("user-1", job.id), /unavailable in local mode/);
    assert.equal(modelFilter, JOB_MATCH_MODEL);
    assert.equal(promptVersion, "3.2");
    prisma.aIAnalysis.findFirst = (async () => ({ model: JOB_MATCH_MODEL, output: { overallFitScore: 81 } })) as unknown as typeof originalAnalysis;
    const cached = await runJobMatch("user-1", job.id);
    assert.equal(cached.cached, true);
    assert.deepEqual(cached.match, { overallFitScore: 81 });
  } finally {
    prisma.jobPosting.findFirstOrThrow = originalJob;
    prisma.resume.findFirst = originalResume;
    prisma.userProfile.findUnique = originalProfile;
    prisma.aIAnalysis.findFirst = originalAnalysis;
    if (oldKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = oldKey;
    if (oldGeminiKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = oldGeminiKey;
    if (oldAiEnabled === undefined) delete process.env.AI_ENABLED; else process.env.AI_ENABLED = oldAiEnabled;
  }
});
