import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  correctionFlowResumeDiagnosticPreconsentDiagnostic,
  runCorrectionFlowResumeDiagnosticLiveLauncher
} from "@/scripts/run-correction-flow-resume-diagnostic-live";

const exactHead = "7".repeat(40);
const credential = "synthetic-live-diagnostic-key-never-log";

test("the résumé diagnostic launcher binds one displayed call before reading the hidden credential", async () => {
  const events: string[] = [];
  const writes: string[] = [];
  let manifestHash = "";
  const exitCode = await runCorrectionFlowResumeDiagnosticLiveLauncher([`--expected-head=${exactHead}`], {
    assertLocalInteractiveRuntime() { events.push("runtime"); },
    gitOutput(args) { return args[0] === "rev-parse" ? exactHead : ""; },
    now: () => new Date("2026-10-09T22:30:00.000Z"),
    write(value) {
      writes.push(value);
      if (value.includes('"status": "awaiting_manifest_consent"')) {
        const parsed = JSON.parse(value);
        manifestHash = parsed.safeManifest.manifestHash;
        assert.equal(parsed.safeManifest.callCount, 1);
        assert.equal(parsed.safeManifest.conservativeReservationMicros, 64_500);
        events.push("manifest");
      }
    },
    async readVisible() { events.push("consent"); return manifestHash; },
    async readSecret() { events.push("secret"); return credential; },
    async execute(input) {
      events.push("execute");
      assert.equal(input.manifest.manifestHash, manifestHash);
      assert.equal(input.consent.approvedCallCount, 1);
      assert.equal(input.credentials.geminiApiKey, credential);
      return {
        contractVersion: "1",
        status: "passed",
        manifestHash,
        exactHead,
        providerMode: "live_synthetic",
        conservativeReservationMicros: 64_500,
        providerCallsStarted: 1,
        providerCallsCompleted: 1,
        providerHttpStatus: 200,
        finishReason: "STOP",
        jsonParseStatus: "parsed",
        knownInputTokens: 100,
        knownOutputTokens: 50,
        knownCachedInputTokens: 0,
        knownEstimatedCostMicros: 263,
        unknownBillingCallCount: 0,
        noRetryAttempted: true,
        noFallbackAttempted: true,
        rawOutputRetained: false,
        failureCode: null,
        failureFieldPath: null,
        validatedOutputHash: "a".repeat(64)
      };
    }
  });
  assert.equal(exitCode, 0);
  assert.deepEqual(events, ["runtime", "manifest", "consent", "secret", "execute"]);
  assert.doesNotMatch(writes.join("\n"), new RegExp(credential, "u"));
});

test("consent mismatch and visible-input failures are bounded before secret acquisition", async () => {
  for (const [readVisible, expectedCode] of [
    [async () => "wrong-hash", "MANIFEST_CONSENT_MISMATCH"],
    [async () => { throw new Error("private visible input"); }, "MANIFEST_CONSENT_INPUT_FAILED"]
  ] as const) {
    let secretReads = 0;
    let executions = 0;
    await assert.rejects(runCorrectionFlowResumeDiagnosticLiveLauncher([`--expected-head=${exactHead}`], {
      assertLocalInteractiveRuntime() {},
      gitOutput(args) { return args[0] === "rev-parse" ? exactHead : ""; },
      now: () => new Date("2026-10-09T22:30:00.000Z"),
      write() {},
      readVisible,
      async readSecret() { secretReads += 1; return credential; },
      async execute() { executions += 1; throw new Error("must not execute"); }
    }), (error: unknown) => {
      const diagnostic = correctionFlowResumeDiagnosticPreconsentDiagnostic(error);
      return diagnostic?.failureCode === expectedCode && diagnostic.providerCallsStarted === 0;
    });
    assert.equal(secretReads, 0);
    assert.equal(executions, 0);
  }
});

test("secret and execution failures cannot spoof a zero-call diagnostic", async () => {
  for (const failureAt of ["secret", "execute"] as const) {
    let manifestHash = "";
    await assert.rejects(runCorrectionFlowResumeDiagnosticLiveLauncher([`--expected-head=${exactHead}`], {
      assertLocalInteractiveRuntime() {},
      gitOutput(args) { return args[0] === "rev-parse" ? exactHead : ""; },
      now: () => new Date("2026-10-09T22:30:00.000Z"),
      write(value) {
        if (value.includes('"status": "awaiting_manifest_consent"')) {
          manifestHash = JSON.parse(value).safeManifest.manifestHash;
        }
      },
      async readVisible() { return manifestHash; },
      async readSecret() {
        if (failureAt === "secret") {
          throw Object.assign(new Error("private secret failure"), { code: "MANIFEST_CONSENT_INPUT_FAILED" });
        }
        return credential;
      },
      async execute() {
        throw Object.assign(new Error("private execution failure"), { code: "MANIFEST_CONSENT_INPUT_FAILED" });
      }
    }), (error: unknown) => correctionFlowResumeDiagnosticPreconsentDiagnostic(error) === null);
  }
});

test("the supported diagnostic command has no database, environment-key, or raw-output path", () => {
  const script = readFileSync(fileURLToPath(
    new URL("../scripts/run-correction-flow-resume-diagnostic-live.ts", import.meta.url)
  ), "utf8");
  const packageJson = JSON.parse(readFileSync(fileURLToPath(
    new URL("../package.json", import.meta.url)
  ), "utf8")) as { scripts: Record<string, string> };
  assert.equal(
    packageJson.scripts["correction-flow:diagnose-resume:live"],
    "node --import tsx scripts/run-correction-flow-resume-diagnostic-live.ts"
  );
  assert.doesNotMatch(script, /DATABASE_URL|DIRECT_URL|TEST_DATABASE_URL|GEMINI_API_KEY|OPENAI_API_KEY/u);
  assert.match(script, /\/dev\/tty/u);
  assert.match(script, /\["-echo"\]/u);
  assert.match(script, /rawOutputRetention: false/u);
});
