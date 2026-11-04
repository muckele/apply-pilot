import type { JobPosting, JobSource, JobSourceType, UserProfile } from "@prisma/client";

import { PublicApiError } from "@/lib/api-errors";
import { LocalAiUnavailableError } from "@/lib/ai/client";
import { getJobSourceProvider } from "@/lib/job-sources";
import { runBoardDiscovery, type BoardDiscoveryResult } from "@/lib/job-sources/board-discovery";
import type { JobBoardDirectoryEntry } from "@/lib/job-sources/board-directory";
import { normalizeBoardTokenInput } from "@/lib/job-sources/board-fetch";
import { syncBoard, type BoardListingCache } from "@/lib/job-sources/board-sync";
import { isBoardAts } from "@/lib/job-sources/board-url";
import { complianceDisabledMessage, isSourceTypeComplianceEnabled } from "@/lib/job-sources/compliance";
import {
  resolveDiscoveryLocation,
  resolveDiscoveryQueries,
  type JobDiscoveryPreferences
} from "@/lib/job-sources/discovery-preferences";
import {
  createRunDedupeIndex,
  normalizedJobFromPosting,
  persistCandidates,
  type RunDedupeIndex
} from "@/lib/job-sources/ingestion";
import { evaluateForImport, normalizedJobKey, readPositiveIntegerEnv } from "@/lib/job-sources/prefilter";
import { scoreJobRelevance } from "@/lib/job-sources/relevance";
import { assertSourceCanSync, buildCriteriaFromSource } from "@/lib/job-sources/source-policy";
import type { DiscoverySourceReport, JobSearchCriteria, NormalizedJob, RawJob } from "@/lib/job-sources/types";
import { runJobMatch } from "@/lib/jobs";
import { prisma } from "@/lib/prisma";
import { getOrCreateAiSettings } from "@/lib/ai/usage";

export { getPreImportRejectionReason } from "@/lib/job-sources/prefilter";
export type { DiscoverySourceReport } from "@/lib/job-sources/types";

export type AutomatedDiscoveryOptions = {
  userId: string;
  queries?: string[];
  location?: string;
  remoteOnly?: boolean;
  limitPerQuery?: number;
  scoreImported?: boolean;
  maxJobsToScore?: number;
  /** Overrides the reviewed seed directory (tests). */
  boardDirectory?: readonly JobBoardDirectoryEntry[];
  maxBoards?: number;
};

export type RestrictedBoardPolicy = {
  name: string;
  status: "approved_api_required";
  reason: string;
  allowedPath: string;
  policyUrl: string;
};

type ProviderSearchResult = {
  imported: JobPosting[];
  unchanged: JobPosting[];
  skipped: number;
  duplicates: number;
  closed?: number;
  bestRelevanceScore: number;
};

const defaultMaxJobsToScore = 8;

export type DiscoveryAiScoreResult = {
  jobId: string;
  deterministicScore: number;
  aiScore?: number;
  score?: number;
  cached?: boolean;
  error?: string;
};

export type DiscoveryScoringStopReason =
  | "NOT_REQUESTED"
  | "DISABLED_BY_POLICY"
  | "LIMIT_ZERO"
  | "AI_UNAVAILABLE"
  | "AI_CONFIGURATION_INVALID"
  | "AI_BUDGET_EXCEEDED";

export type DiscoveryScoringSummary = {
  eligible: number;
  attempted: number;
  cached: number;
  scored: number;
  failed: number;
  stopReason: DiscoveryScoringStopReason | null;
};

export type DiscoveryScoringResult = {
  jobs: DiscoveryAiScoreResult[];
  summary: DiscoveryScoringSummary;
};

type JobMatchRunner = typeof runJobMatch;

