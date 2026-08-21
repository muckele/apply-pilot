import { NextRequest, NextResponse } from "next/server";

import {
  applicationRunPathSchema,
  resolveApplicationRunReviewBodySchema
} from "@/lib/application-runs/contracts";
import { resolveApplicationRunReview } from "@/lib/application-runs/service";
import { checkRateLimit } from "@/lib/security/rate-limit";
import { apiErrorResponse, requireUserId } from "@/lib/user-context";

const NO_STORE = { "Cache-Control": "no-store" } as const;

type ResolveApplicationRunReviewRouteDependencies = {
  requireUserId: typeof requireUserId;
  checkRateLimit: typeof checkRateLimit;
  resolveApplicationRunReview: typeof resolveApplicationRunReview;
};

type RouteContext = { params: Promise<{ id: string }> };

export function createResolveApplicationRunReviewRouteHandlers(
  dependencies: ResolveApplicationRunReviewRouteDependencies
) {
  return {
    async POST(request: NextRequest, context: RouteContext) {
      try {
        const userId = await dependencies.requireUserId();
        const { id: runId } = applicationRunPathSchema.parse(await context.params);
        const body = resolveApplicationRunReviewBodySchema.parse(await request.json());
        await dependencies.checkRateLimit(`application-runs:resolve-review:${userId}`, 30, 60_000);
        const run = await dependencies.resolveApplicationRunReview({ userId, runId, ...body });
        return NextResponse.json({ run }, { headers: NO_STORE });
      } catch (error) {
        const response = apiErrorResponse(error);
        response.headers.set("Cache-Control", "no-store");
        return response;
      }
    }
  };
}

const handlers = createResolveApplicationRunReviewRouteHandlers({
  requireUserId,
  checkRateLimit,
  resolveApplicationRunReview
});

export const POST = handlers.POST;
