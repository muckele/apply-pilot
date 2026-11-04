import { createHash } from "node:crypto";

import type { JobPosting, JobSourceType } from "@prisma/client";

import type { NormalizedJob } from "@/lib/job-sources/types";
import { upsertNormalizedJob } from "@/lib/jobs";
import { normalizeText, normalizeUrl } from "@/lib/normalize";
import { prisma } from "@/lib/prisma";

/**
 * Freshness and dedupe rules for imported postings (MVP Bible §6, ingestion rules):
 * - unchanged postings are not rewritten (content fingerprint over the stored fields);
 * - duplicates are dropped across sources by normalized apply URL, then by normalized
 *   company + title + location;
 * - postings that vanished from their board are marked EXPIRED.
 */

/** Keys seen earlier in the same discovery run, shared by every source in that run. */
export type RunDedupeIndex = {
  applyUrls: Set<string>;
  identities: Map<string, Set<JobSourceType>>;
};

export type PersistResult = {
  created: JobPosting[];
  updated: JobPosting[];
  unchanged: JobPosting[];
  duplicates: number;
};

export type ClosureScope = {
  jobSourceId: string;
  /** Narrows a shared source (the board directory) to one board's company. */
  company?: string;
};

export function createRunDedupeIndex(): RunDedupeIndex {
  return { applyUrls: new Set(), identities: new Map() };
}

export function postingApplyKey(job: Pick<NormalizedJob, "applyUrl" | "sourceUrl">) {
  return normalizeUrl(job.applyUrl ?? job.sourceUrl);
}

export function postingIdentityKey(job: Pick<NormalizedJob, "company" | "title" | "location">) {
  return [normalizeText(job.company), normalizeText(job.title), normalizeText(job.location)].join("|");
}

function postingRowIdentity(posting: JobPosting) {
  return [posting.normalizedCompany, posting.normalizedTitle, posting.normalizedLocation].join("|");
}

export function normalizedJobFromPosting(job: JobPosting): NormalizedJob {
  return {
    title: job.title,
    company: job.company,
    location: job.location ?? undefined,
    remoteStatus: job.remoteStatus ?? undefined,
    salaryMin: job.salaryMin ?? undefined,
    salaryMax: job.salaryMax ?? undefined,
    datePosted: job.datePosted ?? undefined,
    sourceUrl: job.sourceUrl,
    applyUrl: job.applyUrl ?? undefined,
    description: job.description,
    requirements: job.requirements,
    preferredQualifications: job.preferredQualifications,
    benefits: job.benefits,
    detectedTechStack: job.detectedTechStack,
    seniorityLevel: job.seniorityLevel ?? undefined,
    companySize: job.companySize ?? undefined,
    sourceType: job.sourceType
  };
}

function canonical(value: string | number | Date | null | undefined) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  return value === undefined || value === "" ? null : value;
}

/** Hash of every stored content field, so a posting whose content did not change is not rewritten. */
export function jobContentFingerprint(job: NormalizedJob) {
  const content = [
    canonical(job.title),
    canonical(job.company),
    canonical(job.location),
    canonical(job.remoteStatus),
    canonical(job.salaryMin),
    canonical(job.salaryMax),
    canonical(job.datePosted),
    canonical(job.sourceUrl),
    canonical(job.applyUrl),
    canonical(job.description),
    job.requirements,
    job.preferredQualifications,
    job.benefits,
    job.detectedTechStack,
    canonical(job.seniorityLevel),
    canonical(job.companySize),
    job.sourceType
  ];

  return createHash("sha256").update(JSON.stringify(content)).digest("hex");
}

export async function persistCandidates({
  userId,
  jobSourceId,
  candidates,
  index,
  now = new Date()
}: {
  userId: string;
  jobSourceId?: string;
  candidates: NormalizedJob[];
  index: RunDedupeIndex;
  now?: Date;
}): Promise<PersistResult> {
  const result: PersistResult = { created: [], updated: [], unchanged: [], duplicates: 0 };
  if (!candidates.length) {
    return result;
  }

  const applyKeys = [...new Set(candidates.map(postingApplyKey).filter(Boolean))];
  const existing = await prisma.jobPosting.findMany({
    where: {
      userId,
      OR: [
        { normalizedApplyUrl: { in: applyKeys } },
        {
          normalizedCompany: { in: [...new Set(candidates.map((job) => normalizeText(job.company)))] },
          normalizedTitle: { in: [...new Set(candidates.map((job) => normalizeText(job.title)))] }
        }
      ]
    }
  });
  const byApplyKey = new Map<string, JobPosting>();
  const byIdentity = new Map<string, JobPosting[]>();
  for (const posting of existing) {
    byApplyKey.set(posting.normalizedApplyUrl, posting);
    const identity = postingRowIdentity(posting);
    byIdentity.set(identity, [...(byIdentity.get(identity) ?? []), posting]);
  }

  for (const job of candidates) {
    const applyKey = postingApplyKey(job);
    const identity = postingIdentityKey(job);
    const seenSourceTypes = index.identities.get(identity);

    if (
      (applyKey && index.applyUrls.has(applyKey)) ||
      (seenSourceTypes && [...seenSourceTypes].some((type) => type !== job.sourceType))
    ) {
      result.duplicates += 1;
      continue;
    }

    if (applyKey) {
      index.applyUrls.add(applyKey);
    }
    index.identities.set(identity, new Set([...(seenSourceTypes ?? []), job.sourceType]));

    const sameUrl = applyKey ? byApplyKey.get(applyKey) : undefined;
    if (sameUrl && postingRowIdentity(sameUrl) === identity) {
      if (jobContentFingerprint(normalizedJobFromPosting(sameUrl)) === jobContentFingerprint(job)) {
        result.unchanged.push(sameUrl);
      } else {
        result.updated.push(await upsertNormalizedJob({ userId, jobSourceId, job }));
      }
      continue;
    }

    const crossSourceCopy = (byIdentity.get(identity) ?? []).some((posting) => posting.sourceType !== job.sourceType);
    if (sameUrl || crossSourceCopy) {
      result.duplicates += 1;
      continue;
    }

    result.created.push(await upsertNormalizedJob({ userId, jobSourceId, job }));
  }

  if (result.unchanged.length) {
    await prisma.jobPosting.updateMany({
      where: { userId, id: { in: result.unchanged.map((posting) => posting.id) } },
      data: { lastCheckedAt: now }
    });
  }

  return result;
}

/**
 * Marks ACTIVE postings that are no longer listed on their board as EXPIRED. Only ACTIVE
 * postings change; applied, interviewing, archived or user-expired postings are left alone.
 */
export async function closeVanishedPostings({
  userId,
  sourceType,
  scopes,
  listedApplyUrls,
  now = new Date()
}: {
  userId: string;
  sourceType: JobSourceType;
  scopes: ClosureScope[];
  listedApplyUrls: string[];
  now?: Date;
}) {
  if (!scopes.length) {
    return 0;
  }

  const { count } = await prisma.jobPosting.updateMany({
    where: {
      userId,
      sourceType,
      status: "ACTIVE",
      normalizedApplyUrl: { notIn: [...new Set(listedApplyUrls.filter(Boolean))] },
      OR: scopes.map((scope) =>
        scope.company
          ? { jobSourceId: scope.jobSourceId, normalizedCompany: normalizeText(scope.company) }
          : { jobSourceId: scope.jobSourceId }
      )
    },
    data: { status: "EXPIRED", lastCheckedAt: now }
  });

  return count;
}
