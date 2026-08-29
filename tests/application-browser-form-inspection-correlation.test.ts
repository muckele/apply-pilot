import assert from "node:assert/strict";
import { test } from "node:test";

import type { ElementHandle } from "playwright";

import {
  ApplicationFormCorrelationError,
  correlateSafeApplicationFormExtraction,
  type CorrelatedApplicationFormChoiceReference
} from "@/lib/application-browser/form-inspection-correlation";
import type {
  SafeApplicationFormExtraction,
  SafeDomFieldReference,
  SourceChoiceOrdinal,
  SourceFieldOrdinal
} from "@/lib/application-browser/form-inspection-dom";
import {
  applicationFormInspectionReportSchema,
  buildNormalizedApplicationFormInspection,
  canonicalJson,
  FormInspectionDomainError,
  FORM_INSPECTION_SCHEMA_VERSION,
  type ApplicationFormInspectionReport,
  type NormalizedApplicationFormField
} from "@/lib/application-runs/form-inspection";

const AUTHORITATIVE_APPLY_HOST = "jobs.example.com";

type RawField =
  ApplicationFormInspectionReport["forms"][number]["sections"][number]["fields"][number];
type RawConstraints = RawField["constraints"];

const EMPTY_CONSTRAINTS: RawConstraints = {
  minLength: null,
  maxLength: null,
  min: null,
  max: null,
  step: null,
  acceptedFileTypes: [],
  multiple: false
};

function rawField(overrides: Partial<RawField> = {}): RawField {
  return {
    question: "Portfolio URL",
    helpText: null,
    fieldType: "URL",
    unsupportedReason: null,
    required: true,
    autocomplete: "url",
    constraints: { ...EMPTY_CONSTRAINTS },
    choices: [],
    ...overrides
  };
}

function singleSectionReport(
  fields: readonly RawField[],
  input: Readonly<{ title?: string | null; heading?: string | null }> = {}
): ApplicationFormInspectionReport {
  return applicationFormInspectionReportSchema.parse({
    schemaVersion: FORM_INSPECTION_SCHEMA_VERSION,
    forms: [{
      title: input.title === undefined ? "Application" : input.title,
      sections: [{
        heading: input.heading === undefined ? "Candidate details" : input.heading,
        fields
      }]
    }]
  });
}

function fieldOrdinalKey(ordinal: SourceFieldOrdinal): string {
  return `${ordinal.form}/${ordinal.section}/${ordinal.field}`;
}

function choiceOrdinalKey(ordinal: SourceChoiceOrdinal): string {
  return `${ordinal.form}/${ordinal.section}/${ordinal.field}/${ordinal.choice}`;
}

function opaqueHandle(): ElementHandle {
  return Object.freeze({}) as unknown as ElementHandle;
}

type SyntheticExtraction = Readonly<{
  extraction: SafeApplicationFormExtraction;
  fieldHandles: ReadonlyMap<string, ElementHandle>;
  choiceHandles: ReadonlyMap<string, ElementHandle>;
  disposeCalls(): number;
}>;

function syntheticExtraction(
  report: ApplicationFormInspectionReport,
  input: Readonly<{
    transformReferences?: (references: SafeDomFieldReference[]) => readonly SafeDomFieldReference[];
    disposalError?: Error;
    synchronousDisposalError?: Error;
    handleFactory?: () => ElementHandle;
  }> = {}
): SyntheticExtraction {
  const fieldHandles = new Map<string, ElementHandle>();
  const choiceHandles = new Map<string, ElementHandle>();
  const references: SafeDomFieldReference[] = [];
  const makeHandle = input.handleFactory ?? opaqueHandle;

  for (const [formIndex, form] of report.forms.entries()) {
    for (const [sectionIndex, section] of form.sections.entries()) {
      for (const [fieldIndex, field] of section.fields.entries()) {
        const sourceOrdinal = { form: formIndex, section: sectionIndex, field: fieldIndex };
        const handle = makeHandle();
        fieldHandles.set(fieldOrdinalKey(sourceOrdinal), handle);
        const choices = field.choices.map((_choice, choiceIndex) => {
          const choiceOrdinal = { ...sourceOrdinal, choice: choiceIndex };
          const choiceHandle = makeHandle();
          choiceHandles.set(choiceOrdinalKey(choiceOrdinal), choiceHandle);
          return { sourceOrdinal: choiceOrdinal, handle: choiceHandle };
        });
        references.push({ sourceOrdinal, handle, choices });
      }
    }
  }

  const transformed = input.transformReferences?.(references) ?? references;
  let disposeCallCount = 0;
  const extraction: SafeApplicationFormExtraction = {
    report,
    fields: transformed,
    dispose() {
      disposeCallCount += 1;
      if (input.synchronousDisposalError) throw input.synchronousDisposalError;
      return input.disposalError ? Promise.reject(input.disposalError) : Promise.resolve();
    }
  };
  return {
    extraction,
    fieldHandles,
    choiceHandles,
    disposeCalls: () => disposeCallCount
  };
}

