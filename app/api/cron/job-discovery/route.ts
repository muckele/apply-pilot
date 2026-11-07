import { NextRequest, NextResponse } from "next/server";

import { createBoardListingCache } from "@/lib/job-sources/board-sync";
import { complianceDisabledSourceTypes } from "@/lib/job-sources/compliance";
import {
  combineDiscoveryScoringSummaries,
  isSystemicDiscoveryScoringStopReason,
  runScheduledBoardDiscovery,
  type DiscoveryScoringStopReason,
  type DiscoveryScoringSummary
} from "@/lib/job-sources/discovery";
import { runJobSourceSync } from "@/lib/job-sources/source-management";
import { getAllowedAuthEmails, isEmailAllowedForAuth, requiresEmailAllowlist } from "@/lib/auth-access";
import { captureException, logger } from "@/lib/monitoring/logger";
import { prisma } from "@/lib/prisma";
import { writeAuditLog } from "@/lib/security/audit-log";
import { cronJobDiscoverySchema } from "@/lib/validators";

export const dynamic = "force-dynamic";
// Fits Vercel Pro. The route stops scheduling new work at timeBudgetRatio of this so that
// in-flight boards, scoring and the response can finish inside the limit.
export const maxDuration = 300;

const timeBudgetRatio = 0.8;
const timeBudgetMessage = "Deferred to the next run: this cron run reached its time budget.";

// Upper bound on users whose saved preferences run board discovery in one cron invocation.
const maxPreferenceUsersPerRun = 25;

type PreferenceRunResult = {
  userId: string;
  status: "success" | "error" | "skipped" | "deferred";
  imported: number;
  boards?: { followed: number; directory: number; deferred: number; timeDeferred: number };
  scoring?: DiscoveryScoringSummary;
  error?: string;
};

/**
 * Preference discovery over public ATS boards for every user with saved discovery preferences:
 * followed boards plus matching directory boards. One listing cache serves the whole
 * invocation, so each board is fetched at most once however many users match it. Followed
 * boards synced here get a fresh lastSyncedAt, so the per-source phase below skips them.
 */
async function runPreferenceBoardPhase(
  privateUserFilter: Record<string, unknown>,
  scoringStopReasonsByUser: Map<string, DiscoveryScoringStopReason>,
  deadline: number
) {
  // Least recently run first: each completed user's preference row is touched below, so users
  // deferred by the time budget lead the next run.
  const preferences = await prisma.jobDiscoveryPreference.findMany({
    where: privateUserFilter,
    include: { user: { include: { profile: true } } },
    orderBy: [{ updatedAt: "asc" }, { userId: "asc" }],
    take: maxPreferenceUsersPerRun
  });
  const listingCache = createBoardListingCache();
  const results: PreferenceRunResult[] = [];

  for (const preference of preferences) {
    if (!isEmailAllowedForAuth(preference.user.email)) {
      results.push({
        userId: preference.userId,
        status: "skipped",
        imported: 0,
        error: "User is not approved for this private deployment."
      });
      continue;
    }

    if (Date.now() >= deadline) {
      results.push({ userId: preference.userId, status: "deferred", imported: 0, error: timeBudgetMessage });
      continue;
    }

    try {
      const result = await runScheduledBoardDiscovery({
        userId: preference.userId,
        profile: preference.user.profile,
        preference,
        listingCache,
        scoringStopReason: scoringStopReasonsByUser.get(preference.userId),
        deadline
      });
      await prisma.jobDiscoveryPreference.update({
        where: { userId: preference.userId },
        data: { updatedAt: new Date() }
      });

      results.push({
        userId: preference.userId,
        status: "success",
        imported: result.imported.length,
        boards: result.boards,
        scoring: result.scoring
      });

      if (isSystemicDiscoveryScoringStopReason(result.scoring.stopReason)) {
        scoringStopReasonsByUser.set(preference.userId, result.scoring.stopReason);
      }

      await writeAuditLog({
        userId: preference.userId,
        action: "job.discovery.cron.preferences",
        resource: "JobPosting",
        metadata: { imported: result.imported.length, boards: result.boards, scoring: result.scoring }
      });
    } catch (error) {
      results.push({
        userId: preference.userId,
        status: "error",
        imported: 0,
        error: error instanceof Error ? error.message : "Preference board discovery failed."
      });
      captureException(error, { source: "cron.job-discovery.preferences", userId: preference.userId });
    }
  }

  return results;
}

class CronAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CronAuthError";
  }
}

function assertCronAuthorized(request: NextRequest) {
  const configuredSecret = process.env.CRON_SECRET;
  const authorization = request.headers.get("authorization") ?? "";
  const bearerToken = authorization.replace(/^Bearer\s+/i, "").trim();

  if (!configuredSecret) {
    throw new CronAuthError("CRON_SECRET is not configured.");
  }

  if (bearerToken !== configuredSecret) {
    throw new CronAuthError("Invalid cron token.");
  }
}

async function readCronOptions(request: NextRequest) {
  if (request.method === "POST") {
    return cronJobDiscoverySchema.parse(await request.json().catch(() => ({})));
  }

  return cronJobDiscoverySchema.parse({
    limitPerSource: request.nextUrl.searchParams.get("limitPerSource") ?? undefined,
    maxSources: request.nextUrl.searchParams.get("maxSources") ?? undefined,
    location: request.nextUrl.searchParams.get("location") ?? undefined,
    remoteOnly: request.nextUrl.searchParams.get("remoteOnly") === "true"
  });
}

function readPositiveIntEnv(name: string, fallback: number, min: number, max: number) {
  const parsed = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

async function runCron(request: NextRequest) {
  const startedAt = Date.now();
  const deadline = startedAt + maxDuration * 1000 * timeBudgetRatio;
  assertCronAuthorized(request);
  const options = await readCronOptions(request);
  const maxSources = options.maxSources ?? readPositiveIntEnv("CRON_MAX_SOURCES_PER_RUN", 10, 1, 100);
  const minSourceIntervalMinutes = readPositiveIntEnv("CRON_MIN_SOURCE_INTERVAL_MINUTES", 360, 5, 10_080);
  const runningLockMinutes = readPositiveIntEnv("CRON_RUNNING_LOCK_MINUTES", 30, 5, 240);
  const syncedBefore = new Date(Date.now() - minSourceIntervalMinutes * 60_000);
  const staleRunningBefore = new Date(Date.now() - runningLockMinutes * 60_000);
  const privateUserFilter = requiresEmailAllowlist()
    ? { user: { email: { in: getAllowedAuthEmails() } } }
    : {};
  const scoringStopReasonsByUser = new Map<string, DiscoveryScoringStopReason>();
  const preferenceResults = await runPreferenceBoardPhase(privateUserFilter, scoringStopReasonsByUser, deadline);
  const sources = await prisma.jobSource.findMany({
    where: {
      syncEnabled: true,
      type: { notIn: ["MANUAL", ...complianceDisabledSourceTypes()] },
      ...privateUserFilter,
      AND: [
        {
          OR: [{ lastSyncedAt: null }, { lastSyncedAt: { lt: syncedBefore } }]
        },
        {
          OR: [{ lastSyncStatus: null }, { lastSyncStatus: { not: "RUNNING" } }, { updatedAt: { lt: staleRunningBefore } }]
        },
        {
          OR: [{ type: { notIn: ["RSS", "COMPANY_CAREERS"] } }, { allowlisted: true }]
        }
      ]
    },
    include: {
      user: {
        include: {
          profile: true
        }
      }
    },
    orderBy: [{ lastSyncedAt: "asc" }, { userId: "asc" }, { type: "asc" }, { name: "asc" }],
    take: maxSources
  });
  const results: Array<{
    sourceId: string;
    sourceName: string;
    userId: string;
    status: "success" | "error" | "skipped" | "deferred";
    imported: number;
    skipped?: number;
    scoring?: DiscoveryScoringSummary;
    error?: string;
  }> = [];

  for (const source of sources) {
    // Sources are ordered by lastSyncedAt, so a deferred source leads the next run.
    if (Date.now() >= deadline) {
      results.push({
        sourceId: source.id,
        sourceName: source.name,
        userId: source.userId,
        status: "deferred",
        imported: 0,
        error: timeBudgetMessage
      });
      continue;
    }

    if (!isEmailAllowedForAuth(source.user.email)) {
      results.push({
        sourceId: source.id,
        sourceName: source.name,
        userId: source.userId,
        status: "skipped",
        imported: 0,
        error: "User is not approved for this private deployment."
      });
      logger.warn("cron.job_discovery.source_skipped_disallowed_user", {
        sourceId: source.id,
        userId: source.userId
      });
      continue;
    }

    try {
      const result = await runJobSourceSync({
        userId: source.userId,
        source,
        profile: source.user.profile,
        scoringStopReason: scoringStopReasonsByUser.get(source.userId),
        options: {
          limit: options.limitPerSource,
          location: options.location,
          remoteOnly: options.remoteOnly
        }
      });

      results.push({
        sourceId: source.id,
        sourceName: source.name,
        userId: source.userId,
        status: "success",
        imported: result.imported.length,
        skipped: result.skipped,
        scoring: result.scoring
      });

      if (isSystemicDiscoveryScoringStopReason(result.scoring.stopReason)) {
        scoringStopReasonsByUser.set(source.userId, result.scoring.stopReason);
      }

      await writeAuditLog({
        userId: source.userId,
        action: "job.discovery.cron.source.sync",
        resource: "JobSource",
        resourceId: source.id,
        metadata: { imported: result.imported.length, skipped: result.skipped, scoring: result.scoring }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Cron source sync failed.";
      results.push({
        sourceId: source.id,
        sourceName: source.name,
        userId: source.userId,
        status: "error",
        imported: 0,
        error: message
      });
      captureException(error, {
        source: "cron.job-discovery",
        jobSourceId: source.id,
        userId: source.userId
      });
    }
  }

  const allResults = [...preferenceResults, ...results];
  const imported = allResults.reduce((total, result) => total + result.imported, 0);
  const failed = allResults.filter((result) => result.status === "error").length;
  const scoring = combineDiscoveryScoringSummaries(
    allResults.flatMap((result) => result.scoring ? [result.scoring] : [])
  );
  const deferredUsers = preferenceResults.filter((result) => result.status === "deferred").length;
  const deferredSources = results.filter((result) => result.status === "deferred").length;
  const deferredBoards = preferenceResults.reduce((total, result) => total + (result.boards?.timeDeferred ?? 0), 0);
  const timeBudget = {
    maxDurationSeconds: maxDuration,
    budgetSeconds: maxDuration * timeBudgetRatio,
    exhausted: Date.now() >= deadline || deferredUsers + deferredSources + deferredBoards > 0,
    deferredUsers,
    deferredBoards,
    deferredSources
  };

  logger.info("cron.job_discovery.completed", {
    preferenceUsers: preferenceResults.length,
    sources: sources.length,
    imported,
    failed,
    scoring,
    timeBudget,
    elapsedMs: Date.now() - startedAt,
    maxSources,
    minSourceIntervalMinutes
  });

  return NextResponse.json({
    ok: failed === 0,
    preferenceUsers: preferenceResults.length,
    preferenceResults,
    sources: sources.length,
    imported,
    failed,
    scoring,
    timeBudget,
    results
  });
}

export async function GET(request: NextRequest) {
  try {
    return await runCron(request);
  } catch (error) {
    if (error instanceof CronAuthError) {
      logger.warn("cron.job_discovery.unauthorized", { error: error.message });
      return NextResponse.json({ error: error.message }, { status: 401 });
    }

    captureException(error, { source: "cron.job-discovery.auth" });
    return NextResponse.json({ error: error instanceof Error ? error.message : "Cron failed." }, { status: 400 });
  }
}

export async function POST(request: NextRequest) {
  try {
    return await runCron(request);
  } catch (error) {
    if (error instanceof CronAuthError) {
      logger.warn("cron.job_discovery.unauthorized", { error: error.message });
      return NextResponse.json({ error: error.message }, { status: 401 });
    }

    captureException(error, { source: "cron.job-discovery.auth" });
    return NextResponse.json({ error: error instanceof Error ? error.message : "Cron failed." }, { status: 400 });
  }
}
