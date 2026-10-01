import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { JobPosting, JobSource } from "@prisma/client";

import { getJobSourceProvider } from "@/lib/job-sources";
import { importJobsFromSource, scoreTopImportedJobs } from "@/lib/job-sources/discovery";
import { scoreJobRelevance } from "@/lib/job-sources/relevance";
import type { NormalizedJob } from "@/lib/job-sources/types";
import { prisma } from "@/lib/prisma";
import { PublicApiError } from "@/lib/api-errors";

function stub(t: TestContext, owner: object, name: string, replacement: unknown) {
  const methods = owner as Record<string, unknown>;
  const original = methods[name];
  methods[name] = replacement;
  t.after(() => { methods[name] = original; });
}

const source = { id: "source-1", name: "Example Co", type: "GREENHOUSE" } as JobSource;
const rawJob = {
  id: 1,
  title: "Solutions Engineer",
  absolute_url: "https://boards.greenhouse.io/example/jobs/1",
  location: { name: "Los Angeles, CA" },
  content: "Partner with customers on technical discovery, demos, API integrations, onboarding, SaaS workflows, and training. Requires React, SQL, and AWS."
};

function posting(id: string, title: string, description: string, overallFitScore: number | null = null) {
  const normalized: NormalizedJob = {
    title,
    company: "Example Co",
    location: "Los Angeles, CA",
    remoteStatus: "Hybrid",
    sourceUrl: `https://example.com/jobs/${id}`,
    description,
    requirements: [],
    preferredQualifications: [],
    benefits: [],
    detectedTechStack: [],
    sourceType: "GREENHOUSE"
  };
  const row = {
    ...normalized,
    id,
    userId: "user-1",
    location: normalized.location ?? null,
    remoteStatus: normalized.remoteStatus ?? null,
    salaryMin: null,
    salaryMax: null,
    datePosted: null,
    seniorityLevel: null,
    companySize: null,
    overallFitScore,
    confidenceScore: null,
    supportedKeywords: [],
    missingKeywords: [],
    concerns: [],
    suggestedResumeAngle: null,
    suggestedCoverLetterAngle: null
  } as unknown as JobPosting;
  return { normalized, row };
}

function stubPersonalizedBoundary(t: TestContext, requestedIds: string[]) {
  stub(t, prisma.jobPosting, "findFirstOrThrow", async (args: { where: { id: string } }) => {
    requestedIds.push(args.where.id);
    throw new Error("personalized scoring unavailable in test");
  });
  stub(t, prisma.resume, "findFirst", async () => null);
  stub(t, prisma.userProfile, "findUnique", async () => null);
}

test("new discovery imports stay unscored and persist no applicant-fit evidence", async (t) => {
  const provider = getJobSourceProvider("GREENHOUSE");
  const row = posting("new-job", rawJob.title, rawJob.content).row;
  const upserts: Array<{ create: Record<string, unknown>; update: Record<string, unknown> }> = [];
  const updates: Array<{ data: Record<string, unknown> }> = [];
  stub(t, provider, "searchJobs", async () => [rawJob]);
  stub(t, prisma.jobPosting, "upsert", async (args: { create: Record<string, unknown>; update: Record<string, unknown> }) => {
    upserts.push(args);
    return row;
  });
  stub(t, prisma.jobPosting, "update", async (args: { data: Record<string, unknown> }) => {
    updates.push(args);
    return { ...row, ...args.data };
  });

  const result = await importJobsFromSource({ userId: "user-1", source, criteria: {}, profile: null });

  assert.equal(result.imported.length, 1);
  assert.ok(result.bestRelevanceScore >= 60);
  assert.equal(result.imported[0].overallFitScore, null);
  assert.deepEqual(result.imported[0].supportedKeywords, []);
  assert.equal(result.imported[0].suggestedResumeAngle, null);
  assert.equal(result.imported[0].suggestedCoverLetterAngle, null);
  assert.equal(upserts.length, 1);
  assert.deepEqual(updates, []);
  for (const data of [upserts[0].create, upserts[0].update]) {
    for (const key of ["overallFitScore", "resumeKeywordScore", "skillsMatchScore", "experienceMatchScore",
      "careerGoalScore", "locationWorkStyleScore", "compensationScore", "confidenceScore",
      "keyMatchReason", "matchRecommendation", "supportedKeywords", "missingKeywords",
      "suggestedResumeAngle", "suggestedCoverLetterAngle", "concerns"]) {
      assert.equal(Object.hasOwn(data, key), false, `${key} must not be set by discovery`);
    }
  }
});

