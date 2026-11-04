import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { aiInvocationFromRequest } from "@/lib/ai/http";
import { generateMockAnswerFeedback } from "@/lib/ai/mock-interview";
import { mockSessionJob, writeMockAnswer } from "@/lib/ai/mock-interview-records";
import { MOCK_ANSWER_MAX_CHARS, parseMockQuestions } from "@/lib/ai/mock-interview-session";
import type { JobContextInput } from "@/lib/ai/grounded-text";
import { PublicApiError } from "@/lib/api-errors";
import { prisma } from "@/lib/prisma";
import { checkRateLimit } from "@/lib/security/rate-limit";
import { apiErrorResponse, requireUserId } from "@/lib/user-context";

type Params = {
  params: Promise<{ sessionId: string }>;
};

const answerSchema = z.object({
  questionId: z.string().trim().min(1).max(16),
  answer: z.string().max(MOCK_ANSWER_MAX_CHARS)
}).strict();

// Gets Gemini feedback on one practice answer and saves the answer with its feedback on
// the owner's session. The answer is private practice text: it is sent to Gemini only
// after the user confirms, stored only on the session, and never logged or audited.
export async function POST(request: NextRequest, { params }: Params) {
  try {
    const userId = await requireUserId();
    await checkRateLimit(`mock-interview:answer:${userId}`, 20, 60_000);
    const { sessionId } = await params;
    const input = answerSchema.parse(await request.json().catch(() => ({})));
    const session = await prisma.mockInterviewSession.findFirst({
      where: { id: sessionId, userId },
      include: {
        jobPosting: true,
        application: { include: { jobPosting: true } },
        interview: { include: { jobPosting: true, application: { include: { jobPosting: true } } } }
      }
    });
    if (!session) throw new PublicApiError("Practice session not found.", 404);
    const question = parseMockQuestions(session.questions).find((entry) => entry.questionId === input.questionId);
    if (!question) throw new PublicApiError("That question is not part of this practice session.", 404);
    const resume = await prisma.resume.findFirst({
      where: { userId, isMaster: true },
      orderBy: { updatedAt: "desc" }
    });

    const generated = await generateMockAnswerFeedback(
      { question, job: mockSessionJob<JobContextInput>(session), resume, answer: input.answer },
      userId,
      aiInvocationFromRequest(request)
    );

    const saved = await writeMockAnswer(userId, session.id, question.questionId, (current) => ({
      answer: generated.answerText,
      answeredAt: new Date().toISOString(),
      attempts: (current?.attempts ?? 0) + 1,
      savedStoryId: current?.savedStoryId ?? null,
      savedStoryAttempt: current?.savedStoryAttempt ?? null,
      requestHash: generated.inputHash,
      feedback: generated.feedback
    }));

    await prisma.auditLog.create({
      data: {
        userId,
        action: "interview.mock.answer",
        resource: "MockInterviewSession",
        resourceId: session.id,
        metadata: {
          questionId: question.questionId,
          attempts: saved.record.attempts,
          model: generated.model,
          scores: Object.fromEntries(Object.entries(generated.feedback.scores).map(([dimension, value]) => [dimension, value.score]))
        }
      }
    });

    return NextResponse.json({ questionId: question.questionId, answer: saved.record, revision: saved.revision });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
