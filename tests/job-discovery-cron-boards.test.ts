import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { AISettings, JobSource } from "@prisma/client";
import { NextRequest } from "next/server";

import { getJobSourceProvider } from "@/lib/job-sources";
import {
  directoryBoardKey,
  directoryPreferencesFrom,
  loadJobBoardDirectory,
  matchDirectoryBoards
} from "@/lib/job-sources/board-directory";
import type { JobSearchCriteria } from "@/lib/job-sources/types";
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

function followed(userId: string): JobSource {
  return {
    id: `followed-${userId}`,
    userId,
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
  };
}

function preference(userId: string, email: string, industries = ["Synthetic test industry"]) {
  return {
    id: `preference-${userId}`,
    userId,
    targetSearches: ["Solutions Engineer"],
    location: "",
    limitPerQuery: 8,
    remoteOnly: false,
    scoreImported: false,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    // An industry no directory board carries, so only the followed board is synced.
    user: {
      id: userId,
      email,
      profile: {
        userId,
        industriesOfInterest: industries,
        preferredLocations: [],
        location: "",
        remotePreference: "FLEXIBLE",
        preferredRoles: [],
        skillsToEmphasize: [],
        dealBreakers: [],
        salaryTargetMin: null,
        salaryTargetMax: null
      }
    }
  };
}

function forbidNetwork(t: TestContext) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    throw new Error(`Unexpected network request in test: ${String(input)}`);
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = original; });
}

type SetupOptions = {
  industries?: string[];
  perSourceRows?: JobSource[];
  onGreenhouseFetch?: () => void;
};

