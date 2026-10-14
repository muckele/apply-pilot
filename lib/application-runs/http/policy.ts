import { NextRequest, NextResponse } from "next/server";

import { automationPolicyPatchContract } from "@/lib/application-runs/contracts";
import {
  readAutomationPolicy,
  updateAutomationPolicy
} from "@/lib/application-runs/service";
import { checkRateLimit } from "@/lib/security/rate-limit";
import { apiErrorResponse, requireUserId } from "@/lib/user-context";

const NO_STORE = { "Cache-Control": "no-store" } as const;

type PolicyRouteDependencies = {
  requireUserId: typeof requireUserId;
  checkRateLimit: typeof checkRateLimit;
  readAutomationPolicy: typeof readAutomationPolicy;
  updateAutomationPolicy: typeof updateAutomationPolicy;
};

export function createApplicationAutomationPolicyRouteHandlers(
  dependencies: PolicyRouteDependencies
) {
  return {
    async GET() {
      try {
        const userId = await dependencies.requireUserId();
        await dependencies.checkRateLimit(`application-automation-policy:read:${userId}`, 60, 60_000);
        const policy = await dependencies.readAutomationPolicy(userId);
        return NextResponse.json(policy, { headers: NO_STORE });
      } catch (error) {
        const response = apiErrorResponse(error);
        response.headers.set("Cache-Control", "no-store");
        return response;
      }
    },

    async PATCH(request: NextRequest) {
      try {
        const userId = await dependencies.requireUserId();
        const patch = automationPolicyPatchContract.parse(await request.json());
        await dependencies.checkRateLimit(`application-automation-policy:update:${userId}`, 20, 60_000);
        const policy = await dependencies.updateAutomationPolicy(userId, patch);
        return NextResponse.json(policy, { headers: NO_STORE });
      } catch (error) {
        const response = apiErrorResponse(error);
        response.headers.set("Cache-Control", "no-store");
        return response;
      }
    }
  };
}

const handlers = createApplicationAutomationPolicyRouteHandlers({
  requireUserId,
  checkRateLimit,
  readAutomationPolicy,
  updateAutomationPolicy
});

export const GET = handlers.GET;
export const PATCH = handlers.PATCH;
