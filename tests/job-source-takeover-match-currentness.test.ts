import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { JobPosting, UserProfile } from "@prisma/client";

import { getJobSourceProvider } from "@/lib/job-sources";
import { createBoardListingCache, syncBoard, type BoardTarget } from "@/lib/job-sources/board-sync";
import { createRunDedupeIndex, hasSameMatchContent, keepUnchangedMatchContent } from "@/lib/job-sources/ingestion";
import { ManualJobImportProvider } from "@/lib/job-sources/manual";
import type { NormalizedJob } from "@/lib/job-sources/types";
import {
  buildCurrentJobMatchContext,
  buildCurrentJobMatchInput,
  currentJobMatchInputHash,
  hasCurrentJobMatchAnalysis
} from "@/lib/jobs/current-job-match";
import { normalizeText, normalizeUrl } from "@/lib/normalize";
import { prisma } from "@/lib/prisma";

// UX-9 (D035): a scheduled board sync that takes over a job the user imported by hand must not
// make a paid, reviewed match stale when the posting itself did not change. Synthetic data only.

const applyUrl = "https://job-boards.greenhouse.io/northwindlabs/jobs/4012345";

const postingHtml = [
  "<h2>About the role</h2>",
  "<p>Northwind Labs is hiring a <strong>Solutions Engineer</strong> to partner with customers on API integrations.</p>",
  "<p>You’ll own technical discovery for <em>mid-market</em> accounts.</p>",
  "<h2>What you will do</h2>",
  "<ul><li>Run technical discovery calls with prospects and customers</li>",
  "<li>Build <strong>SQL</strong>, REST and webhook demos for evaluations</li></ul>",
  "<h2>What you bring</h2>",
  "<ul><li>Three years of customer-facing technical work</li>",
  "<li>Comfort with Python or JavaScript for small integrations</li></ul>"
].join("");

// What the user pasted into the manual import form from the same posting page.
const pastedDescription = [
  "About the role",
  "Northwind Labs is hiring a Solutions Engineer to partner with customers on API integrations.",
  "You’ll own technical discovery for mid-market accounts.",
  "",
  "What you will do",
  "• Run technical discovery calls with prospects and customers",
  "• Build SQL, REST and webhook demos for evaluations",
  "",
  "What you bring",
  "Three years of customer-facing technical work",
  "Comfort with Python or JavaScript for small integrations"
].join("\n");

