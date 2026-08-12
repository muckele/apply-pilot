import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { prisma } from "@/lib/prisma";
import { checkRateLimit } from "@/lib/security/rate-limit";
import { apiErrorResponse, requireUserId } from "@/lib/user-context";

const generatedDocumentPatchSchema = z.object({
  title: z.string().trim().min(2).max(160).optional(),
  content: z.string().trim().min(1).max(30000).optional()
});

type Params = {
  params: Promise<{ id: string }>;
};

export async function PATCH(request: NextRequest, { params }: Params) {
  try {
    const userId = await requireUserId();
    await checkRateLimit(`generated-documents:update:${userId}`, 60, 60_000);
    const { id } = await params;
    const input = generatedDocumentPatchSchema.parse(await request.json());
    const existing = await prisma.generatedDocument.findFirstOrThrow({ where: { id, userId } });
    const document = await prisma.$transaction(async (tx) => {
      const updated = await tx.generatedDocument.update({
        where: { id: existing.id },
        data: input
      });

      await tx.auditLog.create({
        data: {
          userId,
          action: "generated-document.update",
          resource: "GeneratedDocument",
          resourceId: updated.id,
          metadata: {}
        }
      });

      return updated;
    });

    return NextResponse.json({ document });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
