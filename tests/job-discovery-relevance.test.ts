import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { JobPosting, JobSource } from "@prisma/client";

import { getJobSourceProvider } from "@/lib/job-sources";
import { importJobsFromSource, scoreTopImportedJobs } from "@/lib/job-sources/discovery";
import { scoreJobRelevance } from "@/lib/job-sources/relevance";
import type { NormalizedJob } from "@/lib/job-sources/types";
import { prisma } from "@/lib/prisma";

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
  assert.deepEqual(ranked.map((result) => result.jobId), ["strong", "weak"]);
  assert.deepEqual(ranked.map((result) => result.deterministicScore), [strongScore, weakScore]);
  assert.ok(ranked.every((result) => result.aiScore === undefined));
  assert.ok(ranked.every((result) => /personalized scoring unavailable/.test(result.error ?? "")));

  requestedIds.length = 0;
  const winner = await scoreTopImportedJobs({
    userId: "user-1", jobs: [weak.row, strong.row], profile: null, limit: 1
  });
  assert.deepEqual(requestedIds, ["strong"]);
  assert.deepEqual(winner.map((result) => result.jobId), ["strong"]);
  assert.equal(winner[0].deterministicScore, strongScore);
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
  assert.deepEqual(ranked.map((result) => result.jobId), ["strong", "weak"]);
  assert.deepEqual(ranked.map((result) => result.deterministicScore), [strongScore, weakScore]);
  assert.notEqual(ranked[1].deterministicScore, weak.row.overallFitScore);
  assert.ok(ranked.every((result) => result.aiScore === undefined));
  assert.ok(ranked.every((result) => /personalized scoring unavailable/.test(result.error ?? "")));

  requestedIds.length = 0;
  const winner = await scoreTopImportedJobs({
    userId: "user-1", jobs: [weak.row, strong.row], profile: null, limit: 1
  });
  assert.deepEqual(requestedIds, ["strong"]);
  assert.deepEqual(winner.map((result) => result.jobId), ["strong"]);
  assert.equal(winner[0].deterministicScore, strongScore);
});
