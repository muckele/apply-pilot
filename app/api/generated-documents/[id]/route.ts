import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { prisma } from "@/lib/prisma";
import { writeAuditLog } from "@/lib/security/audit-log";
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
    const { id } = await params;
    const input = generatedDocumentPatchSchema.parse(await request.json());
    const existing = await prisma.generatedDocument.findFirstOrThrow({ where: { id, userId } });
    const document = await prisma.generatedDocument.update({
      where: { id: existing.id },
      data: input
    });

    await writeAuditLog({
      userId,
      action: "generated-document.update",
      resource: "GeneratedDocument",
      resourceId: document.id
    });

    return NextResponse.json({ document });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
