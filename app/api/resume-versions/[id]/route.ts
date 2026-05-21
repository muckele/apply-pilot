import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { prisma } from "@/lib/prisma";
import { writeAuditLog } from "@/lib/security/audit-log";
import { apiErrorResponse, requireUserId } from "@/lib/user-context";

const resumeVersionPatchSchema = z.object({
  title: z.string().trim().min(2).max(160).optional(),
  summary: z.string().trim().max(2000).nullable().optional(),
  fullText: z.string().trim().min(1).max(30000).optional()
});

type Params = {
  params: Promise<{ id: string }>;
};

export async function PATCH(request: NextRequest, { params }: Params) {
  try {
    const userId = await requireUserId();
    const { id } = await params;
    const input = resumeVersionPatchSchema.parse(await request.json());
    const existing = await prisma.resumeVersion.findFirstOrThrow({ where: { id, userId } });
    const version = await prisma.resumeVersion.update({
      where: { id: existing.id },
      data: input
    });

    await writeAuditLog({
      userId,
      action: "resume-version.update",
      resource: "ResumeVersion",
      resourceId: version.id
    });

    return NextResponse.json({ version });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
