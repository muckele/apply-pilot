import { z } from "zod";

export const APPLICATION_BROWSER_BINDING_NAME = "__applyPilotB1Command";

export const B1_WORKFLOW_STATES = [
  "STARTING",
  "APPLY_PILOT_AUTH_REQUIRED",
  "CONTROL_READY",
  "OPENING_TARGET",
  "TARGET_OPEN",
  "HANDOFF_PENDING",
  "HUMAN_ONLY",
  "ERROR",
  "CLOSED"
] as const;

export type B1WorkflowState = (typeof B1_WORKFLOW_STATES)[number];

export type B1Command =
  | { type: "GET_STATUS" }
  | { type: "OPEN_TARGET" }
  | { type: "INSPECT_FORM" }
  | { type: "FILL_APPROVED_FIELDS" }
  | { type: "HANDOFF_TO_HUMAN" }
  | { type: "END_HUMAN_SESSION" }
  | { type: "CLOSE_WORKFLOW" };

export const B3_FILL_COMMAND_REJECTION_CODES = [
  "FILL_POLICY_DENIED",
  "FILL_REVIEW_REQUIRED",
  "FILL_ALREADY_IN_PROGRESS",
  "FILL_NO_ELIGIBLE_FIELDS",
  "FILL_STALE"
] as const;

export type B3FillCommandRejectionCode =
  (typeof B3_FILL_COMMAND_REJECTION_CODES)[number];

export type B3FillCommandStatus =
  | { outcome: "IN_PROGRESS" }
  | { outcome: "FINALIZED" }
  | { outcome: "RECOVERY_PENDING" }
  | { outcome: "CANCELLED" }
  | { outcome: "REJECTED"; errorCode: B3FillCommandRejectionCode };

export const BROWSER_INSPECTION_RECOVERABLE_CODES = [
  "FORM_INSPECTION_IN_PROGRESS",
  "FORM_STABILITY_TIMEOUT",
  "FORM_GENERATION_INVALIDATED",
  "FORM_CORRELATION_INVALID",
  "AMBIGUOUS_DUPLICATE_FIELD",
  "FORM_INSPECTION_CANCELLED",
  "FORM_INSPECTION_REQUEST_TOO_LARGE",
  "RUN_LIFECYCLE_STALE",
  "RUN_DOCUMENT_STALE",
  "SAME_ORIGIN_RATE_LIMITED",
  "SAME_ORIGIN_REQUEST_FAILED"
] as const;

export type BrowserInspectionRecoverableCode =
  (typeof BROWSER_INSPECTION_RECOVERABLE_CODES)[number];

export type B2InspectionCommandStatus =
  | { outcome: "IN_PROGRESS" }
  | {
      outcome: "SUCCEEDED";
      replayed: boolean;
      inspectionVersion: number;
      answerPacketVersion: number;
      reinspectionRequired: boolean;
    }
  | {
      outcome: "REINSPECTION_REQUIRED";
      errorCode: "FORM_GENERATION_INVALIDATED";
      retryAllowed: true;
    }
  | {
      outcome: "FAILED";
      errorCode: BrowserInspectionRecoverableCode;
      retryAllowed: true;
    };

export type B1Status = {
  state: B1WorkflowState;
  runId: string;
  targetHost?: string;
  errorCode?: string;
  inspection?: B2InspectionCommandStatus;
  fillCommand?: B3FillCommandStatus;
  humanSession?: { expiresAtMs: number };
};

const immutableRunIdSchema = z.string().cuid();

export function parseImmutableRunId(value: unknown): string {
  const parsed = immutableRunIdSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error("A valid ApplicationRun run ID is required.");
  }
  return parsed.data;
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

export function parseApplyPilotOrigin(value: unknown): string {
  if (typeof value !== "string" || !value) {
    throw new Error("A valid Apply Pilot origin is required.");
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("A valid Apply Pilot origin is required.");
  }

  const protocolAllowed = url.protocol === "https:" || (url.protocol === "http:" && isLoopbackHostname(url.hostname));
  if (
    !protocolAllowed ||
    url.username ||
    url.password ||
    (url.pathname !== "" && url.pathname !== "/") ||
    url.search ||
    url.hash
  ) {
    throw new Error("A valid Apply Pilot origin is required.");
  }

  return url.origin;
}

export function parseB1Command(value: unknown): B1Command {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid B1 command.");
  }
  const keys = Object.keys(value);
  const type = (value as Record<string, unknown>).type;
  if (
    keys.length !== 1 ||
    keys[0] !== "type" ||
    (type !== "GET_STATUS" &&
      type !== "OPEN_TARGET" &&
      type !== "INSPECT_FORM" &&
      type !== "FILL_APPROVED_FIELDS" &&
      type !== "HANDOFF_TO_HUMAN" &&
      type !== "END_HUMAN_SESSION" &&
      type !== "CLOSE_WORKFLOW")
  ) {
    throw new Error("Invalid B1 command.");
  }
  return { type };
}

export function isB1CommandAllowed(command: B1Command, state: B1WorkflowState): boolean {
  if (command.type === "OPEN_TARGET") return state === "CONTROL_READY";
  if (command.type === "INSPECT_FORM") return state === "TARGET_OPEN";
  if (command.type === "FILL_APPROVED_FIELDS") return state === "TARGET_OPEN";
  if (command.type === "HANDOFF_TO_HUMAN") return state === "TARGET_OPEN" || state === "HUMAN_ONLY";
  if (command.type === "END_HUMAN_SESSION") return state === "HUMAN_ONLY";
  if (command.type === "CLOSE_WORKFLOW") return state !== "CLOSED";
  return state !== "CLOSED";
}
