import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import { z } from "zod";

import {
  APPLICATION_ANSWER_DISPOSITION_REASONS,
  APPLICATION_ANSWER_DISPOSITIONS,
  APPLICATION_QUESTION_CLASSIFICATIONS,
  CLASSIFIER_VERSION,
  classifyApplicationQuestion,
  type ApplicationAnswerDisposition,
  type ApplicationAnswerDispositionReason,
  type ApplicationQuestionClassification
} from "@/lib/application-runs/question-classification";

export const FORM_INSPECTION_SCHEMA_VERSION = 1 as const;
export const FORM_NORMALIZER_VERSION = 1 as const;
export const FIELD_FINGERPRINT_VERSION = 1 as const;

export const MAX_FORMS = 4;
export const MAX_SECTIONS_PER_FORM = 32;
export const MAX_FIELDS_TOTAL = 200;
export const MAX_CHOICES_PER_FIELD = 256;
export const MAX_CHOICES_TOTAL = 1_000;
export const MAX_FUTURE_OBSERVED_URL_CODE_POINTS = 2_048;
export const MAX_FUTURE_RAW_HTTP_BODY_BYTES = 256 * 1024;

export const FORM_INSPECTION_TEXT_LIMITS = {
  formOrSection: { codePoints: 300, utf8Bytes: 1_200 },
  question: { codePoints: 500, utf8Bytes: 2_000 },
  helpText: { codePoints: 1_000, utf8Bytes: 4_000 },
  choiceLabel: { codePoints: 200, utf8Bytes: 800 }
} as const;

export const APPLICATION_FORM_FIELD_TYPES = [
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
] as const;
export type ApplicationFormFieldType = (typeof APPLICATION_FORM_FIELD_TYPES)[number];

export const APPLICATION_FORM_UNSUPPORTED_REASONS = [
  "PASSWORD",
  "RICH_TEXT",
  "CUSTOM_COMBOBOX",
  "UNSUPPORTED_CONTROL"
] as const;
export type ApplicationFormUnsupportedReason = (typeof APPLICATION_FORM_UNSUPPORTED_REASONS)[number];

export const NORMALIZED_FORM_UNSUPPORTED_REASONS = [
  ...APPLICATION_FORM_UNSUPPORTED_REASONS,
  "MULTIPLE_FILE_UPLOAD",
  "AMBIGUOUS_CHOICES"
] as const;
export type NormalizedFormUnsupportedReason = (typeof NORMALIZED_FORM_UNSUPPORTED_REASONS)[number];

export const APPLICATION_FORM_AUTOCOMPLETE_VALUES = [
  "name",
  "honorific-prefix",
  "given-name",
  "additional-name",
  "family-name",
  "honorific-suffix",
  "nickname",
  "organization-title",
  "organization",
  "street-address",
  "address-line1",
  "address-line2",
  "address-line3",
  "address-level1",
  "address-level2",
  "address-level3",
  "address-level4",
  "country",
  "country-name",
  "postal-code",
  "language",
  "tel",
  "tel-country-code",
  "tel-national",
  "tel-area-code",
  "tel-local",
  "tel-extension",
  "email",
  "url",
  "bday",
  "bday-day",
  "bday-month",
  "bday-year",
  "sex"
] as const;
export type ApplicationFormAutocomplete = (typeof APPLICATION_FORM_AUTOCOMPLETE_VALUES)[number];

export const APPLICATION_FORM_ACCEPTED_FILE_TYPES = ["PDF", "DOC", "DOCX", "RTF", "TXT"] as const;
export type ApplicationFormAcceptedFileType = (typeof APPLICATION_FORM_ACCEPTED_FILE_TYPES)[number];

export const FORM_INSPECTION_ERROR_CODES = [
  "INVALID_INPUT",
  "MALFORMED_UNICODE",
  "AMBIGUOUS_DUPLICATE_FIELD",
  "NON_CANONICAL_VALUE"
] as const;
export type FormInspectionErrorCode = (typeof FORM_INSPECTION_ERROR_CODES)[number];

export class FormInspectionDomainError extends Error {
  readonly code: FormInspectionErrorCode;

  constructor(code: FormInspectionErrorCode, message: string) {
    super(message);
    this.name = "FormInspectionDomainError";
    this.code = code;
  }
}

// This narrow identity set contains controls with demonstrated invisible-token
// or blank-identity behavior: soft hyphen, blank Hangul fillers, deprecated
// Mongolian separator, invisible math/directional controls, ZWSP, and BOM.
// NFKC maps U+3164/U+FFA0 to U+1160 before removal. Deliberately preserve
// U+034F, U+17B4/U+17B5, Mongolian/emoji variation selectors, Unicode tags,
// and U+200C/U+200D because they can carry combining, shaping, or emoji meaning.
const BIDI_AND_CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u115f-\u1160\u180e\u200b\u200e-\u200f\u202a-\u202e\u2060-\u206f\u3164\ufeff\uffa0]/u;
const BIDI_AND_CONTROL_GLOBAL_PATTERN = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u115f-\u1160\u180e\u200b\u200e-\u200f\u202a-\u202e\u2060-\u206f\u3164\ufeff\uffa0]/gu;
const UNICODE_WHITESPACE_PATTERN = /\p{White_Space}+/gu;
const UNICODE_WHITESPACE_CHARACTER = /^\p{White_Space}$/u;
const UNICODE_PUNCTUATION_SYMBOL_OR_CONTROL_CHARACTER = /^[\p{P}\p{S}\p{C}]$/u;
const UNICODE_LETTER_OR_NUMBER_CHARACTER = /^[\p{L}\p{N}]$/u;
const ASCII_ALPHANUMERIC_CHARACTER = /^[A-Za-z0-9]$/u;
const VISIBLE_BASE_CHARACTER_PATTERN = /[\p{L}\p{N}\p{P}\p{S}]/u;
// These code points have letter/symbol categories but render as blank. U+3164
// and U+FFA0 are included for callers that have not normalized to NFKC yet.
const INVISIBLE_BASE_CHARACTER_PATTERN = /[\u115f\u1160\u2800\u3164\uffa0]/u;
const LOWERCASE_HEX_64_PATTERN = /^[0-9a-f]{64}$/;

export function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

export function countUnicodeCodePoints(value: string): number {
  return [...value].length;
}

export function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

export function hasVisibleBaseCharacter(value: string): boolean {
  return [...value].some(
    (character) =>
      VISIBLE_BASE_CHARACTER_PATTERN.test(character) &&
      !INVISIBLE_BASE_CHARACTER_PATTERN.test(character)
  );
}

