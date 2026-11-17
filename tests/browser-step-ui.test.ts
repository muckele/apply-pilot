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

// The Apply page is dark. The start command had a light fill and inherited the page's light text,
// so it was near-white on near-white (live case 2026-11-17). Step 5 uses the page's own colors;
// the Copy button is the same light chip everywhere, with its own dark text, so it is left out.
const LIGHT_THEME_COLOR = /(?:^|\s)(?:text|bg|border)-(?:slate-\d+|white|black)(?=\s|$)/;

test("step 5 uses the Apply page's own colors, and the start command sets its text and fill together", async () => {
  const harness = createDomHarness({ fetch: (async () => new Response("{}")) as typeof fetch, confirm: () => true });
  try {
    await harness.render(React.createElement(BrowserStep, { appOrigin: ORIGIN, runId: RUN_ID }));
    const lightColored = [...harness.container.querySelectorAll<HTMLElement>("*")]
      .filter((element) => !element.closest("[data-copy-button]") && LIGHT_THEME_COLOR.test(element.getAttribute("class") ?? ""))
      .map((element) => `${element.tagName.toLowerCase()} ${element.getAttribute("class")}`);
    assert.deepEqual(lightColored, []);
    const commandClass = harness.container.querySelector("[data-browser-start-command]")?.getAttribute("class") ?? "";
    assert.match(commandClass, /(?:^|\s)text-\[var\(--product-text\)\](?=\s|$)/);
    assert.match(commandClass, /(?:^|\s)bg-\[var\(--product-control-bg\)\](?=\s|$)/);
  } finally {
    await harness.close();
  }
});
