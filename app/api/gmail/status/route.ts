import { NextResponse } from "next/server";

import { getGmailIntegrationStatus } from "@/lib/gmail/status";
import { apiErrorResponse, requireUserId } from "@/lib/user-context";

export async function GET() {
  try {
    const userId = await requireUserId();
    const status = await getGmailIntegrationStatus(userId);

    return NextResponse.json(status, {
      status: status.issues.length ? 503 : 200
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
