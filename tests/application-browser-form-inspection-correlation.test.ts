import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ApplicationFormCorrelationError,
  correlateProtectedApplicationFormExtraction,
  type CorrelatedProtectedApplicationFormExtraction
} from "@/lib/application-browser/form-inspection-correlation";
import type {
  OpaqueExtractionCandidate,
  ProtectedApplicationFormExtraction,
  ProtectedFieldSlot,
  ProtectedWriterTargetBinding
} from "@/lib/application-browser/protected-browser-session";
import {
  applicationFormInspectionReportSchema,
  buildNormalizedApplicationFormInspection,
  canonicalJson,
  FORM_INSPECTION_SCHEMA_VERSION,
  type ApplicationFormInspectionReport,
  type NormalizedApplicationFormField
} from "@/lib/application-runs/form-inspection";

const AUTHORITATIVE_APPLY_HOST = "jobs.example.com";

type CorrelatedOpaqueMapKey = Extract<
  keyof CorrelatedProtectedApplicationFormExtraction,
  "fields" | "choices"
>;
const CORRELATED_RESULT_HAS_NO_OPAQUE_MAP_KEYS:
  [CorrelatedOpaqueMapKey] extends [never] ? true : false = true;

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

function opaqueIdentity<T extends object>(): T {
  return Object.freeze(Object.create(null)) as T;
}

type SyntheticExtraction = Readonly<{
  extraction: ProtectedApplicationFormExtraction;
  candidate: OpaqueExtractionCandidate;
  disposeCalls(): number;
  sealCalls(): number;
  sealedBindings(): readonly ProtectedWriterTargetBinding[] | null;
}>;

function syntheticExtraction(
  report: ApplicationFormInspectionReport,
  input: Readonly<{
    transformReferences?: (references: ProtectedFieldSlot[]) => readonly ProtectedFieldSlot[];
    disposalError?: Error;
    synchronousDisposalError?: Error;
    sealingError?: Error;
    referenceFactory?: () => object;
  }> = {}
): SyntheticExtraction {
  const candidate = opaqueIdentity<OpaqueExtractionCandidate>();
  const references: ProtectedFieldSlot[] = [];
  const makeReference = input.referenceFactory ?? (() => opaqueIdentity<object>());

  for (const [formIndex, form] of report.forms.entries()) {
    for (const [sectionIndex, section] of form.sections.entries()) {
      for (const [fieldIndex, field] of section.fields.entries()) {
        const sourceOrdinal = { form: formIndex, section: sectionIndex, field: fieldIndex };
        const reference = makeReference() as ProtectedFieldSlot["reference"];
        const choices = field.choices.map((_choice, choiceIndex) => {
          const choiceOrdinal = { ...sourceOrdinal, choice: choiceIndex };
          const choiceReference = makeReference() as ProtectedFieldSlot["choices"][number]["reference"];
          return { sourceOrdinal: choiceOrdinal, reference: choiceReference };
        });
        references.push({ sourceOrdinal, reference, choices });
      }
    }
  }

  const transformed = input.transformReferences?.(references) ?? references;
  let disposeCallCount = 0;
  let sealCallCount = 0;
  let sealedBindings: readonly ProtectedWriterTargetBinding[] | null = null;
  const extraction: ProtectedApplicationFormExtraction = {
    candidate,
    report,
    fields: transformed,
    sealWriterTargets(bindings) {
      sealCallCount += 1;
      sealedBindings = bindings;
      return input.sealingError ? Promise.reject(input.sealingError) : Promise.resolve();
    },
    dispose() {
      disposeCallCount += 1;
      if (input.synchronousDisposalError) throw input.synchronousDisposalError;
      return input.disposalError ? Promise.reject(input.disposalError) : Promise.resolve();
    }
  };
  return {
    extraction,
    candidate,
    disposeCalls: () => disposeCallCount,
    sealCalls: () => sealCallCount,
    sealedBindings: () => sealedBindings
  };
}

function normalizedFields(
  snapshot: ReturnType<typeof buildNormalizedApplicationFormInspection>["snapshot"]
): NormalizedApplicationFormField[] {
  return snapshot.forms.flatMap((form) =>
    form.sections.flatMap((section) => section.fields)
  );
}

