import { execFileSync, spawnSync } from "node:child_process";
import { closeSync, openSync, readSync, writeSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { SYNTHETIC_CORRECTION_FLOW_FIXTURE } from "@/evaluation/correction-flow-qualification-fixture";
import type { CorrectionFlowProviderCredentials } from "@/lib/ai/correction-flow-provider-adapter";
import { runDurableCorrectionFlowQualification } from "@/lib/ai/correction-flow-durable-driver";
import {
  buildCorrectionFlowQualificationManifest,
  correctionFlowQualificationConsent,
  hasDirtyCorrectionFlowQualificationWorktree,
  type CorrectionFlowQualificationConsent,
  type CorrectionFlowQualificationManifest,
  type CorrectionFlowQualificationReceipt
} from "@/lib/ai/correction-flow-qualification";
import {
  assertPostgresTestMajorVersion,
  validatePostgresTestEnvironment,
  verifyLivePostgresTestDatabase,
  type PostgresTestEnvironment,
  type ValidatedPostgresTestConfig
} from "@/tests/postgres/postgres-test-harness";

type SafeDatabaseIdentity = Readonly<{
  databaseUrl: string;
  databaseName: string;
  serverMajorVersion: number;
}>;

type LiveExecutionInput = Readonly<{
  databaseUrl: string;
  manifest: CorrectionFlowQualificationManifest;
  consent: CorrectionFlowQualificationConsent;
  credentials: CorrectionFlowProviderCredentials;
  fixture: typeof SYNTHETIC_CORRECTION_FLOW_FIXTURE;
  signal: AbortSignal;
}>;

type LiveLauncherDependencies = Readonly<{
  assertLocalInteractiveRuntime(): void;
  gitOutput(args: string[]): string;
  now(): Date;
  verifyDatabase(): Promise<SafeDatabaseIdentity>;
  write(value: string): void;
  readVisible(prompt: string): Promise<string>;
  readSecret(prompt: string): Promise<string>;
  execute(input: LiveExecutionInput): Promise<CorrectionFlowQualificationReceipt>;
}>;

function expectedHeadArgument(arguments_: readonly string[]) {
  if (arguments_.length !== 1 || !arguments_[0]?.startsWith("--expected-head=")) {
    throw new Error(
      "Usage: npm run correction-flow:qualify:live -- --expected-head=<full-git-sha>"
    );
  }
  const expectedHead = arguments_[0].slice("--expected-head=".length).trim();
  if (!/^[a-f0-9]{40}$/u.test(expectedHead)) {
    throw new Error("The expected qualification head must be a full Git SHA.");
  }
  return expectedHead;
}

export function assertCorrectionFlowLiveDatabaseEnvironment(
  environment: PostgresTestEnvironment
): ValidatedPostgresTestConfig {
  const config = validatePostgresTestEnvironment(environment);
  for (const name of ["DATABASE_URL", "DIRECT_URL"] as const) {
    const value = environment[name];
    if (!value) throw new Error(`${name} is required for live correction-flow qualification.`);
    if (value !== config.url) {
      throw new Error(`${name} must exactly match TEST_DATABASE_URL for live correction-flow qualification.`);
    }
  }
  return config;
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
  if (process.env.NODE_ENV === "production" || hosted ||
    !process.stdin.isTTY || !process.stderr.isTTY) {
    throw new Error("Live correction-flow qualification requires a local interactive terminal.");
  }
}

function gitOutput(args: string[]) {
  return execFileSync("git", args, {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  }).trim();
}

async function verifyDatabase(): Promise<SafeDatabaseIdentity> {
  const config = assertCorrectionFlowLiveDatabaseEnvironment(process.env);
  const live = await verifyLivePostgresTestDatabase(config);
  assertPostgresTestMajorVersion(live);
  return {
    databaseUrl: config.url,
    databaseName: live.databaseName,
    serverMajorVersion: live.serverMajorVersion
  };
}

async function readTty(prompt: string, hidden: boolean) {
  const ttyFd = openSync("/dev/tty", "r+");
  let echoDisabled = false;
  const bytes: number[] = [];
  try {
    writeSync(ttyFd, prompt);
    if (hidden) {
      const disabled = spawnSync("/bin/stty", ["-echo"], {
        stdio: [ttyFd, ttyFd, ttyFd]
      });
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
    if (echoDisabled) {
      spawnSync("/bin/stty", ["echo"], { stdio: [ttyFd, ttyFd, ttyFd] });
    }
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

const defaultDependencies: LiveLauncherDependencies = {
  assertLocalInteractiveRuntime,
  gitOutput,
  now: () => new Date(),
  verifyDatabase,
  write: (value) => process.stdout.write(`${value}\n`),
  readVisible: (prompt) => readTty(prompt, false),
  readSecret: (prompt) => readTty(prompt, true),
  execute: ({ databaseUrl, manifest, consent, credentials, signal }) =>
    runDurableCorrectionFlowQualification({
      databaseUrl,
      manifest,
      consent,
      credentials,
      signal
    })
};

export async function runCorrectionFlowLiveLauncher(
  arguments_: readonly string[],
  dependencies: LiveLauncherDependencies = defaultDependencies
) {
  dependencies.assertLocalInteractiveRuntime();
  const expectedHead = expectedHeadArgument(arguments_);
  const exactHead = dependencies.gitOutput(["rev-parse", "HEAD"]);
  if (exactHead !== expectedHead) {
    throw new Error("The current Git head does not match the approved qualification head.");
  }
  const worktreeStatus = dependencies.gitOutput([
    "status",
    "--porcelain=v1",
    "--untracked-files=all"
  ]);
  if (hasDirtyCorrectionFlowQualificationWorktree(worktreeStatus)) {
    throw new Error("Live correction-flow qualification requires a clean working tree.");
  }

  const database = await dependencies.verifyDatabase();
  const generatedAt = dependencies.now();
  const manifest = buildCorrectionFlowQualificationManifest({
    exactHead,
    providerMode: "live_synthetic",
    generatedAt,
    fixture: SYNTHETIC_CORRECTION_FLOW_FIXTURE
  });
  dependencies.write(JSON.stringify({
    status: "awaiting_manifest_consent",
    providerCallsStarted: 0,
    database: {
      name: database.databaseName,
      serverMajorVersion: database.serverMajorVersion,
      localDisposableOnly: true
    },
    safeManifest: manifest
  }, null, 2));

  const approval = await dependencies.readVisible(
    "Type the exact manifest hash to approve the displayed data sharing, existing-key use, " +
      "four calls, and conservative cost reservation: "
  );
  if (approval !== manifest.manifestHash) {
    throw new Error("Manifest consent did not match; no credential was requested and no provider call started.");
  }
  const consent = correctionFlowQualificationConsent.parse({
    manifestHash: manifest.manifestHash,
    exactHead,
    providerMode: manifest.providerMode,
    approvedCallCount: manifest.callCount,
    approvedConservativeReservationMicros: manifest.conservativeReservationMicros,
    approvedStepTimeoutMs: manifest.stepTimeoutMs,
    syntheticApplicantDataSharingApproved: true,
    existingCredentialUseApproved: true,
    noRetry: true,
    noOwnerData: true,
    noProductionWrites: true,
    noEmployerInteraction: true,
    cleanupRequired: true,
    approvedAt: dependencies.now().toISOString()
  });

  const controller = new AbortController();
  const cancel = () => controller.abort(Object.assign(new Error("Qualification cancelled."), {
    code: "EXECUTION_CANCELLED"
  }));
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  let geminiApiKey = "";
  let openAiApiKey = "";
  try {
    geminiApiKey = await dependencies.readSecret("Existing Gemini API key (input hidden): ");
    openAiApiKey = await dependencies.readSecret("Existing OpenAI API key (input hidden): ");
    const receipt = await dependencies.execute({
      databaseUrl: database.databaseUrl,
      manifest,
      consent,
      credentials: { geminiApiKey, openAiApiKey },
      fixture: SYNTHETIC_CORRECTION_FLOW_FIXTURE,
      signal: controller.signal
    });
    const serialized = JSON.stringify({ status: receipt.status, receipt }, null, 2);
    if (serialized.includes(geminiApiKey) || serialized.includes(openAiApiKey)) {
      throw new Error("Qualification receipt contained a credential and was not emitted.");
    }
    dependencies.write(serialized);
    return receipt.status === "passed" && receipt.cleanupStatus === "completed" ? 0 : 1;
  } finally {
    geminiApiKey = "";
    openAiApiKey = "";
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCorrectionFlowLiveLauncher(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  }).catch(() => {
    process.stderr.write(
      "Live correction-flow qualification stopped before a privacy-safe receipt was produced.\n"
    );
    process.exitCode = 1;
  });
}
