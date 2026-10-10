import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  correctionFlowDocumentReviewPreconsentDiagnostic,
  runCorrectionFlowDocumentReviewLiveLauncher
} from "@/scripts/run-correction-flow-document-review-live";
import type { CorrectionFlowDocumentReviewReceipt } from "@/lib/ai/correction-flow-document-review";

const exactHead = "e".repeat(40);
const credential = "synthetic-visible-review-key-never-log";

function safeReceipt(manifestHash: string): CorrectionFlowDocumentReviewReceipt {
  return {
    contractVersion: "2" as const,
    status: "approved" as const,
    manifestHash,
    exactHead,
    providerMode: "live_synthetic" as const,
    conservativeReservationMicros: 112_125,
    providerCallsStarted: 2,
    providerCallsCompleted: 2,
    knownInputTokens: 200,
    knownOutputTokens: 120,
    knownCachedInputTokens: 0,
    knownEstimatedCostMicros: 600,
    unknownBillingCallCount: 0,
    noRetryAttempted: true as const,
    noFallbackAttempted: true as const,
    stoppedAfterFirstFailure: true as const,
    rawProviderOutputRetained: false as const,
    validatedDocumentPersistentRetention: false as const,
    safeReceiptOnly: true as const,
    failureStage: null,
    failureCode: null,
    failureClass: null,
    failureFieldPath: null,
    envelopeHash: "1".repeat(64),
    reviewAttestation: {
      contractVersion: "1" as const,
      reviewEnvelopeHash: "1".repeat(64),
      reviewedAt: "2026-10-10T05:03:00.000Z",
      documents: [
        {
          kind: "resume" as const,
          validatedOutputHash: "2".repeat(64),
          deliveredPdfHash: "3".repeat(64),
          disposition: "approved" as const,
          reason: null,
          reviewedAllPages: true as const,
          reviewedWritingQuality: true as const,
          reviewedVisualLayout: true as const
        },
        {
          kind: "cover_letter" as const,
          validatedOutputHash: "4".repeat(64),
          deliveredPdfHash: "5".repeat(64),
          disposition: "approved" as const,
          reason: null,
          reviewedAllPages: true as const,
          reviewedWritingQuality: true as const,
          reviewedVisualLayout: true as const
        }
      ],
      attestationHash: "6".repeat(64)
    }
  };
}

