import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { AISettings, JobPosting, JobSource } from "@prisma/client";

import { getJobSourceProvider } from "@/lib/job-sources";
import { runJobSourceSync } from "@/lib/job-sources/source-management";
import { prisma } from "@/lib/prisma";

function stub(t: TestContext, owner: object, name: string, replacement: unknown) {
  const methods = owner as Record<string, unknown>;
  const original = methods[name];
  methods[name] = replacement;
  t.after(() => { methods[name] = original; });
}

function configureLocalAiUnavailable(t: TestContext) {
  const changes: Record<string, string | undefined> = {
    AI_ENABLED: "false",
    AI_MOCK_MODE: "false",
    OPENAI_API_KEY: undefined,
    GEMINI_API_KEY: undefined
  };
  for (const [name, value] of Object.entries(changes)) {
    const prior = process.env[name];
    t.after(() => { if (prior === undefined) delete process.env[name]; else process.env[name] = prior; });
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
}

const source = {
  id: "source-1",
  userId: "user-1",
  name: "Synthetic Greenhouse",
  type: "GREENHOUSE",
  baseUrl: null,
  boardToken: "synthetic",
  allowlisted: false,
  robotsChecked: false,
  lastSyncedAt: null,
  lastSyncStatus: null,
  lastSyncError: null,
  syncEnabled: true,
  notes: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z")
} as JobSource;

const rawJob = {
  id: 1,
  title: "Solutions Engineer",
  absolute_url: "https://boards.greenhouse.io/synthetic/jobs/1",
  location: { name: "Remote" },
  content: "Partner with customers on technical discovery, API integrations, SaaS onboarding, workflows, and training."
};

const job = {
  id: "job-1",
  userId: "user-1",
  jobSourceId: source.id,
  title: rawJob.title,
  company: source.name,
  location: "Remote",
  remoteStatus: "Remote",
  salaryMin: null,
  salaryMax: null,
  datePosted: null,
  sourceUrl: rawJob.absolute_url,
  applyUrl: rawJob.absolute_url,
  description: rawJob.content,
  requirements: [],
  preferredQualifications: [],
  benefits: [],
  detectedTechStack: [],
  seniorityLevel: null,
  companySize: null,
  overallFitScore: null,
  confidenceScore: null,
  supportedKeywords: [],
  missingKeywords: [],
  concerns: [],
  suggestedResumeAngle: null,
  suggestedCoverLetterAngle: null
} as unknown as JobPosting;

function setup(t: TestContext, aiDiscoveryEnabled: boolean) {
  configureLocalAiUnavailable(t);
  const provider = getJobSourceProvider("GREENHOUSE");
  const sourceUpdates: Array<Record<string, unknown>> = [];
  let matchLoads = 0;
  stub(t, provider, "searchJobs", async () => [rawJob]);
  stub(t, prisma.jobSource, "updateMany", async () => ({ count: 1 }));
  stub(t, prisma.jobSource, "update", async ({ data }: { data: Record<string, unknown> }) => {
    sourceUpdates.push(data);
    return source;
  });
  stub(t, prisma.jobPosting, "upsert", async () => job);
  stub(t, prisma.aISettings, "upsert", async () => ({
    id: "settings-1",
    userId: "user-1",
    monthlyBudgetCents: 500,
    automationBudgetCents: 150,
    maxAnalysesPerSync: 5,
    aiDiscoveryEnabled,
    modelOverride: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z")
  } satisfies AISettings));
  stub(t, prisma.jobPosting, "findFirstOrThrow", async () => { matchLoads += 1; return job; });
  stub(t, prisma.resume, "findFirst", async () => null);
  stub(t, prisma.userProfile, "findUnique", async () => null);
  return { sourceUpdates, get matchLoads() { return matchLoads; } };
}

test("disabled source scoring imports successfully and performs zero match attempts", async (t) => {
  const state = setup(t, false);
  const result = await runJobSourceSync({ userId: "user-1", source, profile: null });

  assert.equal(result.imported.length, 1);
  assert.equal(state.matchLoads, 0);
  assert.deepEqual(result.scoring, {
    eligible: 1,
    attempted: 0,
    cached: 0,
    scored: 0,
    failed: 0,
    stopReason: "DISABLED_BY_POLICY"
  });
  assert.equal(state.sourceUpdates.at(-1)?.lastSyncStatus, "SUCCESS");
});

test("systemic scoring unavailability stops scoring without turning a successful import into a sync error", async (t) => {
  const state = setup(t, true);
  const result = await runJobSourceSync({ userId: "user-1", source, profile: null });

  assert.equal(result.imported.length, 1);
  assert.equal(state.matchLoads, 1);
  assert.equal(result.scoredJobs.length, 1);
  assert.deepEqual(result.scoring, {
    eligible: 1,
    attempted: 1,
    cached: 0,
    scored: 0,
    failed: 1,
    stopReason: "AI_UNAVAILABLE"
  });
  assert.equal(state.sourceUpdates.at(-1)?.lastSyncStatus, "SUCCESS");
  assert.equal(state.sourceUpdates.at(-1)?.lastSyncError, null);
});
