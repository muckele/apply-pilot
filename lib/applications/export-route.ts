import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";

import {
  buildApplicationsCsv,
  toApplicationExportRow,
  type ApplicationExportRow
} from "@/lib/applications/csv-export";
import { PublicApiError } from "@/lib/api-errors";
import {
  CURRENT_JOB_MATCH_ANALYSES,
  buildCurrentJobMatchContext,
  hasCurrentJobMatchAnalysis,
  readCurrentJobMatchSources
} from "@/lib/jobs/current-job-match";
import { CURRENT_EVIDENCE_SNAPSHOT_SELECT } from "@/lib/jobs/evidence-snapshot-contracts";
import { captureException } from "@/lib/monitoring/logger";
import { prisma } from "@/lib/prisma";
import { apiErrorResponse, UnauthorizedError } from "@/lib/user-context";

const PRIVATE_NO_STORE = "private, no-store";

/** Every read is pinned to one owner, including the nested timeline events. */
export function applicationExportQuery(userId: string) {
  return {
    where: { userId },
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    select: {
      id: true,
      userId: true,
      status: true,
      createdAt: true,
      dateApplied: true,
      followUpDueAt: true,
      jobPosting: {
        select: {
          company: true,
          title: true,
          sourceUrl: true,
          applyUrl: true,
          // Inputs needed to show the fit score only when the stored analysis is still current.
          location: true,
          remoteStatus: true,
          salaryMin: true,
          salaryMax: true,
          description: true,
          requirements: true,
          preferredQualifications: true,
          detectedTechStack: true,
          overallFitScore: true,
          currentEvidenceSnapshotId: true,
          evidenceSnapshotGeneration: true,
          currentEvidenceSnapshot: { select: CURRENT_EVIDENCE_SNAPSHOT_SELECT },
          aiAnalyses: CURRENT_JOB_MATCH_ANALYSES
        }
      },
      resumeVersion: { select: { id: true, title: true, userId: true } },
      coverLetterVersion: { select: { id: true, title: true, userId: true } },
      events: {
        where: { userId },
        orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
        take: 1,
        select: { title: true, occurredAt: true }
      }
    }
  } satisfies Prisma.ApplicationFindManyArgs;
}

export async function readApplicationExportRows(userId: string): Promise<ApplicationExportRow[]> {
  const [records, sources] = await Promise.all([
    prisma.application.findMany(applicationExportQuery(userId)),
    readCurrentJobMatchSources(userId)
  ]);

  return records.map((record) => {
    const context = buildCurrentJobMatchContext({ job: record.jobPosting, ...sources });
    const current = hasCurrentJobMatchAnalysis({
      ...record.jobPosting,
      currentEvidenceSourceValid: context.currentEvidenceSourceValid
    }, context.matchInput);
    return toApplicationExportRow(record, {
      userId,
      fitScore: current ? record.jobPosting.overallFitScore : null
    });
  });
}

type ApplicationsExportRouteDependencies = {
  requireUserId: () => Promise<string>;
  checkRateLimit: (key: string, limit: number, windowMs: number) => Promise<void>;
  readApplicationExportRows: (userId: string) => Promise<ApplicationExportRow[]>;
  now?: () => Date;
};

export function createApplicationsExportRouteHandlers(dependencies: ApplicationsExportRouteDependencies) {
  const now = dependencies.now ?? (() => new Date());

  return {
    async GET() {
      try {
        const userId = await dependencies.requireUserId();
        await dependencies.checkRateLimit(`applications:export:${userId}`, 10, 60_000);
        const csv = buildApplicationsCsv(await dependencies.readApplicationExportRows(userId));
        const filename = `apply-pilot-applications-${now().toISOString().slice(0, 10)}.csv`;

        return new NextResponse(csv, {
          status: 200,
          headers: {
            "Content-Type": "text/csv; charset=utf-8",
            "Content-Disposition": `attachment; filename="${filename}"`,
            "Cache-Control": PRIVATE_NO_STORE,
            "X-Content-Type-Options": "nosniff"
          }
        });
      } catch (error) {
        const response = error instanceof UnauthorizedError || error instanceof PublicApiError
          ? apiErrorResponse(error)
          : unexpectedExportError(error);
        response.headers.set("Cache-Control", PRIVATE_NO_STORE);
        return response;
      }
    }
  };
}

function unexpectedExportError(error: unknown) {
  captureException(error, { source: "applicationsExport" });
  return NextResponse.json({ error: "Applications could not be exported." }, { status: 500 });
}
