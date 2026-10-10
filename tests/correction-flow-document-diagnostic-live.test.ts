import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  correctionFlowDocumentDiagnosticPreconsentDiagnostic,
  runCorrectionFlowDocumentDiagnosticLiveLauncher
} from "@/scripts/run-correction-flow-document-diagnostic-live";

const exactHead = "e".repeat(40);
const credential = "synthetic-live-two-document-key-never-log";

test("the launcher binds two sequential document calls before one hidden credential read", async () => {
  const events: string[] = [];
  const writes: string[] = [];
  let manifestHash = "";
  const exitCode = await runCorrectionFlowDocumentDiagnosticLiveLauncher(
    [`--expected-head=${exactHead}`],
    {
      assertLocalInteractiveRuntime() { events.push("runtime"); },
      gitOutput(args) { return args[0] === "rev-parse" ? exactHead : ""; },
      now: () => new Date("2026-10-10T01:30:00.000Z"),
      write(value) {
        writes.push(value);
        if (value.includes('"status": "awaiting_manifest_consent"')) {
          const parsed = JSON.parse(value);
          manifestHash = parsed.safeManifest.manifestHash;
          assert.equal(parsed.safeManifest.callCount, 2);
          assert.equal(parsed.safeManifest.conservativeReservationMicros, 112_125);
          assert.deepEqual(parsed.safeManifest.calls.map((call: { stage: string }) => call.stage), [
            "tailored_resume",
            "cover_letter"
          ]);
          events.push("manifest");
        }
      },
      async readVisible() { events.push("consent"); return manifestHash; },
      async readSecret() { events.push("secret"); return credential; },
      async execute(input) {
        events.push("execute");
        assert.equal(input.manifest.manifestHash, manifestHash);
        assert.equal(input.consent.approvedCallCount, 2);
        assert.equal(input.credentials.geminiApiKey, credential);
        return {
          contractVersion: "1",
          status: "passed",
          manifestHash,
          exactHead,
          providerMode: "live_synthetic",
          conservativeReservationMicros: 112_125,
          providerCallsStarted: 2,
          providerCallsCompleted: 2,
          knownInputTokens: 200,
          knownOutputTokens: 120,
          knownCachedInputTokens: 0,
          knownEstimatedCostMicros: 600,
          unknownBillingCallCount: 0,
          noRetryAttempted: true,
          noFallbackAttempted: true,
          stoppedAfterFirstFailure: true,
          rawOutputRetained: false,
          outputEmitted: false,
          failureStage: null,
          failureCode: null,
          failureClass: null,
          failureFieldPath: null,
          validatedOutputHashes: {
            tailoredResume: "a".repeat(64),
            coverLetter: "b".repeat(64)
          },
          exportVerification: null
        };
      }
    }
  );
  assert.equal(exitCode, 0);
  assert.deepEqual(events, ["runtime", "manifest", "consent", "secret", "execute"]);
  assert.doesNotMatch(writes.join("\n"), new RegExp(credential, "u"));
  assert.doesNotMatch(writes.join("\n"), /"professionalSummary"\s*:|Synthetic owner confirms/u);
});

test("head, cleanliness, and manifest consent fail before credential acquisition", async () => {
  for (const scenario of ["head", "dirty", "consent"] as const) {
    let secretReads = 0;
    let manifestHash = "";
    await assert.rejects(runCorrectionFlowDocumentDiagnosticLiveLauncher(
      [`--expected-head=${exactHead}`],
      {
        assertLocalInteractiveRuntime() {},
        gitOutput(args) {
          if (args[0] === "rev-parse") return scenario === "head" ? "f".repeat(40) : exactHead;
          return scenario === "dirty" ? " M private-owner-file" : "";
        },
        now: () => new Date("2026-10-10T01:30:00.000Z"),
        write(value) {
          if (value.includes('"status": "awaiting_manifest_consent"')) {
            manifestHash = JSON.parse(value).safeManifest.manifestHash;
          }
        },
        async readVisible() { return scenario === "consent" ? "wrong" : manifestHash; },
        async readSecret() { secretReads += 1; return credential; },
        async execute() { throw new Error("must not execute"); }
      }
    ), (error: unknown) => {
      const diagnostic = correctionFlowDocumentDiagnosticPreconsentDiagnostic(error);
      const expected = scenario === "head"
        ? "LIVE_HEAD_MISMATCH"
        : scenario === "dirty"
          ? "LIVE_WORKTREE_DIRTY"
          : "MANIFEST_CONSENT_MISMATCH";
      return diagnostic?.failureCode === expected && diagnostic.providerCallsStarted === 0;
    });
    assert.equal(secretReads, 0);
  }
});

test("the supported command has no database, environment-key, or document-output path", () => {
  const script = readFileSync(fileURLToPath(
    new URL("../scripts/run-correction-flow-document-diagnostic-live.ts", import.meta.url)
  ), "utf8");
  const packageJson = JSON.parse(readFileSync(fileURLToPath(
    new URL("../package.json", import.meta.url)
  ), "utf8")) as { scripts: Record<string, string> };
  assert.equal(
    packageJson.scripts["correction-flow:diagnose-documents:live"],
    "node --import tsx scripts/run-correction-flow-document-diagnostic-live.ts"
  );
  assert.doesNotMatch(script, /DATABASE_URL|DIRECT_URL|TEST_DATABASE_URL|GEMINI_API_KEY|OPENAI_API_KEY/u);
  assert.match(script, /\/dev\/tty/u);
  assert.match(script, /\["-echo"\]/u);
  assert.match(script, /rawOutputRetention: false/u);
  assert.match(script, /outputEmission: false/u);
});
