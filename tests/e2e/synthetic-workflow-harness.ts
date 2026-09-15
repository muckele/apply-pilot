import path from "node:path";

import {
  SYNTHETIC_EMPLOYER_SUBMISSION_URL,
  SYNTHETIC_EMPLOYER_TARGET_URL,
  parseSyntheticEmployerSnapshotValue,
  type SyntheticEmployerSnapshot
} from "./synthetic-employer-fixture";

const GUARDED_SUITE_MARKER = "SYNTHETIC_FULL_WORKFLOW_E2E";
const SYNTHETIC_DIAGNOSTIC_DIRECTORY = path.join("test-results", "synthetic-human-submit");
const syntheticChildRuntimeEnvironmentNames = [
  "PATH",
  "HOME",
  "USERPROFILE",
  "TMPDIR",
  "TMP",
  "TEMP",
  "SystemRoot",
  "SYSTEMROOT",
  "COMSPEC",
  "PATHEXT",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "CI",
  "TERM"
] as const;

export type SyntheticNetworkPurpose =
  | "APPLY_PILOT"
  | "SYNTHETIC_TARGET"
  | "SYNTHETIC_SUBMISSION"
  | "REJECTED";

export type SyntheticNetworkClassification = Readonly<{
  allowed: boolean;
  purpose: SyntheticNetworkPurpose;
}>;

export type SyntheticWorkflowRequestCounters = Readonly<{
  applyPilotRequestCount: number;
  syntheticTargetRequestCount: number;
  syntheticSubmissionEndpointCount: number;
  rejectedRequestCount: number;
}>;

export type SyntheticFillResultCounts = Readonly<{
  attempted: number;
  succeeded: number;
  failed: number;
  skipped: number;
  manual: number;
}>;

export type SyntheticDiagnosticSummary = Readonly<{
  phase: string | null;
  runState: string | null;
  runStateVersion: number | null;
  inspectionVersion: number | null;
  packetVersion: number | null;
  hasFillAttempt: boolean;
  fillResultCounts: SyntheticFillResultCounts;
  hasCompletedAt: boolean;
  applicationStatus: string | null;
  hasDateApplied: boolean;
  controlUrl: string | null;
  targetUrl: string | null;
}>;

export type SyntheticCleanupFailure = Readonly<{
  label: string;
  reason: "FAILED" | "TIMED_OUT";
}>;

type CleanupTask = (signal: AbortSignal) => void | Promise<void>;

function assertGuardedSyntheticSuite(environment: Readonly<Record<string, string | undefined>>): void {
  if (environment[GUARDED_SUITE_MARKER] !== "1") {
    throw new Error("Synthetic workflow helpers require the guarded synthetic full-workflow suite.");
  }
}

export function buildSyntheticWorkflowChildEnvironment(
  validatedDatabaseUrl: string,
  parentEnvironment: Readonly<Record<string, string | undefined>> = process.env
): NodeJS.ProcessEnv {
  assertGuardedSyntheticSuite(parentEnvironment);
  if (typeof validatedDatabaseUrl !== "string" || validatedDatabaseUrl.trim().length === 0) {
    throw new Error("Synthetic workflow child requires an explicit validated PostgreSQL test URL.");
  }

  const environment: Record<string, string | undefined> = {};
  for (const name of syntheticChildRuntimeEnvironmentNames) {
    const value = parentEnvironment[name];
    if (value !== undefined) environment[name] = value;
  }
  Object.assign(environment, {
    NODE_ENV: "development",
    ALLOW_DEMO_USER: "true",
    DEFAULT_DEMO_USER_ID: "synthetic-human-submit-user",
    AUTH_TRUST_HOST: "true",
    NEXT_TELEMETRY_DISABLED: "1",
    AI_ENABLED: "false",
    AI_MOCK_MODE: "true",
    OPENAI_MOCK_MODE: "true",
    DATABASE_URL: validatedDatabaseUrl,
    DIRECT_URL: validatedDatabaseUrl,
    SYNTHETIC_FULL_WORKFLOW_E2E: "1"
  });
  return environment as NodeJS.ProcessEnv;
}

