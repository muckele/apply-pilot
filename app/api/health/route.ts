import { NextResponse } from "next/server";

import { getAppVersion } from "@/lib/app-version";

export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json({
    status: "ok",
    service: "jobmatch-crm",
    environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "development",
    version: getAppVersion(),
    timestamp: new Date().toISOString()
  });
}
