import { NextRequest, NextResponse } from "next/server";

import { generateInterviewFeedback } from "@/lib/ai/documents";
import { normalizeInterviewQuestion } from "@/lib/interviews/library";
import { prisma } from "@/lib/prisma";
import { checkRateLimit } from "@/lib/security/rate-limit";
import { apiErrorResponse, requireUserId } from "@/lib/user-context";

type Params = {
  params: Promise<{ id: string }>;
};

export async function POST(_request: NextRequest, { params }: Params) {
  try {
    const userId = await requireUserId();
    await checkRateLimit(`interview-feedback:${userId}`, 12, 60_000);
    const { id } = await params;
    const interview = await prisma.interview.findFirstOrThrow({
      where: { id, userId },
      include: {
        jobPosting: true,
        notesList: true,
        recordings: true
      }
    });
    const feedback = await generateInterviewFeedback({ interview }, userId);

    await prisma.$transaction(async (tx) => {
      await tx.interview.update({
        where: { id: interview.id },
        data: { followUpEmailDraft: feedback.thankYouEmailDraft }
      });

      await tx.aIAnalysis.create({
        data: {
          userId,
          jobPostingId: interview.jobPostingId,
          interviewId: interview.id,
          type: "INTERVIEW_FEEDBACK",
          model: feedback.model,
          promptName: "interviewFeedbackPrompt",
          promptVersion: feedback.promptVersion,
          inputHash: feedback.inputHash,
          input: { interviewId: interview.id },
          output: feedback,
          confidence: 76
        }
      });

      for (const [index, question] of feedback.questionsAsked.entries()) {
        const normalizedQuestion = normalizeInterviewQuestion(question);
        if (normalizedQuestion.length < 5) continue;
        const improvedAnswer = feedback.betterAnswers[index]?.trim() || undefined;
        await tx.interviewQuestion.upsert({
          where: { userId_normalizedQuestion: { userId, normalizedQuestion } },
          update: {
            jobPostingId: interview.jobPostingId,
            interviewId: interview.id,
            improvedAnswer,
            timesAsked: { increment: 1 },
            lastAskedAt: new Date()
          },
          create: {
            userId,
            jobPostingId: interview.jobPostingId,
            interviewId: interview.id,
            question,
            normalizedQuestion,
            category: "ROLE_SPECIFIC",
            improvedAnswer,
            tags: ["INTERVIEW_FEEDBACK"],
            timesAsked: 1,
            lastAskedAt: new Date()
          }
        });
      }

      await tx.auditLog.create({
        data: {
          userId,
          action: "interview.feedback.generate",
          resource: "Interview",
          resourceId: interview.id,
          metadata: { questionsCaptured: feedback.questionsAsked.length }
        }
      });
    });

    return NextResponse.json({ feedback, requiresApprovalBeforeSending: true });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
