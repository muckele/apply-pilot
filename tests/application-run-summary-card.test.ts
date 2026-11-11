import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ApplicationRunSummaryCard } from "@/components/application-run-summary-card";
import { deriveApplyProgress, type ApplyProgressInput } from "@/lib/apply-page/apply-progress";
import { stepHeading } from "@/lib/assisted-apply/control-steps";

const JOB_ID = "clz8w7m9a0001qwer1234tyui";
const input: ApplyProgressInput = {
  hasMasterResume: true, hasCurrentMatch: true, reviewSaved: true,
  resumeAttached: true, coverAttached: true, coverRequired: true,
  automationAvailable: true, run: { state: "READY", companionState: null }, applied: false
};

function render(overrides: Partial<ApplyProgressInput> = {}) {
  const progress = deriveApplyProgress({ ...input, ...overrides });
  return { progress, html: renderToStaticMarkup(createElement(ApplicationRunSummaryCard, { jobId: JOB_ID, progress })) };
}

test("the card links to the Apply page", () => {
  const { progress, html } = render();
  assert.match(html, new RegExp(`href="/jobs/${JOB_ID}/apply"`));
  assert.match(html, /Continue on the Apply page/);
  assert.ok(html.includes(stepHeading(progress.current)));
  assert.ok(html.includes(progress.now));
});

test("the card does not link to /application-runs/", () => {
  for (const overrides of [{}, { run: null }, { run: { state: "FILLING", companionState: null } }]) {
    assert.doesNotMatch(render(overrides).html, /\/application-runs\//);
  }
});
