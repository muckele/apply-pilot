import type { PreparationBlockingReason, PreparationErrorCategory } from "@/lib/application-runs/preparation";

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
    text: "This application needs a résumé that's ready to use. Write or choose one in step 3.",
    fix: { label: "Go to step 3", target: "step-3" }
  },
  cover_letter_required: {
    text: "This application needs a cover letter that's ready to use. Write or choose one in step 3.",
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

// Why a FAILED run failed, by its error category. A failed run can be prepared again.
export const PREPARE_FAILURE_COPY: Record<PreparationErrorCategory, string> = {
  planner_input_invalid: "Preparation failed because the bounded planner input was invalid.",
  planner_output_invalid: "Preparation failed because the planner output was invalid.",
  planner_confidence_invalid: "Preparation failed because the planner confidence was invalid.",
  planner_provider_failure: "Preparation failed while building the application plan.",
  ai_provider_usage_exceeded_reservation: "Preparation failed because provider usage exceeded its reservation."
};
