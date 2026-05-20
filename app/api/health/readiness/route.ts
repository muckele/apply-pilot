import { NextResponse } from "next/server";

import { captureException } from "@/lib/monitoring/logger";
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

export async function GET() {
  const startedAt = Date.now();

  try {
    await withTimeout(prisma.$queryRaw`SELECT 1`, READINESS_TIMEOUT_MS);

    return NextResponse.json({
      status: "ready",
      service: "jobmatch-crm",
      checks: {
        database: "ok"
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
          database: "failed"
        },
        latencyMs: Date.now() - startedAt,
        timestamp: new Date().toISOString()
      },
      { status: 503 }
    );
  }
}
