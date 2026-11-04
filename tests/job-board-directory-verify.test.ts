import assert from "node:assert/strict";
import { test } from "node:test";

import { summarizeBoardListing, verifyBoard } from "@/lib/job-sources/board-directory-verify";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

test("verification makes exactly one GET to the provider's own board endpoint with no extra headers", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const result = await verifyBoard({ ats: "GREENHOUSE", token: "example" }, {
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      return jsonResponse({ jobs: [{ id: 1, title: "Engineer", location: { name: "Remote - US" } }] });
    }
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://boards-api.greenhouse.io/v1/boards/example/jobs?content=true");
  assert.equal(calls[0].init?.method ?? "GET", "GET");
  assert.equal(new Headers(calls[0].init?.headers).has("user-agent"), false, "uses the same default User-Agent as the fetchers");
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.jobCount, 1);
  assert.equal(result.ok && result.remote, true);
});

test("verification fails on HTTP errors, unexpected shapes, empty boards and network errors", async () => {
  const notFound = await verifyBoard({ ats: "LEVER", token: "missing" }, { fetchImpl: async () => jsonResponse({ ok: false }, 404) });
  assert.deepEqual(notFound, { ok: false, status: 404, error: "HTTP 404" });

  const wrongShape = await verifyBoard({ ats: "LEVER", token: "odd" }, { fetchImpl: async () => jsonResponse({ jobs: [] }) });
  assert.equal(wrongShape.ok, false);

  const empty = await verifyBoard({ ats: "ASHBY", token: "empty" }, { fetchImpl: async () => jsonResponse({ jobs: [] }) });
  assert.equal(empty.ok, false);
  assert.match(empty.ok ? "" : empty.error, /no listed jobs/i);

  const offline = await verifyBoard({ ats: "ASHBY", token: "offline" }, {
    fetchImpl: async () => { throw new Error("getaddrinfo ENOTFOUND"); }
  });
  assert.equal(offline.ok, false);
  assert.match(offline.ok ? "" : offline.error, /ENOTFOUND/);
});

test("listing summaries count only listed Ashby jobs and rank the most common locations", () => {
  const ashby = summarizeBoardListing("ASHBY", {
    jobs: [
      { title: "A", location: "San Francisco", isRemote: false, isListed: true },
      { title: "B", location: "San Francisco", secondaryLocations: [{ location: "New York" }], isListed: true },
      { title: "C", location: "Remote", isRemote: true, isListed: false }
    ]
  });
  assert.deepEqual(ashby, { jobCount: 2, locations: ["San Francisco", "New York"], remote: false });

  const lever = summarizeBoardListing("LEVER", [
    { text: "A", categories: { location: "Toronto", allLocations: ["Toronto", "Remote - Canada"] }, workplaceType: "remote" },
    { text: "B", categories: { location: "Toronto" }, workplaceType: "onsite" }
  ]);
  assert.deepEqual(lever, { jobCount: 2, locations: ["Toronto", "Remote - Canada"], remote: true });

  const greenhouse = summarizeBoardListing("GREENHOUSE", {
    jobs: [
      { title: "A", location: { name: "Seattle, WA; Remote - US" } },
      { title: "B", location: { name: "Seattle, WA" } }
    ]
  });
  assert.deepEqual(greenhouse, { jobCount: 2, locations: ["Seattle, WA", "Remote - US"], remote: true });

  assert.equal(summarizeBoardListing("GREENHOUSE", [{ title: "not wrapped" }]), null);
  assert.equal(summarizeBoardListing("LEVER", { jobs: [] }), null);
  assert.equal(summarizeBoardListing("ASHBY", null), null);
});
