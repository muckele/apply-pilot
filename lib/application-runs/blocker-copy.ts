import type { PreparationBlockingReason } from "@/lib/application-runs/preparation";

export type ReadyFix = {
  label: string;
  target: "step-1" | "step-2" | "step-3" | "turn-off-fill" | "settings-ai" | "retry";
};

// Plain-language reason a run is blocked, plus where the user can fix it (null when the
// text itself says what to do or nothing on the page can help).
export const PREPARE_BLOCKER_COPY: Record<PreparationBlockingReason, { text: string; fix: ReadyFix | null }> = {
  automation_disabled: { text: "Application automation is disabled by the current policy.", fix: null },
  automation_disabled_during_preparation: { text: "Application automation was disabled during preparation.", fix: null },
  host_blocked: { text: "The run's target host is blocked by the current policy.", fix: null },
  fit_below_threshold: {
    text: "The job's current fit score does not meet the existing policy threshold.",
    fix: { label: "Go to step 1", target: "step-1" }
  },
  match_confidence_below_threshold: {
    text: "The job's current match confidence does not meet the existing policy threshold.",
    fix: { label: "Go to step 1", target: "step-1" }
  },
  resume_required: {
    text: "An eligible tailored resume must be explicitly assigned to this application in the job packet.",
    fix: { label: "Go to step 3", target: "step-3" }
  },
  cover_letter_required: {
    text: "An eligible cover letter must be explicitly assigned to this application in the job packet.",
    fix: { label: "Go to step 3", target: "step-3" }
  },
  daily_application_cap_reached: {
    text: "The daily preparation cap has been reached.",
    fix: { label: "Try later", target: "retry" }
  },
  ai_budget_exceeded: { text: "The existing AI budget does not permit preparation.", fix: null },
  ai_request_cost_limit: { text: "This planner request exceeds the existing per-request cost limit.", fix: null },
  ai_cost_confirmation_required: {
    text: "Preparation requires a separate AI cost confirmation. No additional planner request was sent.",
    fix: null
  },
  ai_duplicate_in_progress: {
    text: "Another planner request is in progress. Review the run state before deciding whether to retry.",
    fix: { label: "Try again", target: "retry" }
  }
};