const EXPECTED_COMMIT_2B_CORRELATED_KEYS = [
  "ambiguousQuestionCount",
  "ambiguousRequiredCount",
  "candidate",
  "dispose",
  "fieldCount",
  "formFingerprint",
  "inspectionReport",
  "normalizedSnapshot",
  "requiredFieldCount",
  "uniqueFieldCount"
] as const;

function assertNoOpaqueReferenceAuthority(
  result: CorrelatedProtectedApplicationFormExtraction,
  suppliedReferences: readonly object[]
): void {
  const legacy = result as CorrelatedProtectedApplicationFormExtraction & Readonly<{
    fields?: ReadonlyMap<string, Readonly<{ reference: object }>>;
    choices?: ReadonlyMap<string, ReadonlyMap<string, Readonly<{ reference: object }>>>;
  }>;
  const retainedReferences = [
    ...[...(legacy.fields?.values() ?? [])].map((entry) => entry.reference),
    ...[...(legacy.choices?.values() ?? [])]
      .flatMap((choices) => [...choices.values()])
      .map((entry) => entry.reference)
  ];
  const evidence = {
    ownKeys: Object.keys(result).sort(),
    opaqueMapKeys: ["fields", "choices"].filter((key) => key in result),
    retainedSuppliedReferenceCount: retainedReferences.filter((reference) =>
      suppliedReferences.includes(reference)
    ).length
  };

  assert.equal(CORRELATED_RESULT_HAS_NO_OPAQUE_MAP_KEYS, true);
  assert.deepEqual(evidence, {
    ownKeys: [...EXPECTED_COMMIT_2B_CORRELATED_KEYS],
    opaqueMapKeys: [],
    retainedSuppliedReferenceCount: 0
  });
}

async function assertCorrelationInvalid(
  synthetic: SyntheticExtraction,
  secrets: readonly string[] = []
): Promise<void> {
  await assert.rejects(
    correlateProtectedApplicationFormExtraction({
      extraction: synthetic.extraction,
      authoritativeApplyHost: AUTHORITATIVE_APPLY_HOST
    }),
    (error) => {
      assert.ok(error instanceof ApplicationFormCorrelationError);
      assert.equal(error.name, "ApplicationFormCorrelationError");
      assert.equal(error.code, "FORM_CORRELATION_INVALID");
      assert.equal(error.message, "Protected form correlation failed: FORM_CORRELATION_INVALID");
      for (const secret of secrets) assert.equal(error.message.includes(secret), false);
      return true;
    }
  );
  assert.equal(synthetic.disposeCalls(), 1);
}

test("correlates one protected report through candidate-level authority and owns disposal", async () => {
  const report = singleSectionReport([rawField()]);
  const expected = buildNormalizedApplicationFormInspection({
    authoritativeApplyHost: AUTHORITATIVE_APPLY_HOST,
    report
  });
  const synthetic = syntheticExtraction(report);

  const result = await correlateProtectedApplicationFormExtraction({
    extraction: synthetic.extraction,
    authoritativeApplyHost: AUTHORITATIVE_APPLY_HOST
  });

  assert.equal(result.formFingerprint, expected.formFingerprint);
  assert.equal(result.candidate, synthetic.candidate);
  assert.equal(result.fieldCount, 1);
  assert.equal(result.requiredFieldCount, 1);
  assert.deepEqual(result.inspectionReport, report);
  assert.deepEqual(result.normalizedSnapshot, expected.snapshot);
  assert.equal(synthetic.sealCalls(), 1);
  const normalized = normalizedFields(expected.snapshot)[0];
  assert.deepEqual(synthetic.sealedBindings(), [{
    normalizedFieldKey: normalized.normalizedFieldKey,
    fieldFingerprint: normalized.fieldFingerprint,
    fieldType: "URL",
    sourceOrdinal: { form: 0, section: 0, field: 0 },
    choices: []
  }]);
  assertNoOpaqueReferenceAuthority(result, synthetic.extraction.fields.map((slot) => slot.reference));
  assert.equal(synthetic.disposeCalls(), 0);

  await Promise.all([result.dispose(), result.dispose(), result.dispose()]);
  assert.equal(synthetic.disposeCalls(), 1);
});

