import { google } from "googleapis";
import { NextRequest, NextResponse } from "next/server";

import { PublicApiError } from "@/lib/api-errors";
import { prisma } from "@/lib/prisma";
import { decryptToken, encryptToken } from "@/lib/security/crypto";
import { checkRateLimit } from "@/lib/security/rate-limit";
import { apiErrorResponse, requireUserId } from "@/lib/user-context";
import { gmailSearchSchema } from "@/lib/validators";

function headerValue(headers: Array<{ name?: string | null; value?: string | null }> | undefined, name: string) {
  return headers?.find((header) => header.name?.toLowerCase() === name.toLowerCase())?.value ?? "";
}

export async function POST(request: NextRequest) {
  try {
    const userId = await requireUserId();
    checkRateLimit(`gmail-search:${userId}`, 10, 60_000);
    const input = gmailSearchSchema.parse(await request.json().catch(() => ({})));
    const integration = await prisma.gmailIntegration.findUniqueOrThrow({ where: { userId } });

    if (integration.disconnectedAt || (!integration.encryptedAccessToken && !integration.encryptedRefreshToken)) {
      throw new PublicApiError("Gmail is not connected.");
    }

    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GMAIL_REDIRECT_URI
    );
    oauth2Client.setCredentials({
      access_token: integration.encryptedAccessToken
        ? decryptToken(integration.encryptedAccessToken)
        : undefined,
      refresh_token: integration.encryptedRefreshToken
        ? decryptToken(integration.encryptedRefreshToken)
        : undefined,
      expiry_date: integration.tokenExpiresAt?.getTime()
    });

    const { credentials } = await oauth2Client.refreshAccessToken();
    if (credentials.access_token) {
      await prisma.gmailIntegration.update({
        where: { userId },
        data: {
          encryptedAccessToken: encryptToken(credentials.access_token),
          tokenExpiresAt: credentials.expiry_date ? new Date(credentials.expiry_date) : undefined
        }
      });
    }

    const gmail = google.gmail({ version: "v1", auth: oauth2Client });
    const list = await gmail.users.messages.list({
      userId: "me",
      q: input.query,
      maxResults: input.maxResults
    });
    const messages = await Promise.all(
      (list.data.messages ?? []).map(async (message) => {
        const details = await gmail.users.messages.get({
          userId: "me",
          id: message.id ?? "",
          format: "metadata",
          metadataHeaders: ["From", "To", "Subject", "Date"]
        });
        const headers = details.data.payload?.headers;

        return {
          gmailMessageId: details.data.id,
          threadId: details.data.threadId,
          from: headerValue(headers, "From"),
          to: headerValue(headers, "To"),
          subject: headerValue(headers, "Subject"),
          date: headerValue(headers, "Date"),
          snippet: details.data.snippet,
          labels: details.data.labelIds ?? []
        };
      })
    );

    return NextResponse.json({ query: input.query, messages });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
