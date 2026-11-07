import {
  boardApiUrl,
  boardRegionFromBaseUrl,
  resolveBoardUrl,
  type BoardAts,
  type BoardReference
} from "@/lib/job-sources/board-url";

/**
 * Shared read-only fetch for the public Greenhouse, Lever and Ashby board APIs. The token is
 * validated (via boardApiUrl) before any request, so a stored or pasted value can never steer
 * the request to another host or path.
 */

const atsLabels: Record<BoardAts, string> = {
  GREENHOUSE: "Greenhouse",
  LEVER: "Lever",
  ASHBY: "Ashby"
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** Returns the publicly listed jobs in a board API payload, or null when the shape is unexpected. */
export function listedBoardJobs(ats: BoardAts, payload: unknown): Record<string, unknown>[] | null {
  if (ats === "LEVER") {
    return Array.isArray(payload) ? payload.filter((job): job is Record<string, unknown> => Boolean(asRecord(job))) : null;
  }

  const jobs = asRecord(payload)?.jobs;
  if (!Array.isArray(jobs)) {
    return null;
  }

  const records = jobs.filter((job): job is Record<string, unknown> => Boolean(asRecord(job)));
  // Ashby marks unlisted postings with isListed=false; they are not part of the public board.
  return ats === "ASHBY" ? records.filter((job) => job.isListed !== false) : records;
}

/**
 * Accepts a stored board token (or a pasted board URL saved as the token by older sources)
 * and returns the canonical token. Greenhouse and Lever slugs are lowercase.
 */
export function normalizeBoardTokenInput(ats: BoardAts, raw: string) {
  const trimmed = raw.trim();
  const resolved = trimmed.includes("/") ? resolveBoardUrl(trimmed) : null;

  if (resolved?.ok && resolved.ats === ats) {
    return resolved.token;
  }

  return ats === "ASHBY" ? trimmed : trimmed.toLowerCase();
}

export function boardReferenceFromCriteria(
  ats: BoardAts,
  criteria: { boardToken?: string; company?: string; url?: string }
): BoardReference {
  const raw = criteria.boardToken ?? criteria.company;
  if (!raw?.trim()) {
    throw new Error(`${atsLabels[ats]} sync requires a board token.`);
  }

  return {
    ats,
    token: normalizeBoardTokenInput(ats, raw),
    region: ats === "LEVER" ? boardRegionFromBaseUrl(criteria.url) : "global"
  };
}

export async function fetchBoardListing(reference: BoardReference) {
  const url = boardApiUrl(reference);
  const label = atsLabels[reference.ats];
  const response = await fetch(url, { next: { revalidate: 900 } });

  if (!response.ok) {
    throw new Error(`${label} returned ${response.status}.`);
  }

  const jobs = listedBoardJobs(reference.ats, await response.json());
  if (!jobs) {
    throw new Error(`${label} returned an unexpected board response.`);
  }

  return jobs;
}
