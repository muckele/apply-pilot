import { NextRequest, NextResponse } from "next/server";

import {
  applicationRunPathSchema,
  completeApplicationRunByUserBodySchema
} from "@/lib/application-runs/contracts";
import { completeApplicationRunByUser } from "@/lib/application-runs/service";
import { checkRateLimit } from "@/lib/security/rate-limit";
import { apiErrorResponse, requireUserId } from "@/lib/user-context";

const NO_STORE = { "Cache-Control": "no-store" } as const;

type CompleteApplicationRunByUserRouteDependencies = {
  requireUserId: typeof requireUserId;
  checkRateLimit: typeof checkRateLimit;
  completeApplicationRunByUser: typeof completeApplicationRunByUser;
};

type RouteContext = { params: Promise<{ id: string }> };

export function createCompleteApplicationRunByUserRouteHandlers(
  dependencies: CompleteApplicationRunByUserRouteDependencies
) {
  return {
    async POST(request: NextRequest, context: RouteContext) {
      try {
        const userId = await dependencies.requireUserId();
        const { id: runId } = applicationRunPathSchema.parse(await context.params);
        const body = completeApplicationRunByUserBodySchema.parse(await request.json());
        await dependencies.checkRateLimit(
          `application-runs:complete-by-user:${userId}`,
          10,
          60_000
        );
        const run = await dependencies.completeApplicationRunByUser({
          userId,
          runId,
          attestation: body.attestation
        });
        return NextResponse.json({
          run: {
            id: run.id,
            state: run.state,
            stateVersion: run.stateVersion,
            completedAt: run.completedAt
          }
        }, { headers: NO_STORE });
      } catch (error) {
        const response = apiErrorResponse(error);
        response.headers.set("Cache-Control", "no-store");
        return response;
      }
    }
  };
}

const handlers = createCompleteApplicationRunByUserRouteHandlers({
  requireUserId,
  checkRateLimit,
  completeApplicationRunByUser
});

export const POST = handlers.POST;
