import type { JobSource, UserProfile } from "@prisma/client";

import { getJobSourceProvider } from "@/lib/job-sources";
import { importJobsFromSource } from "@/lib/job-sources/discovery";
import type { JobSearchCriteria } from "@/lib/job-sources/types";
import { prisma } from "@/lib/prisma";

const urlRequiredSourceTypes = new Set<JobSource["type"]>(["RSS", "COMPANY_CAREERS"]);
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

type SourceRunOptions = {
  limit?: number;
  location?: string | null;
  remoteOnly?: boolean;
  query?: string | null;
};

export function assertSourceCanSync(source: JobSource) {
  if (source.type === "MANUAL") {
    throw new Error("Manual sources are saved through manual job import and cannot be synced.");
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

function formatSyncError(error: unknown) {
  return error instanceof Error ? error.message : "Source sync failed.";
}

export async function testJobSource(source: JobSource, options: SourceRunOptions = {}) {
  assertSourceCanSync(source);

  const provider = getJobSourceProvider(source.type);
  const allowed = await provider.validateAllowedSource(source.baseUrl ?? undefined);

  if (!allowed) {
    throw new Error("This source is not allowed by the provider validation rules.");
  }

  const rawJobs = await provider.searchJobs(buildCriteriaFromSource(source, { ...options, limit: 1 }));
  const sample = rawJobs[0] ? provider.normalizeJob(rawJobs[0]) : null;

  return {
    ok: true,
    rawCount: rawJobs.length,
    sample: sample
      ? {
          title: sample.title,
          company: sample.company || source.name,
          location: sample.location,
          sourceUrl: sample.sourceUrl
        }
      : null
  };
}

export async function runJobSourceSync({
  userId,
  source,
  options = {},
  profile
}: {
  userId: string;
  source: JobSource;
  options?: SourceRunOptions;
  profile?: UserProfile | null;
}) {
  assertSourceCanSync(source);

  await prisma.jobSource.update({
    where: { id: source.id },
    data: {
      lastSyncStatus: "RUNNING",
      lastSyncError: null
    }
  });

  try {
    const syncProfile = profile ?? (await prisma.userProfile.findUnique({ where: { userId } }));
    const result = await importJobsFromSource({
      userId,
      source,
      criteria: buildCriteriaFromSource(source, options),
      profile: syncProfile
    });

    await prisma.jobSource.update({
      where: { id: source.id },
      data: {
        lastSyncedAt: new Date(),
        lastSyncStatus: "SUCCESS",
        lastSyncError: null,
        robotsChecked: source.baseUrl ? true : source.robotsChecked,
        allowlisted: source.baseUrl ? true : source.allowlisted
      }
    });

    return result;
  } catch (error) {
    const message = formatSyncError(error);

    await prisma.jobSource.update({
      where: { id: source.id },
      data: {
        lastSyncStatus: "ERROR",
        lastSyncError: message
      }
    });

    throw error;
  }
}

export async function markJobSourceTestResult(sourceId: string, error?: unknown) {
  await prisma.jobSource.update({
    where: { id: sourceId },
    data: error
      ? {
          lastSyncStatus: "TEST_ERROR",
          lastSyncError: formatSyncError(error)
        }
      : {
          lastSyncStatus: "TEST_OK",
          lastSyncError: null
        }
  });
}
