import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { JSDOM } from "jsdom";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  ONBOARDING_CHECKLIST_ANCHOR,
  OnboardingChecklist,
  OnboardingSetupHint
} from "@/components/onboarding-checklist";
import { buildOnboardingChecklist, type OnboardingSignals } from "@/lib/onboarding";

const NOTHING_DONE: OnboardingSignals = {
  parsedMasterResumeCount: 0,
  profileReviewed: false,
  jobPreferencesSet: false,
  jobPostingCount: 0,
  appliedApplicationCount: 0
};

const RESUME_DONE: OnboardingSignals = { ...NOTHING_DONE, parsedMasterResumeCount: 1 };

const EVERYTHING_DONE: OnboardingSignals = {
  parsedMasterResumeCount: 1,
  profileReviewed: true,
  jobPreferencesSet: true,
  jobPostingCount: 1,
  appliedApplicationCount: 1
};

const noopAction = async () => {};

function renderChecklist(signals: OnboardingSignals, hidden = false) {
  const markup = renderToStaticMarkup(createElement(OnboardingChecklist, {
    checklist: buildOnboardingChecklist(signals),
    hidden,
    hideAction: noopAction,
    showAction: noopAction
  }));
  return { markup, document: new JSDOM(`<body>${markup}</body>`).window.document };
}

test("the checklist is a labelled region with a semantic ordered list of five steps", () => {
  const { document } = renderChecklist(RESUME_DONE);
  const region = document.getElementById(ONBOARDING_CHECKLIST_ANCHOR);

  assert.ok(region, "checklist region must carry the anchor id used by empty states");
  assert.equal(region.tagName, "SECTION");
  const headingId = region.getAttribute("aria-labelledby");
  assert.ok(headingId);
  assert.equal(document.getElementById(headingId)?.textContent, "Set up your job search");
  const items = region.querySelectorAll("ol > li");
  assert.equal(items.length, 5);
  assert.match(items[0].textContent ?? "", /Upload your master resume/);
  assert.match(items[4].textContent ?? "", /Apply to your first job/);
});

test("step state is conveyed in text, not colour alone", () => {
  const { document } = renderChecklist(RESUME_DONE);
  const items = [...document.querySelectorAll("ol > li")];
  const stateLabels = items.map((item) => item.querySelector("[data-step-state]")?.textContent?.trim());

  assert.deepEqual(stateLabels, ["Done", "Next step", "To do", "To do", "To do"]);
  assert.deepEqual(items.map((item) => item.getAttribute("data-status")), ["complete", "next", "pending", "pending", "pending"]);
});

test("the next step is highlighted and marked as the current step", () => {
  const { document } = renderChecklist(RESUME_DONE);
  const current = document.querySelectorAll('li[aria-current="step"]');

  assert.equal(current.length, 1);
  assert.match(current[0].textContent ?? "", /Review your profile/);
  assert.match(current[0].className, /product-surface-raised/);
  const primary = current[0].querySelector("a");
  assert.equal(primary?.getAttribute("href"), "/settings/profile");
  assert.equal(primary?.textContent?.trim(), "Review profile");
  assert.match(primary?.className ?? "", /product-primary-action/);
});

test("incomplete steps link to the page that completes them; finished steps do not nag", () => {
  const { document } = renderChecklist(RESUME_DONE);
  const items = [...document.querySelectorAll("ol > li")];
  const links = items.map((item) => {
    const link = item.querySelector("a");
    return link ? [link.getAttribute("href"), link.textContent?.trim()] : null;
  });

  assert.deepEqual(links, [
    null,
    ["/settings/profile", "Review profile"],
    ["/jobs", "Set preferences"],
    ["/jobs", "Find jobs"],
    ["/jobs", "Apply to a job"]
  ]);
});

test("progress is shown as text and as an accessible progressbar", () => {
  const { document } = renderChecklist(RESUME_DONE);
  const progress = document.querySelector('[role="progressbar"]');

  assert.match(document.body.textContent ?? "", /1 of 5 steps done/);
  assert.ok(progress);
  assert.equal(progress.getAttribute("aria-valuemin"), "0");
  assert.equal(progress.getAttribute("aria-valuemax"), "5");
  assert.equal(progress.getAttribute("aria-valuenow"), "1");
  assert.equal(progress.getAttribute("aria-valuetext"), "1 of 5 steps done");
  assert.ok(progress.getAttribute("aria-label"));
});