function normalizedFields(
  snapshot: ReturnType<typeof buildNormalizedApplicationFormInspection>["snapshot"]
): NormalizedApplicationFormField[] {
  return snapshot.forms.flatMap((form) =>
    form.sections.flatMap((section) => section.fields)
  );
}

async function assertCorrelationInvalid(
  synthetic: SyntheticExtraction,
  secrets: readonly string[] = []
): Promise<void> {
  await assert.rejects(
    correlateSafeApplicationFormExtraction({
      extraction: synthetic.extraction,
      authoritativeApplyHost: AUTHORITATIVE_APPLY_HOST
    }),
    (error) => {
      assert.ok(error instanceof ApplicationFormCorrelationError);
      assert.equal(error.name, "ApplicationFormCorrelationError");
      assert.equal(error.code, "FORM_CORRELATION_INVALID");
      assert.equal(error.message, "Safe form correlation failed: FORM_CORRELATION_INVALID");
      for (const secret of secrets) assert.equal(error.message.includes(secret), false);
      return true;
    }
  );
  assert.equal(synthetic.disposeCalls(), 1);
}

test("correlates one safe field through the complete canonical authority and owns disposal", async () => {
  const report = singleSectionReport([rawField()]);
  const expected = buildNormalizedApplicationFormInspection({
    authoritativeApplyHost: AUTHORITATIVE_APPLY_HOST,
    report
  });
  const synthetic = syntheticExtraction(report);

  const result = await correlateSafeApplicationFormExtraction({
    extraction: synthetic.extraction,
    authoritativeApplyHost: AUTHORITATIVE_APPLY_HOST
  });

  assert.equal(result.formFingerprint, expected.formFingerprint);
  assert.equal(result.fieldCount, 1);
  assert.equal(result.requiredFieldCount, 1);
  assert.deepEqual(result.inspectionReport, report);
  assert.deepEqual(result.normalizedSnapshot, expected.snapshot);
  const normalized = normalizedFields(expected.snapshot)[0];
  assert.deepEqual(result.fields.get(normalized.normalizedFieldKey), {
    fieldFingerprint: normalized.fieldFingerprint,
    sourceOrdinal: { form: 0, section: 0, field: 0 },
    handle: synthetic.fieldHandles.get("0/0/0")
  });
  assert.equal(result.choices.size, 0);
  assert.equal(synthetic.disposeCalls(), 0);

  await Promise.all([result.dispose(), result.dispose(), result.dispose()]);
  assert.equal(synthetic.disposeCalls(), 1);
});

