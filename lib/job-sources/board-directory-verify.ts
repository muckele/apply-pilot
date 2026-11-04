import { listedBoardJobs } from "@/lib/job-sources/board-fetch";
import { boardApiUrl, type BoardAts, type BoardReference } from "@/lib/job-sources/board-url";

/**
 * Read-only verification of a seed-directory board: one public GET to the same endpoint the
 * provider fetchers use, with the same default fetch User-Agent. Used when the reviewed
 * directory file is refreshed; never called at request time.
 */

export type BoardListingSummary = {
  jobCount: number;
  locations: string[];
  remote: boolean;
};

export type BoardVerification =
  | ({ ok: true; status: number; payload: unknown } & BoardListingSummary)
  | { ok: false; status?: number; error: string };

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const maxLocationTags = 6;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function splitLocations(value: string) {
  return value
    .split(/[;|]/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && part.length <= 80);
}

function jobLocations(ats: BoardAts, job: Record<string, unknown>) {
  if (ats === "GREENHOUSE") {
    return splitLocations(text(asRecord(job.location)?.name));
  }

  if (ats === "LEVER") {
    const categories = asRecord(job.categories);
    const all = Array.isArray(categories?.allLocations) ? categories.allLocations.map(text) : [];
    return [...splitLocations(text(categories?.location)), ...all.flatMap(splitLocations)];
  }

  const secondary = Array.isArray(job.secondaryLocations)
    ? job.secondaryLocations.map((entry) => text(asRecord(entry)?.location))
    : [];
  return [...splitLocations(text(job.location)), ...secondary.flatMap(splitLocations)];
}

function jobIsRemote(ats: BoardAts, job: Record<string, unknown>) {
  const workplace = text(job.workplaceType).toLowerCase();

  if (ats === "ASHBY" && (job.isRemote === true || workplace === "remote")) {
    return true;
  }
  if (ats === "LEVER" && workplace === "remote") {
    return true;
  }

  return jobLocations(ats, job).some((location) => /\bremote\b/i.test(location));
}

export function summarizeBoardListing(ats: BoardAts, payload: unknown): BoardListingSummary | null {
  const jobs = listedBoardJobs(ats, payload);
  if (!jobs) {
    return null;
  }

  const counts = new Map<string, { label: string; count: number; order: number }>();
  let order = 0;
  for (const job of jobs) {
    for (const location of new Set(jobLocations(ats, job))) {
      const key = location.toLowerCase();
      const existing = counts.get(key);
      if (existing) {
        existing.count += 1;
      } else {
        counts.set(key, { label: location, count: 1, order: order++ });
      }
    }
  }

  const locations = [...counts.values()]
    .sort((left, right) => right.count - left.count || left.order - right.order)
    .slice(0, maxLocationTags)
    .map((entry) => entry.label);

  return {
    jobCount: jobs.length,
    locations,
    remote: jobs.some((job) => jobIsRemote(ats, job))
  };
}

export async function verifyBoard(
  reference: BoardReference,
  { fetchImpl = fetch as FetchLike }: { fetchImpl?: FetchLike } = {}
): Promise<BoardVerification> {
  let response: Response;
  try {
    response = await fetchImpl(boardApiUrl(reference));
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Request failed." };
  }

  if (!response.ok) {
    return { ok: false, status: response.status, error: `HTTP ${response.status}` };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { ok: false, status: response.status, error: "Response was not JSON." };
  }

  const summary = summarizeBoardListing(reference.ats, payload);
  if (!summary) {
    return { ok: false, status: response.status, error: "Unexpected board response shape." };
  }
  if (summary.jobCount === 0) {
    return { ok: false, status: response.status, error: "Board has no listed jobs." };
  }

  return { ok: true, status: response.status, payload, ...summary };
}
