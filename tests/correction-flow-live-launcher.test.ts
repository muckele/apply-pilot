import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { SYNTHETIC_CORRECTION_FLOW_FIXTURE } from "@/evaluation/correction-flow-qualification-fixture";
import type { CorrectionFlowQualificationReceipt } from "@/lib/ai/correction-flow-qualification";
import {
  assertCorrectionFlowLiveDatabaseEnvironment,
  runCorrectionFlowLiveLauncher
} from "@/scripts/run-correction-flow-qualification-live";
import * as liveLauncherModule from "@/scripts/run-correction-flow-qualification-live";

const exactHead = "9".repeat(40);
const geminiKey = "synthetic-gemini-secret-never-log";
const localDatabaseUrl = "postgresql://postgres:postgres@127.0.0.1:55432/apply_pilot_commit5_test";

test("the live launcher binds one displayed manifest before masked keys and executes it unchanged", async () => {
  const events: string[] = [];
  const writes: string[] = [];
  let displayedManifestHash = "";

  const exitCode = await runCorrectionFlowLiveLauncher(
    [`--expected-head=${exactHead}`],
    {
      assertLocalInteractiveRuntime() {
        events.push("runtime");
      },
      gitOutput(args) {
        return args[0] === "rev-parse" ? exactHead : "";
      },
      now: () => new Date("2026-10-09T18:00:00.000Z"),
      async verifyDatabase() {
        events.push("database");
        return { databaseUrl: localDatabaseUrl, databaseName: "apply_pilot_commit5_test", serverMajorVersion: 16 };
      },
      write(value) {
        writes.push(value);
        if (value.includes('"status": "awaiting_manifest_consent"')) {
          displayedManifestHash = JSON.parse(value).safeManifest.manifestHash;
          events.push("manifest");
        }
      },
      async readVisible(prompt) {
        assert.match(prompt, /manifest hash/iu);
        events.push("consent");
        return displayedManifestHash;
      },
      async readSecret(prompt) {
        assert.equal(events.includes("consent"), true);
        assert.match(prompt, /Gemini/u);
        events.push("gemini");
        return geminiKey;
      },
      async execute(input) {
        events.push("execute");
        assert.equal(input.manifest.manifestHash, displayedManifestHash);
        assert.equal(input.consent.manifestHash, displayedManifestHash);
        assert.equal(input.consent.existingCredentialUseApproved, true);
        assert.equal(input.credentials.geminiApiKey, geminiKey);
        assert.equal(input.databaseUrl, localDatabaseUrl);
        assert.deepEqual(input.fixture, SYNTHETIC_CORRECTION_FLOW_FIXTURE);
        return passedReceipt(displayedManifestHash);
      }
    }
  );

  assert.equal(exitCode, 0);
  assert.deepEqual(events, ["runtime", "database", "manifest", "consent", "gemini", "execute"]);
  const serialized = writes.join("\n");
  assert.match(serialized, /"status": "passed"/u);
  assert.doesNotMatch(serialized, new RegExp(geminiKey, "u"));
});

test("the live launcher reads no credentials and starts no execution when manifest consent mismatches", async () => {
  let secretReads = 0;
  let executions = 0;
  await assert.rejects(
    runCorrectionFlowLiveLauncher([`--expected-head=${exactHead}`], {
      assertLocalInteractiveRuntime() {},
      gitOutput(args) {
        return args[0] === "rev-parse" ? exactHead : "";
      },
      now: () => new Date("2026-10-09T18:00:00.000Z"),
      async verifyDatabase() {
        return { databaseUrl: localDatabaseUrl, databaseName: "apply_pilot_commit5_test", serverMajorVersion: 16 };
      },
      write() {},
      async readVisible() {
        return "not-the-manifest-hash";
      },
      async readSecret() {
        secretReads += 1;
        return geminiKey;
      },
      async execute() {
        executions += 1;
        throw new Error("must not execute");
      }
    }),
    (error: unknown) => {
      const diagnostic = liveLauncherModule.correctionFlowLivePreconsentDiagnostic(error);
      return (error as { code?: unknown }).code === "MANIFEST_CONSENT_MISMATCH" &&
        /consent did not match/iu.test((error as Error).message) &&
        diagnostic?.failureCode === "MANIFEST_CONSENT_MISMATCH" &&
        diagnostic.providerCallsStarted === 0;
    }
  );
  assert.equal(secretReads, 0);
  assert.equal(executions, 0);
});