test("correlates reordered references across multiple null and classified contexts by canonical key", async () => {
  const report = applicationFormInspectionReportSchema.parse({
    schemaVersion: FORM_INSPECTION_SCHEMA_VERSION,
    forms: [
      {
        title: null,
        sections: [
          {
            heading: null,
            fields: [
              rawField({ question: null, fieldType: "TEXT", autocomplete: null, required: false }),
              rawField({ question: "LinkedIn URL", fieldType: "URL", autocomplete: "url" })
            ]
          },
          {
            heading: "Optional policy",
            fields: [
              rawField({
                question: "Voluntary disability status",
                fieldType: "TEXT",
                autocomplete: null,
                required: false
              })
            ]
          }
        ]
      },
      {
        title: "Experience",
        sections: [
          {
            heading: null,
            fields: [
              rawField({
                question: "Current employer",
                fieldType: "TEXT",
                autocomplete: null,
                required: false
              }),
              rawField({
                question: "Unsupported editor",
                fieldType: "UNSUPPORTED",
                unsupportedReason: "RICH_TEXT",
                autocomplete: null,
                required: false
              })
            ]
          }
        ]
      }
    ]
  });
  const expected = buildNormalizedApplicationFormInspection({
    authoritativeApplyHost: AUTHORITATIVE_APPLY_HOST,
    report
  });
  const synthetic = syntheticExtraction(report, {
    transformReferences: (references) => [...references].reverse()
  });

  const result = await correlateSafeApplicationFormExtraction({
    extraction: synthetic.extraction,
    authoritativeApplyHost: AUTHORITATIVE_APPLY_HOST
  });

  assert.equal(result.fields.size, 5);
  const fields = normalizedFields(expected.snapshot);
  assert.deepEqual(
    new Set(fields.map((field) => field.permittedDisposition)),
    new Set(["PROPOSABLE", "MANUAL_ONLY", "EXCLUDED", "UNSUPPORTED"])
  );
  assert.ok(fields.some((field) => field.semanticFieldKey === "professional.linkedin"));
  for (const normalized of fields) {
    const correlated = result.fields.get(normalized.normalizedFieldKey);
    assert.ok(correlated);
    assert.equal(correlated.fieldFingerprint, normalized.fieldFingerprint);
    assert.equal(
      correlated.handle,
      synthetic.fieldHandles.get(fieldOrdinalKey(correlated.sourceOrdinal))
    );
  }
  assert.deepEqual(result.normalizedSnapshot, expected.snapshot);
  await result.dispose();
});

