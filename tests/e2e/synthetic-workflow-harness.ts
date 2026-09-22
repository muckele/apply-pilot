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
const syntheticNeutralizedEnvironmentNames = [
  "ADZUNA_APP_ID",
  "ADZUNA_APP_KEY",
  "ADZUNA_COUNTRY",
  "AI_ALLOWED_MODELS",
  "AI_AUTOMATION_CAP_CENTS",
  "AI_CONFIRMATION_THRESHOLD_CENTS",
  "AI_EVAL_DELAY_MS",
  "AI_EVAL_PLAN_TOP",
  "AI_EVAL_TAILOR_TOP",
  "AI_EVAL_USER_EMAIL",
  "AI_EVALUATION_ACKNOWLEDGED",
  "AI_HARD_CAP_CENTS",
  "AI_MAX_REQUEST_COST_CENTS",
  "AI_PROVIDER",
  "AI_PROVIDER_OVERRIDES",
  "APP_BASE_URL",
  "APPLY_PILOT_LOCAL_DESTRUCTIVE",
  "AUTH_ALLOWED_EMAILS",
  "AUTH_ALLOW_PUBLIC_SIGNUPS",
  "AUTH_GOOGLE_ID",
  "AUTH_GOOGLE_SECRET",
  "AUTH_SECRET",
  "AUTH_URL",
  "BLOB_READ_WRITE_TOKEN",
  "COMMIT5_POSTGRES_TEST",
  "CRON_MAX_SOURCES_PER_RUN",
  "CRON_MIN_SOURCE_INTERVAL_MINUTES",
  "CRON_RUNNING_LOCK_MINUTES",
  "CRON_SECRET",
  "FILE_STORAGE_DRIVER",
  "GEMINI_API_KEY",
  "GEMINI_FAST_MODEL",
  "GEMINI_QUALITY_MODEL",
  "GMAIL_REDIRECT_URI",
  "GMAIL_SCOPES",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "JOB_SOURCE_MAX_POSTED_AGE_DAYS",
  "KIMI_EVAL_DATA_ACKNOWLEDGED",
  "KIMI_EVAL_MODE",
  "KIMI_MODEL",
  "KIMI_REASONING_EFFORT",
  "LOCAL_DATABASE_URL",
  "LOCAL_DIRECT_URL",
  "MOONSHOT_API_KEY",
  "NEXTAUTH_SECRET",
  "NEXTAUTH_URL",
  "OPENAI_ALLOWED_MODELS",
  "OPENAI_API_KEY",
  "OPENAI_MODEL",
  "SERPAPI_API_KEY",
  "SERPAPI_MAX_QUERIES_PER_RUN",
  "TEST_DATABASE_URL",
  "THEIRSTACK_API_KEY",
  "THEIRSTACK_POSTED_MAX_AGE_DAYS",
  "TOKEN_ENCRYPTION_KEY",
  "USAJOBS_API_KEY",
  "USAJOBS_USER_AGENT",
  "WORKABLE_API_TOKEN"
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

export type SyntheticCleanupOwnership<T> = Readonly<{
  resource: T;
  setPreferredCleanup(task: CleanupTask): void;
}>;

type SyntheticRateLimitBucketCleanup = Readonly<{
  deleteMany(input: Readonly<{
    where: Readonly<{
      key: Readonly<{
        in: string[];
      }>;
    }>;
  }>): PromiseLike<unknown>;
}>;

const syntheticWorkflowRateLimitKeyPrefixes = [
  "application-automation-policy:read",
  "application-runs:create",
  "application-runs:read",
  "application-runs:prepare",
  "application-runs:form-inspection:publish",
  "application-runs:answer-packet:read",
  "application-runs:answers:review",
  "application-runs:resolve-review",
  "application-runs:fill-attempt:acquire",
  "application-runs:fill-attempt:status",
  "application-runs:fill-attempt:mutate",
  "application-runs:complete-by-user"
] as const;

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
  // Empty values are deliberate: Next's dotenv loader treats them as already
  // defined, so repository-local files cannot restore credential or provider authority.
  for (const name of syntheticNeutralizedEnvironmentNames) environment[name] = "";
  Object.assign(environment, {
    NODE_ENV: "development",
    ALLOW_DEMO_USER: "true",
    DEFAULT_DEMO_USER_ID: "synthetic-human-submit-user",
    AUTH_TRUST_HOST: "true",
    NEXT_TELEMETRY_DISABLED: "1",
    AI_ENABLED: "false",
    AI_MOCK_MODE: "true",
    OPENAI_MOCK_MODE: "true",
    APPLICATION_AUTOMATION_ENABLED: "true",
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

async function runPreferredCleanupWithin(
  task: CleanupTask,
  signal: AbortSignal,
  timeoutMs: number
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(() => task(signal)),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Preferred synthetic cleanup timed out.")),
          timeoutMs
        );
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function runCleanupStageWithin(
  task: CleanupTask,
  parentSignal: AbortSignal,
  timeoutMs: number,
  timeoutMessage: string
): Promise<void> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (parentSignal.aborted) abort();
  else parentSignal.addEventListener("abort", abort, { once: true });

  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(() => task(controller.signal)),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error(timeoutMessage));
        }, timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    parentSignal.removeEventListener("abort", abort);
  }
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

  get perCleanupTimeoutMs(): number {
    return this.#perCleanupTimeoutMs;
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

export async function runWithPreRegisteredCleanup<T>(
  stack: SyntheticCleanupStack,
  label: string,
  cleanupTask: CleanupTask,
  task: () => T | Promise<T>
): Promise<T> {
  stack.add(label, cleanupTask);
  return task();
}

export function remainingSyntheticDatabaseStatementTimeoutMs(
  deadlineAtMs: number,
  nowMs = Date.now()
): number {
  if (!Number.isSafeInteger(deadlineAtMs) || deadlineAtMs < 1) {
    throw new Error("Synthetic database statement cancellation deadline must be a positive safe integer.");
  }
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new Error("Synthetic database statement cancellation clock must be a non-negative safe integer.");
  }
  const remainingMs = deadlineAtMs - nowMs;
  if (remainingMs < 1) {
    throw new Error("Synthetic database statement cancellation deadline expired.");
  }
  return remainingMs;
}

