import type { ApplicationRunState } from "@prisma/client";

import type { ControlConnection, PendingBrowserCommand } from "@/lib/application-browser/control-presentation";
import type { FillStatusDisplayCategory } from "@/lib/application-browser/fill-status-presentation";
import type {
  B1WorkflowState,
  B2InspectionCommandStatus,
  B3FillCommandStatus
} from "@/lib/application-browser/types";
import { safeStopLabel } from "@/lib/assisted-apply/plain-language";

// The control page as the guide's steps 4–8 (redesign §5.1, §5.2, W6–W9).
// Presentation only: this decides which step is "now", which one button is primary and why a
// button is disabled. Every permission is still decided by the gates in
// lib/application-browser/control-presentation.ts and, after that, by the companion and server.

export const ASSISTED_APPLY_STEP_NAMES = {
  1: "Check you're ready",
  2: "Prepare",
  3: "Open the Apply Pilot browser",
  4: "Open the employer's form",
  5: "Check the answers",
  6: "Fill",
  7: "Finish and submit",
  8: "Record it"
} as const;

export type AssistedApplyStepNumber = keyof typeof ASSISTED_APPLY_STEP_NAMES;
export type ControlStepNumber = 4 | 5 | 6 | 7 | 8;
export type StepProgress = "done" | "now" | "later";

export const ASSISTED_APPLY_STEP_NUMBERS: readonly AssistedApplyStepNumber[] = [1, 2, 3, 4, 5, 6, 7, 8];
export const CONTROL_STEP_NUMBERS: readonly ControlStepNumber[] = [4, 5, 6, 7, 8];

export type ControlStepAction =
  | "OPEN_AND_READ"
  | "READ_FORM"
  | "CONTINUE_REVIEW"
  | "FILL"
  | "UNLOCK"
  | "CONFIRM_UNLOCK"
  | "RECORD"
  | "CONFIRM_RECORD"
  | "CHECK_RECORD";

export const CONTROL_STEP_ACTIONS: readonly ControlStepAction[] = [
  "OPEN_AND_READ",
  "READ_FORM",
  "CONTINUE_REVIEW",
  "FILL",
  "UNLOCK",
  "CONFIRM_UNLOCK",
  "RECORD",
  "CONFIRM_RECORD",
  "CHECK_RECORD"
];

export type ControlStepInput = Readonly<{
  companion: Readonly<{
    hasStatus: boolean;
    connection: ControlConnection;
    state: B1WorkflowState;
    errorCode: string | null;
    inspection: B2InspectionCommandStatus | null;
    formInvalidated: boolean;
    fillCommand: B3FillCommandStatus | null;
    // The form was handed over to the user earlier on this page (it may since have closed).
    handedOverEarlier: boolean;
    humanMinutesRemaining: number | null;
    // From browserCommandAvailability: the companion would accept these commands now.
    canOpenTarget: boolean;
    canInspectForm: boolean;
    canHandOff: boolean;
    pendingCommand: PendingBrowserCommand;
  }>;
  review: Readonly<{
    phase: "idle" | "loading" | "loaded" | "error";
    verified: boolean;
    runState: ApplicationRunState | null;
    packet: Readonly<{
      inspectionVersion: number;
      answerPacketVersion: number;
      reviewedAt: string | null;
      fieldCount: number;
      proposableCount: number;
      pendingReviewCount: number;
      readyForRunResolution: boolean;
    }> | null;
    pendingMutation: boolean;
    // The one approval click (D-H) is sending its reviews.
    approving: boolean;
    // Trusted answers still waiting for review (the click's own requests keep their gates).
    approveEligible: boolean;
  }>;
  fill: Readonly<{
    phase: "idle" | "loading" | "loaded" | "error";
    verified: boolean;
    category: FillStatusDisplayCategory | null;
    // apparentAutomatableFieldCount: approved answers Fill could type.
    fillableCount: number;
    // isFillActivationEligible, unchanged.
    activationEligible: boolean;
    acknowledged: boolean;
    pendingActivation: boolean;
    mayHaveDispatched: boolean;
    packetCurrent: boolean;
  }>;
  handoff: Readonly<{ eligible: boolean; confirming: boolean }>;
  record: Readonly<{
    // isPersonalSubmissionCompletionEligible, unchanged.
    eligible: boolean;
    recorded: boolean;
    phase: "idle" | "confirming" | "pending" | "confirmed" | "uncertain";
    runVerified: boolean;
  }>;
  // Fill or a submission record is in flight: every other control waits.
  uiLocked: boolean;
}>;

