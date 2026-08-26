import { z } from "zod";

import {
  APPLICATION_FORM_FIELD_TYPES,
  compareCodeUnits,
  canonicalizeFormComparisonText,
  countUnicodeCodePoints,
  hashDomainSeparated,
  hashDomainSeparatedText,
  hasVisibleBaseCharacter,
  isWellFormedUnicode,
  utf8ByteLength,
  type ApplicationFormFieldType
} from "@/lib/application-runs/form-inspection";
import {
  APPLICATION_ANSWER_DISPOSITION_REASONS,
  APPLICATION_ANSWER_DISPOSITIONS,
  APPLICATION_QUESTION_CLASSIFICATIONS,
  isDispositionWithinPermitted,
  type ApplicationAnswerDisposition,
  type ApplicationAnswerDispositionReason
} from "@/lib/application-runs/question-classification";

export { canonicalJson } from "@/lib/application-runs/form-inspection";

export const ANSWER_PACKET_SCHEMA_VERSION = 1 as const;
export const ANSWER_PACKET_BUILDER_VERSION = 1 as const;
export const ANSWER_PACKET_CANONICALIZER_VERSION = 1 as const;

export const MAX_SCALAR_PROPOSAL_CODE_POINTS = 2_048;
export const MAX_SCALAR_PROPOSAL_UTF8_BYTES = 8 * 1_024;
export const MAX_MULTI_OPTION_PROPOSAL_KEYS = 20;

export const APPLICATION_ANSWER_PROPOSAL_KINDS = [
  "SCALAR",
  "BOOLEAN",
  "OPTIONS",
  "DOCUMENT_REFERENCE"
] as const;

export const APPLICATION_DOCUMENT_ARTIFACT_TYPES = ["RESUME", "COVER_LETTER"] as const;
export const APPLICATION_ANSWER_REVIEW_HASH_VERSIONS = ["CANONICAL_PROPOSAL_V1"] as const;
export const APPLICATION_ANSWER_SOURCE_TYPES = ["ANSWER_VAULT", "TAILORED_RESUME", "COVER_LETTER"] as const;
export const APPLICATION_ANSWER_SOURCE_CATEGORIES = [
  "LINKS",
  "AVAILABILITY",
  "TAILORED_RESUME",
  "COVER_LETTER"
] as const;
export const APPLICATION_RUN_ANSWER_REVIEW_STATUSES = ["PENDING", "APPROVED", "REJECTED"] as const;

export type ApplicationAnswerProposalKind = (typeof APPLICATION_ANSWER_PROPOSAL_KINDS)[number];
export type ApplicationDocumentArtifactType = (typeof APPLICATION_DOCUMENT_ARTIFACT_TYPES)[number];
export type ApplicationAnswerReviewHashVersion = (typeof APPLICATION_ANSWER_REVIEW_HASH_VERSIONS)[number];
export type ApplicationAnswerSourceType = (typeof APPLICATION_ANSWER_SOURCE_TYPES)[number];
export type ApplicationAnswerSourceCategory = (typeof APPLICATION_ANSWER_SOURCE_CATEGORIES)[number];
export type ApplicationRunAnswerReviewStatus = (typeof APPLICATION_RUN_ANSWER_REVIEW_STATUSES)[number];

export const ANSWER_PACKET_DOMAIN_ERROR_CODES = [
  "INVALID_PROPOSAL",
  "PROPOSAL_FIELD_MISMATCH",
  "DISPOSITION_ESCALATION",
  "DISPOSITION_REASON_MISMATCH",
  "PACKET_INVARIANT_VIOLATION"
] as const;

export type AnswerPacketDomainErrorCode = (typeof ANSWER_PACKET_DOMAIN_ERROR_CODES)[number];

export class AnswerPacketDomainError extends Error {
  readonly code: AnswerPacketDomainErrorCode;

  constructor(code: AnswerPacketDomainErrorCode, message: string) {
    super(message);
    this.name = "AnswerPacketDomainError";
    this.code = code;
  }
}

const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;
const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SOURCE_REVISION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,127}$/;
const SEMANTIC_FIELD_KEY_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
// Exact reviewed values reject only the narrow unsafe identity set used by the
// form normalizer: soft hyphen, blank Hangul fillers, deprecated Mongolian
// separator, invisible math/directional controls, ZWSP, and BOM. U+034F,
// U+17B4/U+17B5, variation selectors, Unicode tags, and U+200C/U+200D remain
// permitted when accompanied by a visible base; accepted strings stay exact
// and hash-significant. U+2800 is treated as a blank base, not globally banned,
// so real Braille text may still contain blank cells.
const PROHIBITED_PROPOSAL_CODE_POINTS = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u115f-\u1160\u180e\u200b\u200e\u200f\u202a-\u202e\u2060-\u206f\u3164\ufeff\uffa0]/u;

const sha256HexSchema = z.string().regex(SHA256_HEX_PATTERN);
const safeIdentifierSchema = z.string().regex(SAFE_IDENTIFIER_PATTERN);
const sourceRevisionSchema = z.string().regex(SOURCE_REVISION_PATTERN);
const semanticFieldKeySchema = z.string().max(128).regex(SEMANTIC_FIELD_KEY_PATTERN);
const safeVersionSchema = z.number().int().safe().positive();
const confidenceSchema = z
  .number()
  .int()
  .min(0)
  .max(100)
  .refine((value) => !Object.is(value, -0), { message: "Confidence must not be negative zero." });

