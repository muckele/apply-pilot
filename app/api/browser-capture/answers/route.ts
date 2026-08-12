import { NextRequest, NextResponse } from "next/server";

import { prisma } from "@/lib/prisma";
import {
  browserCaptureCorsHeaders,
  requireBrowserCaptureToken
} from "@/lib/security/browser-capture-token";
import { apiErrorResponse } from "@/lib/user-context";

function withCors(response: NextResponse, request: Request) {
  browserCaptureCorsHeaders(request).forEach((value, key) => response.headers.set(key, value));
  response.headers.set("cache-control", "no-store");
  return response;
}

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: browserCaptureCorsHeaders(request) });
}

export async function GET(request: NextRequest) {
  try {
    const token = await requireBrowserCaptureToken(request, "APPLICATION_ANSWERS_READ");
    const answers = await prisma.applicationAnswer.findMany({
      where: { userId: token.userId, isActive: true },
      select: {
        id: true,
        category: true,
        question: true,
        answer: true,
        sensitive: true
      },
      orderBy: [{ category: "asc" }, { question: "asc" }]
    });

    return withCors(NextResponse.json({ answers }), request);
  } catch (error) {
    return withCors(apiErrorResponse(error), request);
  }
}
