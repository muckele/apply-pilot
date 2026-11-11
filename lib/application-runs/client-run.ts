import { z } from "zod";

import { fetchWithAiCostConfirmation, type ConfirmFn } from "@/lib/ai/browser-request";

// Browser helpers for the run requests behind Prepare: create the run (idempotently), allow its
// employer's host, prepare it, read it back, and turn Assisted Fill off. Shared by the Apply page's
// step 4 and the application page's run panels. Each sends exactly one request (Prepare may send a
// second, confirmed one when the server asks about cost and the user says yes).

const RUN_STATES = [
  "DRAFT", "PREPARING", "READY", "FILLING", "REVIEW_REQUIRED",
  "READY_FOR_USER_SUBMISSION", "COMPLETED_BY_USER", "BLOCKED", "FAILED", "CANCELLED"
] as const;

const runSchema = z.object({
  id: z.string().cuid(),
  applicationId: z.string().cuid(),
  state: z.enum(RUN_STATES),
  applyHost: z.string().optional(),
  blockingReason: z.string().nullable().optional(),
  errorCategory: z.string().nullable().optional()
});

export type RunSnapshot = {
  id: string;
  state: string;
  blockingReason: string | null;
  errorCategory: string | null;
};

export type RunRequestErrorKind =
  // No request was sent: this browser can't keep the create request's key.
  | "storage"
  // 409: the application already has an active run (or a concurrent create won).
  | "conflict"
  | "unauthorized"
  // The server answered with an error, so nothing was confirmed.
  | "refused"
  // The response was lost or didn't match the request; the outcome is unknown.
  | "uncertain";

export class RunRequestError extends Error {
  readonly kind: RunRequestErrorKind;
  /** The server's error code, when it sent one. */
  readonly code: string | null;

  constructor(kind: RunRequestErrorKind, message: string, code: string | null = null) {
    super(message);
    this.name = "RunRequestError";
    this.kind = kind;
    this.code = code;
  }
}

const JSON_HEADERS = { "content-type": "application/json" } as const;
const POLICY_URL = "/api/application-automation-policy";

export function runCreateKeyName(applicationId: string) {
  return `application-run-create:${applicationId}`;
}

function defaultStorage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

// The create request's idempotency key, kept for this tab's session until a run is confirmed, so
// every retry (and a reload) replays the same request rather than creating a second run.
function requestKey(storage: Storage, applicationId: string): string {
  const name = runCreateKeyName(applicationId);
  const retained = storage.getItem(name);
  if (retained) {
    if (!/^[a-f0-9-]{36}$/.test(retained)) throw new Error("The saved creation request is invalid.");
    return retained;
  }
  const generated = crypto.randomUUID();
  storage.setItem(name, generated);
  return generated;
}

/** Forget a kept create key, e.g. once the page shows the application's run. */
export function clearRunCreateKey(applicationId: string, storage: Storage | null = defaultStorage()) {
  try {
    storage?.removeItem(runCreateKeyName(applicationId));
  } catch {
    // The run already exists; a stale key only replays to it.
  }
}

async function errorCode(response: Response): Promise<string | null> {
  const body: unknown = await response.json().catch(() => null);
  return body && typeof body === "object" && "code" in body && typeof body.code === "string" ? body.code : null;
}

export async function ensureApplicationRun(
  applicationId: string,
  deps: { fetchImpl?: typeof fetch; storage?: Storage | null } = {}
): Promise<{ id: string; state: string; applyHost: string | null }> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const storage = deps.storage === undefined ? defaultStorage() : deps.storage;
  let idempotencyKey: string;
  try {
    if (!storage) throw new Error("No session storage.");
    idempotencyKey = requestKey(storage, applicationId);
  } catch {
    throw new RunRequestError("storage", "Browser session storage is unavailable. No creation request was sent.");
  }

  let response: Response;
  try {
    response = await fetchImpl("/api/application-runs", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ applicationId, idempotencyKey }),
      cache: "no-store"
    });
  } catch {
    throw new RunRequestError("uncertain", "The run creation response was lost.");
  }
  if (!response.ok) {
    const kind = response.status === 409 ? "conflict" : response.status === 401 || response.status === 403 ? "unauthorized" : "refused";
    throw new RunRequestError(kind, "The run was not created.", await errorCode(response));
  }
  const parsed = z.object({ run: runSchema }).safeParse(await response.json().catch(() => null));
  if (!parsed.success || parsed.data.run.applicationId !== applicationId) {
    throw new RunRequestError("uncertain", "The run creation response did not match the request.");
  }
  clearRunCreateKey(applicationId, storage);
  const { run } = parsed.data;
  return { id: run.id, state: run.state, applyHost: run.applyHost ?? null };
}

/**
 * Allow the run's employer host and switch application automation on, in PREPARE_ONLY mode. The
 * server adds the run's own host; nothing else is sent. It refuses while Assisted Fill is on.
 */
export async function allowHostForRun(runId: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  let response: Response;
  try {
    response = await fetchImpl(POLICY_URL, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ enablePretrialForRunId: runId }),
      cache: "no-store"
    });
  } catch {
    throw new RunRequestError("uncertain", "The policy response was lost.");
  }
  if (!response.ok) throw new RunRequestError("refused", "The host was not allowed.", await errorCode(response));
}

/** POST Prepare with `{}`. When the server asks about cost (428), `confirm` asks the user first. */
export function prepareRun(runId: string, confirm: ConfirmFn, fetchImpl: typeof fetch = fetch): Promise<Response> {
  return fetchWithAiCostConfirmation(
    `/api/application-runs/${encodeURIComponent(runId)}/prepare`,
    { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({}), cache: "no-store" },
    { fetchImpl, confirm }
  );
}

/** Read a run's durable state; throws when it can't be confirmed to be this run. */
export async function readApplicationRun(runId: string, fetchImpl: typeof fetch = fetch): Promise<RunSnapshot> {
  const response = await fetchImpl(`/api/application-runs/${encodeURIComponent(runId)}`, { method: "GET", cache: "no-store" });
  if (!response.ok) throw new RunRequestError("refused", "The run could not be read.", await errorCode(response));
  return runSnapshotFromBody(await response.json().catch(() => null), runId);
}

/** The run in a `{ run }` response body (create, prepare, read), checked to be the expected run. */
export function runSnapshotFromBody(body: unknown, runId: string): RunSnapshot {
  const parsed = z.object({ run: runSchema }).safeParse(body);
  if (!parsed.success || parsed.data.run.id !== runId) {
    throw new RunRequestError("uncertain", "The run response did not match the request.");
  }
  const { run } = parsed.data;
  return { id: run.id, state: run.state, blockingReason: run.blockingReason ?? null, errorCategory: run.errorCategory ?? null };
}

/** Turn Assisted Fill off (PREPARE_ONLY). The safe direction: no question, no reads first. */
export async function turnOffAssistedFill(fetchImpl: typeof fetch = fetch): Promise<void> {
  let response: Response;
  try {
    response = await fetchImpl(POLICY_URL, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ mode: "PREPARE_ONLY" }),
      cache: "no-store"
    });
  } catch {
    throw new RunRequestError("uncertain", "The policy response was lost.");
  }
  if (!response.ok) throw new RunRequestError("refused", "Assisted Fill was not turned off.", await errorCode(response));
  const parsed = z.object({ mode: z.string() }).safeParse(await response.json().catch(() => null));
  if (!parsed.success || parsed.data.mode !== "PREPARE_ONLY") {
    throw new RunRequestError("uncertain", "The policy response did not confirm Assisted Fill is off.");
  }
}
