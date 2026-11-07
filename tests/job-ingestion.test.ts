import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { JobPosting } from "@prisma/client";

import {
  closeVanishedPostings,
  createRunDedupeIndex,
  jobContentFingerprint,
  normalizedJobFromPosting,
  persistCandidates
} from "@/lib/job-sources/ingestion";
import type { NormalizedJob } from "@/lib/job-sources/types";
import { normalizeText, normalizeUrl } from "@/lib/normalize";
import { prisma } from "@/lib/prisma";

function stub(t: TestContext, owner: object, name: string, replacement: unknown) {
  const methods = owner as Record<string, unknown>;
  const original = methods[name];
  methods[name] = replacement;
  t.after(() => { methods[name] = original; });
}

function job(overrides: Partial<NormalizedJob> = {}): NormalizedJob {
  return {
    title: "Solutions Engineer",
    company: "Example Co",
    location: "Remote - US",
    remoteStatus: "Remote",
    datePosted: new Date("2026-10-30T00:00:00.000Z"),
    sourceUrl: "https://boards.greenhouse.io/example/jobs/1",
    applyUrl: "https://boards.greenhouse.io/example/jobs/1",
    description: "Partner with customers on API integrations.",
    requirements: ["Three years of customer-facing technical work"],
    preferredQualifications: [],
    benefits: [],
    detectedTechStack: ["APIs"],
    sourceType: "GREENHOUSE",
    ...overrides
  };
}

function row(normalized: NormalizedJob, overrides: Partial<JobPosting> = {}): JobPosting {
  return {
    id: "posting-1",
    userId: "user-1",
    jobSourceId: "source-1",
    title: normalized.title,
    normalizedTitle: normalizeText(normalized.title),
    company: normalized.company,
    normalizedCompany: normalizeText(normalized.company),
    location: normalized.location ?? null,
    normalizedLocation: normalizeText(normalized.location),
    remoteStatus: normalized.remoteStatus ?? null,
    salaryMin: normalized.salaryMin ?? null,
    salaryMax: normalized.salaryMax ?? null,
    salaryCurrency: "USD",
    datePosted: normalized.datePosted ?? null,
    sourceUrl: normalized.sourceUrl,
    applyUrl: normalized.applyUrl ?? null,
    normalizedApplyUrl: normalizeUrl(normalized.applyUrl ?? normalized.sourceUrl),
    description: normalized.description,
    requirements: normalized.requirements,
    preferredQualifications: normalized.preferredQualifications,
    benefits: normalized.benefits,
    detectedTechStack: normalized.detectedTechStack,
    seniorityLevel: normalized.seniorityLevel ?? null,
    companySize: normalized.companySize ?? null,
    sourceType: normalized.sourceType,
    status: "ACTIVE",
    overallFitScore: null,
    ...overrides
  } as JobPosting;
}

function database(t: TestContext, existing: JobPosting[]) {
  const upserts: Array<{ create: Record<string, unknown> }> = [];
  const touches: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }> = [];
  const lookups: Array<{ where: Record<string, unknown> }> = [];
  stub(t, prisma.jobPosting, "findMany", async (args: { where: Record<string, unknown> }) => {
    lookups.push(args);
    assert.equal(args.where.userId, "user-1", "existing-posting lookups are scoped to the user");
    return existing;
  });
  stub(t, prisma.jobPosting, "upsert", async (args: { create: Record<string, unknown> }) => {
    upserts.push(args);
    return { ...args.create, id: `created-${upserts.length}` };
  });
  stub(t, prisma.jobPosting, "updateMany", async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
    touches.push(args);
    return { count: 1 };
  });
  return { upserts, touches, lookups };
}

test("the content fingerprint ignores null-versus-undefined but sees real changes", () => {
  const base = job();
  assert.equal(jobContentFingerprint(base), jobContentFingerprint(normalizedJobFromPosting(row(base))));
  assert.equal(jobContentFingerprint({ ...base, location: "" }), jobContentFingerprint({ ...base, location: undefined }));
  assert.notEqual(jobContentFingerprint(base), jobContentFingerprint({ ...base, description: "Changed." }));
  assert.notEqual(jobContentFingerprint(base), jobContentFingerprint({ ...base, salaryMax: 150_000 }));
});

test("new postings are created with their source while unchanged postings are skipped and only touched", async (t) => {
  const unchanged = job({ title: "Implementation Specialist", sourceUrl: "https://boards.greenhouse.io/example/jobs/2", applyUrl: "https://boards.greenhouse.io/example/jobs/2" });
  const db = database(t, [row(unchanged, { id: "existing-unchanged" })]);
  const now = new Date("2026-11-03T12:00:00.000Z");

  const result = await persistCandidates({
    userId: "user-1",
    jobSourceId: "source-1",
    candidates: [job(), unchanged],
    index: createRunDedupeIndex(),
    now
  });

  assert.equal(result.created.length, 1);
  assert.equal(result.updated.length, 0);
  assert.deepEqual(result.unchanged.map((posting) => posting.id), ["existing-unchanged"]);
  assert.equal(db.upserts.length, 1, "the unchanged posting is not rewritten");
  assert.equal(db.upserts[0].create.jobSourceId, "source-1");
  assert.deepEqual(db.touches, [{
    where: { userId: "user-1", id: { in: ["existing-unchanged"] } },
    data: { lastCheckedAt: now }
  }]);
});