test("the live launcher bounds visible consent input failures before credentials or execution", async () => {
  const privateSentinel = "private-visible-input-failure-must-not-appear";
  let secretReads = 0;
  let executions = 0;
  await assert.rejects(
    runCorrectionFlowLiveLauncher([`--expected-head=${exactHead}`], {
      assertLocalInteractiveRuntime() {},
      gitOutput(args) {
        return args[0] === "rev-parse" ? exactHead : "";
      },
      now: () => new Date("2026-10-09T18:00:00.000Z"),
      async verifyDatabase() {
        return { databaseUrl: localDatabaseUrl, databaseName: "apply_pilot_commit5_test", serverMajorVersion: 16 };
      },
      write() {},
      async readVisible() {
        throw new Error(privateSentinel);
      },
      async readSecret() {
        secretReads += 1;
        return geminiKey;
      },
      async execute() {
        executions += 1;
        throw new Error("must not execute");
      }
    }),
    (error: unknown) => {
      const diagnostic = liveLauncherModule.correctionFlowLivePreconsentDiagnostic(error);
      return diagnostic?.failureCode === "MANIFEST_CONSENT_INPUT_FAILED" &&
        diagnostic.providerCallsStarted === 0 &&
        !JSON.stringify(diagnostic).includes(privateSentinel);
    }
  );
  assert.equal(secretReads, 0);
  assert.equal(executions, 0);
});

test("the live launcher does not misclassify execution failures as zero-call preconsent failures", async () => {
  const privateSentinel = "private-execution-failure-must-not-appear";
  let displayedManifestHash = "";
  await assert.rejects(
    runCorrectionFlowLiveLauncher([`--expected-head=${exactHead}`], {
      assertLocalInteractiveRuntime() {},
      gitOutput(args) {
        return args[0] === "rev-parse" ? exactHead : "";
      },
      now: () => new Date("2026-10-09T18:00:00.000Z"),
      async verifyDatabase() {
        return { databaseUrl: localDatabaseUrl, databaseName: "apply_pilot_commit5_test", serverMajorVersion: 16 };
      },
      write(value) {
        if (value.includes('"status": "awaiting_manifest_consent"')) {
          displayedManifestHash = JSON.parse(value).safeManifest.manifestHash;
        }
      },
      async readVisible() {
        return displayedManifestHash;
      },
      async readSecret() {
        return geminiKey;
      },
      async execute() {
        throw Object.assign(new Error(privateSentinel), { code: "MANIFEST_CONSENT_INPUT_FAILED" });
      }
    }),
    (error: unknown) => {
      assert.equal(liveLauncherModule.correctionFlowLivePreconsentDiagnostic(error), null);
      return (error as Error).message === privateSentinel;
    }
  );
});

test("the live launcher does not misclassify secret-input failures as zero-call preconsent failures", async () => {
  const privateSentinel = "private-secret-input-failure-must-not-appear";
  let displayedManifestHash = "";
  let executions = 0;
  await assert.rejects(
    runCorrectionFlowLiveLauncher([`--expected-head=${exactHead}`], {
      assertLocalInteractiveRuntime() {},
      gitOutput(args) {
        return args[0] === "rev-parse" ? exactHead : "";
      },
      now: () => new Date("2026-10-09T18:00:00.000Z"),
      async verifyDatabase() {
        return { databaseUrl: localDatabaseUrl, databaseName: "apply_pilot_commit5_test", serverMajorVersion: 16 };
      },
      write(value) {
        if (value.includes('"status": "awaiting_manifest_consent"')) {
          displayedManifestHash = JSON.parse(value).safeManifest.manifestHash;
        }
      },
      async readVisible() {
        return displayedManifestHash;
      },
      async readSecret() {
        throw Object.assign(new Error(privateSentinel), { code: "MANIFEST_CONSENT_INPUT_FAILED" });
      },
      async execute() {
        executions += 1;
        throw new Error("must not execute");
      }
    }),
    (error: unknown) => {
      assert.equal(liveLauncherModule.correctionFlowLivePreconsentDiagnostic(error), null);
      return (error as Error).message === privateSentinel;
    }
  );
  assert.equal(executions, 0);
});

