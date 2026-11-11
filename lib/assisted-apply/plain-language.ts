import type { ApplicationRunState } from "@prisma/client";

import type { ControlConnection, ManualFieldCategory } from "@/lib/application-browser/control-presentation";
import type { B1WorkflowState } from "@/lib/application-browser/types";
import type { ApplicationFormFieldType } from "@/lib/application-runs/form-inspection";
import type {
  ApplicationAnswerDisposition,
  ApplicationAnswerDispositionReason
} from "@/lib/application-runs/question-classification";

// One dictionary for every state code the assisted-apply screens can show (redesign §5.2).
// Codes themselves only appear under "Details", for troubleshooting.

export const APPLICATION_RUN_STATES_FOR_PLAIN_LANGUAGE = [
  "DRAFT",
  "PREPARING",
  "READY",
  "REVIEW_REQUIRED",
  "FILLING",
  "READY_FOR_USER_SUBMISSION",
  "COMPLETED_BY_USER",
  "BLOCKED",
  "FAILED",
  "CANCELLED"
] as const satisfies readonly ApplicationRunState[];

const RUN_STATE_LABELS: Record<ApplicationRunState, string> = {
  DRAFT: "Not started",
  PREPARING: "Preparing…",
  READY: "Prepared",
  REVIEW_REQUIRED: "Prepared, with things for you to check",
  FILLING: "Filling…",
  READY_FOR_USER_SUBMISSION: "Filled: your turn to finish and submit",
  COMPLETED_BY_USER: "Done: you applied",
  BLOCKED: "Can't continue yet",
  FAILED: "Preparing didn't work",
  CANCELLED: "Stopped"
};

const COMPANION_STATE_LABELS: Record<B1WorkflowState, string> = {
  STARTING: "Starting the Apply Pilot browser…",
  APPLY_PILOT_AUTH_REQUIRED: "Sign in the Apply Pilot browser with your code",
  CONTROL_READY: "Connected",
  OPENING_TARGET: "Opening the employer's form…",
  TARGET_OPEN: "Employer's form is open",
  HANDOFF_PENDING: "Handing the form over to you…",
  HUMAN_ONLY: "The form is yours: finish and submit",
  ERROR: "Stopped safely",
  CLOSED: "Closed"
};

const CONNECTION_LABELS: Record<ControlConnection, string> = {
  UNKNOWN: "Not checked yet",
  CONNECTED: "Connected",
  UNAVAILABLE: "Not connected"
};

const ANSWER_STATUS_LABELS: Record<"PENDING" | "APPROVED" | "REJECTED", string> = {
  PENDING: "Waiting for you",
  APPROVED: "Approved",
  REJECTED: "Won't be filled"
};

const DISPOSITION_LABELS: Record<ApplicationAnswerDisposition, string> = {
  PROPOSABLE: "Apply Pilot can fill this",
  MANUAL_ONLY: "You fill this",
  EXCLUDED: "Apply Pilot never fills this kind of question",
  UNSUPPORTED: "Apply Pilot can't fill this kind of field"
};

const DISPOSITION_REASON_LABELS: Record<ApplicationAnswerDispositionReason, string> = {
  NO_ELIGIBLE_SOURCE: "There's no saved detail Fill can use for this.",
  INVALID_SOURCE_VALUE: "The saved detail doesn't fit this field.",
  AMBIGUOUS_SOURCE: "More than one saved detail could fit, so Apply Pilot won't guess.",
  UNCONFIRMED_APPLICANT_CONTACT: "This detail isn't confirmed in Your application details yet.",
  POLICY_EXCLUDED: "This is a question only you answer.",
  LEGAL_ATTESTATION: "This is a statement only you can make.",
  V1_MANUAL_POLICY: "Apply Pilot leaves this kind of question to you.",
  UNSUPPORTED_CONTROL: "Apply Pilot can't fill this kind of control.",
  AMBIGUOUS_FIELD: "Apply Pilot couldn't tell exactly what this field asks.",
  AMBIGUOUS_CHOICES: "Apply Pilot couldn't tell the choices apart.",
  MULTIPLE_FILE_UPLOAD: "This field takes several files, so you upload them.",
  NO_SELECTED_DOCUMENT: "No document is chosen for this application.",
  UNKNOWN_QUESTION: "Apply Pilot didn't recognise this question."
};

