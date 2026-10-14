import { NextRequest, NextResponse } from "next/server";

import { aiInvocationFromRequest } from "@/lib/ai/http";
import { applicationRunPathSchema, strictEmptyBodySchema } from "@/lib/application-runs/contracts";
import { prepareApplicationRun } from "@/lib/application-runs/orchestration";
import { checkRateLimit } from "@/lib/security/rate-limit";
import { apiErrorResponse, requireUserId } from "@/lib/user-context";

const NO_STORE = { "Cache-Control": "no-store" } as const;

type PrepareApplicationRunRouteDependencies = {
  requireUserId: typeof requireUserId;
  checkRateLimit: typeof checkRateLimit;
  aiInvocationFromRequest: typeof aiInvocationFromRequest;
  prepareApplicationRun: typeof prepareApplicationRun;
};

type RouteContext = { params: Promise<{ id: string }> };

export function createPrepareApplicationRunRouteHandlers(
  dependencies: PrepareApplicationRunRouteDependencies
) {
  return {
    async POST(request: NextRequest, context: RouteContext) {
      try {
        const userId = await dependencies.requireUserId();
        const { id: runId } = applicationRunPathSchema.parse(await context.params);
        strictEmptyBodySchema.parse(await request.json());
        await dependencies.checkRateLimit(`application-runs:prepare:${userId}`, 10, 60_000);
        const invocation = dependencies.aiInvocationFromRequest(request);
        const run = await dependencies.prepareApplicationRun({
          userId,
          runId,
          highCostConfirmed: invocation.highCostConfirmed
        });
        return NextResponse.json({ run }, { headers: NO_STORE });
      } catch (error) {
        const response = apiErrorResponse(error);
        response.headers.set("Cache-Control", "no-store");
        return response;
      }
    }
  };
}

const handlers = createPrepareApplicationRunRouteHandlers({
  requireUserId,
  checkRateLimit,
  aiInvocationFromRequest,
  prepareApplicationRun
});

export const POST = handlers.POST;
