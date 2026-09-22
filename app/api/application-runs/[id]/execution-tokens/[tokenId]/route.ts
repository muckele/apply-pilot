import { NextRequest, NextResponse } from "next/server";

import { applicationRunExecutionTokenPathSchema } from "@/lib/application-runs/contracts";
import { revokeExecutionTokenForRun } from "@/lib/application-runs/execution-token";
import { checkRateLimit } from "@/lib/security/rate-limit";
import { apiErrorResponse, requireUserId } from "@/lib/user-context";

const NO_STORE = { "Cache-Control": "no-store" } as const;

type RevokeApplicationRunExecutionTokenRouteDependencies = {
  requireUserId: typeof requireUserId;
  checkRateLimit: typeof checkRateLimit;
  revokeExecutionTokenForRun: typeof revokeExecutionTokenForRun;
};

type RouteContext = { params: Promise<{ id: string; tokenId: string }> };

export function createRevokeApplicationRunExecutionTokenRouteHandlers(
  dependencies: RevokeApplicationRunExecutionTokenRouteDependencies
) {
  return {
    async DELETE(_request: NextRequest, context: RouteContext) {
      try {
        const userId = await dependencies.requireUserId();
        const { id: runId, tokenId } = applicationRunExecutionTokenPathSchema.parse(await context.params);
        await dependencies.checkRateLimit(`application-runs:execution-token:revoke:${userId}`, 20, 60_000);
        const result = await dependencies.revokeExecutionTokenForRun({ userId, runId, tokenId });
        return NextResponse.json(result, { headers: NO_STORE });
      } catch (error) {
        const response = apiErrorResponse(error);
        response.headers.set("Cache-Control", "no-store");
        return response;
      }
    }
  };
}

const handlers = createRevokeApplicationRunExecutionTokenRouteHandlers({
  requireUserId,
  checkRateLimit,
  revokeExecutionTokenForRun
});

export const DELETE = handlers.DELETE;
