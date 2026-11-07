import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { recordApplyReturnAction } from "@/lib/applications/apply-return-service";
import { prisma } from "@/lib/prisma";
import { checkRateLimit } from "@/lib/security/rate-limit";
import { apiErrorResponse, requireUserId } from "@/lib/user-context";

type Params = {
  params: Promise<{ id: string }>;
};

// "Did you apply?": records that the user opened the employer's application from the Apply Kit,
// or their "Not applying" answer (and its undo). "Yes, I applied" is not accepted here; it goes
// through the existing "I applied" confirmation (POST /api/applications).
const applyReturnSchema = z.object({
  action: z.enum(["OPENED", "NOT_APPLYING", "UNDO_NOT_APPLYING"])
}).strict();

export async function POST(request: NextRequest, { params }: Params) {
  try {
    const userId = await requireUserId();
    await checkRateLimit(`applications:apply-return:${userId}`, 60, 60_000);
    const { id } = await params;
    const input = applyReturnSchema.parse(await request.json());
    const result = await prisma.$transaction((tx) =>
      recordApplyReturnAction(tx, { userId, jobId: id, action: input.action, now: new Date() }));
    return NextResponse.json(result);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
