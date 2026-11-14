import "@/tests/fixtures/dom-globals";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";

import { ResultWindow, type ResultWindowProps } from "@/components/apply-page/result-window";
import { resultWindowView } from "@/lib/apply-page/result-window";
import type { ChecklistView } from "@/lib/jobs/job-view-types";
import { createDomHarness, type DomHarness } from "@/tests/fixtures/dom-harness";

// The one large window after every score (G-6). Synthetic data only.

function checklist(shown: string[], notShown: string[]): ChecklistView {
  const item = (requirement: string, status: "shown" | "not_shown") =>
    ({ requirement, jobRef: null, status, claim: null, resumeLines: [], tenure: null });
  return {
    items: [...shown.map((text) => item(text, "shown")), ...notShown.map((text) => item(text, "not_shown"))],
    counts: { shown: shown.length, notShown: notShown.length, notAssessed: 0, total: shown.length + notShown.length }
  };
}

const MONEY = /[$¢]|\bcents?\b|\bcost\b/iu;

test("the grade decides the window: an A is strong, a B is close with at most two gaps, a C or D is weak", () => {
  const list = checklist(["Service delivery", "SQL"], ["Quenby certification", "Enterprise sales", "Spanish"]);
  assert.deepEqual(resultWindowView({ score: 85, checklist: list }), {
    kind: "strong", letter: "A", score: 85, why: "Your résumé shows 2 of 5 must-haves."
  });
  assert.deepEqual(resultWindowView({ score: 84, checklist: list }), {
    kind: "close", letter: "B", score: 84, why: "Your résumé shows 2 of 5 must-haves.", missing: ["Quenby certification", "Enterprise sales"]
  });
  assert.deepEqual(resultWindowView({ score: 69, checklist: list }), { kind: "weak", letter: "C", score: 69 });
  assert.deepEqual(resultWindowView({ score: 12, checklist: list }), { kind: "weak", letter: "D", score: 12 });
  assert.equal(resultWindowView({ score: 140, checklist: list }), null);
  assert.equal(resultWindowView({ score: 90, checklist: checklist([], []) })?.kind === "strong" &&
    (resultWindowView({ score: 90, checklist: checklist([], []) }) as { why: string }).why, "Your résumé fits what this job asks for.");
});

async function withWindow(props: Partial<ResultWindowProps> & Pick<ResultWindowProps, "view">, run: (harness: DomHarness, calls: string[]) => Promise<void>) {
  const calls: string[] = [];
  const harness = createDomHarness();
  try {
    await harness.render(React.createElement(ResultWindow, {
      onCreate: () => calls.push("create"),
      onClose: () => calls.push("close"),
      onAddExperience: () => calls.push("add"),
      onApplyOnMyOwn: () => calls.push("own"),
      ...props
    }));
    await run(harness, calls);
  } finally {
    await harness.close();
  }
}

function dialog(harness: DomHarness) {
  const element = harness.container.querySelector("dialog[data-result-window]");
  assert.ok(element, "the window is a dialog");
  return element as HTMLDialogElement;
}

test("an A shows the grade, why, and Create; Not now closes; no price and no credit line yet", async () => {
  await withWindow({ view: { kind: "strong", letter: "A", score: 91, why: "Your résumé shows 5 of 6 must-haves." } }, async (harness, calls) => {
    const text = dialog(harness).textContent ?? "";
    assert.match(text, /A · 91/u);
    assert.match(text, /Your résumé shows 5 of 6 must-haves\./u);
    assert.doesNotMatch(text, MONEY);
    assert.doesNotMatch(text, /credit/iu, "the credit line stays hidden until a credit source exists");
    assert.equal(dialog(harness).getAttribute("aria-labelledby"), dialog(harness).querySelector("h2")?.id);
    await harness.click(harness.button("Create my résumé and cover letter"));
    await harness.click(harness.button("Not now"));
    assert.deepEqual(calls, ["create", "close"]);
    assert.equal(harness.maybeButton("Find other jobs"), undefined);
  });
});

