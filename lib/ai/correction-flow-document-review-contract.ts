import { z } from "zod";

import { hashAiInput } from "@/lib/ai/input-hash";

export const CORRECTION_FLOW_DOCUMENT_REVIEW_CONTRACT_VERSION = "1" as const;

const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const gitSha = z.string().regex(/^[a-f0-9]{40}$/u);
const documentKind = z.enum(["resume", "cover_letter"]);
const disposition = z.enum(["approved", "needs_revision"]);
const revisionReason = z.enum(["clarity", "tone", "formatting", "length", "other"]);

const resumeIdentity = z.object({
  kind: z.literal("resume"),
  validatedOutputHash: sha256,
  renderedPdfHash: sha256
}).strict();

const coverLetterIdentity = z.object({
  kind: z.literal("cover_letter"),
  validatedOutputHash: sha256,
  renderedPdfHash: sha256
}).strict();

const envelopeInputSchema = z.object({
  manifestHash: sha256,
  exactHead: gitSha,
  payloadHash: sha256,
  sourceResumeHash: sha256,
  profileHash: sha256,
  jobProjectionHash: sha256,
  reviewedEvidenceHash: sha256,
  factCatalogHash: sha256,
  promptVersion: z.string().min(1).max(40),
  model: z.string().min(1).max(120),
  thinkingLevel: z.enum(["LOW", "MEDIUM", "HIGH"]),
  generationId: z.string().min(1).max(160),
  documents: z.tuple([resumeIdentity, coverLetterIdentity])
}).strict();

const envelopeSchema = envelopeInputSchema.extend({
  contractVersion: z.literal(CORRECTION_FLOW_DOCUMENT_REVIEW_CONTRACT_VERSION),
  envelopeHash: sha256
}).strict();

const resumeDelivery = z.object({
  kind: z.literal("resume"),
  renderedPdfHash: sha256,
  delivered: z.literal(true)
}).strict();

const coverLetterDelivery = z.object({
  kind: z.literal("cover_letter"),
  renderedPdfHash: sha256,
  delivered: z.literal(true)
}).strict();

const reviewDecisionFields = {
  validatedOutputHash: sha256,
  renderedPdfHash: sha256,
  disposition,
  reason: revisionReason.nullable(),
  reviewedAllPages: z.literal(true),
  reviewedWritingQuality: z.literal(true),
  reviewedVisualLayout: z.literal(true)
} as const;

const resumeDecision = z.object({
  kind: z.literal("resume"),
  ...reviewDecisionFields
}).strict().superRefine((value, context) => {
  if ((value.disposition === "approved") !== (value.reason === null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["reason"], message: "Reason must be null only for approval." });
  }
});

const coverLetterDecision = z.object({
  kind: z.literal("cover_letter"),
  ...reviewDecisionFields
}).strict().superRefine((value, context) => {
  if ((value.disposition === "approved") !== (value.reason === null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["reason"], message: "Reason must be null only for approval." });
  }
});

const submissionSchema = z.object({
  envelopeHash: sha256,
  documents: z.tuple([resumeDecision, coverLetterDecision])
}).strict();

const attestedDocumentFields = {
  validatedOutputHash: sha256,
  deliveredPdfHash: sha256,
  disposition,
  reason: revisionReason.nullable(),
  reviewedAllPages: z.literal(true),
  reviewedWritingQuality: z.literal(true),
  reviewedVisualLayout: z.literal(true)
} as const;

const attestationCoreSchema = z.object({
  contractVersion: z.literal(CORRECTION_FLOW_DOCUMENT_REVIEW_CONTRACT_VERSION),
  reviewEnvelopeHash: sha256,
  reviewedAt: z.string().datetime({ offset: true }),
  documents: z.tuple([
    z.object({ kind: z.literal("resume"), ...attestedDocumentFields }).strict(),
    z.object({ kind: z.literal("cover_letter"), ...attestedDocumentFields }).strict()
  ])
}).strict();

const attestationSchema = attestationCoreSchema.extend({ attestationHash: sha256 }).strict();