test("keeps every source handle aligned while canonical forms, sections, fields, and choices reorder", async () => {
  const report = applicationFormInspectionReportSchema.parse({
    schemaVersion: FORM_INSPECTION_SCHEMA_VERSION,
    forms: [
      {
        title: "Form Zeta",
        sections: [
          {
            heading: "Section Alpha",
            fields: [
              rawField({
                question: "Current employer",
                fieldType: "TEXT",
                autocomplete: null,
                required: false
              })
            ]
          },
          {
            heading: "Section Zeta",
            fields: [
              rawField({
                question: "Preferred office",
                fieldType: "SELECT_ONE",
                autocomplete: null,
                required: false,
                choices: [
                  { label: "Zulu office", disabled: false },
                  { label: "Alpha office", disabled: true },
                  { label: "Middle office", disabled: false }
                ]
              }),
              rawField({
                question: "Portfolio website",
                fieldType: "URL",
                autocomplete: null,
                required: false
              })
            ]
          }
        ]
      },
      {
        title: "Form Alpha",
        sections: [
          {
            heading: "Section Beta",
            fields: [
              rawField({
                question: "LinkedIn profile",
                fieldType: "URL",
                autocomplete: null,
                required: false
              }),
              rawField({
                question: "Additional comments",
                fieldType: "TEXT",
                autocomplete: null,
                required: false
              })
            ]
          }
        ]
      }
    ]
  });
  const authoritative = buildNormalizedApplicationFormInspection({
    authoritativeApplyHost: AUTHORITATIVE_APPLY_HOST,
    report
  });
  const synthetic = syntheticExtraction(report);

  const result = await correlateSafeApplicationFormExtraction({
    extraction: synthetic.extraction,
    authoritativeApplyHost: AUTHORITATIVE_APPLY_HOST
  });

  const rawFormTitles = report.forms.map((form) => form.title);
  const canonicalFormTitles = authoritative.snapshot.forms.map((form) => form.title);
  const canonicalFormKeys = authoritative.snapshot.forms.map((form) => form.formKey);
  assert.notDeepEqual(canonicalFormTitles, rawFormTitles);
  assert.deepEqual(canonicalFormKeys, [...canonicalFormKeys].sort());

  const rawMultiSectionForm = report.forms[0];
  const canonicalMultiSectionForm = authoritative.snapshot.forms.find(
    (form) => form.title === rawMultiSectionForm.title
  );
  assert.ok(canonicalMultiSectionForm);
  const rawSectionHeadings = rawMultiSectionForm.sections.map((section) => section.heading);
  const canonicalSectionHeadings = canonicalMultiSectionForm.sections.map(
    (section) => section.heading
  );
  const canonicalSectionKeys = canonicalMultiSectionForm.sections.map(
    (section) => section.sectionKey
  );
  assert.notDeepEqual(canonicalSectionHeadings, rawSectionHeadings);
  assert.deepEqual(canonicalSectionKeys, [...canonicalSectionKeys].sort());

  const rawMultiFieldSection = rawMultiSectionForm.sections.find(
    (section) => section.heading === "Section Zeta"
  );
  const canonicalMultiFieldSection = canonicalMultiSectionForm.sections.find(
    (section) => section.heading === rawMultiFieldSection?.heading
  );
  assert.ok(rawMultiFieldSection);
  assert.ok(canonicalMultiFieldSection);
  const rawFieldQuestions = rawMultiFieldSection.fields.map((field) => field.question);
  const canonicalFieldQuestions = canonicalMultiFieldSection.fields.map(
    (field) => field.question
  );
  const canonicalFieldKeys = canonicalMultiFieldSection.fields.map(
    (field) => field.normalizedFieldKey
  );
  assert.notDeepEqual(canonicalFieldQuestions, rawFieldQuestions);
  assert.deepEqual(canonicalFieldKeys, [...canonicalFieldKeys].sort());

  const rawChoiceField = rawMultiFieldSection.fields.find(
    (field) => field.question === "Preferred office"
  );
  const canonicalChoiceField = canonicalMultiFieldSection.fields.find(
    (field) => field.question === rawChoiceField?.question
  );
  assert.ok(rawChoiceField);
  assert.ok(canonicalChoiceField);
  const rawChoiceLabels = rawChoiceField.choices.map((choice) => choice.label);
  const canonicalChoiceLabels = canonicalChoiceField.choices.map((choice) => choice.label);
  const canonicalChoiceKeys = canonicalChoiceField.choices.map((choice) => choice.key);
  assert.notDeepEqual(canonicalChoiceLabels, rawChoiceLabels);
  assert.deepEqual(canonicalChoiceKeys, [...canonicalChoiceKeys].sort());

  const authoritativeFields = normalizedFields(authoritative.snapshot);
  const rawFieldCount = report.forms.reduce(
    (formTotal, form) => formTotal + form.sections.reduce(
      (sectionTotal, section) => sectionTotal + section.fields.length,
      0
    ),
    0
  );
  assert.equal(result.fields.size, rawFieldCount);
  assert.equal(authoritativeFields.length, rawFieldCount);

  let choiceBearingFieldCount = 0;
  for (const [formIndex, form] of report.forms.entries()) {
    for (const [sectionIndex, section] of form.sections.entries()) {
      for (const [fieldIndex, field] of section.fields.entries()) {
        const sourceOrdinal = { form: formIndex, section: sectionIndex, field: fieldIndex };
        const normalized = authoritativeFields.find(
          (candidate) => candidate.question === field.question
        );
        const fieldHandle = synthetic.fieldHandles.get(fieldOrdinalKey(sourceOrdinal));
        assert.ok(normalized);
        assert.ok(fieldHandle);
        assert.deepEqual(result.fields.get(normalized.normalizedFieldKey), {
          fieldFingerprint: normalized.fieldFingerprint,
          sourceOrdinal,
          handle: fieldHandle
        });

        if (field.choices.length === 0) {
          assert.equal(result.choices.has(normalized.normalizedFieldKey), false);
          continue;
        }

        choiceBearingFieldCount += 1;
        const correlatedChoices = result.choices.get(normalized.normalizedFieldKey);
        assert.ok(correlatedChoices);
        assert.equal(correlatedChoices.size, field.choices.length);
        for (const canonicalChoice of normalized.choices) {
          const choiceIndex = field.choices.findIndex(
            (choice) =>
              choice.label === canonicalChoice.label &&
              choice.disabled === canonicalChoice.disabled
          );
          assert.notEqual(choiceIndex, -1);
          const sourceChoiceOrdinal = { ...sourceOrdinal, choice: choiceIndex };
          const choiceHandle = synthetic.choiceHandles.get(
            choiceOrdinalKey(sourceChoiceOrdinal)
          );
          assert.ok(choiceHandle);
          assert.deepEqual(correlatedChoices.get(canonicalChoice.key), {
            sourceOrdinal: sourceChoiceOrdinal,
            handle: choiceHandle
          });
        }
      }
    }
  }
  assert.equal(result.choices.size, choiceBearingFieldCount);
  await result.dispose();
});

