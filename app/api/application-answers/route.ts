import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { PublicApiError } from "@/lib/api-errors";
import { applicationAnswerCategories } from "@/lib/application-answers";
import { normalizeText } from "@/lib/normalize";
import { prisma } from "@/lib/prisma";
import { checkRateLimit } from "@/lib/security/rate-limit";
import { apiErrorResponse, requireUserId } from "@/lib/user-context";

const createAnswerSchema = z.object({
  category: z.enum(applicationAnswerCategories).default("GENERAL"),
  question: z.string().trim().min(3).max(300),
  answer: z.string().trim().min(1).max(4000),
  sensitive: z.boolean().default(false),
  isActive: z.boolean().default(true)
});

export async function GET() {
  try {
    const userId = await requireUserId();
    const answers = await prisma.applicationAnswer.findMany({
      where: { userId },
      orderBy: [{ category: "asc" }, { question: "asc" }]
    });

    return NextResponse.json({ answers });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const userId = await requireUserId();
    await checkRateLimit(`application-answers:create:${userId}`, 30, 60_000);
    const input = createAnswerSchema.parse(await request.json());
    const normalizedQuestion = normalizeText(input.question);
    const existing = await prisma.applicationAnswer.findUnique({
      where: { userId_normalizedQuestion: { userId, normalizedQuestion } }
    });

    if (existing) {
      throw new PublicApiError("An answer for this question already exists.");
    }

    const answer = await prisma.$transaction(async (tx) => {
      const created = await tx.applicationAnswer.create({
        data: { userId, normalizedQuestion, ...input }
      });
      await tx.auditLog.create({
        data: {
          userId,
          action: "application-answer.create",
          resource: "ApplicationAnswer",
          resourceId: created.id,
          metadata: { category: created.category, sensitive: created.sensitive }
        }
      });
      return created;
    });

    return NextResponse.json({ answer }, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
