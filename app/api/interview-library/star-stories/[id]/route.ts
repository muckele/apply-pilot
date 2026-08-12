import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { prisma } from "@/lib/prisma";
import { checkRateLimit } from "@/lib/security/rate-limit";
import { apiErrorResponse, requireUserId } from "@/lib/user-context";

const patchSchema = z.object({
  title: z.string().trim().min(3).max(200).optional(),
  situation: z.string().trim().min(1).max(5000).optional(),
  task: z.string().trim().min(1).max(5000).optional(),
  action: z.string().trim().min(1).max(5000).optional(),
  result: z.string().trim().min(1).max(5000).optional(),
  skills: z.array(z.string().trim().min(1).max(80)).max(30).optional(),
  roleContext: z.string().trim().max(1000).nullable().optional(),
  isFavorite: z.boolean().optional()
});

type Params = { params: Promise<{ id: string }> };

export async function PATCH(request: NextRequest, { params }: Params) {
  try {
    const userId = await requireUserId();
    await checkRateLimit(`interview-library:story:update:${userId}`, 60, 60_000);
    const { id } = await params;
    const input = patchSchema.parse(await request.json());
    const existing = await prisma.starStory.findFirstOrThrow({ where: { id, userId } });
    const story = await prisma.$transaction(async (tx) => {
      const updated = await tx.starStory.update({ where: { id: existing.id }, data: input });
      await tx.auditLog.create({
        data: {
          userId,
          action: "star-story.update",
          resource: "StarStory",
          resourceId: updated.id,
          metadata: {}
        }
      });
      return updated;
    });
    return NextResponse.json({ story });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function DELETE(_request: NextRequest, { params }: Params) {
  try {
    const userId = await requireUserId();
    await checkRateLimit(`interview-library:story:delete:${userId}`, 30, 60_000);
    const { id } = await params;
    const existing = await prisma.starStory.findFirstOrThrow({ where: { id, userId } });
    await prisma.$transaction([
      prisma.starStory.delete({ where: { id: existing.id } }),
      prisma.auditLog.create({
        data: {
          userId,
          action: "star-story.delete",
          resource: "StarStory",
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
