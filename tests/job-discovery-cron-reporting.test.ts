import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { AISettings, JobPosting, JobSource } from "@prisma/client";
import { NextRequest } from "next/server";

import { getJobSourceProvider } from "@/lib/job-sources";
import { prisma } from "@/lib/prisma";

function stub(t: TestContext, owner: object, name: string, replacement: unknown) {
  const methods = owner as Record<string, unknown>;
  const original = methods[name];
  methods[name] = replacement;
  t.after(() => { methods[name] = original; });
}

function setEnvironment(t: TestContext) {
  const changes: Record<string, string | undefined> = {
    CRON_SECRET: "synthetic-cron-secret",
    AUTH_ALLOWED_EMAILS: "",
    AUTH_ALLOW_PUBLIC_SIGNUPS: "false",
    AI_ENABLED: "false",
    AI_MOCK_MODE: "false",
    OPENAI_API_KEY: undefined,
    GEMINI_API_KEY: undefined,
    LOG_LEVEL: "error"
  };
  for (const [name, value] of Object.entries(changes)) {
    const prior = process.env[name];
    t.after(() => { if (prior === undefined) delete process.env[name]; else process.env[name] = prior; });
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
}

function source(index: number) {
  return {
    id: `source-${index}`,
    userId: "user-1",
    name: `Synthetic Source ${index}`,
    type: "GREENHOUSE",
    baseUrl: null,
    boardToken: `synthetic-${index}`,
    allowlisted: false,
    robotsChecked: false,
    lastSyncedAt: null,
    lastSyncStatus: null,
    lastSyncError: null,
    syncEnabled: true,
    notes: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    user: { email: "tester@example.test", profile: null }
  } as JobSource & { user: { email: string; profile: null } };
}

const rawJob = {
  id: 1,
  title: "Solutions Engineer",
  absolute_url: "https://boards.greenhouse.io/synthetic/jobs/1",
  location: { name: "Remote" },
  content: "Partner with customers on technical discovery, API integrations, SaaS onboarding, workflows, and training."
};

function posting(jobSourceId: string) {
  return {
    id: `job-${jobSourceId}`,
    userId: "user-1",
    jobSourceId,
    title: rawJob.title,
    company: `Company ${jobSourceId}`,
    location: "Remote",
    remoteStatus: "Remote",
    salaryMin: null,
    salaryMax: null,
    datePosted: null,
    sourceUrl: `${rawJob.absolute_url}-${jobSourceId}`,
    applyUrl: `${rawJob.absolute_url}-${jobSourceId}`,
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
}

test("cron reports five source scoring summaries and propagates a systemic stop without failing imports", async (t) => {
  setEnvironment(t);
  const sources = Array.from({ length: 5 }, (_, index) => source(index + 1));
  const audits: Array<{ data: { metadata?: unknown } }> = [];
  let matchLoads = 0;
  const provider = getJobSourceProvider("GREENHOUSE");

  stub(t, provider, "searchJobs", async () => [rawJob]);
  stub(t, prisma.jobSource, "findMany", async () => sources);
  stub(t, prisma.jobSource, "updateMany", async () => ({ count: 1 }));
  stub(t, prisma.jobSource, "update", async () => sources[0]);
  stub(t, prisma.jobPosting, "upsert", async ({ create }: { create: { jobSourceId: string } }) => posting(create.jobSourceId));
  stub(t, prisma.aISettings, "upsert", async () => ({
    id: "settings-1",
    userId: "user-1",
    monthlyBudgetCents: 500,
    automationBudgetCents: 150,
    maxAnalysesPerSync: 5,
    aiDiscoveryEnabled: true,
    modelOverride: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z")
  } satisfies AISettings));
  stub(t, prisma.jobPosting, "findFirstOrThrow", async () => { matchLoads += 1; return posting("source-1"); });
  stub(t, prisma.resume, "findFirst", async () => null);
  stub(t, prisma.userProfile, "findUnique", async () => null);
  stub(t, prisma.auditLog, "create", async (args: { data: { metadata?: unknown } }) => { audits.push(args); return { id: `audit-${audits.length}` }; });

  const { GET } = await import("@/app/api/cron/job-discovery/route");
  const response = await GET(new NextRequest("http://localhost/api/cron/job-discovery", {
    headers: { authorization: "Bearer synthetic-cron-secret" }
  }));
  const result = await response.json();

  assert.equal(response.status, 200);
  assert.equal(result.ok, true);
  assert.equal(result.sources, 5);
  assert.equal(result.imported, 5);
  assert.equal(result.failed, 0);
  assert.equal(result.results.length, 5);
  assert.equal(matchLoads, 1);
  assert.deepEqual(result.scoring, {
    eligible: 5,
    attempted: 1,
    cached: 0,
    scored: 0,
    failed: 1,
    stopReason: "AI_UNAVAILABLE"
  });
  assert.equal(result.results[0].scoring.attempted, 1);
  assert.ok(result.results.slice(1).every((entry: { scoring: { attempted: number; stopReason: string } }) =>
    entry.scoring.attempted === 0 && entry.scoring.stopReason === "AI_UNAVAILABLE"));
  assert.equal(audits.length, 5);
  assert.ok(audits.every((audit) => Boolean((audit.data.metadata as { scoring?: unknown })?.scoring)));
});
