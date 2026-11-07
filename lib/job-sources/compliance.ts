import type { JobSourceType } from "@prisma/client";

/**
 * Sources whose terms need a compliance decision before Apply Pilot may use them (MVP Bible §6).
 * They stay off unless the deployment sets the flag to exactly "true".
 *
 * - Remotive: its API terms prohibit showing its jobs to collect sign-ups and limit fetches.
 * - Adzuna: a commercial licence is required after the 14-day trial for revenue-generating use.
 */
const complianceFlags: Partial<Record<JobSourceType, { flag: string; reason: string }>> = {
  REMOTIVE: {
    flag: "JOB_SOURCE_REMOTIVE_ENABLED",
    reason: "Remotive's API terms prohibit sign-up-gated display of its jobs."
  },
  ADZUNA: {
    flag: "JOB_SOURCE_ADZUNA_ENABLED",
    reason: "Adzuna requires a commercial licence for revenue-generating products."
  }
};

type Env = Record<string, string | undefined>;

export function isSourceTypeComplianceEnabled(type: JobSourceType, env: Env = process.env) {
  const gate = complianceFlags[type];
  return !gate || env[gate.flag]?.trim().toLowerCase() === "true";
}

export function complianceDisabledSourceTypes(env: Env = process.env) {
  return (Object.keys(complianceFlags) as JobSourceType[]).filter((type) => !isSourceTypeComplianceEnabled(type, env));
}

export function complianceDisabledMessage(type: JobSourceType) {
  const gate = complianceFlags[type];
  return gate
    ? `${type} is disabled pending compliance review. ${gate.reason} Set ${gate.flag}=true only after that review.`
    : `${type} is not compliance-gated.`;
}

export function assertSourceTypeComplianceEnabled(type: JobSourceType, env: Env = process.env) {
  if (!isSourceTypeComplianceEnabled(type, env)) {
    throw new Error(complianceDisabledMessage(type));
  }
}
