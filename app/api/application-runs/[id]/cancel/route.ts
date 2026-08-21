import { NextRequest, NextResponse } from "next/server";

import { applicationRunPathSchema, strictEmptyBodySchema } from "@/lib/application-runs/contracts";
import { cancelApplicationRun } from "@/lib/application-runs/service";
import { checkRateLimit } from "@/lib/security/rate-limit";
import { apiErrorResponse, requireUserId } from "@/lib/user-context";

const NO_STORE = { "Cache-Control": "no-store" } as const;

type CancelApplicationRunRouteDependencies = {
  requireUserId: typeof requireUserId;
  checkRateLimit: typeof checkRateLimit;
  cancelApplicationRun: typeof cancelApplicationRun;
};

type RouteContext = { params: Promise<{ id: string }> };

export function createCancelApplicationRunRouteHandlers(
  dependencies: CancelApplicationRunRouteDependencies
) {
  return {
    async POST(request: NextRequest, context: RouteContext) {
      try {
        const userId = await dependencies.requireUserId();
        const { id: runId } = applicationRunPathSchema.parse(await context.params);
        strictEmptyBodySchema.parse(await request.json());
        await dependencies.checkRateLimit(`application-runs:cancel:${userId}`, 30, 60_000);
        const result = await dependencies.cancelApplicationRun({ userId, runId });
        return NextResponse.json(result, { headers: NO_STORE });
      } catch (error) {
        const response = apiErrorResponse(error);
        response.headers.set("Cache-Control", "no-store");
        return response;
      }
    }
  };
}

const handlers = createCancelApplicationRunRouteHandlers({
  requireUserId,
  checkRateLimit,
  cancelApplicationRun
});

export const POST = handlers.POST;
