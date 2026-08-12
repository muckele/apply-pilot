import type { JobSource, UserProfile } from "@prisma/client";

import { getJobSourceProvider } from "@/lib/job-sources";
import { importJobsFromSource, scoreTopImportedJobs } from "@/lib/job-sources/discovery";
import {
  assertSourceCanSync,
  buildCriteriaFromSource,
  type SourceRunOptions
} from "@/lib/job-sources/source-policy";
import { prisma } from "@/lib/prisma";
import { getOrCreateAiSettings } from "@/lib/ai/usage";

function getRunningLockMs() {
  const minutes = Number(process.env.CRON_RUNNING_LOCK_MINUTES ?? 30);
  return Math.max(5, Number.isFinite(minutes) ? minutes : 30) * 60_000;
}

async function claimSyncLock(sourceId: string) {
  const staleBefore = new Date(Date.now() - getRunningLockMs());
  const result = await prisma.jobSource.updateMany({
    where: {
      id: sourceId,
      OR: [{ lastSyncStatus: null }, { lastSyncStatus: { not: "RUNNING" } }, { updatedAt: { lt: staleBefore } }]
    },
    data: {
      lastSyncStatus: "RUNNING",
      lastSyncError: null
    }
  });

  if (result.count === 0) {
    throw new Error("This source is already syncing. Try again after the current run finishes.");
  }
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

  await claimSyncLock(source.id);

  try {
    const syncProfile = profile ?? (await prisma.userProfile.findUnique({ where: { userId } }));
    const result = await importJobsFromSource({
      userId,
      source,
      criteria: buildCriteriaFromSource(source, options),
      profile: syncProfile
    });
    const aiSettings = await getOrCreateAiSettings(userId);
    const scoredJobs = aiSettings.aiDiscoveryEnabled
      ? await scoreTopImportedJobs({
          userId,
          jobs: result.imported,
          limit: aiSettings.maxAnalysesPerSync
        })
      : [];

    await prisma.jobSource.update({
      where: { id: source.id },
      data: {
        lastSyncedAt: new Date(),
        lastSyncStatus: "SUCCESS",
        lastSyncError: null,
        robotsChecked: source.baseUrl ? true : source.robotsChecked,
        allowlisted: source.allowlisted
      }
    });

    return { ...result, scoredJobs };
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
