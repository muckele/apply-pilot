import type { NormalizedJob } from "@/lib/job-sources/types";

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