function addSafeTextIssues(
  value: string,
  context: z.RefinementCtx,
  limits: { codePoints: number; utf8Bytes: number }
): void {
  if (!isWellFormedUnicode(value)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Text contains malformed Unicode." });
  }
  if (value.trim().length === 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Text must not be blank." });
  }
  if (!hasVisibleBaseCharacter(value)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Text must contain a visible base character." });
  }
  if (PROHIBITED_PROPOSAL_CODE_POINTS.test(value)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Text contains prohibited control characters." });
  }
  if (countUnicodeCodePoints(value) > limits.codePoints || utf8ByteLength(value) > limits.utf8Bytes) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Text exceeds the allowed size." });
  }
}

const scalarProposalValueSchema = z.string().superRefine((value, context) => {
  addSafeTextIssues(value, context, {
    codePoints: MAX_SCALAR_PROPOSAL_CODE_POINTS,
    utf8Bytes: MAX_SCALAR_PROPOSAL_UTF8_BYTES
  });
});

const scalarProposalSchema = z
  .object({
    kind: z.literal("SCALAR"),
    value: scalarProposalValueSchema
  })
  .strict();

const booleanProposalSchema = z
  .object({
    kind: z.literal("BOOLEAN"),
    value: z.boolean()
  })
  .strict();

const optionsProposalSchema = z
  .object({
    kind: z.literal("OPTIONS"),
    // The inspection contract allows up to 256 frozen choices. Canonicalization
    // deduplicates first, then enforces the smaller 20-key proposal limit.
    optionKeys: z.array(sha256HexSchema).min(1).max(256)
  })
  .strict();

const documentReferenceProposalSchema = z
  .object({
    kind: z.literal("DOCUMENT_REFERENCE"),
    artifactType: z.enum(APPLICATION_DOCUMENT_ARTIFACT_TYPES),
    documentId: safeIdentifierSchema,
    contentHash: sha256HexSchema
  })
  .strict();

const applicationAnswerProposalSchema = z.union([
  scalarProposalSchema,
  booleanProposalSchema,
  optionsProposalSchema,
  documentReferenceProposalSchema
]);

export type ApplicationAnswerProposal = Readonly<z.infer<typeof applicationAnswerProposalSchema>>;

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareCodeUnits);
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) {
    throw new AnswerPacketDomainError("PACKET_INVARIANT_VIOLATION", `${label} must not contain duplicates.`);
  }
}

export function parseApplicationAnswerProposal(value: unknown): ApplicationAnswerProposal {
  const parsed = applicationAnswerProposalSchema.parse(value);
  if (parsed.kind !== "OPTIONS") return parsed;

  const optionKeys = sortedUnique(parsed.optionKeys);
  if (optionKeys.length > MAX_MULTI_OPTION_PROPOSAL_KEYS) {
    throw new AnswerPacketDomainError("INVALID_PROPOSAL", "An option proposal exceeds the 20-key limit.");
  }
  return { kind: "OPTIONS", optionKeys };
}

export type FrozenApplicationAnswerChoice = Readonly<{
  key: string;
  disabled: boolean;
}>;

export type FrozenApplicationAnswerField = Readonly<{
  normalizedFieldKey: string;
  fieldFingerprint: string;
  fieldType: ApplicationFormFieldType;
  semanticFieldKey: string | null;
  choices: readonly FrozenApplicationAnswerChoice[];
}>;

export type ApplicationAnswerProposalCompatibilityInput = Readonly<{
  expectedField: Readonly<{
    normalizedFieldKey: string;
    fieldFingerprint: string;
    fieldType: ApplicationFormFieldType;
    semanticFieldKey: string | null;
  }>;
  frozenField: FrozenApplicationAnswerField;
}>;

const frozenApplicationAnswerChoiceSchema = z
  .object({
    key: sha256HexSchema,
    disabled: z.boolean()
  })
  .strict();

const applicationAnswerFieldIdentitySchema = z
  .object({
    normalizedFieldKey: sha256HexSchema,
    fieldFingerprint: sha256HexSchema,
    fieldType: z.enum(APPLICATION_FORM_FIELD_TYPES),
    semanticFieldKey: semanticFieldKeySchema.nullable()
  })
  .strict();

const frozenApplicationAnswerFieldSchema = applicationAnswerFieldIdentitySchema
  .extend({
    choices: z.array(frozenApplicationAnswerChoiceSchema).max(256)
  })
  .strict()
  .superRefine((field, context) => {
    const seen = new Set<string>();
    for (let index = 0; index < field.choices.length; index += 1) {
      const key = field.choices[index].key;
      if (seen.has(key)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["choices", index, "key"],
          message: "Frozen choices must have unique keys."
        });
      }
      seen.add(key);
    }
  });

const applicationAnswerProposalCompatibilityInputSchema = z
  .object({
    expectedField: applicationAnswerFieldIdentitySchema,
    frozenField: frozenApplicationAnswerFieldSchema
  })
  .strict();

const SCALAR_FIELD_TYPES = new Set<ApplicationFormFieldType>([
  "TEXT",
  "EMAIL",
  "TEL",
  "URL",
  "TEXTAREA",
  "NUMBER",
  "DATE"
]);
const SINGLE_OPTION_FIELD_TYPES = new Set<ApplicationFormFieldType>(["SELECT_ONE", "RADIO_GROUP"]);
const MULTI_OPTION_FIELD_TYPES = new Set<ApplicationFormFieldType>(["SELECT_MANY", "CHECKBOX_GROUP"]);

