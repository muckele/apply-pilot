import assert from "node:assert/strict";
import test from "node:test";

import {
  ONBOARDING_STEP_IDS,
  buildOnboardingChecklist,
  hasOnboardingJobPreferences,
  isOnboardingProfileReviewed,
  resolveOnboardingChecklistDisplay,
  type OnboardingSignals
} from "@/lib/onboarding";

const NOTHING_DONE: OnboardingSignals = {
  parsedMasterResumeCount: 0,
  profileReviewed: false,
  jobPreferencesSet: false,
  jobPostingCount: 0,
  applicationCount: 0
};

const EVERYTHING_DONE: OnboardingSignals = {
  parsedMasterResumeCount: 1,
  profileReviewed: true,
  jobPreferencesSet: true,
  jobPostingCount: 1,
  applicationCount: 1
};

test("a brand-new account sees five ordered steps with the master resume as the next step", () => {
  const checklist = buildOnboardingChecklist(NOTHING_DONE);

  assert.deepEqual(checklist.steps.map((step) => step.id), [...ONBOARDING_STEP_IDS]);
  assert.deepEqual(checklist.steps.map((step) => step.id), [
    "master-resume",
    "profile",
    "job-preferences",
    "first-matches",
    "first-application"
  ]);
  assert.deepEqual(checklist.steps.map((step) => step.number), [1, 2, 3, 4, 5]);
  assert.deepEqual(checklist.steps.map((step) => step.status), ["next", "pending", "pending", "pending", "pending"]);
  assert.equal(checklist.completedCount, 0);
  assert.equal(checklist.totalCount, 5);
  assert.equal(checklist.isComplete, false);
  assert.equal(checklist.nextStep?.id, "master-resume");
});

test("each step links to the product page where the user can complete it", () => {
  const checklist = buildOnboardingChecklist(NOTHING_DONE);
  const hrefs = Object.fromEntries(checklist.steps.map((step) => [step.id, step.href]));

  assert.deepEqual(hrefs, {
    "master-resume": "/resumes",
    profile: "/settings/profile",
    "job-preferences": "/jobs",
    "first-matches": "/jobs",
    "first-application": "/jobs"
  });
});

test("every step has a title, a description, and a distinct action label", () => {
  const checklist = buildOnboardingChecklist(NOTHING_DONE);

  assert.deepEqual(checklist.steps.map((step) => step.title), [
    "Upload your master resume",
    "Review your profile",
    "Set job preferences",
    "See your first matches",
    "Track your first application"
  ]);
  for (const step of checklist.steps) {
    assert.ok(step.description.trim().length > 20, step.id);
    assert.ok(step.actionLabel.trim().length > 0, step.id);
  }
  const labels = checklist.steps.map((step) => step.actionLabel);
  assert.equal(new Set(labels).size, labels.length, "action labels must be distinguishable for screen readers");
});

test("each signal completes exactly its own step", () => {
  const cases: Array<[Partial<OnboardingSignals>, string]> = [
    [{ parsedMasterResumeCount: 1 }, "master-resume"],
    [{ profileReviewed: true }, "profile"],
    [{ jobPreferencesSet: true }, "job-preferences"],
    [{ jobPostingCount: 3 }, "first-matches"],
    [{ applicationCount: 2 }, "first-application"]
  ];

  for (const [signal, expectedCompleteId] of cases) {
    const checklist = buildOnboardingChecklist({ ...NOTHING_DONE, ...signal });
    const completeIds = checklist.steps.filter((step) => step.status === "complete").map((step) => step.id);
    assert.deepEqual(completeIds, [expectedCompleteId], JSON.stringify(signal));
    assert.equal(checklist.completedCount, 1);
  }
});

test("the next step is the first incomplete step even when later steps finished first", () => {
  const checklist = buildOnboardingChecklist({
    ...NOTHING_DONE,
    parsedMasterResumeCount: 1,
    jobPostingCount: 4,
    applicationCount: 1
  });

  assert.deepEqual(checklist.steps.map((step) => step.status), ["complete", "next", "pending", "complete", "complete"]);
  assert.equal(checklist.nextStep?.id, "profile");
  assert.equal(checklist.completedCount, 3);
  assert.equal(checklist.isComplete, false);
});

test("only one step is ever highlighted as next", () => {
  const signals: OnboardingSignals[] = [
    NOTHING_DONE,
    { ...NOTHING_DONE, parsedMasterResumeCount: 1 },
    { ...NOTHING_DONE, parsedMasterResumeCount: 1, profileReviewed: true },
    { ...EVERYTHING_DONE, applicationCount: 0 }
  ];

  for (const signal of signals) {
    const checklist = buildOnboardingChecklist(signal);
    assert.equal(checklist.steps.filter((step) => step.status === "next").length, 1);
    assert.equal(checklist.nextStep, checklist.steps.find((step) => step.status === "next"));
  }
});

