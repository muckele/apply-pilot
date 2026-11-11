import "@/tests/fixtures/dom-globals";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";

import { PrepareStep, type PrepareStepProps } from "@/components/apply-page/prepare-step";
import { allowHostForRun, prepareRun } from "@/lib/application-runs/client-run";
import { buildReadyList, type ReadyListInput } from "@/lib/apply-page/ready-list";
import { createDomHarness } from "@/tests/fixtures/dom-harness";

// Synthetic ids only (cuid-shaped, as the run API returns).
const APPLICATION_ID = "clz8w7m9a0000qwer1234tyui";
const RUN_ID = "clz8w7m9a0004qwer1234tyui";
const HOST = "jobs.example.com";
const QUESTION = `Prepare plans this application with Google Gemini (usually under 1¢) and lets Apply Pilot work on ${HOST}.`;
const KEY = `application-run-create:${APPLICATION_ID}`;

const READY_INPUT: ReadyListInput = {
  fitScore: 90, confidenceScore: 88, hasCurrentMatch: true, resume: "ready", cover: "ready",
  coverRequired: true, fillMode: "PREPARE_ONLY", hostBlocked: false,
  details: { confirmed: 6, total: 10, missing: [] }
};

type Call = { method: string; url: string; body: unknown; costConfirmed: boolean };
type Route = (call: Call) => Response | Promise<Response>;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function runBody(state: string, extra: Record<string, unknown> = {}) {
  return { run: { id: RUN_ID, applicationId: APPLICATION_ID, state, applyHost: HOST, blockingReason: null, errorCategory: null, ...extra } };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}

// The happy path, one route per request; tests override the ones they exercise.
const HAPPY: Record<string, Route> = {
  "POST /api/application-runs": () => json({ ...runBody("DRAFT"), replayed: false }, 201),
  "PATCH /api/application-automation-policy": () => json({ enabled: true, mode: "PREPARE_ONLY", allowedHosts: [HOST], blockedHosts: [] }),
  [`POST /api/application-runs/${RUN_ID}/prepare`]: () => json(runBody("READY")),
  [`GET /api/application-runs/${RUN_ID}`]: () => json(runBody("DRAFT"))
};

function recorder(overrides: Record<string, Route> = {}) {
  const calls: Call[] = [];
  const routes = { ...HAPPY, ...overrides };
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const call: Call = {
      method,
      url: String(input),
      body: init?.body ? JSON.parse(String(init.body)) : null,
      costConfirmed: new Headers(init?.headers).get("x-ai-cost-confirmed") === "true"
    };
    calls.push(call);
    const route = routes[`${method} ${call.url}`];
    if (!route) throw new Error(`Unexpected request: ${method} ${call.url}`);
    return route(call);
  }) as typeof fetch;
  return { calls, fetchImpl, requests: () => calls.map((call) => `${call.method} ${call.url}`) };
}

function props(overrides: Partial<PrepareStepProps> = {}): PrepareStepProps {
  return {
    jobId: "job-1",
    applicationId: APPLICATION_ID,
    applyHost: HOST,
    readyList: buildReadyList(READY_INPUT),
    fillMode: "PREPARE_ONLY",
    run: null,
    ...overrides
  };
}

async function settle() {
  for (let tick = 0; tick < 12; tick += 1) await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 0)); });
}

async function withStep(
  stepProps: PrepareStepProps,
  fetchImpl: typeof fetch,
  run: (harness: ReturnType<typeof createDomHarness>) => Promise<void>
) {
  const harness = createDomHarness({ fetch: fetchImpl, confirm: () => { throw new Error("window.confirm must not run"); } });
  try {
    await harness.render(React.createElement(PrepareStep, stepProps));
    await run(harness);
  } finally {
    await harness.close();
  }
}

const mainButton = (harness: ReturnType<typeof createDomHarness>) => harness.button("Allow and prepare");
const question = (harness: ReturnType<typeof createDomHarness>) =>
  harness.container.querySelector('[role="group"] .job-card-copy')?.textContent ?? null;