function assertProposalKindCompatibleWithField(
  proposal: ApplicationAnswerProposal,
  fieldType: ApplicationFormFieldType,
  semanticFieldKey: string | null
): void {
  if (proposal.kind === "SCALAR" && !SCALAR_FIELD_TYPES.has(fieldType)) {
    throw new AnswerPacketDomainError("PROPOSAL_FIELD_MISMATCH", "A scalar proposal is incompatible with this field type.");
  }
  if (proposal.kind === "BOOLEAN" && fieldType !== "CHECKBOX_BOOLEAN") {
    throw new AnswerPacketDomainError("PROPOSAL_FIELD_MISMATCH", "A Boolean proposal is incompatible with this field type.");
  }
  if (
    proposal.kind === "OPTIONS" &&
    !SINGLE_OPTION_FIELD_TYPES.has(fieldType) &&
    !MULTI_OPTION_FIELD_TYPES.has(fieldType)
  ) {
    throw new AnswerPacketDomainError("PROPOSAL_FIELD_MISMATCH", "An option proposal is incompatible with this field type.");
  }
  if (proposal.kind === "DOCUMENT_REFERENCE") {
    if (fieldType !== "FILE_UPLOAD") {
      throw new AnswerPacketDomainError(
        "PROPOSAL_FIELD_MISMATCH",
        "A document-reference proposal is incompatible with this field type."
      );
    }
    const expectedArtifactType =
      semanticFieldKey === "document.resume"
        ? "RESUME"
        : semanticFieldKey === "document.cover_letter"
          ? "COVER_LETTER"
          : null;
    if (proposal.artifactType !== expectedArtifactType) {
      throw new AnswerPacketDomainError(
        "PROPOSAL_FIELD_MISMATCH",
        "The document artifact does not match the field's server-owned semantic identity."
      );
    }
  }
}

export function parseCompatibleApplicationAnswerProposal(
  value: unknown,
  field: unknown
): ApplicationAnswerProposal {
  const parsedField = applicationAnswerProposalCompatibilityInputSchema.parse(field);
  const { expectedField, frozenField } = parsedField;
  if (
    expectedField.normalizedFieldKey !== frozenField.normalizedFieldKey ||
    expectedField.fieldFingerprint !== frozenField.fieldFingerprint ||
    expectedField.fieldType !== frozenField.fieldType ||
    expectedField.semanticFieldKey !== frozenField.semanticFieldKey
  ) {
    throw new AnswerPacketDomainError(
      "PROPOSAL_FIELD_MISMATCH",
      "The proposal field identity does not match the frozen inspection field."
    );
  }

  const proposal = parseApplicationAnswerProposal(value);
  assertProposalKindCompatibleWithField(
    proposal,
    expectedField.fieldType,
    expectedField.semanticFieldKey
  );

  const isChoiceField =
    SINGLE_OPTION_FIELD_TYPES.has(expectedField.fieldType) ||
    MULTI_OPTION_FIELD_TYPES.has(expectedField.fieldType);
  if (isChoiceField ? frozenField.choices.length === 0 : frozenField.choices.length > 0) {
    throw new AnswerPacketDomainError(
      "PACKET_INVARIANT_VIOLATION",
      "Frozen choices are incompatible with the frozen field type."
    );
  }

  if (proposal.kind !== "OPTIONS") return proposal;

  if (SINGLE_OPTION_FIELD_TYPES.has(expectedField.fieldType) && proposal.optionKeys.length !== 1) {
    throw new AnswerPacketDomainError("PROPOSAL_FIELD_MISMATCH", "A single-choice field requires exactly one option key.");
  }
  if (
    MULTI_OPTION_FIELD_TYPES.has(expectedField.fieldType) &&
    (proposal.optionKeys.length < 1 || proposal.optionKeys.length > MAX_MULTI_OPTION_PROPOSAL_KEYS)
  ) {
    throw new AnswerPacketDomainError("PROPOSAL_FIELD_MISMATCH", "A multi-choice field requires between 1 and 20 keys.");
  }

  const choices = new Map<string, FrozenApplicationAnswerChoice>();
  for (const choice of frozenField.choices) {
    choices.set(choice.key, choice);
  }
  for (const optionKey of proposal.optionKeys) {
    const choice = choices.get(optionKey);
    if (!choice) {
      throw new AnswerPacketDomainError("PROPOSAL_FIELD_MISMATCH", "The proposal refers to an unknown frozen option key.");
    }
    if (choice.disabled) {
      throw new AnswerPacketDomainError("PROPOSAL_FIELD_MISMATCH", "The proposal refers to a disabled frozen option.");
    }
  }
  return proposal;
}

const PROPOSAL_HASH_DOMAIN = "application-answer-proposal:v1\0";
const SOURCE_VALUE_HASH_DOMAIN = "application-answer-source-value:v1\0";
const SOURCE_FINGERPRINT_DOMAIN = "application-answer-source-fingerprint:v1\0";
const POLICY_HASH_DOMAIN = "application-answer-policy:v1\0";
const INPUT_HASH_DOMAIN = "application-answer-packet-input:v1\0";
const PACKET_HASH_DOMAIN = "application-answer-packet:v1\0";

export function computeApplicationAnswerProposalHash(value: unknown): string {
  return hashDomainSeparated(PROPOSAL_HASH_DOMAIN, parseApplicationAnswerProposal(value));
}