export type CorrectionFlowDocumentReviewEnvelope = z.infer<typeof envelopeSchema>;
export type CorrectionFlowDocumentReviewAttestation = z.infer<typeof attestationSchema>;
export type CorrectionFlowDocumentReviewSubmission = z.infer<typeof submissionSchema>;

function freezeEnvelope(value: z.infer<typeof envelopeSchema>): CorrectionFlowDocumentReviewEnvelope {
  value.documents.forEach(Object.freeze);
  Object.freeze(value.documents);
  return Object.freeze(value);
}

export function buildCorrectionFlowDocumentReviewEnvelope(
  input: unknown
): CorrectionFlowDocumentReviewEnvelope {
  const parsed = envelopeInputSchema.parse(input);
  const core = {
    contractVersion: CORRECTION_FLOW_DOCUMENT_REVIEW_CONTRACT_VERSION,
    ...parsed,
    documents: parsed.documents.map((document) => ({ ...document })) as [
      z.infer<typeof resumeIdentity>,
      z.infer<typeof coverLetterIdentity>
    ]
  };
  return freezeEnvelope(envelopeSchema.parse({
    ...core,
    envelopeHash: hashAiInput("correctionFlowDocumentReviewEnvelope", "1", core)
  }));
}

export function createCorrectionFlowDocumentReviewAttestation(
  envelopeValue: unknown,
  deliveryValue: unknown,
  submissionValue: unknown,
  reviewedAt: string
): CorrectionFlowDocumentReviewAttestation {
  const envelope = envelopeSchema.parse(envelopeValue);
  const delivery = z.tuple([resumeDelivery, coverLetterDelivery]).parse(deliveryValue);
  const submission = submissionSchema.parse(submissionValue);
  if (submission.envelopeHash !== envelope.envelopeHash) {
    throw new Error("Document review submission does not match the current envelope.");
  }
  for (let index = 0; index < envelope.documents.length; index += 1) {
    const expected = envelope.documents[index];
    const delivered = delivery[index];
    const decision = submission.documents[index];
    if (
      expected.kind !== delivered.kind ||
      expected.kind !== decision.kind ||
      expected.renderedPdfHash !== delivered.renderedPdfHash ||
      expected.renderedPdfHash !== decision.renderedPdfHash ||
      expected.validatedOutputHash !== decision.validatedOutputHash
    ) {
      throw new Error("Document review submission does not match the delivered document hashes.");
    }
  }
  const core = attestationCoreSchema.parse({
    contractVersion: CORRECTION_FLOW_DOCUMENT_REVIEW_CONTRACT_VERSION,
    reviewEnvelopeHash: envelope.envelopeHash,
    reviewedAt,
    documents: submission.documents.map((decision, index) => ({
      kind: decision.kind,
      validatedOutputHash: decision.validatedOutputHash,
      deliveredPdfHash: delivery[index].renderedPdfHash,
      disposition: decision.disposition,
      reason: decision.reason,
      reviewedAllPages: decision.reviewedAllPages,
      reviewedWritingQuality: decision.reviewedWritingQuality,
      reviewedVisualLayout: decision.reviewedVisualLayout
    }))
  });
  const attestation = attestationSchema.parse({
    ...core,
    attestationHash: hashAiInput("correctionFlowDocumentReviewAttestation", "1", core)
  });
  attestation.documents.forEach(Object.freeze);
  Object.freeze(attestation.documents);
  return Object.freeze(attestation);
}

export function isCorrectionFlowDocumentReviewCurrent(
  attestationValue: unknown,
  envelopeValue: unknown
) {
  const attestation = attestationSchema.safeParse(attestationValue);
  const envelope = envelopeSchema.safeParse(envelopeValue);
  if (!attestation.success || !envelope.success) return false;
  const { attestationHash, ...core } = attestation.data;
  return attestation.data.reviewEnvelopeHash === envelope.data.envelopeHash &&
    attestationHash === hashAiInput("correctionFlowDocumentReviewAttestation", "1", core);
}

export const correctionFlowDocumentReviewSchemas = Object.freeze({
  envelope: envelopeSchema,
  submission: submissionSchema,
  attestation: attestationSchema,
  delivery: z.tuple([resumeDelivery, coverLetterDelivery])
});
