import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, stat, lstat, readdir, symlink, writeFile, chmod, rm, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { CorrectionFlowDocumentReviewReceipt } from "@/lib/ai/correction-flow-document-review";
import {
  persistCorrectionFlowDocumentReviewReceipt,
  publishPrivateCorrectionFlowReceipt,
  serializeCorrectionFlowDocumentReviewReceipt
} from "@/lib/ai/correction-flow-document-review-receipt";

function receipt(): CorrectionFlowDocumentReviewReceipt {
  return {
    contractVersion: "3", status: "stopped", manifestHash: "a".repeat(64), exactHead: "b".repeat(40),
    providerMode: "live_synthetic", conservativeReservationMicros: 112125,
    providerCallsStarted: 1, providerCallsCompleted: 1, knownInputTokens: 200,
    knownOutputTokens: 120, knownCachedInputTokens: 0, knownEstimatedCostMicros: 600,
    unknownBillingCallCount: 0, noRetryAttempted: true, noFallbackAttempted: true,
    stoppedAfterFirstFailure: true, rawProviderOutputRetained: false,
    validatedDocumentPersistentRetention: false, safeReceiptOnly: true,
    failureStage: "tailored_resume", failureCode: "APPLICATION_DOCUMENT_EVIDENCE_REQUIRED",
    failureClass: null, failureFieldPath: "output.resumeText.line[3]", failureClaimSource: null,
    envelopeHash: null, reviewAttestation: null
  };
}

async function temporary() {
  const path = await mkdtemp(join(tmpdir(), "ap-safe-receipt-test-"));
  await chmod(path, 0o700);
  return path;
}

function reviewed(status: "approved" | "needs_revision"): CorrectionFlowDocumentReviewReceipt {
  return { ...receipt(), status, failureStage: null, failureCode: null, failureFieldPath: null,
    providerCallsStarted: 2, providerCallsCompleted: 2, envelopeHash: "c".repeat(64),
    reviewAttestation: {
      contractVersion: "1", reviewEnvelopeHash: "c".repeat(64), reviewedAt: "2026-10-16T22:00:00.000Z",
      attestationHash: "d".repeat(64),
      documents: ["resume", "cover_letter"].map((kind) => ({
        kind, validatedOutputHash: "e".repeat(64), deliveredPdfHash: "f".repeat(64),
        disposition: status, reason: status === "approved" ? null : "clarity", reviewedAllPages: true,
        reviewedWritingQuality: true, reviewedVisualLayout: true
      })) as NonNullable<CorrectionFlowDocumentReviewReceipt["reviewAttestation"]>["documents"]
    }
  };
}

test("safe final receipts persist exact bytes privately, with verified path/hash and no staged file", async () => {
  const parentDirectory = await temporary();
  try {
    for (const value of [reviewed("approved"), reviewed("needs_revision"), receipt(),
      { ...receipt(), providerCallsCompleted: 0, unknownBillingCallCount: 1,
        knownInputTokens: 0, knownOutputTokens: 0, knownEstimatedCostMicros: 0, failureCode: "EXECUTION_CANCELLED" },
      ...["OWNER_REVIEW_INCOMPLETE", "OWNER_REVIEW_CANCELLED", "OWNER_REVIEW_EXPIRED", "EXECUTION_CANCELLED"]
        .map((failureCode) => ({ ...receipt(), failureStage: "owner_review" as const, failureCode }))]) {
      const saved = await persistCorrectionFlowDocumentReviewReceipt(value, { parentDirectory });
      const bytes = await readFile(saved.path);
      assert.equal(saved.sha256, createHash("sha256").update(bytes).digest("hex"));
      assert.deepEqual(JSON.parse(bytes.toString()), { status: value.status, receipt: value });
      const directory = join(saved.path, "..");
      assert.equal((await stat(directory)).mode & 0o777, 0o700);
      assert.equal((await stat(saved.path)).mode & 0o777, 0o600);
      assert.deepEqual(await readdir(directory), ["receipt.json"]);
    }
  } finally { await rm(parentDirectory, { recursive: true, force: true }); }
});

test("concurrent receipts have unique paths and never overwrite earlier receipt bytes", async () => {
  const parentDirectory = await temporary();
  try {
    const saved = await Promise.all(Array.from({ length: 10 }, (_, index) =>
      persistCorrectionFlowDocumentReviewReceipt({ ...receipt(), knownInputTokens: index }, { parentDirectory })));
    assert.equal(new Set(saved.map((value) => value.path)).size, 10);
    for (let index = 0; index < saved.length; index++) {
      assert.equal(JSON.parse(await readFile(saved[index].path, "utf8")).receipt.knownInputTokens, index);
    }
  } finally { await rm(parentDirectory, { recursive: true, force: true }); }
});

