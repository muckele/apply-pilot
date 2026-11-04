"use server";

import { cookies } from "next/headers";

import {
  ONBOARDING_HIDDEN_COOKIE,
  onboardingHiddenCookieOptions,
  onboardingHiddenCookieValue
} from "@/lib/onboarding-preference";
import { requirePageUserId } from "@/lib/page-context";

export async function hideOnboardingChecklist() {
  const userId = await requirePageUserId();
  const cookieStore = await cookies();
  cookieStore.set(ONBOARDING_HIDDEN_COOKIE, onboardingHiddenCookieValue(userId), onboardingHiddenCookieOptions());
}

export async function showOnboardingChecklist() {
  await requirePageUserId();
  const cookieStore = await cookies();
  cookieStore.delete({ name: ONBOARDING_HIDDEN_COOKIE, path: onboardingHiddenCookieOptions().path });
}