function hasUnsafeEmbeddedCompatibilityExpansion(value: string): boolean {
  // Preserve ordinary Unicode punctuation and symbols. Reject only an original
  // P/S/C scalar whose compatibility decomposition injects ASCII word material
  // next to an ASCII token, or whitespace inside one, because canonical NFKC
  // would otherwise erase the untrusted boundary before snapshot verification.
  const characters = [...value];
  return characters.some((character, index) => {
    const hasAsciiLeft = ASCII_ALPHANUMERIC_CHARACTER.test(characters[index - 1] ?? "");
    const hasAsciiRight = ASCII_ALPHANUMERIC_CHARACTER.test(characters[index + 1] ?? "");
    if (!UNICODE_PUNCTUATION_SYMBOL_OR_CONTROL_CHARACTER.test(character)) return false;
    const decomposed = [...character.normalize("NFKD")];
    if (decomposed.length === 1 && decomposed[0] === character) return false;
    const expandsToWordMaterial = decomposed.some((part) =>
      UNICODE_LETTER_OR_NUMBER_CHARACTER.test(part)
    );
    const expandsToWhitespace = decomposed.some((part) =>
      UNICODE_WHITESPACE_CHARACTER.test(part)
    );
    return (
      (expandsToWordMaterial && (hasAsciiLeft || hasAsciiRight)) ||
      (expandsToWhitespace && hasAsciiLeft && hasAsciiRight)
    );
  });
}

export function sanitizeFormDisplayText(value: string): string {
  if (!isWellFormedUnicode(value)) {
    throw new FormInspectionDomainError("MALFORMED_UNICODE", "Form text contains malformed Unicode.");
  }
  return value
    .normalize("NFKC")
    .replace(UNICODE_WHITESPACE_PATTERN, " ")
    .replace(BIDI_AND_CONTROL_GLOBAL_PATTERN, "")
    // Removing an invisible separator can make previously separated combining
    // sequences composable. Re-normalize so sanitation is idempotent and a
    // builder-produced snapshot always verifies as canonical.
    .normalize("NFKC")
    .trim()
    .replace(/ +/g, " ");
}

export function canonicalizeFormComparisonText(value: string): string {
  return sanitizeFormDisplayText(value).toLowerCase();
}

export function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertCanonicalString(value: string): void {
  if (!isWellFormedUnicode(value)) {
    throw new FormInspectionDomainError("NON_CANONICAL_VALUE", "Canonical JSON contains malformed Unicode.");
  }
}

export function canonicalJson(value: unknown): string {
  const ancestors = new Set<object>();

  const serialize = (current: unknown): string => {
    if (current === null) return "null";
    if (typeof current === "string") {
      assertCanonicalString(current);
      return JSON.stringify(current);
    }
    if (typeof current === "boolean") return current ? "true" : "false";
    if (typeof current === "number") {
      if (!Number.isSafeInteger(current) || Object.is(current, -0)) {
        throw new FormInspectionDomainError(
          "NON_CANONICAL_VALUE",
          "Canonical JSON numbers must be finite safe integers other than negative zero."
        );
      }
      return String(current);
    }
    if (
      typeof current === "undefined" ||
      typeof current === "bigint" ||
      typeof current === "symbol" ||
      typeof current === "function"
    ) {
      throw new FormInspectionDomainError("NON_CANONICAL_VALUE", "Canonical JSON contains an unsupported value.");
    }

    if (ancestors.has(current)) {
      throw new FormInspectionDomainError("NON_CANONICAL_VALUE", "Canonical JSON cannot contain cycles.");
    }
    ancestors.add(current);
    try {
      if (Array.isArray(current)) {
        if (Object.getPrototypeOf(current) !== Array.prototype) {
          throw new FormInspectionDomainError("NON_CANONICAL_VALUE", "Canonical JSON arrays must be plain arrays.");
        }
        const serializedEntries: string[] = [];
        for (let index = 0; index < current.length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(current, String(index));
          if (!descriptor) {
            throw new FormInspectionDomainError("NON_CANONICAL_VALUE", "Canonical JSON arrays cannot be sparse.");
          }
          if (!descriptor.enumerable || !("value" in descriptor)) {
            throw new FormInspectionDomainError(
              "NON_CANONICAL_VALUE",
              "Canonical JSON arrays require enumerable data properties."
            );
          }
          serializedEntries.push(serialize(descriptor.value));
        }
        const unexpectedKeys = Reflect.ownKeys(current).filter((key) => {
          if (key === "length") return false;
          return typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= current.length;
        });
        if (unexpectedKeys.length > 0) {
          throw new FormInspectionDomainError("NON_CANONICAL_VALUE", "Canonical JSON arrays cannot have extra properties.");
        }
        return `[${serializedEntries.join(",")}]`;
      }

      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new FormInspectionDomainError("NON_CANONICAL_VALUE", "Canonical JSON objects must be plain objects.");
      }
      const ownKeys = Reflect.ownKeys(current);
      if (ownKeys.some((key) => typeof key === "symbol")) {
        throw new FormInspectionDomainError("NON_CANONICAL_VALUE", "Canonical JSON objects cannot use symbol keys.");
      }
      const descriptors = Object.getOwnPropertyDescriptors(current);
      const keys = ownKeys as string[];
      for (const key of keys) {
        assertCanonicalString(key);
        const descriptor = descriptors[key];
        if (!descriptor?.enumerable || !("value" in descriptor)) {
          throw new FormInspectionDomainError(
            "NON_CANONICAL_VALUE",
            "Canonical JSON objects require enumerable data properties."
          );
        }
      }
      keys.sort(compareCodeUnits);
      return `{${keys.map((key) => `${JSON.stringify(key)}:${serialize(descriptors[key].value)}`).join(",")}}`;
    } finally {
      ancestors.delete(current);
    }
  };

  return serialize(value);
}

function assertHashDomain(domain: string): void {
  if (!domain.endsWith("\0") || !isWellFormedUnicode(domain)) {
    throw new FormInspectionDomainError("NON_CANONICAL_VALUE", "Hash domains must be well-formed and NUL-terminated.");
  }
}

export function hashDomainSeparated(domain: string, projection: unknown): string {
  assertHashDomain(domain);
  return createHash("sha256").update(domain, "utf8").update(canonicalJson(projection), "utf8").digest("hex");
}

export function hashDomainSeparatedText(domain: string, exactText: string): string {
  assertHashDomain(domain);
  assertCanonicalString(exactText);
  return createHash("sha256").update(domain, "utf8").update(exactText, "utf8").digest("hex");
}

