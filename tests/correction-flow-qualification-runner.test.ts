import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildCorrectionFlowQualificationManifest,
  correctionFlowQualificationConsent,
  hasDirtyCorrectionFlowQualificationWorktree,
  runCorrectionFlowQualification,
  type CorrectionFlowQualificationDriver,
  type CorrectionFlowProviderCallMetrics
} from "@/lib/ai/correction-flow-qualification";
import { estimateAiCostMicros } from "@/lib/ai/pricing";

const exactHead = "68a05e6c24b3be7efdd3471fc4b1ae9222363b8b";
const privateSentinel = "SYNTHETIC PRIVATE FIXTURE MUST STAY OUT OF RECEIPTS";

function manifest(providerMode: "offline_stubbed" | "live_synthetic" = "offline_stubbed") {
  return buildCorrectionFlowQualificationManifest({
    exactHead,
    providerMode,
    generatedAt: new Date("2026-10-09T02:00:00.000Z"),
    fixture: {
      safeLabel: "Synthetic correction-flow fixture",
      job: { description: `${privateSentinel}: job`, requirements: ["Quenby certification"] },
      resume: { rawText: `${privateSentinel}: resume` },
      profile: { careerGoals: `${privateSentinel}: profile` },
      predeterminedCorrection: {
        kind: "OWNER_ATTESTATION",
        fact: `${privateSentinel}: correction`,
        reuseScope: "JOB_ONLY",
        masterProfileOptIn: false
      }
    }
  });
}

function consentFor(value: ReturnType<typeof manifest>) {
  return correctionFlowQualificationConsent.parse({
    manifestHash: value.manifestHash,
    exactHead: value.exactHead,
    providerMode: value.providerMode,
    approvedCallCount: 4,
    approvedConservativeReservationMicros: 166_740,
    approvedStepTimeoutMs: 180_000,
    syntheticApplicantDataSharingApproved: true,
    existingCredentialUseApproved: value.providerMode === "live_synthetic",
    noRetry: true,
    noOwnerData: true,
    noProductionWrites: true,
    noEmployerInteraction: true,
    cleanupRequired: true,
    approvedAt: "2026-10-09T02:05:00.000Z"
  });
}

function metrics(
  stage: CorrectionFlowProviderCallMetrics["stage"],
  overrides: Partial<CorrectionFlowProviderCallMetrics> = {}
): CorrectionFlowProviderCallMetrics {
  const plan = manifest().calls.find((entry) => entry.stage === stage)!;
  const inputTokens = overrides.inputTokens ?? 100;
  const outputTokens = overrides.outputTokens ?? 50;
  const cachedInputTokens = overrides.cachedInputTokens ?? 0;
  return {
    stage,
    provider: plan.provider,
    model: plan.model,
    promptVersion: plan.promptVersion,
    inputTokens,
    outputTokens,
    cachedInputTokens,
    estimatedCostMicros: estimateAiCostMicros({
      model: plan.model,
      inputTokens,
      outputTokens,
      cachedInputTokens
    }),
    billingStatus: "known",
    providerCompleted: true,
    mocked: true,
    ...overrides
  };
}

function successfulDriver(events: string[]): CorrectionFlowQualificationDriver {
  return {
    async initialMatch() {
      events.push("initial_match");
      return metrics("initial_match");
    },
    async applyPredeterminedCorrection() {
      events.push("apply_correction");
    },
    async updatedMatch() {
      events.push("updated_match");
      return metrics("updated_match");
    },
    async generateResume() {
      events.push("tailored_resume");
      return metrics("tailored_resume");
    },
    async generateCoverLetter() {
      events.push("cover_letter");
      return metrics("cover_letter");
    },
    async verifyExports() {
      events.push("verify_exports");
      return {
        resume: {
          currentEvidenceSnapshotBound: true,
          correctionPresent: true,
          supersededFactAbsent: true,
          unsupportedClaimsAbsent: true,
          generatedContentSha256: "a".repeat(64),
          exportedTextSha256: "b".repeat(64)
        },
        coverLetter: {
          currentEvidenceSnapshotBound: true,
          correctionPresent: true,
          supersededFactAbsent: true,
          unsupportedClaimsAbsent: true,
          generatedContentSha256: "c".repeat(64),
          exportedTextSha256: "d".repeat(64)
        }
      };
    },
    async cleanup() {
      events.push("cleanup");
    }
  };
}

