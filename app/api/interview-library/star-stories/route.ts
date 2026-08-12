import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { prisma } from "@/lib/prisma";
import { checkRateLimit } from "@/lib/security/rate-limit";
import { apiErrorResponse, requireUserId } from "@/lib/user-context";

const createSchema = z.object({
  title: z.string().trim().min(3).max(200),
  situation: z.string().trim().min(1).max(5000),
  task: z.string().trim().min(1).max(5000),
  action: z.string().trim().min(1).max(5000),
  result: z.string().trim().min(1).max(5000),
  skills: z.array(z.string().trim().min(1).max(80)).max(30).default([]),
  roleContext: z.string().trim().max(1000).nullable().optional(),
  isFavorite: z.boolean().default(false)
});

export async function GET() {
  try {
    const userId = await requireUserId();
    const stories = await prisma.starStory.findMany({
      where: { userId },
      orderBy: [{ isFavorite: "desc" }, { updatedAt: "desc" }]
    });
    return NextResponse.json({ stories });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const userId = await requireUserId();
    await checkRateLimit(`interview-library:story:create:${userId}`, 30, 60_000);
    const input = createSchema.parse(await request.json());
    const story = await prisma.$transaction(async (tx) => {
      const created = await tx.starStory.create({ data: { userId, ...input } });
      await tx.auditLog.create({
        data: {
          userId,
          action: "star-story.create",
          resource: "StarStory",
          resourceId: created.id,
          metadata: { isFavorite: created.isFavorite }
        }
      });
      return created;
    });
    return NextResponse.json({ story }, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
