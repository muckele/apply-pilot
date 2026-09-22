import assert from "node:assert/strict";
import { test } from "node:test";

import { runJobMatch } from "@/lib/jobs";
import { prisma } from "@/lib/prisma";

test("runJobMatch excludes heuristic-local rows but reuses real-model rows", async () => {
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
  let modelFilter: unknown;
  try {
    delete process.env.OPENAI_API_KEY;
    prisma.jobPosting.findFirstOrThrow = (async () => job) as unknown as typeof originalJob;
    prisma.resume.findFirst = (async () => null) as unknown as typeof originalResume;
    prisma.userProfile.findUnique = (async () => null) as unknown as typeof originalProfile;
    prisma.aIAnalysis.findFirst = (async (args: { where: { model: unknown } }) => {
      modelFilter = args.where.model;
      return modelFilter ? null : { model: "heuristic-local", output: { overallFitScore: 78 } };
    }) as unknown as typeof originalAnalysis;
    await assert.rejects(runJobMatch("user-1", job.id), /unavailable in local mode/);
    assert.deepEqual(modelFilter, { not: "heuristic-local" });
    prisma.aIAnalysis.findFirst = (async () => ({ model: "gpt-4o-mini", output: { overallFitScore: 81 } })) as unknown as typeof originalAnalysis;
    const cached = await runJobMatch("user-1", job.id);
    assert.equal(cached.cached, true);
    assert.deepEqual(cached.match, { overallFitScore: 81 });
  } finally {
    prisma.jobPosting.findFirstOrThrow = originalJob;
    prisma.resume.findFirst = originalResume;
    prisma.userProfile.findUnique = originalProfile;
    prisma.aIAnalysis.findFirst = originalAnalysis;
    if (oldKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = oldKey;
  }
});