test("a finished account is complete with no next step", () => {
  const checklist = buildOnboardingChecklist(EVERYTHING_DONE);

  assert.equal(checklist.isComplete, true);
  assert.equal(checklist.completedCount, 5);
  assert.equal(checklist.nextStep, null);
  assert.ok(checklist.steps.every((step) => step.status === "complete"));
});

test("invalid or non-positive counts never complete a step", () => {
  for (const count of [0, -1, Number.NaN, Number.NEGATIVE_INFINITY, 0.5]) {
    const checklist = buildOnboardingChecklist({
      ...EVERYTHING_DONE,
      parsedMasterResumeCount: count,
      jobPostingCount: count,
      applicationCount: count
    });
    assert.deepEqual(
      checklist.steps.filter((step) => step.status !== "complete").map((step) => step.id),
      ["master-resume", "first-matches", "first-application"],
      String(count)
    );
  }
});

test("large counts complete their step", () => {
  const checklist = buildOnboardingChecklist({ ...EVERYTHING_DONE, jobPostingCount: 4_000, applicationCount: 250 });
  assert.equal(checklist.isComplete, true);
});

test("building a checklist does not mutate shared step definitions between calls", () => {
  const first = buildOnboardingChecklist(EVERYTHING_DONE);
  const second = buildOnboardingChecklist(NOTHING_DONE);

  assert.equal(first.steps[0].status, "complete");
  assert.equal(second.steps[0].status, "next");
  assert.notEqual(first.steps[0], second.steps[0]);
});

test("profile review requires a target role and somewhere to work", () => {
  const base = {
    location: "",
    preferredRoles: [] as string[],
    preferredLocations: [] as string[],
    remotePreference: "FLEXIBLE"
  };

  assert.equal(isOnboardingProfileReviewed(null), false);
  assert.equal(isOnboardingProfileReviewed(undefined), false);
  assert.equal(isOnboardingProfileReviewed(base), false);
  assert.equal(isOnboardingProfileReviewed({ ...base, location: "Los Angeles, CA" }), false, "location alone is not enough");
  assert.equal(isOnboardingProfileReviewed({ ...base, preferredRoles: ["Product Manager"] }), false, "roles alone are not enough");
  assert.equal(
    isOnboardingProfileReviewed({ ...base, preferredRoles: ["Product Manager"], location: "Los Angeles, CA" }),
    true
  );
  assert.equal(
    isOnboardingProfileReviewed({ ...base, preferredRoles: ["Product Manager"], preferredLocations: ["Seattle"] }),
    true
  );
  assert.equal(
    isOnboardingProfileReviewed({ ...base, preferredRoles: ["Product Manager"], remotePreference: "REMOTE" }),
    true,
    "remote-only work style counts as where to work"
  );
  for (const remotePreference of ["FLEXIBLE", "HYBRID", "ONSITE"]) {
    assert.equal(
      isOnboardingProfileReviewed({ ...base, preferredRoles: ["Product Manager"], remotePreference }),
      false,
      remotePreference
    );
  }
});

test("profile review ignores blank and whitespace-only values", () => {
  assert.equal(
    isOnboardingProfileReviewed({
      location: "   ",
      preferredRoles: ["  ", ""],
      preferredLocations: [" "],
      remotePreference: "FLEXIBLE"
    }),
    false
  );
  assert.equal(
    isOnboardingProfileReviewed({
      location: "   ",
      preferredRoles: ["  ", "Designer"],
      preferredLocations: ["", " Austin "],
      remotePreference: "FLEXIBLE"
    }),
    true
  );
  assert.equal(
    isOnboardingProfileReviewed({ location: null, preferredRoles: null, preferredLocations: null, remotePreference: null }),
    false
  );
});

test("job preferences require a saved preference with at least one non-blank target search", () => {
  assert.equal(hasOnboardingJobPreferences(null), false);
  assert.equal(hasOnboardingJobPreferences(undefined), false);
  assert.equal(hasOnboardingJobPreferences({ targetSearches: [] }), false);
  assert.equal(hasOnboardingJobPreferences({ targetSearches: ["", "   "] }), false);
  assert.equal(hasOnboardingJobPreferences({ targetSearches: null }), false);
  assert.equal(hasOnboardingJobPreferences({ targetSearches: ["Staff engineer"] }), true);
  assert.equal(hasOnboardingJobPreferences({ targetSearches: ["  ", "remote data analyst"] }), true);
});

test("display is full until hidden, collapsed while hidden, and gone once complete", () => {
  const incomplete = buildOnboardingChecklist(NOTHING_DONE);
  const complete = buildOnboardingChecklist(EVERYTHING_DONE);

  assert.equal(resolveOnboardingChecklistDisplay(incomplete, { hidden: false }), "full");
  assert.equal(resolveOnboardingChecklistDisplay(incomplete, { hidden: true }), "collapsed");
  assert.equal(resolveOnboardingChecklistDisplay(complete, { hidden: false }), "none");
  assert.equal(resolveOnboardingChecklistDisplay(complete, { hidden: true }), "none");
});
