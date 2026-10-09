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
    /consent did not match/iu
  );
  assert.equal(secretReads, 0);
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
    "node --import tsx scripts/run-correction-flow-qualification-live.ts"
  );
  assert.doesNotMatch(script, /GEMINI_API_KEY|OPENAI_API_KEY|--api-key/u);
  assert.doesNotMatch(script, /["']\.env/u);
  assert.match(script, /\/dev\/tty/u);
  assert.match(script, /\["-echo"\]/u);
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