export function isApplicationAnswerProposalHashValid(value: unknown, expectedHash: unknown): boolean {
  const parsedHash = sha256HexSchema.safeParse(expectedHash);
  if (!parsedHash.success) return false;
  try {
    return computeApplicationAnswerProposalHash(value) === parsedHash.data;
  } catch {
    return false;
  }
}

const applicationAnswerSourceFingerprintInputSchema = z.discriminatedUnion("sourceType", [
  z
    .object({
      sourceType: z.literal("ANSWER_VAULT"),
      sourceId: safeIdentifierSchema,
      sourceRevision: sourceRevisionSchema,
      sourceCategory: z.enum(["LINKS", "AVAILABILITY"]),
      exactValue: scalarProposalValueSchema
    })
    .strict(),
  z
    .object({
      sourceType: z.literal("TAILORED_RESUME"),
      sourceId: safeIdentifierSchema,
      sourceRevision: sourceRevisionSchema,
      sourceCategory: z.literal("TAILORED_RESUME"),
      exactValue: sha256HexSchema
    })
    .strict(),
  z
    .object({
      sourceType: z.literal("COVER_LETTER"),
      sourceId: safeIdentifierSchema,
      sourceRevision: sourceRevisionSchema,
      sourceCategory: z.literal("COVER_LETTER"),
      exactValue: sha256HexSchema
    })
    .strict()
]);

export type ApplicationAnswerSourceFingerprintInput = z.infer<typeof applicationAnswerSourceFingerprintInputSchema>;

export type ApplicationAnswerSourceFingerprintResult = Readonly<{
  sourceFingerprint: string;
}>;

export function computeApplicationAnswerSourceFingerprint(
  input: unknown
): ApplicationAnswerSourceFingerprintResult {
  const parsed = applicationAnswerSourceFingerprintInputSchema.parse(input);
  const exactValueDigest = hashDomainSeparatedText(SOURCE_VALUE_HASH_DOMAIN, parsed.exactValue);
  const sourceFingerprint = hashDomainSeparated(SOURCE_FINGERPRINT_DOMAIN, {
    sourceCategory: parsed.sourceCategory,
    sourceId: parsed.sourceId,
    sourceRevision: parsed.sourceRevision,
    sourceType: parsed.sourceType,
    exactValueDigest
  });
  return { sourceFingerprint };
}

export const applicationAnswerPacketPolicyProjectionSchema = z
  .object({
    schemaVersion: z.literal(1),
    sensitiveAnswerPolicy: z.literal("EXCLUDE"),
    finalReviewRequired: z.literal(true)
  })
  .strict();

export type ApplicationAnswerPacketPolicyProjection = z.infer<
  typeof applicationAnswerPacketPolicyProjectionSchema
>;

export function computeApplicationAnswerPacketPolicyHash(input: unknown): string {
  return hashDomainSeparated(POLICY_HASH_DOMAIN, applicationAnswerPacketPolicyProjectionSchema.parse(input));
}

const applicationAnswerInputDocumentReferenceSchema = z
  .object({
    artifactType: z.enum(APPLICATION_DOCUMENT_ARTIFACT_TYPES),
    documentId: safeIdentifierSchema,
    contentHash: sha256HexSchema
  })
  .strict();

const applicationAnswerSourceLookupProjectionSchema = z
  .object({
    normalizedFieldKey: sha256HexSchema,
    candidateSourceFingerprints: z.array(sha256HexSchema).max(256)
  })
  .strict();

const applicationAnswerPacketInputProjectionSchema = z
  .object({
    schemaVersion: z.literal(1),
    inspectionVersion: z.number().int().safe().positive(),
    formFingerprint: sha256HexSchema,
    builderVersion: safeVersionSchema,
    classifierVersion: safeVersionSchema,
    canonicalizerVersion: safeVersionSchema,
    reviewHashVersion: z.literal("CANONICAL_PROPOSAL_V1"),
    policyHash: sha256HexSchema,
    documentReferences: z.array(applicationAnswerInputDocumentReferenceSchema).max(2),
    sourceLookups: z.array(applicationAnswerSourceLookupProjectionSchema).max(200)
  })
  .strict();

export type ApplicationAnswerPacketInputProjection = z.infer<typeof applicationAnswerPacketInputProjectionSchema>;

function compareDocumentReferences(
  left: z.infer<typeof applicationAnswerInputDocumentReferenceSchema>,
  right: z.infer<typeof applicationAnswerInputDocumentReferenceSchema>
): number {
  return (
    compareCodeUnits(left.artifactType, right.artifactType) ||
    compareCodeUnits(left.documentId, right.documentId) ||
    compareCodeUnits(left.contentHash, right.contentHash)
  );
}

export function canonicalizeApplicationAnswerPacketInputProjection(
  input: unknown
): ApplicationAnswerPacketInputProjection {
  const parsed = applicationAnswerPacketInputProjectionSchema.parse(input);
  const artifactTypes = parsed.documentReferences.map((document) => document.artifactType);
  assertUnique(artifactTypes, "Document artifact types");

  const lookupFieldKeys = parsed.sourceLookups.map((lookup) => lookup.normalizedFieldKey);
  assertUnique(lookupFieldKeys, "Source lookup field keys");

  return {
    ...parsed,
    documentReferences: [...parsed.documentReferences].sort(compareDocumentReferences),
    sourceLookups: parsed.sourceLookups
      .map((lookup) => {
        assertUnique(lookup.candidateSourceFingerprints, "Candidate source fingerprints");
        return {
          ...lookup,
          candidateSourceFingerprints: [...lookup.candidateSourceFingerprints].sort(compareCodeUnits)
        };
      })
      .sort((left, right) => compareCodeUnits(left.normalizedFieldKey, right.normalizedFieldKey))
  };
}

