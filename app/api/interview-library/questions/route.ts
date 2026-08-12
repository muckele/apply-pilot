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

const createSchema = z.object({
  question: z.string().trim().min(5).max(1000),
  category: z.enum(interviewQuestionCategories).default("GENERAL"),
  answer: z.string().trim().max(10_000).nullable().optional(),
  improvedAnswer: z.string().trim().max(10_000).nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(80)).max(20).default([]),
  jobPostingId: z.string().optional(),
  interviewId: z.string().optional()
});

export async function GET() {
  try {
    const userId = await requireUserId();
    const questions = await prisma.interviewQuestion.findMany({
      where: { userId },
      orderBy: [{ lastAskedAt: "desc" }, { updatedAt: "desc" }]
    });
    return NextResponse.json({ questions });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const userId = await requireUserId();
    await checkRateLimit(`interview-library:question:create:${userId}`, 40, 60_000);
    const input = createSchema.parse(await request.json());
    await Promise.all([
      input.jobPostingId
        ? prisma.jobPosting.findFirstOrThrow({ where: { id: input.jobPostingId, userId }, select: { id: true } })
        : null,
      input.interviewId
        ? prisma.interview.findFirstOrThrow({ where: { id: input.interviewId, userId }, select: { id: true } })
        : null
    ]);
    const normalizedQuestion = normalizeInterviewQuestion(input.question);
    const existing = await prisma.interviewQuestion.findUnique({
      where: { userId_normalizedQuestion: { userId, normalizedQuestion } }
    });
    if (existing) throw new PublicApiError("This interview question is already in your library.");

    const question = await prisma.$transaction(async (tx) => {
      const created = await tx.interviewQuestion.create({ data: { userId, normalizedQuestion, ...input } });
      await tx.auditLog.create({
        data: {
          userId,
          action: "interview-question.create",
          resource: "InterviewQuestion",
          resourceId: created.id,
          metadata: { category: created.category }
        }
      });
      return created;
    });

    return NextResponse.json({ question }, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