test("discovery never writes a fixed applicant cover-letter narrative", async (t) => {
  const provider = getJobSourceProvider("GREENHOUSE");
  const row = posting("new-job", rawJob.title, rawJob.content).row;
  const writes: unknown[] = [];
  stub(t, provider, "searchJobs", async () => [rawJob]);
  stub(t, prisma.jobPosting, "upsert", async (args: unknown) => { writes.push(args); return row; });
  stub(t, prisma.jobPosting, "update", async (args: unknown) => { writes.push(args); return row; });

  await importJobsFromSource({ userId: "user-1", source, criteria: {}, profile: null });

  assert.doesNotMatch(JSON.stringify(writes), /Mathew|Uckele|software training|operations leadership/i);
});

test("rediscovery preserves an existing personalized match without scoring-field updates", async (t) => {
  const provider = getJobSourceProvider("GREENHOUSE");
  const row = {
    ...posting("scored-job", rawJob.title, rawJob.content, 91).row,
    confidenceScore: 88,
    supportedKeywords: ["Verified skill"],
    suggestedResumeAngle: "Use verified resume evidence.",
    suggestedCoverLetterAngle: "Use verified career history."
  } as JobPosting;
  let scoringUpdates = 0;
  stub(t, provider, "searchJobs", async () => [rawJob]);
  stub(t, prisma.jobPosting, "upsert", async () => row);
  stub(t, prisma.jobPosting, "update", async () => { scoringUpdates++; return row; });

  const result = await importJobsFromSource({ userId: "user-1", source, criteria: {}, profile: null });

  assert.equal(result.imported.length, 1);
  assert.equal(scoringUpdates, 0);
  assert.equal(result.imported[0].overallFitScore, 91);
  assert.equal(result.imported[0].confidenceScore, 88);
  assert.deepEqual(result.imported[0].supportedKeywords, ["Verified skill"]);
  assert.equal(result.imported[0].suggestedResumeAngle, "Use verified resume evidence.");
  assert.equal(result.imported[0].suggestedCoverLetterAngle, "Use verified career history.");
});

test("null-fit imports rank two eligible jobs by transient relevance", async (t) => {
  const strong = posting("strong", "Solutions Engineer",
    "Partner with customers on technical discovery, demos, API integrations, onboarding, SaaS workflows, and training. Requires React, SQL, and AWS.");
  const weak = posting("weak", "Implementation Specialist",
    "Support customer onboarding, implementation, workflows, and SaaS account setup.");
  const strongScore = scoreJobRelevance({ job: strong.normalized, profile: null }).score;
  const weakScore = scoreJobRelevance({ job: weak.normalized, profile: null }).score;
  assert.ok(weakScore >= 60, "weaker job must compete in candidate sorting");
  assert.ok(strongScore > weakScore);
  const requestedIds: string[] = [];
  stubPersonalizedBoundary(t, requestedIds);

  const ranked = await scoreTopImportedJobs({
    userId: "user-1", jobs: [weak.row, strong.row], profile: null, limit: 2
  });

  assert.deepEqual(requestedIds, ["strong", "weak"]);
  assert.deepEqual(ranked.jobs.map((result) => result.jobId), ["strong", "weak"]);
  assert.deepEqual(ranked.jobs.map((result) => result.deterministicScore), [strongScore, weakScore]);
  assert.ok(ranked.jobs.every((result) => result.aiScore === undefined));
  assert.ok(ranked.jobs.every((result) => /personalized scoring unavailable/.test(result.error ?? "")));
  assert.deepEqual(ranked.summary, {
    eligible: 2,
    attempted: 2,
    cached: 0,
    scored: 0,
    failed: 2,
    stopReason: null
  });

  requestedIds.length = 0;
  const winner = await scoreTopImportedJobs({
    userId: "user-1", jobs: [weak.row, strong.row], profile: null, limit: 1
  });
  assert.deepEqual(requestedIds, ["strong"]);
  assert.deepEqual(winner.jobs.map((result) => result.jobId), ["strong"]);
  assert.equal(winner.jobs[0].deterministicScore, strongScore);
  assert.deepEqual(winner.summary, {
    eligible: 2,
    attempted: 1,
    cached: 0,
    scored: 0,
    failed: 1,
    stopReason: null
  });
});

