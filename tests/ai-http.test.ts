import assert from "node:assert/strict";
import test from "node:test";
import type { NextRequest } from "next/server";

import { aiInvocationFromRequest } from "@/lib/ai/http";

test("AI invocation headers require exact affirmative cost and data grants", () => {
  const confirmed = aiInvocationFromRequest(new Request("https://app.example.test/api/resumes/parse", {
    headers: {
      "x-ai-cost-confirmed": "true",
      "x-ai-data-confirmed": "true"
    }
  }) as NextRequest);
  assert.deepEqual(confirmed, { highCostConfirmed: true, dataSharingConfirmed: true });

  const denied = aiInvocationFromRequest(new Request("https://app.example.test/api/resumes/parse", {
    headers: {
      "x-ai-cost-confirmed": "TRUE",
      "x-ai-data-confirmed": "yes"
    }
  }) as NextRequest);
  assert.deepEqual(denied, { highCostConfirmed: false, dataSharingConfirmed: false });
});
