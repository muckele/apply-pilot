import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json({
    status: "ok",
    service: "jobmatch-crm",
    environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "development",
    version: process.env.APP_VERSION ?? process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 12) ?? null,
    timestamp: new Date().toISOString()
  });
}
