import type { Prisma } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { aiInvocationFromRequest } from "@/lib/ai/http";
import { generateInterviewFeedback, INTERVIEW_FEEDBACK_PROMPT_NAME } from "@/lib/ai/interview-feedback";
import { PublicApiError } from "@/lib/api-errors";
import { normalizeInterviewQuestion } from "@/lib/interviews/library";
import { prisma } from "@/lib/prisma";
import { checkRateLimit } from "@/lib/security/rate-limit";
import { apiErrorResponse, requireUserId } from "@/lib/user-context";

type Params = {
  params: Promise<{ id: string }>;
};

// Transcription stays manual: the user pastes a transcript and confirms participant
// consent. The transcript is used for this request only and is not stored.
const feedbackRequestSchema = z.object({
  transcript: z.string().max(60_000).optional(),
  transcriptConsentConfirmed: z.boolean().optional().default(false)
});

export async function POST(request: NextRequest, { params }: Params) {
  try {
    const userId = await requireUserId();
    await checkRateLimit(`interview-feedback:${userId}`, 12, 60_000);
    const { id } = await params;
    const input = feedbackRequestSchema.parse(await request.json().catch(() => ({})));
    const interview = await prisma.interview.findFirst({
      where: { id, userId },
      include: {
        jobPosting: true,
        application: { include: { jobPosting: true } },
        notesList: { orderBy: { createdAt: "asc" } }
      }
    });
    if (!interview) throw new PublicApiError("Interview not found.", 404);
    const resume = await prisma.resume.findFirst({
      where: { userId, isMaster: true },
      orderBy: { updatedAt: "desc" }
    });
    const job = interview.jobPosting ?? interview.application?.jobPosting ?? null;
    const notes = [...new Set([interview.notes, ...interview.notesList.map((note) => note.body)]
      .map((note) => note?.trim())
      .filter((note): note is string => Boolean(note)))];

    const feedback = await generateInterviewFeedback(
      {
        interview: { type: interview.type },
        job,
        resume,
        notes,
        transcript: input.transcript?.trim() || null,
        transcriptConsentConfirmed: input.transcriptConsentConfirmed
      },
      userId,
      aiInvocationFromRequest(request)
    );

    await prisma.$transaction(async (tx) => {
      await tx.interview.update({
        where: { id: interview.id },
        data: { followUpEmailDraft: feedback.thankYouEmailDraft }
      });

      await tx.aIAnalysis.create({
        data: {
          userId,
          jobPostingId: job?.id ?? null,
          interviewId: interview.id,
          type: "INTERVIEW_FEEDBACK",
          model: feedback.model,
          promptName: INTERVIEW_FEEDBACK_PROMPT_NAME,
          promptVersion: feedback.promptVersion,
          inputHash: feedback.inputHash,
          input: {
            interviewId: interview.id,
            noteCount: notes.length,
            transcriptProvided: Boolean(input.transcript?.trim()),
            transcriptTruncated: feedback.transcriptTruncated
          },
          output: {
            summary: feedback.summary,
            questionsAsked: feedback.questionsAsked,
            strongMoments: feedback.strongMoments,
            weakAnswers: feedback.weakAnswers,
            betterAnswers: feedback.betterAnswers,
            thankYouEmailDraft: feedback.thankYouEmailDraft
          } as unknown as Prisma.InputJsonValue,
          confidence: null
        }
      });

      for (const question of feedback.questionsAsked) {
        const normalizedQuestion = normalizeInterviewQuestion(question);
        if (normalizedQuestion.length < 5) continue;
        const improvedAnswer = feedback.betterAnswers
          .find((answer) => normalizeInterviewQuestion(answer.question) === normalizedQuestion)
          ?.suggestion.trim() || undefined;
        await tx.interviewQuestion.upsert({
          where: { userId_normalizedQuestion: { userId, normalizedQuestion } },
          update: {
            jobPostingId: job?.id ?? null,
            interviewId: interview.id,
            improvedAnswer,
            timesAsked: { increment: 1 },
            lastAskedAt: new Date()
          },
          create: {
            userId,
            jobPostingId: job?.id ?? null,
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
          metadata: {
            provider: feedback.provider,
            model: feedback.model,
            questionsCaptured: feedback.questionsAsked.length,
            transcriptProvided: Boolean(input.transcript?.trim())
          }
        }
      });
    });

    return NextResponse.json({ feedback, requiresApprovalBeforeSending: true });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
