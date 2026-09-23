import type {
  OpaqueExtractionCandidate,
  ProtectedApplicationFormExtraction,
  ProtectedSourceChoiceOrdinal,
  ProtectedSourceFieldOrdinal,
  ProtectedWriterTargetBinding,
  ProtectedWritableFieldType
} from "@/lib/application-browser/protected-browser-session";
import { PROTECTED_WRITABLE_FIELD_TYPES } from "@/lib/application-browser/protected-browser-session";
import {
  buildNormalizedApplicationFormInspection,
  canonicalizeFormComparisonText,
  deriveChoiceKey,
  FormInspectionDomainError,
  sanitizeFormDisplayText,
  type ApplicationFormInspectionReport,
  type NormalizedApplicationFormField,
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
  uniqueFieldCount: number;
  ambiguousQuestionCount: number;
  ambiguousRequiredCount: number;
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

const writableFieldTypes = new Set<string>(PROTECTED_WRITABLE_FIELD_TYPES);

function isWritableFieldType(value: string): value is ProtectedWritableFieldType {
  return writableFieldTypes.has(value);
}

function normalizedFieldForSource(input: Readonly<{
  report: ApplicationFormInspectionReport;
  sourceOrdinal: ProtectedSourceFieldOrdinal;
  authoritativeApplyHost: string;
}>): NormalizedApplicationFormField {
  const form = input.report.forms[input.sourceOrdinal.form];
  const section = form?.sections[input.sourceOrdinal.section];
  const field = section?.fields[input.sourceOrdinal.field];
  if (!form || !section || !field) throw correlationInvalid();
  const single = buildNormalizedApplicationFormInspection({
    authoritativeApplyHost: input.authoritativeApplyHost,
    report: {
      schemaVersion: input.report.schemaVersion,
      forms: [{
        title: form.title,
        sections: [{ heading: section.heading, fields: [field] }]
      }]
    }
  });
  const normalized = single.snapshot.forms[0]?.sections[0]?.fields[0];
  if (!normalized || single.fieldCount !== 1) throw correlationInvalid();
  return normalized;
}

function ambiguousMemberForSource(input: Readonly<{
  report: ApplicationFormInspectionReport;
  sourceOrdinal: ProtectedSourceFieldOrdinal;
  authoritativeApplyHost: string;
}>) {
  const form = input.report.forms[input.sourceOrdinal.form];
  const section = form?.sections[input.sourceOrdinal.section];
  const field = section?.fields[input.sourceOrdinal.field];
  if (!form || !section || !field) throw correlationInvalid();
  const doubled = buildNormalizedApplicationFormInspection({
    authoritativeApplyHost: input.authoritativeApplyHost,
    report: {
      schemaVersion: input.report.schemaVersion,
      forms: [{ title: form.title, sections: [{ heading: section.heading, fields: [field, field] }] }]
    }
  });
  const member = doubled.snapshot.forms[0]?.sections[0]?.ambiguousMembers?.[0];
  if (!member || doubled.ambiguousQuestionCount !== 2) throw correlationInvalid();
  return member;
}

function buildWriterTargetBindings(input: Readonly<{
  extraction: ProtectedApplicationFormExtraction;
  normalizedSnapshot: NormalizedApplicationFormSnapshot;
  authoritativeApplyHost: string;
}>): readonly ProtectedWriterTargetBinding[] {
  const normalizedByKey = new Map<string, NormalizedApplicationFormField>();
  for (const form of input.normalizedSnapshot.forms) {
    for (const section of form.sections) {
      for (const field of section.fields) {
        if (normalizedByKey.has(field.normalizedFieldKey)) throw correlationInvalid();
        normalizedByKey.set(field.normalizedFieldKey, field);
      }
    }
  }

  // Sections are canonically sorted, so match raw sections using their unique
  // field keys and anonymous occurrence multisets rather than source order.
  const allAnonymous = input.normalizedSnapshot.forms.flatMap((form) =>
    form.sections.flatMap((section) => section.ambiguousMembers ?? [])
  );
  const anonymousCounts = new Map<string, number>();
  for (const member of allAnonymous) {
    const key = `${member.collisionKey}/${member.memberIntegrityDigest}/${member.required}`;
    anonymousCounts.set(key, (anonymousCounts.get(key) ?? 0) + 1);
  }

  const bindings: ProtectedWriterTargetBinding[] = [];
  const boundKeys = new Set<string>();
  for (const slot of input.extraction.fields) {
    const source = slot.sourceOrdinal;
    const rawField = input.extraction.report.forms[source.form]?.sections[source.section]?.fields[source.field];
    if (!rawField) throw correlationInvalid();
    const derived = normalizedFieldForSource({
      report: input.extraction.report,
      sourceOrdinal: source,
      authoritativeApplyHost: input.authoritativeApplyHost
    });
    if (input.normalizedSnapshot.ambiguityGroups?.some((group) => group.collisionKey === derived.normalizedFieldKey)) {
      const member = ambiguousMemberForSource({
        report: input.extraction.report,
        sourceOrdinal: source,
        authoritativeApplyHost: input.authoritativeApplyHost
      });
      const key = `${member.collisionKey}/${member.memberIntegrityDigest}/${member.required}`;
      const remaining = anonymousCounts.get(key) ?? 0;
      if (remaining < 1) throw correlationInvalid();
      anonymousCounts.set(key, remaining - 1);
      continue;
    }
    const normalized = normalizedByKey.get(derived.normalizedFieldKey);
    if (
      !normalized ||
      normalized.fieldFingerprint !== derived.fieldFingerprint ||
      normalized.fieldType !== derived.fieldType
    ) throw correlationInvalid();
    if (!isWritableFieldType(normalized.fieldType)) continue;
    if (boundKeys.has(normalized.normalizedFieldKey) || rawField.fieldType !== normalized.fieldType) {
      throw correlationInvalid();
    }
    boundKeys.add(normalized.normalizedFieldKey);

    const normalizedChoices = new Map(normalized.choices.map((choice) => [choice.key, choice]));
    const choices = slot.choices
      .map((choiceSlot) => {
        const choiceOrdinal = choiceSlot.sourceOrdinal;
        const rawChoice = rawField.choices[choiceOrdinal.choice];
        if (!rawChoice) throw correlationInvalid();
        const choiceKey = deriveChoiceKey({
          normalizedFieldKey: normalized.normalizedFieldKey,
          normalizedLabel: canonicalizeFormComparisonText(sanitizeFormDisplayText(rawChoice.label))
        });
        const canonicalChoice = normalizedChoices.get(choiceKey);
        if (!canonicalChoice || canonicalChoice.disabled !== rawChoice.disabled) throw correlationInvalid();
        return Object.freeze({ choiceKey, sourceOrdinal: choiceOrdinal });
      })
      .sort((left, right) => left.sourceOrdinal.choice - right.sourceOrdinal.choice);
    if (
      normalized.fieldType === "SELECT_ONE"
        ? choices.length !== rawField.choices.length || choices.length !== normalized.choices.length
        : choices.length !== 0
    ) throw correlationInvalid();
    bindings.push(Object.freeze({
      normalizedFieldKey: normalized.normalizedFieldKey,
      fieldFingerprint: normalized.fieldFingerprint,
      fieldType: normalized.fieldType,
      sourceOrdinal: source,
      choices: Object.freeze(choices)
    }));
  }
  if ([...anonymousCounts.values()].some((count) => count !== 0)) throw correlationInvalid();

  const expectedWritableKeys = [...normalizedByKey.values()]
    .filter((field) => isWritableFieldType(field.fieldType))
    .map((field) => field.normalizedFieldKey);
  if (
    expectedWritableKeys.length !== bindings.length ||
    expectedWritableKeys.some((key) => !boundKeys.has(key))
  ) throw correlationInvalid();
  bindings.sort((left, right) =>
    left.sourceOrdinal.form - right.sourceOrdinal.form ||
    left.sourceOrdinal.section - right.sourceOrdinal.section ||
    left.sourceOrdinal.field - right.sourceOrdinal.field
  );
  return Object.freeze(bindings);
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
    const writerTargetBindings = buildWriterTargetBindings({
      extraction,
      normalizedSnapshot: full.snapshot,
      authoritativeApplyHost: input.authoritativeApplyHost
    });
    await extraction.sealWriterTargets(writerTargetBindings);

    const candidate = extraction.candidate;
    const inspectionReport = extraction.report;
    const disposeOwnedCandidate = extraction.dispose;
    return {
      candidate,
      formFingerprint: full.formFingerprint,
      fieldCount: full.fieldCount,
      requiredFieldCount: full.requiredFieldCount,
      uniqueFieldCount: full.uniqueFieldCount,
      ambiguousQuestionCount: full.ambiguousQuestionCount,
      ambiguousRequiredCount: full.ambiguousRequiredCount,
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
