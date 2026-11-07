import type { Prisma } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import {
  isMockStorySaved,
  parseMockAnswers,
  parseMockQuestions,
  starStoryFromMockAnswer
} from "@/lib/ai/mock-interview-session";
import { PublicApiError } from "@/lib/api-errors";
import { prisma } from "@/lib/prisma";
import { checkRateLimit } from "@/lib/security/rate-limit";
import { apiErrorResponse, requireUserId } from "@/lib/user-context";

type Params = {
  params: Promise<{ sessionId: string }>;
};

const saveSchema = z.object({ questionId: z.string().trim().min(1).max(16) }).strict();

// Saves a strong practice answer to the user's STAR library in one click. The story is
// the user's own answer split into STAR parts; no AI call is made here.
export async function POST(request: NextRequest, { params }: Params) {
  try {
    const userId = await requireUserId();
    await checkRateLimit(`mock-interview:story:${userId}`, 30, 60_000);
    const { sessionId } = await params;
    const input = saveSchema.parse(await request.json().catch(() => ({})));
    const session = await prisma.mockInterviewSession.findFirst({ where: { id: sessionId, userId } });
    if (!session) throw new PublicApiError("Practice session not found.", 404);
    const question = parseMockQuestions(session.questions).find((entry) => entry.questionId === input.questionId);
    if (!question) throw new PublicApiError("That question is not part of this practice session.", 404);
    const answers = parseMockAnswers(session.answers);
    const record = answers[question.questionId];
    if (!record) throw new PublicApiError("Answer this question before saving it as a STAR story.", 404);

    if (isMockStorySaved(record)) {
      const existing = await prisma.starStory.findFirst({ where: { id: record.savedStoryId!, userId } });
      if (existing) return NextResponse.json({ story: existing, alreadySaved: true });
    }

    const draft = starStoryFromMockAnswer(question, record);
    if (!draft) {
      throw new PublicApiError(
        "Only strong answers can be saved as STAR stories. Cover all four STAR parts and work on the tips first.",
        422,
        { code: "MOCK_INTERVIEW_ANSWER_NOT_STRONG" }
      );
    }

    const story = await prisma.$transaction(async (tx) => {
      const created = await tx.starStory.create({
        data: { userId, ...draft, skills: [], roleContext: session.title }
      });
      const linked = await tx.mockInterviewSession.updateMany({
        where: { id: session.id, userId, revision: session.revision },
        data: {
          answers: {
            ...answers,
            [question.questionId]: { ...record, savedStoryId: created.id, savedStoryAttempt: record.attempts }
          } as unknown as Prisma.InputJsonValue,
          revision: { increment: 1 }
        }
      });
      if (linked.count !== 1) {
        throw new PublicApiError("This practice session changed while saving. Refresh and try again.", 409, {
          code: "MOCK_INTERVIEW_SESSION_CONFLICT",
          retryable: true
        });
      }
      await tx.auditLog.create({
        data: {
          userId,
          action: "star-story.create",
          resource: "StarStory",
          resourceId: created.id,
          metadata: { source: "mock_interview", sessionId: session.id, questionId: question.questionId }
        }
      });
      return created;
    });

    return NextResponse.json({ story, alreadySaved: false }, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
