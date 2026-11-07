import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import {
  MOCK_INTERVIEW_FEEDBACK_PROMPT_NAME,
  MOCK_INTERVIEW_QUESTIONS_PROMPT_NAME
} from "@/lib/ai/mock-interview";
import { serializeMockSession } from "@/lib/ai/mock-interview-records";
import { mockSessionRequestHashes } from "@/lib/ai/mock-interview-session";
import { PublicApiError } from "@/lib/api-errors";
import { prisma } from "@/lib/prisma";
import { checkRateLimit } from "@/lib/security/rate-limit";
import { apiErrorResponse, requireUserId } from "@/lib/user-context";

type Params = {
  params: Promise<{ sessionId: string }>;
};

const finishSchema = z.object({ completed: z.boolean() }).strict();

export async function GET(_request: NextRequest, { params }: Params) {
  try {
    const userId = await requireUserId();
    const { sessionId } = await params;
    const session = await prisma.mockInterviewSession.findFirst({ where: { id: sessionId, userId } });
    if (!session) throw new PublicApiError("Practice session not found.", 404);
    return NextResponse.json({ session: serializeMockSession(session) });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

// Marks the session finished (or reopens it). The summary itself is derived from the
// saved feedback on every read, so finishing never calls AI.
export async function PATCH(request: NextRequest, { params }: Params) {
  try {
    const userId = await requireUserId();
    await checkRateLimit(`mock-interview:update:${userId}`, 30, 60_000);
    const { sessionId } = await params;
    const input = finishSchema.parse(await request.json().catch(() => ({})));
    const completedAt = input.completed ? new Date() : null;
    const result = await prisma.mockInterviewSession.updateMany({
      where: { id: sessionId, userId },
      data: { completedAt }
    });
    if (result.count !== 1) throw new PublicApiError("Practice session not found.", 404);
    return NextResponse.json({ completedAt });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

// Deletes the session and the cached AI outputs derived from it, so the user's practice
// answers do not outlive the session in the response cache.
export async function DELETE(_request: NextRequest, { params }: Params) {
  try {
    const userId = await requireUserId();
    await checkRateLimit(`mock-interview:delete:${userId}`, 30, 60_000);
    const { sessionId } = await params;
    const session = await prisma.mockInterviewSession.findFirst({
      where: { id: sessionId, userId },
      select: { id: true, requestHash: true, answers: true }
    });
    if (!session) throw new PublicApiError("Practice session not found.", 404);
    const requestHashes = mockSessionRequestHashes(session);

    await prisma.$transaction(async (tx) => {
      const deleted = await tx.mockInterviewSession.deleteMany({ where: { id: session.id, userId } });
      if (deleted.count !== 1) throw new PublicApiError("Practice session not found.", 404);
      if (requestHashes.length) {
        await tx.aIResponseCache.deleteMany({
          where: {
            userId,
            promptName: { in: [MOCK_INTERVIEW_QUESTIONS_PROMPT_NAME, MOCK_INTERVIEW_FEEDBACK_PROMPT_NAME] },
            requestHash: { in: requestHashes }
          }
        });
      }
      await tx.auditLog.create({
        data: {
          userId,
          action: "interview.mock.delete",
          resource: "MockInterviewSession",
          resourceId: session.id,
          metadata: { cachedOutputsRemoved: requestHashes.length }
        }
      });
    });

    return NextResponse.json({ deleted: true });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
