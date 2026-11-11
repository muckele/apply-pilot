import { createHash } from "node:crypto";

import type { JobPosting, JobSourceType } from "@prisma/client";

import type { NormalizedJob } from "@/lib/job-sources/types";
import { upsertNormalizedJob } from "@/lib/jobs";
import { normalizeText, normalizeUrl } from "@/lib/normalize";
import { prisma } from "@/lib/prisma";

/**
 * Freshness and dedupe rules for imported postings (MVP Bible §6, ingestion rules):
 * - unchanged postings are not rewritten (content fingerprint over the stored fields);
 * - a refresh whose posting content is unchanged keeps what the job match reads, so a paid match
 *   stays current (keepUnchangedMatchContent);
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

// Line breaks, spacing and list bullets are formatting, not content. Text pasted from a posting
// page keeps its line breaks and bullets; the board API text has them flattened and gains a space
// wherever an inline tag sat ("<strong>SQL</strong>," reads "SQL ,").
const formattingOnly = /[\s\u00b7\u2022\u2023\u2043\u25aa\u25ab\u25cb\u25cf\u25e6]+/gu;

function postingText(value: string | null | undefined) {
  return (value ?? "").normalize("NFC").replace(formattingOnly, "");
}

/** A source that does not list a value leaves the stored one in place, as the upsert does. */
function sameUnlessUnlisted<T>(stored: T | undefined, incoming: T | undefined, same: (left: T, right: T) => boolean) {
  return incoming === undefined || (stored !== undefined && same(stored, incoming));
}

function sameNormalizedText(left: string, right: string) {
  return normalizeText(left) === normalizeText(right);
}

/**
 * Requirement and qualification lists are lines taken out of the description, by the board's
 * extractor or by the manual import form. Two extractions of the same text are the same content
 * when every line on both sides is part of that text; a line the text does not contain is new.
 */
function sameExtractedLines(stored: string[], incoming: string[], text: string) {
  const left = stored.map(postingText);
  const right = incoming.map(postingText);
  if (left.length === right.length && left.every((line, index) => line === right[index])) {
    return true;
  }
  return [...left, ...right].every((line) => text.includes(line));
}

function sameTerms(stored: string[], incoming: string[]) {
  const key = (terms: string[]) => [...new Set(terms.map((term) => term.trim().toLowerCase()))].sort().join("\n");
  return key(stored) === key(incoming);
}

/**
 * True when `incoming` says the same as `stored` in every field the job match reads (see
 * buildCurrentJobMatchInput in lib/jobs/current-job-match.ts) and differs at most in formatting
 * or in how its lists were extracted. Any changed word, value or list line counts as a change.
 */
export function hasSameMatchContent(stored: NormalizedJob, incoming: NormalizedJob) {
  const text = postingText(stored.description);
  return (
    text === postingText(incoming.description) &&
    sameNormalizedText(stored.title, incoming.title) &&
    sameNormalizedText(stored.company, incoming.company) &&
    sameUnlessUnlisted(stored.location, incoming.location, sameNormalizedText) &&
    sameUnlessUnlisted(stored.remoteStatus, incoming.remoteStatus, sameNormalizedText) &&
    sameUnlessUnlisted(stored.salaryMin, incoming.salaryMin, Object.is) &&
    sameUnlessUnlisted(stored.salaryMax, incoming.salaryMax, Object.is) &&
    sameExtractedLines(stored.requirements, incoming.requirements, text) &&
    sameExtractedLines(stored.preferredQualifications, incoming.preferredQualifications, text) &&
    sameTerms(stored.detectedTechStack, incoming.detectedTechStack)
  );
}

/**
 * What a refresh should store. When the posting's content did not change, the stored values of
 * every field the job match reads are kept, so a paid (and possibly reviewed) match stays current;
 * provenance and the other fields still come from the source. This also covers a board taking over
 * a job the user imported by hand: the pasted text and the board's text of one unchanged posting
 * differ only in formatting. When the content changed, the source's values replace them.
 */
export function keepUnchangedMatchContent(stored: NormalizedJob, incoming: NormalizedJob): NormalizedJob {
  if (!hasSameMatchContent(stored, incoming)) {
    return incoming;
  }
  return {
    ...incoming,
    title: stored.title,
    company: stored.company,
    location: stored.location,
    remoteStatus: stored.remoteStatus,
    salaryMin: stored.salaryMin,
    salaryMax: stored.salaryMax,
    description: stored.description,
    requirements: stored.requirements,
    preferredQualifications: stored.preferredQualifications,
    detectedTechStack: stored.detectedTechStack
  };
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
      const stored = normalizedJobFromPosting(sameUrl);
      const refreshed = keepUnchangedMatchContent(stored, job);
      if (jobContentFingerprint(stored) === jobContentFingerprint(refreshed)) {
        result.unchanged.push(sameUrl);
      } else {
        result.updated.push(await upsertNormalizedJob({ userId, jobSourceId, job: refreshed }));
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