test("the live launcher fails closed before prompts for a dirty worktree", async () => {
  let prompts = 0;
  await assert.rejects(
    runCorrectionFlowLiveLauncher([`--expected-head=${exactHead}`], {
      assertLocalInteractiveRuntime() {},
      gitOutput(args) {
        return args[0] === "rev-parse" ? exactHead : " M package.json";
      },
      now: () => new Date("2026-10-09T18:00:00.000Z"),
      async verifyDatabase() {
        throw new Error("database must not be touched");
      },
      write() {},
      async readVisible() {
        prompts += 1;
        return "";
      },
      async readSecret() {
        prompts += 1;
        return "";
      },
      async execute() {
        throw new Error("must not execute");
      }
    }),
    /clean working tree/iu
  );
  assert.equal(prompts, 0);
});

test("the live database guard requires all Prisma URLs to identify the same disposable local database", () => {
  const safe = {
    COMMIT5_POSTGRES_TEST: "1",
    TEST_DATABASE_URL: localDatabaseUrl,
    DATABASE_URL: localDatabaseUrl,
    DIRECT_URL: localDatabaseUrl
  };
  assert.equal(assertCorrectionFlowLiveDatabaseEnvironment(safe).url, localDatabaseUrl);
  assert.throws(
    () => assertCorrectionFlowLiveDatabaseEnvironment({ ...safe, DIRECT_URL: "postgresql://example.invalid/prod" }),
    /must exactly match TEST_DATABASE_URL/iu
  );
  assert.throws(
    () => assertCorrectionFlowLiveDatabaseEnvironment({ ...safe, DATABASE_URL: undefined }),
    /DATABASE_URL is required/iu
  );
});

test("the live command accepts no provider credential through arguments, environment, or repository files", () => {
  const script = readFileSync(fileURLToPath(
    new URL("../scripts/run-correction-flow-qualification-live.ts", import.meta.url)
  ), "utf8");
  const packageJson = JSON.parse(readFileSync(fileURLToPath(
    new URL("../package.json", import.meta.url)
  ), "utf8")) as { scripts: Record<string, string> };

  assert.equal(
    packageJson.scripts["correction-flow:qualify:live"],
    "COMMIT5_POSTGRES_TEST=1 node --import tsx scripts/run-correction-flow-qualification-live.ts"
  );
  assert.doesNotMatch(script, /GEMINI_API_KEY|OPENAI_API_KEY|--api-key/u);
  assert.doesNotMatch(script, /["']\.env/u);
  assert.match(script, /\/dev\/tty/u);
  assert.match(script, /\["-echo"\]/u);
});

test("the executable formats pre-consent failures as bounded zero-call diagnostics", () => {
  const candidate = liveLauncherModule as typeof liveLauncherModule & {
    correctionFlowLivePreconsentDiagnostic?: (error: unknown) => unknown;
  };
  assert.equal(typeof candidate.correctionFlowLivePreconsentDiagnostic, "function");
  const privateSentinel = "private-terminal-input-must-not-appear";
  const unbranded = Object.assign(new Error(privateSentinel), {
    code: "POSTGRES_TEST_GUARD_REJECTED"
  });
  assert.equal(candidate.correctionFlowLivePreconsentDiagnostic?.(unbranded), null);
  assert.equal(candidate.correctionFlowLivePreconsentDiagnostic?.(new Error(privateSentinel)), null);
});

function passedReceipt(manifestHash: string): CorrectionFlowQualificationReceipt {
  return {
    contractVersion: "2",
    status: "passed",
    manifestHash,
    exactHead,
    providerMode: "live_synthetic",
    conservativeReservationMicros: 257_565,
    providerCallsStarted: 4,
    providerCallsCompleted: 4,
    knownInputTokens: 400,
    knownOutputTokens: 200,
    knownCachedInputTokens: 0,
    knownEstimatedCostMicros: 1_052,
    unknownBillingCallCount: 0,
    noRetryAttempted: true,
    failureStage: null,
    failureCode: null,
    failureFieldPath: null,
    cleanupStatus: "completed",
    exportVerification: {
      resume: artifactVerification(),
      coverLetter: artifactVerification()
    }
  };
}

function artifactVerification() {
  return {
    currentEvidenceSnapshotBound: true,
    correctionPresent: true,
    supersededFactAbsent: true,
    unsupportedClaimsAbsent: true,
    generatedContentSha256: "a".repeat(64),
    exportedTextSha256: "b".repeat(64)
  };
}
