import { NextRequest, NextResponse } from "next/server";

import {
  applicationRunAnswerPathSchema,
  applicationRunDocumentExportBodySchema
} from "@/lib/application-runs/contracts";
import {
  exportApprovedApplicationRunDocument
} from "@/lib/application-runs/document-export";
import { checkRateLimit } from "@/lib/security/rate-limit";
import { apiErrorResponse, requireUserId } from "@/lib/user-context";

const NO_STORE = { "Cache-Control": "no-store" } as const;

type ApplicationRunDocumentExportRouteDependencies = {
  requireUserId: typeof requireUserId;
  checkRateLimit: typeof checkRateLimit;
  exportApprovedApplicationRunDocument: typeof exportApprovedApplicationRunDocument;
};

type RouteContext = { params: Promise<{ id: string; answerId: string }> };

export function createApplicationRunDocumentExportRouteHandlers(
  dependencies: ApplicationRunDocumentExportRouteDependencies
) {
  return {
    async POST(request: NextRequest, context: RouteContext) {
      try {
        const userId = await dependencies.requireUserId();
        const { id: runId, answerId } = applicationRunAnswerPathSchema.parse(await context.params);
        await dependencies.checkRateLimit(`application-runs:document-export:${userId}`, 30, 60_000);
        const body = applicationRunDocumentExportBodySchema.parse(await request.json());
        const exported = await dependencies.exportApprovedApplicationRunDocument({
          userId,
          runId,
          answerId,
          expectedStateVersion: body.expectedStateVersion,
          answerPacketVersion: body.answerPacketVersion,
          packetHash: body.packetHash,
          format: body.format
        });

        return new NextResponse(new Uint8Array(exported.bytes), {
          headers: {
            ...NO_STORE,
            "Content-Type": exported.contentType,
            "Content-Disposition": `attachment; filename="${exported.filename}"`
          }
        });
      } catch (error) {
        const response = apiErrorResponse(error);
        response.headers.set("Cache-Control", "no-store");
        return response;
      }
    }
  };
}

const handlers = createApplicationRunDocumentExportRouteHandlers({
  requireUserId,
  checkRateLimit,
  exportApprovedApplicationRunDocument
});

export const POST = handlers.POST;