test("a failed writer-target seal is sanitized and disposes transferred candidate ownership", async () => {
  const synthetic = syntheticExtraction(singleSectionReport([rawField()]), {
    sealingError: new Error("PRIVATE SELECTOR AND EMPLOYER VALUE")
  });

  await assertCorrelationInvalid(synthetic, ["PRIVATE SELECTOR", "EMPLOYER VALUE"]);
  assert.equal(synthetic.sealCalls(), 1);
});

test("detaches candidate cleanup without later dereferencing the extraction slot container", async (context) => {
  for (const cleanupResult of ["resolves", "rejects"] as const) {
    await context.test(`cleanup ${cleanupResult}`, async () => {
      const report = singleSectionReport([rawField()]);
      const synthetic = syntheticExtraction(report);
      const cleanupError = new Error("private candidate cleanup failure");
      type AccessPhase = "correlation" | "after-correlation" | "negative-control";
      let phase: AccessPhase = "correlation";
      const operations: Array<Readonly<{
        phase: AccessPhase;
        operation: "get" | "getOwnPropertyDescriptor" | "ownKeys";
        property: string | null;
      }>> = [];
      let cleanupCalls = 0;
      const disposeOwnedCandidate = (): Promise<void> => {
        cleanupCalls += 1;
        return cleanupResult === "rejects" ? Promise.reject(cleanupError) : Promise.resolve();
      };
      const extractionTarget: ProtectedApplicationFormExtraction = {
        candidate: synthetic.extraction.candidate,
        report: synthetic.extraction.report,
        fields: synthetic.extraction.fields,
        sealWriterTargets: synthetic.extraction.sealWriterTargets,
        dispose: disposeOwnedCandidate
      };
      const suppliedReferences = extractionTarget.fields.flatMap((slot) => [
        slot.reference,
        ...slot.choices.map((choice) => choice.reference)
      ]);
      const record = (
        operation: "get" | "getOwnPropertyDescriptor" | "ownKeys",
        property: PropertyKey | null
      ): void => {
        operations.push({ phase, operation, property: property === null ? null : String(property) });
      };
      const extraction = new Proxy(extractionTarget, {
        get(target, property, receiver) {
          record("get", property);
          return Reflect.get(target, property, receiver);
        },
        getOwnPropertyDescriptor(target, property) {
          record("getOwnPropertyDescriptor", property);
          return Reflect.getOwnPropertyDescriptor(target, property);
        },
        ownKeys(target) {
          record("ownKeys", null);
          return Reflect.ownKeys(target);
        }
      });

      const result = await correlateProtectedApplicationFormExtraction({
        extraction,
        authoritativeApplyHost: AUTHORITATIVE_APPLY_HOST
      });
      assertNoOpaqueReferenceAuthority(result, suppliedReferences);

      phase = "after-correlation";
      const firstDisposal = result.dispose();
      assert.equal(result.dispose(), firstDisposal);
      const outcomes = await Promise.allSettled([firstDisposal, result.dispose()]);

      assert.deepEqual(
        operations.filter((operation) => operation.phase === "after-correlation"),
        []
      );
      assert.equal(cleanupCalls, 1);
      assert.deepEqual(
        outcomes.map((outcome) => outcome.status),
        cleanupResult === "rejects" ? ["rejected", "rejected"] : ["fulfilled", "fulfilled"]
      );
      if (cleanupResult === "rejects") {
        assert.equal(outcomes[0].status === "rejected" && outcomes[0].reason, cleanupError);
        assert.equal(outcomes[1].status === "rejected" && outcomes[1].reason, cleanupError);
      }

      phase = "negative-control";
      void extraction.fields;
      void Object.getOwnPropertyDescriptor(extraction, "candidate");
      void Reflect.ownKeys(extraction);
      assert.deepEqual(
        operations.filter((operation) => operation.phase === "negative-control"),
        [
          { phase: "negative-control", operation: "get", property: "fields" },
          {
            phase: "negative-control",
            operation: "getOwnPropertyDescriptor",
            property: "candidate"
          },
          { phase: "negative-control", operation: "ownKeys", property: null }
        ]
      );
    });
  }
});

