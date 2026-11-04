import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { JobSource, UserProfile } from "@prisma/client";

import { getJobSourceProvider } from "@/lib/job-sources";
import { directorySourceNames, runBoardDiscovery } from "@/lib/job-sources/board-discovery";
import type { JobBoardDirectoryEntry } from "@/lib/job-sources/board-directory";
import { createBoardListingCache } from "@/lib/job-sources/board-sync";
import { createRunDedupeIndex } from "@/lib/job-sources/ingestion";
import type { JobSearchCriteria } from "@/lib/job-sources/types";
import { prisma } from "@/lib/prisma";

function stub(t: TestContext, owner: object, name: string, replacement: unknown) {
  const methods = owner as Record<string, unknown>;
  const original = methods[name];
  methods[name] = replacement;
  t.after(() => { methods[name] = original; });
}

const profile = {
  userId: "user-1",
  industriesOfInterest: ["SaaS"],
  preferredLocations: ["Remote"],
  location: "",
  remotePreference: "FLEXIBLE",
  preferredRoles: [],
  skillsToEmphasize: [],
  dealBreakers: [],
  salaryTargetMin: null,
  salaryTargetMax: null
} as unknown as UserProfile;

function sourceRow(overrides: Partial<JobSource>): JobSource {
  return {
    id: "source",
    userId: "user-1",
    name: "Source",
    type: "GREENHOUSE",
    baseUrl: null,
    boardToken: null,
    allowlisted: true,
    robotsChecked: true,
    lastSyncedAt: null,
    lastSyncStatus: null,
    lastSyncError: null,
    syncEnabled: true,
    notes: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides
  };
}

function entry(overrides: Partial<JobBoardDirectoryEntry>): JobBoardDirectoryEntry {
  return {
    company: "Company",
    ats: "GREENHOUSE",
    token: "company",
    industries: ["Hardware"],
    locations: ["Austin, TX"],
    remote: false,
    verifiedAt: "2026-11-03T18:00:00.000Z",
    ...overrides
  };
}

const goodGreenhouseJob = (token: string) => ({
  id: 1,
  title: "Solutions Engineer",
  absolute_url: `https://boards.greenhouse.io/${token}/jobs/1`,
  location: { name: "Remote" },
  content: "Partner with customers on technical discovery, API integrations, SaaS onboarding, workflows, and training."
});
const seniorGreenhouseJob = (token: string) => ({
  id: 2,
  title: "Director of Finance",
  absolute_url: `https://boards.greenhouse.io/${token}/jobs/2`,
  location: { name: "Remote" },
  content: "Lead finance."
});
const goodAshbyJob = (token: string) => ({
  title: "Solutions Engineer",
  location: "Remote",
  isRemote: true,
  isListed: true,
  jobUrl: `https://jobs.ashbyhq.com/${token}/abc`,
  applyUrl: `https://jobs.ashbyhq.com/${token}/abc/application`,
  descriptionPlain: "Partner with customers on technical discovery, API integrations, SaaS onboarding, workflows, and training."
});

