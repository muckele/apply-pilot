import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { prisma } from "@/lib/prisma";
import { writeAuditLog } from "@/lib/security/audit-log";
import { apiErrorResponse, requireUserId } from "@/lib/user-context";

const disconnectSchema = z.object({
  deleteSyncedData: z.boolean().optional().default(false)
});

export async function POST(request: NextRequest) {
  try {
    const userId = await requireUserId();
    const input = disconnectSchema.parse(await request.json().catch(() => ({})));

    await prisma.gmailIntegration.updateMany({
      where: { userId },
      data: {
        encryptedAccessToken: null,
        encryptedRefreshToken: null,
        disconnectedAt: new Date()
      }
    });

    if (input.deleteSyncedData) {
      await prisma.emailMessage.deleteMany({
        where: { userId, gmailMessageId: { not: null } }
      });
    }

    await writeAuditLog({
      userId,
      action: "gmail.disconnect",
      resource: "GmailIntegration",
      metadata: { deleteSyncedData: input.deleteSyncedData }
    });

    return NextResponse.json({ disconnected: true, deletedSyncedData: input.deleteSyncedData });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
