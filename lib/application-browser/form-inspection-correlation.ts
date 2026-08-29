import type { ElementHandle } from "playwright";

import type {
  SafeApplicationFormExtraction,
  SafeDomFieldReference,
  SourceChoiceOrdinal,
  SourceFieldOrdinal
} from "@/lib/application-browser/form-inspection-dom";
import {
  buildNormalizedApplicationFormInspection,
  canonicalJson,
  FormInspectionDomainError,
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
    super(`Safe form correlation failed: ${code}`);
    this.name = "ApplicationFormCorrelationError";
    this.code = code;
  }
}

export type CorrelatedApplicationFormFieldReference = Readonly<{
  fieldFingerprint: string;
  sourceOrdinal: SourceFieldOrdinal;
  handle: ElementHandle;
}>;

export type CorrelatedApplicationFormChoiceReference = Readonly<{
  sourceOrdinal: SourceChoiceOrdinal;
  handle: ElementHandle;
}>;

export type CorrelatedSafeApplicationFormExtraction = Readonly<{
  formFingerprint: string;
  fieldCount: number;
  requiredFieldCount: number;
  inspectionReport: ApplicationFormInspectionReport;
  normalizedSnapshot: NormalizedApplicationFormSnapshot;
  fields: ReadonlyMap<string, CorrelatedApplicationFormFieldReference>;
  choices: ReadonlyMap<
    string,
    ReadonlyMap<string, CorrelatedApplicationFormChoiceReference>
  >;
  dispose(): Promise<void>;
}>;

type RawField =
  ApplicationFormInspectionReport["forms"][number]["sections"][number]["fields"][number];

type ValidatedSourceField = Readonly<{
  reference: SafeDomFieldReference;
  rawField: RawField;
  formTitle: string | null;
  sectionHeading: string | null;
}>;

function correlationInvalid(): ApplicationFormCorrelationError {
  return new ApplicationFormCorrelationError("FORM_CORRELATION_INVALID");
}

