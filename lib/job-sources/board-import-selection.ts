import { isRemotePosting, workStyleFromLocation } from "@/lib/job-sources/location-match";
import type { NormalizedJob } from "@/lib/job-sources/types";
import { normalizeText } from "@/lib/normalize";

/**
 * Chooses which passing postings from one board listing are stored in a run.
 *
 * The per-board cap (`limitPerQuery`, default 8) limits how many *new* postings one board can
 * add to a user's feed per run. Postings the user already has are always passed through so
 * they are refreshed (unchanged ones only get `lastCheckedAt`), but they no longer take cap
 * slots. Before this, the cap kept the top-scoring postings, so the same already-imported jobs
 * held their slots run after run and a board's new postings never got in.
 *
 * New postings fill the cap in this order: "strong" before "review", then postings from the
 * last 7 days before older ones, then relevance score, then the board's own listing order.
 * Within a decision band recency wins over a few score points, because applying early matters
 * more to the user than a small difference in a deterministic score.
 */

const recentDays = 7;

export type BoardImportCandidate = {
  job: NormalizedJob;
  score: number;
  decision: string;
  order: number;
};

function isRecent(job: NormalizedJob, now: number) {
  const posted = job.datePosted?.getTime();
  return posted !== undefined && !Number.isNaN(posted) && now - posted <= recentDays * 86_400_000;
}

/**
 * One board often lists the same role once per city ("Account Executive, Commercial" in
 * Raleigh, Boston, Atlanta and US - Remote), each with its own apply URL. Those collapse to one
 * feed job per normalized title: the best-scoring listing; on ties one whose location says
 * remote, then a remote-flagged one, then the board's first. The other listings stay on the board and are not expired.
 */
export function collapseRepeatedRoles<T extends BoardImportCandidate>(candidates: readonly T[]) {
  const best = new Map<string, T>();
  // A listing whose own location says remote beats city listings of a remote-flagged role.
  const remote = (candidate: T) =>
    workStyleFromLocation(candidate.job.location) === "Remote" ? 2 : isRemotePosting(candidate.job) ? 1 : 0;

  for (const candidate of candidates) {
    const key = normalizeText(candidate.job.title);
    const current = best.get(key);
    if (
      !current ||
      candidate.score > current.score ||
      (candidate.score === current.score && remote(candidate) > remote(current))
    ) {
      best.set(key, candidate);
    }
  }

  const kept = candidates.filter((candidate) => best.get(normalizeText(candidate.job.title)) === candidate);
  return { kept, collapsed: candidates.length - kept.length };
}

export function selectBoardImports<T extends BoardImportCandidate>({
  candidates,
  alreadyImported,
  cap,
  now = Date.now()
}: {
  candidates: readonly T[];
  alreadyImported: (job: NormalizedJob) => boolean;
  cap: number;
  now?: number;
}): T[] {
  const known = candidates.filter((candidate) => alreadyImported(candidate.job));
  const unseen = candidates.filter((candidate) => !alreadyImported(candidate.job));
  const band = (candidate: T) => (candidate.decision === "strong" ? 1 : 0);
  const recent = (candidate: T) => (isRecent(candidate.job, now) ? 1 : 0);

  const fresh = [...unseen]
    .sort(
      (left, right) =>
        band(right) - band(left) ||
        recent(right) - recent(left) ||
        right.score - left.score ||
        left.order - right.order
    )
    .slice(0, Math.max(0, Math.trunc(cap)));

  return [...[...known].sort((left, right) => left.order - right.order), ...fresh];
}
