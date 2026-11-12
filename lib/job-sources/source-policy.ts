import type { JobSource, UserProfile } from "@prisma/client";

import { assertSourceTypeComplianceEnabled } from "@/lib/job-sources/compliance";
import {
  resolveDiscoveryLocation,
  resolveDiscoveryQueries,
  type JobDiscoveryPreferences
} from "@/lib/job-sources/discovery-preferences";
import type { JobSearchCriteria } from "@/lib/job-sources/types";

const urlRequiredSourceTypes = new Set<JobSource["type"]>(["RSS", "COMPANY_CAREERS"]);
const userReviewedSourceTypes = new Set<JobSource["type"]>(["RSS", "COMPANY_CAREERS"]);
const boardTokenRequiredSourceTypes = new Set<JobSource["type"]>([
  "GREENHOUSE",
  "LEVER",
  "ASHBY",
  "WORKABLE"
]);
const queryDrivenSourceTypes = new Set<JobSource["type"]>([
  "REMOTIVE",
  "ADZUNA",
  "THEIRSTACK",
  "SERPAPI",
  "USAJOBS"
]);

export type SourceRunOptions = {
  limit?: number;
  location?: string | null;
  remoteOnly?: boolean;
  query?: string | null;
};

/**
 * A manual run (the Job Sources page's Sync) sends little more than a limit. What it leaves out
 * comes from the same discovery settings scheduled discovery reads: the saved target searches
 * (else the profile's preferred roles), location and remote-only choice. A value the request
 * sets itself wins.
 */
export function withDiscoveryDefaults(
  options: SourceRunOptions,
  {
    savedPreference,
    profile
  }: {
    savedPreference: Pick<JobDiscoveryPreferences, "targetSearches" | "location" | "remoteOnly"> | null;
    profile: Pick<UserProfile, "preferredRoles" | "preferredLocations" | "location"> | null;
  }
): { options: SourceRunOptions; targetSearches: string[] } {
  return {
    options: {
      ...options,
      location: resolveDiscoveryLocation({ suppliedLocation: options.location ?? undefined, savedPreference, profile }),
      remoteOnly: options.remoteOnly ?? savedPreference?.remoteOnly ?? false
    },
    targetSearches: resolveDiscoveryQueries({ savedPreference, profilePreferredRoles: profile?.preferredRoles })
  };
}

export function sourceRequiresUserReview(sourceType: JobSource["type"]) {
  return userReviewedSourceTypes.has(sourceType);
}

export function assertSourceCanSync(source: JobSource) {
  if (source.type === "MANUAL") {
    throw new Error("Manual sources are saved through manual job import and cannot be synced.");
  }

  assertSourceTypeComplianceEnabled(source.type);

  if (sourceRequiresUserReview(source.type) && !source.allowlisted) {
    throw new Error("Review and approve this source before testing or syncing it.");
  }

  if (urlRequiredSourceTypes.has(source.type) && !source.baseUrl) {
    throw new Error(`${source.type} sources require a URL.`);
  }

  if (boardTokenRequiredSourceTypes.has(source.type) && !source.boardToken) {
    throw new Error(`${source.type} sources require a board token or company slug.`);
  }
}

export function buildCriteriaFromSource(source: JobSource, options: SourceRunOptions = {}): JobSearchCriteria {
  const boardToken = source.boardToken?.trim() || undefined;
  const baseUrl = source.baseUrl?.trim() || undefined;
  const query = options.query?.trim() || (queryDrivenSourceTypes.has(source.type) ? boardToken || source.name : undefined);

  return {
    query,
    company: boardToken ?? source.name,
    boardToken,
    url: baseUrl,
    location: options.location?.trim() || undefined,
    remote: options.remoteOnly,
    limit: options.limit ?? 25
  };
}
