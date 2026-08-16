import { z } from "zod";

import { PublicApiError } from "@/lib/api-errors";
import { canonicalizePolicyHostEntry } from "@/lib/application-runs/host-policy";

// Mirrors the Prisma ApplicationAutomationPolicy defaults exactly. A unit test guards
// this constant against dual-source drift with prisma/schema.prisma.
export const AUTOMATION_POLICY_DEFAULTS = {
  enabled: false,
  mode: "PREPARE_ONLY",
  minimumFitScore: 85,
  minimumConfidenceScore: 85,
  dailyApplicationCap: 5,
  allowedHosts: [] as string[],
  blockedHosts: [] as string[],
  permittedAdapters: [] as string[],
  coverLetterRequired: true,
  sensitiveAnswerPolicy: "EXCLUDE",
  finalReviewRequired: true
} as const;

// ---------------------------------------------------------------------------
// Global feature gate + per-user capability
// ---------------------------------------------------------------------------

// Minimal environment view: callers and tests may provide only the variables being
// inspected instead of the full augmented ProcessEnv (which Next.js extends with a
// required NODE_ENV).
export type AutomationEnv = Readonly<Record<string, string | undefined>>;

// Only the exact string "true" enables the global gate. Everything else — undefined,
// "false", "1", "TRUE", "yes", " true " — fails closed.
export function isApplicationAutomationEnabled(env: AutomationEnv = process.env): boolean {
  return env.APPLICATION_AUTOMATION_ENABLED === "true";
}

// Effective capability requires BOTH the global flag and the per-user policy switch.
export function isAutomationAllowed(policy: { enabled: boolean }, env: AutomationEnv = process.env): boolean {
  return isApplicationAutomationEnabled(env) && policy.enabled;
}

// CAPABILITY-INCREASING OPERATIONS ONLY (create run, prepare, future token issuance,
// future fill). Safety/recovery operations — reading runs/policy, PATCH policy, cancel,
// token revocation, answer review — must never call this guard, so automation stays
// recoverable while disabled.
export function assertAutomationCapability(
  policy: { enabled: boolean },
  env: AutomationEnv = process.env
): void {
  if (!isAutomationAllowed(policy, env)) {
    throw new PublicApiError("Application automation is disabled.", 403, { code: "AUTOMATION_DISABLED" });
  }
}

// ---------------------------------------------------------------------------
// Fail-closed policy patch validation
// ---------------------------------------------------------------------------

// Score domain follows the established job-match range (0–100, see lib/ai/job-match.ts).
// The daily cap range follows the existing bounded-int convention used for
// maxAnalysesPerSync (0–25) in the AI settings route.
const scoreSchema = z.number().int().min(0).max(100);

export const applicationAutomationPolicyPatchSchema = z
  .object({
    enabled: z.boolean().optional(),
    mode: z.literal("PREPARE_ONLY").optional(),
    minimumFitScore: scoreSchema.optional(),
    minimumConfidenceScore: scoreSchema.optional(),
    dailyApplicationCap: z.number().int().min(0).max(25).optional(),
    allowedHosts: z.array(z.string().max(253)).max(50).optional(),
    blockedHosts: z.array(z.string().max(253)).max(50).optional(),
    permittedAdapters: z.array(z.string().regex(/^[a-z0-9-]{1,64}$/)).max(25).optional(),
    coverLetterRequired: z.boolean().optional(),
    sensitiveAnswerPolicy: z.literal("EXCLUDE").optional(),
    finalReviewRequired: z.literal(true).optional() // false is rejected outright
  })
  .strict();

export type ApplicationAutomationPolicyPatch = z.infer<typeof applicationAutomationPolicyPatchSchema>;

// Parses and canonicalizes a policy patch. Host entries are canonicalized with the
// hostname-only rules (no wildcards, URLs, userinfo, ports, IP literals, or local
// targets) and deduplicated; any invalid entry fails closed with 422.
export function parseAutomationPolicyPatch(input: unknown): ApplicationAutomationPolicyPatch {
  const parsed = applicationAutomationPolicyPatchSchema.parse(input);
  for (const field of ["allowedHosts", "blockedHosts"] as const) {
    const entries = parsed[field];
    if (!entries) continue;
    const canonical = entries.map((entry) => {
      const host = canonicalizePolicyHostEntry(entry);
      if (host === null) {
        throw new PublicApiError(`Invalid ${field} entry: ${entry}.`, 422, {
          code: "AUTOMATION_POLICY_INVALID"
        });
      }
      return host;
    });
    parsed[field] = [...new Set(canonical)];
  }
  return parsed;
}
