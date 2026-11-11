import "@/tests/fixtures/dom-globals";
import assert from "node:assert/strict";
import test from "node:test";
import React from "react";

import { ScoreJobButton } from "@/components/job-workspace/score-job-button";
import { createDomHarness } from "@/tests/fixtures/dom-harness";

function costResponse() {
  return new Response(JSON.stringify({ code: "AI_COST_CONFIRMATION_REQUIRED", maximumCostMicros: 72_720 }), { status: 428 });
}

test("the button shows its cost and asks through the confirm it is given", async () => {
  const requests: RequestInit[] = [];
  const asked: string[] = [];
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(init ?? {});
    return requests.length === 1 ? costResponse() : new Response("{}", { status: 200 });
  }) as typeof fetch;
  let windowConfirms = 0;
  const harness = createDomHarness({ fetch: fetchImpl, confirm: () => { windowConfirms += 1; return true; } });
  await harness.render(React.createElement(ScoreJobButton, {
    jobId: "job-1", label: "Check my match", maximumMicros: 72_720,
    confirm: async (message) => { asked.push(message); return true; }
  }));
  await harness.click(harness.button(/Check my match · about 8¢/));
  await harness.waitForText(/Scored/);
  assert.equal(windowConfirms, 0);
  assert.equal(asked.length, 1);
  assert.equal(new Headers(requests[1].headers).get("x-ai-cost-confirmed"), "true");
  await harness.close();
});
