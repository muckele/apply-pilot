import { spawn, type ChildProcess } from "node:child_process";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";

const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 250;
const DEFAULT_GRACEFUL_STOP_TIMEOUT_MS = 5_000;
const DEFAULT_FORCE_STOP_TIMEOUT_MS = 2_000;
const DEFAULT_MAX_LOG_CHARACTERS = 32_768;
const MAX_STARTUP_TIMEOUT_MS = 60_000;
const MAX_POLL_INTERVAL_MS = 5_000;
const MAX_GRACEFUL_STOP_TIMEOUT_MS = 30_000;
const MAX_FORCE_STOP_TIMEOUT_MS = 10_000;
const MAX_LOG_CHARACTERS = 1_048_576;

type ReadinessResponse = Readonly<{ status: number }>;

export type NextTestServerChildState = Readonly<{
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  spawnError: Error | undefined;
}>;

export type NextTestServer = Readonly<{
  origin: `http://127.0.0.1:${number}`;
  getLogs(): string;
  stop(): Promise<void>;
}>;

export type StartNextTestServerOptions = Readonly<{
  cwd?: string;
  environment?: Readonly<Record<string, string | undefined>>;
  readinessPath?: string;
  startupTimeoutMs?: number;
  pollIntervalMs?: number;
  gracefulStopTimeoutMs?: number;
  forceStopTimeoutMs?: number;
  maxLogCharacters?: number;
}>;

export class NextTestServerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NextTestServerError";
  }
}

function assertBoundedPositiveInteger(value: number, name: string, maximum: number): void {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1 || value > maximum) {
    throw new NextTestServerError(
      `Next test server ${name} must be a finite positive integer no greater than ${maximum}.`
    );
  }
}

async function readNextEnvironmentFileState(pathname: string): Promise<Buffer | undefined> {
  try {
    return await readFile(pathname);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function sameNextEnvironmentFileState(left: Buffer | undefined, right: Buffer | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.equals(right);
}

export async function captureNextEnvironmentFile(repositoryRoot: string): Promise<Readonly<{
  recordGeneratedState(): Promise<void>;
  restore(): Promise<void>;
}>> {
  const pathname = path.join(repositoryRoot, "next-env.d.ts");
  const original = await readNextEnvironmentFileState(pathname);

  let generated: Buffer | undefined;
  let generatedStateRecorded = false;
  let recordPromise: Promise<void> | undefined;
  let restorePromise: Promise<void> | undefined;
  return Object.freeze({
    recordGeneratedState: () => {
      if (restorePromise) {
        return Promise.reject(new NextTestServerError("Next environment restoration has already started."));
      }
      recordPromise ??= (async () => {
        generated = await readNextEnvironmentFileState(pathname);
        generatedStateRecorded = true;
      })();
      return recordPromise;
    },
    restore: () => {
      restorePromise ??= (async () => {
        if (recordPromise) await recordPromise;
        const current = await readNextEnvironmentFileState(pathname);
        if (sameNextEnvironmentFileState(current, original)) return;
        if (!generatedStateRecorded || !sameNextEnvironmentFileState(current, generated)) {
          throw new NextTestServerError(
            "next-env.d.ts changed after Next startup; refusing to overwrite concurrent changes."
          );
        }
        if (original) {
          await writeFile(pathname, original);
          return;
        }
        await unlink(pathname).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        });
      })();
      return restorePromise;
    }
  });
}

export function buildNextTestServerOrigin(port: number): `http://127.0.0.1:${number}` {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new NextTestServerError("Next test server requires a valid ephemeral TCP port.");
  }
  return `http://127.0.0.1:${port}`;
}

export async function reserveNextTestServerPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
      server.off("error", onError);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new NextTestServerError("Next test server failed to reserve a loopback TCP port.");
  }

  const port = address.port;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

export function appendBoundedNextServerLog(current: string, chunk: string, maxCharacters: number): string {
  assertBoundedPositiveInteger(maxCharacters, "log bound", MAX_LOG_CHARACTERS);
  return `${current}${chunk}`.slice(-maxCharacters);
}

export function resolveNextTestServerEnvironment(
  explicitEnvironment: Readonly<Record<string, string | undefined>> | undefined,
  parentEnvironment: Readonly<Record<string, string | undefined>> = process.env
): NodeJS.ProcessEnv {
  return { ...(explicitEnvironment ?? parentEnvironment) } as NodeJS.ProcessEnv;
}

