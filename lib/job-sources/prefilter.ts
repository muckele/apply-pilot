import type { UserProfile } from "@prisma/client";

import {
  isRemoteOrHybridPosting,
  isRemotePosting,
  jobLocationFit,
  preferredLocationsFromProfile
} from "@/lib/job-sources/location-match";
import { scoreJobRelevance, type JobRelevanceResult } from "@/lib/job-sources/relevance";
import type { NormalizedJob } from "@/lib/job-sources/types";
import { normalizeText, normalizeUrl } from "@/lib/normalize";

/**
 * Deterministic pre-import filter shared by every discovery path. It runs before any posting
 * is stored and before the capped AI scoring step.
 */

export function normalizedJobKey(job: NormalizedJob) {
  return [
    normalizeText(job.company),
    normalizeText(job.title),
    normalizeText(job.location),
    normalizeUrl(job.applyUrl ?? job.sourceUrl)
  ].join("|");
}

export function queryMatchesJob(job: NormalizedJob, query?: string) {
  if (!query) {
    return true;
  }

  const tokens = normalizeText(query)
    .split(" ")
    .filter((token) => token.length > 2);

  if (!tokens.length) {
    return true;
  }

  const haystack = normalizeText(
    [job.title, job.company, job.location, job.description, ...job.requirements, ...job.detectedTechStack].join(" ")
  );
  const matchedTokens = tokens.filter((token) => haystack.includes(token));

  return matchedTokens.length >= Math.max(1, Math.ceil(tokens.length * 0.6));
}

/** A board listing is not query-scoped, so a posting passes when it matches any target search. */
export function queryMatchesAny(job: NormalizedJob, queries: readonly string[]) {
  return !queries.length || queries.some((query) => queryMatchesJob(job, query));
}

/** Remote is read from the posting's work style and location; description wording does not count. */
export function matchesRemoteOnly(job: NormalizedJob, remoteOnly?: boolean) {
  if (!remoteOnly) {
    return true;
  }

  return isRemotePosting(job);
}

export function readPositiveIntegerEnv(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function maxPostedAgeDays() {
  return readPositiveIntegerEnv("JOB_SOURCE_MAX_POSTED_AGE_DAYS", 30);
}

function jobPostedAgeDays(job: NormalizedJob) {
  if (!job.datePosted || Number.isNaN(job.datePosted.getTime())) {
    return null;
  }

  return (Date.now() - job.datePosted.getTime()) / 86_400_000;
}

/**
 * Driven by this user's own preferred and home locations; no locale is built in. A remote posting
 * must be remote in a country the user accepts; a hybrid or onsite one must be in their city or
 * state. Remote or hybrid wording in the description no longer skips this check.
 */
function locationMatchesProfile(job: NormalizedJob, profile: UserProfile | null) {
  return (
    jobLocationFit({
      location: job.location,
      remoteStatus: job.remoteStatus,
      title: job.title,
      preferredLocations: preferredLocationsFromProfile(profile)
    }) !== "none"
  );
}

function salaryMatchesProfile(job: NormalizedJob, profile: UserProfile | null) {
  if (!profile?.salaryTargetMin || (!job.salaryMin && !job.salaryMax)) {
    return true;
  }

  const jobMax = job.salaryMax ?? job.salaryMin ?? 0;

  return jobMax >= profile.salaryTargetMin * 0.85;
}

export function getPreImportRejectionReason({
  job,
  profile,
  relevance,
  remoteOnly
}: {
  job: NormalizedJob;
  profile: UserProfile | null;
  relevance: JobRelevanceResult;
  remoteOnly?: boolean;
}) {
  const ageDays = jobPostedAgeDays(job);

  if (ageDays !== null && ageDays > maxPostedAgeDays()) {
    return `Posting is older than ${maxPostedAgeDays()} days.`;
  }

  if (remoteOnly && !matchesRemoteOnly(job, true)) {
    return "Posting does not match remote-only filter.";
  }

  if (profile?.remotePreference === "REMOTE" && !isRemoteOrHybridPosting(job)) {
    return "Work style does not match remote preference.";
  }

  if (!locationMatchesProfile(job, profile)) {
    return "Location does not match preferred locations or remote/hybrid preferences.";
  }

  if (!salaryMatchesProfile(job, profile)) {
    return "Salary range is below the target range.";
  }

  if (relevance.hardExcluded) {
    return "Role contains a hard-excluded title, role type, or deal-breaker.";
  }

  if (relevance.breakdown.seniorityScore === 0) {
    return "Role appears too senior for the current search target.";
  }

  // Titles are scored against the user's own roles and target searches (neutral when they have
  // none), so a title outside them is not carried in by body wording alone.
  if (relevance.breakdown.roleTitleScore < 45) {
    return "Role title does not match your target roles or searches.";
  }

  if (relevance.decision === "skip") {
    return "Overall relevance score is below the save threshold.";
  }

  return null;
}

export type ImportEvaluation =
  | { passed: true; relevance: JobRelevanceResult }
  | { passed: false; relevance: JobRelevanceResult | null };

/** Applies the query, remote-only and relevance prefilter to one normalized posting. */
export function evaluateForImport({
  job,
  profile,
  queries,
  remoteOnly
}: {
  job: NormalizedJob;
  profile: UserProfile | null;
  queries: readonly string[];
  remoteOnly?: boolean;
}): ImportEvaluation {
  if (!job.title || !job.sourceUrl || !queryMatchesAny(job, queries) || !matchesRemoteOnly(job, remoteOnly)) {
    return { passed: false, relevance: null };
  }

  const relevance = scoreJobRelevance({ job, profile, queries });
  const rejection = getPreImportRejectionReason({ job, profile, relevance, remoteOnly });

  return rejection ? { passed: false, relevance } : { passed: true, relevance };
}
