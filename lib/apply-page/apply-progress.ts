import {
  ASSISTED_APPLY_STEP_NAMES,
  ASSISTED_APPLY_STEP_NUMBERS,
  type AssistedApplyStepNumber,
} from "@/lib/assisted-apply/control-steps";

export type ApplyProgressInput = {
  hasMasterResume: boolean;
  /** The job has a shown fit estimate (any basis). */
  hasCurrentMatch: boolean;
  /** That estimate is bound to the user's saved review (basis REVIEWED_EVIDENCE). */
  reviewSaved: boolean;
  resumeAttached: boolean;
  coverAttached: boolean;
  coverRequired: boolean;
  /** Carried for later tasks. */
  automationAvailable: boolean;
  run: { state: string; companionState: string | null } | null;
  applied: boolean;
};

export type ApplyProgress = {
  current: AssistedApplyStepNumber;
  steps: Array<{ number: AssistedApplyStepNumber; name: string; state: "done" | "now" | "later" }>;
  now: string;
  next: string | null;
};

const BROWSER_NOW = "Continue in the Apply Pilot browser window.";

const NOW_TEXT: Record<AssistedApplyStepNumber, string> = {
  1: "Check my match",
  2: "Write a line for anything your résumé doesn't show, then Update my score",
  3: "Write my résumé and cover letter, review them",
  4: "Fix anything on the ready list, then Allow and prepare",
  5: BROWSER_NOW,
  6: BROWSER_NOW,
  7: BROWSER_NOW,
  8: BROWSER_NOW,
  9: "Complete the rest and press the employer's Submit yourself.",
  10: "Confirm what you sent.",
};

const STOPPED_NOW = "This application was stopped. Prepare it again to start over.";

// Runs that are prepared or further along. CANCELLED is handled before this (it sends the user back to step 4).
const PREPARED_STATES: ReadonlySet<string> = new Set([
  "READY",
  "REVIEW_REQUIRED",
  "FILLING",
  "READY_FOR_USER_SUBMISSION",
  "COMPLETED_BY_USER"
]);

/**
 * Single place that maps a prepared run to a step (5 to 9). The run endpoint reports the run state
 * but not the form inspection or the review answers, so READY and REVIEW_REQUIRED cannot tell
 * "form read, answers awaiting approval" (7) or "review resolved" (8) from "form not opened" (5/6):
 * they take the earlier step. A companion state, when one is supplied, moves it forward.
 */
function stepFromRun(run: NonNullable<ApplyProgressInput["run"]>): AssistedApplyStepNumber {
  if (run.state === "READY_FOR_USER_SUBMISSION" || run.companionState === "HUMAN_ONLY") return 9;
  if (run.state === "FILLING" || run.companionState === "HANDOFF_PENDING") return 8;
  switch (run.companionState) {
    case "CONTROL_READY":
    case "OPENING_TARGET":
    case "TARGET_OPEN":
      return 6;
    default:
      return 5;
  }
}

function currentStep(input: ApplyProgressInput): AssistedApplyStepNumber {
  if (!input.hasMasterResume || !input.hasCurrentMatch) return 1;
  if (!input.reviewSaved) return 2;
  if (!(input.resumeAttached && (input.coverAttached || !input.coverRequired))) return 3;
  if (!input.run || !PREPARED_STATES.has(input.run.state)) return 4;
  return stepFromRun(input.run);
}

function allDone(now: string): ApplyProgress {
  return {
    current: 10,
    steps: ASSISTED_APPLY_STEP_NUMBERS.map((number) => ({
      number,
      name: ASSISTED_APPLY_STEP_NAMES[number],
      state: "done" as const,
    })),
    now,
    next: null,
  };
}

export function deriveApplyProgress(input: ApplyProgressInput): ApplyProgress {
  if (input.applied) return allDone("You applied. Nothing left to do.");
  if (input.run?.state === "COMPLETED_BY_USER") return allDone("You applied. Nothing left to do.");
  const current = currentStep(input);
  const nextNumber = ASSISTED_APPLY_STEP_NUMBERS.find((n) => n === current + 1);
  return {
    current,
    steps: ASSISTED_APPLY_STEP_NUMBERS.map((number) => ({
      number,
      name: ASSISTED_APPLY_STEP_NAMES[number],
      state: number < current ? ("done" as const) : number === current ? ("now" as const) : ("later" as const),
    })),
    now: !input.hasMasterResume
      ? "Add your master résumé first, so Apply Pilot can check your match."
      : current === 4 && input.run?.state === "CANCELLED"
        ? STOPPED_NOW
        : NOW_TEXT[current],
    next: nextNumber ? ASSISTED_APPLY_STEP_NAMES[nextNumber] : null,
  };
}