test("a B shows the two things still missing, with Create, Add my experience first and Find better-fit jobs", async () => {
  await withWindow({
    view: { kind: "close", letter: "B", score: 76, why: "Your résumé shows 4 of 6 must-haves.", missing: ["Quenby certification", "Spanish"] }
  }, async (harness, calls) => {
    const element = dialog(harness);
    assert.match(element.textContent ?? "", /B · 76/u);
    assert.deepEqual([...element.querySelectorAll("[data-missing] li")].map((item) => item.textContent), ["Quenby certification", "Spanish"]);
    await harness.click(harness.button("Add my experience first"));
    await harness.click(harness.button("Create my résumé and cover letter"));
    assert.deepEqual(calls, ["add", "create"]);
    const better = [...element.querySelectorAll("a")].find((link) => link.textContent === "Find better-fit jobs");
    assert.equal(better?.getAttribute("href"), "/jobs");
  });
});

test("a C or D says it may not be a good fit, goes to Jobs, keeps a small Apply on my own link, and creates nothing", async () => {
  await withWindow({ view: { kind: "weak", letter: "D", score: 41 } }, async (harness, calls) => {
    const element = dialog(harness);
    assert.match(element.textContent ?? "", /D · 41/u);
    assert.match(element.textContent ?? "", /This may not be a good fit\. Let's look at other jobs\./u);
    const jobs = [...element.querySelectorAll("a")].find((link) => link.textContent === "Find other jobs");
    assert.equal(jobs?.getAttribute("href"), "/jobs");
    assert.equal(harness.maybeButton("Create my résumé and cover letter"), undefined);
    await harness.click(harness.button("Apply on my own"));
    assert.deepEqual(calls, ["own"]);
  });
});

test("once credits exist, Create says what it uses, and with none left it sends the user to upgrade", async () => {
  const view = { kind: "strong", letter: "A", score: 90, why: "Your résumé shows 3 of 3 must-haves." } as const;
  await withWindow({ view, credit: { left: 4 }, upgradeHref: "/settings/plan" }, async (harness) => {
    assert.match(dialog(harness).textContent ?? "", /Uses 1 credit · 4 left/u);
  });
  await withWindow({ view, credit: { left: 0 }, upgradeHref: "/settings/plan" }, async (harness) => {
    assert.equal(harness.maybeButton("Create my résumé and cover letter"), undefined);
    const upgrade = [...dialog(harness).querySelectorAll("a")].find((link) => link.textContent === "Upgrade your plan");
    assert.equal(upgrade?.getAttribute("href"), "/settings/plan");
  });
});

test("unsaved lines in step 2 hold Create back and point there", async () => {
  await withWindow({
    view: { kind: "strong", letter: "A", score: 88, why: "Your résumé shows 3 of 3 must-haves." },
    createBlockedReason: "You've written lines in step 2 that aren't saved yet. Update your match there first."
  }, async (harness, calls) => {
    assert.equal(harness.button("Create my résumé and cover letter").disabled, true);
    assert.match(dialog(harness).textContent ?? "", /aren't saved yet/u);
    await harness.click(harness.button("Go to step 2"));
    assert.deepEqual(calls, ["add"]);
  });
});

test("while creating, Create is busy and the window says what is happening", async () => {
  await withWindow({
    view: { kind: "strong", letter: "A", score: 88, why: "Your résumé shows 3 of 3 must-haves." },
    creating: true,
    status: { tone: "info", text: "Writing your résumé…" }
  }, async (harness, calls) => {
    const create = harness.button(/Creating/u);
    assert.equal(create.disabled, true);
    await harness.click(create);
    assert.deepEqual(calls, []);
    assert.match(dialog(harness).querySelector("[role=status]")?.textContent ?? "", /Writing your résumé…/u);
  });
});

test("Esc closes the window through the page, and the dialog never closes itself", async () => {
  await withWindow({ view: { kind: "strong", letter: "A", score: 90, why: "Your résumé shows 3 of 3 must-haves." } }, async (harness, calls) => {
    const cancel = new harness.window.Event("cancel", { cancelable: true });
    await act(async () => { dialog(harness).dispatchEvent(cancel); });
    assert.equal(cancel.defaultPrevented, true);
    assert.deepEqual(calls, ["close"]);
  });
  await withWindow({
    view: { kind: "strong", letter: "A", score: 90, why: "Your résumé shows 3 of 3 must-haves." },
    creating: true
  }, async (harness, calls) => {
    await act(async () => { dialog(harness).dispatchEvent(new harness.window.Event("cancel", { cancelable: true })); });
    assert.deepEqual(calls, [], "Esc waits while documents are being written");
  });
});