// The public board API returns HTML-escaped HTML when content=true.
function escapeHtml(html: string) {
  return html.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function boardListing(html: string) {
  return [{
    id: 4012345,
    title: "Solutions Engineer",
    absolute_url: applyUrl,
    location: { name: "Remote - US" },
    first_published: "2026-10-28T14:00:00.000Z",
    updated_at: "2026-11-09T02:00:00.000Z",
    content: escapeHtml(html)
  }];
}

const resumeUpdatedAt = new Date("2026-11-01T10:00:00.000Z");
const resume = {
  id: "resume-1",
  updatedAt: resumeUpdatedAt,
  summary: "Customer-facing solutions engineer.",
  rawText: "Customer-facing solutions engineer.\nBuilt API integrations and SQL reports.",
  skills: ["SQL", "Python"],
  achievements: [],
  workHistory: [],
  projects: [],
  education: [],
  certifications: []
};

const reviewedSnapshot = {
  id: "snapshot-reviewed",
  resumeId: resume.id,
  sourceResumeUpdatedAt: resumeUpdatedAt,
  snapshotHash: "c".repeat(64),
  reviewPayload: {
    schema: "apply-pilot/evidence-snapshot-payload/v2",
    facts: [{
      factId: "fact:1",
      originGapId: "gap:0",
      fact: "Built webhook demos for customer evaluations.",
      provenance: { kind: "OWNER_ATTESTED", ownerAttested: true },
      reuseScope: "JOB_ONLY",
      masterProfileOptIn: false
    }],
    unresolvedGapIds: []
  }
};

type StoredPosting = JobPosting & { currentEvidenceSnapshot: typeof reviewedSnapshot | null };

function manuallyImportedPosting(): StoredPosting {
  const job: NormalizedJob = new ManualJobImportProvider().normalizeJob({
    title: "Solutions Engineer",
    company: "Northwind Labs",
    location: "Remote - US",
    remoteStatus: "Remote",
    sourceUrl: applyUrl,
    applyUrl,
    description: pastedDescription
  });
  return {
    id: "posting-1",
    userId: "user-1",
    jobSourceId: null,
    title: job.title,
    normalizedTitle: normalizeText(job.title),
    company: job.company,
    normalizedCompany: normalizeText(job.company),
    location: job.location ?? null,
    normalizedLocation: normalizeText(job.location),
    remoteStatus: job.remoteStatus ?? null,
    salaryMin: job.salaryMin ?? null,
    salaryMax: job.salaryMax ?? null,
    salaryCurrency: "USD",
    datePosted: job.datePosted ?? null,
    sourceUrl: job.sourceUrl,
    applyUrl: job.applyUrl ?? null,
    normalizedApplyUrl: normalizeUrl(job.applyUrl ?? job.sourceUrl),
    description: job.description,
    requirements: job.requirements,
    preferredQualifications: job.preferredQualifications,
    benefits: job.benefits,
    detectedTechStack: job.detectedTechStack,
    seniorityLevel: job.seniorityLevel ?? null,
    companySize: job.companySize ?? null,
    sourceType: job.sourceType,
    status: "ACTIVE",
    overallFitScore: 88,
    confidenceScore: 90,
    currentEvidenceSnapshotId: reviewedSnapshot.id,
    evidenceSnapshotGeneration: 1,
    currentEvidenceSnapshot: reviewedSnapshot
  } as StoredPosting;
}

function matchContext(job: StoredPosting) {
  return buildCurrentJobMatchContext({ job, resume, profile: null });
}

function reviewedAnalysisFor(job: StoredPosting) {
  const context = matchContext(job);
  assert.equal(context.effectiveEvidenceSnapshotId, reviewedSnapshot.id, "the fixture's reviewed evidence is valid");
  return { inputHash: currentJobMatchInputHash(context.matchInput), evidenceSnapshotId: reviewedSnapshot.id };
}

function reviewedMatchIsCurrent(job: StoredPosting, analysis: { inputHash: string; evidenceSnapshotId: string }) {
  const context = matchContext(job);
  return hasCurrentJobMatchAnalysis({
    currentEvidenceSnapshotId: job.currentEvidenceSnapshotId,
    currentEvidenceSourceValid: context.currentEvidenceSourceValid,
    aiAnalyses: [analysis]
  }, context.matchInput);
}

function stub(t: TestContext, owner: object, name: string, replacement: unknown) {
  const methods = owner as Record<string, unknown>;
  const original = methods[name];
  methods[name] = replacement;
  t.after(() => { methods[name] = original; });
}

const profile = {
  userId: "user-1",
  industriesOfInterest: [],
  preferredLocations: [],
  location: "",
  remotePreference: "FLEXIBLE",
  preferredRoles: ["Solutions Engineer"],
  skillsToEmphasize: [],
  dealBreakers: [],
  salaryTargetMin: null,
  salaryTargetMax: null
} as unknown as UserProfile;

const target: BoardTarget = {
  ats: "GREENHOUSE",
  token: "northwindlabs",
  company: "Northwind Labs",
  jobSourceId: "board-source-1",
  closureScopes: [{ jobSourceId: "board-source-1" }]
};

/** One stored posting behind the Prisma calls a board sync makes, with Prisma's update semantics. */
function postingTable(t: TestContext, initial: StoredPosting, listing: () => Record<string, unknown>[]) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    throw new Error(`Unexpected network request in test: ${String(input)}`);
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  stub(t, getJobSourceProvider("GREENHOUSE"), "searchJobs", async () => listing());

  const state = { current: initial, upserts: 0, touches: 0 };
  stub(t, prisma.jobPosting, "findMany", async (args: { where: Record<string, unknown> }) => {
    assert.equal(args.where.userId, "user-1");
    return [state.current];
  });
  stub(t, prisma.jobPosting, "upsert", async (args: {
    where: { userId_normalizedCompany_normalizedTitle_normalizedLocation_normalizedApplyUrl: Record<string, string> };
    update: Record<string, unknown>;
  }) => {
    const key = args.where.userId_normalizedCompany_normalizedTitle_normalizedLocation_normalizedApplyUrl;
    assert.deepEqual(key, {
      userId: state.current.userId,
      normalizedCompany: state.current.normalizedCompany,
      normalizedTitle: state.current.normalizedTitle,
      normalizedLocation: state.current.normalizedLocation,
      normalizedApplyUrl: state.current.normalizedApplyUrl
    }, "the sync updates the stored posting instead of creating another one");
    state.upserts += 1;
    // Prisma leaves a column untouched when its update value is undefined.
    const changes = Object.fromEntries(Object.entries(args.update).filter(([, value]) => value !== undefined));
    state.current = { ...state.current, ...changes } as StoredPosting;
    return state.current;
  });
  stub(t, prisma.jobPosting, "updateMany", async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
    if ("status" in args.where) {
      const listed = (args.where.normalizedApplyUrl as { notIn: string[] }).notIn;
      assert.ok(listed.includes(state.current.normalizedApplyUrl), "a listed posting is never expired");
      return { count: 0 };
    }
    state.touches += 1;
    state.current = { ...state.current, ...args.data } as StoredPosting;
    return { count: 1 };
  });
  return state;
}