function boundedFailureLogs(getLogs: () => string, maxCharacters: number): string {
  const logs = getLogs().slice(-maxCharacters);
  return logs.length > 0 ? `\n${logs}` : "";
}

function defaultDelay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function requestWithDeadline(
  request: (url: string, init: RequestInit) => Promise<ReadinessResponse>,
  url: string,
  timeoutMs: number
): Promise<ReadinessResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await request(url, { redirect: "manual", signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function waitForNextTestServerReadiness(options: Readonly<{
  origin: string;
  childState(): NextTestServerChildState;
  getLogs(): string;
  request?: (url: string, init: RequestInit) => Promise<ReadinessResponse>;
  now?: () => number;
  delay?: (milliseconds: number) => Promise<void>;
  timeoutMs?: number;
  pollIntervalMs?: number;
  maxFailureLogCharacters?: number;
}>): Promise<void> {
  const request = options.request ?? ((url, init) => fetch(url, init));
  const now = options.now ?? Date.now;
  const delay = options.delay ?? defaultDelay;
  const timeoutMs = options.timeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const maxFailureLogCharacters = options.maxFailureLogCharacters ?? DEFAULT_MAX_LOG_CHARACTERS;
  assertBoundedPositiveInteger(timeoutMs, "startup timeout", MAX_STARTUP_TIMEOUT_MS);
  assertBoundedPositiveInteger(pollIntervalMs, "poll interval", MAX_POLL_INTERVAL_MS);
  assertBoundedPositiveInteger(maxFailureLogCharacters, "failure-log bound", MAX_LOG_CHARACTERS);

  const deadline = now() + timeoutMs;
  while (true) {
    const state = options.childState();
    if (state.spawnError) {
      throw new NextTestServerError(
        `Next server failed to start.${boundedFailureLogs(options.getLogs, maxFailureLogCharacters)}`
      );
    }
    if (state.exitCode !== null || state.signalCode !== null) {
      const disposition = state.exitCode !== null ? `with code ${state.exitCode}` : `from signal ${state.signalCode}`;
      throw new NextTestServerError(
        `Next server exited before becoming ready ${disposition}.${boundedFailureLogs(
          options.getLogs,
          maxFailureLogCharacters
        )}`
      );
    }

    const remainingMs = deadline - now();
    if (remainingMs <= 0) {
      throw new NextTestServerError(
        `Timed out waiting for Next server.${boundedFailureLogs(options.getLogs, maxFailureLogCharacters)}`
      );
    }

    try {
      const response = await requestWithDeadline(request, options.origin, Math.max(1, remainingMs));
      if (response.status > 0) return;
    } catch {
      // Readiness remains false until the known loopback route responds or the bounded deadline expires.
    }

    const afterRequestMs = deadline - now();
    if (afterRequestMs <= 0) {
      throw new NextTestServerError(
        `Timed out waiting for Next server.${boundedFailureLogs(options.getLogs, maxFailureLogCharacters)}`
      );
    }
    await delay(Math.min(pollIntervalMs, afterRequestMs));
  }
}

function childHasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

async function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (childHasExited(child)) return true;
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (exited: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("close", onClose);
      resolve(exited);
    };
    const onClose = () => finish(true);
    const timer = setTimeout(() => finish(childHasExited(child)), timeoutMs);
    child.once("close", onClose);
    if (childHasExited(child)) finish(true);
  });
}

export async function stopNextTestServerChild(
  child: ChildProcess,
  options: Readonly<{ gracefulTimeoutMs?: number; forceTimeoutMs?: number }> = {}
): Promise<void> {
  const gracefulTimeoutMs = options.gracefulTimeoutMs ?? DEFAULT_GRACEFUL_STOP_TIMEOUT_MS;
  const forceTimeoutMs = options.forceTimeoutMs ?? DEFAULT_FORCE_STOP_TIMEOUT_MS;
  assertBoundedPositiveInteger(
    gracefulTimeoutMs,
    "graceful shutdown timeout",
    MAX_GRACEFUL_STOP_TIMEOUT_MS
  );
  assertBoundedPositiveInteger(forceTimeoutMs, "forced shutdown timeout", MAX_FORCE_STOP_TIMEOUT_MS);
  if (childHasExited(child)) return;

  child.kill("SIGTERM");
  if (await waitForChildExit(child, gracefulTimeoutMs)) return;

  child.kill("SIGKILL");
  if (await waitForChildExit(child, forceTimeoutMs)) return;
  throw new NextTestServerError("Next test server did not exit within its bounded shutdown deadline.");
}

