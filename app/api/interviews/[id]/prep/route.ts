import type { Prisma } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";

import { aiInvocationFromRequest } from "@/lib/ai/http";
import { generateInterviewPrep, INTERVIEW_PREP_PROMPT_NAME } from "@/lib/ai/interview-prep";
import { PublicApiError } from "@/lib/api-errors";
import { normalizeInterviewQuestion } from "@/lib/interviews/library";
import { prisma } from "@/lib/prisma";
import { checkRateLimit } from "@/lib/security/rate-limit";
import { apiErrorResponse, requireUserId } from "@/lib/user-context";

type Params = {
  params: Promise<{ id: string }>;
};

// Generates interview prep on Gemini from the signed-in user's master resume and the
// interview's linked job. Every read is owner-scoped; nothing is sent to an employer.
export async function POST(request: NextRequest, { params }: Params) {
  try {
    const userId = await requireUserId();
    await checkRateLimit(`interview-prep:${userId}`, 12, 60_000);
    const { id } = await params;
    const interview = await prisma.interview.findFirst({
      where: { id, userId },
      include: { jobPosting: true, application: { include: { jobPosting: true } } }
    });
    if (!interview) throw new PublicApiError("Interview not found.", 404);
    const [resume, profile] = await Promise.all([
      prisma.resume.findFirst({ where: { userId, isMaster: true }, orderBy: { updatedAt: "desc" } }),
      prisma.userProfile.findUnique({ where: { userId } })
    ]);
    const job = interview.jobPosting ?? interview.application?.jobPosting ?? null;

    const prep = await generateInterviewPrep(
      { interview: { type: interview.type }, job, resume, profile },
      userId,
      aiInvocationFromRequest(request)
    );

    const updated = await prisma.$transaction(async (tx) => {
      const saved = await tx.interview.update({
        where: { id: interview.id },
        data: {
          prepBrief: prep.prepBrief,
          likelyQuestions: prep.likelyQuestions,
          starStories: prep.starStories as unknown as Prisma.InputJsonValue
        }
      });

      for (const question of prep.likelyQuestions) {
        const normalizedQuestion = normalizeInterviewQuestion(question);
        if (normalizedQuestion.length < 5) continue;
        await tx.interviewQuestion.upsert({
          where: { userId_normalizedQuestion: { userId, normalizedQuestion } },
          update: { jobPostingId: job?.id ?? null, interviewId: interview.id },
          create: {
            userId,
            jobPostingId: job?.id ?? null,
            interviewId: interview.id,
            question,
            normalizedQuestion,
            category: "ROLE_SPECIFIC",
            tags: ["AI_PREP"]
          }
        });
      }

      for (const story of prep.starStories) {
        const existing = await tx.starStory.findFirst({
          where: { userId, title: { equals: story.theme, mode: "insensitive" } }
        });
        if (existing) continue;
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

      await tx.aIAnalysis.create({
        data: {
          userId,
          jobPostingId: job?.id ?? null,
          interviewId: interview.id,
          type: "INTERVIEW_PREP",
          model: prep.model,
          promptName: INTERVIEW_PREP_PROMPT_NAME,
          promptVersion: prep.promptVersion,
          inputHash: prep.inputHash,
          input: { interviewId: interview.id, jobPostingId: job?.id ?? null, masterResumeId: resume?.id ?? null },
          output: {
            prepBrief: prep.prepBrief,
            likelyQuestions: prep.likelyQuestions,
            starStories: prep.starStories,
            questionsToAsk: prep.questionsToAsk,
            risksToPrepareFor: prep.risksToPrepareFor,
            droppedStoryCount: prep.droppedStoryCount
          } as unknown as Prisma.InputJsonValue,
          confidence: null
        }
      });

      await tx.auditLog.create({
        data: {
          userId,
          action: "interview.prep.generate",
          resource: "Interview",
          resourceId: interview.id,
          metadata: {
            provider: prep.provider,
            model: prep.model,
            starStories: prep.starStories.length,
            droppedStoryCount: prep.droppedStoryCount
          }
        }
      });

      return saved;
    });

    return NextResponse.json({ interview: updated, prep });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
