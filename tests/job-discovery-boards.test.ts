import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { AISettings, JobPosting, JobSource, UserProfile } from "@prisma/client";

import { getJobSourceProvider } from "@/lib/job-sources";
import { runAutomatedJobDiscovery, runScheduledBoardDiscovery } from "@/lib/job-sources/discovery";
import { normalizeText, normalizeUrl } from "@/lib/normalize";
import { prisma } from "@/lib/prisma";

function stub(t: TestContext, owner: object, name: string, replacement: unknown) {
  const methods = owner as Record<string, unknown>;
  const original = methods[name];
  methods[name] = replacement;
  t.after(() => { methods[name] = original; });
}

function setEnv(t: TestContext, changes: Record<string, string | undefined>) {
  for (const [name, value] of Object.entries(changes)) {
    const prior = process.env[name];
    t.after(() => { if (prior === undefined) delete process.env[name]; else process.env[name] = prior; });
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
}

const description = "Partner with customers on technical discovery, API integrations, SaaS onboarding, workflows, and training.";
const rawGreenhouseJob = {
  id: 1,
  title: "Solutions Engineer",
  absolute_url: "https://boards.greenhouse.io/acme/jobs/1",
  location: { name: "Remote" },
  content: description
};

const followedBoard = {
  id: "followed-acme",
  userId: "user-1",
  name: "Acme",
  type: "GREENHOUSE",
  baseUrl: "https://boards.greenhouse.io/acme",
  boardToken: "acme",
  allowlisted: true,
  robotsChecked: true,
  lastSyncedAt: null,
  lastSyncStatus: null,
  lastSyncError: null,
  syncEnabled: true,
  notes: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z")
} as JobSource;

const profile = {
  userId: "user-1",
  industriesOfInterest: [],
  preferredLocations: [],
  location: "",
  remotePreference: "FLEXIBLE",
  preferredRoles: ["Solutions Engineer"],
  skillsToEmphasize: [],
  dealBreakers: [],
  salaryTargetMin: null,
  salaryTargetMax: null
} as unknown as UserProfile;

function setup(t: TestContext, options: { existing?: JobPosting[] } = {}) {
  setEnv(t, {
    AI_ENABLED: "false",
    AI_MOCK_MODE: "false",
    GEMINI_API_KEY: undefined,
    OPENAI_API_KEY: undefined,
    USAJOBS_API_KEY: undefined,
    THEIRSTACK_API_KEY: undefined,
    SERPAPI_API_KEY: undefined,
    ADZUNA_APP_ID: "synthetic-id",
    ADZUNA_APP_KEY: "synthetic-key",
    JOB_SOURCE_REMOTIVE_ENABLED: undefined,
    JOB_SOURCE_ADZUNA_ENABLED: undefined
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    throw new Error(`Unexpected network request in test: ${String(input)}`);
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const calls = { greenhouse: 0, remotive: 0, adzuna: 0 };
  const sourceQueries: Array<Record<string, unknown>> = [];
  const createdSources: Array<Record<string, unknown>> = [];
  const upserts: Array<{ create: Record<string, unknown> }> = [];

  stub(t, getJobSourceProvider("GREENHOUSE"), "searchJobs", async () => {
    calls.greenhouse += 1;
    return [rawGreenhouseJob];
  });
  stub(t, getJobSourceProvider("REMOTIVE"), "searchJobs", async () => {
    calls.remotive += 1;
    return [{ id: 9, url: "https://remotive.example/jobs/9", title: "Solutions Engineer", company_name: "Acme", candidate_required_location: "Remote", description }];
  });
  stub(t, getJobSourceProvider("ADZUNA"), "searchJobs", async () => {
    calls.adzuna += 1;
    return [];
  });
  stub(t, prisma.aISettings, "upsert", async () => ({
    id: "settings-1", userId: "user-1", monthlyBudgetCents: 500, automationBudgetCents: 150, maxAnalysesPerSync: 5,
    aiDiscoveryEnabled: true, modelOverride: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"), updatedAt: new Date("2026-01-01T00:00:00.000Z")
  } satisfies AISettings));
  stub(t, prisma.userProfile, "findUnique", async () => profile);
  stub(t, prisma.jobDiscoveryPreference, "findUnique", async () => null);
  stub(t, prisma.jobSource, "findMany", async (args: { where: Record<string, unknown> }) => {
    sourceQueries.push(args.where);
    assert.equal(args.where.userId, "user-1");
    const types = (args.where.type as { in: string[] }).in;
    return types.includes("GREENHOUSE") ? [followedBoard] : [];
  });
  stub(t, prisma.jobSource, "findFirst", async () => null);
  stub(t, prisma.jobSource, "create", async ({ data }: { data: Record<string, unknown> }) => {
    createdSources.push(data);
    return { ...followedBoard, ...data, id: `created-${createdSources.length}`, boardToken: null };
  });
  stub(t, prisma.jobSource, "update", async () => followedBoard);
  stub(t, prisma.jobPosting, "findMany", async () => options.existing ?? []);
  stub(t, prisma.jobPosting, "upsert", async (args: { create: Record<string, unknown> }) => {
    upserts.push(args);
    return { ...args.create, id: `posting-${upserts.length}`, overallFitScore: null } as unknown as JobPosting;
  });
  stub(t, prisma.jobPosting, "updateMany", async () => ({ count: 0 }));

  return { calls, sourceQueries, createdSources, upserts };
}

test("Remotive and Adzuna are skipped by default with the compliance flag named", async (t) => {
  const state = setup(t);

  const result = await runAutomatedJobDiscovery({ userId: "user-1", queries: ["Solutions Engineer"], boardDirectory: [] });

  assert.equal(state.calls.remotive, 0);
  assert.equal(state.calls.adzuna, 0, "credentials alone do not enable Adzuna");
  assert.ok(!state.createdSources.some((source) => source.type === "REMOTIVE"), "no Remotive source row is created while gated");
  assert.match(result.reports.find((report) => report.type === "REMOTIVE")?.details ?? "", /JOB_SOURCE_REMOTIVE_ENABLED/);
  assert.match(result.reports.find((report) => report.type === "ADZUNA")?.details ?? "", /JOB_SOURCE_ADZUNA_ENABLED/);
  assert.equal(result.reports.find((report) => report.type === "REMOTIVE")?.status, "skipped");
});

test("followed boards run first and an aggregator copy of the same job is dropped as a duplicate", async (t) => {
  const state = setup(t);
  setEnv(t, { JOB_SOURCE_REMOTIVE_ENABLED: "true" });

  const result = await runAutomatedJobDiscovery({ userId: "user-1", queries: ["Solutions Engineer"], boardDirectory: [] });

  assert.equal(state.calls.greenhouse, 1);
  assert.equal(state.calls.remotive, 1);
  assert.equal(result.imported, 1);
  assert.equal(state.upserts.length, 1);
  assert.equal(state.upserts[0].create.sourceType, "GREENHOUSE", "the employer's own board wins");
  assert.equal(result.reports[0].name, "Acme (Greenhouse)", "boards are reported first");
  assert.equal(result.reports.find((report) => report.type === "REMOTIVE")?.duplicates, 1);
  assert.equal(result.duplicates, 1);
});

test("configured-source sync no longer re-fetches board types that board discovery already covered", async (t) => {
  const state = setup(t);

  await runAutomatedJobDiscovery({ userId: "user-1", queries: ["Solutions Engineer"], boardDirectory: [] });

  const configured = state.sourceQueries.find((where) => !(where.type as { in: string[] }).in.includes("GREENHOUSE"));
  assert.deepEqual((configured?.type as { in: string[] }).in, ["WORKABLE", "RSS", "COMPANY_CAREERS"]);
  assert.equal(state.calls.greenhouse, 1);
});

test("unchanged postings are not rewritten but stay eligible for the unchanged AI scoring cap", async (t) => {
  const normalized = getJobSourceProvider("GREENHOUSE").normalizeJob(rawGreenhouseJob);
  const existing = {
    id: "existing-1",
    userId: "user-1",
    jobSourceId: "followed-acme",
    title: normalized.title,
    normalizedTitle: normalizeText(normalized.title),
    company: "Acme",
    normalizedCompany: "acme",
    location: normalized.location ?? null,
    normalizedLocation: normalizeText(normalized.location),
    remoteStatus: normalized.remoteStatus ?? null,
    salaryMin: null,
    salaryMax: null,
    datePosted: null,
    sourceUrl: normalized.sourceUrl,
    applyUrl: normalized.applyUrl ?? null,
    normalizedApplyUrl: normalizeUrl(normalized.applyUrl),
    description: normalized.description,
    requirements: normalized.requirements,
    preferredQualifications: normalized.preferredQualifications,
    benefits: normalized.benefits,
    detectedTechStack: normalized.detectedTechStack,
    seniorityLevel: null,
    companySize: null,
    sourceType: "GREENHOUSE",
    status: "ACTIVE",
    overallFitScore: null
  } as unknown as JobPosting;
  const state = setup(t, { existing: [existing] });

  const result = await runAutomatedJobDiscovery({ userId: "user-1", queries: ["Solutions Engineer"], boardDirectory: [] });

  assert.equal(state.upserts.length, 0);
  assert.equal(result.imported, 0);
  assert.equal(result.unchanged, 1);
  assert.equal(result.scoring.eligible, 1, "the unchanged posting is still offered to the capped scorer");
  assert.equal(result.scoring.stopReason, "NOT_REQUESTED");
});

test("scheduled board discovery uses the saved preference and never calls query aggregators", async (t) => {
  const state = setup(t);
  setEnv(t, { JOB_SOURCE_REMOTIVE_ENABLED: "true", JOB_SOURCE_ADZUNA_ENABLED: "true" });

  const result = await runScheduledBoardDiscovery({
    userId: "user-1",
    profile,
    preference: { targetSearches: ["Solutions Engineer"], location: "", limitPerQuery: 8, remoteOnly: false, scoreImported: false },
    boardDirectory: []
  });

  assert.equal(state.calls.greenhouse, 1);
  assert.equal(state.calls.remotive, 0);
  assert.equal(state.calls.adzuna, 0);
  assert.equal(result.imported.length, 1);
  assert.deepEqual(result.queries, ["Solutions Engineer"]);
  assert.equal(result.scoring.stopReason, "NOT_REQUESTED");
});
