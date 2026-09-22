import type { NextRequest } from "next/server";

export function aiInvocationFromRequest(request: NextRequest) {
  return { highCostConfirmed: request.headers.get("x-ai-cost-confirmed") === "true" };
}