function setup(t: TestContext, options: SetupOptions = {}) {
  setEnv(t, {
    CRON_SECRET: "synthetic-cron-secret",
    AUTH_ALLOWED_EMAILS: "owner@example.test,second@example.test",
    AUTH_ALLOW_PUBLIC_SIGNUPS: "false",
    AI_ENABLED: "false",
    AI_MOCK_MODE: "false",
    GEMINI_API_KEY: undefined,
    OPENAI_API_KEY: undefined,
    JOB_SOURCE_REMOTIVE_ENABLED: undefined,
    JOB_SOURCE_ADZUNA_ENABLED: undefined,
    LOG_LEVEL: "error"
  });
  forbidNetwork(t);
  const fetches: JobSearchCriteria[] = [];
  const preferenceQueries: Array<Record<string, unknown>> = [];
  const perSourceQueries: Array<Record<string, unknown>> = [];
  const upserts: Array<{ create: Record<string, unknown> }> = [];
  const audits: Array<{ data: { userId: string; action: string; metadata?: Record<string, unknown> } }> = [];
  const boardFetchKeys: string[] = [];
  const preferenceTouches: string[] = [];
  let aggregatorCalls = 0;

  stub(t, getJobSourceProvider("GREENHOUSE"), "searchJobs", async (criteria: JobSearchCriteria) => {
    fetches.push(criteria);
    boardFetchKeys.push(`GREENHOUSE:${criteria.boardToken}`);
    options.onGreenhouseFetch?.();
    if (criteria.boardToken !== "acme") {
      return [];
    }
    return [{
      id: 1,
      title: "Solutions Engineer",
      absolute_url: "https://boards.greenhouse.io/acme/jobs/1",
      location: { name: "Remote" },
      content: "Partner with customers on technical discovery, API integrations, SaaS onboarding, workflows, and training."
    }];
  });
  for (const type of ["LEVER", "ASHBY"] as const) {
    stub(t, getJobSourceProvider(type), "searchJobs", async (criteria: JobSearchCriteria) => {
      boardFetchKeys.push(`${type}:${criteria.boardToken}`);
      return [];
    });
  }
  for (const type of ["REMOTIVE", "ADZUNA", "THEIRSTACK", "SERPAPI", "USAJOBS"] as const) {
    stub(t, getJobSourceProvider(type), "searchJobs", async () => { aggregatorCalls += 1; return []; });
  }
  stub(t, prisma.jobDiscoveryPreference, "findMany", async (args: { where: Record<string, unknown> }) => {
    preferenceQueries.push(args.where);
    return [
      preference("user-1", "owner@example.test", options.industries),
      preference("user-2", "second@example.test", options.industries)
    ];
  });
  stub(t, prisma.jobDiscoveryPreference, "update", async ({ where }: { where: { userId: string } }) => {
    preferenceTouches.push(where.userId);
    return {};
  });
  stub(t, prisma.jobSource, "findMany", async (args: { where: Record<string, unknown> }) => {
    const userId = args.where.userId as string | undefined;
    if (userId) {
      return [followed(userId)];
    }
    perSourceQueries.push(args.where);
    return options.perSourceRows ?? [];
  });
  stub(t, prisma.jobSource, "findFirst", async () => null);
  stub(t, prisma.jobSource, "create", async ({ data }: { data: Partial<JobSource> }) => ({
    ...followed(data.userId ?? "user"),
    ...data,
    id: `directory-${data.userId}-${data.type}`,
    boardToken: null
  }));
  stub(t, prisma.jobSource, "updateMany", async () => ({ count: 1 }));
  stub(t, prisma.jobSource, "update", async ({ where }: { where: { id: string } }) => ({ id: where.id }));
  stub(t, prisma.jobPosting, "findMany", async () => []);
  stub(t, prisma.jobPosting, "upsert", async (args: { create: Record<string, unknown> }) => {
    upserts.push(args);
    return { ...args.create, id: `posting-${upserts.length}`, overallFitScore: null };
  });
  stub(t, prisma.jobPosting, "updateMany", async () => ({ count: 0 }));
  stub(t, prisma.aISettings, "upsert", async () => ({
    id: "settings", userId: "user", monthlyBudgetCents: 500, automationBudgetCents: 150, maxAnalysesPerSync: 5,
    aiDiscoveryEnabled: true, modelOverride: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"), updatedAt: new Date("2026-01-01T00:00:00.000Z")
  } satisfies AISettings));
  stub(t, prisma.auditLog, "create", async (args: { data: { userId: string; action: string } }) => {
    audits.push(args);
    return { id: `audit-${audits.length}` };
  });

  return {
    fetches,
    preferenceQueries,
    perSourceQueries,
    upserts,
    audits,
    boardFetchKeys,
    preferenceTouches,
    get aggregatorCalls() { return aggregatorCalls; }
  };
}

async function runCron() {
  const { GET } = await import("@/app/api/cron/job-discovery/route");
  return GET(new NextRequest("http://localhost/api/cron/job-discovery", {
    headers: { authorization: "Bearer synthetic-cron-secret" }
  }));
}

test("the cron runs preference discovery over boards for each allowed user, sharing one fetch per board", async (t) => {
  const state = setup(t);
  setEnv(t, { NODE_ENV: "production" });

  const response = await runCron();
  const result = await response.json();

  assert.equal(response.status, 200);
  assert.equal(result.ok, true);
  assert.deepEqual(state.preferenceQueries[0], { user: { email: { in: ["owner@example.test", "second@example.test"] } } });
  assert.equal(state.fetches.length, 1, "two users following the same board share one fetch");
  assert.equal(state.aggregatorCalls, 0, "the cron never calls query aggregators");
  assert.deepEqual(
    state.upserts.map((upsert) => upsert.create.userId).sort(),
    ["user-1", "user-2"],
    "each user gets their own posting"
  );
  assert.equal(result.preferenceUsers, 2);
  assert.equal(result.imported, 2);
  assert.deepEqual(result.preferenceResults.map((entry: { userId: string; status: string }) => [entry.userId, entry.status]), [
    ["user-1", "success"],
    ["user-2", "success"]
  ]);
  assert.deepEqual(
    state.audits.map((audit) => [audit.data.userId, audit.data.action]),
    [["user-1", "job.discovery.cron.preferences"], ["user-2", "job.discovery.cron.preferences"]]
  );
});