test("correlates unique choices by canonical choice key without relying on source order", async () => {
  const report = singleSectionReport([
    rawField({
      question: "Preferred office",
      fieldType: "SELECT_ONE",
      autocomplete: null,
      required: false,
      choices: [
        { label: "Zulu office", disabled: false },
        { label: "Alpha office", disabled: true },
        { label: "Middle office", disabled: false }
      ]
    })
  ]);
  const synthetic = syntheticExtraction(report, {
    transformReferences: ([reference]) => [{
      ...reference,
      choices: [...reference.choices].reverse()
    }]
  });
  const expected = buildNormalizedApplicationFormInspection({
    authoritativeApplyHost: AUTHORITATIVE_APPLY_HOST,
    report
  });
  const expectedField = normalizedFields(expected.snapshot)[0];

  const result = await correlateSafeApplicationFormExtraction({
    extraction: synthetic.extraction,
    authoritativeApplyHost: AUTHORITATIVE_APPLY_HOST
  });

  const correlatedChoices = result.choices.get(expectedField.normalizedFieldKey);
  assert.ok(correlatedChoices);
  assert.equal(correlatedChoices.size, 3);
  for (const canonicalChoice of expectedField.choices) {
    const correlated: CorrelatedApplicationFormChoiceReference | undefined =
      correlatedChoices.get(canonicalChoice.key);
    assert.ok(correlated);
    const rawChoice: RawField["choices"][number] =
      report.forms[0].sections[0].fields[0].choices[correlated.sourceOrdinal.choice];
    assert.equal(canonicalChoice.label, rawChoice.label);
    assert.equal(canonicalChoice.disabled, rawChoice.disabled);
    assert.equal(
      correlated.handle,
      synthetic.choiceHandles.get(choiceOrdinalKey(correlated.sourceOrdinal))
    );
  }
  await result.dispose();
});

test("keeps an ambiguous-choice field but exposes no invented canonical choice identities", async () => {
  const report = singleSectionReport([
    rawField({
      question: "Choose a location",
      fieldType: "SELECT_ONE",
      autocomplete: null,
      choices: [
        { label: "Café", disabled: false },
        { label: "  CAFÉ ", disabled: true }
      ]
    })
  ]);
  const synthetic = syntheticExtraction(report);

  const result = await correlateSafeApplicationFormExtraction({
    extraction: synthetic.extraction,
    authoritativeApplyHost: AUTHORITATIVE_APPLY_HOST
  });

  const normalized = normalizedFields(result.normalizedSnapshot)[0];
  assert.equal(normalized.fieldType, "UNSUPPORTED");
  assert.equal(normalized.unsupportedReason, "AMBIGUOUS_CHOICES");
  assert.deepEqual(normalized.choices, []);
  assert.equal(result.fields.has(normalized.normalizedFieldKey), true);
  assert.equal(result.choices.has(normalized.normalizedFieldKey), false);
  await result.dispose();
  assert.equal(synthetic.disposeCalls(), 1);
});

test("correlates multiple-file upload normalization without a choice map", async () => {
  const report = singleSectionReport([
    rawField({
      question: "Upload résumé",
      fieldType: "FILE_UPLOAD",
      autocomplete: null,
      constraints: {
        ...EMPTY_CONSTRAINTS,
        acceptedFileTypes: ["PDF"],
        multiple: true
      }
    })
  ]);
  const synthetic = syntheticExtraction(report);

  const result = await correlateSafeApplicationFormExtraction({
    extraction: synthetic.extraction,
    authoritativeApplyHost: AUTHORITATIVE_APPLY_HOST
  });

  const normalized = normalizedFields(result.normalizedSnapshot)[0];
  assert.equal(normalized.fieldType, "UNSUPPORTED");
  assert.equal(normalized.unsupportedReason, "MULTIPLE_FILE_UPLOAD");
  assert.equal(result.fields.get(normalized.normalizedFieldKey)?.handle, synthetic.fieldHandles.get("0/0/0"));
  assert.equal(result.choices.has(normalized.normalizedFieldKey), false);
  await result.dispose();
});

test("preserves canonical duplicate-field ambiguity and disposes transferred ownership", async () => {
  const duplicate = rawField({ question: "Portfolio URL" });
  const report = singleSectionReport([duplicate, duplicate]);
  const synthetic = syntheticExtraction(report);

  await assert.rejects(
    correlateSafeApplicationFormExtraction({
      extraction: synthetic.extraction,
      authoritativeApplyHost: AUTHORITATIVE_APPLY_HOST
    }),
    (error) => {
      assert.ok(error instanceof FormInspectionDomainError);
      assert.equal(error.code, "AMBIGUOUS_DUPLICATE_FIELD");
      return true;
    }
  );
  assert.equal(synthetic.disposeCalls(), 1);
});

