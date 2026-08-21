import { NextRequest, NextResponse } from "next/server";

import { createApplicationRunBodySchema } from "@/lib/application-runs/contracts";
import { createApplicationRun } from "@/lib/application-runs/service";
import { checkRateLimit } from "@/lib/security/rate-limit";
import { apiErrorResponse, requireUserId } from "@/lib/user-context";

const NO_STORE = { "Cache-Control": "no-store" } as const;

type ApplicationRunsRouteDependencies = {
  requireUserId: typeof requireUserId;
  checkRateLimit: typeof checkRateLimit;
  createApplicationRun: typeof createApplicationRun;
};

export function createApplicationRunsRouteHandlers(dependencies: ApplicationRunsRouteDependencies) {
  return {
    async POST(request: NextRequest) {
      try {
        const userId = await dependencies.requireUserId();
        const input = createApplicationRunBodySchema.parse(await request.json());
        await dependencies.checkRateLimit(`application-runs:create:${userId}`, 20, 60_000);
        const result = await dependencies.createApplicationRun(userId, input);
        return NextResponse.json(result, {
          status: result.replayed ? 200 : 201,
          headers: NO_STORE
        });
      } catch (error) {
        const response = apiErrorResponse(error);
        response.headers.set("Cache-Control", "no-store");
        return response;
      }
    }
  };
}

const handlers = createApplicationRunsRouteHandlers({
  requireUserId,
  checkRateLimit,
  createApplicationRun
});

export const POST = handlers.POST;