function assertApplyPilotLoopbackOrigin(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Synthetic workflow requires the exact allocated 127.0.0.1 origin.");
  }
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.port.length === 0 ||
    !Number.isInteger(Number(url.port)) ||
    Number(url.port) < 1 ||
    Number(url.port) > 65_535 ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.pathname !== "/" ||
    url.search.length > 0 ||
    url.hash.length > 0 ||
    url.origin !== value
  ) {
    throw new Error("Synthetic workflow requires the exact allocated 127.0.0.1 origin.");
  }
  return url;
}

export function classifySyntheticWorkflowUrl(
  requestUrl: string,
  applyPilotOrigin: string
): SyntheticNetworkClassification {
  const trustedApplyPilotOrigin = assertApplyPilotLoopbackOrigin(applyPilotOrigin).origin;
  let candidate: URL;
  try {
    candidate = new URL(requestUrl);
  } catch {
    return { allowed: false, purpose: "REJECTED" };
  }

  if (
    candidate.origin === trustedApplyPilotOrigin &&
    candidate.username.length === 0 &&
    candidate.password.length === 0
  ) {
    return { allowed: true, purpose: "APPLY_PILOT" };
  }
  if (candidate.href === SYNTHETIC_EMPLOYER_TARGET_URL) {
    return { allowed: true, purpose: "SYNTHETIC_TARGET" };
  }
  if (candidate.href === SYNTHETIC_EMPLOYER_SUBMISSION_URL) {
    return { allowed: true, purpose: "SYNTHETIC_SUBMISSION" };
  }
  return { allowed: false, purpose: "REJECTED" };
}

export function createSyntheticWorkflowRequestCounters(): SyntheticWorkflowRequestCounters {
  return {
    applyPilotRequestCount: 0,
    syntheticTargetRequestCount: 0,
    syntheticSubmissionEndpointCount: 0,
    rejectedRequestCount: 0
  };
}

export function countSyntheticWorkflowRequest(
  counters: SyntheticWorkflowRequestCounters,
  classification: SyntheticNetworkClassification
): SyntheticWorkflowRequestCounters {
  switch (classification.purpose) {
    case "APPLY_PILOT":
      return { ...counters, applyPilotRequestCount: counters.applyPilotRequestCount + 1 };
    case "SYNTHETIC_TARGET":
      return { ...counters, syntheticTargetRequestCount: counters.syntheticTargetRequestCount + 1 };
    case "SYNTHETIC_SUBMISSION":
      return { ...counters, syntheticSubmissionEndpointCount: counters.syntheticSubmissionEndpointCount + 1 };
    case "REJECTED":
      return { ...counters, rejectedRequestCount: counters.rejectedRequestCount + 1 };
  }
}

function boundedDiagnosticToken(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : null;
}

function boundedDiagnosticVersion(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : null;
}

function boundedDiagnosticCount(value: unknown): number {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : 0;
}

function safeControlUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2_048) return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "http:" ||
      url.hostname !== "127.0.0.1" ||
      url.port.length === 0 ||
      url.username.length > 0 ||
      url.password.length > 0 ||
      url.search.length > 0 ||
      url.hash.length > 0
    ) {
      return null;
    }
    return url.href;
  } catch {
    return null;
  }
}

function safeTargetUrl(value: unknown): string | null {
  return value === SYNTHETIC_EMPLOYER_TARGET_URL ? SYNTHETIC_EMPLOYER_TARGET_URL : null;
}

