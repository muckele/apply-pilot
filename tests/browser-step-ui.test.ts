import "@/tests/fixtures/dom-globals";
import assert from "node:assert/strict";
import test from "node:test";
import React from "react";

import { BrowserStep, browserStartCommand } from "@/components/apply-page/browser-step";
import { createDomHarness } from "@/tests/fixtures/dom-harness";

const RUN_ID = "clz8w7m9a0004qwer1234tyui";
const ORIGIN = "https://app.example.com";

test("the start command contains only the origin and the run id", async () => {
  const expected = `npm run application-browser -- --app-origin ${ORIGIN} --run-id ${RUN_ID}`;
  assert.equal(browserStartCommand(ORIGIN, RUN_ID), expected);
  assert.doesNotMatch(expected, /token|cookie|code/iu);

  const harness = createDomHarness({ fetch: (async () => new Response("{}")) as typeof fetch, confirm: () => true });
  try {
    await harness.render(React.createElement(BrowserStep, { appOrigin: ORIGIN, runId: RUN_ID }));
    const command = harness.container.querySelector("[data-browser-start-command]");
    assert.equal(command?.textContent, expected);
    assert.ok(harness.container.querySelector("[data-copy-button]"), "copy button");
    assert.ok([...harness.container.querySelectorAll("button")].some((b) => /sign-in code/iu.test(b.textContent ?? "")), "sign-in code button");
  } finally {
    await harness.close();
  }
});
