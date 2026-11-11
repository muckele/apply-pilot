import "@/tests/fixtures/dom-globals";
import assert from "node:assert/strict";
import test from "node:test";
import React from "react";

import { AssistedFillSettingsCard } from "@/components/assisted-fill-settings-card";
import { createDomHarness } from "@/tests/fixtures/dom-harness";

// Task 14 (UX-6): Settings keeps a permanent off switch for Assisted Fill. Turning it on happens
// only at step 8 of a prepared application, where it's used.

const POLICY_URL = "/api/application-automation-policy";

type Call = { method: string; url: string; body: unknown };

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function policy(mode: "PREPARE_ONLY" | "FILL_AND_REVIEW") {
  return { enabled: true, mode, allowedHosts: ["jobs.example.com"], blockedHosts: [], persisted: true, effectiveEnabled: true };
}

function recorder(respond: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = {
      method: init?.method ?? "GET",
      url: String(input),
      body: init?.body ? JSON.parse(String(init.body)) : null
    };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

test("the settings card's Turn off sends PREPARE_ONLY", async () => {
  const { calls, fetchImpl } = recorder(() => json(policy("PREPARE_ONLY")));
  const harness = createDomHarness({
    fetch: fetchImpl,
    confirm: () => {
      throw new Error("Turn off asks no question");
    }
  });
  try {
    await harness.render(React.createElement(AssistedFillSettingsCard, { initialMode: "FILL_AND_REVIEW" }));
    assert.match(harness.text(), /Assisted Fill is on/);
    await harness.click(harness.button("Turn off"));
    await harness.waitForText(/Assisted Fill is off/);
    assert.deepEqual(calls, [{ method: "PATCH", url: POLICY_URL, body: { mode: "PREPARE_ONLY" } }]);
    assert.match(harness.text(), /Turn it on at step 8 of an application you've prepared\./);
    assert.equal(harness.maybeButton("Turn off"), undefined);
  } finally {
    await harness.close();
  }
});

test("when Fill is off the card says where to turn it on and offers no turn-on button", async () => {
  const { calls, fetchImpl } = recorder(() => {
    throw new Error("nothing is sent");
  });
  const harness = createDomHarness({ fetch: fetchImpl });
  try {
    await harness.render(React.createElement(AssistedFillSettingsCard, { initialMode: "PREPARE_ONLY" }));
    assert.match(harness.text(), /Assisted Fill is off/);
    assert.match(harness.text(), /Turn it on at step 8 of an application you've prepared\./);
    assert.equal(harness.container.querySelectorAll("button").length, 0, "no button at all while off");
    assert.deepEqual(calls, []);
  } finally {
    await harness.close();
  }
});

test("a refused Turn off keeps the switch on and lets the user try again", async () => {
  let attempt = 0;
  const { calls, fetchImpl } = recorder(() => {
    attempt += 1;
    return attempt === 1 ? json({ error: "Too many requests.", code: "RATE_LIMITED" }, 429) : json(policy("PREPARE_ONLY"));
  });
  const harness = createDomHarness({ fetch: fetchImpl });
  try {
    await harness.render(React.createElement(AssistedFillSettingsCard, { initialMode: "FILL_AND_REVIEW" }));
    await harness.click(harness.button("Turn off"));
    await harness.waitForText(/wasn't turned off/);
    assert.match(harness.text(), /Assisted Fill is on/);
    await harness.click(harness.button("Turn off"));
    await harness.waitForText(/Assisted Fill is off/);
    assert.equal(calls.filter((call) => call.method === "PATCH").length, 2);
  } finally {
    await harness.close();
  }
});

test("a lost Turn off response is never replayed; the card reads the mode again", async () => {
  const { calls, fetchImpl } = recorder((call) => {
    if (call.method === "PATCH") throw new TypeError("network lost");
    return json(policy("PREPARE_ONLY"));
  });
  const harness = createDomHarness({ fetch: fetchImpl });
  try {
    await harness.render(React.createElement(AssistedFillSettingsCard, { initialMode: "FILL_AND_REVIEW" }));
    await harness.click(harness.button("Turn off"));
    await harness.waitForText(/Assisted Fill is off/);
    assert.deepEqual(calls.map((call) => call.method), ["PATCH", "GET"]);
  } finally {
    await harness.close();
  }
});
