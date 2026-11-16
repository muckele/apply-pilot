import type { JobPosting, UserProfile } from "@prisma/client";

import { getJobSourceProvider } from "@/lib/job-sources";
import { checkAshbyHostedPage, type HostedPageState } from "@/lib/job-sources/ashby-hosted-page";
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
import type { RawJob } from "@/lib/job-sources/types";
import { prisma } from "@/lib/prisma";

/** Board APIs return the whole board; closure detection needs every listed posting. */
export const ALL_BOARD_JOBS = Number.POSITIVE_INFINITY;

/**
 * A board's listed jobs plus whether its ATS-hosted job pages are served (Ashby only; "unknown" for the
 * others). One fetch of each per board per run, shared across users in a cron invocation.
 */
export type BoardListing = { jobs: RawJob[]; hostedPage: HostedPageState };
export type BoardListingCache = Map<string, Promise<BoardListing>>;

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
};

function listBoard(target: BoardTarget, cache: BoardListingCache) {
  const key = `${target.ats}:${boardRegionFromBaseUrl(target.baseUrl)}:${target.token.toLowerCase()}`;
  let listing = cache.get(key);

  if (!listing) {
    listing = Promise.all([
      getJobSourceProvider(target.ats).searchJobs({
        boardToken: target.token,
        url: target.baseUrl ?? undefined,
        limit: ALL_BOARD_JOBS
      }),
      target.ats === "ASHBY" ? checkAshbyHostedPage(target.token) : Promise.resolve<HostedPageState>("unknown")
    ]).then(([jobs, hostedPage]) => ({ jobs, hostedPage }));
    cache.set(key, listing);
  }

  return listing;
}

/**
 * Marks the user's postings this board lists when its hosted job pages are switched off (keeping the
 * first time it was found), and clears the mark once they are served again. "unknown" changes nothing.
 */
async function markAtsApplyPage(userId: string, listedApplyUrls: string[], hostedPage: HostedPageState, now: Date) {
  const keys = [...new Set(listedApplyUrls.filter(Boolean))];
  if (hostedPage === "unknown" || !keys.length) {
    return;
  }
  const off = hostedPage === "off";
  await prisma.jobPosting.updateMany({
    where: { userId, normalizedApplyUrl: { in: keys }, atsApplyPageOffAt: off ? null : { not: null } },
    data: { atsApplyPageOffAt: off ? now : null }
  });
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
  const { jobs: rawJobs, hostedPage } = await listBoard(target, listingCache);
  const listedApplyUrls: string[] = [];
  const passing: BoardImportCandidate[] = [];
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
      passing.push({ job, score: evaluation.relevance.score, decision: evaluation.relevance.decision, order });
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
  const closed = await closeVanishedPostings({
    userId,
    sourceType: target.ats,
    scopes: target.closureScopes,
    listedApplyUrls,
    now
  });
  await markAtsApplyPage(userId, listedApplyUrls, hostedPage, now);

  return {
    imported: [...persisted.created, ...persisted.updated],
    unchanged: persisted.unchanged,
    listed: rawJobs.length,
    skipped: rawJobs.length - passing.length,
    capped: Math.max(0, distinctRoles.length - selected.length),
    otherLocations,
    duplicates: persisted.duplicates,
    closed,
    bestRelevanceScore
  };
}