export type ControlActionState = Readonly<{
  label: string;
  enabled: boolean;
  // One plain line saying why the button is disabled (null when enabled).
  reason: string | null;
}>;

export type ControlStepsView = Readonly<{
  // The step shown as the "Now" card. null only when the application was stopped.
  current: ControlStepNumber | null;
  finished: "RECORDED" | "STOPPED" | null;
  progress: Readonly<Record<AssistedApplyStepNumber, StepProgress>>;
  heading: string;
  sentence: string;
  next: string;
  primary: Readonly<{ action: ControlStepAction; step: ControlStepNumber }> | null;
  actions: Readonly<Record<ControlStepAction, ControlActionState>>;
  // Where "I personally submitted this application" is shown: in step 7 once the form is
  // handed over (W8), otherwise in step 8.
  recordEntryStep: 7 | 8;
}>;

const OPENABLE_RUN_STATES: ReadonlySet<ApplicationRunState> = new Set(["READY", "REVIEW_REQUIRED"]);
const FILL_USED_CATEGORIES: ReadonlySet<FillStatusDisplayCategory> = new Set([
  "COMPLETED",
  "STOPPED_EARLY",
  "RECOVERED_AFTER_LOSS",
  "ATTEMPT_CONSUMED",
  "CANCELLED"
]);
const LEAVE_WARNING_STATES: ReadonlySet<B1WorkflowState> = new Set([
  "OPENING_TARGET",
  "TARGET_OPEN",
  "HANDOFF_PENDING",
  "HUMAN_ONLY"
]);

// While the employer's form is opening, open or handed over, leaving this page closes it.
export function shouldWarnBeforeLeaving(input: Readonly<{ hasStatus: boolean; state: B1WorkflowState }>): boolean {
  return input.hasStatus && LEAVE_WARNING_STATES.has(input.state);
}

export function stepHeading(step: AssistedApplyStepNumber): string {
  return `Step ${step} of 8 · ${ASSISTED_APPLY_STEP_NAMES[step]}`;
}