export function computeApplicationAnswerPacketInputHash(input: unknown): string {
  return hashDomainSeparated(INPUT_HASH_DOMAIN, canonicalizeApplicationAnswerPacketInputProjection(input));
}

const PACKET_FIELD_TYPES = [
  "TEXT",
  "EMAIL",
  "TEL",
  "URL",
  "TEXTAREA",
  "SELECT_ONE",
  "SELECT_MANY",
  "RADIO_GROUP",
  "CHECKBOX_BOOLEAN",
  "CHECKBOX_GROUP",
  "NUMBER",
  "DATE",
  "FILE_UPLOAD",
  "UNSUPPORTED"
] as const satisfies readonly ApplicationFormFieldType[];

const packetNormalizedQuestionSchema = z.string().superRefine((value, context) => {
  if (!isWellFormedUnicode(value)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Normalized question contains malformed Unicode." });
    return;
  }
  if (PROHIBITED_PROPOSAL_CODE_POINTS.test(value)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Normalized question contains prohibited controls." });
  }
  if (value.length > 0 && !hasVisibleBaseCharacter(value)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Normalized question lacks a visible base character." });
  }
  if (countUnicodeCodePoints(value) > 500 || utf8ByteLength(value) > 2_000) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Normalized question exceeds its size limit." });
  }
  if (canonicalizeFormComparisonText(value) !== value) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Normalized question is not canonical." });
  }
});

const applicationAnswerPacketAnswerProjectionSchema = z
  .object({
    normalizedFieldKey: sha256HexSchema,
    normalizedQuestion: packetNormalizedQuestionSchema,
    semanticFieldKey: semanticFieldKeySchema.nullable(),
    fieldFingerprint: sha256HexSchema,
    fieldType: z.enum(PACKET_FIELD_TYPES),
    classification: z.enum(APPLICATION_QUESTION_CLASSIFICATIONS),
    disposition: z.enum(APPLICATION_ANSWER_DISPOSITIONS),
    dispositionReason: z.enum(APPLICATION_ANSWER_DISPOSITION_REASONS).nullable(),
    proposal: applicationAnswerProposalSchema.nullable(),
    sourceType: z.enum(APPLICATION_ANSWER_SOURCE_TYPES).nullable(),
    sourceIds: z.array(safeIdentifierSchema).max(20),
    evidenceIds: z.array(safeIdentifierSchema).length(0),
    sourceFingerprint: sha256HexSchema.nullable(),
    confidence: confidenceSchema,
    required: z.boolean(),
    requiresReview: z.boolean(),
    sensitive: z.boolean(),
    valueRedacted: z.boolean()
  })
  .strict();

export type ApplicationAnswerPacketAnswerProjection = z.infer<
  typeof applicationAnswerPacketAnswerProjectionSchema
>;

const applicationAnswerPacketValidationFieldSchema = frozenApplicationAnswerFieldSchema;

const applicationAnswerPacketValidationContextSchema = z
  .object({
    fields: z.array(applicationAnswerPacketValidationFieldSchema).max(200)
  })
  .strict();

export type ApplicationAnswerPacketValidationContext = Readonly<{
  fields: readonly FrozenApplicationAnswerField[];
}>;

const applicationAnswerPacketProjectionSchema = z
  .object({
    schemaVersion: z.literal(1),
    inspectionVersion: z.number().int().safe().positive(),
    formFingerprint: sha256HexSchema,
    builderVersion: safeVersionSchema,
    policyHash: sha256HexSchema,
    answers: z.array(applicationAnswerPacketAnswerProjectionSchema).max(200)
  })
  .strict();

export type ApplicationAnswerPacketProjection = z.infer<typeof applicationAnswerPacketProjectionSchema>;

const MANUAL_ONLY_REASONS = new Set<ApplicationAnswerDispositionReason>([
  "NO_ELIGIBLE_SOURCE",
  "INVALID_SOURCE_VALUE",
  "AMBIGUOUS_SOURCE",
  "UNCONFIRMED_APPLICANT_CONTACT",
  "LEGAL_ATTESTATION",
  "V1_MANUAL_POLICY",
  "NO_SELECTED_DOCUMENT"
]);
const PROPOSABLE_DOWNGRADE_MANUAL_REASONS = new Set<ApplicationAnswerDispositionReason>([
  "NO_ELIGIBLE_SOURCE",
  "INVALID_SOURCE_VALUE",
  "AMBIGUOUS_SOURCE",
  "NO_SELECTED_DOCUMENT"
]);
const INSPECTION_MANUAL_ONLY_REASONS = new Set<ApplicationAnswerDispositionReason>([
  "UNCONFIRMED_APPLICANT_CONTACT",
  "LEGAL_ATTESTATION",
  "V1_MANUAL_POLICY"
]);
const UNSUPPORTED_REASONS = new Set<ApplicationAnswerDispositionReason>([
  "UNSUPPORTED_CONTROL",
  "AMBIGUOUS_FIELD",
  "AMBIGUOUS_CHOICES",
  "MULTIPLE_FILE_UPLOAD",
  "UNKNOWN_QUESTION"
]);