test("validates source references before preserving canonical duplicate-field ambiguity", async () => {
  const duplicate = rawField({ question: "Portfolio URL" });
  const report = singleSectionReport([duplicate, duplicate]);
  const synthetic = syntheticExtraction(report, {
    transformReferences: (references) => references.slice(0, 1)
  });

  await assertCorrelationInvalid(synthetic);
});

test("rejects every malformed field-reference shape with one bounded disposal", async (context) => {
  const oneFieldReport = singleSectionReport([rawField()]);
  const twoFieldReport = singleSectionReport([
    rawField({ question: "Portfolio URL" }),
    rawField({ question: "LinkedIn URL" })
  ]);
  const cases: ReadonlyArray<Readonly<{
    name: string;
    report: ApplicationFormInspectionReport;
    transform: (references: SafeDomFieldReference[]) => readonly SafeDomFieldReference[];
  }>> = [
    {
      name: "missing field reference",
      report: oneFieldReport,
      transform: () => []
    },
    {
      name: "extra field reference",
      report: oneFieldReport,
      transform: (references) => [...references, references[0]]
    },
    {
      name: "duplicate field ordinal",
      report: twoFieldReport,
      transform: (references) => [
        references[0],
        { ...references[1], sourceOrdinal: references[0].sourceOrdinal }
      ]
    },
    {
      name: "form index out of bounds",
      report: oneFieldReport,
      transform: ([reference]) => [{ ...reference, sourceOrdinal: { form: 1, section: 0, field: 0 } }]
    },
    {
      name: "section index out of bounds",
      report: oneFieldReport,
      transform: ([reference]) => [{ ...reference, sourceOrdinal: { form: 0, section: 1, field: 0 } }]
    },
    {
      name: "field index out of bounds",
      report: oneFieldReport,
      transform: ([reference]) => [{ ...reference, sourceOrdinal: { form: 0, section: 0, field: 1 } }]
    },
    {
      name: "non-integer field ordinal",
      report: oneFieldReport,
      transform: ([reference]) => [{ ...reference, sourceOrdinal: { form: 0, section: 0, field: 0.5 } }]
    },
    {
      name: "negative field ordinal",
      report: oneFieldReport,
      transform: ([reference]) => [{ ...reference, sourceOrdinal: { form: 0, section: 0, field: -1 } }]
    }
  ];

  for (const entry of cases) {
    await context.test(entry.name, async () => {
      const synthetic = syntheticExtraction(entry.report, { transformReferences: entry.transform });
      await assertCorrelationInvalid(synthetic);
    });
  }
});

test("rejects every malformed choice-reference shape with one bounded disposal", async (context) => {
  const report = singleSectionReport([
    rawField({
      question: "Preferred office",
      fieldType: "SELECT_ONE",
      autocomplete: null,
      choices: [
        { label: "Alpha", disabled: false },
        { label: "Beta", disabled: true }
      ]
    })
  ]);
  const mutateChoices = (
    transform: (reference: SafeDomFieldReference) => SafeDomFieldReference
  ) => (references: SafeDomFieldReference[]) => [transform(references[0])];
  const cases: ReadonlyArray<Readonly<{
    name: string;
    transform: (references: SafeDomFieldReference[]) => readonly SafeDomFieldReference[];
  }>> = [
    {
      name: "raw and reference choice counts differ",
      transform: mutateChoices((reference) => ({ ...reference, choices: reference.choices.slice(0, 1) }))
    },
    {
      name: "choice parent form differs",
      transform: mutateChoices((reference) => ({
        ...reference,
        choices: [{
          ...reference.choices[0],
          sourceOrdinal: { ...reference.choices[0].sourceOrdinal, form: 1 }
        }, reference.choices[1]]
      }))
    },
    {
      name: "choice parent section differs",
      transform: mutateChoices((reference) => ({
        ...reference,
        choices: [{
          ...reference.choices[0],
          sourceOrdinal: { ...reference.choices[0].sourceOrdinal, section: 1 }
        }, reference.choices[1]]
      }))
    },
    {
      name: "choice parent field differs",
      transform: mutateChoices((reference) => ({
        ...reference,
        choices: [{
          ...reference.choices[0],
          sourceOrdinal: { ...reference.choices[0].sourceOrdinal, field: 1 }
        }, reference.choices[1]]
      }))
    },
    {
      name: "duplicate choice ordinal leaves another missing",
      transform: mutateChoices((reference) => ({
        ...reference,
        choices: [
          reference.choices[0],
          { ...reference.choices[1], sourceOrdinal: reference.choices[0].sourceOrdinal }
        ]
      }))
    },
    {
      name: "choice index is out of bounds",
      transform: mutateChoices((reference) => ({
        ...reference,
        choices: [{
          ...reference.choices[0],
          sourceOrdinal: { ...reference.choices[0].sourceOrdinal, choice: 2 }
        }, reference.choices[1]]
      }))
    },
    {
      name: "choice index is not an integer",
      transform: mutateChoices((reference) => ({
        ...reference,
        choices: [{
          ...reference.choices[0],
          sourceOrdinal: { ...reference.choices[0].sourceOrdinal, choice: 0.5 }
        }, reference.choices[1]]
      }))
    }
  ];

  for (const entry of cases) {
    await context.test(entry.name, async () => {
      const synthetic = syntheticExtraction(report, { transformReferences: entry.transform });
      await assertCorrelationInvalid(synthetic);
    });
  }
});

