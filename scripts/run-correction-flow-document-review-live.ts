import { execFileSync, spawnSync } from "node:child_process";
import { closeSync, openSync, readSync, writeSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { syntheticCorrectionFlowDocumentPayload } from "@/evaluation/correction-flow-provider-stub";
import { SYNTHETIC_CORRECTION_FLOW_FIXTURE } from "@/evaluation/correction-flow-qualification-fixture";
import {
  buildCorrectionFlowDocumentReviewManifest,
  correctionFlowDocumentReviewConsent,
  createCorrectionFlowDocumentReviewRunner,
  type CorrectionFlowDocumentReviewConsent,
  type CorrectionFlowDocumentReviewManifest,
  type CorrectionFlowDocumentReviewReceipt
} from "@/lib/ai/correction-flow-document-review";
import { hasDirtyCorrectionFlowQualificationWorktree } from "@/lib/ai/correction-flow-qualification";

const preconsentFailureCodes = new Set([
  "LIVE_ARGUMENT_INVALID",
  "LIVE_RUNTIME_UNAVAILABLE",
  "LIVE_GIT_PREFLIGHT_FAILED",
  "LIVE_HEAD_MISMATCH",
  "LIVE_WORKTREE_DIRTY",
  "LIVE_HEAD_CHANGED",
  "LIVE_WORKTREE_CHANGED",
  "MANIFEST_CONSENT_INPUT_FAILED",
  "MANIFEST_CONSENT_MISMATCH"
]);

class CorrectionFlowDocumentReviewPreconsentError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "CorrectionFlowDocumentReviewPreconsentError";
    this.code = code;
  }
}

function preconsentError(code: string, message: string) {
  return new CorrectionFlowDocumentReviewPreconsentError(code, message);
}

export function correctionFlowDocumentReviewPreconsentDiagnostic(error: unknown) {
  const code = error instanceof CorrectionFlowDocumentReviewPreconsentError
    ? error.code
    : error instanceof Error && typeof (error as Error & { code?: unknown }).code === "string"
      ? (error as Error & { code: string }).code
      : null;
  return typeof code === "string" && preconsentFailureCodes.has(code)
    ? {
        status: "stopped_before_provider" as const,
        failureStage: "preconsent_preflight" as const,
        failureCode: code,
        providerCallsStarted: 0
      }
    : null;
}

type LiveExecutionInput = Readonly<{
  manifest: CorrectionFlowDocumentReviewManifest;
  consent: CorrectionFlowDocumentReviewConsent;
  credentials: Readonly<{ geminiApiKey: string }>;
  signal: AbortSignal;
  onReviewReady(review: Readonly<{ reviewUrl: string }>): void;
}>;

type LiveDependencies = Readonly<{
  assertLocalInteractiveRuntime(): void;
  gitOutput(args: string[]): string;
  now(): Date;
  write(value: string): void;
  readVisible(prompt: string): Promise<string>;
  readSecret(prompt: string): Promise<string>;
  execute(input: LiveExecutionInput): Promise<CorrectionFlowDocumentReviewReceipt>;
}>;

function expectedHeadArgument(arguments_: readonly string[]) {
  if (arguments_.length !== 1 || !arguments_[0]?.startsWith("--expected-head=")) {
    throw preconsentError(
      "LIVE_ARGUMENT_INVALID",
      "Usage: npm run correction-flow:review-documents:live -- --expected-head=<full-git-sha>"
    );
  }
  const expectedHead = arguments_[0].slice("--expected-head=".length).trim();
  if (!/^[a-f0-9]{40}$/u.test(expectedHead)) {
    throw preconsentError("LIVE_ARGUMENT_INVALID", "The expected review head must be a full Git SHA.");
  }
  return expectedHead;
}

function assertLocalInteractiveRuntime() {
  const hosted = [
    process.env.CI,
    process.env.GITHUB_ACTIONS,
    process.env.VERCEL,
    process.env.VERCEL_ENV,
    process.env.AWS_LAMBDA_FUNCTION_NAME,
    process.env.K_SERVICE
  ].some((value) => Boolean(value));
  if (process.env.NODE_ENV === "production" || hosted || !process.stdin.isTTY || !process.stderr.isTTY) {
    throw preconsentError(
      "LIVE_RUNTIME_UNAVAILABLE",
      "Live document review requires a local interactive terminal."
    );
  }
}

