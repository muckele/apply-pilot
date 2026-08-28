import assert from "node:assert/strict";
import { test } from "node:test";

import { createSameOriginClient } from "@/lib/application-browser/same-origin-client";

const RUN_ID = "clz8w7m9a0002qwer1234tyui";
const ORIGIN = "https://apply.example.com";

function response(url: string, status: number, body: unknown) {
  return {
    url: () => url,
    status: () => status,
    json: async () => body
  };
}

test("same-origin client exposes only fixed GETs for the immutable run and policy", async () => {
  const calls: Array<{ url: string; options: unknown }> = [];
  const client = createSameOriginClient({
    configuredApplyPilotOrigin: ORIGIN,
    immutableRunId: RUN_ID,
    requestContext: {
      async get(url, options) {
        calls.push({ url, options });
        if (url.endsWith(`/api/application-runs/${RUN_ID}`)) {
          return response(url, 200, {
            run: {
              id: RUN_ID,
              state: "READY",
              applyHost: "jobs.example.test",
              applyUrlSnapshot: "https://jobs.example.test/apply"
            }
          });
        }
        return response(url, 200, {
          effectiveEnabled: true,
          allowedHosts: ["jobs.example.test"],
          blockedHosts: []
        });
      }
    }
  });

  assert.deepEqual(await client.getApplicationRun(RUN_ID), {
    id: RUN_ID,
    state: "READY",
    applyHost: "jobs.example.test",
    applyUrlSnapshot: "https://jobs.example.test/apply"
  });
  assert.deepEqual(await client.getAutomationPolicy(), {
    effectiveEnabled: true,
    allowedHosts: ["jobs.example.test"],
    blockedHosts: []
  });
  assert.deepEqual(calls, [
    {
      url: `${ORIGIN}/api/application-runs/${RUN_ID}`,
      options: { failOnStatusCode: false, maxRedirects: 0 }
    },
    {
      url: `${ORIGIN}/api/application-automation-policy`,
      options: { failOnStatusCode: false, maxRedirects: 0 }
    }
  ]);
  assert.equal("request" in client, false);
  assert.equal("fetch" in client, false);
});

test("same-origin client rejects an alternate run ID before making a request", async () => {
  let calls = 0;
  const client = createSameOriginClient({
    configuredApplyPilotOrigin: ORIGIN,
    immutableRunId: RUN_ID,
    requestContext: {
      async get() {
        calls += 1;
        throw new Error("unexpected");
      }
    }
  });

  await assert.rejects(client.getApplicationRun("clz8w7m9a0003qwer1234tyui"), /immutable run/i);
  assert.equal(calls, 0);
});

test("same-origin client rejects redirects and response URL drift", async () => {
  for (const [name, returned] of [
    ["redirect", response(`${ORIGIN}/login`, 302, {})],
    ["cross origin", response("https://attacker.example/api/application-runs/x", 200, {})],
    ["wrong path", response(`${ORIGIN}/api/application-runs/other`, 200, {})]
  ] as const) {
    const client = createSameOriginClient({
      configuredApplyPilotOrigin: ORIGIN,
      immutableRunId: RUN_ID,
      requestContext: { async get() { return returned; } }
    });
    await assert.rejects(client.getApplicationRun(RUN_ID), /same-origin response|redirect/i, name);
  }
});

test("same-origin client validates narrow successful response shapes without exposing bodies", async () => {
  const client = createSameOriginClient({
    configuredApplyPilotOrigin: ORIGIN,
    immutableRunId: RUN_ID,
    requestContext: {
      async get(url) {
        return response(url, 200, { run: { id: RUN_ID, state: "READY", applyHost: "jobs.example.test" } });
      }
    }
  });
  await assert.rejects(client.getApplicationRun(RUN_ID), /invalid run response/i);
});