const fieldTypeSchema = z.enum(APPLICATION_FORM_FIELD_TYPES);
const unsupportedReasonSchema = z.enum(APPLICATION_FORM_UNSUPPORTED_REASONS);
const normalizedUnsupportedReasonSchema = z.enum(NORMALIZED_FORM_UNSUPPORTED_REASONS);
const autocompleteSchema = z.enum(APPLICATION_FORM_AUTOCOMPLETE_VALUES);
const acceptedFileTypeSchema = z.enum(APPLICATION_FORM_ACCEPTED_FILE_TYPES);
const nonnegativeLengthConstraintSchema = z
  .number()
  .int()
  .min(0)
  .max(4_000)
  .refine((value) => !Object.is(value, -0), { message: "Length constraints must not be negative zero." });

function boundedTextBaseSchema(
  limits: { readonly codePoints: number; readonly utf8Bytes: number },
  options: { nonblank: boolean }
) {
  const text = z.string().superRefine((value, context) => {
    if (!isWellFormedUnicode(value)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Text contains malformed Unicode." });
      return;
    }
    if (countUnicodeCodePoints(value) > limits.codePoints || utf8ByteLength(value) > limits.utf8Bytes) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Text exceeds its raw size limit." });
      return;
    }
    try {
      // A deleted invisible could have appeared either inside a policy token or
      // in place of a real token boundary. Raw authoritative form text rejects
      // every non-whitespace code point the normalizer would delete so that
      // canonical storage never loses that distinction. Ordinary whitespace is
      // still normalized to a single visible space.
      const nonWhitespaceSecurityText = value
        .normalize("NFKC")
        .replace(UNICODE_WHITESPACE_PATTERN, "");
      if (BIDI_AND_CONTROL_PATTERN.test(nonWhitespaceSecurityText)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Text contains an unsafe invisible identity character."
        });
        return;
      }
      if (hasUnsafeEmbeddedCompatibilityExpansion(value)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Text contains compatibility formatting that obscures an ASCII identity boundary."
        });
        return;
      }
      const sanitized = sanitizeFormDisplayText(value);
      if (options.nonblank && (sanitized.length === 0 || !hasVisibleBaseCharacter(sanitized))) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "Text must not be blank after normalization." });
      }
      if (countUnicodeCodePoints(sanitized) > limits.codePoints || utf8ByteLength(sanitized) > limits.utf8Bytes) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "Text exceeds its normalized size limit." });
      }
    } catch {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Text contains malformed Unicode." });
    }
  });
  return text;
}

const nullableDisplayTextSchema = boundedTextBaseSchema(FORM_INSPECTION_TEXT_LIMITS.formOrSection, {
  nonblank: false
}).nullable();
const nullableQuestionSchema = boundedTextBaseSchema(FORM_INSPECTION_TEXT_LIMITS.question, {
  nonblank: true
}).nullable();
const nullableHelpTextSchema = boundedTextBaseSchema(FORM_INSPECTION_TEXT_LIMITS.helpText, {
  nonblank: false
}).nullable();
const choiceLabelSchema = boundedTextBaseSchema(FORM_INSPECTION_TEXT_LIMITS.choiceLabel, {
  nonblank: true
});

const decimalConstraintSchema = z
  .string()
  .max(64)
  .refine((value) => isWellFormedUnicode(value) && !BIDI_AND_CONTROL_PATTERN.test(value), {
    message: "Decimal constraints must not contain controls."
  })
  .nullable();

const inspectionConstraintSchema = z
  .object({
    minLength: nonnegativeLengthConstraintSchema.nullable(),
    maxLength: nonnegativeLengthConstraintSchema.nullable(),
    min: decimalConstraintSchema,
    max: decimalConstraintSchema,
    step: decimalConstraintSchema,
    acceptedFileTypes: z.array(acceptedFileTypeSchema).max(APPLICATION_FORM_ACCEPTED_FILE_TYPES.length),
    multiple: z.boolean()
  })
  .strict();

const inspectionChoiceSchema = z
  .object({
    label: choiceLabelSchema,
    disabled: z.boolean()
  })
  .strict();

const CHOICE_FIELD_TYPES: readonly ApplicationFormFieldType[] = [
  "SELECT_ONE",
  "SELECT_MANY",
  "RADIO_GROUP",
  "CHECKBOX_GROUP"
];
const TEXT_CONSTRAINT_FIELD_TYPES: readonly ApplicationFormFieldType[] = [
  "TEXT",
  "EMAIL",
  "TEL",
  "URL",
  "TEXTAREA"
];

const inspectionFieldSchema = z
  .object({
    question: nullableQuestionSchema,
    helpText: nullableHelpTextSchema,
    fieldType: fieldTypeSchema,
    unsupportedReason: unsupportedReasonSchema.nullable(),
    required: z.boolean(),
    autocomplete: autocompleteSchema.nullable(),
    constraints: inspectionConstraintSchema,
    choices: z.array(inspectionChoiceSchema).max(MAX_CHOICES_PER_FIELD)
  })
  .strict()
  .superRefine((field, context) => {
    const isChoiceField = CHOICE_FIELD_TYPES.includes(field.fieldType);
    if (isChoiceField && field.choices.length === 0) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["choices"], message: "Choice controls require choices." });
    }
    if (!isChoiceField && field.choices.length > 0) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["choices"], message: "This control cannot contain choices." });
    }
    if (field.fieldType === "UNSUPPORTED" ? field.unsupportedReason === null : field.unsupportedReason !== null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["unsupportedReason"],
        message: "Unsupported reason must match the control type."
      });
    }

    const { minLength, maxLength, min, max, step, acceptedFileTypes, multiple } = field.constraints;
    if (minLength !== null && maxLength !== null && minLength > maxLength) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["constraints"], message: "Length bounds are reversed." });
    }
    if (!TEXT_CONSTRAINT_FIELD_TYPES.includes(field.fieldType) && (minLength !== null || maxLength !== null)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["constraints"], message: "Length bounds are incompatible." });
    }
    if (field.fieldType !== "NUMBER" && field.fieldType !== "DATE" && (min !== null || max !== null || step !== null)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["constraints"], message: "Value bounds are incompatible." });
    }
    if (field.fieldType !== "FILE_UPLOAD" && (acceptedFileTypes.length > 0 || multiple)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["constraints"], message: "File bounds are incompatible." });
    }
  });

const inspectionSectionSchema = z
  .object({
    heading: nullableDisplayTextSchema,
    fields: z.array(inspectionFieldSchema).min(1).max(MAX_FIELDS_TOTAL)
  })
  .strict();

const inspectionFormSchema = z
  .object({
    title: nullableDisplayTextSchema,
    sections: z.array(inspectionSectionSchema).min(1).max(MAX_SECTIONS_PER_FORM)
  })
  .strict();

