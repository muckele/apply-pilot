import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { type TestContext } from "node:test";

import { ONBOARDING_APPLIED_STATUSES } from "@/lib/onboarding";
import { loadOnboardingChecklist } from "@/lib/onboarding-loader";
import {
  ONBOARDING_HIDDEN_COOKIE,
  ONBOARDING_HIDE_MAX_AGE_SECONDS,
  isOnboardingHiddenForUser,
  onboardingHiddenCookieOptions,
  onboardingHiddenCookieValue
} from "@/lib/onboarding-preference";
import { prisma } from "@/lib/prisma";

type Calls = Record<string, unknown[]>;

function stub(t: TestContext, owner: object, name: string, replacement: unknown) {
  const methods = owner as Record<string, unknown>;
  const original = methods[name];
  methods[name] = replacement;
  t.after(() => { methods[name] = original; });
}

function stubOnboardingQueries(
  t: TestContext,
  results: {
    parsedMasterResumeCount?: number;
    profile?: unknown;
    discoveryPreference?: unknown;
    jobPostingCount?: number;
    applications?: Array<{ status: string; dateApplied?: Date | null }>;
  } = {}
) {
  const calls: Calls = {
    resumeCount: [],
    profileFindUnique: [],
    preferenceFindUnique: [],
    jobPostingCount: [],
    applicationCount: []
  };
  stub(t, prisma.resume, "count", async (args: unknown) => {
    calls.resumeCount.push(args);
    return results.parsedMasterResumeCount ?? 0;
  });
  stub(t, prisma.userProfile, "findUnique", async (args: unknown) => {
    calls.profileFindUnique.push(args);
    return results.profile ?? null;
  });
  stub(t, prisma.jobDiscoveryPreference, "findUnique", async (args: unknown) => {
    calls.preferenceFindUnique.push(args);
    return results.discoveryPreference ?? null;
  });
  stub(t, prisma.jobPosting, "count", async (args: unknown) => {
    calls.jobPostingCount.push(args);
    return results.jobPostingCount ?? 0;
  });
  stub(t, prisma.application, "count", async (args: unknown) => {
    calls.applicationCount.push(args);
    // Simulate the database for the step 5 filter: dateApplied set OR status in the applied set.
    const where = (args as {
      where: { OR?: Array<{ dateApplied?: { not: null }; status?: { in: readonly string[] } }> };
    }).where;
    const rows = results.applications ?? [];
    const matches = rows.filter((row) => (where.OR ?? []).some((clause) =>
      (clause.dateApplied !== undefined && row.dateApplied != null) ||
      (clause.status !== undefined && clause.status.in.includes(row.status))
    ));
    return Math.min(1, matches.length);
  });
  return calls;
}

test("loader runs one bounded, user-scoped query per step", async (t) => {
  const calls = stubOnboardingQueries(t);

  await loadOnboardingChecklist("user-a");

  assert.deepEqual(calls.resumeCount, [{
    where: { userId: "user-a", isMaster: true, parsedAt: { not: null } },
    take: 1
  }]);
  assert.deepEqual(calls.profileFindUnique, [{
    where: { userId: "user-a" },
    select: { location: true, preferredRoles: true, preferredLocations: true, remotePreference: true }
  }]);
  assert.deepEqual(calls.preferenceFindUnique, [{
    where: { userId: "user-a" },
    select: { targetSearches: true }
  }]);
  assert.deepEqual(calls.jobPostingCount, [{ where: { userId: "user-a" }, take: 1 }]);
  assert.deepEqual(calls.applicationCount, [{
    where: {
      userId: "user-a",
      OR: [{ dateApplied: { not: null } }, { status: { in: [...ONBOARDING_APPLIED_STATUSES] } }]
    },
    take: 1
  }]);
});

test("loader scopes every query to the requested user only", async (t) => {
  const calls = stubOnboardingQueries(t);

  await loadOnboardingChecklist("user-b");

  for (const [name, entries] of Object.entries(calls)) {
    assert.equal(entries.length, 1, name);
    const where = (entries[0] as { where: Record<string, unknown> }).where;
    assert.equal(where.userId, "user-b", name);
  }
});

test("a brand-new account loads an incomplete checklist starting at the master resume", async (t) => {
  stubOnboardingQueries(t);

  const checklist = await loadOnboardingChecklist("new-user");

  assert.equal(checklist.isComplete, false);
  assert.equal(checklist.completedCount, 0);
  assert.equal(checklist.nextStep?.id, "master-resume");
});

