import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { JobSource } from "@prisma/client";

import { AdzunaProvider } from "@/lib/job-sources/adzuna";
import {
  complianceDisabledSourceTypes,
  isSourceTypeComplianceEnabled
} from "@/lib/job-sources/compliance";
import { RemotiveProvider } from "@/lib/job-sources/remotive";
import { assertSourceCanSync } from "@/lib/job-sources/source-policy";

function setEnv(t: TestContext, changes: Record<string, string | undefined>) {
  for (const [name, value] of Object.entries(changes)) {
    const prior = process.env[name];
    t.after(() => { if (prior === undefined) delete process.env[name]; else process.env[name] = prior; });
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
}

function forbidNetwork(t: TestContext) {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    throw new Error("network must not be used while the source is compliance-gated");
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = original; });
  return { get calls() { return calls; } };
}

function source(type: JobSource["type"]) {
  return { id: "source-1", userId: "user-1", name: "Gated", type, baseUrl: null, boardToken: null, allowlisted: true } as JobSource;
}

test("Remotive and Adzuna are off unless their explicit compliance flag is true", () => {
  assert.equal(isSourceTypeComplianceEnabled("REMOTIVE", {}), false);
  assert.equal(isSourceTypeComplianceEnabled("ADZUNA", {}), false);
  assert.equal(isSourceTypeComplianceEnabled("REMOTIVE", { JOB_SOURCE_REMOTIVE_ENABLED: "1" }), false);
  assert.equal(isSourceTypeComplianceEnabled("ADZUNA", { JOB_SOURCE_ADZUNA_ENABLED: "yes" }), false);
  assert.equal(isSourceTypeComplianceEnabled("REMOTIVE", { JOB_SOURCE_REMOTIVE_ENABLED: "true" }), true);
  assert.equal(isSourceTypeComplianceEnabled("ADZUNA", { JOB_SOURCE_ADZUNA_ENABLED: " TRUE " }), true);
  assert.equal(isSourceTypeComplianceEnabled("GREENHOUSE", {}), true);
  assert.equal(isSourceTypeComplianceEnabled("USAJOBS", {}), true);

  assert.deepEqual(complianceDisabledSourceTypes({}).sort(), ["ADZUNA", "REMOTIVE"]);
  assert.deepEqual(complianceDisabledSourceTypes({ JOB_SOURCE_REMOTIVE_ENABLED: "true" }), ["ADZUNA"]);
});

test("gated providers refuse to fetch while disabled, even with credentials configured", async (t) => {
  setEnv(t, {
    JOB_SOURCE_REMOTIVE_ENABLED: undefined,
    JOB_SOURCE_ADZUNA_ENABLED: undefined,
    ADZUNA_APP_ID: "synthetic-id",
    ADZUNA_APP_KEY: "synthetic-key"
  });
  const network = forbidNetwork(t);

  await assert.rejects(new RemotiveProvider().searchJobs({ query: "engineer" }), /JOB_SOURCE_REMOTIVE_ENABLED/);
  await assert.rejects(new AdzunaProvider().searchJobs({ query: "engineer" }), /JOB_SOURCE_ADZUNA_ENABLED/);
  assert.equal(network.calls, 0);
});

test("gated providers fetch normally once the flag is explicitly enabled", async (t) => {
  setEnv(t, { JOB_SOURCE_REMOTIVE_ENABLED: "true" });
  const original = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    urls.push(String(input));
    return new Response(JSON.stringify({ jobs: [{ id: 1, title: "Engineer", url: "https://remotive.com/x", company_name: "Co" }] }));
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = original; });

  const jobs = await new RemotiveProvider().searchJobs({ query: "engineer" });

  assert.equal(jobs.length, 1);
  assert.equal(urls.length, 1);
});

test("manual sync, test and cron paths refuse gated sources with the flag name", (t) => {
  setEnv(t, { JOB_SOURCE_REMOTIVE_ENABLED: undefined, JOB_SOURCE_ADZUNA_ENABLED: undefined });

  assert.throws(() => assertSourceCanSync(source("REMOTIVE")), /JOB_SOURCE_REMOTIVE_ENABLED/);
  assert.throws(() => assertSourceCanSync(source("ADZUNA")), /JOB_SOURCE_ADZUNA_ENABLED/);
  assert.doesNotThrow(() => assertSourceCanSync(source("USAJOBS")));
});