export function controlPageTitle(view: ControlStepsView, hasStatus: boolean): string {
  if (view.finished === "RECORDED") return "Apply Pilot browser: Done";
  if (view.finished === "STOPPED") return "Apply Pilot browser: Stopped";
  if (!hasStatus || view.current === null) return "Apply Pilot browser: Connecting…";
  return `Apply Pilot browser: Step ${view.current}, ${ASSISTED_APPLY_STEP_NAMES[view.current]}`;
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

// The one approval button names exactly how many ticked answers it approves (D-H).
export function approveButtonLabel(tickedCount: number, proposedCount: number): string {
  if (proposedCount === 0) return "Continue";
  if (tickedCount === 0) return "Approve none and continue";
  if (tickedCount === 1) return "Approve this 1 and continue";
  return `Approve these ${tickedCount} and continue`;
}

export function fillButtonLabel(fillableCount: number): string {
  return `Fill ${fillableCount} ${plural(fillableCount, "field", "fields")} (runs once)`;
}

type Facts = Readonly<{
  formOpen: boolean;
  handedOver: boolean;
  stopped: boolean;
  formRead: boolean;
  answersMatchReading: boolean;
  reviewed: boolean;
  fillRunning: boolean;
  fillUsed: boolean;
  runOpenable: boolean;
}>;

function deriveFacts(input: ControlStepInput): Facts {
  const { companion, review, fill } = input;
  const live = companion.hasStatus;
  const formOpen = live && companion.state === "TARGET_OPEN";
  const inspection = companion.inspection;
  const formRead = formOpen &&
    inspection?.outcome === "SUCCEEDED" &&
    !inspection.reinspectionRequired &&
    !companion.formInvalidated;
  const packet = review.packet;
  const answersMatchReading = formRead &&
    packet !== null &&
    inspection?.outcome === "SUCCEEDED" &&
    packet.inspectionVersion === inspection.inspectionVersion &&
    packet.answerPacketVersion === inspection.answerPacketVersion;
  const fillCommand = companion.fillCommand?.outcome ?? null;
  const fillRunning = fill.pendingActivation ||
    fill.category === "FILLING" ||
    fill.category === "RECOVERY_PENDING" ||
    fill.category === "UNAVAILABLE" ||
    review.runState === "FILLING" ||
    fillCommand === "IN_PROGRESS" ||
    fillCommand === "RECOVERY_PENDING" ||
    (fill.mayHaveDispatched && !fill.verified);
  const fillUsed = !fillRunning && (
    (fill.category !== null && FILL_USED_CATEGORIES.has(fill.category)) ||
    review.runState === "READY_FOR_USER_SUBMISSION" ||
    fillCommand === "FINALIZED" ||
    fillCommand === "CANCELLED"
  );
  return {
    formOpen,
    handedOver: live && (companion.state === "HANDOFF_PENDING" || companion.state === "HUMAN_ONLY"),
    stopped: live && (companion.state === "ERROR" || companion.state === "CLOSED"),
    formRead,
    answersMatchReading,
    reviewed: review.runState === "READY" && packet !== null && packet.reviewedAt !== null,
    fillRunning,
    fillUsed,
    runOpenable: review.runState === null || OPENABLE_RUN_STATES.has(review.runState)
  };
}

function connectionReason(input: ControlStepInput): string | null {
  const { companion } = input;
  if (!companion.hasStatus) {
    return companion.connection === "UNAVAILABLE"
      ? "Apply Pilot can't reach the Apply Pilot browser from this page. Use Retry connection under More."
      : "Waiting for the Apply Pilot browser to connect. If this doesn't change, use Refresh status under More.";
  }
  if (companion.connection === "UNAVAILABLE") {
    return "Apply Pilot lost its connection to this window. Use Retry connection under More.";
  }
  return null;
}

function stoppedReason(input: ControlStepInput): string | null {
  const { companion } = input;
  if (!companion.hasStatus) return null;
  if (companion.state === "ERROR") {
    const reason = safeStopLabel(companion.errorCode ?? "");
    return `${reason} To try again, close this window and start the Apply Pilot browser again.`;
  }
  if (companion.state === "CLOSED") {
    return "This window is no longer connected to the employer's form. To try again, start the Apply Pilot browser again.";
  }
  return null;
}

function busyReason(input: ControlStepInput): string | null {
  if (input.fill.pendingActivation) return "Fill is running. Wait for it to finish.";
  if (input.uiLocked) return "Apply Pilot is recording your submission. Wait a moment.";
  if (input.companion.pendingCommand !== null) return "Wait for the step in progress to finish.";
  return null;
}

function firstReason(...reasons: Array<string | null | false>): string {
  for (const reason of reasons) if (reason) return reason;
  return "This isn't available right now. Open Details for the technical reason.";
}

function action(label: string, enabled: boolean, reason: () => string): ControlActionState {
  return { label, enabled, reason: enabled ? null : reason() };
}

function actionStates(input: ControlStepInput, facts: Facts): Record<ControlStepAction, ControlActionState> {
  const { companion, review, fill, handoff, record } = input;
  const state = companion.state;
  const live = companion.hasStatus;
  const packet = review.packet;
  const inspecting = companion.pendingCommand === "INSPECT_FORM" ||
    (facts.formOpen && companion.inspection?.outcome === "IN_PROGRESS");
  const opening = companion.pendingCommand === "OPEN_TARGET" || (live && state === "OPENING_TARGET");
  const fillCommand = companion.fillCommand;

  const openAndRead = action(
    opening ? "Opening the form…" : inspecting ? "Reading the form…" : "Open and read the form",
    !input.uiLocked && companion.canOpenTarget && facts.runOpenable,
    () => firstReason(
      opening && "Opening the employer's form…",
      busyReason(input),
      connectionReason(input),
      stoppedReason(input),
      (state === "STARTING" || state === "APPLY_PILOT_AUTH_REQUIRED") &&
        "Sign this window in with your code first.",
      facts.formOpen && "The employer's form is already open.",
      facts.handedOver && "The form has already been handed over to you.",
      !facts.runOpenable && (review.runState === "DRAFT" || review.runState === "PREPARING" ||
        review.runState === "BLOCKED" || review.runState === "FAILED") &&
        "This application isn't prepared yet. Finish step 2 on the application page first.",
      !facts.runOpenable && "This application is past the point where the form can be opened again."
    )
  );

  const readForm = action(
    inspecting ? "Reading the form…" : "Read the form",
    !input.uiLocked && companion.canInspectForm,
    () => firstReason(
      inspecting && "Apply Pilot is reading the form…",
      busyReason(input),
      connectionReason(input),
      stoppedReason(input),
      !facts.formOpen && "Open the employer's form first."
    )
  );

  const continueReview = action(
    review.approving ? "Approving…" : "Approve and continue",
    !input.uiLocked && review.approveEligible && !review.pendingMutation,
    () => firstReason(
      review.approving && "Approving your answers…",
      review.pendingMutation && "Saving your choice…",
      busyReason(input),
      review.phase === "loading" && "Loading the latest answers…",
      (review.phase === "error" || !review.verified) &&
        "Apply Pilot couldn't confirm the latest answers. Use Refresh review data under More.",
      packet === null && "Apply Pilot hasn't proposed any answers yet. Read the form first.",
      packet !== null && packet.reviewedAt !== null && "You've already checked these answers.",
      review.runState !== "REVIEW_REQUIRED" && "These answers can't be confirmed at this stage.",
      packet !== null && !packet.readyForRunResolution && packet.pendingReviewCount === 0 &&
        "Apply Pilot is still checking the answers. Use Refresh review data under More."
    )
  );

  const fillAction = action(
    fill.pendingActivation ? "Filling…" : fillButtonLabel(fill.fillableCount),
    fill.activationEligible && fill.acknowledged,
    () => firstReason(
      fill.pendingActivation && "Fill is running. It runs only once.",
      fill.mayHaveDispatched && !fill.verified &&
        "Apply Pilot couldn't confirm what Fill did, so it won't run Fill again. Use Refresh Fill status under More.",
      (fill.category === "FILLING" || fillCommand?.outcome === "IN_PROGRESS" || review.runState === "FILLING") &&
        "Fill is running. It runs only once.",
      (fill.category === "RECOVERY_PENDING" || fillCommand?.outcome === "RECOVERY_PENDING") &&
        "Apply Pilot is still settling the Fill result. Use Refresh Fill status under More.",
      fill.category === "UNAVAILABLE" &&
        "Apply Pilot couldn't confirm the Fill status, so it won't run Fill. Use Refresh Fill status under More.",
      facts.fillUsed && "Fill has already run. It runs only once.",
      fillCommand?.outcome === "REJECTED" &&
        "Fill didn't start (see the note above). Read the form again under More before trying again, or go on to step 7 and finish the form yourself.",
      busyReason(input),
      connectionReason(input),
      stoppedReason(input),
      facts.handedOver && "The form has been handed over to you, so Apply Pilot won't fill it.",
      !facts.formOpen && "The employer's form isn't open in this window.",
      !facts.formRead && "Read the form first (step 4).",
      !facts.reviewed && "Check the answers first (step 5).",
      review.phase === "loading" && "Loading the latest answers…",
      (review.phase === "error" || !review.verified) &&
        "Apply Pilot couldn't confirm the latest answers. Use Refresh review data under More.",
      !fill.packetCurrent && "Apply Pilot is matching your answers to the form it just read…",
      (fill.phase !== "loaded" || !fill.verified) && "Checking whether Fill has already run…",
      fill.fillableCount === 0 && "There's nothing for Apply Pilot to fill on this form.",
      review.pendingMutation && "Saving your choice…",
      !fill.acknowledged && "Tick the box above to say you understand first."
    )
  );

  const unlockEnabled = handoff.eligible && companion.canHandOff && !input.uiLocked;
  const unlockReason = () => firstReason(
    busyReason(input),
    connectionReason(input),
    stoppedReason(input),
    facts.handedOver && "The form is already unlocked.",
    !facts.formOpen && "The employer's form isn't open in this window.",
    facts.fillRunning && "Wait for Fill to finish.",
    (fill.phase !== "loaded" || !fill.verified) &&
      "Checking whether Fill has run. If this doesn't change, use Refresh Fill status under More.",
    review.pendingMutation && "Saving your choice…"
  );
  const unlock = action("Unlock the form", unlockEnabled, unlockReason);
  const confirmUnlock = action("Yes, unlock the form", unlockEnabled, unlockReason);

  const recordEntry = action(
    "I personally submitted this application",
    record.eligible,
    () => firstReason(
      record.recorded && "Your submission is already recorded.",
      record.phase === "pending" && "Recording your submission…",
      !record.runVerified &&
        "Apply Pilot is checking this application's status. If this doesn't change, use Refresh review data under More.",
      "A submission can't be recorded for this application at this stage."
    )
  );
  const confirmRecord = action(
    record.phase === "pending" ? "Recording personal submission…" : "Confirm personal submission",
    record.phase !== "pending" && record.eligible,
    () => firstReason(
      record.phase === "pending" && "Recording your submission…",
      "Apply Pilot couldn't confirm this application's status. Press Not yet, then try again."
    )
  );
  const checkRecord = action(
    "Refresh personal-submission status",
    record.phase !== "pending",
    () => "Recording your submission…"
  );

  return {
    OPEN_AND_READ: openAndRead,
    READ_FORM: readForm,
    CONTINUE_REVIEW: continueReview,
    FILL: fillAction,
    UNLOCK: unlock,
    CONFIRM_UNLOCK: confirmUnlock,
    RECORD: recordEntry,
    CONFIRM_RECORD: confirmRecord,
    CHECK_RECORD: checkRecord
  };
}

type Placement = Readonly<{
  current: ControlStepNumber | null;
  finished: ControlStepsView["finished"];
  primary: ControlStepsView["primary"];
  sentence: string;
  next: string;
}>;

const NEXT_LINES: Readonly<Record<ControlStepNumber, string>> = {
  4: "Next: check the answers Apply Pilot proposes (step 5).",
  5: "Next: Fill types the answers you approved, once (step 6).",
  6: "Next: unlock the form and finish it yourself (step 7).",
  7: "Next: finish the form, press the employer's Submit button yourself, then record it (step 8).",
  8: "This is the last step."
};

function readSummary(input: ControlStepInput): string {
  const packet = input.review.packet;
  if (packet === null) return "Apply Pilot read the form.";
  if (packet.proposableCount === 0) {
    return `Apply Pilot read ${packet.fieldCount} ${plural(packet.fieldCount, "field", "fields")} but has no answers to propose. You'll fill them yourself.`;
  }
  return `Apply Pilot read ${packet.fieldCount} ${plural(packet.fieldCount, "field", "fields")} and proposes answers for ${packet.proposableCount}. Untick any you don't want filled, then approve.`;
}

function place(input: ControlStepInput, facts: Facts): Placement {
  const { companion, review, record, handoff } = input;

  if (review.runState === "COMPLETED_BY_USER" || record.recorded || record.phase === "confirmed") {
    return {
      current: 8,
      finished: "RECORDED",
      primary: null,
      sentence: "Done. Your submission is recorded. Apply Pilot didn't submit anything itself.",
      next: "Nothing more to do here."
    };
  }
  if (review.runState === "CANCELLED") {
    return {
      current: null,
      finished: "STOPPED",
      primary: null,
      sentence: "This application was stopped, so Apply Pilot won't do anything more with it.",
      next: "Finish the employer's form yourself if you still want to apply."
    };
  }

  if (record.phase === "confirming" || record.phase === "pending") {
    return {
      current: 8,
      finished: null,
      primary: { action: "CONFIRM_RECORD", step: 8 },
      sentence: "Confirm only if you pressed the employer's Submit button yourself.",
      next: NEXT_LINES[8]
    };
  }
  if (record.phase === "uncertain") {
    return {
      current: 8,
      finished: null,
      primary: record.eligible
        ? { action: "RECORD", step: 8 }
        : { action: "CHECK_RECORD", step: 8 },
      sentence: "Apply Pilot couldn't confirm whether your submission was recorded. It didn't send it again.",
      next: NEXT_LINES[8]
    };
  }

  if (facts.handedOver) {
    const minutes = companion.humanMinutesRemaining;
    return {
      current: 7,
      finished: null,
      primary: { action: "RECORD", step: 7 },
      sentence: companion.state === "HANDOFF_PENDING"
        ? "Handing the form over to you…"
        : `The form is yours: finish it and press the employer's Submit button yourself${minutes === null ? "" : ` (${minutes} ${plural(minutes, "minute", "minutes")} left)`}.`,
      next: "Next: once you've pressed Submit, record it (step 8)."
    };
  }

  if (facts.fillRunning) {
    return {
      current: 6,
      finished: null,
      primary: { action: "FILL", step: 6 },
      sentence: input.fill.mayHaveDispatched && !input.fill.verified
        ? "Apply Pilot couldn't confirm what Fill did. It won't run Fill again. Check every field on the form yourself."
        : "Fill is running. It types your approved answers once and never presses Submit.",
      next: NEXT_LINES[6]
    };
  }

  if (facts.fillUsed) {
    if (facts.formOpen || !companion.hasStatus) {
      return {
        current: 7,
        finished: null,
        primary: { action: handoff.confirming ? "CONFIRM_UNLOCK" : "UNLOCK", step: 7 },
        sentence: "Fill has run. Unlock the form so you can check it, finish it and submit it yourself.",
        next: NEXT_LINES[7]
      };
    }
    return {
      current: 8,
      finished: null,
      primary: { action: "RECORD", step: 8 },
      sentence: "Fill has run and the employer's form isn't open in this window any more. If you submitted it, record it here. If not, finish it in your usual browser.",
      next: NEXT_LINES[8]
    };
  }

  if (facts.stopped) {
    if (companion.handedOverEarlier) {
      return {
        current: 8,
        finished: null,
        primary: { action: "RECORD", step: 8 },
        sentence: "The employer's form is closed. If you pressed its Submit button, record it here.",
        next: NEXT_LINES[8]
      };
    }
    return {
      current: 4,
      finished: null,
      primary: { action: "OPEN_AND_READ", step: 4 },
      sentence: stoppedReason(input) ?? "Apply Pilot stopped safely.",
      next: NEXT_LINES[4]
    };
  }

  if (!facts.formOpen) {
    return {
      current: 4,
      finished: null,
      primary: { action: "OPEN_AND_READ", step: 4 },
      sentence: companion.hasStatus && companion.state === "OPENING_TARGET"
        ? "Opening the employer's form…"
        : "Apply Pilot opens the employer's form in a second window and reads its fields. It doesn't type anything yet.",
      next: NEXT_LINES[4]
    };
  }

  if (!facts.formRead) {
    const inspection = companion.inspection;
    const changed = companion.formInvalidated ||
      inspection?.outcome === "REINSPECTION_REQUIRED" ||
      (inspection?.outcome === "SUCCEEDED" && inspection.reinspectionRequired);
    return {
      current: 4,
      finished: null,
      primary: { action: "READ_FORM", step: 4 },
      sentence: changed
        ? "The employer's form changed, so Apply Pilot needs to read it again."
        : inspection?.outcome === "FAILED"
          ? "Apply Pilot couldn't read the form (see the note above). You can try again."
          : "The employer's form is open. Apply Pilot reads it next, so it can propose answers.",
      next: NEXT_LINES[4]
    };
  }

  if (!facts.answersMatchReading) {
    return {
      current: 5,
      finished: null,
      primary: { action: "CONTINUE_REVIEW", step: 5 },
      sentence: review.phase === "error"
        ? "Apply Pilot read the form but couldn't load its proposed answers."
        : "Apply Pilot read the form. Loading its proposed answers…",
      next: NEXT_LINES[5]
    };
  }

  if (!facts.reviewed) {
    return {
      current: 5,
      finished: null,
      primary: { action: "CONTINUE_REVIEW", step: 5 },
      sentence: readSummary(input),
      next: NEXT_LINES[5]
    };
  }

  const packet = review.packet;
  if (input.fill.fillableCount === 0) {
    return {
      current: 7,
      finished: null,
      primary: { action: handoff.confirming ? "CONFIRM_UNLOCK" : "UNLOCK", step: 7 },
      sentence: "Apply Pilot has nothing it can fill on this form. Unlock the form and fill it in yourself.",
      next: NEXT_LINES[7]
    };
  }
  const total = packet?.fieldCount ?? input.fill.fillableCount;
  return {
    current: 6,
    finished: null,
    primary: { action: "FILL", step: 6 },
    sentence: `Apply Pilot can fill ${input.fill.fillableCount} of ${total} ${plural(total, "field", "fields")}. You'll do the rest.`,
    next: NEXT_LINES[6]
  };
}

export function deriveControlSteps(input: ControlStepInput): ControlStepsView {
  const facts = deriveFacts(input);
  const placement = place(input, facts);
  const progress = {} as Record<AssistedApplyStepNumber, StepProgress>;
  for (const step of ASSISTED_APPLY_STEP_NUMBERS) {
    if (step <= 3 || placement.finished === "RECORDED") progress[step] = "done";
    else if (placement.current === null) progress[step] = "later";
    else progress[step] = step < placement.current ? "done" : step === placement.current ? "now" : "later";
  }
  const heading = placement.finished === "STOPPED"
    ? "Stopped"
    : placement.finished === "RECORDED"
      ? `${stepHeading(8)}: done`
      : stepHeading(placement.current ?? 4);
  return {
    current: placement.current,
    finished: placement.finished,
    progress,
    heading,
    sentence: placement.sentence,
    next: placement.next,
    primary: placement.primary,
    actions: actionStates(input, facts),
    recordEntryStep: placement.primary?.action === "RECORD" && placement.primary.step === 7 ? 7 : 8
  };
}

// Where a proposed value comes from, in plain words (D034: application details are saved,
// unmasked answers; documents come from the ones chosen for this application).
export function answerSourceLabel(answer: Readonly<{
  classification: string;
  proposal: Readonly<{ kind: string }> | null;
}>): string {
  if (answer.proposal?.kind === "DOCUMENT_REFERENCE") return "Your documents for this application";
  if (answer.classification === "CONTACT" || answer.classification === "PROFESSIONAL_LINK") {
    return "Your application details";
  }
  return "Your saved answers";
}