export function buildSyntheticDiagnosticSummary(
  input: Readonly<Record<string, unknown>>
): SyntheticDiagnosticSummary {
  const fillInput = input.fillResultCounts && typeof input.fillResultCounts === "object"
    ? input.fillResultCounts as Record<string, unknown>
    : {};
  const fillResultCounts = Object.freeze({
    attempted: boundedDiagnosticCount(fillInput.attempted),
    succeeded: boundedDiagnosticCount(fillInput.succeeded),
    failed: boundedDiagnosticCount(fillInput.failed),
    skipped: boundedDiagnosticCount(fillInput.skipped),
    manual: boundedDiagnosticCount(fillInput.manual)
  });

  return Object.freeze({
    phase: boundedDiagnosticToken(input.phase),
    runState: boundedDiagnosticToken(input.runState),
    runStateVersion: boundedDiagnosticVersion(input.runStateVersion),
    inspectionVersion: boundedDiagnosticVersion(input.inspectionVersion),
    packetVersion: boundedDiagnosticVersion(input.packetVersion),
    hasFillAttempt: input.hasFillAttempt === true,
    fillResultCounts,
    hasCompletedAt: input.hasCompletedAt === true,
    applicationStatus: boundedDiagnosticToken(input.applicationStatus),
    hasDateApplied: input.hasDateApplied === true,
    controlUrl: safeControlUrl(input.controlUrl),
    targetUrl: safeTargetUrl(input.targetUrl)
  });
}

export function buildSyntheticDiagnosticArtifactPath(filename: string, repositoryRoot = process.cwd()): string {
  if (
    typeof filename !== "string" ||
    filename.length > 132 ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/.test(filename) ||
    filename.includes("..") ||
    path.basename(filename) !== filename
  ) {
    throw new Error("Synthetic diagnostics require a safe JSON artifact filename.");
  }
  return path.join(repositoryRoot, SYNTHETIC_DIAGNOSTIC_DIRECTORY, filename);
}

function sanitizeCleanupLabel(label: string): string {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(label)) {
    throw new Error("Synthetic cleanup labels must be bounded identifiers.");
  }
  return label;
}

async function runBoundedCleanup(
  label: string,
  task: CleanupTask,
  timeoutMs: number
): Promise<SyntheticCleanupFailure | undefined> {
  const controller = new AbortController();
  return new Promise<SyntheticCleanupFailure | undefined>((resolve) => {
    let settled = false;
    const finish = (failure: SyntheticCleanupFailure | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(failure);
    };
    const timer = setTimeout(() => {
      controller.abort();
      finish(Object.freeze({ label, reason: "TIMED_OUT" }));
    }, timeoutMs);

    Promise.resolve()
      .then(() => task(controller.signal))
      .then(
        () => finish(undefined),
        () => finish(Object.freeze({ label, reason: "FAILED" }))
      );
  });
}

export class SyntheticCleanupStack {
  readonly #entries: Array<Readonly<{ label: string; task: CleanupTask }>> = [];
  readonly #perCleanupTimeoutMs: number;
  #cleanupPromise: Promise<readonly SyntheticCleanupFailure[]> | undefined;

  constructor(options: Readonly<{ perCleanupTimeoutMs?: number }> = {}) {
    this.#perCleanupTimeoutMs = options.perCleanupTimeoutMs ?? 5_000;
    if (!Number.isInteger(this.#perCleanupTimeoutMs) || this.#perCleanupTimeoutMs < 1) {
      throw new Error("Synthetic cleanup timeout must be a positive integer.");
    }
  }

  add(label: string, task: CleanupTask): void {
    if (this.#cleanupPromise) throw new Error("Synthetic cleanup has already started.");
    this.#entries.push(Object.freeze({ label: sanitizeCleanupLabel(label), task }));
  }

  cleanup(): Promise<readonly SyntheticCleanupFailure[]> {
    this.#cleanupPromise ??= this.#runCleanup();
    return this.#cleanupPromise;
  }

  async #runCleanup(): Promise<readonly SyntheticCleanupFailure[]> {
    const failures: SyntheticCleanupFailure[] = [];
    for (const entry of [...this.#entries].reverse()) {
      const failure = await runBoundedCleanup(entry.label, entry.task, this.#perCleanupTimeoutMs);
      if (failure) failures.push(failure);
    }
    return Object.freeze(failures);
  }
}

export function parseSyntheticEmployerSnapshot(value: unknown): SyntheticEmployerSnapshot {
  return parseSyntheticEmployerSnapshotValue(value);
}
