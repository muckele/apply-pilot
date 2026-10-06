import { z } from "zod";

import type {
  QualificationExpectedCheckpoint,
  QualificationPreparation,
  QualificationReviewArtifactData
} from "@/lib/ai/job-match-qualification";

const recommendationSchema = z.enum(["apply now", "consider", "skip"]);
const preferenceDispositionSchema = z.enum(["aligned", "conflict", "unknown", "not_applicable"]);
const caseDecisionSchema = z.object({
  caseId: z.string().min(1),
  factsCurrent: z.literal(true),
  clarifications: z.array(z.object({
    questionId: z.string().min(1),
    answer: z.enum(["yes", "no", "not_sure", "skip"]),
    context: z.string().max(2_000)
  }).strict()),
  preferences: z.object({
    location: preferenceDispositionSchema,
    workStyle: preferenceDispositionSchema,
    compensation: preferenceDispositionSchema
  }).strict(),
  recommendation: recommendationSchema,
  rationale: z.string().trim().min(1).max(2_000)
}).strict();

export type QualificationOwnerReviewDecision = z.infer<typeof caseDecisionSchema>;
export type QualificationReviewArtifact = QualificationReviewArtifactData;

export type ReviewEvidenceItem = Readonly<{
  ref: string;
  label: string;
  title: string;
  details: readonly string[];
  selectionLabel: string;
}>;

export type QualificationJobContext = Readonly<{
  title: string;
  company: string;
  location: string;
  workArrangement: string;
  compensation: string;
  responsibilities: readonly string[];
  technologies: readonly string[];
  sourceUrl: string;
  capturedAt: string;
  capturedAtLabel: string;
}>;

export function parseQualificationOwnerReviewDecision(value: unknown) {
  return caseDecisionSchema.parse(value);
}

export function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

export function assertQualificationOwnerReviewCheckpoint(
  expected: QualificationExpectedCheckpoint,
  actual: QualificationPreparation
) {
  const validHash = (value: string) => /^[a-f0-9]{64}$/u.test(value);
  if (!validHash(expected.manifestHash)
    || !validHash(expected.resumeProjectionHash)
    || !validHash(expected.profileProjectionHash)
    || expected.manifestHash !== actual.safeManifest.manifestHash
    || expected.resumeProjectionHash !== actual.safeManifest.resumeProjectionHash
    || expected.profileProjectionHash !== actual.safeManifest.profileProjectionHash) {
    throw new Error("Qualification review checkpoint did not exactly match the recaptured input.");
  }
}