test("loader derives profile and preference completion from the stored records", async (t) => {
  stubOnboardingQueries(t, {
    parsedMasterResumeCount: 1,
    profile: {
      location: "",
      preferredRoles: ["Solutions Engineer"],
      preferredLocations: [],
      remotePreference: "REMOTE"
    },
    discoveryPreference: { targetSearches: ["  "] },
    jobPostingCount: 0,
    applications: []
  });

  const checklist = await loadOnboardingChecklist("user-c");

  assert.deepEqual(checklist.steps.map((step) => step.status), ["complete", "complete", "next", "pending", "pending"]);
});

test("loader reports a finished account as complete", async (t) => {
  stubOnboardingQueries(t, {
    parsedMasterResumeCount: 1,
    profile: {
      location: "Los Angeles, CA",
      preferredRoles: ["Product Manager"],
      preferredLocations: [],
      remotePreference: "FLEXIBLE"
    },
    discoveryPreference: { targetSearches: ["Product Manager"] },
    jobPostingCount: 1,
    applications: [{ status: "SAVED" }, { status: "APPLIED" }]
  });

  const checklist = await loadOnboardingChecklist("user-d");

  assert.equal(checklist.isComplete, true);
  assert.equal(checklist.nextStep, null);
});

test("saved or interested applications do not finish the apply step", async (t) => {
  stubOnboardingQueries(t, {
    parsedMasterResumeCount: 1,
    jobPostingCount: 1,
    applications: [{ status: "SAVED" }, { status: "INTERESTED" }]
  });

  const checklist = await loadOnboardingChecklist("user-e");

  assert.notEqual(
    checklist.steps.find((step) => step.id === "first-application")?.status,
    "complete",
    "a manual import creates a SAVED application and must not finish step 5"
  );
  assert.equal(checklist.steps.find((step) => step.id === "first-matches")?.status, "complete");
});

test("an application at or beyond APPLIED finishes the apply step", async (t) => {
  for (const status of ["APPLIED", "RECRUITER_SCREEN", "OFFER", "REJECTED"]) {
    stubOnboardingQueries(t, { applications: [{ status: "SAVED" }, { status }] });
    const checklist = await loadOnboardingChecklist("user-f");
    assert.equal(checklist.steps.find((step) => step.id === "first-application")?.status, "complete", status);
  }
});

test("an archived job that was only ever saved does not finish the apply step", async (t) => {
  stubOnboardingQueries(t, { applications: [{ status: "ARCHIVED", dateApplied: null }] });

  const checklist = await loadOnboardingChecklist("user-g");

  assert.notEqual(checklist.steps.find((step) => step.id === "first-application")?.status, "complete");
});

test("an applied date finishes the apply step even after the job is archived", async (t) => {
  stubOnboardingQueries(t, {
    applications: [{ status: "ARCHIVED", dateApplied: new Date("2026-10-20T00:00:00.000Z") }]
  });

  const checklist = await loadOnboardingChecklist("user-h");

  assert.equal(checklist.steps.find((step) => step.id === "first-application")?.status, "complete");
});

test("the loader stays thin: no full-table reads and no unscoped queries", () => {
  const source = readFileSync("lib/onboarding-loader.ts", "utf8");

  assert.doesNotMatch(source, /findMany/);
  assert.doesNotMatch(source, /\$queryRaw/);
  assert.match(source, /buildOnboardingChecklist/);
});

test("the hide cookie is bound to the signed-in user", () => {
  const value = onboardingHiddenCookieValue("user-a");

  assert.equal(isOnboardingHiddenForUser(value, "user-a"), true);
  assert.equal(isOnboardingHiddenForUser(value, "user-b"), false, "another user on the same browser still sees the checklist");
  assert.equal(isOnboardingHiddenForUser(undefined, "user-a"), false);
  assert.equal(isOnboardingHiddenForUser("", "user-a"), false);
  assert.equal(isOnboardingHiddenForUser("1", "user-a"), false);
  assert.notEqual(value, "user-a", "the raw user id is not stored in the cookie");
  assert.match(value, /^[a-f0-9]{32}$/);
});

test("the hide cookie is httpOnly, lax, scoped to the dashboard, and temporary", () => {
  const options = onboardingHiddenCookieOptions();

  assert.equal(ONBOARDING_HIDDEN_COOKIE, "apply-pilot-onboarding-hidden");
  assert.equal(options.httpOnly, true);
  assert.equal(options.sameSite, "lax");
  assert.equal(options.path, "/dashboard");
  assert.equal(options.maxAge, ONBOARDING_HIDE_MAX_AGE_SECONDS);
  assert.equal(ONBOARDING_HIDE_MAX_AGE_SECONDS, 7 * 24 * 60 * 60);
  assert.equal(onboardingHiddenCookieOptions("production").secure, true);
  assert.equal(onboardingHiddenCookieOptions("development").secure, false);
});
