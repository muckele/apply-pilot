import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { resumeFontFamilies, resumePageSizes, resumeTemplates } from "@/lib/documents/resume-format";
import { prisma } from "@/lib/prisma";
import { checkRateLimit } from "@/lib/security/rate-limit";
import { apiErrorResponse, requireUserId } from "@/lib/user-context";

const resumeVersionPatchSchema = z.object({
  title: z.string().trim().min(2).max(160).optional(),
  summary: z.string().trim().max(2000).nullable().optional(),
  fullText: z.string().trim().min(1).max(30000).optional(),
  skills: z.array(z.string().trim().min(1).max(100)).max(100).optional(),
  template: z.enum(resumeTemplates).optional(),
  pageSize: z.enum(resumePageSizes).optional(),
  fontFamily: z.enum(resumeFontFamilies).optional(),
  accentColor: z.string().regex(/^#[0-9A-F]{6}$/i).optional(),
  fontSize: z.number().int().min(9).max(12).optional(),
  lineSpacing: z.number().int().min(100).max(150).optional()
});

type Params = {
  params: Promise<{ id: string }>;
};

export async function PATCH(request: NextRequest, { params }: Params) {
  try {
    const userId = await requireUserId();
    await checkRateLimit(`resume-versions:update:${userId}`, 60, 60_000);
    const { id } = await params;
    const input = resumeVersionPatchSchema.parse(await request.json());
    const existing = await prisma.resumeVersion.findFirstOrThrow({ where: { id, userId } });
    const version = await prisma.$transaction(async (tx) => {
      const updated = await tx.resumeVersion.update({
        where: { id: existing.id },
        data: input
      });

      await tx.auditLog.create({
        data: {
          userId,
          action: "resume-version.update",
          resource: "ResumeVersion",
          resourceId: updated.id,
          metadata: {}
        }
      });

      return updated;
    });

    return NextResponse.json({ version });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