function setup(t: TestContext, rows: JobSource[], options: { failToken?: string } = {}) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    throw new Error(`Unexpected network request in test: ${String(input)}`);
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const fetches: Array<{ type: string; criteria: JobSearchCriteria }> = [];
  const created: JobSource[] = [];
  const sourceUpdates: Array<{ where: { id: string }; data: Record<string, unknown> }> = [];
  const upserts: Array<{ create: Record<string, unknown> }> = [];
  const closures: Array<{ where: Record<string, unknown> }> = [];

  for (const type of ["GREENHOUSE", "LEVER", "ASHBY"] as const) {
    stub(t, getJobSourceProvider(type), "searchJobs", async (criteria: JobSearchCriteria) => {
      fetches.push({ type, criteria });
      if (criteria.boardToken === options.failToken) {
        throw new Error("Greenhouse returned 503.");
      }
      if (type === "ASHBY") {
        return [goodAshbyJob(criteria.boardToken ?? "")];
      }
      return [goodGreenhouseJob(criteria.boardToken ?? ""), seniorGreenhouseJob(criteria.boardToken ?? "")];
    });
  }
  stub(t, prisma.jobSource, "findMany", async ({ where }: { where: { userId: string } }) => {
    assert.equal(where.userId, "user-1");
    return [...rows, ...created];
  });
  stub(t, prisma.jobSource, "findFirst", async ({ where }: { where: { userId: string; type: string; name: string } }) => {
    assert.equal(where.userId, "user-1");
    return created.find((row) => row.type === where.type && row.name === where.name) ?? null;
  });
  stub(t, prisma.jobSource, "create", async ({ data }: { data: Partial<JobSource> }) => {
    const row = sourceRow({ ...data, id: `aggregate-${data.type}` });
    created.push(row);
    return row;
  });
  stub(t, prisma.jobSource, "update", async (args: { where: { id: string }; data: Record<string, unknown> }) => {
    sourceUpdates.push(args);
    return rows.find((row) => row.id === args.where.id);
  });
  stub(t, prisma.jobPosting, "findMany", async ({ where }: { where: { userId: string } }) => {
    assert.equal(where.userId, "user-1");
    return [];
  });
  stub(t, prisma.jobPosting, "upsert", async (args: { create: Record<string, unknown> }) => {
    upserts.push(args);
    return { ...args.create, id: `posting-${upserts.length}` };
  });
  stub(t, prisma.jobPosting, "updateMany", async (args: { where: Record<string, unknown> }) => {
    closures.push(args);
    return { count: 0 };
  });

  return { fetches, created, sourceUpdates, upserts, closures };
}

const directory = [
  entry({ company: "Acme", token: "acme", industries: ["SaaS"] }),
  entry({ company: "Opted Out", ats: "LEVER", token: "optedout", industries: ["SaaS"] }),
  entry({ company: "SaaS Co", token: "saasco", industries: ["SaaS"] }),
  entry({ company: "Remote AI", ats: "ASHBY", token: "remoteai", industries: ["AI"], remote: true }),
  entry({ company: "Unrelated", token: "unrelated", industries: ["Hardware"] })
];

test("board discovery syncs followed boards first, then matching directory boards, within the cap", async (t) => {
  const followed = sourceRow({ id: "followed-acme", name: "Acme", boardToken: "acme", baseUrl: "https://boards.greenhouse.io/acme" });
  const optedOut = sourceRow({ id: "optout", name: "Opted Out", type: "LEVER", boardToken: "optedout", syncEnabled: false });
  const db = setup(t, [followed, optedOut]);
  const now = new Date("2026-11-03T12:00:00.000Z");

  const result = await runBoardDiscovery({
    userId: "user-1",
    profile,
    queries: ["Solutions Engineer"],
    location: "",
    remoteOnly: false,
    limitPerBoard: 5,
    maxBoards: 3,
    index: createRunDedupeIndex(),
    directory,
    now
  });

  assert.deepEqual(
    db.fetches.map((fetch) => `${fetch.type}:${fetch.criteria.boardToken}`).sort(),
    ["ASHBY:remoteai", "GREENHOUSE:acme", "GREENHOUSE:saasco"],
    "followed acme once (not again from the directory), never the opted-out or unmatched boards"
  );
  assert.ok(db.fetches.every((fetch) => fetch.criteria.limit === Number.POSITIVE_INFINITY), "full listings are fetched");
  assert.equal(db.fetches.find((fetch) => fetch.criteria.boardToken === "acme")?.criteria.url, "https://boards.greenhouse.io/acme");

  assert.deepEqual(db.created.map((row) => [row.type, row.name, row.syncEnabled, row.userId]).sort(), [
    ["ASHBY", directorySourceNames.ASHBY, false, "user-1"],
    ["GREENHOUSE", directorySourceNames.GREENHOUSE, false, "user-1"]
  ]);

  assert.equal(result.imported.length, 3, "one passing job per board; the director role is filtered out");
  assert.deepEqual(
    db.upserts.map((upsert) => [upsert.create.company, upsert.create.jobSourceId]).sort(),
    [["Acme", "followed-acme"], ["Remote AI", "aggregate-ASHBY"], ["SaaS Co", "aggregate-GREENHOUSE"]]
  );
  assert.ok(db.upserts.every((upsert) => upsert.create.userId === "user-1"));

  assert.deepEqual(db.sourceUpdates, [{
    where: { id: "followed-acme" },
    data: { lastSyncedAt: now, lastSyncStatus: "SUCCESS", lastSyncError: null }
  }]);
  assert.equal(db.closures.length, 3, "each synced board checks for vanished postings");
  assert.ok(db.closures.every((closure) => closure.where.userId === "user-1" && closure.where.status === "ACTIVE"));

  assert.deepEqual(result.boards, { followed: 1, directory: 2, deferred: 0 });
  const acmeReport = result.reports.find((report) => report.name === "Acme (Greenhouse)");
  assert.equal(acmeReport?.status, "imported");
  assert.equal(acmeReport?.imported, 1);
  assert.equal(acmeReport?.skipped, 1);
  assert.match(result.reports.find((report) => report.name === "SaaS Co (Greenhouse)")?.details ?? "", /directory/i);
});

