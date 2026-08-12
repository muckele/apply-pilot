import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { prisma } from "@/lib/prisma";
import { checkRateLimit } from "@/lib/security/rate-limit";
import { apiErrorResponse, requireUserId } from "@/lib/user-context";

const updateTaskSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  status: z.enum(["OPEN", "DONE", "ARCHIVED"]).optional(),
  priority: z.enum(["LOW", "MEDIUM", "HIGH"]).optional(),
  dueAt: z.union([z.coerce.date(), z.null()]).optional()
});

type Params = {
  params: Promise<{ id: string }>;
};

export async function PATCH(request: NextRequest, { params }: Params) {
  try {
    const userId = await requireUserId();
    await checkRateLimit(`tasks:update:${userId}`, 80, 60_000);
    const { id } = await params;
    const input = updateTaskSchema.parse(await request.json());
    const existing = await prisma.task.findFirstOrThrow({ where: { id, userId } });

    const task = await prisma.$transaction(async (tx) => {
      const updated = await tx.task.update({
        where: { id: existing.id },
        data: input
      });

      await tx.auditLog.create({
        data: {
          userId,
          action: "task.update",
          resource: "Task",
          resourceId: updated.id,
          metadata: { status: updated.status }
        }
      });

      return updated;
    });

    return NextResponse.json({ task });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
