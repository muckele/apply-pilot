import { NextRequest, NextResponse } from "next/server";

import {
  assertApplicationJsonContentType,
  readBoundedApplicationRunPacketJson,
  toPublicApplicationRunAnswerPacket
} from "@/lib/application-runs/answer-packet-api";
import { rebuildCurrentAnswerPacket } from "@/lib/application-runs/answer-packet-service";
import {
  applicationRunPathSchema,
  rebuildApplicationRunAnswerPacketBodySchema
} from "@/lib/application-runs/contracts";
import { checkRateLimit } from "@/lib/security/rate-limit";
import { apiErrorResponse, requireUserId } from "@/lib/user-context";

const NO_STORE = { "Cache-Control": "no-store" } as const;

type RebuildApplicationRunAnswerPacketRouteDependencies = {
  requireUserId: typeof requireUserId;
  checkRateLimit: typeof checkRateLimit;
  rebuildCurrentAnswerPacket: typeof rebuildCurrentAnswerPacket;
};

type RouteContext = { params: Promise<{ id: string }> };

export function createRebuildApplicationRunAnswerPacketRouteHandlers(
  dependencies: RebuildApplicationRunAnswerPacketRouteDependencies
) {
  return {
    async POST(request: NextRequest, context: RouteContext) {
      try {
        const userId = await dependencies.requireUserId();
        const { id: runId } = applicationRunPathSchema.parse(await context.params);
        await dependencies.checkRateLimit(
          `application-runs:answer-packet:rebuild:${userId}`,
          10,
          60_000
        );
        assertApplicationJsonContentType(request);
        const body = rebuildApplicationRunAnswerPacketBodySchema.parse(
          await readBoundedApplicationRunPacketJson(request)
        );
        const result = await dependencies.rebuildCurrentAnswerPacket({
          userId,
          runId,
          expectedStateVersion: body.expectedStateVersion,
          expectedFormInspectionVersion: body.expectedFormInspectionVersion,
          expectedAnswerPacketVersion: body.expectedAnswerPacketVersion
        });
        return NextResponse.json(
          {
            replayed: result.replayed,
            run: {
              id: result.runId,
              state: result.state,
              stateVersion: result.stateVersion
            },
            current: toPublicApplicationRunAnswerPacket(result.packet)
          },
          { status: result.replayed ? 200 : 201, headers: NO_STORE }
        );
      } catch (error) {
        const response = apiErrorResponse(error);
        response.headers.set("Cache-Control", "no-store");
        return response;
      }
    }
  };
}

const handlers = createRebuildApplicationRunAnswerPacketRouteHandlers({
  requireUserId,
  checkRateLimit,
  rebuildCurrentAnswerPacket
});

export const POST = handlers.POST;