test("the synthetic correction manifest pins four calls and exposes hashes and categories only", () => {
  const value = manifest("live_synthetic");

  assert.equal(value.exactHead, exactHead);
  assert.equal(value.callCount, 4);
  assert.equal(value.conservativeReservationMicros, 166_740);
  assert.equal(value.stepTimeoutMs, 180_000);
  assert.deepEqual(value.calls.map((entry) => [entry.stage, entry.provider, entry.model, entry.maximumCostMicros]), [
    ["initial_match", "google-gemini-developer-api", "gemini-3.8-flash", 72_720],
    ["updated_match", "google-gemini-developer-api", "gemini-3.8-flash", 72_720],
    ["tailored_resume", "openai-api", "gpt-4o-mini", 12_000],
    ["cover_letter", "openai-api", "gpt-4o-mini", 9_300]
  ]);
  assert.deepEqual(value.dataCategories, [
    "synthetic_job_projection",
    "synthetic_resume_projection_including_raw_text",
    "synthetic_profile_preferences",
    "synthetic_job_only_reviewed_evidence"
  ]);
  assert.match(value.fixture.jobProjectionHash, /^[a-f0-9]{64}$/u);
  assert.match(value.fixture.resumeProjectionHash, /^[a-f0-9]{64}$/u);
  assert.match(value.fixture.profileProjectionHash, /^[a-f0-9]{64}$/u);
  assert.match(value.fixture.correctionHash, /^[a-f0-9]{64}$/u);
  assert.match(value.manifestHash, /^[a-f0-9]{64}$/u);
  assert.doesNotMatch(JSON.stringify(value), new RegExp(privateSentinel, "u"));
});

test("consent mismatches fail closed before any driver method or cleanup runs", async () => {
  const value = manifest();
  const events: string[] = [];
  const invalid = { ...consentFor(value), approvedCallCount: 3 };

  await assert.rejects(
    runCorrectionFlowQualification({ manifest: value, consent: invalid, driver: successfulDriver(events) }),
    /consent/i
  );
  assert.deepEqual(events, []);
});

test("the runner performs the fixed sequence once, verifies exports, cleans up, and returns a redacted receipt", async () => {
  const value = manifest();
  const events: string[] = [];

  const receipt = await runCorrectionFlowQualification({
    manifest: value,
    consent: consentFor(value),
    driver: successfulDriver(events)
  });

  assert.deepEqual(events, [
    "initial_match",
    "apply_correction",
    "updated_match",
    "tailored_resume",
    "cover_letter",
    "verify_exports",
    "cleanup"
  ]);
  assert.equal(receipt.status, "passed");
  assert.equal(receipt.providerCallsStarted, 4);
  assert.equal(receipt.providerCallsCompleted, 4);
  assert.equal(receipt.noRetryAttempted, true);
  assert.equal(receipt.knownEstimatedCostMicros, 616);
  assert.equal(receipt.conservativeReservationMicros, 166_740);
  assert.equal(receipt.cleanupStatus, "completed");
  assert.equal(receipt.exportVerification?.resume.correctionPresent, true);
  assert.equal(receipt.exportVerification?.coverLetter.correctionPresent, true);
  assert.doesNotMatch(JSON.stringify(receipt), new RegExp(privateSentinel, "u"));
});

