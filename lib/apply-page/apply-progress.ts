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

/** Single place that maps a run to a step from READY on. Task 16 extends this. */
function stepFromRun(run: NonNullable<ApplyProgressInput["run"]>): AssistedApplyStepNumber {
  void run;
  return 5;
}

function currentStep(input: ApplyProgressInput): AssistedApplyStepNumber {
  if (!input.hasMasterResume || !input.hasCurrentMatch) return 1;
  if (!input.reviewSaved) return 2;
  if (!(input.resumeAttached && (input.coverAttached || !input.coverRequired))) return 3;
  if (input.run?.state !== "READY") return 4;
  return stepFromRun(input.run);
}

export function deriveApplyProgress(input: ApplyProgressInput): ApplyProgress {
  if (input.applied) {
    return {
      current: 10,
      steps: ASSISTED_APPLY_STEP_NUMBERS.map((number) => ({
        number,
        name: ASSISTED_APPLY_STEP_NAMES[number],
        state: "done" as const,
      })),
      now: "You applied. Nothing left to do.",
      next: null,
    };
  }
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
      : NOW_TEXT[current],
    next: nextNumber ? ASSISTED_APPLY_STEP_NAMES[nextNumber] : null,
  };
}