const systemicConfigurationCodes = new Set([
  "AI_MODEL_PRICING_UNKNOWN",
  "AI_MODEL_PRICING_NOT_EFFECTIVE",
  "AI_MODEL_PRICING_EXPIRED",
  "AI_REQUEST_COST_LIMIT",
  "AI_BUDGET_OWNER_REQUIRED",
  "AI_PROVIDER_USAGE_EXCEEDED_RESERVATION"
]);

export function getDiscoveryScoringStopReason(error: unknown): DiscoveryScoringStopReason | null {
  if (error instanceof LocalAiUnavailableError) {
    return "AI_UNAVAILABLE";
  }

  if (!(error instanceof PublicApiError)) {
    return null;
  }

  const code = typeof error.details?.code === "string" ? error.details.code : null;
  if (code === "AI_BUDGET_EXCEEDED") {
    return "AI_BUDGET_EXCEEDED";
  }

  return code && systemicConfigurationCodes.has(code) ? "AI_CONFIGURATION_INVALID" : null;
}

export function isSystemicDiscoveryScoringStopReason(
  reason: DiscoveryScoringStopReason | null
): reason is "AI_UNAVAILABLE" | "AI_CONFIGURATION_INVALID" | "AI_BUDGET_EXCEEDED" {
  return reason === "AI_UNAVAILABLE" || reason === "AI_CONFIGURATION_INVALID" || reason === "AI_BUDGET_EXCEEDED";
}

export function combineDiscoveryScoringSummaries(
  summaries: DiscoveryScoringSummary[]
): DiscoveryScoringSummary {
  return summaries.reduce<DiscoveryScoringSummary>(
    (combined, summary) => ({
      eligible: combined.eligible + summary.eligible,
      attempted: combined.attempted + summary.attempted,
      cached: combined.cached + summary.cached,
      scored: combined.scored + summary.scored,
      failed: combined.failed + summary.failed,
      stopReason: isSystemicDiscoveryScoringStopReason(summary.stopReason)
        ? summary.stopReason
        : combined.stopReason ?? summary.stopReason
    }),
    { eligible: 0, attempted: 0, cached: 0, scored: 0, failed: 0, stopReason: null }
  );
}

// Greenhouse, Lever and Ashby sources are synced by board discovery (runBoardDiscovery).
const sourceTypesForConfiguredSync: JobSourceType[] = ["WORKABLE", "RSS", "COMPANY_CAREERS"];

export const restrictedJobBoardPolicies: RestrictedBoardPolicy[] = [
  {
    name: "LinkedIn",
    status: "approved_api_required",
    reason: "Direct bots, crawlers, browser plug-ins, and automated activity are prohibited.",
    allowedPath: "Use approved LinkedIn APIs, licensed aggregator APIs, or user-reviewed manual import. Do not automate logged-in activity.",
    policyUrl: "https://www.linkedin.com/help/linkedin/answer/a1341387/prohibited-software-and-extensions"
  },
  {
    name: "Indeed",
    status: "approved_api_required",
    reason: "Indeed access must follow its terms and API documentation; this app should not scrape search results.",
    allowedPath: "Use an approved Indeed API/partner integration, licensed aggregator API, or user-reviewed manual import.",
    policyUrl: "https://www.indeed.com/legal"
  },
  {
    name: "CareerBuilder",
    status: "approved_api_required",
    reason: "CareerBuilder prohibits robots, spiders, data mining, and aggregation beyond permitted use.",
    allowedPath: "Use an approved CareerBuilder contract/API feed, licensed aggregator API, employer export, or user-reviewed manual import.",
    policyUrl: "https://hiring.careerbuilder.com/company/terms-and-conditions"
  },
  {
    name: "ZipRecruiter",
    status: "approved_api_required",
    reason: "ZipRecruiter robots.txt denies default crawlers and blocks job-search crawling paths.",
    allowedPath: "Use an approved ZipRecruiter API/partner feed, licensed aggregator API, or user-reviewed manual import.",
    policyUrl: "https://www.ziprecruiter.com/robots.txt"
  }
];