function dispositionReasonMatches(
  disposition: ApplicationAnswerDisposition,
  dispositionReason: ApplicationAnswerDispositionReason | null
): boolean {
  return (
    (disposition === "PROPOSABLE" && dispositionReason === null) ||
    (disposition === "EXCLUDED" && dispositionReason === "POLICY_EXCLUDED") ||
    (disposition === "MANUAL_ONLY" && dispositionReason !== null && MANUAL_ONLY_REASONS.has(dispositionReason)) ||
    (disposition === "UNSUPPORTED" && dispositionReason !== null && UNSUPPORTED_REASONS.has(dispositionReason))
  );
}

function assertPacketAnswerProjection(
  answer: ApplicationAnswerPacketAnswerProjection,
  validationField: z.infer<typeof applicationAnswerPacketValidationFieldSchema> | undefined
): void {
  const hasSource =
    answer.sourceType !== null || answer.sourceIds.length > 0 || answer.sourceFingerprint !== null;

  if (answer.disposition === "PROPOSABLE") {
    if (
      answer.proposal === null ||
      !answer.requiresReview ||
      answer.sensitive ||
      answer.valueRedacted ||
      answer.dispositionReason !== null ||
      answer.sourceType === null ||
      answer.sourceIds.length === 0 ||
      answer.sourceFingerprint === null
    ) {
      throw new AnswerPacketDomainError(
        "PACKET_INVARIANT_VIOLATION",
        "A proposable packet answer has contradictory authority, review, privacy, or provenance fields."
      );
    }
    const proposal = parseApplicationAnswerProposal(answer.proposal);
    if (proposal.kind === "OPTIONS") {
      if (validationField === undefined) {
        throw new AnswerPacketDomainError(
          "PACKET_INVARIANT_VIOLATION",
          "An option proposal requires its frozen inspection choices as validation context."
        );
      }
      if (validationField.fieldFingerprint !== answer.fieldFingerprint) {
        throw new AnswerPacketDomainError(
          "PACKET_INVARIANT_VIOLATION",
          "Option validation context is stale for the packet field fingerprint."
        );
      }
      parseCompatibleApplicationAnswerProposal(proposal, {
        expectedField: {
          normalizedFieldKey: answer.normalizedFieldKey,
          fieldFingerprint: answer.fieldFingerprint,
          fieldType: answer.fieldType,
          semanticFieldKey: answer.semanticFieldKey
        },
        frozenField: validationField
      });
    } else {
      assertProposalKindCompatibleWithField(proposal, answer.fieldType, answer.semanticFieldKey);
    }
    if (proposal.kind === "DOCUMENT_REFERENCE") {
      const expectedSourceType = proposal.artifactType === "RESUME" ? "TAILORED_RESUME" : "COVER_LETTER";
      if (
        answer.sourceType !== expectedSourceType ||
        answer.sourceIds.length !== 1 ||
        answer.sourceIds[0] !== proposal.documentId
      ) {
        throw new AnswerPacketDomainError(
          "PACKET_INVARIANT_VIOLATION",
          "Document proposal provenance must bind the selected document identity and source family."
        );
      }
    } else if (answer.sourceType !== "ANSWER_VAULT" || answer.sourceIds.length !== 1) {
      throw new AnswerPacketDomainError(
        "PACKET_INVARIANT_VIOLATION",
        "Non-document V1 proposals require exactly one Answer Vault source."
      );
    }
    return;
  }

  if (answer.proposal !== null || answer.requiresReview || hasSource || answer.confidence !== 0) {
    throw new AnswerPacketDomainError(
      "PACKET_INVARIANT_VIOLATION",
      "A non-proposable packet answer must not contain proposal authority, provenance, or positive confidence."
    );
  }
  if (answer.dispositionReason === null) {
    throw new AnswerPacketDomainError(
      "PACKET_INVARIANT_VIOLATION",
      "A non-proposable packet answer requires a closed disposition reason."
    );
  }
  if (!dispositionReasonMatches(answer.disposition, answer.dispositionReason)) {
    throw new AnswerPacketDomainError(
      "PACKET_INVARIANT_VIOLATION",
      "The packet answer's closed reason is incompatible with its disposition."
    );
  }
  if (answer.disposition === "EXCLUDED") {
    if (!answer.sensitive || !answer.valueRedacted || answer.dispositionReason !== "POLICY_EXCLUDED") {
      throw new AnswerPacketDomainError(
        "PACKET_INVARIANT_VIOLATION",
        "An excluded packet answer must carry the privacy exclusion flags and policy reason."
      );
    }
  } else if (answer.sensitive || answer.valueRedacted) {
    throw new AnswerPacketDomainError(
      "PACKET_INVARIANT_VIOLATION",
      "Only excluded packet answers may carry sensitive/redacted compatibility flags."
    );
  }
}

