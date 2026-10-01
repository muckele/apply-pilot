import type { DiscoveryScoringStopReason, DiscoveryScoringSummary } from "@/lib/job-sources/discovery";

const stopReasonMessages: Record<DiscoveryScoringStopReason, string> = {
  NOT_REQUESTED: "Scoring was not requested for this discovery run.",
  DISABLED_BY_POLICY: "Scoring is disabled by your AI discovery settings.",
  LIMIT_ZERO: "Scoring stopped because the per-run analysis limit is zero.",
  AI_UNAVAILABLE: "Remaining attempts stopped because AI scoring is unavailable.",
  AI_CONFIGURATION_INVALID: "Remaining attempts stopped because AI scoring is not configured correctly.",
  AI_BUDGET_EXCEEDED: "Remaining attempts stopped because the automation budget was exhausted."
};

export function formatDiscoveryScoringSummary(summary: DiscoveryScoringSummary) {
  const cached = summary.cached ? ` (${summary.cached} cached)` : "";
  const failed = summary.failed
    ? `${summary.failed} failed`
    : "0 failed";
  const stop = summary.stopReason ? ` ${stopReasonMessages[summary.stopReason]}` : "";

  return `AI scoring: ${summary.eligible} eligible, ${summary.attempted} attempted, ${summary.scored} scored${cached}, ${failed}.${stop}`;
}