test("a changed posting at the same apply URL is updated", async (t) => {
  const stored = job();
  const db = database(t, [row(stored)]);

  const result = await persistCandidates({
    userId: "user-1",
    jobSourceId: "source-1",
    candidates: [job({ description: "Now also covers SQL reporting." })],
    index: createRunDedupeIndex()
  });

  assert.equal(result.updated.length, 1);
  assert.equal(result.created.length, 0);
  assert.equal(db.upserts.length, 1);
});

test("cross-source duplicates are dropped by apply URL first, then by company, title and location", async (t) => {
  const aggregatorCopy = row(job({ sourceType: "REMOTIVE", sourceUrl: "https://remotive.example/jobs/9", applyUrl: "https://remotive.example/jobs/9" }), { id: "aggregator-copy" });
  const sameApplyUrl = row(job({ title: "Solutions Engineer (Remote)", sourceType: "MANUAL", sourceUrl: "https://boards.greenhouse.io/example/jobs/3", applyUrl: "https://boards.greenhouse.io/example/jobs/3" }), { id: "manual-copy" });
  const db = database(t, [aggregatorCopy, sameApplyUrl]);

  const result = await persistCandidates({
    userId: "user-1",
    jobSourceId: "source-1",
    candidates: [
      job(),
      job({ title: "Account Executive", sourceUrl: "https://boards.greenhouse.io/example/jobs/3", applyUrl: "https://boards.greenhouse.io/example/jobs/3?utm_source=feed" })
    ],
    index: createRunDedupeIndex()
  });

  assert.equal(result.duplicates, 2);
  assert.equal(result.created.length, 0);
  assert.equal(db.upserts.length, 0);
});

test("a same-source repost with a new URL is a new posting, not a duplicate", async (t) => {
  const original = row(job({ sourceUrl: "https://boards.greenhouse.io/example/jobs/1", applyUrl: "https://boards.greenhouse.io/example/jobs/1" }));
  const db = database(t, [original]);

  const result = await persistCandidates({
    userId: "user-1",
    jobSourceId: "source-1",
    candidates: [job({ sourceUrl: "https://boards.greenhouse.io/example/jobs/77", applyUrl: "https://boards.greenhouse.io/example/jobs/77" })],
    index: createRunDedupeIndex()
  });

  assert.equal(result.created.length, 1);
  assert.equal(result.duplicates, 0);
  assert.equal(db.upserts.length, 1);
});

test("the run index drops a posting already taken from another source earlier in the same run", async (t) => {
  database(t, []);
  const index = createRunDedupeIndex();

  const board = await persistCandidates({ userId: "user-1", jobSourceId: "board", candidates: [job()], index });
  const aggregator = await persistCandidates({
    userId: "user-1",
    jobSourceId: "aggregator",
    candidates: [
      job({ sourceType: "REMOTIVE", sourceUrl: "https://remotive.example/jobs/9", applyUrl: "https://remotive.example/jobs/9" }),
      job({ sourceType: "REMOTIVE", title: "Different", sourceUrl: "https://boards.greenhouse.io/example/jobs/1#apply" })
    ],
    index
  });

  assert.equal(board.created.length, 1);
  assert.equal(aggregator.created.length, 0);
  assert.equal(aggregator.duplicates, 2);
});

test("closing vanished postings only expires active postings of this user and board scope", async (t) => {
  const calls: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }> = [];
  stub(t, prisma.jobPosting, "updateMany", async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
    calls.push(args);
    return { count: 2 };
  });
  const now = new Date("2026-11-03T12:00:00.000Z");

  const closed = await closeVanishedPostings({
    userId: "user-1",
    sourceType: "GREENHOUSE",
    scopes: [{ jobSourceId: "followed-1" }, { jobSourceId: "directory-gh", company: "Example Co" }],
    listedApplyUrls: ["https://boards.greenhouse.io/example/jobs/1"],
    now
  });

  assert.equal(closed, 2);
  assert.deepEqual(calls, [{
    where: {
      userId: "user-1",
      sourceType: "GREENHOUSE",
      status: "ACTIVE",
      normalizedApplyUrl: { notIn: ["https://boards.greenhouse.io/example/jobs/1"] },
      OR: [{ jobSourceId: "followed-1" }, { jobSourceId: "directory-gh", normalizedCompany: "example co" }]
    },
    data: { status: "EXPIRED", lastCheckedAt: now }
  }]);

  assert.equal(await closeVanishedPostings({ userId: "user-1", sourceType: "GREENHOUSE", scopes: [], listedApplyUrls: [], now }), 0);
  assert.equal(calls.length, 1, "no scope means no write");
});