export const applicationFormInspectionReportSchema = z
  .object({
    schemaVersion: z.literal(FORM_INSPECTION_SCHEMA_VERSION),
    forms: z.array(inspectionFormSchema).min(1).max(MAX_FORMS)
  })
  .strict()
  .superRefine((report, context) => {
    let fieldCount = 0;
    let choiceCount = 0;
    for (const form of report.forms) {
      for (const section of form.sections) {
        fieldCount += section.fields.length;
        for (const field of section.fields) choiceCount += field.choices.length;
      }
    }
    if (fieldCount > MAX_FIELDS_TOTAL) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["forms"], message: "Inspection has too many fields." });
    }
    if (choiceCount > MAX_CHOICES_TOTAL) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["forms"], message: "Inspection has too many choices." });
    }
  });

export type ApplicationFormInspectionReport = z.infer<typeof applicationFormInspectionReportSchema>;

export type NormalizedApplicationFormConstraints = Readonly<{
  minLength: number | null;
  maxLength: number | null;
  min: string | null;
  max: string | null;
  step: string | null;
  acceptedFileTypes: readonly ApplicationFormAcceptedFileType[];
  multiple: boolean;
}>;

export type NormalizedApplicationFormChoice = Readonly<{
  key: string;
  label: string;
  disabled: boolean;
}>;

export type NormalizedApplicationFormField = Readonly<{
  normalizedFieldKey: string;
  semanticFieldKey: string | null;
  question: string | null;
  normalizedQuestion: string;
  helpText: string | null;
  fieldType: ApplicationFormFieldType;
  classification: ApplicationQuestionClassification;
  permittedDisposition: ApplicationAnswerDisposition;
  dispositionReason: ApplicationAnswerDispositionReason | null;
  unsupportedReason: NormalizedFormUnsupportedReason | null;
  required: boolean;
  autocomplete: ApplicationFormAutocomplete | null;
  constraints: NormalizedApplicationFormConstraints;
  choices: readonly NormalizedApplicationFormChoice[];
  fieldFingerprint: string;
}>;

export type NormalizedApplicationFormSection = Readonly<{
  sectionKey: string;
  heading: string | null;
  fields: readonly NormalizedApplicationFormField[];
}>;

export type NormalizedApplicationForm = Readonly<{
  formKey: string;
  title: string | null;
  sections: readonly NormalizedApplicationFormSection[];
}>;

export type NormalizedApplicationFormSnapshot = Readonly<{
  schemaVersion: typeof FORM_INSPECTION_SCHEMA_VERSION;
  normalizerVersion: typeof FORM_NORMALIZER_VERSION;
  classifierVersion: typeof CLASSIFIER_VERSION;
  fingerprintVersion: typeof FIELD_FINGERPRINT_VERSION;
  forms: readonly NormalizedApplicationForm[];
}>;

const normalizedConstraintSchema = z
  .object({
    minLength: nonnegativeLengthConstraintSchema.nullable(),
    maxLength: nonnegativeLengthConstraintSchema.nullable(),
    min: z.string().max(64).nullable(),
    max: z.string().max(64).nullable(),
    step: z.string().max(64).nullable(),
    acceptedFileTypes: z.array(acceptedFileTypeSchema).max(APPLICATION_FORM_ACCEPTED_FILE_TYPES.length),
    multiple: z.boolean()
  })
  .strict();
const normalizedChoiceSchema = z
  .object({ key: z.string().regex(LOWERCASE_HEX_64_PATTERN), label: choiceLabelSchema, disabled: z.boolean() })
  .strict();
const normalizedQuestionSchema = boundedTextBaseSchema(FORM_INSPECTION_TEXT_LIMITS.question, {
  nonblank: false
});
const semanticFieldKeySchema = z
  .string()
  .max(128)
  .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/);
const normalizedFieldSchema = z
  .object({
    normalizedFieldKey: z.string().regex(LOWERCASE_HEX_64_PATTERN),
    semanticFieldKey: semanticFieldKeySchema.nullable(),
    question: nullableQuestionSchema,
    normalizedQuestion: normalizedQuestionSchema,
    helpText: nullableHelpTextSchema,
    fieldType: fieldTypeSchema,
    classification: z.enum(APPLICATION_QUESTION_CLASSIFICATIONS),
    permittedDisposition: z.enum(APPLICATION_ANSWER_DISPOSITIONS),
    dispositionReason: z.enum(APPLICATION_ANSWER_DISPOSITION_REASONS).nullable(),
    unsupportedReason: normalizedUnsupportedReasonSchema.nullable(),
    required: z.boolean(),
    autocomplete: autocompleteSchema.nullable(),
    constraints: normalizedConstraintSchema,
    choices: z.array(normalizedChoiceSchema).max(MAX_CHOICES_PER_FIELD),
    fieldFingerprint: z.string().regex(LOWERCASE_HEX_64_PATTERN)
  })
  .strict();
const normalizedSectionSchema = z
  .object({
    sectionKey: z.string().regex(LOWERCASE_HEX_64_PATTERN),
    heading: nullableDisplayTextSchema,
    fields: z.array(normalizedFieldSchema).min(1).max(MAX_FIELDS_TOTAL)
  })
  .strict();
const normalizedFormSchema = z
  .object({
    formKey: z.string().regex(LOWERCASE_HEX_64_PATTERN),
    title: nullableDisplayTextSchema,
    sections: z.array(normalizedSectionSchema).min(1).max(MAX_SECTIONS_PER_FORM)
  })
  .strict();
const normalizedApplicationFormSnapshotSchema = z
  .object({
    schemaVersion: z.literal(FORM_INSPECTION_SCHEMA_VERSION),
    normalizerVersion: z.literal(FORM_NORMALIZER_VERSION),
    classifierVersion: z.literal(CLASSIFIER_VERSION),
    fingerprintVersion: z.literal(FIELD_FINGERPRINT_VERSION),
    forms: z.array(normalizedFormSchema).min(1).max(MAX_FORMS)
  })
  .strict()
  .superRefine((snapshot, context) => {
    let fieldCount = 0;
    let choiceCount = 0;
    for (const form of snapshot.forms) {
      for (const section of form.sections) {
        fieldCount += section.fields.length;
        for (const field of section.fields) choiceCount += field.choices.length;
      }
    }
    if (fieldCount > MAX_FIELDS_TOTAL) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["forms"], message: "Snapshot has too many fields." });
    }
    if (choiceCount > MAX_CHOICES_TOTAL) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["forms"], message: "Snapshot has too many choices." });
    }
  });

function sanitizedNullable(value: string | null): string | null {
  if (value === null) return null;
  const sanitized = sanitizeFormDisplayText(value);
  return sanitized.length === 0 || !hasVisibleBaseCharacter(sanitized) ? null : sanitized;
}

