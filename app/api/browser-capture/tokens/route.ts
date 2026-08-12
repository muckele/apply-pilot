import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { PublicApiError } from "@/lib/api-errors";
import { prisma } from "@/lib/prisma";
import {
  browserCaptureScopes,
  createBrowserCaptureToken
} from "@/lib/security/browser-capture-token";
import { checkRateLimit } from "@/lib/security/rate-limit";
import { apiErrorResponse, requireUserId } from "@/lib/user-context";

const createTokenSchema = z.object({
  name: z.string().trim().min(2).max(80),
  includeAnswers: z.boolean().default(false),
  expiresInDays: z.coerce.number().int().min(1).max(365).default(90)
});

export async function GET() {
  try {
    const userId = await requireUserId();
    const tokens = await prisma.browserCaptureToken.findMany({
      where: { userId },
      select: {
        id: true,
        name: true,
        tokenPrefix: true,
        scopes: true,
        lastUsedAt: true,
        expiresAt: true,
        revokedAt: true,
        createdAt: true
      },
      orderBy: { createdAt: "desc" }
    });

    return NextResponse.json({ tokens }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const userId = await requireUserId();
    await checkRateLimit(`browser-tokens:create:${userId}`, 10, 60_000);
    const input = createTokenSchema.parse(await request.json());
    const activeTokenCount = await prisma.browserCaptureToken.count({
      where: {
        userId,
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }]
      }
    });

    if (activeTokenCount >= 5) {
      throw new PublicApiError("Revoke an existing browser token before creating another.");
    }

    const generated = createBrowserCaptureToken();
    const expiresAt = new Date(Date.now() + input.expiresInDays * 24 * 60 * 60 * 1000);
    const scopes = input.includeAnswers
      ? [...browserCaptureScopes]
      : [browserCaptureScopes[0]];

    const tokenRecord = await prisma.$transaction(async (tx) => {
      const created = await tx.browserCaptureToken.create({
        data: {
          userId,
          name: input.name,
          tokenHash: generated.tokenHash,
          tokenPrefix: generated.tokenPrefix,
          scopes,
          expiresAt
        },
        select: {
          id: true,
          name: true,
          tokenPrefix: true,
          scopes: true,
          expiresAt: true,
          createdAt: true
        }
      });

      await tx.auditLog.create({
        data: {
          userId,
          action: "browser-capture-token.create",
          resource: "BrowserCaptureToken",
          resourceId: created.id,
          metadata: { scopes, expiresAt: expiresAt.toISOString() }
        }
      });

      return created;
    });

    return NextResponse.json(
      { token: generated.token, tokenRecord },
      { status: 201, headers: { "cache-control": "no-store" } }
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
}
