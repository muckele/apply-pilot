import { exchangeCompanionSignInCode } from "@/lib/companion-sign-in";
import { createCompanionSignInExchangeRoute } from "@/lib/companion-sign-in-routes";
import { companionSignInDependencies } from "@/lib/companion-sign-in-store";
import { writeAuditLog } from "@/lib/security/audit-log";
import { checkRateLimit } from "@/lib/security/rate-limit";

const handlers = createCompanionSignInExchangeRoute({
  checkRateLimit,
  writeAuditLog,
  exchange: (input) => exchangeCompanionSignInCode(input, companionSignInDependencies)
});

export const POST = handlers.POST;
