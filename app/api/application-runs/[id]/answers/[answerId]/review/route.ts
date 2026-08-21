import { NextRequest, NextResponse } from "next/server";

import {
  applicationRunAnswerPathSchema,
  reviewApplicationRunAnswerBodySchema
} from "@/lib/application-runs/contracts";
import { reviewApplicationRunAnswer } from "@/lib/application-runs/service";
import { checkRateLimit } from "@/lib/security/rate-limit";
import { apiErrorResponse, requireUserId } from "@/lib/user-context";

const NO_STORE = { "Cache-Control": "no-store" } as const;

type ReviewApplicationRunAnswerRouteDependencies = {
  requireUserId: typeof requireUserId;
  checkRateLimit: typeof checkRateLimit;
  reviewApplicationRunAnswer: typeof reviewApplicationRunAnswer;
};

type RouteContext = { params: Promise<{ id: string; answerId: string }> };

export function createReviewApplicationRunAnswerRouteHandlers(
  dependencies: ReviewApplicationRunAnswerRouteDependencies
) {
  return {
    async POST(request: NextRequest, context: RouteContext) {
      try {
        const userId = await dependencies.requireUserId();
        const { id: runId, answerId } = applicationRunAnswerPathSchema.parse(await context.params);
        const body = reviewApplicationRunAnswerBodySchema.parse(await request.json());
        await dependencies.checkRateLimit(`application-runs:answers:review:${userId}`, 60, 60_000);
        const answer = await dependencies.reviewApplicationRunAnswer({
          userId,
          runId,
          answerId,
          status: body.status
        });
        return NextResponse.json({ answer }, { headers: NO_STORE });
      } catch (error) {
        const response = apiErrorResponse(error);
        response.headers.set("Cache-Control", "no-store");
        return response;
      }
    }
  };
}

const handlers = createReviewApplicationRunAnswerRouteHandlers({
  requireUserId,
  checkRateLimit,
  reviewApplicationRunAnswer
});

export const POST = handlers.POST;
