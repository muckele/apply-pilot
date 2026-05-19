import { google } from "googleapis";
import { NextResponse } from "next/server";

import { assertGmailReady } from "@/lib/gmail/status";
import { createOAuthState } from "@/lib/security/oauth-state";
import { apiErrorResponse, requireUserId } from "@/lib/user-context";

export async function GET() {
  try {
    const status = await assertGmailReady();
    const userId = await requireUserId();
    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      status.redirectUri
    );
    const url = oauth2Client.generateAuthUrl({
      access_type: "offline",
      prompt: "consent",
      state: createOAuthState(userId),
      scope: status.scope.split(" ")
    });

    return NextResponse.redirect(url);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