function canonicalizeDecimal(value: string): string {
  const sanitized = sanitizeFormDisplayText(value);
  const match = /^(-)?(\d+)(?:\.(\d+))?$/.exec(sanitized);
  if (!match) throw new FormInspectionDomainError("INVALID_INPUT", "A decimal constraint is invalid.");
  const integer = match[2].replace(/^0+(?=\d)/, "");
  const fraction = (match[3] ?? "").replace(/0+$/, "");
  const isZero = integer === "0" && fraction.length === 0;
  return `${match[1] && !isZero ? "-" : ""}${integer}${fraction.length > 0 ? `.${fraction}` : ""}`;
}

function canonicalizeDate(value: string): string {
  const sanitized = sanitizeFormDisplayText(value);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(sanitized);
  if (!match) throw new FormInspectionDomainError("INVALID_INPUT", "A date constraint is invalid.");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth) {
    throw new FormInspectionDomainError("INVALID_INPUT", "A date constraint is invalid.");
  }
  return sanitized;
}

function decimalParts(value: string): { negative: boolean; integer: string; fraction: string } {
  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const [integer, fraction = ""] = unsigned.split(".");
  return { negative, integer, fraction };
}

function compareCanonicalDecimals(left: string, right: string): number {
  const a = decimalParts(left);
  const b = decimalParts(right);
  if (a.negative !== b.negative) return a.negative ? -1 : 1;
  const direction = a.negative ? -1 : 1;
  if (a.integer.length !== b.integer.length) return (a.integer.length < b.integer.length ? -1 : 1) * direction;
  const integerComparison = compareCodeUnits(a.integer, b.integer);
  if (integerComparison !== 0) return integerComparison * direction;
  const width = Math.max(a.fraction.length, b.fraction.length);
  const fractionComparison = compareCodeUnits(a.fraction.padEnd(width, "0"), b.fraction.padEnd(width, "0"));
  return fractionComparison * direction;
}

function normalizeConstraints(
  fieldType: ApplicationFormFieldType,
  constraints: ApplicationFormInspectionReport["forms"][number]["sections"][number]["fields"][number]["constraints"]
): NormalizedApplicationFormConstraints {
  let min: string | null = null;
  let max: string | null = null;
  let step: string | null = null;
  if (fieldType === "NUMBER") {
    min = constraints.min === null ? null : canonicalizeDecimal(constraints.min);
    max = constraints.max === null ? null : canonicalizeDecimal(constraints.max);
    step = constraints.step === null ? null : canonicalizeDecimal(constraints.step);
    if (min !== null && max !== null && compareCanonicalDecimals(min, max) > 0) {
      throw new FormInspectionDomainError("INVALID_INPUT", "Numeric constraint bounds are reversed.");
    }
    if (step !== null && compareCanonicalDecimals(step, "0") <= 0) {
      throw new FormInspectionDomainError("INVALID_INPUT", "Numeric steps must be positive.");
    }
  } else if (fieldType === "DATE") {
    min = constraints.min === null ? null : canonicalizeDate(constraints.min);
    max = constraints.max === null ? null : canonicalizeDate(constraints.max);
    step = constraints.step === null ? null : canonicalizeDecimal(constraints.step);
    if (min !== null && max !== null && compareCodeUnits(min, max) > 0) {
      throw new FormInspectionDomainError("INVALID_INPUT", "Date constraint bounds are reversed.");
    }
    if (step !== null && compareCanonicalDecimals(step, "0") <= 0) {
      throw new FormInspectionDomainError("INVALID_INPUT", "Date steps must be positive.");
    }
  }
  return {
    minLength: constraints.minLength,
    maxLength: constraints.maxLength,
    min,
    max,
    step,
    acceptedFileTypes: [...new Set(constraints.acceptedFileTypes)].sort(compareCodeUnits),
    multiple: constraints.multiple
  };
}

function normalizeApplyHost(value: string): string {
  const normalized = value.toLowerCase();
  if (
    value !== value.trim() ||
    normalized.length === 0 ||
    normalized.length > 253 ||
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/.test(
      normalized
    )
  ) {
    throw new FormInspectionDomainError("INVALID_INPUT", "The authoritative apply host is invalid.");
  }
  return normalized;
}

export function deriveNormalizedFieldKey(input: {
  semanticFieldKey: string | null;
  formTitle: string;
  sectionHeading: string;
  normalizedQuestion: string;
  fieldType: ApplicationFormFieldType;
}): string {
  return hashDomainSeparated("application-form-field-key:v1\0", {
    fieldType: input.fieldType,
    formTitle: input.formTitle,
    identity: input.semanticFieldKey ?? input.normalizedQuestion,
    sectionHeading: input.sectionHeading,
    semanticFieldKey: input.semanticFieldKey
  });
}

export function deriveChoiceKey(input: { normalizedFieldKey: string; normalizedLabel: string }): string {
  return hashDomainSeparated("application-form-choice-key:v1\0", input);
}

export function computeFieldFingerprint(input: {
  normalizedFieldKey: string;
  semanticFieldKey: string | null;
  normalizedQuestion: string;
  normalizedFormTitle: string;
  normalizedSectionHeading: string;
  normalizedHelpText: string;
  fieldType: ApplicationFormFieldType;
  classification: ApplicationQuestionClassification;
  permittedDisposition: ApplicationAnswerDisposition;
  dispositionReason: ApplicationAnswerDispositionReason | null;
  unsupportedReason: NormalizedFormUnsupportedReason | null;
  required: boolean;
  autocomplete: ApplicationFormAutocomplete | null;
  constraints: NormalizedApplicationFormConstraints;
  choices: readonly { key: string; disabled: boolean }[];
}): string {
  return hashDomainSeparated("application-form-field:v1\0", {
    ...input,
    choices: [...input.choices].sort((left, right) => compareCodeUnits(left.key, right.key)),
    classifierVersion: CLASSIFIER_VERSION,
    fingerprintVersion: FIELD_FINGERPRINT_VERSION,
    normalizerVersion: FORM_NORMALIZER_VERSION
  });
}

