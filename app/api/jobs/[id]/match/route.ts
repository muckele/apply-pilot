import { NextRequest, NextResponse } from "next/server";

import { runJobMatch } from "@/lib/jobs";
import { checkRateLimit } from "@/lib/security/rate-limit";
import { apiErrorResponse, requireUserId } from "@/lib/user-context";

type Params = {
  params: Promise<{ id: string }>;
};

export async function POST(_request: NextRequest, { params }: Params) {
  try {
    const userId = await requireUserId();
    checkRateLimit(`job-match:${userId}`, 20, 60_000);
    const { id } = await params;
    const result = await runJobMatch(userId, id);

    return NextResponse.json(result);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