function gitOutput(args: string[]) {
  return execFileSync("git", args, {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  }).trim();
}

async function readTty(prompt: string, hidden: boolean) {
  const ttyFd = openSync("/dev/tty", "r+");
  let echoDisabled = false;
  const bytes: number[] = [];
  try {
    writeSync(ttyFd, prompt);
    if (hidden) {
      const disabled = spawnSync("/bin/stty", ["-echo"], { stdio: [ttyFd, ttyFd, ttyFd] });
      if (disabled.status !== 0) throw new Error("Could not mask terminal input.");
      echoDisabled = true;
    }
    const byte = Buffer.alloc(1);
    while (true) {
      const count = readSync(ttyFd, byte, 0, 1, null);
      if (count === 0 || byte[0] === 10 || byte[0] === 13) break;
      if (bytes.length >= 512) throw new Error("Terminal input exceeded the accepted bound.");
      bytes.push(byte[0]);
      byte.fill(0);
    }
  } finally {
    if (echoDisabled) spawnSync("/bin/stty", ["echo"], { stdio: [ttyFd, ttyFd, ttyFd] });
    writeSync(ttyFd, "\n");
    closeSync(ttyFd);
  }
  const buffer = Buffer.from(bytes);
  bytes.fill(0);
  const value = buffer.toString("utf8").trim();
  buffer.fill(0);
  if (!value) throw new Error("Required terminal input was empty.");
  return value;
}

const defaultDependencies: LiveDependencies = {
  assertLocalInteractiveRuntime,
  gitOutput,
  now: () => new Date(),
  write: (value) => process.stdout.write(`${value}\n`),
  readVisible: (prompt) => readTty(prompt, false),
  readSecret: (prompt) => readTty(prompt, true),
  execute: async ({ manifest, consent, credentials, signal, onReviewReady }) =>
    createCorrectionFlowDocumentReviewRunner({
      manifest,
      consent,
      payload: syntheticCorrectionFlowDocumentPayload(),
      credentials,
      onReviewReady
    }).run(signal)
};

