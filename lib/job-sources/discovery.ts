import type { JobPosting, JobSource, JobSourceType } from "@prisma/client";

import { getJobSourceProvider } from "@/lib/job-sources";
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
  details: string;
};

export type RestrictedBoardPolicy = {
  name: string;
  status: "approved_api_required";
  reason: string;
  allowedPath: string;
  policyUrl: string;
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
  query
}: {
  userId: string;
  source: JobSource;
  rawJobs: RawJob[];
  query?: string;
}) {
  const provider = getJobSourceProvider(source.type);
  const seen = new Set<string>();
  const imported: JobPosting[] = [];

  for (const rawJob of rawJobs) {
    const normalized = provider.normalizeJob(rawJob);
    const job = {
      ...normalized,
      company: normalized.company || source.name
    };
    const key = normalizedJobKey(job);

    if (!job.title || !job.sourceUrl || seen.has(key) || !queryMatchesJob(job, query)) {
      continue;
    }

    seen.add(key);
    imported.push(await upsertNormalizedJob({ userId, jobSourceId: source.id, job }));
  }

  return imported;
}

async function runProviderSearch({
  userId,
  source,
  criteria
}: {
  userId: string;
  source: JobSource;
  criteria: JobSearchCriteria;
}) {
  const provider = getJobSourceProvider(source.type);
  const rawJobs = await provider.searchJobs(criteria);

  return importRawJobs({ userId, source, rawJobs, query: criteria.query });
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
        criteria: { query, remote: true, limit: limitPerQuery }
      });

      jobs.forEach((job) => importedJobs.set(job.id, job));
      reports.push({
        name: `Remotive: ${query}`,
        type: "REMOTIVE",
        status: "imported",
        imported: jobs.length,
        details: "Pulled through Remotive's public remote jobs API."
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
          }
        });

        jobs.forEach((job) => importedJobs.set(job.id, job));
        reports.push({
          name: `USAJOBS: ${query}`,
          type: "USAJOBS",
          status: "imported",
          imported: jobs.length,
          details: "Pulled through the official USAJOBS API."
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
          }
        });

        jobs.forEach((job) => importedJobs.set(job.id, job));
        reports.push({
          name: `Adzuna: ${query}`,
          type: "ADZUNA",
          status: "imported",
          imported: jobs.length,
          details: "Pulled through the Adzuna jobs API."
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
          }
        });

        jobs.forEach((job) => importedJobs.set(job.id, job));
        reports.push({
          name: `TheirStack: ${query}`,
          type: "THEIRSTACK",
          status: "imported",
          imported: jobs.length,
          details: "Pulled through TheirStack's licensed jobs API. This may consume provider credits."
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
        }
      });

      await prisma.jobSource.update({
        where: { id: source.id },
        data: { lastSyncedAt: new Date() }
      });

      jobs.forEach((job) => importedJobs.set(job.id, job));
      reports.push({
        name: source.name,
        type: source.type,
        status: "imported",
        imported: jobs.length,
        details: "Synced from a configured allowed source."
      });
    } catch (error) {
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
