import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { PublicApiError } from "@/lib/api-errors";
import {
  SELF_REPORTED_EFFORT_METADATA_KEY,
  buildSelfReportedEffort,
  effortMinutesSchema
} from "@/lib/applications/self-reported-effort";
import { prisma } from "@/lib/prisma";
import { checkRateLimit } from "@/lib/security/rate-limit";
import { apiErrorResponse, requireUserId } from "@/lib/user-context";

type Params = {
  params: Promise<{ id: string }>;
};

const effortSchema = z.object({ minutes: effortMinutesSchema }).strict();

// Adds or corrects the self-reported minutes for an application from its tracker page. Events are
// append-only, so a correction is a new timeline event and the latest record is the one Insights
// uses. Only applications with an applied date can have minutes, because Insights counts minutes
// in the week the application was applied.
export async function POST(request: NextRequest, { params }: Params) {
  try {
    const userId = await requireUserId();
    await checkRateLimit(`applications:effort:${userId}`, 30, 60_000);
    const { id } = await params;
    const input = effortSchema.parse(await request.json());
    const effort = await prisma.$transaction(async (tx) => {
      const application = await tx.application.findFirst({
        where: { id, userId },
        select: { id: true, dateApplied: true }
      });
      if (!application) throw new PublicApiError("Application not found.", 404);
      if (!application.dateApplied) {
        throw new PublicApiError("Record this application as applied before adding the minutes it took.", 409);
      }
      const record = buildSelfReportedEffort({ minutes: input.minutes, recordedAt: new Date() });
      await tx.applicationEvent.create({
        data: {
          userId,
          applicationId: application.id,
          type: "NOTE_ADDED",
          title: `Minutes this application took: ${record.minutes}`,
          metadata: { [SELF_REPORTED_EFFORT_METADATA_KEY]: record }
        }
      });
      await tx.auditLog.create({
        data: {
          userId,
          action: "application.effort_recorded",
          resource: "Application",
          resourceId: application.id,
          metadata: {}
        }
      });
      return record;
    });

    return NextResponse.json({ effort: { minutes: effort.minutes, recordedAt: effort.recordedAt } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