export async function runCorrectionFlowDocumentReviewLiveLauncher(
  arguments_: readonly string[],
  dependencies: LiveDependencies = defaultDependencies
) {
  try {
    dependencies.assertLocalInteractiveRuntime();
  } catch (error) {
    if (correctionFlowDocumentReviewPreconsentDiagnostic(error)) throw error;
    throw preconsentError("LIVE_RUNTIME_UNAVAILABLE", "Live document review runtime preflight failed.");
  }
  const expectedHead = expectedHeadArgument(arguments_);
  let exactHead: string;
  let worktreeStatus: string;
  try {
    exactHead = dependencies.gitOutput(["rev-parse", "HEAD"]);
    worktreeStatus = dependencies.gitOutput(["status", "--porcelain=v1", "--untracked-files=all"]);
  } catch {
    throw preconsentError("LIVE_GIT_PREFLIGHT_FAILED", "The document review Git preflight failed.");
  }
  if (exactHead !== expectedHead) {
    throw preconsentError("LIVE_HEAD_MISMATCH", "The current Git head does not match the approved review head.");
  }
  if (hasDirtyCorrectionFlowQualificationWorktree(worktreeStatus)) {
    throw preconsentError("LIVE_WORKTREE_DIRTY", "Live document review requires a clean working tree.");
  }

  const manifest = buildCorrectionFlowDocumentReviewManifest({
    exactHead,
    providerMode: "live_synthetic",
    generatedAt: dependencies.now(),
    payload: syntheticCorrectionFlowDocumentPayload(),
    safeLabel: SYNTHETIC_CORRECTION_FLOW_FIXTURE.safeLabel
  });
  dependencies.write(JSON.stringify({
    status: "awaiting_manifest_consent",
    providerCallsStarted: 0,
    safeManifest: manifest
  }, null, 2));

  let approval: string;
  try {
    approval = await dependencies.readVisible(
      "Type the exact manifest hash to approve two synthetic Gemini calls and the 15-minute local review: "
    );
  } catch {
    throw preconsentError(
      "MANIFEST_CONSENT_INPUT_FAILED",
      "Manifest consent input could not be read; no credential was requested and no provider call started."
    );
  }
  if (approval !== manifest.manifestHash) {
    throw preconsentError(
      "MANIFEST_CONSENT_MISMATCH",
      "Manifest consent did not match; no credential was requested and no provider call started."
    );
  }
  const consent = correctionFlowDocumentReviewConsent.parse({
    manifestHash: manifest.manifestHash,
    exactHead,
    providerMode: manifest.providerMode,
    approvedCallCount: 2,
    approvedConservativeReservationMicros: manifest.conservativeReservationMicros,
    approvedStepTimeoutMs: manifest.stepTimeoutMs,
    syntheticApplicantDataSharingApproved: true,
    existingCredentialUseApproved: true,
    noRetry: true,
    noFallback: true,
    stopAfterFirstFailure: true,
    noOwnerData: true,
    noProductionWrites: true,
    noDatabaseWrites: true,
    noEmployerInteraction: true,
    noJobMatchCalls: true,
    rawProviderOutputRetention: false,
    validatedDocumentPersistentRetention: false,
    validatedDocumentLocalDisplay: true,
    validatedDocumentLifetimeMs: 900_000,
    safeReceiptOnly: true,
    approvedAt: dependencies.now().toISOString()
  });

  const controller = new AbortController();
  const cancel = () => controller.abort(Object.assign(new Error("Document review cancelled."), {
    code: "EXECUTION_CANCELLED"
  }));
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  let geminiApiKey = "";
  try {
    geminiApiKey = await dependencies.readSecret("Existing Gemini API key (input hidden): ");
    let currentHead: string;
    let currentWorktreeStatus: string;
    try {
      currentHead = dependencies.gitOutput(["rev-parse", "HEAD"]);
      currentWorktreeStatus = dependencies.gitOutput(["status", "--porcelain=v1", "--untracked-files=all"]);
    } catch {
      throw preconsentError(
        "LIVE_GIT_PREFLIGHT_FAILED",
        "The document review Git pre-dispatch recheck failed; no provider call started."
      );
    }
    if (currentHead !== exactHead) {
      throw preconsentError(
        "LIVE_HEAD_CHANGED",
        "The document review Git head changed after consent; no provider call started."
      );
    }
    if (hasDirtyCorrectionFlowQualificationWorktree(currentWorktreeStatus)) {
      throw preconsentError(
        "LIVE_WORKTREE_CHANGED",
        "The document review worktree changed after consent; no provider call started."
      );
    }
    const receipt = await dependencies.execute({
      manifest,
      consent,
      credentials: { geminiApiKey },
      signal: controller.signal,
      onReviewReady(review) {
        if (!/^http:\/\/127\.0\.0\.1:\d+\/review\/[A-Za-z0-9_-]+$/u.test(review.reviewUrl)) {
          throw new Error("Document review URL was not an exact tokenized loopback URL.");
        }
        dependencies.write(review.reviewUrl);
      }
    });
    const serialized = JSON.stringify({ status: receipt.status, receipt }, null, 2);
    if (serialized.includes(geminiApiKey)) throw new Error("Document review receipt contained a credential.");
    dependencies.write(serialized);
    return receipt.status === "approved" || receipt.status === "needs_revision" ? 0 : 1;
  } finally {
    geminiApiKey = "";
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCorrectionFlowDocumentReviewLiveLauncher(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  }).catch((error) => {
    const diagnostic = correctionFlowDocumentReviewPreconsentDiagnostic(error);
    process.stderr.write(diagnostic
      ? `${JSON.stringify(diagnostic, null, 2)}\n`
      : `${JSON.stringify({
          status: "stopped",
          failureStage: "live_review_launcher",
          failureCode: "LIVE_REVIEW_LAUNCHER_FAILED"
        }, null, 2)}\n`);
    process.exitCode = 1;
  });
}
