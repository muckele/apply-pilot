import { google } from "googleapis";
import { NextRequest, NextResponse } from "next/server";

import { prisma } from "@/lib/prisma";
import { writeAuditLog } from "@/lib/security/audit-log";
import { encryptToken } from "@/lib/security/crypto";
import { verifyOAuthState } from "@/lib/security/oauth-state";
import { apiErrorResponse } from "@/lib/user-context";

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const code = searchParams.get("code");
    const state = searchParams.get("state");

    if (!code || !state) {
      throw new Error("Missing Gmail OAuth code or state.");
    }

    const userId = verifyOAuthState(state);
    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GMAIL_REDIRECT_URI
    );
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    const gmail = google.gmail({ version: "v1", auth: oauth2Client });
    const profile = await gmail.users.getProfile({ userId: "me" });
    const updateData = {
      googleAccountEmail: profile.data.emailAddress,
      encryptedAccessToken: tokens.access_token ? encryptToken(tokens.access_token) : undefined,
      encryptedRefreshToken: tokens.refresh_token ? encryptToken(tokens.refresh_token) : undefined,
      tokenExpiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : undefined,
      scope: tokens.scope ?? process.env.GMAIL_SCOPES ?? "https://www.googleapis.com/auth/gmail.readonly",
      disconnectedAt: null
    };

    await prisma.gmailIntegration.upsert({
      where: { userId },
      create: {
        userId,
        scope: updateData.scope,
        googleAccountEmail: updateData.googleAccountEmail,
        encryptedAccessToken: updateData.encryptedAccessToken,
        encryptedRefreshToken: updateData.encryptedRefreshToken,
        tokenExpiresAt: updateData.tokenExpiresAt
      },
      update: updateData
    });

    await writeAuditLog({
      userId,
      action: "gmail.connect",
      resource: "GmailIntegration"
    });

    return NextResponse.redirect(
      new URL("/settings/integrations?gmail=connected", process.env.APP_BASE_URL ?? request.nextUrl.origin)
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
}
