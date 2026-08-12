import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { PublicApiError } from "@/lib/api-errors";
import { applicationAnswerCategories } from "@/lib/application-answers";
import { normalizeText } from "@/lib/normalize";
import { prisma } from "@/lib/prisma";
import { checkRateLimit } from "@/lib/security/rate-limit";
import { apiErrorResponse, requireUserId } from "@/lib/user-context";

const patchAnswerSchema = z.object({
  category: z.enum(applicationAnswerCategories).optional(),
  question: z.string().trim().min(3).max(300).optional(),
  answer: z.string().trim().min(1).max(4000).optional(),
  sensitive: z.boolean().optional(),
  isActive: z.boolean().optional()
});

type Params = { params: Promise<{ id: string }> };

export async function PATCH(request: NextRequest, { params }: Params) {
  try {
    const userId = await requireUserId();
    await checkRateLimit(`application-answers:update:${userId}`, 60, 60_000);
    const { id } = await params;
    const input = patchAnswerSchema.parse(await request.json());
    const existing = await prisma.applicationAnswer.findFirstOrThrow({ where: { id, userId } });
    const normalizedQuestion = input.question ? normalizeText(input.question) : existing.normalizedQuestion;
    const duplicate = await prisma.applicationAnswer.findFirst({
      where: { userId, normalizedQuestion, id: { not: existing.id } }
    });

    if (duplicate) {
      throw new PublicApiError("An answer for this question already exists.");
    }

    const answer = await prisma.$transaction(async (tx) => {
      const updated = await tx.applicationAnswer.update({
        where: { id: existing.id },
        data: { ...input, normalizedQuestion }
      });
      await tx.auditLog.create({
        data: {
          userId,
          action: "application-answer.update",
          resource: "ApplicationAnswer",
          resourceId: updated.id,
          metadata: { category: updated.category, sensitive: updated.sensitive }
        }
      });
      return updated;
    });

    return NextResponse.json({ answer });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function DELETE(_request: NextRequest, { params }: Params) {
  try {
    const userId = await requireUserId();
    await checkRateLimit(`application-answers:delete:${userId}`, 30, 60_000);
    const { id } = await params;
    const existing = await prisma.applicationAnswer.findFirstOrThrow({ where: { id, userId } });

    await prisma.$transaction([
      prisma.applicationAnswer.delete({ where: { id: existing.id } }),
      prisma.auditLog.create({
        data: {
          userId,
          action: "application-answer.delete",
          resource: "ApplicationAnswer",
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
