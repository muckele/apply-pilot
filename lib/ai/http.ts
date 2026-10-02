import type { NextRequest } from "next/server";

export function aiInvocationFromRequest(request: NextRequest): {
  highCostConfirmed: boolean;
  dataSharingConfirmed?: boolean;
} {
  return {
    highCostConfirmed: request.headers.get("x-ai-cost-confirmed") === "true",
    dataSharingConfirmed: request.headers.get("x-ai-data-confirmed") === "true"
  };
}