function formatJob(job: JobPosting) {
  return {
    id: job.id,
    title: job.title,
    company: job.company,
    location: job.location,
    sourceType: job.sourceType,
    sourceUrl: job.sourceUrl,
    applyUrl: job.applyUrl,
    fitScore: job.overallFitScore
  };
}

/** Tracks written postings for the run summary, and every surviving posting for capped AI scoring. */
type RunTracker = {
  imported: Map<string, JobPosting>;
  scoringPool: Map<string, JobPosting>;
};

function createRunTracker(): RunTracker {
  return { imported: new Map(), scoringPool: new Map() };
}

function trackImportedJobs(tracker: RunTracker, result: Pick<ProviderSearchResult, "imported" | "unchanged">) {
  result.imported.forEach((job) => {
    tracker.imported.set(job.id, job);
    tracker.scoringPool.set(job.id, job);
  });
  // Unchanged postings are not rewritten, but they stay eligible for the same capped scoring
  // step they reached before (already-scored ones return the cached match).
  result.unchanged.forEach((job) => tracker.scoringPool.set(job.id, job));
}

function reportDetails(base: string, result: ProviderSearchResult) {
  const notes = [
    result.unchanged.length ? `${result.unchanged.length} unchanged.` : "",
    result.duplicates ? `${result.duplicates} already found through another source.` : "",
    result.closed ? `${result.closed} no longer listed and marked expired.` : ""
  ].filter(Boolean);

  if (!result.imported.length && !result.unchanged.length && result.skipped) {
    notes.push("No jobs passed the current relevance filter.");
  }

  return [base, ...notes].join(" ");
}

function freshnessFields(result: ProviderSearchResult) {
  return { unchanged: result.unchanged.length, duplicates: result.duplicates, closed: result.closed ?? 0 };
}

async function getOrCreateJobSource({
  userId,
  name,
  type,
  notes
}: {
  userId: string;
  name: string;
  type: JobSourceType;
  notes: string;
}) {
  const existing = await prisma.jobSource.findFirst({
    where: { userId, type, name }
  });

  if (existing) {
    return existing;
  }

  return prisma.jobSource.create({
    data: {
      userId,
      name,
      type,
      allowlisted: true,
      robotsChecked: true,
      notes
    }
  });
}

async function importRawJobs({
  userId,
  source,
  rawJobs,
  query,
  remoteOnly,
  profile,
  index
}: {
  userId: string;
  source: JobSource;
  rawJobs: RawJob[];
  query?: string;
  remoteOnly?: boolean;
  profile: Awaited<ReturnType<typeof prisma.userProfile.findUnique>>;
  index: RunDedupeIndex;
}): Promise<ProviderSearchResult> {
  const provider = getJobSourceProvider(source.type);
  const seen = new Set<string>();
  const candidates: NormalizedJob[] = [];
  let skipped = 0;
  let bestRelevanceScore = 0;

  for (const rawJob of rawJobs) {
    const normalized = provider.normalizeJob(rawJob);
    const job = {
      ...normalized,
      company: normalized.company || source.name
    };
    const key = normalizedJobKey(job);

    if (seen.has(key)) {
      skipped += 1;
      continue;
    }

    const evaluation = evaluateForImport({ job, profile, queries: query ? [query] : [], remoteOnly });
    if (evaluation.relevance) {
      bestRelevanceScore = Math.max(bestRelevanceScore, evaluation.relevance.score);
    }
    if (!evaluation.passed) {
      skipped += 1;
      continue;
    }

    seen.add(key);
    candidates.push(job);
  }

  const persisted = await persistCandidates({ userId, jobSourceId: source.id, candidates, index });

  return {
    imported: [...persisted.created, ...persisted.updated],
    unchanged: persisted.unchanged,
    skipped,
    duplicates: persisted.duplicates,
    bestRelevanceScore
  };
}

