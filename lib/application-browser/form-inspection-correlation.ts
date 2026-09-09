import type {
  OpaqueExtractionCandidate,
  ProtectedApplicationFormExtraction,
  ProtectedSourceChoiceOrdinal,
  ProtectedSourceFieldOrdinal
} from "@/lib/application-browser/protected-browser-session";
import {
  buildNormalizedApplicationFormInspection,
  FormInspectionDomainError,
  type ApplicationFormInspectionReport,
  type NormalizedApplicationFormSnapshot
} from "@/lib/application-runs/form-inspection";

export const APPLICATION_FORM_CORRELATION_ERROR_CODES = [
  "FORM_CORRELATION_INVALID"
] as const;

export type ApplicationFormCorrelationErrorCode =
  (typeof APPLICATION_FORM_CORRELATION_ERROR_CODES)[number];

export class ApplicationFormCorrelationError extends Error {
  readonly code: ApplicationFormCorrelationErrorCode;

  constructor(code: ApplicationFormCorrelationErrorCode) {
    super(`Protected form correlation failed: ${code}`);
    this.name = "ApplicationFormCorrelationError";
    this.code = code;
  }
}

export type CorrelatedProtectedApplicationFormExtraction = Readonly<{
  candidate: OpaqueExtractionCandidate;
  formFingerprint: string;
  fieldCount: number;
  requiredFieldCount: number;
  inspectionReport: ApplicationFormInspectionReport;
  normalizedSnapshot: NormalizedApplicationFormSnapshot;
  dispose(): Promise<void>;
}>;

function correlationInvalid(): ApplicationFormCorrelationError {
  return new ApplicationFormCorrelationError("FORM_CORRELATION_INVALID");
}

function isSourceIndex(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function fieldOrdinalKey(ordinal: ProtectedSourceFieldOrdinal): string {
  return `${ordinal.form}/${ordinal.section}/${ordinal.field}`;
}

function choiceOrdinalKey(ordinal: ProtectedSourceChoiceOrdinal): string {
  return `${ordinal.form}/${ordinal.section}/${ordinal.field}/${ordinal.choice}`;
}

function validateProtectedSourceGraph(
  extraction: ProtectedApplicationFormExtraction
): number {
  const expectedFieldOrdinals = new Set<string>();
  let rawFieldCount = 0;
  for (const [formIndex, form] of extraction.report.forms.entries()) {
    for (const [sectionIndex, section] of form.sections.entries()) {
      for (const fieldIndex of section.fields.keys()) {
        expectedFieldOrdinals.add(fieldOrdinalKey({
          form: formIndex,
          section: sectionIndex,
          field: fieldIndex
        }));
        rawFieldCount += 1;
      }
    }
  }
  if (extraction.fields.length !== rawFieldCount) throw correlationInvalid();

  const claimedFieldOrdinals = new Set<string>();
  const claimedChoiceOrdinals = new Set<string>();

  for (const slot of extraction.fields) {
    const ordinal = slot.sourceOrdinal;
    if (
      !isSourceIndex(ordinal.form) ||
      !isSourceIndex(ordinal.section) ||
      !isSourceIndex(ordinal.field)
    ) {
      throw correlationInvalid();
    }
    const form = extraction.report.forms[ordinal.form];
    const section = form?.sections[ordinal.section];
    const rawField = section?.fields[ordinal.field];
    if (!form || !section || !rawField) throw correlationInvalid();

    const sourceFieldKey = fieldOrdinalKey(ordinal);
    if (
      !expectedFieldOrdinals.has(sourceFieldKey) ||
      claimedFieldOrdinals.has(sourceFieldKey)
    ) {
      throw correlationInvalid();
    }
    claimedFieldOrdinals.add(sourceFieldKey);

    if (slot.choices.length !== rawField.choices.length) throw correlationInvalid();
    const claimedChoiceIndexes = new Set<number>();
    for (const choiceSlot of slot.choices) {
      const choiceOrdinal = choiceSlot.sourceOrdinal;
      if (
        !isSourceIndex(choiceOrdinal.form) ||
        !isSourceIndex(choiceOrdinal.section) ||
        !isSourceIndex(choiceOrdinal.field) ||
        !isSourceIndex(choiceOrdinal.choice) ||
        choiceOrdinal.form !== ordinal.form ||
        choiceOrdinal.section !== ordinal.section ||
        choiceOrdinal.field !== ordinal.field ||
        choiceOrdinal.choice >= rawField.choices.length ||
        claimedChoiceIndexes.has(choiceOrdinal.choice)
      ) {
        throw correlationInvalid();
      }
      const sourceChoiceKey = choiceOrdinalKey(choiceOrdinal);
      if (claimedChoiceOrdinals.has(sourceChoiceKey)) throw correlationInvalid();
      claimedChoiceIndexes.add(choiceOrdinal.choice);
      claimedChoiceOrdinals.add(sourceChoiceKey);
    }
    if (claimedChoiceIndexes.size !== rawField.choices.length) throw correlationInvalid();

  }

  if (claimedFieldOrdinals.size !== expectedFieldOrdinals.size) throw correlationInvalid();
  for (const expected of expectedFieldOrdinals) {
    if (!claimedFieldOrdinals.has(expected)) throw correlationInvalid();
  }
  return rawFieldCount;
}

function mapCorrelationFailure(error: unknown): Error {
  if (
    error instanceof FormInspectionDomainError &&
    error.code === "AMBIGUOUS_DUPLICATE_FIELD"
  ) {
    return error;
  }
  if (error instanceof ApplicationFormCorrelationError) return error;
  return correlationInvalid();
}

function createIdempotentDisposer(
  disposeOwnedCandidate: () => Promise<void>
): () => Promise<void> {
  let disposePromise: Promise<void> | null = null;
  return () => {
    disposePromise ??= Promise.resolve().then(disposeOwnedCandidate);
    return disposePromise;
  };
}

export async function correlateProtectedApplicationFormExtraction(
  input: Readonly<{
    extraction: ProtectedApplicationFormExtraction;
    authoritativeApplyHost: string;
  }>
): Promise<CorrelatedProtectedApplicationFormExtraction> {
  const extraction = input.extraction;
  try {
    const rawFieldCount = validateProtectedSourceGraph(extraction);
    const full = buildNormalizedApplicationFormInspection({
      authoritativeApplyHost: input.authoritativeApplyHost,
      report: extraction.report
    });
    if (full.fieldCount !== rawFieldCount) throw correlationInvalid();

    const candidate = extraction.candidate;
    const inspectionReport = extraction.report;
    const disposeOwnedCandidate = extraction.dispose;
    return {
      candidate,
      formFingerprint: full.formFingerprint,
      fieldCount: full.fieldCount,
      requiredFieldCount: full.requiredFieldCount,
      inspectionReport,
      normalizedSnapshot: full.snapshot,
      dispose: createIdempotentDisposer(disposeOwnedCandidate)
    };
  } catch (error) {
    try {
      await extraction.dispose();
    } catch {
      // The bounded primary correlation error remains authoritative.
    }
    throw mapCorrelationFailure(error);
  }
}