test("stale stored fit cannot outrank a stronger eligible job", async (t) => {
  const strong = posting("strong", "Solutions Engineer",
    "Partner with customers on technical discovery, demos, API integrations, onboarding, SaaS workflows, and training. Requires React, SQL, and AWS.");
  const weak = posting("weak", "Implementation Specialist",
    "Support customer onboarding, implementation, workflows, and SaaS account setup.", 99);
  const strongScore = scoreJobRelevance({ job: strong.normalized, profile: null }).score;
  const weakScore = scoreJobRelevance({ job: weak.normalized, profile: null }).score;
  assert.ok(weakScore >= 60, "weaker job must compete in candidate sorting");
  assert.ok(strongScore > weakScore);
  const requestedIds: string[] = [];
  stubPersonalizedBoundary(t, requestedIds);

  const ranked = await scoreTopImportedJobs({
    userId: "user-1", jobs: [weak.row, strong.row], profile: null, limit: 2
  });

  assert.deepEqual(requestedIds, ["strong", "weak"]);
  assert.deepEqual(ranked.jobs.map((result) => result.jobId), ["strong", "weak"]);
  assert.deepEqual(ranked.jobs.map((result) => result.deterministicScore), [strongScore, weakScore]);
  assert.notEqual(ranked.jobs[1].deterministicScore, weak.row.overallFitScore);
  assert.ok(ranked.jobs.every((result) => result.aiScore === undefined));
  assert.ok(ranked.jobs.every((result) => /personalized scoring unavailable/.test(result.error ?? "")));

  requestedIds.length = 0;
  const winner = await scoreTopImportedJobs({
    userId: "user-1", jobs: [weak.row, strong.row], profile: null, limit: 1
  });
  assert.deepEqual(requestedIds, ["strong"]);
  assert.deepEqual(winner.jobs.map((result) => result.jobId), ["strong"]);
  assert.equal(winner.jobs[0].deterministicScore, strongScore);
});

test("discovery scoring caps an eligible cross-source batch and reports cached successes", async () => {
  const jobs = Array.from({ length: 7 }, (_, index) => posting(
    `job-${index + 1}`,
    `Solutions Engineer ${index + 1}`,
    "Partner with customers on technical discovery, API integrations, onboarding, SaaS workflows, and training."
  ).row);
  const calls: Array<{ jobId: string; automation?: boolean }> = [];

  const result = await scoreTopImportedJobs({
    userId: "user-1",
    jobs,
    profile: null,
    limit: 5,
    jobMatchRunner: async (_userId, jobId, options) => {
      calls.push({ jobId, automation: options?.automation });
      return {
        job: { ...jobs.find((job) => job.id === jobId)!, overallFitScore: 86 },
        match: {},
        cached: jobId === "job-2"
      };
    }
  });

  assert.equal(calls.length, 5);
  assert.ok(calls.every((call) => call.automation === true));
  assert.equal(result.jobs.length, 5);
  assert.deepEqual(result.summary, {
    eligible: 7,
    attempted: 5,
    cached: 1,
    scored: 5,
    failed: 0,
    stopReason: null
  });
});

