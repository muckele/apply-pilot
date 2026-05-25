import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { prisma } from "@/lib/prisma";
import { checkRateLimit } from "@/lib/security/rate-limit";
import { deletePrivateLocalFilesForUser } from "@/lib/storage/private-files";
import { apiErrorResponse, requireUserId } from "@/lib/user-context";

const accountDeleteSchema = z.object({
  confirmation: z.literal("DELETE MY DATA")
});

export async function POST(request: NextRequest) {
  try {
    const userId = await requireUserId();
    checkRateLimit(`account:delete:${userId}`, 5, 60_000);

    accountDeleteSchema.parse(await request.json());
    await deletePrivateLocalFilesForUser(userId);

    await prisma.$transaction(async (tx) => {
      await tx.auditLog.deleteMany({ where: { userId } });
      await tx.user.delete({ where: { id: userId } });
    });

    return NextResponse.json({ deleted: true });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