async function runProviderSearch({
  userId,
  source,
  criteria,
  profile,
  index
}: {
  userId: string;
  source: JobSource;
  criteria: JobSearchCriteria;
  profile: Awaited<ReturnType<typeof prisma.userProfile.findUnique>>;
  index: RunDedupeIndex;
}) {
  const provider = getJobSourceProvider(source.type);
  const rawJobs = await provider.searchJobs(criteria);

  return importRawJobs({ userId, source, rawJobs, query: criteria.query, remoteOnly: criteria.remote, profile, index });
}

export async function importJobsFromSource({
  userId,
  source,
  criteria,
  profile,
  index = createRunDedupeIndex()
}: {
  userId: string;
  source: JobSource;
  criteria: JobSearchCriteria;
  profile: Awaited<ReturnType<typeof prisma.userProfile.findUnique>>;
  index?: RunDedupeIndex;
}): Promise<ProviderSearchResult> {
  if (isBoardAts(source.type) && criteria.boardToken) {
    // A board sync reads the whole public listing so postings that left the board can be closed.
    const result = await syncBoard({
      userId,
      target: {
        ats: source.type,
        token: normalizeBoardTokenInput(source.type, criteria.boardToken),
        baseUrl: criteria.url,
        company: source.name,
        jobSourceId: source.id,
        closureScopes: [{ jobSourceId: source.id }]
      },
      queries: criteria.query ? [criteria.query] : [],
      remoteOnly: criteria.remote,
      profile,
      maxImports: criteria.limit ?? 25,
      index
    });

    return {
      imported: result.imported,
      unchanged: result.unchanged,
      skipped: result.skipped,
      duplicates: result.duplicates,
      closed: result.closed,
      bestRelevanceScore: result.bestRelevanceScore
    };
  }

  return runProviderSearch({ userId, source, criteria, profile, index });
}

export async function scoreTopImportedJobs({
  userId,
  jobs,
  profile,
  limit,
  enabled = true,
  disabledReason = "DISABLED_BY_POLICY",
  jobMatchRunner = runJobMatch
}: {
  userId: string;
  jobs: JobPosting[];
  profile: UserProfile | null;
  limit: number;
  enabled?: boolean;
  disabledReason?: DiscoveryScoringStopReason;
  jobMatchRunner?: JobMatchRunner;
}): Promise<DiscoveryScoringResult> {
  const eligibleCandidates = jobs
    .map((job) => ({ job, relevance: scoreJobRelevance({ job: normalizedJobFromPosting(job), profile }) }))
    .filter(({ relevance }) => relevance.score >= 60)
    .sort((left, right) => {
      const scoreDifference = right.relevance.score - left.relevance.score;
      if (scoreDifference !== 0) return scoreDifference;
      return (right.job.datePosted?.getTime() ?? 0) - (left.job.datePosted?.getTime() ?? 0);
    });
  const summary: DiscoveryScoringSummary = {
    eligible: eligibleCandidates.length,
    attempted: 0,
    cached: 0,
    scored: 0,
    failed: 0,
    stopReason: null
  };

  if (!enabled) {
    summary.stopReason = disabledReason;
    return { jobs: [], summary };
  }

  if (limit <= 0) {
    summary.stopReason = "LIMIT_ZERO";
    return { jobs: [], summary };
  }

  const candidates = eligibleCandidates.slice(0, limit);
  const results: DiscoveryAiScoreResult[] = [];

  for (const { job, relevance } of candidates) {
    summary.attempted += 1;
    try {
      const result = await jobMatchRunner(userId, job.id, { automation: true });
      results.push({
        jobId: job.id,
        deterministicScore: relevance.score,
        aiScore: result.job.overallFitScore ?? undefined,
        score: result.job.overallFitScore ?? undefined,
        cached: result.cached
      });
      summary.scored += 1;
      if (result.cached) {
        summary.cached += 1;
      }
    } catch (error) {
      summary.failed += 1;
      results.push({
        jobId: job.id,
        deterministicScore: relevance.score,
        error: error instanceof Error ? error.message : "Scoring failed."
      });

      const stopReason = getDiscoveryScoringStopReason(error);
      if (stopReason) {
        summary.stopReason = stopReason;
        break;
      }
    }
  }

  return { jobs: results, summary };
}

