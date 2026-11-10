import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { PublicApiError } from "@/lib/api-errors";
import { applicationRunPathSchema, strictEmptyBodySchema } from "@/lib/application-runs/contracts";
import { runIdFromCompanionCallback, sessionCookieName } from "@/lib/companion-sign-in";
import { captureException } from "@/lib/monitoring/logger";
import { apiErrorResponse } from "@/lib/user-context";

const NO_STORE = { "Cache-Control": "no-store" } as const;
const ATTEMPT_WINDOW_MS = 10 * 60_000;
const ATTEMPTS_PER_WINDOW = 10;

type AuditInput = { userId?: string; action: string; resource: string; resourceId?: string; metadata?: Record<string, unknown> };

type SharedDependencies = {
  checkRateLimit: (key: string, limit?: number, windowMs?: number) => Promise<unknown>;
  writeAuditLog: (input: AuditInput) => Promise<unknown>;
};

async function auditQuietly(writeAuditLog: SharedDependencies["writeAuditLog"], input: AuditInput) {
  try {
    await writeAuditLog(input);
  } catch (error) {
    // The sign-in itself stands even if its audit write fails; the failure is still reported.
    captureException(error, { source: input.action, userId: input.userId, resourceId: input.resourceId });
  }
}

function noStore(response: NextResponse) {
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export function createIssueCompanionSignInCodeRoute(dependencies: SharedDependencies & {
  requireUserId: () => Promise<string>;
  issue: (input: { userId: string; runId: string }) => Promise<{ code: string; expiresAt: Date }>;
}) {
  return {
    async POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
      try {
        const userId = await dependencies.requireUserId();
        const { id: runId } = applicationRunPathSchema.parse(await context.params);
        strictEmptyBodySchema.parse(await request.json());
        await dependencies.checkRateLimit(`companion-sign-in:issue:${userId}`, ATTEMPTS_PER_WINDOW, ATTEMPT_WINDOW_MS);
        const issued = await dependencies.issue({ userId, runId });
        await auditQuietly(dependencies.writeAuditLog, {
          userId,
          action: "companion.sign_in_code.issued",
          resource: "ApplicationRun",
          resourceId: runId
        });
        return NextResponse.json(
          { code: issued.code, expiresAt: issued.expiresAt.toISOString() },
          { headers: NO_STORE }
        );
      } catch (error) {
        return noStore(apiErrorResponse(error));
      }
    }
  };
}

const exchangeBodySchema = z.object({
  code: z.string().max(40),
  callbackUrl: z.string().max(200)
}).strict();

function clientAddress(request: NextRequest) {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}

export function createCompanionSignInExchangeRoute(dependencies: SharedDependencies & {
  exchange: (input: { code: string; callbackUrl: string }) => Promise<{
    userId: string;
    runId: string;
    sessionToken: string;
    expires: Date;
    redirectTo: string;
  }>;
}) {
  return {
    async POST(request: NextRequest) {
      // A session cookie may only be set for a page Apply Pilot itself served, which
      // stops another site from signing a visitor into this account.
      if (request.headers.get("origin") !== request.nextUrl.origin) {
        return NextResponse.json(
          { error: "Sign-in requests must come from Apply Pilot." },
          { status: 403, headers: NO_STORE }
        );
      }
      try {
        const parsed = exchangeBodySchema.safeParse(await request.json().catch(() => null));
        if (!parsed.success) {
          throw new PublicApiError("That code didn't work.", 400, { code: "COMPANION_SIGN_IN_FAILED" });
        }
        const runKey = runIdFromCompanionCallback(parsed.data.callbackUrl) ?? "invalid";
        await dependencies.checkRateLimit(`companion-sign-in:exchange-ip:${clientAddress(request)}`, ATTEMPTS_PER_WINDOW, ATTEMPT_WINDOW_MS);
        await dependencies.checkRateLimit(`companion-sign-in:exchange-run:${runKey}`, ATTEMPTS_PER_WINDOW, ATTEMPT_WINDOW_MS);

        const result = await dependencies.exchange(parsed.data);
        await auditQuietly(dependencies.writeAuditLog, {
          userId: result.userId,
          action: "companion.sign_in.completed",
          resource: "ApplicationRun",
          resourceId: result.runId
        });

        const secure = request.nextUrl.protocol === "https:";
        const response = NextResponse.json({ redirectTo: result.redirectTo }, { headers: NO_STORE });
        response.cookies.set(sessionCookieName(secure), result.sessionToken, {
          httpOnly: true,
          sameSite: "lax",
          secure,
          path: "/",
          expires: result.expires
        });
        return response;
      } catch (error) {
        return noStore(apiErrorResponse(error));
      }
    }
  };
}
