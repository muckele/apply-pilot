import { NextResponse } from "next/server";

import { toPublicApplicationRunAnswerPacket } from "@/lib/application-runs/answer-packet-api";
import { getCurrentAnswerPacket } from "@/lib/application-runs/answer-packet-service";
import { applicationRunPathSchema } from "@/lib/application-runs/contracts";
import { checkRateLimit } from "@/lib/security/rate-limit";
import { apiErrorResponse, requireUserId } from "@/lib/user-context";

const NO_STORE = { "Cache-Control": "no-store" } as const;

type ApplicationRunAnswerPacketRouteDependencies = {
  requireUserId: typeof requireUserId;
  checkRateLimit: typeof checkRateLimit;
  getCurrentAnswerPacket: typeof getCurrentAnswerPacket;
};

type RouteContext = { params: Promise<{ id: string }> };

export function createApplicationRunAnswerPacketRouteHandlers(
  dependencies: ApplicationRunAnswerPacketRouteDependencies
) {
  return {
    async GET(_request: Request, context: RouteContext) {
      try {
        const userId = await dependencies.requireUserId();
        const { id: runId } = applicationRunPathSchema.parse(await context.params);
        await dependencies.checkRateLimit(`application-runs:answer-packet:read:${userId}`, 60, 60_000);
        const result = await dependencies.getCurrentAnswerPacket({ userId, runId });
        return NextResponse.json(
          {
            runId: result.runId,
            current: result.current === null
              ? null
              : toPublicApplicationRunAnswerPacket(result.current)
          },
          { headers: NO_STORE }
        );
      } catch (error) {
        const response = apiErrorResponse(error);
        response.headers.set("Cache-Control", "no-store");
        return response;
      }
    }
  };
}

const handlers = createApplicationRunAnswerPacketRouteHandlers({
  requireUserId,
  checkRateLimit,
  getCurrentAnswerPacket
});

export const GET = handlers.GET;
