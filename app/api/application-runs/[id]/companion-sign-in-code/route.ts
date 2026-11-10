import { issueCompanionSignInCode } from "@/lib/companion-sign-in";
import { createIssueCompanionSignInCodeRoute } from "@/lib/companion-sign-in-routes";
import { companionSignInDependencies } from "@/lib/companion-sign-in-store";
import { writeAuditLog } from "@/lib/security/audit-log";
import { checkRateLimit } from "@/lib/security/rate-limit";
import { requireUserId } from "@/lib/user-context";

const handlers = createIssueCompanionSignInCodeRoute({
  requireUserId,
  checkRateLimit,
  writeAuditLog,
  issue: (input) => issueCompanionSignInCode(input, companionSignInDependencies)
});

export const POST = handlers.POST;