function nightlySync(now: Date) {
  return syncBoard({
    userId: "user-1",
    target,
    queries: ["Solutions Engineer"],
    profile,
    maxImports: 8,
    index: createRunDedupeIndex(),
    listingCache: createBoardListingCache(),
    now
  });
}

function matchJobFields(job: StoredPosting) {
  return buildCurrentJobMatchInput({ job, resume: null, profile: null }).job;
}

test("a board sync of an unchanged posting over a manually imported job keeps the reviewed score current", async (t) => {
  const imported = manuallyImportedPosting();
  const analysis = reviewedAnalysisFor(imported);
  assert.equal(reviewedMatchIsCurrent(imported, analysis), true, "the reviewed 88 is current before the sync");
  const table = postingTable(t, imported, () => boardListing(postingHtml));

  await nightlySync(new Date("2026-11-10T03:00:00.000Z"));

  assert.equal(table.current.sourceType, "GREENHOUSE", "the board sync took the job over");
  assert.deepEqual(matchJobFields(table.current), matchJobFields(imported), "nothing the match reads was rewritten");
  assert.equal(reviewedMatchIsCurrent(table.current, analysis), true, "the reviewed score is still current");

  const upsertsAfterTakeover = table.upserts;
  const nextNight = await nightlySync(new Date("2026-11-11T03:00:00.000Z"));

  assert.equal(nextNight.unchanged.length, 1, "the next night sees the same posting as unchanged");
  assert.equal(table.upserts, upsertsAfterTakeover, "an unchanged posting is not rewritten again");
  assert.equal(reviewedMatchIsCurrent(table.current, analysis), true, "the reviewed score stays current on later nights");
});

test("a board sync of a changed posting over a manually imported job makes the reviewed score stale", async (t) => {
  const changes = [
    ["a new requirement", postingHtml.replace(
      "</li></ul><h2>What you bring",
      "</li><li>Own the renewal forecast for your territory</li></ul><h2>What you bring"
    )],
    ["a reworded sentence", postingHtml.replace("mid-market", "enterprise")],
    ["a removed requirement", postingHtml.replace("<li>Three years of customer-facing technical work</li>", "")]
  ] as const;

  for (const [change, html] of changes) {
    await t.test(change, async (st) => {
      assert.notEqual(html, postingHtml, "the fixture really changes the posting");
      const imported = manuallyImportedPosting();
      const analysis = reviewedAnalysisFor(imported);
      const table = postingTable(st, imported, () => boardListing(html));

      await nightlySync(new Date("2026-11-10T03:00:00.000Z"));

      assert.equal(table.current.sourceType, "GREENHOUSE");
      assert.notEqual(table.current.description, imported.description, "the board's changed text is stored");
      assert.equal(reviewedMatchIsCurrent(table.current, analysis), false, "the reviewed score is out of date");
    });
  }
});

