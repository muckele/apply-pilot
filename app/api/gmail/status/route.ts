import { NextResponse } from "next/server";

import { getGmailIntegrationStatus } from "@/lib/gmail/status";

export async function GET() {
  const status = await getGmailIntegrationStatus();

  return NextResponse.json(status, {
    status: status.issues.length ? 503 : 200
  });
}
