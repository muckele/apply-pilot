import { prisma } from "@/lib/prisma";

export type GmailIntegrationStatus = {
  oauthConfigured: boolean;
  databaseReachable: boolean;
  connected: boolean;
  googleAccountEmail?: string | null;
  redirectUri: string;
  scope: string;
  issues: string[];
};

export async function getGmailIntegrationStatus(userId?: string) {
  const redirectUri =
    process.env.GMAIL_REDIRECT_URI ?? "http://127.0.0.1:3000/api/gmail/callback";
  const scope = process.env.GMAIL_SCOPES ?? "https://www.googleapis.com/auth/gmail.readonly";
  const issues: string[] = [];
  const oauthConfigured = Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);

  if (!oauthConfigured) {
    issues.push("Google OAuth credentials are not configured.");
  }

  let databaseReachable = false;
  let connected = false;
  let googleAccountEmail: string | null | undefined;

  try {
    await prisma.$queryRaw`SELECT 1`;
    databaseReachable = true;
    if (userId) {
      const integration = await prisma.gmailIntegration.findUnique({ where: { userId } });
      connected = Boolean(
        integration &&
          !integration.disconnectedAt &&
          (integration.encryptedAccessToken || integration.encryptedRefreshToken)
      );
      googleAccountEmail = integration?.googleAccountEmail;
    }
  } catch {
    issues.push("PostgreSQL is not reachable from DATABASE_URL.");
  }

  return {
    oauthConfigured,
    databaseReachable,
    connected,
    googleAccountEmail,
    redirectUri,
    scope,
    issues
  } satisfies GmailIntegrationStatus;
}

export async function assertGmailReady() {
  const status = await getGmailIntegrationStatus();

  if (status.issues.length > 0) {
    throw new Error(`Gmail integration is not ready: ${status.issues.join(" ")}`);
  }

  return status;
}