function sumReports(reports: DiscoverySourceReport[], field: "unchanged" | "duplicates" | "closed") {
  return reports.reduce((total, report) => total + (report[field] ?? 0), 0);
}

function trackBoardDiscovery(tracker: RunTracker, reports: DiscoverySourceReport[], boardRun: BoardDiscoveryResult) {
  trackImportedJobs(tracker, boardRun);
  reports.push(...boardRun.reports);
}

export async function runAutomatedJobDiscovery(options: AutomatedDiscoveryOptions) {
  const aiSettings = await getOrCreateAiSettings(options.userId);
  const maxJobsToScore = Math.min(options.maxJobsToScore ?? defaultMaxJobsToScore, aiSettings.maxAnalysesPerSync);
  const reports: DiscoverySourceReport[] = [];
  const tracker = createRunTracker();
  const index = createRunDedupeIndex();
  const [profile, savedPreference] = await Promise.all([
    prisma.userProfile.findUnique({ where: { userId: options.userId } }),
    prisma.jobDiscoveryPreference.findUnique({ where: { userId: options.userId } })
  ]);
  const queries = resolveDiscoveryQueries({
    suppliedQueries: options.queries,
    savedPreference,
    profilePreferredRoles: profile?.preferredRoles
  });
  const location = resolveDiscoveryLocation({
    suppliedLocation: options.location,
    savedPreference,
    profile
  });
  const limitPerQuery = options.limitPerQuery ?? savedPreference?.limitPerQuery ?? 8;
  const remoteOnly = options.remoteOnly ?? savedPreference?.remoteOnly ?? false;
  const scoreImported = options.scoreImported ?? savedPreference?.scoreImported ?? false;

  // Employer ATS boards run first so their postings (fresh, with the real apply URL) win the
  // cross-source dedupe against aggregator copies of the same job.
  const boardRun = await runBoardDiscovery({
    userId: options.userId,
    profile,
    queries,
    location,
    remoteOnly,
    limitPerBoard: limitPerQuery,
    maxBoards: options.maxBoards,
    index,
    directory: options.boardDirectory
  });
  trackBoardDiscovery(tracker, reports, boardRun);

  if (isSourceTypeComplianceEnabled("REMOTIVE")) {
    const remotiveSource = await getOrCreateJobSource({
      userId: options.userId,
      name: "Remotive public API",
      type: "REMOTIVE",
      notes: "Automated remote-job discovery from Remotive public API."
    });

    for (const query of queries) {
      try {
        const jobs = await runProviderSearch({
          userId: options.userId,
          source: remotiveSource,
          criteria: { query, remote: true, limit: limitPerQuery },
          profile,
          index
        });

        trackImportedJobs(tracker, jobs);
        reports.push({
          name: `Remotive: ${query}`,
          type: "REMOTIVE",
          status: "imported",
          imported: jobs.imported.length,
          skipped: jobs.skipped,
          ...freshnessFields(jobs),
          bestRelevanceScore: jobs.bestRelevanceScore,
          details: reportDetails("Pulled through Remotive's public remote jobs API.", jobs)
        });
      } catch (error) {
        reports.push({
          name: `Remotive: ${query}`,
          type: "REMOTIVE",
          status: "error",
          imported: 0,
          details: error instanceof Error ? error.message : "Remotive sync failed."
        });
      }
    }
  } else {
    reports.push({
      name: "Remotive public API",
      type: "REMOTIVE",
      status: "skipped",
      imported: 0,
      details: complianceDisabledMessage("REMOTIVE")
    });
  }

  if (process.env.USAJOBS_API_KEY && process.env.USAJOBS_USER_AGENT) {
    const usaJobsSource = await getOrCreateJobSource({
      userId: options.userId,
      name: "USAJOBS API",
      type: "USAJOBS",
      notes: "Automated federal-job discovery from the official USAJOBS API."
    });

    for (const query of queries) {
      try {
        const jobs = await runProviderSearch({
          userId: options.userId,
          source: usaJobsSource,
          criteria: {
            query,
            location,
            remote: remoteOnly,
            limit: limitPerQuery
          },
          profile,
          index
        });

        trackImportedJobs(tracker, jobs);
        reports.push({
          name: `USAJOBS: ${query}`,
          type: "USAJOBS",
          status: "imported",
          imported: jobs.imported.length,
          skipped: jobs.skipped,
          ...freshnessFields(jobs),
          bestRelevanceScore: jobs.bestRelevanceScore,
          details: reportDetails("Pulled through the official USAJOBS API.", jobs)
        });
      } catch (error) {
        reports.push({
          name: `USAJOBS: ${query}`,
          type: "USAJOBS",
          status: "error",
          imported: 0,
          details: error instanceof Error ? error.message : "USAJOBS sync failed."
        });
      }
    }
  } else {
    reports.push({
      name: "USAJOBS API",
      type: "USAJOBS",
      status: "skipped",
      imported: 0,
      details: "Set USAJOBS_API_KEY and USAJOBS_USER_AGENT to enable federal job discovery."
    });
  }

  const adzunaConfigured = Boolean(process.env.ADZUNA_APP_ID && process.env.ADZUNA_APP_KEY);
  if (adzunaConfigured && isSourceTypeComplianceEnabled("ADZUNA")) {
    const adzunaSource = await getOrCreateJobSource({
      userId: options.userId,
      name: "Adzuna API",
      type: "ADZUNA",
      notes: "Automated job discovery from the approved Adzuna jobs API."
    });

    for (const query of queries) {
      try {
        const jobs = await runProviderSearch({
          userId: options.userId,
          source: adzunaSource,
          criteria: {
            query,
            location,
            remote: remoteOnly,
            limit: limitPerQuery
          },
          profile,
          index
        });

        trackImportedJobs(tracker, jobs);
        reports.push({
          name: `Adzuna: ${query}`,
          type: "ADZUNA",
          status: "imported",
          imported: jobs.imported.length,
          skipped: jobs.skipped,
          ...freshnessFields(jobs),
          bestRelevanceScore: jobs.bestRelevanceScore,
          details: reportDetails("Pulled through the Adzuna jobs API.", jobs)
        });
      } catch (error) {
        reports.push({
          name: `Adzuna: ${query}`,
          type: "ADZUNA",
          status: "error",
          imported: 0,
          details: error instanceof Error ? error.message : "Adzuna sync failed."
        });
      }
    }
  } else {
    reports.push({
      name: "Adzuna API",
      type: "ADZUNA",
      status: "skipped",
      imported: 0,
      details: adzunaConfigured
        ? complianceDisabledMessage("ADZUNA")
        : "Set ADZUNA_APP_ID and ADZUNA_APP_KEY, and JOB_SOURCE_ADZUNA_ENABLED=true after licence review, to enable Adzuna discovery."
    });
  }

  if (process.env.THEIRSTACK_API_KEY) {
    const theirStackSource = await getOrCreateJobSource({
      userId: options.userId,
      name: "TheirStack API",
      type: "THEIRSTACK",
      notes: "Automated broad job discovery from TheirStack's licensed jobs API."
    });

    for (const query of queries) {
      try {
        const jobs = await runProviderSearch({
          userId: options.userId,
          source: theirStackSource,
          criteria: {
            query,
            location,
            remote: remoteOnly,
            limit: limitPerQuery
          },
          profile,
          index
        });

        trackImportedJobs(tracker, jobs);
        reports.push({
          name: `TheirStack: ${query}`,
          type: "THEIRSTACK",
          status: "imported",
          imported: jobs.imported.length,
          skipped: jobs.skipped,
          ...freshnessFields(jobs),
          bestRelevanceScore: jobs.bestRelevanceScore,
          details: reportDetails("Pulled through TheirStack's licensed jobs API. This may consume provider credits.", jobs)
        });
      } catch (error) {
        reports.push({
          name: `TheirStack: ${query}`,
          type: "THEIRSTACK",
          status: "error",
          imported: 0,
          details: error instanceof Error ? error.message : "TheirStack sync failed."
        });
      }
    }
  } else {
    reports.push({
      name: "TheirStack API",
      type: "THEIRSTACK",
      status: "skipped",
      imported: 0,
      details: "Set THEIRSTACK_API_KEY to enable broader multi-site job discovery through a licensed API."
    });
  }

  if (process.env.SERPAPI_API_KEY) {
    const serpApiMaxQueries = Math.min(
      queries.length,
      readPositiveIntegerEnv("SERPAPI_MAX_QUERIES_PER_RUN", 3)
    );
    const serpApiQueries = queries.slice(0, serpApiMaxQueries);
    const serpApiSource = await getOrCreateJobSource({
      userId: options.userId,
      name: "SerpApi Google Jobs",
      type: "SERPAPI",
      notes: "Automated broad job discovery from SerpApi's Google Jobs API."
    });

    for (const query of serpApiQueries) {
      try {
        const jobs = await runProviderSearch({
          userId: options.userId,
          source: serpApiSource,
          criteria: {
            query,
            location,
            remote: remoteOnly,
            limit: Math.min(limitPerQuery, 10)
          },
          profile,
          index
        });

        trackImportedJobs(tracker, jobs);
        reports.push({
          name: `SerpApi Google Jobs: ${query}`,
          type: "SERPAPI",
          status: "imported",
          imported: jobs.imported.length,
          skipped: jobs.skipped,
          ...freshnessFields(jobs),
          bestRelevanceScore: jobs.bestRelevanceScore,
          details: reportDetails("Pulled through SerpApi's Google Jobs API. This may consume provider credits.", jobs)
        });
      } catch (error) {
        reports.push({
          name: `SerpApi Google Jobs: ${query}`,
          type: "SERPAPI",
          status: "error",
          imported: 0,
          details: error instanceof Error ? error.message : "SerpApi sync failed."
        });
      }
    }

    if (queries.length > serpApiQueries.length) {
      reports.push({
        name: "SerpApi Google Jobs",
        type: "SERPAPI",
        status: "skipped",
        imported: 0,
        details: `Skipped ${queries.length - serpApiQueries.length} SerpApi searches because SERPAPI_MAX_QUERIES_PER_RUN is ${serpApiMaxQueries}.`
      });
    }
  } else {
    reports.push({
      name: "SerpApi Google Jobs",
      type: "SERPAPI",
      status: "skipped",
      imported: 0,
      details: "Set SERPAPI_API_KEY to enable Google Jobs discovery through SerpApi."
    });
  }

  const configuredSources = await prisma.jobSource.findMany({
    where: {
      userId: options.userId,
      syncEnabled: true,
      type: { in: sourceTypesForConfiguredSync },
      OR: [
        { type: { notIn: ["RSS", "COMPANY_CAREERS"] } },
        { allowlisted: true }
      ]
    }
  });

  for (const source of configuredSources) {
    try {
      assertSourceCanSync(source);
      const jobs = await runProviderSearch({
        userId: options.userId,
        source,
        criteria: buildCriteriaFromSource(source, {
          location,
          remoteOnly,
          limit: limitPerQuery
        }),
        profile,
        index
      });

      await prisma.jobSource.update({
        where: { id: source.id },
        data: {
          lastSyncedAt: new Date(),
          lastSyncStatus: "SUCCESS",
          lastSyncError: null
        }
      });

      trackImportedJobs(tracker, jobs);
      reports.push({
        name: source.name,
        type: source.type,
        status: "imported",
        imported: jobs.imported.length,
        skipped: jobs.skipped,
        ...freshnessFields(jobs),
        bestRelevanceScore: jobs.bestRelevanceScore,
        details: reportDetails("Synced from a configured allowed source.", jobs)
      });
    } catch (error) {
      await prisma.jobSource.update({
        where: { id: source.id },
        data: {
          lastSyncStatus: "ERROR",
          lastSyncError: error instanceof Error ? error.message : "Configured source sync failed."
        }
      });

      reports.push({
        name: source.name,
        type: source.type,
        status: "error",
        imported: 0,
        details: error instanceof Error ? error.message : "Configured source sync failed."
      });
    }
  }

  const scoring = await scoreTopImportedJobs({
    userId: options.userId,
    jobs: [...tracker.scoringPool.values()],
    profile,
    limit: maxJobsToScore,
    enabled: scoreImported && aiSettings.aiDiscoveryEnabled,
    disabledReason: scoreImported ? "DISABLED_BY_POLICY" : "NOT_REQUESTED"
  });

  return {
    queries,
    location,
    imported: tracker.imported.size,
    unchanged: sumReports(reports, "unchanged"),
    duplicates: sumReports(reports, "duplicates"),
    closed: sumReports(reports, "closed"),
    boards: boardRun.boards,
    jobs: [...tracker.imported.values()].map(formatJob),
    scoredJobs: scoring.jobs,
    scoring: scoring.summary,
    reports,
    restrictedBoards: restrictedJobBoardPolicies
  };
}