test("a provider failure stops later calls without retry and still cleans up", async () => {
  const value = manifest();
  const events: string[] = [];
  const driver = successfulDriver(events);
  driver.updatedMatch = async () => {
    events.push("updated_match");
    throw Object.assign(new Error(`${privateSentinel}: provider failure`), {
      code: "PROVIDER_REJECTED",
      billingStatus: "uncertain"
    });
  };

  const receipt = await runCorrectionFlowQualification({
    manifest: value,
    consent: consentFor(value),
    driver
  });

  assert.deepEqual(events, ["initial_match", "apply_correction", "updated_match", "cleanup"]);
  assert.equal(receipt.status, "stopped");
  assert.equal(receipt.failureStage, "updated_match");
  assert.equal(receipt.failureCode, "PROVIDER_REJECTED");
  assert.equal(receipt.providerCallsStarted, 2);
  assert.equal(receipt.providerCallsCompleted, 1);
  assert.equal(receipt.unknownBillingCallCount, 1);
  assert.equal(receipt.noRetryAttempted, true);
  assert.equal(receipt.cleanupStatus, "completed");
  assert.doesNotMatch(JSON.stringify(receipt), new RegExp(privateSentinel, "u"));
});

test("a billed invalid provider response retains only safe known usage and cost", async () => {
  const value = manifest();
  const events: string[] = [];
  const driver = successfulDriver(events);
  const billed = metrics("initial_match");
  driver.initialMatch = async () => {
    events.push("initial_match");
    throw Object.assign(new Error(`${privateSentinel}: invalid provider response`), {
      code: "PROVIDER_OUTPUT_INVALID",
      billingStatus: "known",
      inputTokens: billed.inputTokens,
      outputTokens: billed.outputTokens,
      cachedInputTokens: billed.cachedInputTokens,
      estimatedCostMicros: billed.estimatedCostMicros
    });
  };

  const receipt = await runCorrectionFlowQualification({
    manifest: value,
    consent: consentFor(value),
    driver
  });

  assert.equal(receipt.status, "stopped");
  assert.equal(receipt.failureCode, "PROVIDER_OUTPUT_INVALID");
  assert.equal(receipt.knownInputTokens, 100);
  assert.equal(receipt.knownOutputTokens, 50);
  assert.equal(receipt.knownEstimatedCostMicros, 263);
  assert.equal(receipt.unknownBillingCallCount, 0);
  assert.doesNotMatch(JSON.stringify(receipt), new RegExp(privateSentinel, "u"));
});

test("cancellation during a provider step stops the sequence and cleans up", async () => {
  const value = manifest();
  const events: string[] = [];
  const controller = new AbortController();
  const driver = successfulDriver(events);
  driver.generateResume = async (signal) => {
    events.push("tailored_resume");
    controller.abort(new Error("qualification timeout"));
    await new Promise<void>((resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      if (signal.aborted) reject(signal.reason);
      else resolve();
    });
    return metrics("tailored_resume");
  };

  const receipt = await runCorrectionFlowQualification({
    manifest: value,
    consent: consentFor(value),
    driver,
    signal: controller.signal
  });

  assert.deepEqual(events, ["initial_match", "apply_correction", "updated_match", "tailored_resume", "cleanup"]);
  assert.equal(receipt.status, "stopped");
  assert.equal(receipt.failureStage, "tailored_resume");
  assert.equal(receipt.failureCode, "EXECUTION_CANCELLED");
  assert.equal(receipt.providerCallsStarted, 3);
  assert.equal(receipt.cleanupStatus, "completed");
});

test("usage above a conservative per-call reservation stops before the next call", async () => {
  const value = manifest();
  const events: string[] = [];
  const driver = successfulDriver(events);
  driver.initialMatch = async () => {
    events.push("initial_match");
    return metrics("initial_match", {
      inputTokens: manifest().calls[0].maximumInputTokens + 1
    });
  };

  const receipt = await runCorrectionFlowQualification({
    manifest: value,
    consent: consentFor(value),
    driver
  });

  assert.deepEqual(events, ["initial_match", "cleanup"]);
  assert.equal(receipt.status, "stopped");
  assert.equal(receipt.failureStage, "initial_match");
  assert.equal(receipt.failureCode, "CONSERVATIVE_RESERVATION_EXCEEDED");
  assert.equal(receipt.providerCallsStarted, 1);
  assert.equal(receipt.providerCallsCompleted, 1);
  assert.equal(receipt.cleanupStatus, "completed");
});