function boardJob(overrides: Partial<NormalizedJob> = {}): NormalizedJob {
  return {
    ...getJobSourceProvider("GREENHOUSE").normalizeJob(boardListing(postingHtml)[0]),
    company: "Northwind Labs",
    ...overrides
  };
}

function pastedJob(overrides: Partial<NormalizedJob> = {}): NormalizedJob {
  return {
    ...new ManualJobImportProvider().normalizeJob({
      title: "Solutions Engineer",
      company: "Northwind Labs",
      location: "Remote - US",
      remoteStatus: "Remote",
      sourceUrl: applyUrl,
      applyUrl,
      description: pastedDescription
    }),
    ...overrides
  };
}

test("the same posting pasted by hand and read from the board API is the same match content", () => {
  const stored = pastedJob();
  const incoming = boardJob();
  assert.notEqual(stored.description, incoming.description, "the two texts really differ in formatting");
  assert.equal(hasSameMatchContent(stored, incoming), true);

  const kept = keepUnchangedMatchContent(stored, incoming);
  assert.deepEqual(
    buildCurrentJobMatchInput({ job: kept, resume: null, profile: null }).job,
    buildCurrentJobMatchInput({ job: stored, resume: null, profile: null }).job,
    "every field the match reads keeps its stored value"
  );
  assert.equal(kept.sourceType, "GREENHOUSE", "provenance still comes from the source");
  assert.equal(kept.datePosted?.toISOString(), "2026-10-28T14:00:00.000Z");
});

test("a value the source does not list is not a change, because the stored value stays", () => {
  const stored = pastedJob({ salaryMin: 120_000, salaryMax: 150_000, remoteStatus: "Remote" });
  assert.equal(hasSameMatchContent(stored, boardJob({ salaryMin: undefined, salaryMax: undefined, remoteStatus: undefined })), true);
});

test("any real difference in what the match reads is a change", () => {
  const stored = pastedJob({ salaryMin: 120_000, salaryMax: 150_000 });
  const changes: Array<[string, Partial<NormalizedJob>]> = [
    ["one word of the description", { description: boardJob().description.replace("mid-market", "enterprise") }],
    ["letter case in the description", { description: boardJob().description.replace("SQL", "sql") }],
    ["a different salary", { salaryMin: 130_000 }],
    ["a different work style", { remoteStatus: "Hybrid" }],
    ["a different location", { location: "Remote - Canada" }],
    ["a requirement the text does not contain", { requirements: [...boardJob().requirements, "Own the renewal forecast for your territory"] }],
    ["a preferred qualification the text does not contain", { preferredQualifications: ["Five years of Kubernetes administration"] }],
    ["a different detected tech stack", { detectedTechStack: ["SQL"] }]
  ];

  for (const [change, overrides] of changes) {
    const incoming = boardJob(overrides);
    assert.equal(hasSameMatchContent(stored, incoming), false, change);
    assert.equal(keepUnchangedMatchContent(stored, incoming) === incoming, true, `${change}: the source's values are stored`);
  }
});

test("a stored line that the posting text does not contain is not silently kept", () => {
  // Preferred qualifications typed in the user's own words cannot be matched to the board's text.
  const stored = pastedJob({ preferredQualifications: ["Has run customer workshops before"] });
  assert.equal(hasSameMatchContent(stored, boardJob()), false);
});

test("the kept fields cover every posting field the job match reads", () => {
  // If the match starts reading another posting field, keepUnchangedMatchContent must keep it too.
  assert.deepEqual(Object.keys(buildCurrentJobMatchInput({ job: pastedJob(), resume: null, profile: null }).job).sort(), [
    "company",
    "description",
    "detectedTechStack",
    "location",
    "preferredQualifications",
    "remoteStatus",
    "requirements",
    "salaryMax",
    "salaryMin",
    "title"
  ]);
});