test("atomic publisher refuses existing files and symlinks without touching their contents", async () => {
  for (const mode of ["file", "symlink"] as const) {
    const directory = await temporary();
    try {
      const destination = join(directory, "receipt.json");
      const outside = join(directory, "owner-file");
      await writeFile(outside, "unchanged");
      if (mode === "file") await writeFile(destination, "existing");
      else await symlink(outside, destination);
      await assert.rejects(publishPrivateCorrectionFlowReceipt(directory, receipt()),
        (error: unknown) => error instanceof Error && error.message === "Safe receipt could not be saved.");
      assert.equal(await readFile(outside, "utf8"), "unchanged");
      assert.equal(await readFile(destination, "utf8"), mode === "file" ? "existing" : "unchanged");
      assert.equal((await lstat(destination)).isSymbolicLink(), mode === "symlink");
      assert.deepEqual((await readdir(directory)).sort(), ["owner-file", "receipt.json"]);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
});

test("untrusted directory symlinks and nonprivate directories fail without writing", async () => {
  const parentDirectory = await temporary();
  const link = `${parentDirectory}-link`;
  try {
    await symlink(parentDirectory, link);
    await assert.rejects(persistCorrectionFlowDocumentReviewReceipt(receipt(), { parentDirectory: link }));
    await chmod(parentDirectory, 0o777);
    await assert.rejects(persistCorrectionFlowDocumentReviewReceipt(receipt(), { parentDirectory }));
    assert.deepEqual(await readdir(parentDirectory), []);
  } finally { await rm(link, { force: true }); await rm(parentDirectory, { recursive: true, force: true }); }
});

test("write errors expose a bounded code with no private filesystem details or fabricated saved result", async () => {
  const parentDirectory = await temporary();
  try {
    const privatePath = join(parentDirectory, "private-generated-prose");
    await writeFile(privatePath, "not a directory");
    await assert.rejects(persistCorrectionFlowDocumentReviewReceipt(receipt(), { parentDirectory: privatePath }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, "SAFE_RECEIPT_WRITE_FAILED");
        assert.doesNotMatch(String(error), /private-generated-prose|ENOTDIR/u);
        return true;
      });
  } finally { await rm(parentDirectory, { recursive: true, force: true }); }
});

test("strict receipt allowlist rejects unknown prose, credentials and capability URLs at every nesting level", () => {
  const secret = "synthetic-credential-never-retain";
  const url = "http://127.0.0.1:54321/review/private-token";
  const mutations = [
    { ...receipt(), generatedText: "Private generated prose" },
    { ...receipt(), credentials: secret }, { ...receipt(), reviewUrl: url },
    { ...receipt(), failureCode: secret }, { ...receipt(), failureFieldPath: "output.privateGeneratedProse" },
    { ...receipt(), failureFieldPath: url },
    { ...receipt(), failureClaimSource: { factId: "fact:0007", originFieldPath: "professionalSummary", reason: "not_in_output", text: secret } },
    { ...reviewed("approved"), reviewAttestation: { ...reviewed("approved").reviewAttestation, prose: secret } }
  ];
  for (const mutation of mutations) {
    assert.throws(() => serializeCorrectionFlowDocumentReviewReceipt(mutation),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, "SAFE_RECEIPT_INVALID");
        assert.doesNotMatch(String(error), /synthetic-credential|private-token|Private generated prose/u);
        return true;
      });
  }
  assert.throws(() => serializeCorrectionFlowDocumentReviewReceipt(receipt(), ["a".repeat(64)]),
    (error: unknown) => (error as { code?: string }).code === "SAFE_RECEIPT_INVALID");
});

test("valid bounded failure source metadata remains in the persisted receipt", () => {
  const value = { ...receipt(), failureClaimSource: {
    factId: "fact:0007", originFieldPath: "bulletRewrites[3].rewrite", reason: "not_in_output" as const
  } };
  assert.deepEqual(JSON.parse(serializeCorrectionFlowDocumentReviewReceipt(value)).receipt, value);
});

test("all safe summary fact-ID failure paths preserve usage and cost in saved receipts", async () => {
  const parentDirectory = await temporary();
  try {
    for (const failureCode of ["APPLICATION_DOCUMENT_EVIDENCE_REQUIRED", "APPLICATION_DOCUMENT_UNUSED_FACT_ID", "APPLICATION_DOCUMENT_UNKNOWN_FACT_ID"]) {
      const value = { ...receipt(), failureCode, failureFieldPath: "output.professionalSummaryFactId" };
      const saved = await persistCorrectionFlowDocumentReviewReceipt(value, { parentDirectory });
      assert.deepEqual(JSON.parse(await readFile(saved.path, "utf8")).receipt, value);
    }
  } finally { await rm(parentDirectory, { recursive: true, force: true }); }
});


test("a staged write failure leaves no receipt or partial staging file and hides raw errors", async (context) => {
  const parentDirectory = await temporary();
  try {
    const probe = await open(join(parentDirectory, "probe"), "wx", 0o600);
    const prototype = Object.getPrototypeOf(probe);
    await probe.close();
    await rm(join(parentDirectory, "probe"));
    const mocked = context.mock.method(prototype, "writeFile", async () => {
      throw new Error("private provider text from a disk failure must never escape");
    });
    try {
      await assert.rejects(persistCorrectionFlowDocumentReviewReceipt(receipt(), { parentDirectory }),
        (error: unknown) => {
          assert.equal((error as { code?: string }).code, "SAFE_RECEIPT_WRITE_FAILED");
          assert.doesNotMatch(String(error), /provider text|disk failure/u);
          return true;
        });
      assert.deepEqual(await readdir(parentDirectory), []);
    } finally { mocked.mock.restore(); }
  } finally { await rm(parentDirectory, { recursive: true, force: true }); }
});


test("concurrent atomic publication to one destination admits exactly one complete receipt", async () => {
  const directory = await temporary();
  try {
    const outcomes = await Promise.allSettled(Array.from({ length: 8 }, (_, index) =>
      publishPrivateCorrectionFlowReceipt(directory, { ...receipt(), knownInputTokens: index })));
    assert.equal(outcomes.filter(result => result.status === "fulfilled").length, 1);
    assert.equal(outcomes.filter(result => result.status === "rejected").length, 7);
    const saved = outcomes.find(result => result.status === "fulfilled") as PromiseFulfilledResult<{ path: string; sha256: string }>;
    const bytes = await readFile(saved.value.path);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), saved.value.sha256);
    assert.deepEqual(await readdir(directory), ["receipt.json"]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