test("the checklist offers a Hide for now submit control inside a form", () => {
  const { document } = renderChecklist(NOTHING_DONE);
  const button = [...document.querySelectorAll("form button")].find((node) => node.textContent?.trim() === "Hide for now");

  assert.ok(button, "Hide for now button must be a form submit");
  assert.equal(button.getAttribute("type"), "submit");
});

test("decorative icons are hidden from assistive technology", () => {
  const { document } = renderChecklist(RESUME_DONE);
  for (const svg of document.querySelectorAll("svg")) {
    assert.equal(svg.getAttribute("aria-hidden"), "true");
  }
});

test("a finished checklist renders nothing, hidden or not", () => {
  assert.equal(renderChecklist(EVERYTHING_DONE).markup, "");
  assert.equal(renderChecklist(EVERYTHING_DONE, true).markup, "");
});

test("a hidden checklist collapses to a one-line summary with a Show checklist control", () => {
  const { document } = renderChecklist({ ...RESUME_DONE, profileReviewed: true }, true);
  const region = document.getElementById(ONBOARDING_CHECKLIST_ANCHOR);

  assert.ok(region, "collapsed summary keeps the anchor so empty-state links still land somewhere useful");
  assert.equal(region.querySelector("ol"), null);
  assert.match(region.textContent ?? "", /2 of 5 steps done/);
  assert.match(region.textContent ?? "", /Set job preferences/);
  const button = [...region.querySelectorAll("form button")].find((node) => node.textContent?.trim() === "Show checklist");
  assert.ok(button);
  assert.equal(button.getAttribute("type"), "submit");
  assert.equal(region.querySelector("button")?.textContent?.includes("Hide for now"), false);
});

test("empty-state hints point into the checklist instead of repeating it", () => {
  const markup = renderToStaticMarkup(createElement(OnboardingSetupHint, {
    checklist: buildOnboardingChecklist(RESUME_DONE)
  }));
  const document = new JSDOM(`<body>${markup}</body>`).window.document;
  const link = document.querySelector("a");

  assert.equal(link?.getAttribute("href"), `#${ONBOARDING_CHECKLIST_ANCHOR}`);
  assert.match(document.body.textContent ?? "", /Review your profile/);
  assert.equal(document.querySelectorAll("li").length, 0, "the hint must not duplicate the step list");

  assert.equal(renderToStaticMarkup(createElement(OnboardingSetupHint, {
    checklist: buildOnboardingChecklist(EVERYTHING_DONE)
  })), "");
});

test("dashboard loads the checklist for the signed-in user and renders it above the metrics", () => {
  const page = readFileSync("app/(product)/dashboard/page.tsx", "utf8");

  assert.match(page, /loadOnboardingChecklist\(userId\)/);
  assert.match(page, /isOnboardingHiddenForUser\(/);
  assert.match(page, /cookies\(\)/);
  assert.match(page, /ONBOARDING_HIDDEN_COOKIE/);
  const checklistIndex = page.indexOf("<OnboardingChecklist");
  const metricsIndex = page.indexOf("<MetricCard");
  assert.ok(checklistIndex > 0, "dashboard must render <OnboardingChecklist");
  assert.ok(checklistIndex < metricsIndex, "checklist renders at the top, before the metric cards");
  assert.match(page, /hideAction=\{hideOnboardingChecklist\}/);
  assert.match(page, /showAction=\{showOnboardingChecklist\}/);
});

test("dashboard empty states hand off to the checklist while setup is unfinished", () => {
  const page = readFileSync("app/(product)/dashboard/page.tsx", "utf8");
  const hints = page.match(/<OnboardingSetupHint\b/g) ?? [];

  assert.ok(hints.length >= 2, "best-matches and follow-up empty states should point into the checklist");
});

test("hide and show are user-scoped server actions that only touch the hide cookie", () => {
  const actions = readFileSync("app/(product)/dashboard/onboarding-actions.ts", "utf8");

  assert.match(actions, /^"use server";/);
  assert.match(actions, /export async function hideOnboardingChecklist/);
  assert.match(actions, /export async function showOnboardingChecklist/);
  assert.equal((actions.match(/requirePageUserId\(\)/g) ?? []).length, 2);
  assert.match(actions, /onboardingHiddenCookieValue\(userId\)/);
  assert.match(actions, /onboardingHiddenCookieOptions\(\)/);
  assert.doesNotMatch(actions, /prisma/);
});
