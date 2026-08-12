import { createHash, randomBytes } from "node:crypto";

import { PublicApiError } from "@/lib/api-errors";
import { prisma } from "@/lib/prisma";
import { checkRateLimit } from "@/lib/security/rate-limit";

export const browserCaptureScopes = ["JOB_CAPTURE", "APPLICATION_ANSWERS_READ"] as const;
export type BrowserCaptureScope = (typeof browserCaptureScopes)[number];

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function createBrowserCaptureToken() {
  const token = `jmc_${randomBytes(32).toString("base64url")}`;
  return {
    token,
    tokenHash: hashToken(token),
    tokenPrefix: `${token.slice(0, 12)}...`
  };
}

export async function requireBrowserCaptureToken(request: Request, scope: BrowserCaptureScope) {
  const authorization = request.headers.get("authorization") ?? "";
  const [scheme, token] = authorization.split(/\s+/, 2);

  if (scheme?.toLowerCase() !== "bearer" || !token?.startsWith("jmc_")) {
    throw new PublicApiError("A valid browser capture token is required.", 401);
  }

  const record = await prisma.browserCaptureToken.findUnique({
    where: { tokenHash: hashToken(token) }
  });

  if (
    !record ||
    record.revokedAt ||
    (record.expiresAt && record.expiresAt.getTime() <= Date.now()) ||
    !record.scopes.includes(scope)
  ) {
    throw new PublicApiError("This browser capture token is invalid, expired, or missing permission.", 401);
  }

  await checkRateLimit(`browser-capture:${record.id}`, 60, 60_000);
  await prisma.browserCaptureToken.update({
    where: { id: record.id },
    data: { lastUsedAt: new Date() }
  });

  return record;
}

export function browserCaptureCorsHeaders(request: Request) {
  const origin = request.headers.get("origin");
  const headers = new Headers({
    "access-control-allow-headers": "authorization, content-type",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-max-age": "600",
    vary: "Origin"
  });

  if (origin?.startsWith("chrome-extension://")) {
    headers.set("access-control-allow-origin", origin);
  }

  return headers;
}
