import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";

import { getJobSourceProvider } from "@/lib/job-sources";
import { createBoardListingCache, syncBoard, type BoardListingCache, type BoardTarget } from "@/lib/job-sources/board-sync";
import { createRunDedupeIndex, postingApplyKey } from "@/lib/job-sources/ingestion";
import { prisma } from "@/lib/prisma";

function stub(t: TestContext, owner: object, name: string, replacement: unknown) {
  const methods = owner as Record<string, unknown>;
  const original = methods[name];
  methods[name] = replacement;
  t.after(() => { methods[name] = original; });
}

// A synthetic Ashby posting. Its title fails the import filter, so the sync stores nothing new: the
// flag still applies, because it marks every stored posting the board lists.
const rawAshbyJob = {
  title: "Warehouse Associate",
  location: "Remote",
  isRemote: true,
  jobUrl: "https://jobs.ashbyhq.com/northwindlabs/00000000-0000-4000-8000-000000000001",
  applyUrl: "https://jobs.ashbyhq.com/northwindlabs/00000000-0000-4000-8000-000000000001/application",
  descriptionPlain: "Move boxes.",
  isListed: true
};
const listedKey = postingApplyKey(getJobSourceProvider("ASHBY").normalizeJob(rawAshbyJob));

const ashbyTarget: BoardTarget = {
  ats: "ASHBY",
  token: "northwindlabs",
  company: "Northwind Labs",
  jobSourceId: "board-source-1",
  closureScopes: [{ jobSourceId: "board-source-1" }]
};

function boardPage(off: boolean) {
  const appData = off
    ? { maintenanceMode: false, organization: null, jobBoard: null, posting: null }
    : { maintenanceMode: false, organization: { name: "Northwind Labs" }, jobBoard: { jobPostings: [] }, posting: null };
  return `<html><body><script>window.__appData = ${JSON.stringify(appData)};</script></body></html>`;
}

type UpdateMany = { where: Record<string, unknown>; data: Record<string, unknown> };

function harness(t: TestContext, hostedPage: "off" | "served" | "throws") {
  const hostedRequests: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url !== "https://jobs.ashbyhq.com/northwindlabs") throw new Error(`Unexpected network request in test: ${url}`);
    hostedRequests.push(url);
    if (hostedPage === "throws") throw new TypeError("fetch failed");
    return new Response(boardPage(hostedPage === "off"), { status: hostedPage === "off" ? 404 : 200 });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const listings = { ashby: 0, greenhouse: 0 };
  stub(t, getJobSourceProvider("ASHBY"), "searchJobs", async () => {
    listings.ashby += 1;
    return [rawAshbyJob];
  });
  stub(t, getJobSourceProvider("GREENHOUSE"), "searchJobs", async () => {
    listings.greenhouse += 1;
    return [];
  });
  stub(t, prisma.jobPosting, "findMany", async () => []);
  stub(t, prisma.jobPosting, "upsert", async () => {
    throw new Error("nothing should be stored");
  });
  const flagUpdates: UpdateMany[] = [];
  stub(t, prisma.jobPosting, "updateMany", async (args: UpdateMany) => {
    if ("atsApplyPageOffAt" in args.data) flagUpdates.push(args);
    return { count: 0 };
  });
  return { hostedRequests, flagUpdates, listings };
}

function sync(userId: string, target: BoardTarget, now: Date, listingCache: BoardListingCache = createBoardListingCache()) {
  return syncBoard({
    userId,
    target,
    queries: ["Solutions Engineer"],
    profile: null,
    maxImports: 8,
    index: createRunDedupeIndex(),
    listingCache,
    now
  });
}

const now = new Date("2026-11-15T14:00:00.000Z");

test("a switched-off Ashby board marks the user's listed postings that aren't marked yet", async (t) => {
  const run = harness(t, "off");
  await sync("user-1", ashbyTarget, now);

  assert.deepEqual(run.hostedRequests, ["https://jobs.ashbyhq.com/northwindlabs"]);
  assert.equal(run.flagUpdates.length, 1);
  assert.deepEqual(run.flagUpdates[0], {
    where: { userId: "user-1", normalizedApplyUrl: { in: [listedKey] }, atsApplyPageOffAt: null },
    data: { atsApplyPageOffAt: now }
  });
});

test("a served Ashby board clears the mark on the user's listed postings", async (t) => {
  const run = harness(t, "served");
  await sync("user-1", ashbyTarget, now);

  assert.equal(run.flagUpdates.length, 1);
  assert.deepEqual(run.flagUpdates[0], {
    where: { userId: "user-1", normalizedApplyUrl: { in: [listedKey] }, atsApplyPageOffAt: { not: null } },
    data: { atsApplyPageOffAt: null }
  });
});

test("a failed read of the hosted page changes no marks and doesn't fail the sync", async (t) => {
  const run = harness(t, "throws");
  const result = await sync("user-1", ashbyTarget, now);

  assert.equal(result.listed, 1);
  assert.equal(run.hostedRequests.length, 1);
  assert.deepEqual(run.flagUpdates, []);
});

test("two users syncing the same board in one run share one hosted-page read", async (t) => {
  const run = harness(t, "off");
  const cache = createBoardListingCache();
  await sync("user-1", ashbyTarget, now, cache);
  await sync("user-2", ashbyTarget, now, cache);

  assert.equal(run.listings.ashby, 1);
  assert.equal(run.hostedRequests.length, 1);
  assert.deepEqual(run.flagUpdates.map((update) => update.where.userId), ["user-1", "user-2"]);
});

test("a Greenhouse board makes no hosted-page read and changes no marks", async (t) => {
  const run = harness(t, "off");
  await sync("user-1", { ...ashbyTarget, ats: "GREENHOUSE" }, now);

  assert.equal(run.listings.greenhouse, 1);
  assert.deepEqual(run.hostedRequests, []);
  assert.deepEqual(run.flagUpdates, []);
});

test("a board saved as a pasted board link reads the same hosted page", async (t) => {
  const run = harness(t, "off");
  await sync("user-1", { ...ashbyTarget, token: "https://jobs.ashbyhq.com/northwindlabs" }, now);

  assert.deepEqual(run.hostedRequests, ["https://jobs.ashbyhq.com/northwindlabs"]);
  assert.equal(run.flagUpdates.length, 1);
});
