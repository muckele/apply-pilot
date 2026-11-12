import "@/tests/fixtures/dom-globals";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";

import { aiCostQuestionsMode } from "@/lib/ai/cost-questions";
import { useInPageConfirm, type InPageConfirmRequest } from "@/components/ui/in-page-confirm";
import { createDomHarness } from "@/tests/fixtures/dom-harness";

type Api = ReturnType<typeof useInPageConfirm>;

function Probe({ onApi }: { onApi: (api: Api) => void }) {
  const api = useInPageConfirm();
  onApi(api);
  return React.createElement("div", null, api.dialog);
}

const request: InPageConfirmRequest = { title: "Check my match", body: "This could cost up to $0.07." };

async function setup() {
  const harness = createDomHarness();
  let api!: Api;
  await harness.render(React.createElement(Probe, { onApi: (next) => { api = next; } }));
  return { harness, ask: async (r: InPageConfirmRequest = request) => {
      let answer!: Promise<boolean>;
      await act(async () => { answer = api.confirm(r); });
      return { answer };
    }
  };
}

test("cost questions are always asked", () => {
  assert.equal(aiCostQuestionsMode(), "ASK");
});

test("Confirm resolves true, with focus on Confirm and the question inline", async () => {
  const { harness, ask } = await setup();
  const { answer } = await ask();
  await harness.waitForText(/could cost up to/);
  const group = harness.container.querySelector('[role="group"]');
  assert.ok(group);
  assert.equal(group.getAttribute("aria-labelledby") !== null, true);
  assert.equal(harness.window.document.activeElement === harness.button("Confirm"), true);
  await harness.click(harness.button("Confirm"));
  assert.equal(await answer, true);
  assert.equal(harness.container.querySelector('[role="group"]'), null);
  await harness.close();
});

test("Cancel and Escape resolve false", async () => {
  const { harness, ask } = await setup();
  let { answer } = await ask();
  await harness.waitForText(/could cost up to/);
  await harness.click(harness.button("Cancel"));
  assert.equal(await answer, false);
  ({ answer } = await ask());
  await harness.waitForText(/could cost up to/);
  await act(async () => {
    harness.container.querySelector('[role="group"]')!.dispatchEvent(
      new harness.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })
    );
  });
  assert.equal(await answer, false);
  await harness.close();
});

test("a second question cancels the first; unmounting cancels the open one", async () => {
  const { harness, ask } = await setup();
  const { answer: first } = await ask();
  const { answer: second } = await ask({ title: "Second", body: "Another question.", confirmLabel: "Go ahead" });
  assert.equal(await first, false);
  await harness.waitForText(/Another question/);
  assert.equal(harness.maybeButton("Go ahead") !== undefined, true);
  await harness.close();
  assert.equal(await second, false);
});