export function canonicalizeApplicationAnswerPacketProjection(
  input: unknown,
  validationContext?: unknown
): ApplicationAnswerPacketProjection {
  const parsed = applicationAnswerPacketProjectionSchema.parse(input);
  const normalizedFieldKeys = parsed.answers.map((answer) => answer.normalizedFieldKey);
  assertUnique(normalizedFieldKeys, "Packet answer field keys");
  const parsedValidationContext =
    validationContext === undefined
      ? { fields: [] }
      : applicationAnswerPacketValidationContextSchema.parse(validationContext);
  const validationFieldKeys = parsedValidationContext.fields.map((field) => field.normalizedFieldKey);
  assertUnique(validationFieldKeys, "Packet validation field keys");
  const validationFields = new Map(
    parsedValidationContext.fields.map((field) => [field.normalizedFieldKey, field] as const)
  );
  const optionFieldKeys = new Set(
    parsed.answers
      .filter((answer) => answer.proposal?.kind === "OPTIONS")
      .map((answer) => answer.normalizedFieldKey)
  );
  if (
    validationFields.size !== optionFieldKeys.size ||
    [...validationFields.keys()].some((key) => !optionFieldKeys.has(key))
  ) {
    throw new AnswerPacketDomainError(
      "PACKET_INVARIANT_VIOLATION",
      "Packet validation context must match exactly the option-bearing answers."
    );
  }

  return {
    ...parsed,
    answers: parsed.answers
      .map((answer) => {
        assertUnique(answer.sourceIds, "Packet answer source IDs");
        assertPacketAnswerProjection(answer, validationFields.get(answer.normalizedFieldKey));
        return {
          ...answer,
          proposal: answer.proposal === null ? null : parseApplicationAnswerProposal(answer.proposal),
          sourceIds: [...answer.sourceIds].sort(compareCodeUnits),
          evidenceIds: []
        };
      })
      .sort((left, right) => compareCodeUnits(left.normalizedFieldKey, right.normalizedFieldKey))
  };
}

export function computeApplicationAnswerPacketHash(input: unknown, validationContext?: unknown): string {
  // inputHash and all review/lifecycle fields are intentionally absent from the
  // strict immutable-content projection.
  return hashDomainSeparated(
    PACKET_HASH_DOMAIN,
    canonicalizeApplicationAnswerPacketProjection(input, validationContext)
  );
}

export function assertApplicationAnswerDispositionWithinPermitted(input: {
  permittedDisposition: ApplicationAnswerDisposition;
  permittedDispositionReason: ApplicationAnswerDispositionReason | null;
  disposition: ApplicationAnswerDisposition;
  dispositionReason: ApplicationAnswerDispositionReason | null;
}): void {
  if (!dispositionReasonMatches(input.permittedDisposition, input.permittedDispositionReason)) {
    throw new AnswerPacketDomainError(
      "DISPOSITION_REASON_MISMATCH",
      "The inspection ceiling has an incompatible closed disposition reason."
    );
  }
  if (
    input.permittedDisposition === "MANUAL_ONLY" &&
    (input.permittedDispositionReason === null ||
      !INSPECTION_MANUAL_ONLY_REASONS.has(input.permittedDispositionReason))
  ) {
    throw new AnswerPacketDomainError(
      "DISPOSITION_REASON_MISMATCH",
      "A manual-only inspection ceiling requires a source-independent classification reason."
    );
  }
  if (!isDispositionWithinPermitted(input.permittedDisposition, input.disposition)) {
    throw new AnswerPacketDomainError(
      "DISPOSITION_ESCALATION",
      "The source-resolved disposition exceeds the inspection's permitted authority."
    );
  }

  if (!dispositionReasonMatches(input.disposition, input.dispositionReason)) {
    throw new AnswerPacketDomainError(
      "DISPOSITION_REASON_MISMATCH",
      "The closed disposition reason is incompatible with the final disposition."
    );
  }

  if (input.disposition === input.permittedDisposition) {
    if (input.dispositionReason !== input.permittedDispositionReason) {
      throw new AnswerPacketDomainError(
        "DISPOSITION_REASON_MISMATCH",
        "A preserved disposition must preserve the inspection's closed reason."
      );
    }
    return;
  }

  if (
    input.permittedDisposition === "PROPOSABLE" &&
    input.disposition === "MANUAL_ONLY" &&
    (input.dispositionReason === null || !PROPOSABLE_DOWNGRADE_MANUAL_REASONS.has(input.dispositionReason))
  ) {
    throw new AnswerPacketDomainError(
      "DISPOSITION_REASON_MISMATCH",
      "A proposable field may become manual-only only for a source-resolution reason."
    );
  }
}

export type ApplicationAnswerPacketSummaryRow = Readonly<{
  packetVersion: number;
  packetHash: string;
  normalizedFieldKey: string;
  status: ApplicationRunAnswerReviewStatus;
  finalValueHash: string | null;
  reviewHashVersion: ApplicationAnswerReviewHashVersion | null;
}>;

export type ApplicationAnswerPacketSummaryInput = Readonly<{
  currentPacketVersion: number;
  packetVersion: number;
  packet: unknown;
  validationContext?: unknown;
  rows: readonly unknown[];
}>;

export type ApplicationAnswerPacketSummary = Readonly<{
  fieldCount: number;
  proposableCount: number;
  pendingReviewCount: number;
  approvedCount: number;
  rejectedCount: number;
  manualOnlyCount: number;
  excludedCount: number;
  unsupportedCount: number;
  manualRequiredCount: number;
  readyForRunResolution: boolean;
}>;

const applicationAnswerPacketSummaryRowSchema = z
  .object({
    packetVersion: safeVersionSchema,
    packetHash: sha256HexSchema,
    normalizedFieldKey: sha256HexSchema,
    status: z.enum(APPLICATION_RUN_ANSWER_REVIEW_STATUSES),
    finalValueHash: sha256HexSchema.nullable(),
    reviewHashVersion: z.enum(APPLICATION_ANSWER_REVIEW_HASH_VERSIONS).nullable()
  })
  .strict();

