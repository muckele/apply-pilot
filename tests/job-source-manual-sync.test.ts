import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { AISettings, JobDiscoveryPreference, JobPosting, JobSource, UserProfile } from "@prisma/client";

import { getJobSourceProvider } from "@/lib/job-sources";
import { runJobSourceSync } from "@/lib/job-sources/source-management";
import { normalizeText, normalizeUrl } from "@/lib/normalize";
import { prisma } from "@/lib/prisma";
import { jobSourceSyncSchema } from "@/lib/validators";

// The Job Sources page's Sync button on a followed board: it sends only `{ limit: 25 }`, so the
// run must fall back to the same target searches and remote-only choice scheduled discovery uses.

function stub(t: TestContext, owner: object, name: string, replacement: unknown) {
  const methods = owner as Record<string, unknown>;
  const original = methods[name];
  methods[name] = replacement;
  t.after(() => { methods[name] = original; });
}

const source = {
  id: "source-followed",
  userId: "user-1",
  name: "Synthetic Co",
  type: "ASHBY",
  baseUrl: null,
  boardToken: "synthetic",
  allowlisted: true,
  robotsChecked: true,
  lastSyncedAt: null,
  lastSyncStatus: null,
  lastSyncError: null,
  syncEnabled: true,
  notes: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z")
} as JobSource;

// The profile names a different role, so only the saved target search makes this title relevant.
const profile = {
  userId: "user-1",
  industriesOfInterest: ["SaaS"],
  preferredLocations: ["Remote", "Chicago, IL"],
  location: "",
  remotePreference: "FLEXIBLE",
  preferredRoles: ["Customer Success Manager"],
  skillsToEmphasize: [],
  dealBreakers: [],
  salaryTargetMin: null,
  salaryTargetMax: null
} as unknown as UserProfile;

function preference(overrides: Partial<JobDiscoveryPreference> = {}): JobDiscoveryPreference {
  return {
    id: "preference-1",
    userId: "user-1",
    targetSearches: ["Technical Support Engineer"],
    location: "",
    limitPerQuery: 8,
    remoteOnly: false,
    scoreImported: false,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides
  } as JobDiscoveryPreference;
}

const body = "Partner with customers on technical discovery, API integrations, SaaS onboarding, troubleshooting, workflows, and training.";

function ashbyJob(slug: string, title: string, location = "Remote", description = body) {
  return {
    title,
    location,
    isRemote: location === "Remote",
    isListed: true,
    jobUrl: `https://jobs.ashbyhq.com/synthetic/${slug}`,
    applyUrl: `https://jobs.ashbyhq.com/synthetic/${slug}/application`,
    descriptionPlain: description
  };
}

function storedPosting(raw: ReturnType<typeof ashbyJob>, overrides: Partial<JobPosting> = {}): JobPosting {
  const normalized = getJobSourceProvider("ASHBY").normalizeJob(raw);
  const company = normalized.company || source.name;
  return {
    id: `stored-${raw.title}`,
    userId: "user-1",
    jobSourceId: source.id,
    title: normalized.title,
    company,
    location: normalized.location ?? null,
    remoteStatus: normalized.remoteStatus ?? null,
    salaryMin: null,
    salaryMax: null,
    datePosted: normalized.datePosted ?? null,
    sourceType: "ASHBY",
    sourceUrl: normalized.sourceUrl,
    applyUrl: normalized.applyUrl ?? null,
    description: normalized.description,
    requirements: normalized.requirements,
    preferredQualifications: normalized.preferredQualifications,
    benefits: normalized.benefits,
    detectedTechStack: normalized.detectedTechStack,
    seniorityLevel: normalized.seniorityLevel ?? null,
    companySize: null,
    normalizedApplyUrl: normalizeUrl(normalized.applyUrl ?? normalized.sourceUrl),
    normalizedCompany: normalizeText(company),
    normalizedTitle: normalizeText(normalized.title),
    normalizedLocation: normalizeText(normalized.location ?? ""),
    ...overrides
  } as JobPosting;
}