test("maps canonical failures to a fixed private error even when cleanup rejects", async () => {
  const secrets = [
    "SECRET_FORM_TITLE",
    "SECRET_SECTION_HEADING",
    "SECRET_QUESTION",
    "SECRET_CHOICE_LABEL",
    "https://private.example/SECRET_URL",
    "#SECRET_SELECTOR",
    "SECRET_HANDLE_RENDERING"
  ] as const;
  const report = applicationFormInspectionReportSchema.parse({
    schemaVersion: FORM_INSPECTION_SCHEMA_VERSION,
    forms: [{
      title: secrets[0],
      sections: [{
        heading: secrets[1],
        fields: [
          rawField({
            question: `${secrets[2]} ${secrets[4]} ${secrets[5]}`,
            fieldType: "NUMBER",
            autocomplete: null,
            constraints: { ...EMPTY_CONSTRAINTS, min: "2", max: "1" }
          }),
          rawField({
            question: "Choose one",
            fieldType: "SELECT_ONE",
            autocomplete: null,
            choices: [{ label: secrets[3], disabled: false }]
          })
        ]
      }]
    }]
  });
  const synthetic = syntheticExtraction(report, {
    disposalError: new Error("SECRET_DISPOSAL_FAILURE"),
    handleFactory: () => Object.freeze({
      toString() {
        return secrets[6];
      }
    }) as unknown as ElementHandle
  });

  await assertCorrelationInvalid(synthetic, [...secrets, "SECRET_DISPOSAL_FAILURE"]);
});

test("a synchronous cleanup failure cannot replace a bounded correlation error", async () => {
  const report = singleSectionReport([rawField()]);
  const synthetic = syntheticExtraction(report, {
    transformReferences: () => [],
    synchronousDisposalError: new Error("SECRET_SYNCHRONOUS_DISPOSAL_FAILURE")
  });

  await assertCorrelationInvalid(synthetic, ["SECRET_SYNCHRONOUS_DISPOSAL_FAILURE"]);
});

test("uses exact canonical field and choice objects rather than one-choice fingerprints", async () => {
  const report = singleSectionReport([
    rawField({
      question: "Preferred schedule",
      fieldType: "CHECKBOX_GROUP",
      autocomplete: null,
      choices: [
        { label: "Weekdays", disabled: false },
        { label: "Weekends", disabled: false }
      ]
    })
  ]);
  const synthetic = syntheticExtraction(report);
  const full = buildNormalizedApplicationFormInspection({
    authoritativeApplyHost: AUTHORITATIVE_APPLY_HOST,
    report
  });
  const fullField = normalizedFields(full.snapshot)[0];

  const result = await correlateSafeApplicationFormExtraction({
    extraction: synthetic.extraction,
    authoritativeApplyHost: AUTHORITATIVE_APPLY_HOST
  });

  const resultField = normalizedFields(result.normalizedSnapshot)[0];
  assert.equal(canonicalJson(resultField), canonicalJson(fullField));
  assert.equal(resultField.fieldFingerprint, fullField.fieldFingerprint);
  assert.equal(result.choices.get(fullField.normalizedFieldKey)?.size, fullField.choices.length);
  await result.dispose();
});
