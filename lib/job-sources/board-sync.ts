import type { JobPosting, UserProfile } from "@prisma/client";

import { getJobSourceProvider } from "@/lib/job-sources";
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
  duplicates: number;
  closed: number;
  bestRelevanceScore: number;
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

/**
 * Syncs one Greenhouse, Lever or Ashby board for one user: fetch the full public listing,
 * apply the existing deterministic prefilter, keep the strongest `maxImports` matches, store
 * them with cross-source dedupe and unchanged-skip, then expire postings that left the board.
 */
export async function syncBoard({
  userId,
  target,
  queries,
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
  const passing: Array<{ job: NormalizedJob; score: number; order: number }> = [];
  let bestRelevanceScore = 0;

  rawJobs.forEach((rawJob, order) => {
    const normalized = provider.normalizeJob(rawJob);
    const job = { ...normalized, company: normalized.company || target.company };
    listedApplyUrls.push(postingApplyKey(job));

    const evaluation = evaluateForImport({ job, profile, queries, remoteOnly });
    if (evaluation.relevance) {
      bestRelevanceScore = Math.max(bestRelevanceScore, evaluation.relevance.score);
    }
    if (evaluation.passed) {
      passing.push({ job, score: evaluation.relevance.score, order });
    }
  });

  const cap = Math.max(0, Math.trunc(maxImports));
  const selected = passing
    .sort((left, right) => right.score - left.score || left.order - right.order)
    .slice(0, cap)
    .map((entry) => entry.job);
  const persisted = await persistCandidates({ userId, jobSourceId: target.jobSourceId, candidates: selected, index, now });
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
    skipped: rawJobs.length - passing.length,
    capped: Math.max(0, passing.length - cap),
    duplicates: persisted.duplicates,
    closed,
    bestRelevanceScore
  };
}
