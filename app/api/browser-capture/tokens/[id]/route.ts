import { NextRequest, NextResponse } from "next/server";

import { prisma } from "@/lib/prisma";
import { checkRateLimit } from "@/lib/security/rate-limit";
import { apiErrorResponse, requireUserId } from "@/lib/user-context";

type Params = { params: Promise<{ id: string }> };

export async function DELETE(_request: NextRequest, { params }: Params) {
  try {
    const userId = await requireUserId();
    await checkRateLimit(`browser-tokens:revoke:${userId}`, 20, 60_000);
    const { id } = await params;
    const token = await prisma.browserCaptureToken.findFirstOrThrow({ where: { id, userId } });

    await prisma.$transaction([
      prisma.browserCaptureToken.update({
        where: { id: token.id },
        data: { revokedAt: new Date() }
      }),
      prisma.auditLog.create({
        data: {
          userId,
          action: "browser-capture-token.revoke",
          resource: "BrowserCaptureToken",
          resourceId: token.id,
          metadata: {}
        }
      })
    ]);

    return NextResponse.json({ revoked: true });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
