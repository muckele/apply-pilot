import { NextRequest, NextResponse } from "next/server";

import { applicationDetailsInputSchema } from "@/lib/application-details";
import { loadApplicationDetails, saveApplicationDetails } from "@/lib/application-details-store";
import { checkRateLimit } from "@/lib/security/rate-limit";
import { apiErrorResponse, requireUserId } from "@/lib/user-context";

export async function GET() {
  try {
    const userId = await requireUserId();
    return NextResponse.json({ details: await loadApplicationDetails(userId) });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

// Saving is the applicant's confirmation that Fill may use these values (D034).
export async function PUT(request: NextRequest) {
  try {
    const userId = await requireUserId();
    await checkRateLimit(`application-details:save:${userId}`, 20, 60_000);
    const input = applicationDetailsInputSchema.parse(await request.json());
    return NextResponse.json({ details: await saveApplicationDetails(userId, input) });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
