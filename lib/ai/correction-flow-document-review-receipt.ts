import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, link, lstat, mkdtemp, open, rmdir, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

import { CORRECTION_FLOW_DOCUMENT_VISIBLE_REVIEW_CONTRACT_VERSION } from "@/lib/ai/correction-flow-document-review";
import { correctionFlowDocumentReviewSchemas } from "@/lib/ai/correction-flow-document-review-contract";

const directoryPrefix = ".apply-pilot-document-review-receipt-";
export const CORRECTION_FLOW_SAFE_RECEIPT_PERSISTENCE = Object.freeze({
  enabled: true,
  contents: "sanitized_final_receipt_only",
  location: `~/${directoryPrefix}*/receipt.json`,
  directoryMode: "0700",
  fileMode: "0600"
});

const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const count = z.number().int().nonnegative().safe();
const failureCode = z.enum([
  "AI_MODEL_PRICING_WINDOW_UNSAFE", "CONSERVATIVE_RESERVATION_EXCEEDED", "DIAGNOSTIC_ALREADY_USED",
  "DOCUMENT_DIAGNOSTIC_FAILED", "EXECUTION_CANCELLED", "EXPORT_VERIFICATION_FAILED", "GEMINI_PROVIDER_FAILED",
  "PROVIDER_DOCUMENT_CLAIM_INVALID", "PROVIDER_DOCUMENT_SCHEMA_INVALID", "PROVIDER_STAGE_NOT_APPROVED",
  "OWNER_REVIEW_INCOMPLETE", "OWNER_REVIEW_CANCELLED", "OWNER_REVIEW_EXPIRED",
  "APPLICATION_DOCUMENT_APPLICANT_EVIDENCE_REQUIRED", "APPLICATION_DOCUMENT_BULLET_SOURCE_MISMATCH",
  "APPLICATION_DOCUMENT_CLAIM_NOT_IN_OUTPUT", "APPLICATION_DOCUMENT_EVIDENCE_REQUIRED",
  "APPLICATION_DOCUMENT_NEGATION_REVERSAL", "APPLICATION_DOCUMENT_UNKNOWN_REFERENCE",
  "APPLICATION_DOCUMENT_UNSUPPORTED_CLAIM", "APPLICATION_DOCUMENT_UNSUPPORTED_EXCERPT",
  "APPLICATION_DOCUMENT_UNKNOWN_FACT_ID", "APPLICATION_DOCUMENT_UNUSED_FACT_ID", "APPLICATION_DOCUMENT_INCOMPLETE",
  "APPLICATION_DOCUMENT_QUALITY_REQUIRED"
]);
// Only server-owned schema/reference names may survive. A syntactically plausible prose key is not a safe path.
const pathNames = new Set([
  "output", "professionalSummary", "professionalSummaryFactId", "skillsSection", "rolesOrProjectsToEmphasize", "bulletRewrites",
  "rewrite", "original", "reason", "text", "factId", "resumeTextClaims", "claimEvidence", "claimsUsed",
  "claim", "citations", "ref", "excerpt", "resumeText", "line", "title", "coverLetter", "angle",
  "unsupportedKeywords", "formattingWarnings", "resume", "profile", "summary", "rawText", "header",
  "skills", "achievements", "workHistory", "projects", "education", "certifications", "skillsToEmphasize",
  "reviewedEvidence", "facts", "fact"
]);
const fieldPath = z.string().max(240).refine((value) =>
  /^output(?:\.[A-Za-z][A-Za-z0-9]*|\[\d+\])*$/u.test(value) &&
  (value.match(/[A-Za-z][A-Za-z0-9]*/gu) ?? []).every((part) => pathNames.has(part))
);
const originFieldPath = z.string().max(160).regex(
  /^(?:professionalSummary|(?:skillsSection|rolesOrProjectsToEmphasize)\[\d+\]\.text|bulletRewrites\[\d+\]\.rewrite|(?:resumeTextClaims|claimsUsed)\[\d+\]\.claim)$/u
);
const receiptSchema = z.object({
  contractVersion: z.literal(CORRECTION_FLOW_DOCUMENT_VISIBLE_REVIEW_CONTRACT_VERSION),
  status: z.enum(["approved", "needs_revision", "stopped"]),
  manifestHash: hash, exactHead: z.string().regex(/^[a-f0-9]{40}$/u),
  providerMode: z.enum(["offline_stubbed", "live_synthetic"]),
  conservativeReservationMicros: count, providerCallsStarted: count, providerCallsCompleted: count,
  knownInputTokens: count, knownOutputTokens: count, knownCachedInputTokens: count,
  knownEstimatedCostMicros: count, unknownBillingCallCount: count,
  noRetryAttempted: z.literal(true), noFallbackAttempted: z.literal(true), stoppedAfterFirstFailure: z.literal(true),
  rawProviderOutputRetained: z.literal(false), validatedDocumentPersistentRetention: z.literal(false),
  safeReceiptOnly: z.literal(true),
  failureStage: z.enum(["tailored_resume", "cover_letter", "verify_exports", "owner_review"]).nullable(),
  failureCode: failureCode.nullable(),
  failureClass: z.enum(["unsupported_applicant_term", "source_relation_mismatch"]).nullable(),
  failureFieldPath: fieldPath.nullable(),
  failureClaimSource: z.object({ factId: z.string().regex(/^fact:\d{4,6}$/u), originFieldPath,
    reason: z.enum(["ineligible_source", "not_standalone", "ordered_token_mismatch", "not_in_output"])
  }).strict().nullable().optional(),
  envelopeHash: hash.nullable(),
  reviewAttestation: correctionFlowDocumentReviewSchemas.attestation.nullable()
}).strict();

