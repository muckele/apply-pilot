import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  correctionFlowDocumentReviewPreconsentDiagnostic,
  runCorrectionFlowDocumentReviewLiveLauncher
} from "@/scripts/run-correction-flow-document-review-live";
import type { CorrectionFlowDocumentReviewReceipt } from "@/lib/ai/correction-flow-document-review";

import { PRODUCT_DOCUMENT_REVIEW_RENDERING } from "@/lib/documents/product-document-review";

const exactHead = "e".repeat(40);
const credential = "synthetic-visible-review-key-never-log";

function safeReceipt(manifestHash: string): CorrectionFlowDocumentReviewReceipt {
  return {
    contractVersion: "3" as const,
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

// Fully injected unit harness: no real consent, credential input, provider transport, or owner window.
test("the mocked launcher binds product rendering before simulated consent and emits only URL plus safe receipt", async () => {
  const events: string[] = [];
  const writes: string[] = [];
  let manifestHash = "";
  const exitCode = await runCorrectionFlowDocumentReviewLiveLauncher(
    [`--expected-head=${exactHead}`],
    {
      async persistReceipt() { return { path: "/synthetic/private/receipt.json", sha256: "a".repeat(64) }; },
      assertLocalInteractiveRuntime() { events.push("runtime"); },
      gitOutput(args) { return args[0] === "rev-parse" ? exactHead : ""; },
      now: () => new Date("2026-10-10T05:00:00.000Z"),
      write(value) {
        writes.push(value);
        if (value.includes('"status": "awaiting_manifest_consent"')) {
          const parsed = JSON.parse(value);
          manifestHash = parsed.safeManifest.manifestHash;
          assert.deepEqual(parsed.safeReceiptPersistence, {
            enabled: true, contents: "sanitized_final_receipt_only",
            location: "~/.apply-pilot-document-review-receipt-*/receipt.json",
            directoryMode: "0700", fileMode: "0600"
          });
          assert.equal(parsed.safeManifest.contractVersion, "3");
          assert.deepEqual(parsed.safeManifest.rendering, PRODUCT_DOCUMENT_REVIEW_RENDERING);
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
      async persistReceipt() { return { path: "/synthetic/private/receipt.json", sha256: "a".repeat(64) }; },
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
      async persistReceipt() { return { path: "/synthetic/private/receipt.json", sha256: "a".repeat(64) }; },
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

test("manifest construction failures stop with an actionable bounded diagnostic before any input", async () => {
  let inputReads = 0;
  let executes = 0;
  await assert.rejects(runCorrectionFlowDocumentReviewLiveLauncher([`--expected-head=${exactHead}`], {
    async persistReceipt() { return { path: "/synthetic/private/receipt.json", sha256: "a".repeat(64) }; },
    assertLocalInteractiveRuntime() {},
    gitOutput(args) { return args[0] === "rev-parse" ? exactHead : ""; },
    now: () => new Date("invalid"),
    write() { assert.fail("An invalid manifest must not be displayed."); },
    async readVisible() { inputReads += 1; return ""; },
    async readSecret() { inputReads += 1; return credential; },
    async execute() { executes += 1; return safeReceipt(""); }
  }), (error: unknown) => {
    const diagnostic = correctionFlowDocumentReviewPreconsentDiagnostic(error);
    assert.equal(diagnostic?.failureCode, "LIVE_MANIFEST_BUILD_FAILED");
    assert.equal(diagnostic?.providerCallsStarted, 0);
    assert.equal(diagnostic?.failureCauseClass, "RangeError");
    assert.match(diagnostic?.nextAction ?? "", /Do not retry/u);
    return true;
  });
  assert.equal(inputReads, 0);
  assert.equal(executes, 0);
});

test("manifest display failures retain no raw exception and stop before consent or credentials", async () => {
  const privateMessage = "private-terminal-value-that-must-never-be-emitted";
  let inputReads = 0;
  await assert.rejects(runCorrectionFlowDocumentReviewLiveLauncher([`--expected-head=${exactHead}`], {
    async persistReceipt() { return { path: "/synthetic/private/receipt.json", sha256: "a".repeat(64) }; },
    assertLocalInteractiveRuntime() {},
    gitOutput(args) { return args[0] === "rev-parse" ? exactHead : ""; },
    now: () => new Date("2026-10-14T05:00:00.000Z"),
    write() { throw Object.assign(new Error(privateMessage), { code: "EPIPE" }); },
    async readVisible() { inputReads += 1; return ""; },
    async readSecret() { inputReads += 1; return credential; },
    async execute() { assert.fail("Provider execution must remain unreachable."); }
  }), (error: unknown) => {
    const diagnostic = correctionFlowDocumentReviewPreconsentDiagnostic(error);
    assert.equal(diagnostic?.failureCode, "LIVE_MANIFEST_DISPLAY_FAILED");
    assert.equal(diagnostic?.providerCallsStarted, 0);
    assert.equal(diagnostic?.failureCauseCode, "EPIPE");
    assert.doesNotMatch(JSON.stringify(diagnostic), new RegExp(privateMessage, "u"));
    return true;
  });
  assert.equal(inputReads, 0);
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


test("launcher saves before stdout and preserves safe original receipt when persistence fails", async () => {
  for (const failure of [false, true]) {
    let manifestHash = "";
    const events: string[] = [];
    const writes: string[] = [];
    const exitCode = await runCorrectionFlowDocumentReviewLiveLauncher([`--expected-head=${exactHead}`], {
      assertLocalInteractiveRuntime() {},
      gitOutput(args) { return args[0] === "rev-parse" ? exactHead : ""; },
      now: () => new Date("2026-10-16T22:00:00.000Z"),
      write(value) {
        writes.push(value);
        if (value.includes('"awaiting_manifest_consent"')) manifestHash = JSON.parse(value).safeManifest.manifestHash;
        else events.push("stdout");
      },
      async readVisible() { return manifestHash; },
      async readSecret() { return credential; },
      async execute() { events.push("execute"); return safeReceipt(manifestHash); },
      async persistReceipt(receipt, options) {
        events.push("persist");
        assert.equal(receipt.manifestHash, manifestHash);
        assert.deepEqual(options.forbiddenValues, [credential]);
        if (failure) throw new Error("private-filesystem-detail-never-print");
        return { path: "/synthetic/private/receipt.json", sha256: "a".repeat(64) };
      }
    });
    assert.equal(exitCode, failure ? 1 : 0);
    assert.deepEqual(events, ["execute", "persist", "stdout"]);
    const output = JSON.parse(writes.at(-1)!);
    assert.deepEqual(output.receipt, safeReceipt(manifestHash));
    assert.deepEqual(output.receiptPersistence, failure
      ? { status: "failed", failureCode: "SAFE_RECEIPT_WRITE_FAILED" }
      : { status: "saved", path: "/synthetic/private/receipt.json", sha256: "a".repeat(64) });
    assert.doesNotMatch(writes.join("\n"), /private-filesystem-detail-never-print|synthetic-visible-review-key-never-log/u);
  }
});

test("Terminal hangup gracefully aborts execution, persists stopped receipt, and removes handlers", async () => {
  let manifestHash = "";
  let persisted: CorrectionFlowDocumentReviewReceipt | null = null;
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  const initialCounts = signals.map((signal) => process.listenerCount(signal));
  const exitCode = await runCorrectionFlowDocumentReviewLiveLauncher([`--expected-head=${exactHead}`], {
    assertLocalInteractiveRuntime() {},
    gitOutput(args) { return args[0] === "rev-parse" ? exactHead : ""; },
    now: () => new Date("2026-10-16T22:00:00.000Z"),
    write(value) { if (value.includes('"awaiting_manifest_consent"')) manifestHash = JSON.parse(value).safeManifest.manifestHash; },
    async readVisible() { return manifestHash; }, async readSecret() { return credential; },
    async execute(input) {
      process.emit("SIGHUP");
      assert.equal(input.signal.aborted, true);
      return { ...safeReceipt(manifestHash), status: "stopped", failureStage: "owner_review",
        failureCode: "EXECUTION_CANCELLED", reviewAttestation: null };
    },
    async persistReceipt(receipt) { persisted = receipt; return { path: "/synthetic/private/receipt.json", sha256: "a".repeat(64) }; }
  });
  assert.equal(exitCode, 1);
  assert.equal((persisted as CorrectionFlowDocumentReviewReceipt | null)?.failureCode, "EXECUTION_CANCELLED");
  assert.deepEqual(signals.map((signal) => process.listenerCount(signal)), initialCounts);
});

test("launcher rejects unallowlisted receipt fields before filesystem persistence or final output", async () => {
  let manifestHash = "";
  let saves = 0;
  const writes: string[] = [];
  await assert.rejects(runCorrectionFlowDocumentReviewLiveLauncher([`--expected-head=${exactHead}`], {
    assertLocalInteractiveRuntime() {}, gitOutput(args) { return args[0] === "rev-parse" ? exactHead : ""; },
    now: () => new Date("2026-10-16T22:00:00.000Z"),
    write(value) { writes.push(value); if (value.includes('"awaiting_manifest_consent"')) manifestHash = JSON.parse(value).safeManifest.manifestHash; },
    async readVisible() { return manifestHash; }, async readSecret() { return credential; },
    async execute() { return { ...safeReceipt(manifestHash), rawText: "private generated document" }; },
    async persistReceipt() { saves++; return { path: "/synthetic/private/receipt.json", sha256: "a".repeat(64) }; }
  }), (error: unknown) => (error as { code?: string }).code === "SAFE_RECEIPT_INVALID");
  assert.equal(saves, 0);
  assert.equal(writes.length, 1);
  assert.doesNotMatch(writes.join("\n"), /private generated document/u);
});

test("a final closed stdout cannot remove the receipt already saved before printing", async () => {
  let manifestHash = "";
  let saved: CorrectionFlowDocumentReviewReceipt | null = null;
  const initialListeners = process.listenerCount("SIGHUP");
  await assert.rejects(runCorrectionFlowDocumentReviewLiveLauncher([`--expected-head=${exactHead}`], {
    assertLocalInteractiveRuntime() {}, gitOutput(args) { return args[0] === "rev-parse" ? exactHead : ""; },
    now: () => new Date("2026-10-16T22:00:00.000Z"),
    write(value) {
      if (value.includes('"awaiting_manifest_consent"')) manifestHash = JSON.parse(value).safeManifest.manifestHash;
      else throw Object.assign(new Error("stdout closed"), { code: "EPIPE" });
    },
    async readVisible() { return manifestHash; }, async readSecret() { return credential; },
    async execute() { return safeReceipt(manifestHash); },
    async persistReceipt(receipt) { saved = receipt; return { path: "/synthetic/private/receipt.json", sha256: "a".repeat(64) }; }
  }), (error: unknown) => (error as { code?: string }).code === "EPIPE");
  assert.deepEqual(saved, safeReceipt(manifestHash));
  assert.equal(process.listenerCount("SIGHUP"), initialListeners);
});
