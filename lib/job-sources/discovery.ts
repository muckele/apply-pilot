import type { JobPosting, JobSource, JobSourceType, UserProfile } from "@prisma/client";

import { getJobSourceProvider } from "@/lib/job-sources";
import { scoreJobRelevance, type JobRelevanceResult } from "@/lib/job-sources/relevance";
import { isRemoteLikeText } from "@/lib/job-sources/remote";
import type { JobSearchCriteria, NormalizedJob, RawJob } from "@/lib/job-sources/types";
import { upsertNormalizedJob, runJobMatch } from "@/lib/jobs";
import { normalizeText, normalizeUrl } from "@/lib/normalize";
import { prisma } from "@/lib/prisma";

export type AutomatedDiscoveryOptions = {
  userId: string;
  queries?: string[];
  location?: string;
  remoteOnly?: boolean;
  limitPerQuery?: number;
  scoreImported?: boolean;
  maxJobsToScore?: number;
};

export type DiscoverySourceReport = {
  name: string;
  type: string;
  status: "imported" | "skipped" | "blocked" | "error";
  imported: number;
  skipped?: number;
  bestRelevanceScore?: number;
  details: string;
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
  skipped: number;
  bestRelevanceScore: number;
};

const targetRoleFallbacks = [
  "Sales Engineer",
  "Solutions Engineer",
  "Technical Account Manager",
  "Customer Success Engineer",
  "Implementation Specialist",
  "Full-Stack Developer",
  "Junior Software Engineer",
  "SaaS Operations"
];

const sourceTypesForConfiguredSync: JobSourceType[] = [
  "GREENHOUSE",
  "LEVER",
  "ASHBY",
  "WORKABLE",
  "RSS",
  "COMPANY_CAREERS"
];

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

function resolveQueries(options: AutomatedDiscoveryOptions, preferredRoles: string[]) {
  const supplied = options.queries?.map((query) => query.trim()).filter(Boolean) ?? [];
  const queries = supplied.length ? supplied : preferredRoles.length ? preferredRoles : targetRoleFallbacks;

  return [...new Set(queries)].slice(0, 8);
}

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

function normalizedJobKey(job: NormalizedJob) {
  return [
    normalizeText(job.company),
    normalizeText(job.title),
    normalizeText(job.location),
    normalizeUrl(job.applyUrl ?? job.sourceUrl)
  ].join("|");
}

