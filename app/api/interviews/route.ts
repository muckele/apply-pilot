import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { generateInterviewPrep } from "@/lib/ai/documents";
import { resolveInterviewJobPostingId } from "@/lib/interviews/linking";
import { prisma } from "@/lib/prisma";
import { writeAuditLog } from "@/lib/security/audit-log";
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
  generatePrep: z.boolean().optional().default(true)
});

export async function POST(request: NextRequest) {
  try {
    const userId = await requireUserId();
    const input = createInterviewSchema.parse(await request.json());
    const [requestedJob, application, profile, resume] = await Promise.all([
      input.jobPostingId
        ? prisma.jobPosting.findFirstOrThrow({ where: { id: input.jobPostingId, userId } })
        : null,
      input.applicationId
        ? prisma.application.findFirstOrThrow({ where: { id: input.applicationId, userId } })
        : null,
      prisma.userProfile.findUnique({ where: { userId } }),
      prisma.resume.findFirst({ where: { userId, isMaster: true }, orderBy: { updatedAt: "desc" } })
    ]);

    const linkedJobPostingId = resolveInterviewJobPostingId({
      requestedJobPostingId: requestedJob?.id,
      applicationJobPostingId: application?.jobPostingId
    });
    const job =
      requestedJob ??
      (linkedJobPostingId
        ? await prisma.jobPosting.findFirstOrThrow({ where: { id: linkedJobPostingId, userId } })
        : null);
    const prep = input.generatePrep ? await generateInterviewPrep({ job, application, profile, resume }) : null;
    const interview = await prisma.interview.create({
      data: {
        userId,
        jobPostingId: linkedJobPostingId,
        applicationId: input.applicationId,
        type: input.type,
        scheduledAt: input.scheduledAt,
        durationMinutes: input.durationMinutes,
        locationOrLink: input.locationOrLink,
        interviewerNames: input.interviewerNames,
        interviewerUrls: input.interviewerUrls,
        prepBrief: prep?.prepBrief,
        likelyQuestions: prep?.likelyQuestions ?? [],
        starStories: prep?.starStories
      }
    });

    if (prep) {
      await prisma.aIAnalysis.create({
        data: {
          userId,
          jobPostingId: linkedJobPostingId,
          interviewId: interview.id,
          type: "INTERVIEW_PREP",
          model: prep.model,
          promptName: "interviewPrepPrompt",
          input: { jobPostingId: linkedJobPostingId, applicationId: input.applicationId },
          output: prep,
          confidence: 76
        }
      });
    }

    await writeAuditLog({
      userId,
      action: "interview.create",
      resource: "Interview",
      resourceId: interview.id
    });

    return NextResponse.json({ interview, prep });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
