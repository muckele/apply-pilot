import type { JobPosting, UserProfile } from "@prisma/client";

import { getJobSourceProvider } from "@/lib/job-sources";
import {
  collapseRepeatedRoles,
  selectBoardImports,
  type BoardImportCandidate
} from "@/lib/job-sources/board-import-selection";
import { boardRegionFromBaseUrl, type BoardAts } from "@/lib/job-sources/board-url";
import {
  closeVanishedPostings,
  persistCandidates,
  postingApplyKey,
  type ClosureScope,
  type RunDedupeIndex
} from "@/lib/job-sources/ingestion";
import { evaluateForImport } from "@/lib/job-sources/prefilter";
import type { NormalizedJob, RawJob } from "@/lib/job-sources/types";
import { prisma } from "@/lib/prisma";

/** Board APIs return the whole board; closure detection needs every listed posting. */
export const ALL_BOARD_JOBS = Number.POSITIVE_INFINITY;

/** One fetch per board per run, shared across users in a cron invocation. */
export type BoardListingCache = Map<string, Promise<RawJob[]>>;

export function createBoardListingCache(): BoardListingCache {
  return new Map();
}

export type BoardTarget = {
  ats: BoardAts;
  token: string;
  baseUrl?: string | null;
  company: string;
  jobSourceId: string;
  closureScopes: ClosureScope[];
};

export type BoardSyncResult = {
  imported: JobPosting[];
  unchanged: JobPosting[];
  listed: number;
  skipped: number;
  capped: number;
  /** Same role listed again for other locations on this board; one listing is kept. */
  otherLocations: number;
  duplicates: number;
  closed: number;
  bestRelevanceScore: number;
  /**
   * Postings the user already has that fail the current filter: refreshed from the board (or
   * only re-checked when unchanged) instead of left stale. Not imports, not scored, not skipped.
   */
  refreshedOutsideFilter: number;
};

function listBoard(target: BoardTarget, cache: BoardListingCache) {
  const key = `${target.ats}:${boardRegionFromBaseUrl(target.baseUrl)}:${target.token.toLowerCase()}`;
  let listing = cache.get(key);

  if (!listing) {
    listing = getJobSourceProvider(target.ats).searchJobs({
      boardToken: target.token,
      url: target.baseUrl ?? undefined,
      limit: ALL_BOARD_JOBS
    });
    cache.set(key, listing);
  }

  return listing;
}

/** Apply URLs among `applyKeys` that this user already has stored. */
async function storedApplyKeys(userId: string, applyKeys: string[]) {
  if (!applyKeys.length) {
    return new Set<string>();
  }
  const rows = await prisma.jobPosting.findMany({
    where: { userId, normalizedApplyUrl: { in: applyKeys } },
    select: { normalizedApplyUrl: true }
  });
  return new Set(rows.map((row) => row.normalizedApplyUrl));
}

/**
 * Syncs one Greenhouse, Lever or Ashby board for one user: fetch the full public listing,
 * apply the existing deterministic prefilter, store up to `maxImports` postings the user does
 * not have yet (see board-import-selection.ts) plus refreshes of the ones they already have,
 * with cross-source dedupe and unchanged-skip, then expire postings that left the board.
 *
 * `queries` are the user's target searches. They always count as roles in the relevance
 * prefilter; `requireQueryMatch: false` (a board the user follows) drops only the keyword match.
 * A posting the user already has is refreshed even when it no longer passes the filter: it is
 * in their jobs, and its board content is the truth about it, as closure already assumes.
 */
export async function syncBoard({
  userId,
  target,
  queries,
  requireQueryMatch = true,
  remoteOnly,
  profile,
  maxImports,
  index,
  listingCache = createBoardListingCache(),
  now = new Date()
}: {
  userId: string;
  target: BoardTarget;
  queries: readonly string[];
  requireQueryMatch?: boolean;
  remoteOnly?: boolean;
  profile: UserProfile | null;
  maxImports: number;
  index: RunDedupeIndex;
  listingCache?: BoardListingCache;
  now?: Date;
}): Promise<BoardSyncResult> {
  const provider = getJobSourceProvider(target.ats);
  const rawJobs = await listBoard(target, listingCache);
  const listedApplyUrls: string[] = [];
  const passing: BoardImportCandidate[] = [];
  const filtered: NormalizedJob[] = [];
  let bestRelevanceScore = 0;

  rawJobs.forEach((rawJob, order) => {
    const normalized = provider.normalizeJob(rawJob);
    const job = { ...normalized, company: normalized.company || target.company };
    listedApplyUrls.push(postingApplyKey(job));

    const evaluation = evaluateForImport({ job, profile, queries, remoteOnly, requireQueryMatch });
    if (evaluation.relevance) {
      bestRelevanceScore = Math.max(bestRelevanceScore, evaluation.relevance.score);
    }
    if (evaluation.passed) {
      passing.push({ job, score: evaluation.relevance.score, decision: evaluation.relevance.decision, order });
    } else {
      filtered.push(job);
    }
  });

  const { kept: distinctRoles, collapsed: otherLocations } = collapseRepeatedRoles(passing);
  const cap = Math.max(0, Math.trunc(maxImports));
  // Only a board with more passing postings than the cap needs to know which ones are stored.
  const stored =
    distinctRoles.length > cap
      ? await storedApplyKeys(userId, [...new Set(distinctRoles.map((entry) => postingApplyKey(entry.job)).filter(Boolean))])
      : new Set<string>();
  const selected = selectBoardImports({
    candidates: distinctRoles,
    alreadyImported: (job) => {
      const applyKey = postingApplyKey(job);
      return stored.has(applyKey) || index.applyUrls.has(applyKey);
    },
    cap,
    now: now.getTime()
  }).map((entry) => entry.job);
  const persisted = await persistCandidates({ userId, jobSourceId: target.jobSourceId, candidates: selected, index, now });
  const refreshed = await persistCandidates({
    userId,
    jobSourceId: target.jobSourceId,
    candidates: filtered,
    index,
    refreshOnly: true,
    now
  });
  const refreshedOutsideFilter = refreshed.updated.length + refreshed.unchanged.length;
  const closed = await closeVanishedPostings({
    userId,
    sourceType: target.ats,
    scopes: target.closureScopes,
    listedApplyUrls,
    now
  });

  return {
    imported: [...persisted.created, ...persisted.updated],
    unchanged: persisted.unchanged,
    listed: rawJobs.length,
    skipped: filtered.length - refreshedOutsideFilter,
    capped: Math.max(0, distinctRoles.length - selected.length),
    otherLocations,
    duplicates: persisted.duplicates,
    closed,
    bestRelevanceScore,
    refreshedOutsideFilter
  };
}
