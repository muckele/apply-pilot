import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { generateInterviewPrep } from "@/lib/ai/documents";
import { aiInvocationFromRequest } from "@/lib/ai/http";
import { normalizeInterviewQuestion } from "@/lib/interviews/library";
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
  generatePrep: z.boolean().optional().default(true)
});

export async function POST(request: NextRequest) {
  try {
    const userId = await requireUserId();
    await checkRateLimit(`interviews:create:${userId}`, 30, 60_000);
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
    const prep = input.generatePrep
      ? await generateInterviewPrep(
          { job, application, profile, resume },
          userId,
          aiInvocationFromRequest(request)
        )
      : null;
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
          interviewerUrls: input.interviewerUrls,
          prepBrief: prep?.prepBrief,
          likelyQuestions: prep?.likelyQuestions ?? [],
          starStories: prep?.starStories
        }
      });

      if (prep) {
        for (const question of prep.likelyQuestions) {
          const normalizedQuestion = normalizeInterviewQuestion(question);
          if (normalizedQuestion.length < 5) continue;
          await tx.interviewQuestion.upsert({
            where: { userId_normalizedQuestion: { userId, normalizedQuestion } },
            update: {
              jobPostingId: linkedJobPostingId,
              interviewId: savedInterview.id
            },
            create: {
              userId,
              jobPostingId: linkedJobPostingId,
              interviewId: savedInterview.id,
              question,
              normalizedQuestion,
              category: "ROLE_SPECIFIC",
              tags: ["AI_PREP"]
            }
          });
        }

        for (const story of prep.starStories) {
          const existingStory = await tx.starStory.findFirst({
            where: { userId, title: { equals: story.theme, mode: "insensitive" } }
          });
          if (!existingStory) {
            await tx.starStory.create({
              data: {
                userId,
                title: story.theme,
                situation: story.situation,
                task: story.task,
                action: story.action,
                result: story.result,
                skills: [],
                roleContext: job ? `${job.company} - ${job.title}` : null
              }
            });
          }
        }

        await tx.aIAnalysis.create({
          data: {
            userId,
            jobPostingId: linkedJobPostingId,
            interviewId: savedInterview.id,
            type: "INTERVIEW_PREP",
            model: prep.model,
            promptName: "interviewPrepPrompt",
            promptVersion: prep.promptVersion,
            inputHash: prep.inputHash,
            input: { jobPostingId: linkedJobPostingId, applicationId: input.applicationId },
            output: prep,
            confidence: 76
          }
        });
      }

      await tx.auditLog.create({
        data: {
          userId,
          action: "interview.create",
          resource: "Interview",
          resourceId: savedInterview.id,
          metadata: {}
        }
      });

      return savedInterview;
    });

    return NextResponse.json({ interview, prep });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
