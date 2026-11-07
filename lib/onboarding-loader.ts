import type { Prisma } from "@prisma/client";

import {
  ONBOARDING_APPLIED_STATUSES,
  buildOnboardingChecklist,
  hasOnboardingJobPreferences,
  isOnboardingProfileReviewed,
  type OnboardingChecklist
} from "@/lib/onboarding";
import { prisma } from "@/lib/prisma";

const ONBOARDING_PROFILE_SELECT = {
  location: true,
  preferredRoles: true,
  preferredLocations: true,
  remotePreference: true
} as const satisfies Prisma.UserProfileSelect;

const ONBOARDING_JOB_PREFERENCE_SELECT = {
  targetSearches: true
} as const satisfies Prisma.JobDiscoveryPreferenceSelect;

/**
 * Reads the onboarding signals for one signed-in user. Every query is scoped
 * to `userId`; the counts use `take: 1` because a step only needs to know
 * whether at least one row exists.
 */
export async function loadOnboardingChecklist(userId: string): Promise<OnboardingChecklist> {
  const [parsedMasterResumeCount, profile, discoveryPreference, jobPostingCount, appliedApplicationCount] = await Promise.all([
    prisma.resume.count({ where: { userId, isMaster: true, parsedAt: { not: null } }, take: 1 }),
    prisma.userProfile.findUnique({ where: { userId }, select: ONBOARDING_PROFILE_SELECT }),
    prisma.jobDiscoveryPreference.findUnique({ where: { userId }, select: ONBOARDING_JOB_PREFERENCE_SELECT }),
    prisma.jobPosting.count({ where: { userId }, take: 1 }),
    prisma.application.count({
      where: {
        userId,
        OR: [{ dateApplied: { not: null } }, { status: { in: [...ONBOARDING_APPLIED_STATUSES] } }]
      },
      take: 1
    })
  ]);

  return buildOnboardingChecklist({
    parsedMasterResumeCount,
    profileReviewed: isOnboardingProfileReviewed(profile),
    jobPreferencesSet: hasOnboardingJobPreferences(discoveryPreference),
    jobPostingCount,
    appliedApplicationCount
  });
}
