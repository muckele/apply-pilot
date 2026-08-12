import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { prisma } from "@/lib/prisma";
import { checkRateLimit } from "@/lib/security/rate-limit";
import { apiErrorResponse, requireUserId } from "@/lib/user-context";

const disconnectSchema = z.object({
  deleteSyncedData: z.boolean().optional().default(false)
});

export async function POST(request: NextRequest) {
  try {
    const userId = await requireUserId();
    await checkRateLimit(`gmail:disconnect:${userId}`, 10, 60_000);
    const input = disconnectSchema.parse(await request.json().catch(() => ({})));

    await prisma.$transaction(async (tx) => {
      await tx.gmailIntegration.updateMany({
        where: { userId },
        data: {
          encryptedAccessToken: null,
          encryptedRefreshToken: null,
          disconnectedAt: new Date()
        }
      });

      if (input.deleteSyncedData) {
        await tx.emailMessage.deleteMany({
          where: { userId, gmailMessageId: { not: null } }
        });
      }

      await tx.auditLog.create({
        data: {
          userId,
          action: "gmail.disconnect",
          resource: "GmailIntegration",
          metadata: { deleteSyncedData: input.deleteSyncedData }
        }
      });
    });

    return NextResponse.json({ disconnected: true, deletedSyncedData: input.deleteSyncedData });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