export function computeFormFingerprint(
  authoritativeApplyHost: string,
  snapshot: NormalizedApplicationFormSnapshot
): string {
  const applyHost = normalizeApplyHost(authoritativeApplyHost);
  const canonicalSnapshot = parseNormalizedApplicationFormSnapshot(snapshot);
  const forms = canonicalSnapshot.forms
    .map((form) => ({
      formKey: form.formKey,
      title: canonicalizeFormComparisonText(form.title ?? ""),
      sections: form.sections
        .map((section) => ({
          sectionKey: section.sectionKey,
          heading: canonicalizeFormComparisonText(section.heading ?? ""),
          fieldFingerprints: section.fields.map((field) => field.fieldFingerprint).sort(compareCodeUnits)
        }))
        .sort((left, right) => compareCodeUnits(left.sectionKey, right.sectionKey))
    }))
    .sort((left, right) => compareCodeUnits(left.formKey, right.formKey));
  return hashDomainSeparated("application-form:v1\0", {
    applyHost,
    classifierVersion: CLASSIFIER_VERSION,
    fingerprintVersion: FIELD_FINGERPRINT_VERSION,
    forms,
    normalizerVersion: FORM_NORMALIZER_VERSION,
    schemaVersion: FORM_INSPECTION_SCHEMA_VERSION
  });
}

type WorkingField = {
  normalized: NormalizedApplicationFormField;
  normalizedFormTitle: string;
  normalizedSectionHeading: string;
};

export function buildNormalizedApplicationFormInspection(input: {
  authoritativeApplyHost: string;
  report: unknown;
}): {
  formFingerprint: string;
  fieldCount: number;
  requiredFieldCount: number;
  snapshot: NormalizedApplicationFormSnapshot;
} {
  normalizeApplyHost(input.authoritativeApplyHost);
  const report = applicationFormInspectionReportSchema.parse(input.report);
  const allFields: WorkingField[] = [];
  const workingForms = report.forms.map((form) => {
    const title = sanitizedNullable(form.title);
    const normalizedFormTitle = canonicalizeFormComparisonText(title ?? "");
    const workingSections = form.sections.map((section) => {
      const heading = sanitizedNullable(section.heading);
      const normalizedSectionHeading = canonicalizeFormComparisonText(heading ?? "");
      const fields = section.fields.map((field): WorkingField => {
        const question = sanitizedNullable(field.question);
        const normalizedQuestion = canonicalizeFormComparisonText(question ?? "");
        const helpText = sanitizedNullable(field.helpText);
        const normalizedHelpText = canonicalizeFormComparisonText(helpText ?? "");
        const normalizedConstraints = normalizeConstraints(field.fieldType, field.constraints);

        const canonicalChoices = field.choices.map((choice) => {
          const label = sanitizeFormDisplayText(choice.label);
          return { label, normalizedLabel: canonicalizeFormComparisonText(label), disabled: choice.disabled };
        });
        const choiceLabels = new Set<string>();
        let duplicateChoices = false;
        for (const choice of canonicalChoices) {
          if (choiceLabels.has(choice.normalizedLabel)) duplicateChoices = true;
          choiceLabels.add(choice.normalizedLabel);
        }

        let fieldType = field.fieldType;
        let unsupportedReason: NormalizedFormUnsupportedReason | null = field.unsupportedReason;
        if (field.fieldType === "FILE_UPLOAD" && field.constraints.multiple) {
          fieldType = "UNSUPPORTED";
          unsupportedReason = "MULTIPLE_FILE_UPLOAD";
        } else if (duplicateChoices) {
          fieldType = "UNSUPPORTED";
          unsupportedReason = "AMBIGUOUS_CHOICES";
        }

        const classification = classifyApplicationQuestion({
          question: normalizedQuestion,
          sectionHeading: normalizedSectionHeading,
          helpText: normalizedHelpText,
          autocomplete: field.autocomplete,
          fieldType
        });

        const normalizedFieldKey = deriveNormalizedFieldKey({
          semanticFieldKey: classification.semanticFieldKey,
          formTitle: normalizedFormTitle,
          sectionHeading: normalizedSectionHeading,
          normalizedQuestion,
          fieldType
        });
        const choices: NormalizedApplicationFormChoice[] = duplicateChoices
          ? []
          : canonicalChoices
              .map((choice) => ({
                key: deriveChoiceKey({ normalizedFieldKey, normalizedLabel: choice.normalizedLabel }),
                label: choice.label,
                disabled: choice.disabled
              }))
              .sort((left, right) => compareCodeUnits(left.key, right.key));

        const permittedDisposition =
          classification.permittedDisposition === "EXCLUDED"
            ? "EXCLUDED"
            : fieldType === "UNSUPPORTED"
              ? "UNSUPPORTED"
              : classification.permittedDisposition;
        const dispositionReason =
          fieldType === "UNSUPPORTED" && permittedDisposition === "UNSUPPORTED"
            ? unsupportedReason === "MULTIPLE_FILE_UPLOAD"
              ? "MULTIPLE_FILE_UPLOAD"
              : unsupportedReason === "AMBIGUOUS_CHOICES"
                ? "AMBIGUOUS_CHOICES"
                : "UNSUPPORTED_CONTROL"
            : classification.dispositionReason;

        const fieldFingerprint = computeFieldFingerprint({
          normalizedFieldKey,
          semanticFieldKey: classification.semanticFieldKey,
          normalizedQuestion,
          normalizedFormTitle,
          normalizedSectionHeading,
          normalizedHelpText,
          fieldType,
          classification: classification.classification,
          permittedDisposition,
          dispositionReason,
          unsupportedReason,
          required: field.required,
          autocomplete: field.autocomplete,
          constraints: normalizedConstraints,
          choices
        });
        const normalized: NormalizedApplicationFormField = {
          normalizedFieldKey,
          semanticFieldKey: classification.semanticFieldKey,
          question,
          normalizedQuestion,
          helpText,
          fieldType,
          classification: classification.classification,
          permittedDisposition,
          dispositionReason,
          unsupportedReason,
          required: field.required,
          autocomplete: field.autocomplete,
          constraints: normalizedConstraints,
          choices,
          fieldFingerprint
        };
        const working = { normalized, normalizedFormTitle, normalizedSectionHeading };
        allFields.push(working);
        return working;
      });
      return { heading, normalizedSectionHeading, fields };
    });
    return { title, normalizedFormTitle, sections: workingSections };
  });

  const seenFieldKeys = new Set<string>();
  for (const field of allFields) {
    if (seenFieldKeys.has(field.normalized.normalizedFieldKey)) {
      throw new FormInspectionDomainError(
        "AMBIGUOUS_DUPLICATE_FIELD",
        "The inspection contains indistinguishable duplicate fields."
      );
    }
    seenFieldKeys.add(field.normalized.normalizedFieldKey);
  }

  const forms: NormalizedApplicationForm[] = workingForms
    .map((form) => {
      const sections: NormalizedApplicationFormSection[] = form.sections
        .map((section) => {
          const fields = section.fields.map((field) => field.normalized).sort((left, right) =>
            compareCodeUnits(left.normalizedFieldKey, right.normalizedFieldKey)
          );
          const sectionKey = hashDomainSeparated("application-form-section-key:v1\0", {
            fieldKeys: fields.map((field) => field.normalizedFieldKey),
            heading: section.normalizedSectionHeading
          });
          return { sectionKey, heading: section.heading, fields };
        })
        .sort((left, right) => compareCodeUnits(left.sectionKey, right.sectionKey));
      const formKey = hashDomainSeparated("application-form-form-key:v1\0", {
        sectionKeys: sections.map((section) => section.sectionKey),
        title: form.normalizedFormTitle
      });
      return { formKey, title: form.title, sections };
    })
    .sort((left, right) => compareCodeUnits(left.formKey, right.formKey));

  const snapshot = normalizedApplicationFormSnapshotSchema.parse({
    schemaVersion: FORM_INSPECTION_SCHEMA_VERSION,
    normalizerVersion: FORM_NORMALIZER_VERSION,
    classifierVersion: CLASSIFIER_VERSION,
    fingerprintVersion: FIELD_FINGERPRINT_VERSION,
    forms
  });
  return {
    formFingerprint: computeFormFingerprint(input.authoritativeApplyHost, snapshot),
    fieldCount: allFields.length,
    requiredFieldCount: allFields.filter((field) => field.normalized.required).length,
    snapshot
  };
}

