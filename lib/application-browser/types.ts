import { z } from "zod";

export const APPLICATION_BROWSER_BINDING_NAME = "__applyPilotB1Command";

export const B1_WORKFLOW_STATES = [
  "STARTING",
  "APPLY_PILOT_AUTH_REQUIRED",
  "CONTROL_READY",
  "OPENING_TARGET",
  "TARGET_OPEN",
  "ERROR",
  "CLOSED"
] as const;

export type B1WorkflowState = (typeof B1_WORKFLOW_STATES)[number];

export type B1Command =
  | { type: "GET_STATUS" }
  | { type: "OPEN_TARGET" }
  | { type: "CLOSE_WORKFLOW" };

export type B1Status = {
  state: B1WorkflowState;
  runId: string;
  targetHost?: string;
  errorCode?: string;
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
    (type !== "GET_STATUS" && type !== "OPEN_TARGET" && type !== "CLOSE_WORKFLOW")
  ) {
    throw new Error("Invalid B1 command.");
  }
  return { type };
}

export function isB1CommandAllowed(command: B1Command, state: B1WorkflowState): boolean {
  if (command.type === "OPEN_TARGET") return state === "CONTROL_READY";
  if (command.type === "CLOSE_WORKFLOW") return state !== "CLOSED";
  return state !== "CLOSED";
}
