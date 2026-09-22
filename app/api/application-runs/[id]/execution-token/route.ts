import { NextRequest, NextResponse } from "next/server";

import { applicationRunPathSchema, strictEmptyBodySchema } from "@/lib/application-runs/contracts";
import { issueExecutionToken } from "@/lib/application-runs/execution-token";
import { checkRateLimit } from "@/lib/security/rate-limit";
import { apiErrorResponse, requireUserId } from "@/lib/user-context";

const NO_STORE = { "Cache-Control": "no-store" } as const;

type IssueApplicationRunExecutionTokenRouteDependencies = {
  requireUserId: typeof requireUserId;
  checkRateLimit: typeof checkRateLimit;
  issueExecutionToken: typeof issueExecutionToken;
};

type RouteContext = { params: Promise<{ id: string }> };

export function createIssueApplicationRunExecutionTokenRouteHandlers(
  dependencies: IssueApplicationRunExecutionTokenRouteDependencies
) {
  return {
    async POST(request: NextRequest, context: RouteContext) {
      try {
        const userId = await dependencies.requireUserId();
        const { id: runId } = applicationRunPathSchema.parse(await context.params);
        strictEmptyBodySchema.parse(await request.json());
        await dependencies.checkRateLimit(`application-runs:execution-token:issue:${userId}`, 10, 60_000);
        const issued = await dependencies.issueExecutionToken({
          userId,
          runId,
          scope: "APPLICATION_READ"
        });
        return NextResponse.json(
          {
            token: issued.token,
            tokenRecord: {
              id: issued.tokenRecord.id,
              runId,
              scope: issued.tokenRecord.scope,
              singleUse: issued.tokenRecord.singleUse,
              expiresAt: issued.tokenRecord.expiresAt,
              createdAt: issued.tokenRecord.createdAt
            }
          },
          { status: 201, headers: NO_STORE }
        );
      } catch (error) {
        const response = apiErrorResponse(error);
        response.headers.set("Cache-Control", "no-store");
        return response;
      }
    }
  };
}

const handlers = createIssueApplicationRunExecutionTokenRouteHandlers({
  requireUserId,
  checkRateLimit,
  issueExecutionToken
});

export const POST = handlers.POST;