function rejectNonCanonicalSnapshot(message: string): never {
  throw new FormInspectionDomainError("NON_CANONICAL_VALUE", message);
}

function assertCanonicalNullableDisplay(value: string | null): void {
  if (
    value !== null &&
    (value.length === 0 || !hasVisibleBaseCharacter(value) || sanitizeFormDisplayText(value) !== value)
  ) {
    rejectNonCanonicalSnapshot("Snapshot display text is not canonical.");
  }
}

function assertStrictlySorted<T>(
  values: readonly T[],
  key: (value: T) => string,
  label: string
): void {
  for (let index = 1; index < values.length; index += 1) {
    if (compareCodeUnits(key(values[index - 1]), key(values[index])) >= 0) {
      rejectNonCanonicalSnapshot(`Snapshot ${label} are not uniquely and canonically ordered.`);
    }
  }
}

function assertNormalizedConstraintsCanonical(field: NormalizedApplicationFormField): void {
  const constraints = field.constraints;
  if (
    constraints.minLength !== null &&
    constraints.maxLength !== null &&
    constraints.minLength > constraints.maxLength
  ) {
    rejectNonCanonicalSnapshot("Snapshot length constraints are reversed.");
  }

  const canonicalAcceptedTypes = [...new Set(constraints.acceptedFileTypes)].sort(compareCodeUnits);
  if (canonicalJson(canonicalAcceptedTypes) !== canonicalJson(constraints.acceptedFileTypes)) {
    rejectNonCanonicalSnapshot("Snapshot accepted file types are not a canonical set.");
  }

  const permitsLength = TEXT_CONSTRAINT_FIELD_TYPES.includes(field.fieldType);
  if (!permitsLength && (constraints.minLength !== null || constraints.maxLength !== null)) {
    rejectNonCanonicalSnapshot("Snapshot length constraints are incompatible with the field type.");
  }

  const permitsValue = field.fieldType === "NUMBER" || field.fieldType === "DATE";
  if (!permitsValue && (constraints.min !== null || constraints.max !== null || constraints.step !== null)) {
    rejectNonCanonicalSnapshot("Snapshot value constraints are incompatible with the field type.");
  }

  if (field.fieldType === "NUMBER") {
    const min = constraints.min === null ? null : canonicalizeDecimal(constraints.min);
    const max = constraints.max === null ? null : canonicalizeDecimal(constraints.max);
    const step = constraints.step === null ? null : canonicalizeDecimal(constraints.step);
    if (min !== constraints.min || max !== constraints.max || step !== constraints.step) {
      rejectNonCanonicalSnapshot("Snapshot numeric constraints are not canonical.");
    }
    if (min !== null && max !== null && compareCanonicalDecimals(min, max) > 0) {
      rejectNonCanonicalSnapshot("Snapshot numeric constraints are reversed.");
    }
    if (step !== null && compareCanonicalDecimals(step, "0") <= 0) {
      rejectNonCanonicalSnapshot("Snapshot numeric step is not positive.");
    }
  } else if (field.fieldType === "DATE") {
    const min = constraints.min === null ? null : canonicalizeDate(constraints.min);
    const max = constraints.max === null ? null : canonicalizeDate(constraints.max);
    const step = constraints.step === null ? null : canonicalizeDecimal(constraints.step);
    if (min !== constraints.min || max !== constraints.max || step !== constraints.step) {
      rejectNonCanonicalSnapshot("Snapshot date constraints are not canonical.");
    }
    if (min !== null && max !== null && compareCodeUnits(min, max) > 0) {
      rejectNonCanonicalSnapshot("Snapshot date constraints are reversed.");
    }
    if (step !== null && compareCanonicalDecimals(step, "0") <= 0) {
      rejectNonCanonicalSnapshot("Snapshot date step is not positive.");
    }
  }

  const multipleFile =
    field.fieldType === "UNSUPPORTED" && field.unsupportedReason === "MULTIPLE_FILE_UPLOAD";
  const permitsFiles = field.fieldType === "FILE_UPLOAD" || multipleFile;
  if (!permitsFiles && (constraints.acceptedFileTypes.length > 0 || constraints.multiple)) {
    rejectNonCanonicalSnapshot("Snapshot file constraints are incompatible with the field type.");
  }
  if (field.fieldType === "FILE_UPLOAD" && constraints.multiple) {
    rejectNonCanonicalSnapshot("A multiple-file control must be normalized as unsupported.");
  }
  if (multipleFile ? !constraints.multiple : field.fieldType === "UNSUPPORTED" && constraints.multiple) {
    rejectNonCanonicalSnapshot("Snapshot file multiplicity does not match its unsupported reason.");
  }
}