test("the launcher requires exact consent before one hidden credential read and emits only URL plus safe receipt", async () => {
  const events: string[] = [];
  const writes: string[] = [];
  let manifestHash = "";
  const exitCode = await runCorrectionFlowDocumentReviewLiveLauncher(
    [`--expected-head=${exactHead}`],
    {
      assertLocalInteractiveRuntime() { events.push("runtime"); },
      gitOutput(args) { return args[0] === "rev-parse" ? exactHead : ""; },
      now: () => new Date("2026-10-10T05:00:00.000Z"),
      write(value) {
        writes.push(value);
        if (value.includes('"status": "awaiting_manifest_consent"')) {
          const parsed = JSON.parse(value);
          manifestHash = parsed.safeManifest.manifestHash;
          assert.equal(parsed.safeManifest.contractVersion, "2");
          assert.equal(parsed.safeManifest.validatedDocumentLifetimeMs, 900_000);
          assert.equal(parsed.safeManifest.conservativeReservationMicros, 112_125);
          events.push("manifest");
        }
      },
      async readVisible() { events.push("consent"); return manifestHash; },
      async readSecret() { events.push("secret"); return credential; },
      async execute(input) {
        events.push("execute");
        assert.equal(input.manifest.manifestHash, manifestHash);
        assert.equal(input.credentials.geminiApiKey, credential);
        input.onReviewReady({ reviewUrl: "http://127.0.0.1:54321/review/token" });
        return safeReceipt(manifestHash);
      }
    }
  );
  assert.equal(exitCode, 0);
  assert.deepEqual(events, ["runtime", "manifest", "consent", "secret", "execute"]);
  assert.equal(writes.filter((value) => /^http:\/\/127\.0\.0\.1:\d+\/review\//u.test(value)).length, 1);
  const output = writes.join("\n");
  assert.doesNotMatch(output, new RegExp(credential, "u"));
  assert.doesNotMatch(output, /professionalSummary|Dear Synthetic|Synthetic owner confirms|%PDF/u);
});

test("argument, runtime, head, dirty tree, consent mismatch, and cancellation stop before execution", async () => {
  for (const scenario of ["argument", "runtime", "head", "dirty", "consent", "cancel"] as const) {
    let secretReads = 0;
    let executes = 0;
    let manifestHash = "";
    const arguments_ = scenario === "argument" ? [] : [`--expected-head=${exactHead}`];
    await assert.rejects(runCorrectionFlowDocumentReviewLiveLauncher(arguments_, {
      assertLocalInteractiveRuntime() {
        if (scenario === "runtime") throw Object.assign(new Error("hosted"), { code: "LIVE_RUNTIME_UNAVAILABLE" });
      },
      gitOutput(args) {
        if (args[0] === "rev-parse") return scenario === "head" ? "f".repeat(40) : exactHead;
        return scenario === "dirty" ? " M private-owner-file" : "";
      },
      now: () => new Date("2026-10-10T05:00:00.000Z"),
      write(value) {
        if (value.includes('"status": "awaiting_manifest_consent"')) {
          manifestHash = JSON.parse(value).safeManifest.manifestHash;
        }
      },
      async readVisible() {
        if (scenario === "cancel") throw new Error("owner cancelled");
        return scenario === "consent" ? "wrong" : manifestHash;
      },
      async readSecret() { secretReads += 1; return credential; },
      async execute() { executes += 1; return safeReceipt(manifestHash); }
    }), (error: unknown) => {
      const diagnostic = correctionFlowDocumentReviewPreconsentDiagnostic(error);
      return diagnostic?.providerCallsStarted === 0;
    });
    assert.equal(secretReads, 0);
    assert.equal(executes, 0);
  }
});

test("a post-consent head change stops after one secret read and before provider dispatch", async () => {
  let headReads = 0;
  let secretReads = 0;
  let executes = 0;
  let manifestHash = "";
  await assert.rejects(runCorrectionFlowDocumentReviewLiveLauncher(
    [`--expected-head=${exactHead}`],
    {
      assertLocalInteractiveRuntime() {},
      gitOutput(args) {
        if (args[0] === "rev-parse") {
          headReads += 1;
          return headReads === 1 ? exactHead : "f".repeat(40);
        }
        return "";
      },
      now: () => new Date("2026-10-10T05:00:00.000Z"),
      write(value) {
        if (value.includes('"status": "awaiting_manifest_consent"')) {
          manifestHash = JSON.parse(value).safeManifest.manifestHash;
        }
      },
      async readVisible() { return manifestHash; },
      async readSecret() { secretReads += 1; return credential; },
      async execute() { executes += 1; return safeReceipt(manifestHash); }
    }
  ), (error: unknown) => {
    const diagnostic = correctionFlowDocumentReviewPreconsentDiagnostic(error);
    return diagnostic?.failureCode === "LIVE_HEAD_CHANGED" && diagnostic.providerCallsStarted === 0;
  });
  assert.equal(headReads, 2);
  assert.equal(secretReads, 1);
  assert.equal(executes, 0);
});

test("the supported command has no database, environment-key, auto-open, or screenshot path", () => {
  const script = readFileSync(fileURLToPath(
    new URL("../scripts/run-correction-flow-document-review-live.ts", import.meta.url)
  ), "utf8");
  const packageJson = JSON.parse(readFileSync(fileURLToPath(
    new URL("../package.json", import.meta.url)
  ), "utf8")) as { scripts: Record<string, string> };
  assert.equal(
    packageJson.scripts["correction-flow:review-documents:live"],
    "node --import tsx scripts/run-correction-flow-document-review-live.ts"
  );
  assert.doesNotMatch(script, /DATABASE_URL|DIRECT_URL|TEST_DATABASE_URL|GEMINI_API_KEY|OPENAI_API_KEY/u);
  assert.doesNotMatch(script, /playwright|screenshot|execFileSync\(["']open["']/u);
  assert.match(script, /\/dev\/tty/u);
  assert.match(script, /\["-echo"\]/u);
  assert.match(script, /validatedDocumentPersistentRetention: false/u);
  assert.match(script, /rawProviderOutputRetention: false/u);
});
