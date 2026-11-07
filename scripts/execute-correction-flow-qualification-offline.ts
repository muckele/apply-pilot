import { execFileSync } from "node:child_process";

import {
  SYNTHETIC_CORRECTION_FLOW_DUMMY_CREDENTIALS,
  createSyntheticCorrectionFlowProviderFetches
} from "@/evaluation/correction-flow-provider-stub";
import { SYNTHETIC_CORRECTION_FLOW_FIXTURE } from "@/evaluation/correction-flow-qualification-fixture";
import { runDurableCorrectionFlowQualification } from "@/lib/ai/correction-flow-durable-driver";
import {
  buildCorrectionFlowQualificationManifest,
  correctionFlowQualificationConsent,
  hasDirtyCorrectionFlowQualificationWorktree
} from "@/lib/ai/correction-flow-qualification";
import { assertCorrectionFlowLiveDatabaseEnvironment } from "@/scripts/run-correction-flow-qualification-live";
import {
  assertPostgresTestMajorVersion,
  verifyLivePostgresTestDatabase
} from "@/tests/postgres/postgres-test-harness";

function expectedHeadArgument() {
  const arguments_ = process.argv.slice(2);
  if (arguments_.length !== 1 || !arguments_[0]?.startsWith("--expected-head=")) {
    throw new Error(
      "Usage: npm run correction-flow:qualify:offline -- --expected-head=<full-git-sha>"
    );
  }
  const expectedHead = arguments_[0].slice("--expected-head=".length).trim();
  if (!/^[a-f0-9]{40}$/u.test(expectedHead)) {
    throw new Error("The expected qualification head must be a full Git SHA.");
  }
  return expectedHead;
}

function gitOutput(arguments_: string[]) {
  return execFileSync("git", arguments_, {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  }).trim();
}

async function main() {
  const expectedHead = expectedHeadArgument();
  const exactHead = gitOutput(["rev-parse", "HEAD"]);
  if (exactHead !== expectedHead) {
    throw new Error("The current Git head does not match the expected offline qualification head.");
  }
  if (hasDirtyCorrectionFlowQualificationWorktree(
    gitOutput(["status", "--porcelain=v1", "--untracked-files=normal"])
  )) {
    throw new Error("Offline durable qualification requires a clean working tree.");
  }
  const database = assertCorrectionFlowLiveDatabaseEnvironment(process.env);
  const live = await verifyLivePostgresTestDatabase(database);
  assertPostgresTestMajorVersion(live);
  const manifest = buildCorrectionFlowQualificationManifest({
    exactHead,
    providerMode: "offline_stubbed",
    generatedAt: new Date(),
    fixture: SYNTHETIC_CORRECTION_FLOW_FIXTURE
  });
  const consent = correctionFlowQualificationConsent.parse({
    manifestHash: manifest.manifestHash,
    exactHead,
    providerMode: manifest.providerMode,
    approvedCallCount: manifest.callCount,
    approvedConservativeReservationMicros: manifest.conservativeReservationMicros,
    approvedStepTimeoutMs: manifest.stepTimeoutMs,
    syntheticApplicantDataSharingApproved: true,
    existingCredentialUseApproved: false,
    noRetry: true,
    noOwnerData: true,
    noProductionWrites: true,
    noEmployerInteraction: true,
    cleanupRequired: true,
    approvedAt: new Date().toISOString()
  });
  const receipt = await runDurableCorrectionFlowQualification({
    databaseUrl: database.url,
    manifest,
    consent,
    credentials: SYNTHETIC_CORRECTION_FLOW_DUMMY_CREDENTIALS,
    fetches: createSyntheticCorrectionFlowProviderFetches()
  });
  const report = {
    status: receipt.status === "passed" && receipt.cleanupStatus === "completed"
      ? "offline_durable_qualification_passed"
      : "offline_durable_qualification_stopped",
    exactHead,
    database: {
      name: live.databaseName,
      serverMajorVersion: live.serverMajorVersion,
      localDisposableOnly: true
    },
    realCredentialsRead: false,
    networkRequestsAttempted: false,
    receipt
  };
  const serialized = JSON.stringify(report, null, 2);
  for (const credential of Object.values(SYNTHETIC_CORRECTION_FLOW_DUMMY_CREDENTIALS)) {
    if (serialized.includes(credential)) throw new Error("Offline durable report contains a credential.");
  }
  process.stdout.write(`${serialized}\n`);
  if (receipt.status !== "passed" || receipt.cleanupStatus !== "completed") process.exitCode = 1;
}

main().catch(() => {
  process.stderr.write("Offline durable correction-flow qualification failed safely.\n");
  process.exitCode = 1;
});
