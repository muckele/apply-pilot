import assert from "node:assert/strict";
import test from "node:test";

import { ashbyHostedSlug, checkAshbyHostedPage, classifyAshbyHostedPage, readAshbyAppData } from "@/lib/job-sources/ashby-hosted-page";

// Synthetic pages shaped like jobs.ashbyhq.com's server-rendered HTML (probed 2026-11-15): the page
// carries its data in `window.__appData = {...};` inside an inline script.
function ashbyPage(appData: Record<string, unknown>) {
  return [
    "<!DOCTYPE html><html><head><title>Jobs</title></head><body><div id=\"root\"></div>",
    "<script nonce=\"synthetic\">",
    `      window.__appData = ${JSON.stringify(appData)};`,
    "      window.__otherData = {\"a\":1};",
    "</script></body></html>"
  ].join("\n");
}

const offData = {
  environment: "production",
  maintenanceMode: false,
  organization: null,
  posting: null,
  jobBoard: null,
  routerPrefix: "/",
  customDomainData: null
};

const servedData = {
  environment: "production",
  maintenanceMode: false,
  organization: { organizationId: "org-synthetic-1", name: "Northwind Labs", hostedJobsPageSlug: "northwindlabs", customJobsPageUrl: null },
  posting: null,
  jobBoard: { teams: [], jobPostings: [{ id: "posting-synthetic-1", title: "Solutions Engineer" }] },
  routerPrefix: "/"
};

test("a switched-off board page (404, no organization, no job board) is off", () => {
  assert.equal(classifyAshbyHostedPage(404, ashbyPage(offData)), "off");
});

test("a working board page (200, organization and job board) is served", () => {
  assert.equal(classifyAshbyHostedPage(200, ashbyPage(servedData)), "served");
});

test("anything that isn't clearly one or the other is unknown", () => {
  assert.equal(classifyAshbyHostedPage(404, "<html><body>Not Found</body></html>"), "unknown", "a 404 with no page data");
  assert.equal(classifyAshbyHostedPage(500, ashbyPage(offData)), "unknown", "a server error");
  assert.equal(classifyAshbyHostedPage(429, ashbyPage(offData)), "unknown", "rate limited");
  assert.equal(classifyAshbyHostedPage(200, ashbyPage(offData)), "unknown", "200 without an organization");
  assert.equal(classifyAshbyHostedPage(404, ashbyPage(servedData)), "unknown", "404 that still names the organization");
  assert.equal(classifyAshbyHostedPage(404, ashbyPage({ ...offData, maintenanceMode: true })), "unknown", "Ashby in maintenance");
  assert.equal(classifyAshbyHostedPage(200, ashbyPage({ ...servedData, jobBoard: null })), "unknown", "organization without a job board");
  assert.equal(classifyAshbyHostedPage(404, "window.__appData = {not json};"), "unknown", "page data that isn't JSON");
});

test("page data with braces, script tags and escaped quotes inside strings still parses", () => {
  const tricky = { ...servedData, organization: { ...servedData.organization, name: "North\"wind }; </script> {Labs}" } };
  const data = readAshbyAppData(ashbyPage(tricky));
  assert.equal((data?.organization as { name: string }).name, "North\"wind }; </script> {Labs}");
  assert.equal(classifyAshbyHostedPage(200, ashbyPage(tricky)), "served");
});

test("a page without page data reads as null", () => {
  assert.equal(readAshbyAppData("<html></html>"), null);
  assert.equal(readAshbyAppData("window.__appData = {\"unterminated\": \"x"), null);
});

type FakeCall = { url: string; init: RequestInit | undefined };

function fakeFetch(status: number, body: string, calls: FakeCall[]) {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });
  }) as typeof fetch;
}

test("the check reads exactly the board's hosted page, once", async () => {
  const calls: FakeCall[] = [];
  assert.equal(await checkAshbyHostedPage("northwindlabs", fakeFetch(404, ashbyPage(offData), calls)), "off");
  assert.deepEqual(calls.map((call) => call.url), ["https://jobs.ashbyhq.com/northwindlabs"]);
  assert.ok(calls[0].init?.signal, "the read has a timeout");
  assert.equal(calls[0].init?.redirect, "manual", "a redirect is never followed off the board page");

  const served: FakeCall[] = [];
  assert.equal(await checkAshbyHostedPage("northwindlabs", fakeFetch(200, ashbyPage(servedData), served)), "served");
});

test("a failed read is unknown and never throws", async () => {
  const failing = (async () => {
    throw new TypeError("fetch failed");
  }) as typeof fetch;
  assert.equal(await checkAshbyHostedPage("northwindlabs", failing), "unknown");
});

test("a token that isn't a plain board name is unknown and makes no request", async () => {
  const calls: FakeCall[] = [];
  assert.equal(await checkAshbyHostedPage("northwind/../api", fakeFetch(404, ashbyPage(offData), calls)), "unknown");
  assert.equal(await checkAshbyHostedPage("", fakeFetch(404, ashbyPage(offData), calls)), "unknown");
  assert.equal(calls.length, 0);
});

test("a redirect away from the board page is unknown", async () => {
  assert.equal(await checkAshbyHostedPage("northwindlabs", fakeFetch(302, "", [])), "unknown");
  assert.equal(classifyAshbyHostedPage(301, ashbyPage(offData)), "unknown");
});

test("the hosted board slug comes from the listing's own job links, exactly as Ashby wrote it", () => {
  const id = "00000000-0000-4000-8000-000000000001";
  assert.equal(ashbyHostedSlug([{ jobUrl: `https://jobs.ashbyhq.com/NorthwindLabs/${id}` }]), "NorthwindLabs");
  assert.equal(ashbyHostedSlug([{ applyUrl: `https://jobs.ashbyhq.com/northwind%20labs/${id}/application` }]), "northwind labs", "the apply link when there's no job link");
  assert.equal(
    ashbyHostedSlug([{ jobUrl: "https://careers.northwind.example/jobs/1" }, { jobUrl: `https://jobs.ashbyhq.com/northwindlabs/${id}` }]),
    "northwindlabs",
    "the first job hosted on Ashby"
  );
  assert.equal(ashbyHostedSlug([{ jobUrl: "https://careers.northwind.example/jobs/1" }]), null, "not hosted on Ashby");
  assert.equal(ashbyHostedSlug([{ jobUrl: "http://jobs.ashbyhq.com/northwindlabs/1" }]), null, "not HTTPS");
  assert.equal(ashbyHostedSlug([{ jobUrl: "not a url" }, { title: "No links" }]), null);
  assert.equal(ashbyHostedSlug([]), null);
});