function assertCanonicalSnapshot(snapshot: NormalizedApplicationFormSnapshot): void {
  const seenFieldKeys = new Set<string>();

  for (const form of snapshot.forms) {
    assertCanonicalNullableDisplay(form.title);
    const normalizedFormTitle = canonicalizeFormComparisonText(form.title ?? "");

    for (const section of form.sections) {
      assertCanonicalNullableDisplay(section.heading);
      const normalizedSectionHeading = canonicalizeFormComparisonText(section.heading ?? "");
      assertStrictlySorted(section.fields, (field) => field.normalizedFieldKey, "fields");

      for (const field of section.fields) {
        assertCanonicalNullableDisplay(field.question);
        assertCanonicalNullableDisplay(field.helpText);
        const normalizedQuestion = canonicalizeFormComparisonText(field.question ?? "");
        const normalizedHelpText = canonicalizeFormComparisonText(field.helpText ?? "");
        if (field.normalizedQuestion !== normalizedQuestion) {
          rejectNonCanonicalSnapshot("Snapshot question comparison text is inconsistent.");
        }
        if (seenFieldKeys.has(field.normalizedFieldKey)) {
          rejectNonCanonicalSnapshot("Snapshot contains an ambiguous duplicate field.");
        }
        seenFieldKeys.add(field.normalizedFieldKey);

        const isChoiceField = CHOICE_FIELD_TYPES.includes(field.fieldType);
        if (isChoiceField ? field.choices.length === 0 : field.choices.length > 0) {
          rejectNonCanonicalSnapshot("Snapshot choices are incompatible with the field type.");
        }
        if (field.fieldType === "UNSUPPORTED" ? field.unsupportedReason === null : field.unsupportedReason !== null) {
          rejectNonCanonicalSnapshot("Snapshot unsupported reason is incompatible with the field type.");
        }
        assertNormalizedConstraintsCanonical(field);

        assertStrictlySorted(field.choices, (choice) => choice.key, "choices");
        const seenChoiceLabels = new Set<string>();
        for (const choice of field.choices) {
          if (sanitizeFormDisplayText(choice.label) !== choice.label || choice.label.length === 0) {
            rejectNonCanonicalSnapshot("Snapshot choice display text is not canonical.");
          }
          const normalizedLabel = canonicalizeFormComparisonText(choice.label);
          if (seenChoiceLabels.has(normalizedLabel)) {
            rejectNonCanonicalSnapshot("Snapshot contains ambiguous canonical choices.");
          }
          seenChoiceLabels.add(normalizedLabel);
          const expectedChoiceKey = deriveChoiceKey({
            normalizedFieldKey: field.normalizedFieldKey,
            normalizedLabel
          });
          if (choice.key !== expectedChoiceKey) {
            rejectNonCanonicalSnapshot("Snapshot choice identity is inconsistent.");
          }
        }

        const classification = classifyApplicationQuestion({
          question: normalizedQuestion,
          sectionHeading: normalizedSectionHeading,
          helpText: normalizedHelpText,
          autocomplete: field.autocomplete,
          fieldType: field.fieldType
        });
        if (
          field.classification !== classification.classification ||
          field.semanticFieldKey !== classification.semanticFieldKey
        ) {
          rejectNonCanonicalSnapshot("Snapshot classification authority is inconsistent.");
        }

        const expectedDisposition =
          classification.permittedDisposition === "EXCLUDED"
            ? "EXCLUDED"
            : field.fieldType === "UNSUPPORTED"
              ? "UNSUPPORTED"
              : classification.permittedDisposition;
        const expectedReason =
          field.fieldType === "UNSUPPORTED" && expectedDisposition === "UNSUPPORTED"
            ? field.unsupportedReason === "MULTIPLE_FILE_UPLOAD"
              ? "MULTIPLE_FILE_UPLOAD"
              : field.unsupportedReason === "AMBIGUOUS_CHOICES"
                ? "AMBIGUOUS_CHOICES"
                : "UNSUPPORTED_CONTROL"
            : classification.dispositionReason;
        if (
          field.permittedDisposition !== expectedDisposition ||
          field.dispositionReason !== expectedReason
        ) {
          rejectNonCanonicalSnapshot("Snapshot disposition authority is inconsistent.");
        }

        const expectedFieldKey = deriveNormalizedFieldKey({
          semanticFieldKey: field.semanticFieldKey,
          formTitle: normalizedFormTitle,
          sectionHeading: normalizedSectionHeading,
          normalizedQuestion,
          fieldType: field.fieldType
        });
        if (field.normalizedFieldKey !== expectedFieldKey) {
          rejectNonCanonicalSnapshot("Snapshot field identity is inconsistent.");
        }

        const expectedFieldFingerprint = computeFieldFingerprint({
          normalizedFieldKey: field.normalizedFieldKey,
          semanticFieldKey: field.semanticFieldKey,
          normalizedQuestion,
          normalizedFormTitle,
          normalizedSectionHeading,
          normalizedHelpText,
          fieldType: field.fieldType,
          classification: field.classification,
          permittedDisposition: field.permittedDisposition,
          dispositionReason: field.dispositionReason,
          unsupportedReason: field.unsupportedReason,
          required: field.required,
          autocomplete: field.autocomplete,
          constraints: field.constraints,
          choices: field.choices
        });
        if (field.fieldFingerprint !== expectedFieldFingerprint) {
          rejectNonCanonicalSnapshot("Snapshot field fingerprint is inconsistent.");
        }
      }

      const expectedSectionKey = hashDomainSeparated("application-form-section-key:v1\0", {
        fieldKeys: section.fields.map((field) => field.normalizedFieldKey),
        heading: normalizedSectionHeading
      });
      if (section.sectionKey !== expectedSectionKey) {
        rejectNonCanonicalSnapshot("Snapshot section identity is inconsistent.");
      }
    }

    assertStrictlySorted(form.sections, (section) => section.sectionKey, "sections");
    const expectedFormKey = hashDomainSeparated("application-form-form-key:v1\0", {
      sectionKeys: form.sections.map((section) => section.sectionKey),
      title: normalizedFormTitle
    });
    if (form.formKey !== expectedFormKey) {
      rejectNonCanonicalSnapshot("Snapshot form identity is inconsistent.");
    }
  }

  assertStrictlySorted(snapshot.forms, (form) => form.formKey, "forms");
}

export function parseNormalizedApplicationFormSnapshot(value: unknown): NormalizedApplicationFormSnapshot {
  const parsed = normalizedApplicationFormSnapshotSchema.parse(value);
  assertCanonicalSnapshot(parsed);
  return parsed;
}

export function verifyNormalizedApplicationFormSnapshot(input: {
  authoritativeApplyHost: string;
  expectedFormFingerprint: string;
  snapshot: unknown;
}): NormalizedApplicationFormSnapshot {
  if (!LOWERCASE_HEX_64_PATTERN.test(input.expectedFormFingerprint)) {
    rejectNonCanonicalSnapshot("Expected form fingerprint is invalid.");
  }
  const snapshot = parseNormalizedApplicationFormSnapshot(input.snapshot);
  if (computeFormFingerprint(input.authoritativeApplyHost, snapshot) !== input.expectedFormFingerprint) {
    rejectNonCanonicalSnapshot("Stored form fingerprint does not match the canonical snapshot.");
  }
  return snapshot;
}