export async function deleteSyntheticWorkflowRateLimitRows(
  rateLimitBucket: SyntheticRateLimitBucketCleanup,
  userId: string
): Promise<void> {
  const exactSyntheticRateLimitKeys = syntheticWorkflowRateLimitKeyPrefixes.map(
    (prefix) => `${prefix}:${userId}`
  );
  await rateLimitBucket.deleteMany({
    where: { key: { in: exactSyntheticRateLimitKeys } }
  });
}

export async function runEngineBoundDatabaseCleanup(
  signal: AbortSignal,
  transactionCleanup: (
    transactionTimeoutMs: number,
    statementCancellationTimeoutMs: number
  ) => void | Promise<void>,
  disconnect: () => void | Promise<void>,
  options: Readonly<{
    transactionTimeoutMs: number;
    statementCancellationGraceMs: number;
    aggregateTimeoutMs: number;
    disconnectTimeoutMs: number;
    schedulingMarginMs: number;
    outerTimeoutMs: number;
  }>
): Promise<void> {
  for (const [name, value] of Object.entries(options)) {
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(`Synthetic database cleanup ${name} must be a positive integer.`);
    }
  }
  if (options.transactionTimeoutMs >= options.aggregateTimeoutMs) {
    throw new Error(
      "Synthetic database transaction timeout must be strictly lower than its aggregate deadline."
    );
  }
  const statementCancellationTimeoutMs =
    options.transactionTimeoutMs + options.statementCancellationGraceMs;
  if (statementCancellationTimeoutMs >= options.aggregateTimeoutMs) {
    throw new Error(
      "Synthetic database statement cancellation deadline must be strictly lower than its aggregate deadline."
    );
  }
  if (
    options.aggregateTimeoutMs + options.disconnectTimeoutMs + options.schedulingMarginMs >=
    options.outerTimeoutMs
  ) {
    throw new Error("Synthetic database cleanup deadlines must fit strictly inside the outer cleanup deadline.");
  }

  const startedAtMs = Date.now();
  const aggregateDeadlineAtMs = startedAtMs + options.aggregateTimeoutMs;
  const finalSettlementDeadlineAtMs =
    aggregateDeadlineAtMs + options.disconnectTimeoutMs;
  const outerDeadlineAtMs = startedAtMs + options.outerTimeoutMs;
  if (
    !Number.isSafeInteger(finalSettlementDeadlineAtMs) ||
    !Number.isSafeInteger(outerDeadlineAtMs) ||
    finalSettlementDeadlineAtMs + options.schedulingMarginMs >= outerDeadlineAtMs
  ) {
    throw new Error("Synthetic database cleanup absolute deadlines must fit strictly inside the outer deadline.");
  }

  const transactionPromise = Promise.resolve()
    .then(() => transactionCleanup(options.transactionTimeoutMs, statementCancellationTimeoutMs));
  const transactionOutcomePromise = transactionPromise.then(
    () => Object.freeze({
      status: "fulfilled" as const,
      settledAtMs: Date.now()
    }),
    (error: unknown) => {
      return Object.freeze({
        status: "rejected" as const,
        error,
        settledAtMs: Date.now()
      });
    }
  );
  const observedTransaction = transactionOutcomePromise.then((outcome) => {
    if (outcome.status === "rejected") throw outcome.error;
  });

  try {
    await runCleanupStageWithin(
      () => observedTransaction,
      signal,
      Math.max(0, aggregateDeadlineAtMs - Date.now()),
      "Synthetic database cleanup exceeded its aggregate deadline."
    );
  } catch (transactionFailure) {
    let disconnectFailure: unknown;
    try {
      await runCleanupStageWithin(
        () => disconnect(),
        signal,
        Math.min(
          options.disconnectTimeoutMs,
          Math.max(0, finalSettlementDeadlineAtMs - Date.now())
        ),
        "Synthetic database actor disconnect timed out."
      );
    } catch (error) {
      disconnectFailure = error;
    }

    const transactionOutcome = await transactionOutcomePromise;
    const failures: unknown[] = [transactionFailure];
    if (
      transactionOutcome.status === "rejected" &&
      transactionOutcome.error !== transactionFailure
    ) {
      failures.push(transactionOutcome.error);
    }
    if (disconnectFailure !== undefined) failures.push(disconnectFailure);
    if (transactionOutcome.settledAtMs > finalSettlementDeadlineAtMs) {
      failures.push(new Error(
        "Synthetic database transaction settled after its absolute deadline."
      ));
    }
    if (failures.length === 1) throw transactionFailure;
    throw new AggregateError(
      failures,
      "Synthetic database cleanup did not settle safely."
    );
  }
}