const FIELD_TYPE_LABELS: Record<ApplicationFormFieldType, string> = {
  TEXT: "text box",
  EMAIL: "email box",
  TEL: "phone box",
  URL: "web address box",
  TEXTAREA: "long text box",
  SELECT_ONE: "dropdown",
  SELECT_MANY: "multiple-choice list",
  RADIO_GROUP: "choice buttons",
  CHECKBOX_BOOLEAN: "tick box",
  CHECKBOX_GROUP: "group of tick boxes",
  NUMBER: "number box",
  DATE: "date",
  FILE_UPLOAD: "file upload",
  UNSUPPORTED: "other control"
};

const MANUAL_CATEGORY_LABELS: Record<ManualFieldCategory, string> = {
  MANUAL_CONTROL_FAMILY: "Apply Pilot doesn't fill choice buttons or tick boxes",
  MANUAL_ONLY: "Yours to answer",
  UNSUPPORTED: "Apply Pilot can't fill this kind of field",
  INTENTIONALLY_EXCLUDED: "A question only you answer",
  USER_REJECTED: "You chose not to fill this"
};

// Safe stops the companion reports. Anything not listed falls back to a generic sentence,
// so a new code is never shown outside "Details".
const SAFE_STOP_LABELS: Readonly<Record<string, string>> = {
  APPLY_PILOT_AUTH_REQUIRED: "the Apply Pilot browser needs to be signed in with your code.",
  AUTOMATION_DISABLED: "automation is switched off for now.",
  BROWSER_WORKFLOW_FAILED: "something in the Apply Pilot browser didn't work.",
  COMMAND_NOT_ALLOWED: "that step isn't allowed right now.",
  CONTROL_COMMAND_FAILED: "a step didn't finish.",
  CONTROL_NAVIGATION_TRUST_LOST: "this page left its exact address.",
  CONTROL_PAGE_CLOSED: "this page was closed.",
  CONTROL_STATE_INVALID: "the Apply Pilot browser got into an unexpected state.",
  HANDOFF_NOT_QUIESCENT: "Apply Pilot was still busy, so it couldn't hand the form over yet.",
  HANDOFF_RETIREMENT_FAILED: "Apply Pilot couldn't hand the form over cleanly.",
  HUMAN_SESSION_CLEANUP_UNCERTAIN: "Apply Pilot couldn't confirm the employer's form was closed.",
  INVALID_RUN_RESPONSE: "Apply Pilot couldn't read this application's details.",
  PAGE_CLOSED: "a browser page was closed.",
  PROTECTED_SESSION_LOST: "the employer's form was disconnected.",
  RUN_HOST_NOT_ALLOWED: "Apply Pilot isn't allowed on this employer's site.",
  RUN_IDENTITY_MISMATCH: "this page doesn't match the application the browser was started for.",
  RUN_INVALID_STATE: "this application isn't at a step where that can happen.",
  RUN_TARGET_INVALID: "the saved address of the employer's form isn't usable.",
  RUN_TARGET_STALE: "the saved address of the employer's form changed.",
  TARGET_ALREADY_OPEN: "the employer's form is already open.",
  TARGET_PAGE_CLOSED: "the employer's form window was closed.",
  UNEXPECTED_POPUP: "the employer's page opened an unexpected window."
};

const SAFE_STOP_SENTENCES: Readonly<Record<string, string>> = {
  CONTROL_NAVIGATION_TRUST_LOST: "This page left its exact address, so Apply Pilot stopped safely."
};