function setup(
  t: TestContext,
  {
    listing,
    saved,
    stored = []
  }: { listing: Array<ReturnType<typeof ashbyJob>>; saved: JobDiscoveryPreference | null; stored?: JobPosting[] }
) {
  const upserts: Array<{ create: Record<string, unknown> }> = [];
  stub(t, getJobSourceProvider("ASHBY"), "searchJobs", async () => listing);
  stub(t, prisma.jobSource, "updateMany", async () => ({ count: 1 }));
  stub(t, prisma.jobSource, "update", async () => source);
  stub(t, prisma.userProfile, "findUnique", async () => profile);
  stub(t, prisma.jobDiscoveryPreference, "findUnique", async ({ where }: { where: { userId: string } }) => {
    assert.equal(where.userId, "user-1");
    return saved;
  });
  stub(t, prisma.aISettings, "upsert", async () => ({
    id: "settings-1",
    userId: "user-1",
    monthlyBudgetCents: 500,
    automationBudgetCents: 150,
    maxAnalysesPerSync: 5,
    aiDiscoveryEnabled: false,
    modelOverride: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z")
  } satisfies AISettings));
  stub(t, prisma.jobPosting, "findMany", async ({ where }: { where: { userId: string } }) => {
    assert.equal(where.userId, "user-1");
    return stored;
  });
  stub(t, prisma.jobPosting, "upsert", async (args: { create: Record<string, unknown> }) => {
    upserts.push(args);
    return { ...args.create, id: `posting-${upserts.length}` };
  });
  stub(t, prisma.jobPosting, "updateMany", async () => ({ count: 0 }));
  return { upserts };
}

// Exactly what the Sync button posts, through the route's own schema.
const syncButtonOptions = () => jobSourceSyncSchema.parse({ limit: 25 });

test("a plain Sync of a followed board judges titles against the owner's saved target searches", async (t) => {
  const db = setup(t, {
    listing: [ashbyJob("tse", "Technical Support Engineer")],
    saved: preference()
  });

  const result = await runJobSourceSync({ userId: "user-1", source, options: syncButtonOptions() });

  assert.deepEqual(db.upserts.map((upsert) => upsert.create.title), ["Technical Support Engineer"]);
  assert.equal(result.imported.length, 1);
  assert.equal(result.skipped, 0);
});

test("a followed board's Sync does not require keyword matches with the target searches", async (t) => {
  // "Customer Success Manager" is a profile role; the saved search is a different role.
  const db = setup(t, {
    listing: [ashbyJob("csm", "Customer Success Manager", "Remote", body.replace("technical discovery", "account reviews"))],
    saved: preference()
  });

  await runJobSourceSync({ userId: "user-1", source, options: syncButtonOptions() });

  assert.deepEqual(db.upserts.map((upsert) => upsert.create.title), ["Customer Success Manager"]);
});

test("a plain Sync honours the saved remote-only choice; an explicit request value wins", async (t) => {
  const onsite = ashbyJob("tse-chicago", "Technical Support Engineer", "Chicago, IL");

  const remoteOnly = setup(t, { listing: [onsite], saved: preference({ remoteOnly: true }) });
  const filtered = await runJobSourceSync({ userId: "user-1", source, options: syncButtonOptions() });
  assert.equal(remoteOnly.upserts.length, 0, "the saved remote-only choice filters an onsite posting");
  assert.equal(filtered.skipped, 1);

  const explicit = setup(t, { listing: [onsite], saved: preference({ remoteOnly: true }) });
  await runJobSourceSync({ userId: "user-1", source, options: jobSourceSyncSchema.parse({ limit: 25, remoteOnly: false }) });
  assert.equal(explicit.upserts.length, 1, "a request that sets remoteOnly itself is not overridden");
});

test("a Sync request's own query still narrows the board to keyword matches", async (t) => {
  const db = setup(t, {
    listing: [ashbyJob("tse", "Technical Support Engineer")],
    saved: preference()
  });

  const result = await runJobSourceSync({
    userId: "user-1",
    source,
    options: jobSourceSyncSchema.parse({ limit: 25, query: "Data Scientist" })
  });

  assert.equal(db.upserts.length, 0);
  assert.equal(result.skipped, 1);
});

test("a stored posting that no longer passes the filter is refreshed, not imported, scored or skipped", async (t) => {
  const kept = ashbyJob("tse", "Technical Support Engineer");
  const stale = storedPosting(kept, { description: "An older copy of the posting." });
  const unchanged = ashbyJob("tam", "Technical Account Manager");
  const db = setup(t, {
    listing: [kept, unchanged, ashbyJob("de", "Data Engineer")],
    // Target searches that no longer name any of these roles.
    saved: preference({ targetSearches: ["Payroll Specialist"] }),
    stored: [stale, storedPosting(unchanged)]
  });

  const result = await runJobSourceSync({ userId: "user-1", source, options: syncButtonOptions() });

  assert.deepEqual(
    db.upserts.map((upsert) => [upsert.create.title, upsert.create.description]),
    [["Technical Support Engineer", body]],
    "only the changed stored posting is rewritten; the new filtered posting is not stored"
  );
  assert.equal(result.imported.length, 0, "a refresh outside the filter is not an import");
  assert.equal(result.unchanged.length, 0, "and it does not join the AI scoring pool");
  assert.equal(result.refreshedOutsideFilter, 2, "both stored postings were checked against the board");
  assert.equal(result.skipped, 1, "only the posting the owner does not have counts as filtered");
});
