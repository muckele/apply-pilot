/**
 * First-run onboarding checklist (MVP Bible WP1.2).
 *
 * Pure derivation only: every step is computed from data the account already
 * has, so there is no onboarding table and nothing to migrate. The server
 * loader (`lib/onboarding-loader.ts`) gathers the signals; this module decides
 * what they mean.
 *
 * "Done" definitions:
 * 1. master-resume     - a Resume with isMaster = true and a non-null parsedAt.
 * 2. profile           - a UserProfile with at least one non-blank preferredRoles
 *                        entry AND somewhere to work: a non-blank location, a
 *                        non-blank preferredLocations entry, or remotePreference
 *                        REMOTE. These are the fields discovery and job match
 *                        fall back to, and the UserProfile row only exists after
 *                        the user saves the profile form.
 * 3. job-preferences   - a JobDiscoveryPreference with at least one non-blank
 *                        targetSearches entry (target searches hold both free
 *                        queries and target role titles).
 * 4. first-matches     - at least one JobPosting owned by the user.
 * 5. first-application - at least one Application owned by the user (any status;
 *                        saving a job counts as tracking it).
 */

export const ONBOARDING_STEP_IDS = [
  "master-resume",
  "profile",
  "job-preferences",
  "first-matches",
  "first-application"
] as const;

export type OnboardingStepId = (typeof ONBOARDING_STEP_IDS)[number];

export type OnboardingStepStatus = "complete" | "next" | "pending";

export type OnboardingSignals = {
  parsedMasterResumeCount: number;
  profileReviewed: boolean;
  jobPreferencesSet: boolean;
  jobPostingCount: number;
  applicationCount: number;
};

export type OnboardingStep = {
  id: OnboardingStepId;
  number: number;
  title: string;
  description: string;
  href: string;
  actionLabel: string;
  status: OnboardingStepStatus;
};

export type OnboardingChecklist = {
  steps: readonly OnboardingStep[];
  completedCount: number;
  totalCount: number;
  nextStep: OnboardingStep | null;
  isComplete: boolean;
};

export type OnboardingChecklistDisplay = "full" | "collapsed" | "none";

export type OnboardingProfileFields = {
  location?: string | null;
  preferredRoles?: readonly string[] | null;
  preferredLocations?: readonly string[] | null;
  remotePreference?: string | null;
} | null | undefined;

export type OnboardingJobPreferenceFields = {
  targetSearches?: readonly string[] | null;
} | null | undefined;

type OnboardingStepDefinition = Omit<OnboardingStep, "number" | "status"> & {
  isComplete: (signals: OnboardingSignals) => boolean;
};

function hasPositiveCount(value: number) {
  return Number.isFinite(value) && value >= 1;
}

function hasText(value: string | null | undefined) {
  return typeof value === "string" && value.trim().length > 0;
}

function hasAnyText(values: readonly string[] | null | undefined) {
  return Array.isArray(values) && values.some((value) => hasText(value));
}

const STEP_DEFINITIONS: readonly OnboardingStepDefinition[] = [
  {
    id: "master-resume",
    title: "Upload your master resume",
    description: "Upload a PDF, DOCX or TXT file, or paste the text. Apply Pilot parses it into the facts your tailored documents may use.",
    href: "/resumes",
    actionLabel: "Upload resume",
    isComplete: (signals) => hasPositiveCount(signals.parsedMasterResumeCount)
  },
  {
    id: "profile",
    title: "Review your profile",
    description: "Add at least one preferred role and where you want to work: a location, preferred locations, or a remote work style.",
    href: "/settings/profile",
    actionLabel: "Review profile",
    isComplete: (signals) => signals.profileReviewed === true
  },
  {
    id: "job-preferences",
    title: "Set job preferences",
    description: "Save at least one target search in Automated discovery so Apply Pilot knows which roles to look for.",
    href: "/jobs",
    actionLabel: "Set preferences",
    isComplete: (signals) => signals.jobPreferencesSet === true
  },
  {
    id: "first-matches",
    title: "See your first matches",
    description: "Run discovery, or import a job you found yourself, to bring your first jobs into Apply Pilot.",
    href: "/jobs",
    actionLabel: "Find jobs",
    isComplete: (signals) => hasPositiveCount(signals.jobPostingCount)
  },
  {
    id: "first-application",
    title: "Track your first application",
    description: "Save a job, or mark one as applied, to start tracking it in Applications.",
    href: "/jobs",
    actionLabel: "Track a job",
    isComplete: (signals) => hasPositiveCount(signals.applicationCount)
  }
];

export function isOnboardingProfileReviewed(profile: OnboardingProfileFields): boolean {
  if (!profile) return false;
  const hasTargetRole = hasAnyText(profile.preferredRoles);
  const hasWorkLocation =
    hasText(profile.location) ||
    hasAnyText(profile.preferredLocations) ||
    profile.remotePreference === "REMOTE";
  return hasTargetRole && hasWorkLocation;
}

export function hasOnboardingJobPreferences(preference: OnboardingJobPreferenceFields): boolean {
  return Boolean(preference) && hasAnyText(preference?.targetSearches);
}

export function buildOnboardingChecklist(signals: OnboardingSignals): OnboardingChecklist {
  let nextAssigned = false;
  const steps = STEP_DEFINITIONS.map(({ isComplete, ...definition }, index): OnboardingStep => {
    let status: OnboardingStepStatus = "pending";
    if (isComplete(signals)) {
      status = "complete";
    } else if (!nextAssigned) {
      status = "next";
      nextAssigned = true;
    }
    return { ...definition, number: index + 1, status };
  });
  const completedCount = steps.filter((step) => step.status === "complete").length;

  return {
    steps,
    completedCount,
    totalCount: steps.length,
    nextStep: steps.find((step) => step.status === "next") ?? null,
    isComplete: completedCount === steps.length
  };
}

export function resolveOnboardingChecklistDisplay(
  checklist: Pick<OnboardingChecklist, "isComplete">,
  { hidden }: { hidden: boolean }
): OnboardingChecklistDisplay {
  if (checklist.isComplete) return "none";
  return hidden ? "collapsed" : "full";
}