function queryMatchesJob(job: NormalizedJob, query?: string) {
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

function matchesRemoteOnly(job: NormalizedJob, remoteOnly?: boolean) {
  if (!remoteOnly) {
    return true;
  }

  return isRemoteLikeText(job.remoteStatus) || isRemoteLikeText(job.location) || isRemoteLikeText(job.description);
}

function maxPostedAgeDays() {
  return readPositiveIntegerEnv("JOB_SOURCE_MAX_POSTED_AGE_DAYS", 30);
}

function readPositiveIntegerEnv(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function jobPostedAgeDays(job: NormalizedJob) {
  if (!job.datePosted || Number.isNaN(job.datePosted.getTime())) {
    return null;
  }

  return (Date.now() - job.datePosted.getTime()) / 86_400_000;
}

function isRemoteOrHybrid(job: NormalizedJob) {
  const workStyleText = normalizeText([job.remoteStatus, job.location, job.description].join(" "));

  return (
    isRemoteLikeText(job.remoteStatus) ||
    isRemoteLikeText(job.location) ||
    workStyleText.includes("hybrid") ||
    workStyleText.includes("remote")
  );
}

function locationMatchesProfile(job: NormalizedJob, profile: UserProfile | null) {
  const location = normalizeText(job.location);

  if (!location || isRemoteOrHybrid(job)) {
    return true;
  }

  const preferredLocations = profile?.preferredLocations?.map(normalizeText).filter(Boolean) ?? [];

  if (!preferredLocations.length) {
    return true;
  }

  if (location.includes("united states") || location === "us" || location === "usa") {
    return true;
  }

  const locationAliases = ["los angeles", "fontana", "pasadena", "orange county", "southern california", "california", " ca"];
  if (
    preferredLocations.some((preferred) => location.includes(preferred) || preferred.includes(location)) ||
    locationAliases.some((alias) => location.includes(alias))
  ) {
    return true;
  }

  return false;
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

  if (profile?.remotePreference === "REMOTE" && !isRemoteOrHybrid(job)) {
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

  if (relevance.breakdown.roleTitleScore < 45 && relevance.breakdown.bodyEvidenceScore < 70) {
    return "Role title and body evidence are too weak for the target profile.";
  }

  if (relevance.decision === "skip") {
    return "Overall relevance score is below the save threshold.";
  }

  return null;
}

function trackImportedJobs(target: Map<string, JobPosting>, result: ProviderSearchResult) {
  result.imported.forEach((job) => target.set(job.id, job));
}

function reportDetails(base: string, result: ProviderSearchResult) {
  if (!result.imported.length && result.skipped) {
    return `${base} No jobs passed the current relevance filter.`;
  }

  return base;
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
  profile
}: {
  userId: string;
  source: JobSource;
  rawJobs: RawJob[];
  query?: string;
  remoteOnly?: boolean;
  profile: Awaited<ReturnType<typeof prisma.userProfile.findUnique>>;
}) {
  const provider = getJobSourceProvider(source.type);
  const seen = new Set<string>();
  const imported: JobPosting[] = [];
  let skipped = 0;
  let bestRelevanceScore = 0;

  for (const rawJob of rawJobs) {
    const normalized = provider.normalizeJob(rawJob);
    const job = {
      ...normalized,
      company: normalized.company || source.name
    };
    const key = normalizedJobKey(job);

    if (
      !job.title ||
      !job.sourceUrl ||
      seen.has(key) ||
      !queryMatchesJob(job, query) ||
      !matchesRemoteOnly(job, remoteOnly)
    ) {
      skipped += 1;
      continue;
    }

    const relevance = scoreJobRelevance({ job, profile, query });
    bestRelevanceScore = Math.max(bestRelevanceScore, relevance.score);
    const rejectionReason = getPreImportRejectionReason({ job, profile, relevance, remoteOnly });

    if (rejectionReason) {
      skipped += 1;
      continue;
    }

    seen.add(key);
    imported.push(await upsertJobWithRelevance({ userId, jobSourceId: source.id, job, relevance }));
  }

  return { imported, skipped, bestRelevanceScore };
}

async function upsertJobWithRelevance({
  userId,
  jobSourceId,
  job,
  relevance
}: {
  userId: string;
  jobSourceId?: string;
  job: NormalizedJob;
  relevance: JobRelevanceResult;
}) {
  const upserted = await upsertNormalizedJob({ userId, jobSourceId, job });
  const hasAiScore = upserted.confidenceScore !== null;

  return prisma.jobPosting.update({
    where: { id: upserted.id },
    data: {
      overallFitScore: hasAiScore ? upserted.overallFitScore : relevance.score,
      keyMatchReason: hasAiScore ? (upserted.keyMatchReason ?? relevance.reasons[0]) : relevance.reasons[0],
      matchRecommendation: hasAiScore
        ? (upserted.matchRecommendation ?? relevance.recommendation)
        : relevance.recommendation,
      supportedKeywords: hasAiScore && upserted.supportedKeywords.length ? upserted.supportedKeywords : relevance.supportedKeywords,
      missingKeywords:
        hasAiScore && upserted.missingKeywords.length ? upserted.missingKeywords : relevance.keywordsToStrengthen,
      suggestedResumeAngle: hasAiScore ? (upserted.suggestedResumeAngle ?? relevance.resumeAngle) : relevance.resumeAngle,
      suggestedCoverLetterAngle: hasAiScore
        ? upserted.suggestedCoverLetterAngle
        : "Connect Mathew's software training, customer-facing sales background, and operations leadership to the company's role-specific needs.",
      concerns: hasAiScore && upserted.concerns.length ? upserted.concerns : relevance.concerns
    }
  });
}

async function runProviderSearch({
  userId,
  source,
  criteria,
  profile
}: {
  userId: string;
  source: JobSource;
  criteria: JobSearchCriteria;
  profile: Awaited<ReturnType<typeof prisma.userProfile.findUnique>>;
}) {
  const provider = getJobSourceProvider(source.type);
  const rawJobs = await provider.searchJobs(criteria);

  return importRawJobs({ userId, source, rawJobs, query: criteria.query, remoteOnly: criteria.remote, profile });
}

export async function importJobsFromSource({
  userId,
  source,
  criteria,
  profile
}: {
  userId: string;
  source: JobSource;
  criteria: JobSearchCriteria;
  profile: Awaited<ReturnType<typeof prisma.userProfile.findUnique>>;
}) {
  return runProviderSearch({ userId, source, criteria, profile });
}

export async function runAutomatedJobDiscovery(options: AutomatedDiscoveryOptions) {
  const limitPerQuery = options.limitPerQuery ?? 10;
  const maxJobsToScore = options.maxJobsToScore ?? 8;
  const reports: DiscoverySourceReport[] = [];
  const importedJobs = new Map<string, JobPosting>();
  const profile = await prisma.userProfile.findUnique({ where: { userId: options.userId } });
  const queries = resolveQueries(options, profile?.preferredRoles ?? []);
  const location = options.location || profile?.preferredLocations?.[0] || "Los Angeles, CA";

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
        profile
      });

      trackImportedJobs(importedJobs, jobs);
      reports.push({
        name: `Remotive: ${query}`,
        type: "REMOTIVE",
        status: "imported",
        imported: jobs.imported.length,
        skipped: jobs.skipped,
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
            remote: options.remoteOnly,
            limit: limitPerQuery
          },
          profile
        });

        trackImportedJobs(importedJobs, jobs);
        reports.push({
          name: `USAJOBS: ${query}`,
          type: "USAJOBS",
          status: "imported",
          imported: jobs.imported.length,
          skipped: jobs.skipped,
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

  if (process.env.ADZUNA_APP_ID && process.env.ADZUNA_APP_KEY) {
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
            remote: options.remoteOnly,
            limit: limitPerQuery
          },
          profile
        });

        trackImportedJobs(importedJobs, jobs);
        reports.push({
          name: `Adzuna: ${query}`,
          type: "ADZUNA",
          status: "imported",
          imported: jobs.imported.length,
          skipped: jobs.skipped,
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
      details: "Set ADZUNA_APP_ID and ADZUNA_APP_KEY to enable broad job API discovery."
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
            remote: options.remoteOnly,
            limit: limitPerQuery
          },
          profile
        });

        trackImportedJobs(importedJobs, jobs);
        reports.push({
          name: `TheirStack: ${query}`,
          type: "THEIRSTACK",
          status: "imported",
          imported: jobs.imported.length,
          skipped: jobs.skipped,
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
            remote: options.remoteOnly,
            limit: Math.min(limitPerQuery, 10)
          },
          profile
        });

        trackImportedJobs(importedJobs, jobs);
        reports.push({
          name: `SerpApi Google Jobs: ${query}`,
          type: "SERPAPI",
          status: "imported",
          imported: jobs.imported.length,
          skipped: jobs.skipped,
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
      type: { in: sourceTypesForConfiguredSync }
    }
  });

  for (const source of configuredSources) {
    try {
      const jobs = await runProviderSearch({
        userId: options.userId,
        source,
        criteria: {
          company: source.boardToken ?? source.name,
          boardToken: source.boardToken ?? undefined,
          url: source.baseUrl ?? undefined,
          location,
          limit: limitPerQuery
        },
        profile
      });

      await prisma.jobSource.update({
        where: { id: source.id },
        data: {
          lastSyncedAt: new Date(),
          lastSyncStatus: "SUCCESS",
          lastSyncError: null
        }
      });

      trackImportedJobs(importedJobs, jobs);
      reports.push({
        name: source.name,
        type: source.type,
        status: "imported",
        imported: jobs.imported.length,
        skipped: jobs.skipped,
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

  const scoredJobs: Array<{ jobId: string; score?: number; error?: string }> = [];
  if (options.scoreImported) {
    for (const job of [...importedJobs.values()].slice(0, maxJobsToScore)) {
      try {
        const result = await runJobMatch(options.userId, job.id);
        scoredJobs.push({ jobId: job.id, score: result.job.overallFitScore ?? undefined });
      } catch (error) {
        scoredJobs.push({
          jobId: job.id,
          error: error instanceof Error ? error.message : "Scoring failed."
        });
      }
    }
  }

  return {
    queries,
    location,
    imported: importedJobs.size,
    jobs: [...importedJobs.values()].map(formatJob),
    scoredJobs,
    reports,
    restrictedBoards: restrictedJobBoardPolicies
  };
}
