import { NextRequest, NextResponse } from "next/server";

import { followBoard, followBoardSchema } from "@/lib/job-sources/board-follow";
import { writeAuditLog } from "@/lib/security/audit-log";
import { checkRateLimit } from "@/lib/security/rate-limit";
import { apiErrorResponse, requireUserId } from "@/lib/user-context";

export async function POST(request: NextRequest) {
  try {
    const userId = await requireUserId();
    await checkRateLimit(`job-sources:follow:${userId}`, 20, 60_000);
    const input = followBoardSchema.parse(await request.json());
    const result = await followBoard({ userId, url: input.url, name: input.name });

    if (result.created || result.reenabled) {
      await writeAuditLog({
        userId,
        action: "job.source.follow",
        resource: "JobSource",
        resourceId: result.source.id,
        metadata: { type: result.source.type, created: result.created, reenabled: result.reenabled }
      });
    }

    return NextResponse.json(result, { status: result.created ? 201 : 200 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
