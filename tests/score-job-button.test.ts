import "@/tests/fixtures/dom-globals";
import assert from "node:assert/strict";
import test from "node:test";
import React from "react";

import { ScoreJobButton } from "@/components/job-workspace/score-job-button";
import { createDomHarness } from "@/tests/fixtures/dom-harness";

test("on the Apply page one click scores: no price, no cost question, consent headers on one request", async () => {
  const requests: RequestInit[] = [];
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(init ?? {});
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  const harness = createDomHarness({ fetch: fetchImpl, confirm: () => { throw new Error("window.confirm must not run"); } });
  let scored = 0;
  await harness.render(React.createElement(ScoreJobButton, {
    jobId: "job-1", label: "Check my match", beforeRun: async () => true, onScored: () => { scored += 1; }
  }));
  await harness.click(harness.button("Check my match"));
  await harness.waitForText(/Scored/);
  assert.equal(requests.length, 1);
  assert.equal(new Headers(requests[0].headers).get("x-ai-cost-confirmed"), "true");
  assert.equal(new Headers(requests[0].headers).get("x-ai-data-confirmed"), "true");
  assert.equal(scored, 1, "the page is told, so it can refresh and show the result window");
  assert.equal(harness.refreshes, 0, "the page refreshes, not the button");
  assert.doesNotMatch(harness.text(), /¢|\$/u);
  await harness.close();
});

test("declining the Gemini notice sends nothing", async () => {
  let requests = 0;
  const harness = createDomHarness({ fetch: (async () => { requests += 1; return new Response("{}"); }) as typeof fetch });
  await harness.render(React.createElement(ScoreJobButton, { jobId: "job-1", label: "Check my match", beforeRun: async () => false, onScored: () => {} }));
  await harness.click(harness.button("Check my match"));
  await harness.waitForText(/Nothing was sent\./u);
  assert.equal(requests, 0);
  await harness.close();
});

test("a refused score says why in plain words, with no money in it", async () => {
  const harness = createDomHarness({
    fetch: (async () => new Response(JSON.stringify({ error: "This request would exceed your monthly AI budget.", code: "AI_BUDGET_EXCEEDED" }), { status: 429 })) as typeof fetch
  });
  let scored = 0;
  await harness.render(React.createElement(ScoreJobButton, { jobId: "job-1", label: "Check my match", beforeRun: async () => true, onScored: () => { scored += 1; } }));
  await harness.click(harness.button("Check my match"));
  await harness.waitForText(/You've reached this month's AI limit\./u);
  assert.equal(scored, 0);
  await harness.close();
});