test("substituted field references cannot become Commit 2B authority", async () => {
  const report = singleSectionReport([
    rawField({ question: "Portfolio URL" }),
    rawField({ question: "LinkedIn URL" })
  ]);
  const synthetic = syntheticExtraction(report, {
    transformReferences: ([first, second]) => [
      { ...first, reference: second.reference },
      { ...second, reference: first.reference }
    ]
  });
  const supplied = synthetic.extraction.fields.map((slot) => slot.reference);
  const result = await correlateProtectedApplicationFormExtraction({
    extraction: synthetic.extraction,
    authoritativeApplyHost: AUTHORITATIVE_APPLY_HOST
  });

  try {
    assertNoOpaqueReferenceAuthority(result, supplied);
  } finally {
    await result.dispose();
  }
});

test("substituted choice references cannot become Commit 2B authority", async () => {
  const report = singleSectionReport([
    rawField({
      question: "Preferred office",
      fieldType: "SELECT_ONE",
      autocomplete: null,
      choices: [
        { label: "Alpha", disabled: false },
        { label: "Beta", disabled: false }
      ]
    })
  ]);
  const synthetic = syntheticExtraction(report, {
    transformReferences: ([field]) => [{
      ...field,
      choices: [
        { ...field.choices[0], reference: field.choices[1].reference },
        { ...field.choices[1], reference: field.choices[0].reference }
      ]
    }]
  });
  const supplied = synthetic.extraction.fields[0].choices.map((slot) => slot.reference);
  const result = await correlateProtectedApplicationFormExtraction({
    extraction: synthetic.extraction,
    authoritativeApplyHost: AUTHORITATIVE_APPLY_HOST
  });

  try {
    assertNoOpaqueReferenceAuthority(result, supplied);
  } finally {
    await result.dispose();
  }
});

test("a duplicated opaque reference across coordinates cannot become Commit 2B authority", async () => {
  const report = singleSectionReport([
    rawField({ question: "Portfolio URL" }),
    rawField({ question: "LinkedIn URL" })
  ]);
  const synthetic = syntheticExtraction(report, {
    transformReferences: ([first, second]) => [
      first,
      { ...second, reference: first.reference }
    ]
  });
  const duplicated = synthetic.extraction.fields[0].reference;
  const result = await correlateProtectedApplicationFormExtraction({
    extraction: synthetic.extraction,
    authoritativeApplyHost: AUTHORITATIVE_APPLY_HOST
  });

  try {
    assertNoOpaqueReferenceAuthority(result, [duplicated]);
  } finally {
    await result.dispose();
  }
});

test("candidate and report A cannot retain slot references supplied by extraction B", async () => {
  const reportA = singleSectionReport([
    rawField({ question: "Portfolio URL" }),
    rawField({
      question: "Preferred office",
      fieldType: "SELECT_ONE",
      autocomplete: null,
      choices: [{ label: "Remote", disabled: false }]
    })
  ]);
  const reportB = singleSectionReport([
    rawField({ question: "Other portfolio" }),
    rawField({
      question: "Other office",
      fieldType: "SELECT_ONE",
      autocomplete: null,
      choices: [{ label: "Onsite", disabled: false }]
    })
  ]);
  const extractionB = syntheticExtraction(reportB);
  const syntheticA = syntheticExtraction(reportA, {
    transformReferences: (references) => references.map((slot, fieldIndex) => ({
      ...slot,
      reference: extractionB.extraction.fields[fieldIndex].reference,
      choices: slot.choices.map((choice, choiceIndex) => ({
        ...choice,
        reference: extractionB.extraction.fields[fieldIndex].choices[choiceIndex].reference
      }))
    }))
  });
  const supplied = syntheticA.extraction.fields.flatMap((slot) => [
    slot.reference,
    ...slot.choices.map((choice) => choice.reference)
  ]);
  const result = await correlateProtectedApplicationFormExtraction({
    extraction: syntheticA.extraction,
    authoritativeApplyHost: AUTHORITATIVE_APPLY_HOST
  });

  try {
    assert.equal(result.candidate, syntheticA.candidate);
    assert.deepEqual(result.inspectionReport, reportA);
    assertNoOpaqueReferenceAuthority(result, supplied);
  } finally {
    await result.dispose();
  }
});