/**
 * Scheduled preference discovery for the daily cron: the user's followed boards and matching
 * directory boards only. Query aggregators (some paid, some compliance-gated) are never called
 * from the cron. Scoring follows the user's saved scoreImported choice and the same cap.
 */
export async function runScheduledBoardDiscovery({
  userId,
  profile,
  preference,
  listingCache,
  scoringStopReason,
  maxBoards,
  boardDirectory,
  deadline
}: {
  userId: string;
  profile: UserProfile | null;
  preference: Pick<JobDiscoveryPreferences, "targetSearches" | "location" | "limitPerQuery" | "remoteOnly" | "scoreImported">;
  listingCache?: BoardListingCache;
  scoringStopReason?: DiscoveryScoringStopReason | null;
  maxBoards?: number;
  boardDirectory?: readonly JobBoardDirectoryEntry[];
  /** Epoch ms after which no new board is started. */
  deadline?: number;
}) {
  const aiSettings = await getOrCreateAiSettings(userId);
  const tracker = createRunTracker();
  const queries = resolveDiscoveryQueries({ savedPreference: preference, profilePreferredRoles: profile?.preferredRoles });
  const location = resolveDiscoveryLocation({ savedPreference: preference, profile });
  const boardRun = await runBoardDiscovery({
    userId,
    profile,
    queries,
    location,
    remoteOnly: preference.remoteOnly,
    limitPerBoard: preference.limitPerQuery,
    maxBoards,
    index: createRunDedupeIndex(),
    listingCache,
    directory: boardDirectory,
    deadline
  });
  trackImportedJobs(tracker, boardRun);

  const scoring = await scoreTopImportedJobs({
    userId,
    jobs: [...tracker.scoringPool.values()],
    profile,
    limit: Math.min(defaultMaxJobsToScore, aiSettings.maxAnalysesPerSync),
    enabled: preference.scoreImported && aiSettings.aiDiscoveryEnabled && !scoringStopReason,
    disabledReason: scoringStopReason ?? (preference.scoreImported ? "DISABLED_BY_POLICY" : "NOT_REQUESTED")
  });

  return {
    queries,
    imported: [...tracker.imported.values()],
    boards: boardRun.boards,
    reports: boardRun.reports,
    scoredJobs: scoring.jobs,
    scoring: scoring.summary
  };
}