test("discovery scoring reports a per-job failure and continues to the next candidate", async () => {
  const jobs = [
    posting("job-1", "Solutions Engineer", "Customer discovery, API integrations, SaaS onboarding, and training.").row,
    posting("job-2", "Implementation Engineer", "Customer implementation, technical workflows, API integrations, and SaaS onboarding.").row
  ];
  const attempted: string[] = [];

  const result = await scoreTopImportedJobs({
    userId: "user-1",
    jobs,
    profile: null,
    limit: 5,
    jobMatchRunner: async (_userId, jobId) => {
      attempted.push(jobId);
      if (attempted.length === 1) throw new Error("synthetic provider rejection");
      return { job: { ...jobs[1], overallFitScore: 82 }, match: {}, cached: false };
    }
  });

  assert.deepEqual(attempted, [result.jobs[0].jobId, result.jobs[1].jobId]);
  assert.deepEqual(result.summary, {
    eligible: 2,
    attempted: 2,
    cached: 0,
    scored: 1,
    failed: 1,
    stopReason: null
  });
});

test("discovery scoring stops later candidates after a systemic budget failure", async () => {
  const jobs = Array.from({ length: 4 }, (_, index) => posting(
    `job-${index + 1}`,
    `Solutions Engineer ${index + 1}`,
    "Customer discovery, API integrations, SaaS onboarding, and training."
  ).row);
  const attempted: string[] = [];

  const result = await scoreTopImportedJobs({
    userId: "user-1",
    jobs,
    profile: null,
    limit: 4,
    jobMatchRunner: async (_userId, jobId) => {
      attempted.push(jobId);
      throw new PublicApiError("Synthetic automation allowance exhausted.", 429, {
        code: "AI_BUDGET_EXCEEDED"
      });
    }
  });

  assert.equal(attempted.length, 1);
  assert.equal(result.jobs.length, 1);
  assert.deepEqual(result.summary, {
    eligible: 4,
    attempted: 1,
    cached: 0,
    scored: 0,
    failed: 1,
    stopReason: "AI_BUDGET_EXCEEDED"
  });
});

test("discovery scoring stops later candidates after a systemic configuration failure", async () => {
  const jobs = Array.from({ length: 3 }, (_, index) => posting(
    `job-${index + 1}`,
    `Solutions Engineer ${index + 1}`,
    "Customer discovery, API integrations, SaaS onboarding, and training."
  ).row);
  let attempts = 0;

  const result = await scoreTopImportedJobs({
    userId: "user-1",
    jobs,
    profile: null,
    limit: 3,
    jobMatchRunner: async () => {
      attempts += 1;
      throw new PublicApiError("Synthetic pricing configuration failure.", 503, {
        code: "AI_MODEL_PRICING_UNKNOWN"
      });
    }
  });

  assert.equal(attempts, 1);
  assert.deepEqual(result.summary, {
    eligible: 3,
    attempted: 1,
    cached: 0,
    scored: 0,
    failed: 1,
    stopReason: "AI_CONFIGURATION_INVALID"
  });
});

test("disabled discovery scoring reports eligible jobs and makes zero model attempts", async () => {
  const jobs = Array.from({ length: 3 }, (_, index) => posting(
    `job-${index + 1}`,
    `Solutions Engineer ${index + 1}`,
    "Customer discovery, API integrations, SaaS onboarding, and training."
  ).row);
  let attempts = 0;

  const result = await scoreTopImportedJobs({
    userId: "user-1",
    jobs,
    profile: null,
    limit: 5,
    enabled: false,
    disabledReason: "DISABLED_BY_POLICY",
    jobMatchRunner: async () => {
      attempts += 1;
      throw new Error("must not run");
    }
  });

  assert.equal(attempts, 0);
  assert.deepEqual(result, {
    jobs: [],
    summary: {
      eligible: 3,
      attempted: 0,
      cached: 0,
      scored: 0,
      failed: 0,
      stopReason: "DISABLED_BY_POLICY"
    }
  });
});