export async function acquireCleanupOwnedResource<T>(
  stack: SyntheticCleanupStack,
  label: string,
  acquire: () => T | Promise<T>,
  rawCleanup: (resource: T, signal: AbortSignal) => void | Promise<void>,
  options: Readonly<{
    preferredCleanupTimeoutMs?: number;
    gracefulCleanupTimeoutMs?: number;
    forceCleanupTimeoutMs?: number;
    schedulingMarginMs?: number;
    forceCleanup?: (resource: T, signal: AbortSignal) => void | Promise<void>;
    verifyClosed?: (resource: T) => boolean | Promise<boolean>;
  }> = {}
): Promise<SyntheticCleanupOwnership<T>> {
  const preferredCleanupTimeoutMs = options.preferredCleanupTimeoutMs ?? 5_000;
  const gracefulCleanupTimeoutMs = options.gracefulCleanupTimeoutMs ?? 5_000;
  const forceCleanupTimeoutMs = options.forceCleanupTimeoutMs ?? 5_000;
  const schedulingMarginMs = options.schedulingMarginMs;
  if (!Number.isInteger(preferredCleanupTimeoutMs) || preferredCleanupTimeoutMs < 1) {
    throw new Error("Preferred synthetic cleanup timeout must be a positive integer.");
  }
  if (!Number.isInteger(gracefulCleanupTimeoutMs) || gracefulCleanupTimeoutMs < 1) {
    throw new Error("Graceful synthetic cleanup timeout must be a positive integer.");
  }
  if (!Number.isInteger(forceCleanupTimeoutMs) || forceCleanupTimeoutMs < 1) {
    throw new Error("Forced synthetic cleanup timeout must be a positive integer.");
  }
  if (schedulingMarginMs !== undefined) {
    if (!Number.isInteger(schedulingMarginMs) || schedulingMarginMs < 1) {
      throw new Error("Synthetic cleanup scheduling margin must be a positive integer.");
    }
    const nestedDeadlineMs = preferredCleanupTimeoutMs + gracefulCleanupTimeoutMs +
      (options.forceCleanup ? forceCleanupTimeoutMs : 0) + schedulingMarginMs;
    if (nestedDeadlineMs >= stack.perCleanupTimeoutMs) {
      throw new Error("Synthetic resource cleanup deadlines must fit strictly inside the outer cleanup deadline.");
    }
  }
  const resource = await acquire();
  let cleanupStarted = false;
  let preferredCleanup: CleanupTask | undefined;
  stack.add(label, async (signal) => {
    cleanupStarted = true;
    let preferredFailed = false;
    let preferredFailure: unknown;
    try {
      if (preferredCleanup) {
        await runPreferredCleanupWithin(preferredCleanup, signal, preferredCleanupTimeoutMs);
      }
    } catch (error) {
      preferredFailed = true;
      preferredFailure = error;
    } finally {
      try {
        await runCleanupStageWithin(
          async (gracefulSignal) => {
            await rawCleanup(resource, gracefulSignal);
            if (options.verifyClosed && !await options.verifyClosed(resource)) {
              throw new Error("Graceful synthetic resource cleanup did not close the resource.");
            }
          },
          signal,
          gracefulCleanupTimeoutMs,
          "Raw synthetic resource cleanup timed out."
        );
      } catch (rawFailure) {
        let forceFailure: unknown;
        if (options.forceCleanup) {
          try {
            await runCleanupStageWithin(
              async (forceSignal) => {
                await options.forceCleanup?.(resource, forceSignal);
                if (options.verifyClosed && !await options.verifyClosed(resource)) {
                  throw new Error("Forced synthetic resource cleanup did not close the resource.");
                }
              },
              signal,
              forceCleanupTimeoutMs,
              "Forced synthetic resource cleanup timed out."
            );
          } catch (error) {
            forceFailure = error;
          }
        }
        const failures = [
          ...(preferredFailed ? [preferredFailure] : []),
          rawFailure,
          ...(forceFailure === undefined ? [] : [forceFailure])
        ];
        if (failures.length > 1) {
          throw new AggregateError(
            failures,
            "Synthetic resource cleanup required fallback and did not complete cleanly."
          );
        }
        if (preferredFailed) {
          throw new AggregateError(
            [preferredFailure, rawFailure],
            "Preferred synthetic cleanup and raw resource cleanup both failed."
          );
        }
        throw rawFailure;
      }
    }
    if (preferredFailed) throw preferredFailure;
  });
  return Object.freeze({
    resource,
    setPreferredCleanup(task: CleanupTask) {
      if (cleanupStarted) throw new Error("Synthetic resource cleanup has already started.");
      preferredCleanup = task;
    }
  });
}

export function assertSyntheticCleanupOutcome(
  primaryFailure: unknown,
  cleanupFailures: readonly SyntheticCleanupFailure[]
): void {
  if (cleanupFailures.length === 0) return;
  const summaries = cleanupFailures.map((failure) => {
    const label = typeof failure.label === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(failure.label)
      ? failure.label
      : "invalid-cleanup";
    const reason = failure.reason === "TIMED_OUT" ? "TIMED_OUT" : "FAILED";
    return `${label}:${reason}`;
  });
  const cleanupFailure = new Error(`Synthetic cleanup failed (${summaries.join(", ")}).`);
  cleanupFailure.name = "SyntheticCleanupError";
  if (primaryFailure === undefined) {
    throw new AggregateError(
      [cleanupFailure],
      "Synthetic workflow cleanup did not complete successfully."
    );
  }
  throw new AggregateError(
    [primaryFailure, cleanupFailure],
    "Synthetic workflow failed and cleanup did not complete successfully.",
    { cause: primaryFailure }
  );
}

export function parseSyntheticEmployerSnapshot(value: unknown): SyntheticEmployerSnapshot {
  return parseSyntheticEmployerSnapshotValue(value);
}