test("decorated copied and forged empty references cannot become Commit 2B authority", async (context) => {
  const copiedOpaqueReference = { ...opaqueIdentity<object>() };
  const cases: ReadonlyArray<Readonly<{ name: string; makeReference: () => object }>> = [
    {
      name: "decorated objects",
      makeReference: () => Object.freeze({ unauthenticated: true })
    },
    {
      name: "copied opaque objects",
      makeReference: () => Object.freeze({ ...copiedOpaqueReference })
    },
    {
      name: "forged empty null-prototype objects",
      makeReference: () => Object.freeze(Object.create(null)) as object
    }
  ];

  for (const entry of cases) {
    await context.test(entry.name, async () => {
      const report = singleSectionReport([
        rawField({
          question: "Preferred office",
          fieldType: "SELECT_ONE",
          autocomplete: null,
          choices: [{ label: "Remote", disabled: false }]
        })
      ]);
      const synthetic = syntheticExtraction(report, { referenceFactory: entry.makeReference });
      const supplied = synthetic.extraction.fields.flatMap((slot) => [
        slot.reference,
        ...slot.choices.map((choice) => choice.reference)
      ]);
      const result = await correlateProtectedApplicationFormExtraction({
        extraction: synthetic.extraction,
        authoritativeApplyHost: AUTHORITATIVE_APPLY_HOST
      });

      try {
        assertNoOpaqueReferenceAuthority(result, supplied);
      } finally {
        await result.dispose();
      }
    });
  }
});

test("normalizes reordered protected slots across null and classified contexts", async () => {
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

  const result = await correlateProtectedApplicationFormExtraction({
    extraction: synthetic.extraction,
    authoritativeApplyHost: AUTHORITATIVE_APPLY_HOST
  });

  assert.equal(result.fieldCount, 5);
  const fields = normalizedFields(expected.snapshot);
  assert.deepEqual(
    new Set(fields.map((field) => field.permittedDisposition)),
    new Set(["PROPOSABLE", "MANUAL_ONLY", "EXCLUDED", "UNSUPPORTED"])
  );
  assert.ok(fields.some((field) => field.semanticFieldKey === "professional.linkedin"));
  assert.deepEqual(result.normalizedSnapshot, expected.snapshot);
  assertNoOpaqueReferenceAuthority(
    result,
    synthetic.extraction.fields.map((slot) => slot.reference)
  );
  await result.dispose();
});

test("preserves canonical form section field and choice ordering without retaining references", async () => {
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

  const result = await correlateProtectedApplicationFormExtraction({
    extraction: synthetic.extraction,
    authoritativeApplyHost: AUTHORITATIVE_APPLY_HOST
  });

  const rawFormTitles = report.forms.map((form) => form.title);
  const canonicalFormTitles = authoritative.snapshot.forms.map((form) => form.title);
  const canonicalFormKeys = authoritative.snapshot.forms.map((form) => form.formKey);
  assert.deepEqual([...canonicalFormTitles].sort(), [...rawFormTitles].sort());
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
  assert.equal(result.fieldCount, rawFieldCount);
  assert.equal(authoritativeFields.length, rawFieldCount);
  assert.deepEqual(result.normalizedSnapshot, authoritative.snapshot);
  assertNoOpaqueReferenceAuthority(
    result,
    synthetic.extraction.fields.flatMap((slot) => [
      slot.reference,
      ...slot.choices.map((choice) => choice.reference)
    ])
  );
  await result.dispose();
});

test("normalizes unique choices without relying on protected slot order", async () => {
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

  const result = await correlateProtectedApplicationFormExtraction({
    extraction: synthetic.extraction,
    authoritativeApplyHost: AUTHORITATIVE_APPLY_HOST
  });

  assert.deepEqual(normalizedFields(result.normalizedSnapshot)[0], expectedField);
  assert.deepEqual(expectedField.choices.map((choice) => choice.label), [
    "Alpha office",
    "Middle office",
    "Zulu office"
  ]);
  assertNoOpaqueReferenceAuthority(
    result,
    synthetic.extraction.fields[0].choices.map((choice) => choice.reference)
  );
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

  const result = await correlateProtectedApplicationFormExtraction({
    extraction: synthetic.extraction,
    authoritativeApplyHost: AUTHORITATIVE_APPLY_HOST
  });

  const normalized = normalizedFields(result.normalizedSnapshot)[0];
  assert.equal(normalized.fieldType, "UNSUPPORTED");
  assert.equal(normalized.unsupportedReason, "AMBIGUOUS_CHOICES");
  assert.deepEqual(normalized.choices, []);
  assertNoOpaqueReferenceAuthority(
    result,
    synthetic.extraction.fields.flatMap((slot) => [
      slot.reference,
      ...slot.choices.map((choice) => choice.reference)
    ])
  );
  await result.dispose();
  assert.equal(synthetic.disposeCalls(), 1);
});