const applicationAnswerPacketSummaryInputSchema = z
  .object({
    currentPacketVersion: safeVersionSchema,
    packetVersion: safeVersionSchema,
    packet: z.unknown(),
    validationContext: z.unknown().optional(),
    rows: z.array(applicationAnswerPacketSummaryRowSchema).max(200)
  })
  .strict();

function assertSummaryLifecycleRow(
  row: ApplicationAnswerPacketSummaryRow,
  answer: ApplicationAnswerPacketAnswerProjection
): void {
  if (answer.disposition !== "PROPOSABLE") {
    if (
      row.status !== "PENDING" ||
      row.finalValueHash !== null ||
      row.reviewHashVersion !== null
    ) {
      throw new AnswerPacketDomainError(
        "PACKET_INVARIANT_VIOLATION",
        "A non-proposable compatibility row must remain non-reviewable PENDING without proposal review metadata."
      );
    }
    return;
  }

  if (!answer.requiresReview || answer.proposal === null) {
    throw new AnswerPacketDomainError(
      "PACKET_INVARIANT_VIOLATION",
      "A proposable canonical packet answer requires a typed proposal and user review."
    );
  }
  if (row.status === "APPROVED") {
    if (row.finalValueHash === null || row.reviewHashVersion !== "CANONICAL_PROPOSAL_V1") {
      throw new AnswerPacketDomainError(
        "PACKET_INVARIANT_VIOLATION",
        "An approved proposal requires a canonical proposal hash and hash version."
      );
    }
  } else if (row.finalValueHash !== null || row.reviewHashVersion !== null) {
    throw new AnswerPacketDomainError(
      "PACKET_INVARIANT_VIOLATION",
      "Pending and rejected proposals must not retain a review hash or hash version."
    );
  }
}

export function summarizeApplicationAnswerPacket(
  input: ApplicationAnswerPacketSummaryInput
): ApplicationAnswerPacketSummary {
  const parsedInput = applicationAnswerPacketSummaryInputSchema.parse(input);
  const packet = canonicalizeApplicationAnswerPacketProjection(
    parsedInput.packet,
    parsedInput.validationContext
  );
  if (packet.answers.length === 0) {
    throw new AnswerPacketDomainError(
      "PACKET_INVARIANT_VIOLATION",
      "A summary requires a nonempty canonical packet answer set."
    );
  }

  const packetHash = hashDomainSeparated(PACKET_HASH_DOMAIN, packet);
  const answerKeys = packet.answers.map((answer) => answer.normalizedFieldKey);
  const rowKeys = parsedInput.rows.map((row) => row.normalizedFieldKey);
  assertUnique(answerKeys, "Canonical packet answer field keys");
  assertUnique(rowKeys, "Summary row field keys");

  if (
    parsedInput.rows.length !== packet.answers.length ||
    parsedInput.rows.some(
      (row) => row.packetVersion !== parsedInput.packetVersion || row.packetHash !== packetHash
    )
  ) {
    throw new AnswerPacketDomainError(
      "PACKET_INVARIANT_VIOLATION",
      "Summary rows must belong to the exact packet hash and packet version."
    );
  }

  const rowsByFieldKey = new Map(
    parsedInput.rows.map((row) => [row.normalizedFieldKey, row] as const)
  );
  if (answerKeys.some((key) => !rowsByFieldKey.has(key))) {
    throw new AnswerPacketDomainError(
      "PACKET_INVARIANT_VIOLATION",
      "Summary rows must exactly cover the canonical packet field set."
    );
  }

  const joined = packet.answers.map((answer) => {
    const row = rowsByFieldKey.get(answer.normalizedFieldKey);
    if (row === undefined) {
      throw new AnswerPacketDomainError(
        "PACKET_INVARIANT_VIOLATION",
        "Summary rows must exactly cover the canonical packet field set."
      );
    }
    assertSummaryLifecycleRow(row, answer);
    return { answer, row };
  });
  const proposable = joined.filter(({ answer }) => answer.disposition === "PROPOSABLE");
  const pendingReviewCount = proposable.filter(({ row }) => row.status === "PENDING").length;
  const approvedRows = proposable.filter(({ row }) => row.status === "APPROVED");
  const approvedHashesValid = approvedRows.every(
    ({ answer, row }) =>
      row.reviewHashVersion === "CANONICAL_PROPOSAL_V1" &&
      answer.proposal !== null &&
      isApplicationAnswerProposalHashValid(answer.proposal, row.finalValueHash)
  );

  return {
    fieldCount: joined.length,
    proposableCount: proposable.length,
    pendingReviewCount,
    approvedCount: approvedRows.length,
    rejectedCount: proposable.filter(({ row }) => row.status === "REJECTED").length,
    manualOnlyCount: joined.filter(({ answer }) => answer.disposition === "MANUAL_ONLY").length,
    excludedCount: joined.filter(({ answer }) => answer.disposition === "EXCLUDED").length,
    unsupportedCount: joined.filter(({ answer }) => answer.disposition === "UNSUPPORTED").length,
    manualRequiredCount: joined.filter(
      ({ answer, row }) =>
        answer.required &&
        (answer.disposition === "MANUAL_ONLY" ||
          answer.disposition === "EXCLUDED" ||
          answer.disposition === "UNSUPPORTED" ||
          (answer.disposition === "PROPOSABLE" && row.status === "REJECTED"))
    ).length,
    readyForRunResolution:
      parsedInput.packetVersion === parsedInput.currentPacketVersion &&
      pendingReviewCount === 0 &&
      approvedHashesValid
  };
}