function boundedError(code: "SAFE_RECEIPT_INVALID" | "SAFE_RECEIPT_WRITE_FAILED") {
  return Object.assign(new Error(code === "SAFE_RECEIPT_INVALID"
    ? "Safe receipt did not match the retention allowlist." : "Safe receipt could not be saved."), { code });
}

/** Validate before any serialization or filesystem mutation; never expose raw schema errors. */
export function serializeCorrectionFlowDocumentReviewReceipt(value: unknown, forbiddenValues: readonly string[] = []) {
  const parsed = receiptSchema.safeParse(value);
  if (!parsed.success) throw boundedError("SAFE_RECEIPT_INVALID");
  const serialized = `${JSON.stringify({ status: parsed.data.status, receipt: parsed.data }, null, 2)}\n`;
  if (forbiddenValues.some((forbidden) => forbidden.length > 0 && serialized.includes(forbidden))) {
    throw boundedError("SAFE_RECEIPT_INVALID");
  }
  return serialized;
}

async function assertOwnerDirectory(path: string, privateDirectory: boolean) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() ||
    (info.mode & (privateDirectory ? 0o077 : 0o022)) !== 0) throw boundedError("SAFE_RECEIPT_WRITE_FAILED");
}

/** Publish complete bytes atomically with link(2)'s exclusive destination semantics, never rename-overwrite. */
export async function publishPrivateCorrectionFlowReceipt(
  directory: string, value: unknown, forbiddenValues: readonly string[] = []
): Promise<Readonly<{ path: string; sha256: string }>> {
  const serialized = serializeCorrectionFlowDocumentReviewReceipt(value, forbiddenValues);
  const destination = join(directory, "receipt.json");
  const staged = join(directory, `.receipt-${randomUUID()}.tmp`);
  let stagedCreated = false;
  try {
    await assertOwnerDirectory(directory, true);
    const file = await open(staged, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    stagedCreated = true;
    try {
      await file.chmod(0o600);
      await file.writeFile(serialized, "utf8");
      await file.sync();
    } finally { await file.close(); }
    await link(staged, destination); // Existing regular files and symlinks both fail with EEXIST.
    await unlink(staged);
    stagedCreated = false;
    const directoryHandle = await open(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
    return Object.freeze({ path: destination, sha256: createHash("sha256").update(serialized).digest("hex") });
  } catch {
    throw boundedError("SAFE_RECEIPT_WRITE_FAILED");
  } finally {
    if (stagedCreated) await unlink(staged).catch(() => undefined);
  }
}

/** A fresh private owner-local directory avoids both collisions and reused/symlinked receipt roots. */
export async function persistCorrectionFlowDocumentReviewReceipt(
  value: unknown,
  { parentDirectory = homedir(), forbiddenValues = [] }: {
    parentDirectory?: string;
    forbiddenValues?: readonly string[];
  } = {}
) {
  // Reject unsafe content before even allocating a directory.
  serializeCorrectionFlowDocumentReviewReceipt(value, forbiddenValues);
  let directory: string | null = null;
  try {
    await assertOwnerDirectory(parentDirectory, false);
    directory = await mkdtemp(join(parentDirectory, directoryPrefix));
    await chmod(directory, 0o700);
    return await publishPrivateCorrectionFlowReceipt(directory, value, forbiddenValues);
  } catch (error) {
    if (directory) await rmdir(directory).catch(() => undefined); // Never remove a published receipt.
    if ((error as { code?: unknown })?.code === "SAFE_RECEIPT_INVALID") throw boundedError("SAFE_RECEIPT_INVALID");
    throw boundedError("SAFE_RECEIPT_WRITE_FAILED");
  }
}
