import { NextRequest, NextResponse } from "next/server";

import {
  acquireApplicationRunFillAttemptBodySchema,
  applicationRunFillAttemptPatchBodySchema,
  applicationRunPathSchema
} from "@/lib/application-runs/contracts";
import {
  acquireFillAttempt,
  finalizeFillAttempt,
  getFillAttemptStatus,
  recoverExpiredFillAttempt
} from "@/lib/application-runs/fill-attempt";
import { checkRateLimit } from "@/lib/security/rate-limit";
import { apiErrorResponse, requireUserId } from "@/lib/user-context";

const NO_STORE = { "Cache-Control": "no-store" } as const;

type ApplicationRunFillAttemptRouteDependencies = {
  requireUserId: typeof requireUserId;
  checkRateLimit: typeof checkRateLimit;
  acquireFillAttempt: typeof acquireFillAttempt;
  getFillAttemptStatus: typeof getFillAttemptStatus;
  finalizeFillAttempt: typeof finalizeFillAttempt;
  recoverExpiredFillAttempt: typeof recoverExpiredFillAttempt;
};

type RouteContext = { params: Promise<{ id: string }> };

export function createApplicationRunFillAttemptRouteHandlers(
  dependencies: ApplicationRunFillAttemptRouteDependencies
) {
  return {
    async POST(request: NextRequest, context: RouteContext) {
      try {
        const userId = await dependencies.requireUserId();
        const { id: runId } = applicationRunPathSchema.parse(await context.params);
        const body = acquireApplicationRunFillAttemptBodySchema.parse(await request.json());
        await dependencies.checkRateLimit(`application-runs:fill-attempt:acquire:${userId}`, 10, 60_000);
        const result = await dependencies.acquireFillAttempt({
          userId,
          runId,
          expectedStateVersion: body.expectedStateVersion
        });
        return NextResponse.json(result, { status: 201, headers: NO_STORE });
      } catch (error) {
        const response = apiErrorResponse(error);
        response.headers.set("Cache-Control", "no-store");
        return response;
      }
    },

    async GET(_request: NextRequest, context: RouteContext) {
      try {
        const userId = await dependencies.requireUserId();
        const { id: runId } = applicationRunPathSchema.parse(await context.params);
        await dependencies.checkRateLimit(`application-runs:fill-attempt:status:${userId}`, 300, 60_000);
        const result = await dependencies.getFillAttemptStatus({ userId, runId });
        return NextResponse.json(result, { headers: NO_STORE });
      } catch (error) {
        const response = apiErrorResponse(error);
        response.headers.set("Cache-Control", "no-store");
        return response;
      }
    },

    async PATCH(request: NextRequest, context: RouteContext) {
      try {
        const userId = await dependencies.requireUserId();
        const { id: runId } = applicationRunPathSchema.parse(await context.params);
        const body = applicationRunFillAttemptPatchBodySchema.parse(await request.json());
        await dependencies.checkRateLimit(`application-runs:fill-attempt:mutate:${userId}`, 30, 60_000);
        const result = body.action === "FINALIZE"
          ? await dependencies.finalizeFillAttempt({ userId, runId, ...body })
          : await dependencies.recoverExpiredFillAttempt({
              userId,
              runId,
              fillAttemptId: body.fillAttemptId,
              expectedStateVersion: body.expectedStateVersion
            });
        return NextResponse.json(result, { headers: NO_STORE });
      } catch (error) {
        const response = apiErrorResponse(error);
        response.headers.set("Cache-Control", "no-store");
        return response;
      }
    }
  };
}

const handlers = createApplicationRunFillAttemptRouteHandlers({
  requireUserId,
  checkRateLimit,
  acquireFillAttempt,
  getFillAttemptStatus,
  finalizeFillAttempt,
  recoverExpiredFillAttempt
});

export const POST = handlers.POST;
export const GET = handlers.GET;
export const PATCH = handlers.PATCH;
