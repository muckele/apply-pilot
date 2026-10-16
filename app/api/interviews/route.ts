import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { resolveInterviewJobPostingId } from "@/lib/interviews/linking";
import { prisma } from "@/lib/prisma";
import { checkRateLimit } from "@/lib/security/rate-limit";
import { apiErrorResponse, requireUserId } from "@/lib/user-context";

const createInterviewSchema = z.object({
  jobPostingId: z.string().optional(),
  applicationId: z.string().optional(),
  type: z.enum(["RECRUITER", "HIRING_MANAGER", "TECHNICAL", "PANEL", "FINAL", "OTHER"]),
  scheduledAt: z.coerce.date().optional(),
  durationMinutes: z.coerce.number().int().positive().optional(),
  locationOrLink: z.string().optional(),
  interviewerNames: z.array(z.string()).optional().default([]),
  interviewerUrls: z.array(z.string().url()).optional().default([]),
  generatePrep: z.boolean().optional().default(false)
});

export async function POST(request: NextRequest) {
  try {
    const userId = await requireUserId();
    await checkRateLimit(`interviews:create:${userId}`, 30, 60_000);
    const input = createInterviewSchema.parse(await request.json());
    const [requestedJob, application] = await Promise.all([
      input.jobPostingId
        ? prisma.jobPosting.findFirstOrThrow({ where: { id: input.jobPostingId, userId } })
        : null,
      input.applicationId
        ? prisma.application.findFirstOrThrow({ where: { id: input.applicationId, userId } })
        : null
    ]);

    const linkedJobPostingId = resolveInterviewJobPostingId({
      requestedJobPostingId: requestedJob?.id,
      applicationJobPostingId: application?.jobPostingId
    });
    const interview = await prisma.$transaction(async (tx) => {
      const savedInterview = await tx.interview.create({
        data: {
          userId,
          jobPostingId: linkedJobPostingId,
          applicationId: input.applicationId,
          type: input.type,
          scheduledAt: input.scheduledAt,
          durationMinutes: input.durationMinutes,
          locationOrLink: input.locationOrLink,
          interviewerNames: input.interviewerNames,
          interviewerUrls: input.interviewerUrls
        }
      });

      await tx.auditLog.create({
        data: {
          userId,
          action: "interview.create",
          resource: "Interview",
          resourceId: savedInterview.id,
          metadata: {
            aiPrepRequested: input.generatePrep,
            aiPrepStatus: "deferred"
          }
        }
      });

      return savedInterview;
    });

    return NextResponse.json({
      interview,
      prep: null,
      aiGeneration: { status: "deferred", feature: "INTERVIEW_PREP" }
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
