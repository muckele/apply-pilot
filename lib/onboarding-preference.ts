import { createHash } from "node:crypto";

/**
 * "Hide for now" for the dashboard onboarding checklist, stored in a cookie so
 * no schema change is needed. The value is a hash bound to the user id, so a
 * second account signing in on the same browser still sees its own checklist
 * and the raw id never lands in the cookie.
 */
export const ONBOARDING_HIDDEN_COOKIE = "apply-pilot-onboarding-hidden";
export const ONBOARDING_HIDE_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

export function onboardingHiddenCookieValue(userId: string): string {
  return createHash("sha256").update(`apply-pilot:onboarding-hidden:${userId}`).digest("hex").slice(0, 32);
}

export function isOnboardingHiddenForUser(cookieValue: string | null | undefined, userId: string): boolean {
  return Boolean(cookieValue) && cookieValue === onboardingHiddenCookieValue(userId);
}

export function onboardingHiddenCookieOptions(nodeEnv: string | undefined = process.env.NODE_ENV) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: nodeEnv === "production",
    path: "/dashboard",
    maxAge: ONBOARDING_HIDE_MAX_AGE_SECONDS
  };
}