export async function startNextTestServer(options: StartNextTestServerOptions = {}): Promise<NextTestServer> {
  const startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const gracefulStopTimeoutMs = options.gracefulStopTimeoutMs ?? DEFAULT_GRACEFUL_STOP_TIMEOUT_MS;
  const forceStopTimeoutMs = options.forceStopTimeoutMs ?? DEFAULT_FORCE_STOP_TIMEOUT_MS;
  const maxLogCharacters = options.maxLogCharacters ?? DEFAULT_MAX_LOG_CHARACTERS;
  assertBoundedPositiveInteger(startupTimeoutMs, "startup timeout", MAX_STARTUP_TIMEOUT_MS);
  assertBoundedPositiveInteger(pollIntervalMs, "poll interval", MAX_POLL_INTERVAL_MS);
  assertBoundedPositiveInteger(
    gracefulStopTimeoutMs,
    "graceful shutdown timeout",
    MAX_GRACEFUL_STOP_TIMEOUT_MS
  );
  assertBoundedPositiveInteger(forceStopTimeoutMs, "forced shutdown timeout", MAX_FORCE_STOP_TIMEOUT_MS);
  assertBoundedPositiveInteger(maxLogCharacters, "log bound", MAX_LOG_CHARACTERS);

  const cwd = options.cwd ?? process.cwd();
  const nextEnvironmentFile = await captureNextEnvironmentFile(cwd);
  const port = await reserveNextTestServerPort();
  const origin = buildNextTestServerOrigin(port);
  let logs = "";
  let spawnError: Error | undefined;

  let child: ChildProcess;
  try {
    child = spawn(
      process.execPath,
      [
        path.join("node_modules", "next", "dist", "bin", "next"),
        "dev",
        "--hostname",
        "127.0.0.1",
        "--port",
        String(port)
      ],
      {
        cwd,
        env: resolveNextTestServerEnvironment(options.environment),
        shell: false,
        stdio: ["ignore", "pipe", "pipe"]
      }
    );
  } catch {
    await nextEnvironmentFile.restore();
    throw new NextTestServerError("Next test server process could not be created.");
  }

  child.once("error", (error) => {
    spawnError = error;
  });
  const capture = (chunk: Buffer | string) => {
    logs = appendBoundedNextServerLog(logs, chunk.toString(), maxLogCharacters);
  };
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);

  try {
    const readinessPath = options.readinessPath ?? "/";
    if (!readinessPath.startsWith("/") || readinessPath.startsWith("//")) {
      throw new NextTestServerError("Next test server readiness path must be same-origin.");
    }
    await waitForNextTestServerReadiness({
      origin: `${origin}${readinessPath}`,
      childState: () => ({ exitCode: child.exitCode, signalCode: child.signalCode, spawnError }),
      getLogs: () => logs,
      timeoutMs: startupTimeoutMs,
      pollIntervalMs,
      maxFailureLogCharacters: maxLogCharacters
    });
    await nextEnvironmentFile.recordGeneratedState();
  } catch (startupError) {
    let cleanupFailed = false;
    try {
      await stopNextTestServerChild(child, {
        gracefulTimeoutMs: gracefulStopTimeoutMs,
        forceTimeoutMs: forceStopTimeoutMs
      });
    } catch {
      cleanupFailed = true;
    }
    try {
      await nextEnvironmentFile.restore();
    } catch {
      cleanupFailed = true;
    }
    if (cleanupFailed) throw new NextTestServerError("Next test server startup and bounded cleanup both failed.");
    throw startupError;
  }

  let stopPromise: Promise<void> | undefined;
  return Object.freeze({
    origin,
    getLogs: () => logs,
    stop: () => {
      stopPromise ??= (async () => {
        let stopError: unknown;
        try {
          await stopNextTestServerChild(child, {
            gracefulTimeoutMs: gracefulStopTimeoutMs,
            forceTimeoutMs: forceStopTimeoutMs
          });
        } catch (error) {
          stopError = error;
        }
        try {
          await nextEnvironmentFile.restore();
        } catch {
          throw new NextTestServerError("Next test server stopped but its generated environment file was not restored.");
        }
        if (stopError) throw stopError;
      })();
      return stopPromise;
    }
  });
}