test("the cron's per-source phase skips manual and compliance-gated source types", async (t) => {
  const state = setup(t);

  await runCron();

  assert.equal(state.perSourceQueries.length, 1);
  const typeFilter = state.perSourceQueries[0].type as { notIn: string[] };
  assert.deepEqual([...typeFilter.notIn].sort(), ["ADZUNA", "MANUAL", "REMOTIVE"]);
});

test("a user removed from the allowlist is skipped by the preference phase", async (t) => {
  const state = setup(t);
  process.env.AUTH_ALLOWED_EMAILS = "owner@example.test";

  const response = await runCron();
  const result = await response.json();

  assert.deepEqual(result.preferenceResults.map((entry: { userId: string; status: string }) => [entry.userId, entry.status]), [
    ["user-1", "success"],
    ["user-2", "skipped"]
  ]);
  assert.deepEqual(state.upserts.map((upsert) => upsert.create.userId), ["user-1"]);
});

test("the cron route declares a 300 second maxDuration", async () => {
  const route = await import("@/app/api/cron/job-discovery/route");

  assert.equal(route.maxDuration, 300);
});

test("directory boards are fetched once per cron run and shared by every user", async (t) => {
  const industries = ["Healthcare"];
  const expectedDirectoryBoards = matchDirectoryBoards(
    loadJobBoardDirectory(),
    directoryPreferencesFrom({
      profile: { industriesOfInterest: industries, preferredLocations: [], location: "", remotePreference: "FLEXIBLE" },
      location: "",
      remoteOnly: false
    })
  ).map((match) => directoryBoardKey(match.entry));
  assert.ok(expectedDirectoryBoards.length >= 3, "the reviewed directory has several healthcare boards");
  const state = setup(t, { industries });

  const response = await runCron();
  const result = await response.json();

  assert.equal(result.preferenceResults.filter((entry: { status: string }) => entry.status === "success").length, 2);
  assert.equal(state.boardFetchKeys.length, new Set(state.boardFetchKeys).size, "no board is fetched twice in one run");
  assert.deepEqual(
    [...new Set(state.boardFetchKeys.map((key) => key.toLowerCase()))].sort(),
    ["greenhouse:acme", ...expectedDirectoryBoards.map((key) => key.toLowerCase())].sort()
  );
});

test("the cron stops scheduling users, boards and sources at 80% of maxDuration and reports the deferral", async (t) => {
  let clock = Date.parse("2026-11-04T14:00:00.000Z");
  t.mock.method(Date, "now", () => clock);
  const perSource = { ...followed("user-1"), id: "per-source-1", name: "Workable source", type: "WORKABLE" } as JobSource;
  const state = setup(t, {
    perSourceRows: [{ ...perSource, user: { email: "owner@example.test", profile: null } } as JobSource],
    // The first board takes longer than the time budget.
    onGreenhouseFetch: () => { clock += 250_000; }
  });

  const response = await runCron();
  const result = await response.json();

  assert.equal(response.status, 200);
  assert.equal(result.ok, true, "a deferral is not a failure");
  assert.deepEqual(
    result.preferenceResults.map((entry: { userId: string; status: string }) => [entry.userId, entry.status]),
    [["user-1", "success"], ["user-2", "deferred"]]
  );
  assert.match(result.preferenceResults[1].error, /time budget/i);
  assert.deepEqual(result.results.map((entry: { sourceId: string; status: string }) => [entry.sourceId, entry.status]), [
    ["per-source-1", "deferred"]
  ]);
  assert.deepEqual(result.timeBudget, {
    maxDurationSeconds: 300,
    budgetSeconds: 240,
    exhausted: true,
    deferredUsers: 1,
    deferredBoards: 0,
    deferredSources: 1
  });
  assert.deepEqual(state.preferenceTouches, ["user-1"], "only users that ran move to the back of the queue");
  assert.equal(state.fetches.length, 1);
});
