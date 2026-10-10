import { execFileSync } from "node:child_process";

import {
  SYNTHETIC_CORRECTION_FLOW_DUMMY_CREDENTIALS,
  createSyntheticCorrectionFlowProviderFetches,
  syntheticCorrectionFlowDocumentPayload,
  syntheticCorrectionFlowMatchInput
} from "@/evaluation/correction-flow-provider-stub";
import { SYNTHETIC_CORRECTION_FLOW_FIXTURE } from "@/evaluation/correction-flow-qualification-fixture";
import { createCorrectionFlowProviderAdapter } from "@/lib/ai/correction-flow-provider-adapter";
import {
  buildCorrectionFlowQualificationManifest,
  correctionFlowQualificationConsent,
  hasDirtyCorrectionFlowQualificationWorktree
} from "@/lib/ai/correction-flow-qualification";
import { hashAiInput } from "@/lib/ai/input-hash";

function expectedHeadArgument() {
  const arguments_ = process.argv.slice(2);
  if (arguments_.length !== 1 || !arguments_[0]?.startsWith("--expected-head=")) {
    throw new Error(
      "Usage: npm run correction-flow:adapter:offline -- --expected-head=<full-git-sha>"
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
    throw new Error("Offline adapter qualification requires a clean working tree.");
  }

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
  const requestHashes: Array<{ stage: string; requestHash: string }> = [];
  const adapter = createCorrectionFlowProviderAdapter({
    manifest,
    consent,
    fixture: SYNTHETIC_CORRECTION_FLOW_FIXTURE,
    credentials: SYNTHETIC_CORRECTION_FLOW_DUMMY_CREDENTIALS,
    fetches: createSyntheticCorrectionFlowProviderFetches({
      onRequest(stage, body) {
        requestHashes.push({
          stage,
          requestHash: hashAiInput("correctionFlowProviderWire", "1", body)
        });
      }
    })
  });
  const signal = new AbortController().signal;
  const calls = [
    await adapter.scoreMatch("initial_match", syntheticCorrectionFlowMatchInput(false), signal),
    await adapter.scoreMatch("updated_match", syntheticCorrectionFlowMatchInput(true), signal),
    await adapter.tailorResume(syntheticCorrectionFlowDocumentPayload(), signal),
    await adapter.draftCoverLetter(syntheticCorrectionFlowDocumentPayload(), signal)
  ];
  const report = {
    status: "offline_adapter_ready",
    exactHead,
    manifestHash: manifest.manifestHash,
    providerMode: manifest.providerMode,
    providerCallsStarted: requestHashes.length,
    providerCallsCompleted: adapter.completedStages().length,
    completedStages: adapter.completedStages(),
    noRetryAttempted: true,
    realCredentialsRead: false,
    networkRequestsAttempted: false,
    requestHashes,
    usage: calls.map(({ metrics }) => ({
      stage: metrics.stage,
      provider: metrics.provider,
      model: metrics.model,
      promptVersion: metrics.promptVersion,
      inputTokens: metrics.inputTokens,
      outputTokens: metrics.outputTokens,
      cachedInputTokens: metrics.cachedInputTokens,
      estimatedCostMicros: metrics.estimatedCostMicros,
      mocked: metrics.mocked
    }))
  };
  const serialized = JSON.stringify(report, null, 2);
  for (const credential of Object.values(SYNTHETIC_CORRECTION_FLOW_DUMMY_CREDENTIALS)) {
    if (serialized.includes(credential)) throw new Error("Offline adapter report contains a credential.");
  }
  process.stdout.write(`${serialized}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Offline adapter qualification failed."}\n`);
  process.exitCode = 1;
});