test("correlates multiple-file upload normalization without retaining field authority", async () => {
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

  const result = await correlateProtectedApplicationFormExtraction({
    extraction: synthetic.extraction,
    authoritativeApplyHost: AUTHORITATIVE_APPLY_HOST
  });

  const normalized = normalizedFields(result.normalizedSnapshot)[0];
  assert.equal(normalized.fieldType, "UNSUPPORTED");
  assert.equal(normalized.unsupportedReason, "MULTIPLE_FILE_UPLOAD");
  assertNoOpaqueReferenceAuthority(
    result,
    synthetic.extraction.fields.map((slot) => slot.reference)
  );
  await result.dispose();
});

test("quarantines duplicate source slots while binding only a unique writer target", async () => {
  const duplicate = rawField({ question: "Portfolio URL" });
  const report = singleSectionReport([duplicate, duplicate, rawField({ question: "LinkedIn URL" })]);
  const synthetic = syntheticExtraction(report);
  const result = await correlateProtectedApplicationFormExtraction({
    extraction: synthetic.extraction,
    authoritativeApplyHost: AUTHORITATIVE_APPLY_HOST
  });
  assert.equal(result.fieldCount, 3);
  assert.equal(result.uniqueFieldCount, 1);
  assert.equal(result.ambiguousQuestionCount, 2);
  assert.equal(result.ambiguousRequiredCount, 2);
  assert.deepEqual(synthetic.sealedBindings()?.map((binding) => binding.sourceOrdinal.field), [2]);
  await result.dispose();
  assert.equal(synthetic.disposeCalls(), 1);
});

test("duplicate file uploads and differing native selects seal no writer target", async () => {
  const upload = rawField({ question: "Upload résumé", fieldType: "FILE_UPLOAD", autocomplete: null });
  const select = rawField({
    question: "Preferred location", fieldType: "SELECT_ONE", autocomplete: null,
    choices: [{ label: "Remote", disabled: false }]
  });
  const otherSelect = { ...select, choices: [{ label: "Hybrid", disabled: false }] };
  const synthetic = syntheticExtraction(singleSectionReport([upload, upload, select, otherSelect]));
  const result = await correlateProtectedApplicationFormExtraction({
    extraction: synthetic.extraction,
    authoritativeApplyHost: AUTHORITATIVE_APPLY_HOST
  });
  assert.equal(result.uniqueFieldCount, 0);
  assert.equal(result.ambiguousQuestionCount, 4);
  assert.deepEqual(synthetic.sealedBindings(), []);
  await result.dispose();
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
    transform: (references: ProtectedFieldSlot[]) => readonly ProtectedFieldSlot[];
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
    transform: (reference: ProtectedFieldSlot) => ProtectedFieldSlot
  ) => (references: ProtectedFieldSlot[]) => [transform(references[0])];
  const cases: ReadonlyArray<Readonly<{
    name: string;
    transform: (references: ProtectedFieldSlot[]) => readonly ProtectedFieldSlot[];
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
    referenceFactory: () => Object.freeze({
      toString() {
        return secrets[6];
      }
    })
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

test("uses exact canonical field and choice objects without retaining opaque references", async () => {
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

  const result = await correlateProtectedApplicationFormExtraction({
    extraction: synthetic.extraction,
    authoritativeApplyHost: AUTHORITATIVE_APPLY_HOST
  });

  const resultField = normalizedFields(result.normalizedSnapshot)[0];
  assert.equal(canonicalJson(resultField), canonicalJson(fullField));
  assert.equal(resultField.fieldFingerprint, fullField.fieldFingerprint);
  assertNoOpaqueReferenceAuthority(
    result,
    synthetic.extraction.fields.flatMap((slot) => [
      slot.reference,
      ...slot.choices.map((choice) => choice.reference)
    ])
  );
  await result.dispose();
});
