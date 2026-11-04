import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { AshbyProvider } from "@/lib/job-sources/ashby";
import { GreenhouseProvider } from "@/lib/job-sources/greenhouse";
import { LeverProvider } from "@/lib/job-sources/lever";

const fixtureDir = join(process.cwd(), "tests/fixtures/job-boards");

function fixture(name: string) {
  return JSON.parse(readFileSync(join(fixtureDir, name), "utf8")) as unknown;
}

/** Serves fixtures for exact URLs only; any other request fails the test instead of reaching the network. */
function stubFetch(t: TestContext, routes: Record<string, { body: unknown; status?: number }>) {
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    const route = routes[url];
    if (!route) {
      throw new Error(`Unexpected network request in test: ${url}`);
    }
    return new Response(JSON.stringify(route.body), {
      status: route.status ?? 200,
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = original; });
  return calls;
}

const greenhouseUrl = "https://boards-api.greenhouse.io/v1/boards/dropbox/jobs?content=true";
const leverUrl = "https://api.lever.co/v0/postings/zoox?mode=json";
const ashbyUrl = "https://api.ashbyhq.com/posting-api/job-board/modal?includeCompensation=true";

test("Greenhouse fetcher reads the recorded board and honours the limit", async (t) => {
  const calls = stubFetch(t, { [greenhouseUrl]: { body: fixture("greenhouse-board.json") } });
  const provider = new GreenhouseProvider();

  const all = await provider.searchJobs({ boardToken: "dropbox", limit: Number.POSITIVE_INFINITY });
  const limited = await provider.searchJobs({ boardToken: "dropbox", limit: 2 });

  assert.equal(all.length, 3);
  assert.equal(limited.length, 2);
  assert.deepEqual(calls, [greenhouseUrl, greenhouseUrl]);
});

test("Greenhouse normalisation decodes escaped HTML content and keeps the employer apply URL", (t) => {
  stubFetch(t, {});
  const provider = new GreenhouseProvider();
  const [first] = (fixture("greenhouse-board.json") as { jobs: Record<string, unknown>[] }).jobs;
  const job = provider.normalizeJob(first);

  assert.equal(job.title, "Account Executive");
  assert.equal(job.sourceType, "GREENHOUSE");
  assert.equal(job.location, "Remote - US: Select locations");
  assert.equal(job.sourceUrl, "https://jobs.dropbox.com/listing/8159652?gh_jid=8159652");
  assert.equal(job.applyUrl, job.sourceUrl);
  assert.equal(job.datePosted?.toISOString(), "2026-09-01T13:20:17.000Z", "date posted is first_published, not the bulk updated_at");
  assert.match(job.description, /^Role Description As an Account Executive/);
  assert.match(job.description, /Own the full sales cycle/);
  assert.doesNotMatch(job.description, /&lt;|&gt;|&quot;|<h2>|<p>/);
});

test("Lever fetcher reads the recorded board and uses the EU API host for EU boards", async (t) => {
  const euUrl = "https://api.eu.lever.co/v0/postings/zoox?mode=json";
  const calls = stubFetch(t, {
    [leverUrl]: { body: fixture("lever-board.json") },
    [euUrl]: { body: fixture("lever-board.json") }
  });
  const provider = new LeverProvider();

  assert.equal((await provider.searchJobs({ boardToken: "zoox", limit: Number.POSITIVE_INFINITY })).length, 3);
  assert.equal((await provider.searchJobs({ boardToken: "zoox", url: "https://jobs.eu.lever.co/zoox", limit: 1 })).length, 1);
  assert.deepEqual(calls, [leverUrl, euUrl]);
});

test("Lever normalisation maps workplace type, yearly USD salary range and list requirements", (t) => {
  stubFetch(t, {});
  const provider = new LeverProvider();
  const [first, , third] = fixture("lever-board.json") as Record<string, unknown>[];

  const hybrid = provider.normalizeJob(first);
  assert.equal(hybrid.title, "Administrative Business Partner, Floater");
  assert.equal(hybrid.remoteStatus, "Hybrid", "commitment is not a work style");
  assert.equal(hybrid.seniorityLevel, "Full-time");
  assert.equal(hybrid.location, "Foster City, CA");
  assert.equal(hybrid.salaryMin, 123000);
  assert.equal(hybrid.salaryMax, 168000);
  assert.equal(hybrid.sourceUrl, "https://jobs.lever.co/zoox/e8a190f0-7a89-4c11-a6a0-452ff6234749");
  assert.equal(hybrid.applyUrl, "https://jobs.lever.co/zoox/e8a190f0-7a89-4c11-a6a0-452ff6234749/apply");
  assert.equal(hybrid.datePosted?.getTime(), 1791307664932);
  assert.ok(hybrid.requirements.includes("4+ years of executive assistant experience"), hybrid.requirements.join(" | "));
  assert.match(hybrid.description, /Scheduling team and cross-functional meetings/);

  const onsite = provider.normalizeJob(third);
  assert.equal(onsite.remoteStatus, "On-site");
  assert.equal(onsite.salaryMin, undefined);
  assert.ok(onsite.detectedTechStack.includes("SQL"));
  assert.ok(onsite.detectedTechStack.includes("Python"));
});

