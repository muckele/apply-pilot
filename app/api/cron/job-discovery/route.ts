import { NextRequest, NextResponse } from "next/server";

import { runJobSourceSync } from "@/lib/job-sources/source-management";
import { captureException, logger } from "@/lib/monitoring/logger";
import { prisma } from "@/lib/prisma";
import { writeAuditLog } from "@/lib/security/audit-log";
import { cronJobDiscoverySchema } from "@/lib/validators";

export const dynamic = "force-dynamic";

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
  const queryToken = request.nextUrl.searchParams.get("secret") ?? "";

  if (!configuredSecret) {
    throw new CronAuthError("CRON_SECRET is not configured.");
  }

  if (bearerToken !== configuredSecret && queryToken !== configuredSecret) {
    throw new CronAuthError("Invalid cron token.");
  }
}

async function readCronOptions(request: NextRequest) {
  if (request.method === "POST") {
    return cronJobDiscoverySchema.parse(await request.json().catch(() => ({})));
  }

  return cronJobDiscoverySchema.parse({
    limitPerSource: request.nextUrl.searchParams.get("limitPerSource") ?? undefined,
    location: request.nextUrl.searchParams.get("location") ?? undefined,
    remoteOnly: request.nextUrl.searchParams.get("remoteOnly") === "true"
  });
}

async function runCron(request: NextRequest) {
  assertCronAuthorized(request);
  const options = await readCronOptions(request);
  const sources = await prisma.jobSource.findMany({
    where: {
      syncEnabled: true,
      type: { not: "MANUAL" }
    },
    include: {
      user: {
        include: {
          profile: true
        }
      }
    },
    orderBy: [{ userId: "asc" }, { type: "asc" }, { name: "asc" }]
  });
  const results: Array<{
    sourceId: string;
    sourceName: string;
    userId: string;
    status: "success" | "error";
    imported: number;
    skipped?: number;
    error?: string;
  }> = [];

  for (const source of sources) {
    try {
      const result = await runJobSourceSync({
        userId: source.userId,
        source,
        profile: source.user.profile,
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
        skipped: result.skipped
      });

      await writeAuditLog({
        userId: source.userId,
        action: "job.discovery.cron.source.sync",
        resource: "JobSource",
        resourceId: source.id,
        metadata: { imported: result.imported.length, skipped: result.skipped }
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

  const imported = results.reduce((total, result) => total + result.imported, 0);
  const failed = results.filter((result) => result.status === "error").length;

  logger.info("cron.job_discovery.completed", {
    sources: sources.length,
    imported,
    failed
  });

  return NextResponse.json({
    ok: failed === 0,
    sources: sources.length,
    imported,
    failed,
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
