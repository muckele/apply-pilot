import { NextRequest, NextResponse } from "next/server";

import { checkDeploymentReadiness } from "@/lib/deployment-readiness";
import { captureException, logger } from "@/lib/monitoring/logger";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

const READINESS_TIMEOUT_MS = 3_000;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number) {
  let timeout: ReturnType<typeof setTimeout> | undefined;

  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timeout = setTimeout(
        () => reject(new Error(`Readiness check timed out after ${timeoutMs}ms.`)),
        timeoutMs
      );
    })
  ]).finally(() => {
    if (timeout) {
      clearTimeout(timeout);
    }
  });
}

export async function GET(request: NextRequest) {
  const startedAt = Date.now();
  const configuration = checkDeploymentReadiness(process.env, request.nextUrl.origin);

  try {
    await withTimeout(prisma.$queryRaw`SELECT 1`, READINESS_TIMEOUT_MS);

    if (!configuration.ready) {
      logger.warn("health.readiness.configuration_failed", {
        issues: configuration.issues
      });

      return NextResponse.json(
        {
          status: "not_ready",
          service: "jobmatch-crm",
          checks: {
            database: "ok",
            configuration: "failed"
          },
          capabilities: {
            aiMode: configuration.aiMode,
            directAudioUploads: configuration.directAudioUploads
          },
          configurationIssues: configuration.issues,
          latencyMs: Date.now() - startedAt,
          timestamp: new Date().toISOString()
        },
        { status: 503 }
      );
    }

    return NextResponse.json({
      status: "ready",
      service: "jobmatch-crm",
      checks: {
        database: "ok",
        configuration: "ok"
      },
      capabilities: {
        aiMode: configuration.aiMode,
        directAudioUploads: configuration.directAudioUploads
      },
      latencyMs: Date.now() - startedAt,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    captureException(error, {
      source: "health.readiness",
      latencyMs: Date.now() - startedAt
    });

    return NextResponse.json(
      {
        status: "not_ready",
        service: "jobmatch-crm",
        checks: {
          database: "failed",
          configuration: configuration.ready ? "ok" : "failed"
        },
        capabilities: {
          aiMode: configuration.aiMode,
          directAudioUploads: configuration.directAudioUploads
        },
        latencyMs: Date.now() - startedAt,
        timestamp: new Date().toISOString()
      },
      { status: 503 }
    );
  }
}