test("Ashby fetcher reads the recorded board and drops unlisted postings", async (t) => {
  const recorded = fixture("ashby-board.json") as { apiVersion: string; jobs: Record<string, unknown>[] };
  const withUnlisted = {
    ...recorded,
    jobs: [...recorded.jobs, { ...recorded.jobs[0], id: "unlisted-1", title: "Hidden role", isListed: false }]
  };
  const calls = stubFetch(t, { [ashbyUrl]: { body: withUnlisted } });
  const provider = new AshbyProvider();

  const jobs = await provider.searchJobs({ boardToken: "modal", limit: Number.POSITIVE_INFINITY });

  assert.equal(jobs.length, 3);
  assert.ok(jobs.every((job) => job.title !== "Hidden role"));
  assert.deepEqual(calls, [ashbyUrl]);
});

test("Ashby normalisation reads publishedAt, remote flag, secondary locations and yearly USD salary", (t) => {
  stubFetch(t, {});
  const provider = new AshbyProvider();
  const [first, , remote] = (fixture("ashby-board.json") as { jobs: Record<string, unknown>[] }).jobs;

  const onsite = provider.normalizeJob(first);
  assert.equal(onsite.title, "Member of Technical Staff - Systems");
  assert.equal(onsite.datePosted?.toISOString(), "2024-10-23T20:10:46.053Z");
  assert.equal(onsite.location, "New York; San Francisco");
  assert.equal(onsite.remoteStatus, "On-site");
  assert.equal(onsite.salaryMin, 220000);
  assert.equal(onsite.salaryMax, 300000);
  assert.equal(onsite.sourceUrl, "https://jobs.ashbyhq.com/modal/9b33ebe7-e829-4f03-97ba-5c94dbd7daf6");
  assert.equal(onsite.applyUrl, "https://jobs.ashbyhq.com/modal/9b33ebe7-e829-4f03-97ba-5c94dbd7daf6/application");
  assert.deepEqual(onsite.benefits, ["$220K – $300K • Offers Equity"]);
  assert.match(onsite.description, /AI needs a new infrastructure layer/);

  assert.equal(provider.normalizeJob(remote).remoteStatus, "Remote");
});

test("board fetchers refuse invalid tokens and report HTTP failures without retrying", async (t) => {
  const calls = stubFetch(t, {
    "https://boards-api.greenhouse.io/v1/boards/missing/jobs?content=true": { body: { status: 404 }, status: 404 },
    "https://api.lever.co/v0/postings/missing?mode=json": { body: { ok: false }, status: 404 },
    "https://api.ashbyhq.com/posting-api/job-board/missing?includeCompensation=true": { body: {}, status: 500 }
  });

  await assert.rejects(new GreenhouseProvider().searchJobs({ boardToken: "../v1/boards/other" }), /token/i);
  await assert.rejects(new LeverProvider().searchJobs({ boardToken: "a/b" }), /token/i);
  await assert.rejects(new AshbyProvider().searchJobs({ boardToken: "x?y=1" }), /token/i);
  await assert.rejects(new GreenhouseProvider().searchJobs({}), /board token/i);
  assert.equal(calls.length, 0, "invalid tokens never reach the network");

  await assert.rejects(new GreenhouseProvider().searchJobs({ boardToken: "missing" }), /Greenhouse returned 404/);
  await assert.rejects(new LeverProvider().searchJobs({ boardToken: "missing" }), /Lever returned 404/);
  await assert.rejects(new AshbyProvider().searchJobs({ boardToken: "missing" }), /Ashby returned 500/);
  assert.equal(calls.length, 3);
});

test("board fetchers reject a 200 response with an unexpected shape", async (t) => {
  stubFetch(t, {
    "https://boards-api.greenhouse.io/v1/boards/odd/jobs?content=true": { body: [] },
    "https://api.lever.co/v0/postings/odd?mode=json": { body: { jobs: [] } },
    "https://api.ashbyhq.com/posting-api/job-board/odd?includeCompensation=true": { body: { jobs: "none" } }
  });

  await assert.rejects(new GreenhouseProvider().searchJobs({ boardToken: "odd" }), /unexpected/i);
  await assert.rejects(new LeverProvider().searchJobs({ boardToken: "odd" }), /unexpected/i);
  await assert.rejects(new AshbyProvider().searchJobs({ boardToken: "odd" }), /unexpected/i);
});