export function runStateLabel(state: ApplicationRunState): string {
  return RUN_STATE_LABELS[state];
}

export function companionStateLabel(state: B1WorkflowState): string {
  return COMPANION_STATE_LABELS[state];
}

export function connectionLabel(connection: ControlConnection): string {
  return CONNECTION_LABELS[connection];
}

export function answerStatusLabel(status: "PENDING" | "APPROVED" | "REJECTED"): string {
  return ANSWER_STATUS_LABELS[status];
}

export function dispositionLabel(disposition: ApplicationAnswerDisposition): string {
  return DISPOSITION_LABELS[disposition];
}

export function dispositionReasonLabel(reason: ApplicationAnswerDispositionReason): string {
  return DISPOSITION_REASON_LABELS[reason];
}

export function fieldTypeLabel(fieldType: ApplicationFormFieldType): string {
  return FIELD_TYPE_LABELS[fieldType];
}

export function manualCategoryLabel(category: ManualFieldCategory): string {
  return MANUAL_CATEGORY_LABELS[category];
}

// A full sentence for a safe-stop code. Unknown codes get a generic sentence.
export function safeStopLabel(code: string): string {
  const sentence = Object.hasOwn(SAFE_STOP_SENTENCES, code) ? SAFE_STOP_SENTENCES[code] : undefined;
  if (sentence) return sentence;
  const reason = Object.hasOwn(SAFE_STOP_LABELS, code) ? SAFE_STOP_LABELS[code] : undefined;
  return reason
    ? `Apply Pilot stopped safely: ${reason}`
    : "Apply Pilot stopped safely. Open Details for the technical reason.";
}

// One line saying where the Apply Pilot browser is, for the top of the control page.
export function companionStatusSentence(
  status: Readonly<{ state: B1WorkflowState; errorCode?: string }>,
  connection: ControlConnection,
  hasStatus: boolean
): string {
  if (!hasStatus) {
    return connection === "UNAVAILABLE"
      ? "Not connected to the Apply Pilot browser."
      : "Connecting to the Apply Pilot browser…";
  }
  if (status.state === "ERROR") {
    const reason = status.errorCode && Object.hasOwn(SAFE_STOP_LABELS, status.errorCode)
      ? SAFE_STOP_LABELS[status.errorCode]
      : null;
    return reason ? `Stopped safely: ${reason}` : "Stopped safely. Open Details for the technical reason.";
  }
  const label = companionStateLabel(status.state);
  return connection === "UNAVAILABLE"
    ? `${label} (connection lost: this was the last status Apply Pilot received).`
    : `${label}.`;
}

// Every code the control page knows about. A test checks that none of them is visible
// outside "Details".
export const RAW_CONTROL_PAGE_CODES: readonly string[] = Object.freeze([
  ...Object.keys(RUN_STATE_LABELS),
  ...Object.keys(COMPANION_STATE_LABELS),
  ...Object.keys(CONNECTION_LABELS),
  ...Object.keys(ANSWER_STATUS_LABELS),
  ...Object.keys(DISPOSITION_LABELS),
  ...Object.keys(DISPOSITION_REASON_LABELS),
  ...Object.keys(FIELD_TYPE_LABELS),
  ...Object.keys(MANUAL_CATEGORY_LABELS),
  ...Object.keys(SAFE_STOP_LABELS),
  "PREPARE_ONLY",
  "FILL_AND_REVIEW",
  "CONTACT",
  "PROFESSIONAL_LINK",
  "EXPERIENCE",
  "EDUCATION",
  "SKILL",
  "CITIZENSHIP_IMMIGRATION",
  "WORK_AUTHORIZATION",
  "SPONSORSHIP",
  "AVAILABILITY",
  "RELOCATION",
  "COMPENSATION",
  "DEMOGRAPHIC",
  "DISABILITY",
  "VETERAN",
  "CRIMINAL_HISTORY",
  "DOCUMENT"
].filter((code, index, all) => all.indexOf(code) === index));
