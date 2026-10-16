import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { evidenceSnapshotSaveBodySchema } from "@/lib/jobs/evidence-snapshot-contracts";
import { saveEvidenceSnapshot } from "@/lib/jobs/evidence-snapshots";
import { checkRateLimit } from "@/lib/security/rate-limit";
import { apiErrorResponse, requireUserId } from "@/lib/user-context";

const NO_STORE = { "Cache-Control": "no-store" } as const;
const jobIdSchema = z.string().trim().min(1).max(191).regex(/^[A-Za-z0-9:_-]+$/u);

type Params = {
  params: Promise<{ id: string }>;
};

type EvidenceSnapshotRouteDependencies = {
  requireUserId: typeof requireUserId;
  checkRateLimit: typeof checkRateLimit;
  saveEvidenceSnapshot: typeof saveEvidenceSnapshot;
};

export function createEvidenceSnapshotRouteHandlers(dependencies: EvidenceSnapshotRouteDependencies) {
  return {
    async POST(request: NextRequest, { params }: Params) {
      try {
        const userId = await dependencies.requireUserId();
        const input = evidenceSnapshotSaveBodySchema.parse(await request.json());
        const jobId = jobIdSchema.parse((await params).id);
        await dependencies.checkRateLimit(`evidence-snapshots:create:${userId}`, 20, 60_000);
        const result = await dependencies.saveEvidenceSnapshot(userId, jobId, input);
        return NextResponse.json(result, {
          status: result.replayed ? 200 : 201,
          headers: NO_STORE
        });
      } catch (error) {
        const response = apiErrorResponse(error);
        response.headers.set("Cache-Control", "no-store");
        return response;
      }
    }
  };
}