test("one click creates one run, allows the host once and prepares once, in that order", async () => {
  const recorded = recorder();
  await withStep(props(), recorded.fetchImpl, async (harness) => {
    assert.equal(mainButton(harness).disabled, false);
    await harness.click(mainButton(harness));
    assert.equal(question(harness), QUESTION);
    assert.doesNotMatch(question(harness) ?? "", /https?:\/\//u, "the host only, never a full URL");
    assert.equal(recorded.calls.length, 0, "nothing is sent while the question is open");
    await harness.click(harness.button("Confirm"));
    await settle();
    assert.deepEqual(recorded.requests(), [
      "POST /api/application-runs",
      "PATCH /api/application-automation-policy",
      `POST /api/application-runs/${RUN_ID}/prepare`
    ]);
    const [create, allow, prepare] = recorded.calls;
    assert.deepEqual(Object.keys(create.body as object).sort(), ["applicationId", "idempotencyKey"]);
    assert.equal((create.body as { applicationId: string }).applicationId, APPLICATION_ID);
    assert.deepEqual(allow.body, { enablePretrialForRunId: RUN_ID });
    assert.deepEqual(prepare.body, {});
    assert.equal(prepare.costConfirmed, false, "no cost header unless the server asks and the user confirms");
    assert.equal(harness.window.sessionStorage.getItem(KEY), null, "the create key is cleared once the run exists");
    assert.ok(harness.refreshes >= 1, "a READY run refreshes the page so progress moves on");
  });
});

test("a double click still sends each request once", async () => {
  const created = deferred<Response>();
  const recorded = recorder({ "POST /api/application-runs": () => created.promise });
  await withStep(props(), recorded.fetchImpl, async (harness) => {
    const button = mainButton(harness);
    await act(async () => {
      button.dispatchEvent(new harness.window.MouseEvent("click", { bubbles: true }));
      button.dispatchEvent(new harness.window.MouseEvent("click", { bubbles: true }));
    });
    assert.equal(harness.container.querySelectorAll('[role="group"]').length, 1, "one question");
    await harness.click(harness.button("Confirm"));
    // Clicking again while the run is being created changes nothing.
    await harness.click(mainButton(harness));
    assert.equal(harness.maybeButton("Confirm") === undefined, true);
    created.resolve(json({ ...runBody("DRAFT"), replayed: false }, 201));
    await settle();
    assert.equal(harness.maybeButton("Allow and prepare") === undefined, true, "a prepared run has nothing left to start");
    assert.deepEqual(recorded.requests(), [
      "POST /api/application-runs",
      "PATCH /api/application-automation-policy",
      `POST /api/application-runs/${RUN_ID}/prepare`
    ]);
  });
});

test("Cancel sends nothing", async () => {
  const recorded = recorder();
  await withStep(props(), recorded.fetchImpl, async (harness) => {
    await harness.click(mainButton(harness));
    assert.equal(question(harness), QUESTION);
    await harness.click(harness.button("Cancel"));
    await settle();
    assert.deepEqual(recorded.calls, []);
    assert.equal(harness.window.sessionStorage.getItem(KEY), null, "no create request was even keyed");
    assert.equal(mainButton(harness).disabled, false, "the step can be started again");
  });
});

test("fit_below_threshold shows its copy and Go to step 1", async () => {
  const recorded = recorder();
  await withStep(props({ readyList: buildReadyList({ ...READY_INPUT, fitScore: 84 }) }), recorded.fetchImpl, async (harness) => {
    const line = harness.container.querySelector('[data-ready-line="fit_below_threshold"]');
    assert.equal(line?.getAttribute("data-ok"), "false");
    assert.match(line?.textContent ?? "", /The job's current fit score does not meet the existing policy threshold\./u);
    const fix = line?.querySelector("a");
    assert.equal(fix?.textContent, "Go to step 1");
    assert.equal(fix?.getAttribute("href"), "#step-1");
    assert.equal(mainButton(harness).disabled, true, "a failing blocking line keeps the button off");
    await harness.click(mainButton(harness));
    assert.equal(harness.maybeButton("Confirm") === undefined, true);
    assert.deepEqual(recorded.calls, []);
  });

  // The server is the authority: its block shows the same copy and fix, even when the list looked ready.
  const blocked = recorder({
    [`POST /api/application-runs/${RUN_ID}/prepare`]: () => json({ error: "blocked", code: "RUN_PREPARATION_BLOCKED", reason: "fit_below_threshold" }, 422),
    [`GET /api/application-runs/${RUN_ID}`]: () => json(runBody("BLOCKED", { blockingReason: "fit_below_threshold" }))
  });
  await withStep(props({ run: { id: RUN_ID, state: "DRAFT" } }), blocked.fetchImpl, async (harness) => {
    await harness.click(mainButton(harness));
    await harness.click(harness.button("Confirm"));
    await settle();
    const outcome = harness.container.querySelector("[data-prepare-outcome]");
    assert.match(outcome?.textContent ?? "", /The job's current fit score does not meet the existing policy threshold\./u);
    assert.equal(outcome?.querySelector('a[href="#step-1"]')?.textContent, "Go to step 1");
    assert.equal(blocked.calls.some((call) => call.url === "/api/application-runs"), false, "an existing run is reused");
  });
});

test("Turn off sends PREPARE_ONLY", async () => {
  const recorded = recorder({
    "PATCH /api/application-automation-policy": () => json({ enabled: true, mode: "PREPARE_ONLY", allowedHosts: [], blockedHosts: [] })
  });
  const fillOn = props({ fillMode: "FILL_AND_REVIEW", readyList: buildReadyList({ ...READY_INPUT, fillMode: "FILL_AND_REVIEW" }) });
  await withStep(fillOn, recorded.fetchImpl, async (harness) => {
    assert.equal(mainButton(harness).disabled, true, "Prepare waits while Fill is on");
    const line = harness.container.querySelector('[data-ready-line="fill_on"]');
    assert.match(line?.textContent ?? "", /Assisted Fill is still on/u);
    await harness.click(harness.button("Turn off"));
    await settle();
    assert.equal(harness.container.querySelectorAll('[role="group"]').length, 0, "no question for the safe direction");
    assert.deepEqual(recorded.calls.map((call) => [call.method, call.url, call.body]), [
      ["PATCH", "/api/application-automation-policy", { mode: "PREPARE_ONLY" }]
    ]);
    assert.equal(harness.refreshes, 1);
    assert.equal(mainButton(harness).disabled, false, "with Fill off, Prepare can start");
  });
});

test("a failure after the run exists never creates a second run on retry", async () => {
  let allows = 0;
  const recorded = recorder({
    "PATCH /api/application-automation-policy": () => {
      allows += 1;
      return allows === 1 ? json({ error: "down" }, 503) : json({ enabled: true, mode: "PREPARE_ONLY", allowedHosts: [HOST], blockedHosts: [] });
    }
  });
  await withStep(props(), recorded.fetchImpl, async (harness) => {
    await harness.click(mainButton(harness));
    await harness.click(harness.button("Confirm"));
    await settle();
    assert.match(harness.container.querySelector("[data-prepare-message]")?.textContent ?? "", /jobs\.example\.com/u);
    assert.equal(mainButton(harness).disabled, false);
    await harness.click(mainButton(harness));
    await harness.click(harness.button("Confirm"));
    await settle();
    assert.deepEqual(recorded.requests(), [
      "POST /api/application-runs",
      "PATCH /api/application-automation-policy",
      "PATCH /api/application-automation-policy",
      `POST /api/application-runs/${RUN_ID}/prepare`
    ]);
    assert.deepEqual(recorded.calls[2].body, { enablePretrialForRunId: RUN_ID });
  });
});

test("a lost create response retries with the same request key", async () => {
  let creates = 0;
  const recorded = recorder({
    "POST /api/application-runs": () => {
      creates += 1;
      if (creates === 1) throw new Error("connection dropped");
      return json({ ...runBody("DRAFT"), replayed: true }, 200);
    }
  });
  await withStep(props(), recorded.fetchImpl, async (harness) => {
    await harness.click(mainButton(harness));
    await harness.click(harness.button("Confirm"));
    await settle();
    assert.equal(recorded.calls.length, 1, "nothing after an unconfirmed create");
    assert.ok(harness.window.sessionStorage.getItem(KEY), "the key is kept for the retry");
    await harness.click(mainButton(harness));
    await harness.click(harness.button("Confirm"));
    await settle();
    const keys = recorded.calls.filter((call) => call.url === "/api/application-runs").map((call) => (call.body as { idempotencyKey: string }).idempotencyKey);
    assert.equal(keys.length, 2);
    assert.equal(keys[0], keys[1]);
    assert.equal(harness.window.sessionStorage.getItem(KEY), null);
  });
});

test("an existing blocked run is re-prepared, with its blocker and fix shown first", async () => {
  const recorded = recorder();
  const run = { id: RUN_ID, state: "BLOCKED", blockingReason: "daily_application_cap_reached", errorCategory: null };
  await withStep(props({ run }), recorded.fetchImpl, async (harness) => {
    const outcome = harness.container.querySelector("[data-prepare-outcome]");
    assert.match(outcome?.textContent ?? "", /The daily preparation cap has been reached\./u);
    assert.ok(outcome?.querySelector("button")?.textContent === "Try later");
    await harness.click(mainButton(harness));
    await harness.click(harness.button("Confirm"));
    await settle();
    assert.deepEqual(recorded.requests(), ["PATCH /api/application-automation-policy", `POST /api/application-runs/${RUN_ID}/prepare`]);
  });
});

test("a failed run shows what failed and can be prepared again", async () => {
  const recorded = recorder({
    [`POST /api/application-runs/${RUN_ID}/prepare`]: () => json({ error: "Application planning failed.", code: "RUN_PREPARATION_FAILED", category: "planner_provider_failure" }, 502),
    [`GET /api/application-runs/${RUN_ID}`]: () => json(runBody("FAILED", { errorCategory: "planner_provider_failure" }))
  });
  await withStep(props({ run: { id: RUN_ID, state: "DRAFT" } }), recorded.fetchImpl, async (harness) => {
    await harness.click(mainButton(harness));
    await harness.click(harness.button("Confirm"));
    await settle();
    assert.equal(harness.container.querySelector("[data-prepare-outcome]")?.textContent, "Preparation failed while building the application plan.");
    assert.equal(mainButton(harness).disabled, false, "a failed run can be tried again");
  });
});

test("a cost question from the server is asked in the page: Cancel sends nothing more, Confirm sends the header", async () => {
  for (const answer of ["Cancel", "Confirm"] as const) {
    const recorded = recorder({
      [`POST /api/application-runs/${RUN_ID}/prepare`]: (call) => call.costConfirmed
        ? json(runBody("READY"))
        : json({ error: "confirm", code: "AI_COST_CONFIRMATION_REQUIRED", maximumCostMicros: 62_000, provider: "gemini" }, 428),
      [`GET /api/application-runs/${RUN_ID}`]: () => json(runBody("BLOCKED", { blockingReason: "ai_cost_confirmation_required" }))
    });
    await withStep(props({ run: { id: RUN_ID, state: "DRAFT" } }), recorded.fetchImpl, async (harness) => {
      await harness.click(mainButton(harness));
      await harness.click(harness.button("Confirm"));
      await harness.waitForText(/could cost up to \$0\.062/u);
      const prepares = () => recorded.calls.filter((call) => call.url.endsWith("/prepare"));
      assert.equal(prepares().length, 1, answer);
      await harness.click(harness.button(answer));
      await settle();
      if (answer === "Cancel") {
        assert.equal(prepares().length, 1, "Cancel sends nothing more");
        assert.match(harness.container.querySelector("[data-prepare-message]")?.textContent ?? "", /nothing was charged/iu);
        assert.equal(mainButton(harness).disabled, false);
      } else {
        assert.deepEqual(prepares().map((call) => call.costConfirmed), [false, true]);
        assert.ok(harness.refreshes >= 1);
      }
    });
  }
});

test("the helpers send exactly the documented requests", async () => {
  const recorded = recorder();
  await allowHostForRun(RUN_ID, recorded.fetchImpl);
  assert.deepEqual(recorded.calls.map((call) => [call.method, call.url, call.body]), [
    ["PATCH", "/api/application-automation-policy", { enablePretrialForRunId: RUN_ID }]
  ]);
  const refused = recorder({ "PATCH /api/application-automation-policy": () => json({ error: "no", code: "RUN_HOST_BLOCKED" }, 403) });
  await assert.rejects(allowHostForRun(RUN_ID, refused.fetchImpl));

  const prepared = recorder();
  const response = await prepareRun(RUN_ID, () => { throw new Error("no question without a 428"); }, prepared.fetchImpl);
  assert.equal(response.status, 200);
  assert.deepEqual(prepared.calls.map((call) => [call.method, call.url, call.body, call.costConfirmed]), [
    ["POST", `/api/application-runs/${RUN_ID}/prepare`, {}, false]
  ]);
});

test("once prepared, the step says so and offers nothing to start or turn off", async () => {
  const recorded = recorder();
  const fillOn = buildReadyList({ ...READY_INPUT, fillMode: "FILL_AND_REVIEW" });
  for (const state of ["READY", "REVIEW_REQUIRED"]) {
    await withStep(props({ run: { id: RUN_ID, state }, fillMode: "FILL_AND_REVIEW", readyList: fillOn }), recorded.fetchImpl, async (harness) => {
      assert.match(harness.container.querySelector("[data-prepare-outcome]")?.textContent ?? "", /^Prepared/u, state);
      assert.equal(harness.maybeButton("Allow and prepare") === undefined, true, state);
      assert.equal(harness.maybeButton("Turn off") === undefined, true, `${state}: Fill being on is expected after Prepare`);
      assert.equal(harness.container.querySelector("[data-ready-line]") === null, true, state);
    });
  }
  assert.equal(recorded.calls.length, 0);
});

// Fix round 1.

const DRAFT_RUN = { id: RUN_ID, state: "DRAFT", blockingReason: null, errorCategory: null };

async function allowAndConfirm(harness: ReturnType<typeof createDomHarness>) {
  await harness.click(mainButton(harness));
  await harness.click(harness.button("Confirm"));
  await settle();
}

const messageText = (harness: ReturnType<typeof createDomHarness>) =>
  harness.container.querySelector("[data-prepare-message]")?.textContent ?? null;
const outcomeText = (harness: ReturnType<typeof createDomHarness>) =>
  harness.container.querySelector("[data-prepare-outcome]")?.textContent ?? null;

test("a Fill-on or blocked-host refusal from Enable refreshes the page, so the fix on the list appears", async () => {
  const fillOn = recorder({
    "PATCH /api/application-automation-policy": () => json({ error: "Review the current Fill-capable policy separately before pretrial setup.", code: "AUTOMATION_POLICY_MODE_REQUIRES_REVIEW" }, 409)
  });
  await withStep(props({ run: DRAFT_RUN }), fillOn.fetchImpl, async (harness) => {
    await allowAndConfirm(harness);
    assert.deepEqual(fillOn.requests(), ["PATCH /api/application-automation-policy"]);
    assert.match(messageText(harness) ?? "", /Assisted Fill is on/u);
    assert.equal(harness.refreshes, 1, "the refreshed page carries the policy's Fill mode");
    // What router.refresh() delivers: the same run, with Fill on in the list.
    await harness.render(React.createElement(PrepareStep, props({
      run: DRAFT_RUN, fillMode: "FILL_AND_REVIEW", readyList: buildReadyList({ ...READY_INPUT, fillMode: "FILL_AND_REVIEW" })
    })));
    assert.equal(harness.maybeButton("Turn off") !== undefined, true);
    assert.equal(mainButton(harness).disabled, true);
    assert.match(messageText(harness) ?? "", /Assisted Fill is on/u, "the message stays after the refresh");
  });

  const blockedHost = recorder({
    "PATCH /api/application-automation-policy": () => json({ error: "This application run target host is blocked or invalid.", code: "RUN_HOST_BLOCKED" }, 403)
  });
  await withStep(props({ run: DRAFT_RUN }), blockedHost.fetchImpl, async (harness) => {
    await allowAndConfirm(harness);
    assert.match(messageText(harness) ?? "", /jobs\.example\.com is blocked/u);
    assert.equal(harness.refreshes, 1);
  });
});

test("after Try later, meeting the same block again shows it again", async () => {
  const blockedRun = { id: RUN_ID, state: "BLOCKED", blockingReason: "daily_application_cap_reached", errorCategory: null };
  const recorded = recorder({
    [`POST /api/application-runs/${RUN_ID}/prepare`]: () => json({ error: "The daily application preparation cap has been reached.", code: "RUN_DAILY_CAP_REACHED", reason: "daily_application_cap_reached" }, 429),
    [`GET /api/application-runs/${RUN_ID}`]: () => json(runBody("BLOCKED", { blockingReason: "daily_application_cap_reached" }))
  });
  await withStep(props({ run: blockedRun }), recorded.fetchImpl, async (harness) => {
    await harness.click(harness.button("Try later"));
    assert.equal(outcomeText(harness), null, "Try later puts the step back to Allow and prepare");
    await allowAndConfirm(harness);
    assert.match(outcomeText(harness) ?? "", /The daily preparation cap has been reached\./u);
    assert.equal(messageText(harness), null, "a reported block is the outcome, not a failure to run");
  });
});

test("a refusal that leaves the run unprepared says Prepare didn't run", async () => {
  const cases: Array<{ label: string; run: typeof DRAFT_RUN | { id: string; state: string; blockingReason: string; errorCategory: null }; response: () => Response; readBack: Record<string, unknown>; expected: string }> = [
    {
      label: "rate limited, still DRAFT",
      run: DRAFT_RUN,
      response: () => json({ error: "Rate limit exceeded. Try again shortly." }, 429),
      readBack: runBody("DRAFT"),
      expected: "Prepare didn't run: Rate limit exceeded. Try again shortly."
    },
    {
      label: "stale, run unchanged",
      run: { id: RUN_ID, state: "BLOCKED", blockingReason: "fit_below_threshold", errorCategory: null },
      response: () => json({ error: "This preparation result is no longer current.", code: "RUN_PREPARATION_STALE" }, 409),
      readBack: runBody("BLOCKED", { blockingReason: "fit_below_threshold" }),
      expected: "Prepare didn't run: This preparation result is no longer current. Try again."
    },
    {
      label: "server error without a body",
      run: DRAFT_RUN,
      response: () => new Response("upstream down", { status: 503 }),
      readBack: runBody("DRAFT"),
      expected: "Prepare didn't run. Try again."
    }
  ];
  for (const { label, run, response, readBack, expected } of cases) {
    const recorded = recorder({
      [`POST /api/application-runs/${RUN_ID}/prepare`]: response,
      [`GET /api/application-runs/${RUN_ID}`]: () => json(readBack)
    });
    await withStep(props({ run }), recorded.fetchImpl, async (harness) => {
      await allowAndConfirm(harness);
      assert.equal(messageText(harness), expected, label);
      assert.equal(mainButton(harness).disabled, false, label);
    });
  }
});

test("a create request that replays an ended run is dropped, and the next try creates a new run", async () => {
  let creates = 0;
  const NEW_RUN = "clz8w7m9a0007qwer1234tyui";
  const recorded = recorder({
    "POST /api/application-runs": () => {
      creates += 1;
      return creates === 1
        ? json({ ...runBody("CANCELLED"), replayed: true }, 200)
        : json({ run: { id: NEW_RUN, applicationId: APPLICATION_ID, state: "DRAFT", applyHost: HOST }, replayed: false }, 201);
    },
    [`PATCH /api/application-automation-policy`]: () => json({ enabled: true, mode: "PREPARE_ONLY", allowedHosts: [HOST], blockedHosts: [] }),
    [`POST /api/application-runs/${NEW_RUN}/prepare`]: () => json({ run: { id: NEW_RUN, applicationId: APPLICATION_ID, state: "READY", applyHost: HOST } })
  });
  await withStep(props(), recorded.fetchImpl, async (harness) => {
    await allowAndConfirm(harness);
    assert.deepEqual(recorded.requests(), ["POST /api/application-runs"], "nothing is allowed or prepared for an ended run");
    assert.match(messageText(harness) ?? "", /already ended\. Try again/u);
    assert.equal(harness.window.sessionStorage.getItem(KEY), null, "the ended run's key is dropped");
    await allowAndConfirm(harness);
    const keys = recorded.calls.filter((call) => call.url === "/api/application-runs").map((call) => (call.body as { idempotencyKey: string }).idempotencyKey);
    assert.equal(keys.length, 2);
    assert.notEqual(keys[0], keys[1], "a new request, so a new run");
    assert.deepEqual(recorded.requests().slice(1), [
      "POST /api/application-runs", "PATCH /api/application-automation-policy", `POST /api/application-runs/${NEW_RUN}/prepare`
    ]);
  });
});

test("a run on the page clears a kept create key, and a run that goes away isn't reused", async () => {
  const recorded = recorder({ "PATCH /api/application-automation-policy": () => json({ error: "down" }, 503) });
  const harness = createDomHarness({ fetch: recorded.fetchImpl, confirm: () => { throw new Error("window.confirm must not run"); } });
  try {
    harness.window.sessionStorage.setItem(KEY, "00000000-0000-4000-8000-000000000000");
    await harness.render(React.createElement(PrepareStep, props({ run: DRAFT_RUN })));
    await settle();
    assert.equal(harness.window.sessionStorage.getItem(KEY), null);

    // This step creates a run, then allowing fails; later the page shows that run, then none (it was cancelled).
    await harness.render(React.createElement(PrepareStep, props()));
    await allowAndConfirm(harness);
    assert.deepEqual(recorded.requests(), ["POST /api/application-runs", "PATCH /api/application-automation-policy"]);
    await harness.render(React.createElement(PrepareStep, props({ run: DRAFT_RUN })));
    await settle();
    await harness.render(React.createElement(PrepareStep, props({ run: null })));
    await settle();
    await allowAndConfirm(harness);
    assert.equal(recorded.calls.filter((call) => call.url === "/api/application-runs").length, 2, "the cancelled run isn't reused");
  } finally {
    await harness.close();
  }
});
