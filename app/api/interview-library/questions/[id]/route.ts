import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import {
  interviewQuestionCategories,
  normalizeInterviewQuestion
} from "@/lib/interviews/library";
import { PublicApiError } from "@/lib/api-errors";
import { prisma } from "@/lib/prisma";
import { checkRateLimit } from "@/lib/security/rate-limit";
import { apiErrorResponse, requireUserId } from "@/lib/user-context";

const patchSchema = z.object({
  question: z.string().trim().min(5).max(1000).optional(),
  category: z.enum(interviewQuestionCategories).optional(),
  answer: z.string().trim().max(10_000).nullable().optional(),
  improvedAnswer: z.string().trim().max(10_000).nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(80)).max(20).optional(),
  timesAsked: z.coerce.number().int().min(0).max(1000).optional(),
  lastAskedAt: z.coerce.date().nullable().optional()
});

type Params = { params: Promise<{ id: string }> };

export async function PATCH(request: NextRequest, { params }: Params) {
  try {
    const userId = await requireUserId();
    await checkRateLimit(`interview-library:question:update:${userId}`, 60, 60_000);
    const { id } = await params;
    const input = patchSchema.parse(await request.json());
    const existing = await prisma.interviewQuestion.findFirstOrThrow({ where: { id, userId } });
    const normalizedQuestion = input.question
      ? normalizeInterviewQuestion(input.question)
      : existing.normalizedQuestion;
    const duplicate = await prisma.interviewQuestion.findFirst({
      where: { userId, normalizedQuestion, id: { not: existing.id } }
    });
    if (duplicate) throw new PublicApiError("This interview question is already in your library.");

    const question = await prisma.$transaction(async (tx) => {
      const updated = await tx.interviewQuestion.update({
        where: { id: existing.id },
        data: { ...input, normalizedQuestion }
      });
      await tx.auditLog.create({
        data: {
          userId,
          action: "interview-question.update",
          resource: "InterviewQuestion",
          resourceId: updated.id,
          metadata: {}
        }
      });
      return updated;
    });
    return NextResponse.json({ question });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function DELETE(_request: NextRequest, { params }: Params) {
  try {
    const userId = await requireUserId();
    await checkRateLimit(`interview-library:question:delete:${userId}`, 30, 60_000);
    const { id } = await params;
    const existing = await prisma.interviewQuestion.findFirstOrThrow({ where: { id, userId } });
    await prisma.$transaction([
      prisma.interviewQuestion.delete({ where: { id: existing.id } }),
      prisma.auditLog.create({
        data: {
          userId,
          action: "interview-question.delete",
          resource: "InterviewQuestion",
          resourceId: existing.id,
          metadata: {}
        }
      })
    ]);
    return NextResponse.json({ deleted: true });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