function isSourceIndex(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function fieldOrdinalKey(ordinal: SourceFieldOrdinal): string {
  return `${ordinal.form}/${ordinal.section}/${ordinal.field}`;
}

function choiceOrdinalKey(ordinal: SourceChoiceOrdinal): string {
  return `${ordinal.form}/${ordinal.section}/${ordinal.field}/${ordinal.choice}`;
}

function validateSourceGraph(
  extraction: SafeApplicationFormExtraction
): ValidatedSourceField[] {
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
  const validated: ValidatedSourceField[] = [];

  for (const reference of extraction.fields) {
    const ordinal = reference.sourceOrdinal;
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

    if (reference.choices.length !== rawField.choices.length) {
      throw correlationInvalid();
    }
    const claimedChoiceIndexes = new Set<number>();
    for (const choiceReference of reference.choices) {
      const choiceOrdinal = choiceReference.sourceOrdinal;
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
    if (claimedChoiceIndexes.size !== rawField.choices.length) {
      throw correlationInvalid();
    }

    validated.push({
      reference,
      rawField,
      formTitle: form.title,
      sectionHeading: section.heading
    });
  }

  if (claimedFieldOrdinals.size !== expectedFieldOrdinals.size) {
    throw correlationInvalid();
  }
  for (const expected of expectedFieldOrdinals) {
    if (!claimedFieldOrdinals.has(expected)) throw correlationInvalid();
  }
  return validated;
}

function oneFieldReport(
  schemaVersion: ApplicationFormInspectionReport["schemaVersion"],
  source: ValidatedSourceField,
  rawField: RawField = source.rawField
): ApplicationFormInspectionReport {
  return {
    schemaVersion,
    forms: [{
      title: source.formTitle,
      sections: [{
        heading: source.sectionHeading,
        fields: [rawField]
      }]
    }]
  };
}

function onlyNormalizedField(
  built: ReturnType<typeof buildNormalizedApplicationFormInspection>
): NormalizedApplicationFormField {
  if (
    built.fieldCount !== 1 ||
    built.snapshot.forms.length !== 1 ||
    built.snapshot.forms[0].sections.length !== 1 ||
    built.snapshot.forms[0].sections[0].fields.length !== 1
  ) {
    throw correlationInvalid();
  }
  return built.snapshot.forms[0].sections[0].fields[0];
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

export async function correlateSafeApplicationFormExtraction(
  input: Readonly<{
    extraction: SafeApplicationFormExtraction;
    authoritativeApplyHost: string;
  }>
): Promise<CorrelatedSafeApplicationFormExtraction> {
  const extraction = input.extraction;
  try {
    const validatedSources = validateSourceGraph(extraction);
    const rawFieldCount = validatedSources.length;
    const full = buildNormalizedApplicationFormInspection({
      authoritativeApplyHost: input.authoritativeApplyHost,
      report: extraction.report
    });
    if (full.fieldCount !== rawFieldCount) throw correlationInvalid();

    const completeFields = new Map<string, NormalizedApplicationFormField>();
    for (const form of full.snapshot.forms) {
      for (const section of form.sections) {
        for (const field of section.fields) {
          if (completeFields.has(field.normalizedFieldKey)) throw correlationInvalid();
          completeFields.set(field.normalizedFieldKey, field);
        }
      }
    }
    if (completeFields.size !== full.fieldCount) throw correlationInvalid();

    const fields = new Map<string, CorrelatedApplicationFormFieldReference>();
    const choices = new Map<
      string,
      ReadonlyMap<string, CorrelatedApplicationFormChoiceReference>
    >();
    const claimedFieldKeys = new Set<string>();

    for (const source of validatedSources) {
      const fieldBuild = buildNormalizedApplicationFormInspection({
        authoritativeApplyHost: input.authoritativeApplyHost,
        report: oneFieldReport(extraction.report.schemaVersion, source)
      });
      const subField = onlyNormalizedField(fieldBuild);
      const fullField = completeFields.get(subField.normalizedFieldKey);
      if (
        !fullField ||
        claimedFieldKeys.has(subField.normalizedFieldKey) ||
        subField.fieldFingerprint !== fullField.fieldFingerprint ||
        canonicalJson(subField) !== canonicalJson(fullField)
      ) {
        throw correlationInvalid();
      }
      claimedFieldKeys.add(fullField.normalizedFieldKey);
      fields.set(fullField.normalizedFieldKey, {
        fieldFingerprint: fullField.fieldFingerprint,
        sourceOrdinal: source.reference.sourceOrdinal,
        handle: source.reference.handle
      });

      if (fullField.choices.length === 0) continue;
      if (source.rawField.choices.length !== fullField.choices.length) {
        throw correlationInvalid();
      }

      const fullChoices = new Map(fullField.choices.map((choice) => [choice.key, choice]));
      if (fullChoices.size !== fullField.choices.length) throw correlationInvalid();
      const claimedChoiceKeys = new Set<string>();
      const fieldChoices = new Map<string, CorrelatedApplicationFormChoiceReference>();

      for (const sourceChoice of source.reference.choices) {
        const rawChoice = source.rawField.choices[sourceChoice.sourceOrdinal.choice];
        if (!rawChoice) throw correlationInvalid();
        const choiceBuild = buildNormalizedApplicationFormInspection({
          authoritativeApplyHost: input.authoritativeApplyHost,
          report: oneFieldReport(extraction.report.schemaVersion, source, {
            ...source.rawField,
            choices: [rawChoice]
          })
        });
        const choiceSubField = onlyNormalizedField(choiceBuild);
        if (
          choiceSubField.normalizedFieldKey !== fullField.normalizedFieldKey ||
          choiceSubField.choices.length !== 1
        ) {
          throw correlationInvalid();
        }
        const oneChoice = choiceSubField.choices[0];
        const fullChoice = fullChoices.get(oneChoice.key);
        if (
          !fullChoice ||
          claimedChoiceKeys.has(oneChoice.key) ||
          canonicalJson(oneChoice) !== canonicalJson(fullChoice)
        ) {
          throw correlationInvalid();
        }
        claimedChoiceKeys.add(oneChoice.key);
        fieldChoices.set(oneChoice.key, {
          sourceOrdinal: sourceChoice.sourceOrdinal,
          handle: sourceChoice.handle
        });
      }

      if (
        claimedChoiceKeys.size !== fullField.choices.length ||
        fieldChoices.size !== source.rawField.choices.length
      ) {
        throw correlationInvalid();
      }
      for (const fullChoice of fullField.choices) {
        if (!claimedChoiceKeys.has(fullChoice.key)) throw correlationInvalid();
      }
      if (fieldChoices.size > 0) choices.set(fullField.normalizedFieldKey, fieldChoices);
    }

    if (
      claimedFieldKeys.size !== full.fieldCount ||
      fields.size !== full.fieldCount ||
      fields.size !== rawFieldCount
    ) {
      throw correlationInvalid();
    }
    for (const normalizedFieldKey of completeFields.keys()) {
      if (!claimedFieldKeys.has(normalizedFieldKey)) throw correlationInvalid();
    }

    let disposePromise: Promise<void> | null = null;
    return {
      formFingerprint: full.formFingerprint,
      fieldCount: full.fieldCount,
      requiredFieldCount: full.requiredFieldCount,
      inspectionReport: extraction.report,
      normalizedSnapshot: full.snapshot,
      fields,
      choices,
      dispose() {
        disposePromise ??= Promise.resolve().then(() => extraction.dispose());
        return disposePromise;
      }
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