test("incomplete provider metrics stop before the next stage and retain billing uncertainty", async () => {
  const value = manifest();
  const events: string[] = [];
  const driver = successfulDriver(events);
  driver.initialMatch = async () => {
    events.push("initial_match");
    return metrics("initial_match", {
      providerCompleted: false,
      billingStatus: "uncertain",
      inputTokens: null,
      outputTokens: null,
      cachedInputTokens: null,
      estimatedCostMicros: null
    });
  };

  const receipt = await runCorrectionFlowQualification({
    manifest: value,
    consent: consentFor(value),
    driver
  });

  assert.deepEqual(events, ["initial_match", "cleanup"]);
  assert.equal(receipt.status, "stopped");
  assert.equal(receipt.failureCode, "PROVIDER_METRICS_INCOMPLETE");
  assert.equal(receipt.providerCallsCompleted, 0);
  assert.equal(receipt.unknownBillingCallCount, 1);
});

test("live/mock identity and cost mismatches fail closed", async () => {
  const live = manifest("live_synthetic");
  const events: string[] = [];
  const mockedReceipt = await runCorrectionFlowQualification({
    manifest: live,
    consent: consentFor(live),
    driver: successfulDriver(events)
  });
  assert.equal(mockedReceipt.failureCode, "PROVIDER_IDENTITY_MISMATCH");
  assert.deepEqual(events, ["initial_match", "cleanup"]);

  const offline = manifest();
  const costEvents: string[] = [];
  const costDriver = successfulDriver(costEvents);
  costDriver.initialMatch = async () => {
    costEvents.push("initial_match");
    const value = metrics("initial_match");
    return { ...value, estimatedCostMicros: value.estimatedCostMicros! + 1 };
  };
  const costReceipt = await runCorrectionFlowQualification({
    manifest: offline,
    consent: consentFor(offline),
    driver: costDriver
  });
  assert.equal(costReceipt.failureCode, "PROVIDER_COST_MISMATCH");
  assert.equal(costReceipt.unknownBillingCallCount, 1);
  assert.deepEqual(costEvents, ["initial_match", "cleanup"]);
});

test("failed export verification and failed cleanup remain stopped", async () => {
  const value = manifest();
  const exportEvents: string[] = [];
  const exportDriver = successfulDriver(exportEvents);
  const originalVerify = exportDriver.verifyExports;
  exportDriver.verifyExports = async (signal) => {
    const verification = await originalVerify(signal);
    return {
      ...verification,
      resume: { ...verification.resume, unsupportedClaimsAbsent: false }
    };
  };
  const exportReceipt = await runCorrectionFlowQualification({
    manifest: value,
    consent: consentFor(value),
    driver: exportDriver
  });
  assert.equal(exportReceipt.failureCode, "EXPORT_VERIFICATION_FAILED");

  const cleanupDriver = successfulDriver([]);
  cleanupDriver.cleanup = async () => {
    throw new Error(`${privateSentinel}: cleanup failed`);
  };
  const cleanupReceipt = await runCorrectionFlowQualification({
    manifest: value,
    consent: consentFor(value),
    driver: cleanupDriver
  });
  assert.equal(cleanupReceipt.status, "stopped");
  assert.equal(cleanupReceipt.failureStage, "cleanup");
  assert.equal(cleanupReceipt.failureCode, "CLEANUP_FAILED");
  assert.equal(cleanupReceipt.cleanupStatus, "failed");
  assert.doesNotMatch(JSON.stringify(cleanupReceipt), new RegExp(privateSentinel, "u"));
});

test("an already-aborted execution starts no provider call but still cleans up", async () => {
  const value = manifest();
  const events: string[] = [];
  const controller = new AbortController();
  controller.abort(new Error("cancel before execution"));
  const receipt = await runCorrectionFlowQualification({
    manifest: value,
    consent: consentFor(value),
    driver: successfulDriver(events),
    signal: controller.signal
  });
  assert.deepEqual(events, ["cleanup"]);
  assert.equal(receipt.providerCallsStarted, 0);
  assert.equal(receipt.failureCode, "EXECUTION_CANCELLED");
});