test("boards beyond the cap are deferred and reported", async (t) => {
  const db = setup(t, []);

  const result = await runBoardDiscovery({
    userId: "user-1",
    profile: { ...profile, industriesOfInterest: [], preferredLocations: [] } as UserProfile,
    queries: [],
    location: "",
    remoteOnly: false,
    limitPerBoard: 5,
    maxBoards: 2,
    index: createRunDedupeIndex(),
    directory,
    now: new Date("2026-11-03T12:00:00.000Z")
  });

  assert.equal(db.fetches.length, 2);
  assert.deepEqual(result.boards, { followed: 0, directory: 2, deferred: 3 });
  const deferred = result.reports.find((report) => report.status === "skipped");
  assert.match(deferred?.details ?? "", /3 more boards/);
});

test("a failing board is reported, marks a followed source as errored and does not stop other boards", async (t) => {
  const followed = sourceRow({ id: "followed-acme", name: "Acme", boardToken: "acme" });
  const optedOut = sourceRow({ id: "optout", name: "Opted Out", type: "LEVER", boardToken: "optedout", syncEnabled: false });
  const db = setup(t, [followed, optedOut], { failToken: "acme" });

  const result = await runBoardDiscovery({
    userId: "user-1",
    profile,
    queries: ["Solutions Engineer"],
    location: "",
    remoteOnly: false,
    limitPerBoard: 5,
    maxBoards: 3,
    index: createRunDedupeIndex(),
    directory,
    now: new Date("2026-11-03T12:00:00.000Z")
  });

  const acme = result.reports.find((report) => report.name === "Acme (Greenhouse)");
  assert.equal(acme?.status, "error");
  assert.match(acme?.details ?? "", /503/);
  assert.equal(db.sourceUpdates[0].data.lastSyncStatus, "ERROR");
  assert.equal(result.imported.length, 2, "the two directory boards still import");
  assert.equal(db.closures.length, 2, "a failed fetch never expires postings");
});

test("a shared listing cache fetches each board once across users in one run", async (t) => {
  const db = setup(t, []);
  const listingCache = createBoardListingCache();
  const run = () => runBoardDiscovery({
    userId: "user-1",
    profile,
    queries: [],
    location: "",
    remoteOnly: false,
    limitPerBoard: 5,
    maxBoards: 2,
    index: createRunDedupeIndex(),
    directory: directory.slice(2, 4),
    listingCache,
    now: new Date("2026-11-03T12:00:00.000Z")
  });

  await run();
  await run();

  assert.equal(db.fetches.length, 2);
});
