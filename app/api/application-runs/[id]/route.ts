import { NextResponse } from "next/server";

import { applicationRunPathSchema } from "@/lib/application-runs/contracts";
import { getApplicationRun } from "@/lib/application-runs/service";
import { checkRateLimit } from "@/lib/security/rate-limit";
import { apiErrorResponse, requireUserId } from "@/lib/user-context";

const NO_STORE = { "Cache-Control": "no-store" } as const;

type ApplicationRunRouteDependencies = {
  requireUserId: typeof requireUserId;
  checkRateLimit: typeof checkRateLimit;
  getApplicationRun: typeof getApplicationRun;
};

type RouteContext = { params: Promise<{ id: string }> };

export function createApplicationRunRouteHandlers(dependencies: ApplicationRunRouteDependencies) {
  return {
    async GET(_request: Request, context: RouteContext) {
      try {
        const userId = await dependencies.requireUserId();
        const { id } = applicationRunPathSchema.parse(await context.params);
        await dependencies.checkRateLimit(`application-runs:read:${userId}`, 60, 60_000);
        const run = await dependencies.getApplicationRun(userId, id);
        return NextResponse.json({ run }, { headers: NO_STORE });
      } catch (error) {
        const response = apiErrorResponse(error);
        response.headers.set("Cache-Control", "no-store");
        return response;
      }
    }
  };
}

const handlers = createApplicationRunRouteHandlers({
  requireUserId,
  checkRateLimit,
  getApplicationRun
});

export const GET = handlers.GET;