test("a hung provider step times out, aborts its signal, and still runs cleanup", async () => {
  const value = manifest();
  const events: string[] = [];
  const driver = successfulDriver(events);
  driver.initialMatch = async (signal) => {
    events.push("initial_match");
    await new Promise<never>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
    throw new Error("unreachable");
  };

  const receipt = await runCorrectionFlowQualification({
    manifest: value,
    consent: consentFor(value),
    driver,
    stepTimeoutMs: 10
  });

  assert.deepEqual(events, ["initial_match", "cleanup"]);
  assert.equal(receipt.status, "stopped");
  assert.equal(receipt.failureCode, "STEP_TIMEOUT");
  assert.equal(receipt.cleanupStatus, "completed");
});

test("an aborted provider operation settles before cleanup begins", async () => {
  const value = manifest();
  const events: string[] = [];
  const driver = successfulDriver(events);
  driver.initialMatch = async (signal) => {
    events.push("initial_match");
    await new Promise<never>((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        setImmediate(() => {
          events.push("provider_settled");
          reject(signal.reason);
        });
      }, { once: true });
    });
    throw new Error("unreachable");
  };
  driver.cleanup = async () => {
    assert.equal(events.at(-1), "provider_settled");
    events.push("cleanup");
  };

  const receipt = await runCorrectionFlowQualification({
    manifest: value,
    consent: consentFor(value),
    driver,
    stepTimeoutMs: 10
  });

  assert.deepEqual(events, ["initial_match", "provider_settled", "cleanup"]);
  assert.equal(receipt.status, "stopped");
  assert.equal(receipt.failureCode, "STEP_TIMEOUT");
  assert.equal(receipt.cleanupStatus, "completed");
});

test("worktree status recognizes tracked, staged, and untracked changes", () => {
  assert.equal(hasDirtyCorrectionFlowQualificationWorktree(""), false);
  assert.equal(hasDirtyCorrectionFlowQualificationWorktree(" M package.json\n"), true);
  assert.equal(hasDirtyCorrectionFlowQualificationWorktree("M  package.json\n"), true);
  assert.equal(hasDirtyCorrectionFlowQualificationWorktree("?? qualification.tmp\n"), true);
});

test("the documented prepare command fails closed for a dirty checkout and unknown arguments", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  assert.equal(
    packageJson.scripts["correction-flow:qualify:prepare"],
    "node --import tsx scripts/prepare-correction-flow-qualification.ts"
  );
  assert.equal(
    packageJson.scripts["correction-flow:adapter:offline"],
    "node --import tsx scripts/execute-correction-flow-provider-adapter-offline.ts"
  );
  const headResult = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
  assert.equal(headResult.status, 0);
  const repoHead = headResult.stdout.trim();
  const marker = path.join(root, `.qualification-dirty-${randomUUID()}.tmp`);
  writeFileSync(marker, "synthetic dirty-state marker\n", "utf8");
  try {
    const dirty = spawnSync("npm", [
      "run", "correction-flow:qualify:prepare", "--", `--expected-head=${repoHead}`
    ], { cwd: root, encoding: "utf8" });
    assert.notEqual(dirty.status, 0);
    assert.match(dirty.stderr, /clean working tree/i);
    assert.equal(dirty.stdout.includes("prepared_not_executed"), false);

    const dirtyAdapter = spawnSync("npm", [
      "run", "correction-flow:adapter:offline", "--", `--expected-head=${repoHead}`
    ], { cwd: root, encoding: "utf8" });
    assert.notEqual(dirtyAdapter.status, 0);
    assert.match(dirtyAdapter.stderr, /clean working tree/i);
    assert.equal(dirtyAdapter.stdout.includes("offline_adapter_ready"), false);

    const unknown = spawnSync(process.execPath, [
      "--import", "tsx", "scripts/prepare-correction-flow-qualification.ts", "--unexpected=true"
    ], { cwd: root, encoding: "utf8" });
    assert.notEqual(unknown.status, 0);
    assert.match(unknown.stderr, /Usage:/u);
  } finally {
    unlinkSync(marker);
  }
});
