import assert from "node:assert/strict";
import { test } from "node:test";

import {
  applicationFormInspectionReportSchema,
  buildNormalizedApplicationFormInspection,
  canonicalJson,
  canonicalizeFormComparisonText,
  FormInspectionDomainError,
  FORM_INSPECTION_SCHEMA_VERSION,
  FORM_INSPECTION_TEXT_LIMITS,
  hasVisibleBaseCharacter,
  MAX_CHOICES_PER_FIELD,
  MAX_CHOICES_TOTAL,
  MAX_FIELDS_TOTAL,
  MAX_FORMS,
  MAX_SECTIONS_PER_FORM,
  parseNormalizedApplicationFormSnapshot,
  sanitizeFormDisplayText,
  verifyNormalizedApplicationFormSnapshot
} from "@/lib/application-runs/form-inspection";

const EMPTY_CONSTRAINTS = {
  minLength: null,
  maxLength: null,
  min: null,
  max: null,
  step: null,
  acceptedFileTypes: [] as Array<"PDF" | "DOC" | "DOCX" | "RTF" | "TXT">,
  multiple: false
};

function field(overrides: Record<string, unknown> = {}) {
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

function report(fields = [field()], overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: FORM_INSPECTION_SCHEMA_VERSION,
    forms: [
      {
        title: "Application",
        sections: [{ heading: "Candidate details", fields }]
      }
    ],
    ...overrides
  };
}

function build(input: unknown, authoritativeApplyHost = "jobs.example.com") {
  return buildNormalizedApplicationFormInspection({ authoritativeApplyHost, report: input });
}

function choiceField(question: string, count: number) {
  return field({
    question,
    fieldType: "SELECT_ONE",
    autocomplete: null,
    choices: Array.from({ length: count }, (_, index) => ({ label: `Country ${index}`, disabled: false }))
  });
}

test("the inspection schema rejects unknown authority at every object depth", () => {
  const base = report([
    field({
      fieldType: "SELECT_ONE",
      autocomplete: null,
      choices: [{ label: "One", disabled: false }]
    })
  ]);
  const invalid = [
    { ...base, rawHtml: "<form>" },
    { ...base, forms: [{ ...base.forms[0], id: "client-form" }] },
    {
      ...base,
      forms: [{ ...base.forms[0], sections: [{ ...base.forms[0].sections[0], selector: "#section" }] }]
    },
    {
      ...base,
      forms: [
        {
          ...base.forms[0],
          sections: [
            {
              ...base.forms[0].sections[0],
              fields: [{ ...base.forms[0].sections[0].fields[0], name: "attacker-authority" }]
            }
          ]
        }
      ]
    },
    {
      ...base,
      forms: [
        {
          ...base.forms[0],
          sections: [
            {
              ...base.forms[0].sections[0],
              fields: [
                {
                  ...base.forms[0].sections[0].fields[0],
                  constraints: { ...base.forms[0].sections[0].fields[0].constraints, value: "secret" }
                }
              ]
            }
          ]
        }
      ]
    },
    {
      ...base,
      forms: [
        {
          ...base.forms[0],
          sections: [
            {
              ...base.forms[0].sections[0],
              fields: [
                {
                  ...base.forms[0].sections[0].fields[0],
                  choices: [{ label: "One", disabled: false, rawOptionValue: "yes" }]
                }
              ]
            }
          ]
        }
      ]
    }
  ];
  for (const candidate of invalid) assert.equal(applicationFormInspectionReportSchema.safeParse(candidate).success, false);
});

test("all structural collection bounds fail closed without truncation", () => {
  const fiveForms = report(undefined, {
    forms: Array.from({ length: MAX_FORMS + 1 }, (_, index) => ({
      title: `Form ${index}`,
      sections: [{ heading: null, fields: [field({ question: `Question ${index}` })] }]
    }))
  });
  assert.equal(applicationFormInspectionReportSchema.safeParse(fiveForms).success, false);

  const tooManySections = report(undefined, {
    forms: [
      {
        title: null,
        sections: Array.from({ length: MAX_SECTIONS_PER_FORM + 1 }, (_, index) => ({
          heading: `Section ${index}`,
          fields: [field({ question: `Question ${index}` })]
        }))
      }
    ]
  });
  assert.equal(applicationFormInspectionReportSchema.safeParse(tooManySections).success, false);

  const twoHundred = Array.from({ length: MAX_FIELDS_TOTAL }, (_, index) => field({ question: `Question ${index}` }));
  assert.equal(applicationFormInspectionReportSchema.safeParse(report(twoHundred)).success, true);
  assert.equal(
    applicationFormInspectionReportSchema.safeParse(
      report([...twoHundred, field({ question: `Question ${MAX_FIELDS_TOTAL}` })])
    ).success,
    false
  );
});

test("MAX_CHOICES_PER_FIELD is exactly 256 and country-sized controls are accepted", () => {
  assert.equal(MAX_CHOICES_PER_FIELD, 256);
  assert.equal(applicationFormInspectionReportSchema.safeParse(report([choiceField("Country", 249)])).success, true);
  assert.equal(applicationFormInspectionReportSchema.safeParse(report([choiceField("Country", 256)])).success, true);
  assert.equal(applicationFormInspectionReportSchema.safeParse(report([choiceField("Country", 257)])).success, false);
  const normalized = build(report([choiceField("Country", 249)]));
  assert.equal(normalized.snapshot.forms[0].sections[0].fields[0].choices.length, 249);
});

test("aggregate choice bounds accept 1000 and reject 1001", () => {
  const oneThousand = [250, 250, 250, 250].map((count, index) => choiceField(`Country ${index}`, count));
  assert.equal(MAX_CHOICES_TOTAL, 1_000);
  assert.equal(applicationFormInspectionReportSchema.safeParse(report(oneThousand)).success, true);
  const oneThousandOne = [251, 250, 250, 250].map((count, index) => choiceField(`Country ${index}`, count));
  assert.equal(applicationFormInspectionReportSchema.safeParse(report(oneThousandOne)).success, false);
});

test("normalized text bounds are enforced after Unicode normalization", () => {
  const limits = FORM_INSPECTION_TEXT_LIMITS;
  assert.equal(applicationFormInspectionReportSchema.safeParse(report(undefined, { forms: [{ title: "a".repeat(limits.formOrSection.codePoints), sections: [{ heading: null, fields: [field()] }] }] })).success, true);
  assert.equal(applicationFormInspectionReportSchema.safeParse(report(undefined, { forms: [{ title: "a".repeat(limits.formOrSection.codePoints + 1), sections: [{ heading: null, fields: [field()] }] }] })).success, false);
  assert.equal(applicationFormInspectionReportSchema.safeParse(report([field({ question: "q".repeat(limits.question.codePoints) })])).success, true);
  assert.equal(applicationFormInspectionReportSchema.safeParse(report([field({ question: "q".repeat(limits.question.codePoints + 1) })])).success, false);
  assert.equal(applicationFormInspectionReportSchema.safeParse(report([field({ helpText: "h".repeat(limits.helpText.codePoints) })])).success, true);
  assert.equal(applicationFormInspectionReportSchema.safeParse(report([field({ helpText: "h".repeat(limits.helpText.codePoints + 1) })])).success, false);
  const longChoice = field({ fieldType: "SELECT_ONE", autocomplete: null, choices: [{ label: "x".repeat(limits.choiceLabel.codePoints + 1), disabled: false }] });
  assert.equal(applicationFormInspectionReportSchema.safeParse(report([longChoice])).success, false);
  assert.equal(applicationFormInspectionReportSchema.safeParse(report([field({ question: "Ａ".repeat(500) })])).success, true);
});

test("the dedicated Unicode canonicalizer preserves meaning while removing unsafe formatting", () => {
  assert.equal(sanitizeFormDisplayText("  Café\u00a0Ａ＋Ｂ\u202e\n résumé?  "), "Café A+B résumé?");
  assert.equal(canonicalizeFormComparisonText("École—東京 №２"), "école—東京 no2");
  assert.notEqual(canonicalizeFormComparisonText("resume"), canonicalizeFormComparisonText("résumé"));
  assert.notEqual(canonicalizeFormComparisonText("東京"), canonicalizeFormComparisonText("大阪"));
  assert.equal(applicationFormInspectionReportSchema.safeParse(report([field({ question: "bad\ud800text" })])).success, false);
});

test("compatibility normalization cannot erase an untrusted classifier boundary", () => {
  for (const heading of [
    "The compa\u00a8ny owns the LinkedIn profile",
    "The compa\u00b4ny owns the LinkedIn profile",
    "The companyⒶowns the LinkedIn profile"
  ]) {
    const candidate = report([field({ question: "LinkedIn", fieldType: "URL" })], {
      forms: [
        {
          title: "Application",
          sections: [{ heading, fields: [field({ question: "LinkedIn", fieldType: "URL" })] }]
        }
      ]
    });
    assert.equal(
      applicationFormInspectionReportSchema.safeParse(candidate).success,
      false,
      heading
    );
    assert.throws(() => build(candidate), heading);
  }

  for (const heading of [
    "The compa \u0308ny owns the LinkedIn profile",
    "The compa\tny owns the LinkedIn profile",
    "The compa\u00a0ny owns the LinkedIn profile"
  ]) {
    const canonicalizedBoundary = report(
      [field({ question: "LinkedIn", fieldType: "URL" })],
      {
        forms: [
          {
            title: "Application",
            sections: [
              {
                heading,
                fields: [field({ question: "LinkedIn", fieldType: "URL" })]
              }
            ]
          }
        ]
      }
    );
    const built = build(canonicalizedBoundary);
    const normalized = built.snapshot.forms[0].sections[0].fields[0];
    assert.notEqual(normalized.permittedDisposition, "PROPOSABLE", heading);
    assert.deepEqual(
      verifyNormalizedApplicationFormSnapshot({
        authoritativeApplyHost: "jobs.example.com",
        expectedFormFingerprint: built.formFingerprint,
        snapshot: built.snapshot
      }),
      built.snapshot
    );
  }
});

test("case and presentation whitespace do not alter identities or fingerprints", () => {
  const first = build(
    report([
      field({
        question: "LinkedIn URL",
        helpText: "Your PROFESSIONAL profile",
        choices: [],
        autocomplete: "url"
      })
    ])
  );
  const second = build(
    report([
      field({
        question: "  linkedin\nurl ",
        helpText: "your professional PROFILE",
        choices: [],
        autocomplete: "url"
      })
    ], {
      forms: [
        {
          title: "application",
          sections: [
            {
              heading: "candidate DETAILS",
              fields: [
                field({
                  question: "  linkedin\nurl ",
                  helpText: "your professional PROFILE",
                  choices: [],
                  autocomplete: "url"
                })
              ]
            }
          ]
        }
      ]
    })
  );
  const a = first.snapshot.forms[0].sections[0].fields[0];
  const b = second.snapshot.forms[0].sections[0].fields[0];
  assert.equal(a.normalizedFieldKey, b.normalizedFieldKey);
  assert.equal(a.fieldFingerprint, b.fieldFingerprint);
  assert.equal(first.formFingerprint, second.formFingerprint);
});

test("unsupported controls are inert and hidden controls are forbidden", () => {
  for (const unsupportedReason of ["PASSWORD", "RICH_TEXT", "CUSTOM_COMBOBOX"] as const) {
    const normalized = build(
      report([
        field({
          question: `Unsupported ${unsupportedReason}`,
          fieldType: "UNSUPPORTED",
          unsupportedReason,
          autocomplete: null
        })
      ])
    ).snapshot.forms[0].sections[0].fields[0];
    assert.equal(normalized.fieldType, "UNSUPPORTED");
    assert.equal(normalized.permittedDisposition, "UNSUPPORTED");
  }
  assert.equal(applicationFormInspectionReportSchema.safeParse(report([field({ fieldType: "HIDDEN" })])).success, false);

  const multiple = build(
    report([
      field({
        question: "Upload résumé",
        fieldType: "FILE_UPLOAD",
        autocomplete: null,
        constraints: { ...EMPTY_CONSTRAINTS, acceptedFileTypes: ["PDF"], multiple: true }
      })
    ])
  ).snapshot.forms[0].sections[0].fields[0];
  assert.equal(multiple.fieldType, "UNSUPPORTED");
  assert.equal(multiple.unsupportedReason, "MULTIPLE_FILE_UPLOAD");
  assert.equal(multiple.permittedDisposition, "UNSUPPORTED");
});

test("supported controls preserve classifier-origin unsupported reasons through verification", () => {
  for (const [question, expectedReason] of [
    ["Trace identifier", "UNKNOWN_QUESTION"],
    ["GitHub URL and GitLab URL", "AMBIGUOUS_FIELD"]
  ] as const) {
    const built = build(
      report([field({ question, fieldType: "URL", autocomplete: null })])
    );
    const normalized = built.snapshot.forms[0].sections[0].fields[0];
    assert.equal(normalized.fieldType, "URL");
    assert.equal(normalized.unsupportedReason, null);
    assert.equal(normalized.permittedDisposition, "UNSUPPORTED");
    assert.equal(normalized.dispositionReason, expectedReason);
    assert.deepEqual(parseNormalizedApplicationFormSnapshot(built.snapshot), built.snapshot);
    assert.deepEqual(
      verifyNormalizedApplicationFormSnapshot({
        authoritativeApplyHost: "jobs.example.com",
        expectedFormFingerprint: built.formFingerprint,
        snapshot: built.snapshot
      }),
      built.snapshot
    );
  }
});

test("constraint and control incompatibilities are rejected", () => {
  assert.equal(
    applicationFormInspectionReportSchema.safeParse(
      report([field({ constraints: { ...EMPTY_CONSTRAINTS, minLength: 10, maxLength: 2 } })])
    ).success,
    false
  );
  assert.equal(
    applicationFormInspectionReportSchema.safeParse(
      report([field({ fieldType: "NUMBER", constraints: { ...EMPTY_CONSTRAINTS, minLength: 1 } })])
    ).success,
    false
  );
  assert.equal(
    applicationFormInspectionReportSchema.safeParse(
      report([field({ fieldType: "TEXT", constraints: { ...EMPTY_CONSTRAINTS, min: "1" } })])
    ).success,
    false
  );
  assert.throws(
    () => build(report([field({ fieldType: "NUMBER", constraints: { ...EMPTY_CONSTRAINTS, min: "2", max: "1" } })])),
    FormInspectionDomainError
  );
});

test("choice keys and fingerprints ignore choice order but bind disabled state", () => {
  const choices = [
    { label: "Yes", disabled: false },
    { label: "No", disabled: false }
  ];
  const first = build(report([field({ question: "Select availability", fieldType: "RADIO_GROUP", autocomplete: null, choices })]));
  const reordered = build(
    report([field({ question: "Select availability", fieldType: "RADIO_GROUP", autocomplete: null, choices: [...choices].reverse() })])
  );
  assert.deepEqual(first.snapshot, reordered.snapshot);
  assert.equal(first.formFingerprint, reordered.formFingerprint);

  const disabled = build(
    report([
      field({
        question: "Select availability",
        fieldType: "RADIO_GROUP",
        autocomplete: null,
        choices: [{ label: "Yes", disabled: true }, choices[1]]
      })
    ])
  );
  assert.notEqual(first.formFingerprint, disabled.formFingerprint);
});

test("duplicate canonical choices make only the field unsupported", () => {
  const normalized = build(
    report([
      field({
        question: "Choose one",
        fieldType: "SELECT_ONE",
        autocomplete: null,
        choices: [
          { label: "Café", disabled: false },
          { label: "  CAFÉ ", disabled: false }
        ]
      })
    ])
  ).snapshot.forms[0].sections[0].fields[0];
  assert.equal(normalized.fieldType, "UNSUPPORTED");
  assert.equal(normalized.unsupportedReason, "AMBIGUOUS_CHOICES");
  assert.deepEqual(normalized.choices, []);
});

test("field order is immaterial while material semantics alter fingerprints", () => {
  const fields = [field({ question: "LinkedIn URL" }), field({ question: "Available start date", fieldType: "DATE", autocomplete: null })];
  const first = build(report(fields));
  const reversed = build(report([...fields].reverse()));
  assert.deepEqual(first.snapshot, reversed.snapshot);
  assert.equal(first.formFingerprint, reversed.formFingerprint);

  const changed = build(report([fields[0], field({ ...fields[1], required: false, helpText: "Use YYYY-MM-DD" })]));
  assert.notEqual(first.formFingerprint, changed.formFingerprint);
});

test("confirmation semantics create distinct server-owned field identities", () => {
  const normalized = build(
    report([
      field({ question: "Email address", fieldType: "EMAIL", autocomplete: "email" }),
      field({ question: "Confirm email address", fieldType: "EMAIL", autocomplete: "email" })
    ])
  );
  const fields = normalized.snapshot.forms[0].sections[0].fields;
  assert.deepEqual(
    fields.map((item) => item.semanticFieldKey).sort(),
    ["contact.email", "contact.email.confirmation"]
  );
  assert.notEqual(fields[0].normalizedFieldKey, fields[1].normalizedFieldKey);
});

test("truly indistinguishable duplicate fields fail without ordinal authority", () => {
  assert.throws(
    () => build(report([field({ question: "Portfolio URL" }), field({ question: "Portfolio URL" })])),
    (error) => error instanceof FormInspectionDomainError && error.code === "AMBIGUOUS_DUPLICATE_FIELD"
  );
});

test("the authoritative host is explicit fingerprint material and URL parts are not input", () => {
  const input = report([field()]);
  assert.notEqual(build(input, "jobs.example.com").formFingerprint, build(input, "careers.example.com").formFingerprint);
  assert.equal(applicationFormInspectionReportSchema.safeParse({ ...input, applyUrl: "https://jobs.example.com/path?q=1#x" }).success, false);
});

test("the normalized snapshot contains no client, source, browser, or proposal authority", () => {
  const snapshot = build(report([field()])).snapshot;
  const keys = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
    } else if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        keys.add(key);
        visit(child);
      }
    }
  };
  visit(snapshot);
  for (const forbidden of [
    "rawHtml",
    "dom",
    "selector",
    "id",
    "name",
    "value",
    "currentValue",
    "rawOptionValue",
    "sourceId",
    "sourceIds",
    "evidenceIds",
    "proposal",
    "adapterHint",
    "applyUrl"
  ]) {
    assert.equal(keys.has(forbidden), false, `snapshot unexpectedly contained ${forbidden}`);
  }
});

test("raw and normalized Unicode bounds both fail closed", () => {
  const removableOversize = `${"\0".repeat(FORM_INSPECTION_TEXT_LIMITS.question.codePoints + 1)}Q`;
  assert.equal(
    applicationFormInspectionReportSchema.safeParse(report([field({ question: removableOversize })])).success,
    false
  );
  assert.equal(
    applicationFormInspectionReportSchema.safeParse(
      report([field({ question: "😀".repeat(FORM_INSPECTION_TEXT_LIMITS.question.codePoints) })])
    ).success,
    true
  );
  assert.equal(
    applicationFormInspectionReportSchema.safeParse(
      report([field({ question: "😀".repeat(FORM_INSPECTION_TEXT_LIMITS.question.codePoints + 1) })])
    ).success,
    false
  );
});

test("canonical JSON rejects array accessors without invoking them", () => {
  let getterCalls = 0;
  const accessorArray = ["placeholder"];
  Object.defineProperty(accessorArray, "0", {
    configurable: true,
    enumerable: true,
    get() {
      getterCalls += 1;
      return "dynamic";
    }
  });
  assert.throws(() => canonicalJson(accessorArray));
  assert.equal(getterCalls, 0);
});

test("normalized snapshots reject tampering, noncanonical order, and fingerprint mismatch", () => {
  const built = build(
    report([
      field({ question: "LinkedIn URL" }),
      field({ question: "Available start date", fieldType: "DATE", autocomplete: null })
    ])
  );
  assert.deepEqual(parseNormalizedApplicationFormSnapshot(structuredClone(built.snapshot)), built.snapshot);
  assert.deepEqual(
    verifyNormalizedApplicationFormSnapshot({
      authoritativeApplyHost: "jobs.example.com",
      expectedFormFingerprint: built.formFingerprint,
      snapshot: structuredClone(built.snapshot)
    }),
    built.snapshot
  );

  const mutateFirstField = (patch: Record<string, unknown>) => {
    const snapshot = structuredClone(built.snapshot) as unknown as {
      forms: Array<{ sections: Array<{ fields: Array<Record<string, unknown>> }> }>;
    };
    Object.assign(snapshot.forms[0].sections[0].fields[0], patch);
    return snapshot;
  };
  for (const snapshot of [
    mutateFirstField({ normalizedQuestion: "tampered" }),
    mutateFirstField({ semanticFieldKey: "professional.website" }),
    mutateFirstField({ classification: "CONTACT" }),
    mutateFirstField({ permittedDisposition: "EXCLUDED", dispositionReason: "POLICY_EXCLUDED" })
  ]) {
    assert.throws(() => parseNormalizedApplicationFormSnapshot(snapshot));
  }

  const reordered = structuredClone(built.snapshot) as unknown as {
    forms: Array<{ sections: Array<{ fields: Array<unknown> }> }>;
  };
  reordered.forms[0].sections[0].fields.reverse();
  assert.throws(() => parseNormalizedApplicationFormSnapshot(reordered));

  const extraAuthority = structuredClone(built.snapshot) as unknown as {
    forms: Array<{ sections: Array<{ fields: Array<Record<string, unknown>> }> }>;
  };
  extraAuthority.forms[0].sections[0].fields[0].sourceId = "forbidden";
  assert.throws(() => parseNormalizedApplicationFormSnapshot(extraAuthority));
  assert.throws(() =>
    verifyNormalizedApplicationFormSnapshot({
      authoritativeApplyHost: "jobs.example.com",
      expectedFormFingerprint: "0".repeat(64),
      snapshot: built.snapshot
    })
  );
});

test("normalized constraints and sensitive unsupported controls retain closed semantics", () => {
  assert.equal(
    applicationFormInspectionReportSchema.safeParse(
      report([field({ constraints: { ...EMPTY_CONSTRAINTS, minLength: 0, maxLength: 4_000 } })])
    ).success,
    true
  );
  assert.equal(
    applicationFormInspectionReportSchema.safeParse(
      report([field({ constraints: { ...EMPTY_CONSTRAINTS, maxLength: 4_001 } })])
    ).success,
    false
  );
  assert.doesNotThrow(() =>
    build(
      report([
        field({
          fieldType: "NUMBER",
          constraints: { ...EMPTY_CONSTRAINTS, min: "1".repeat(64), step: "1" }
        })
      ])
    )
  );
  assert.equal(
    applicationFormInspectionReportSchema.safeParse(
      report([field({ fieldType: "NUMBER", constraints: { ...EMPTY_CONSTRAINTS, min: "1".repeat(65) } })])
    ).success,
    false
  );
  assert.throws(() =>
    build(report([field({ fieldType: "DATE", constraints: { ...EMPTY_CONSTRAINTS, min: "2023-02-29" } })]))
  );
  assert.throws(() =>
    build(report([field({ fieldType: "NUMBER", constraints: { ...EMPTY_CONSTRAINTS, step: "0" } })]))
  );

  const sensitiveUnsupported = build(
    report([
      field({
        question: "Voluntary disability status",
        fieldType: "UNSUPPORTED",
        unsupportedReason: "PASSWORD",
        autocomplete: null
      })
    ])
  ).snapshot.forms[0].sections[0].fields[0];
  assert.equal(sensitiveUnsupported.classification, "DISABILITY");
  assert.equal(sensitiveUnsupported.permittedDisposition, "EXCLUDED");
  assert.equal(sensitiveUnsupported.dispositionReason, "POLICY_EXCLUDED");
});

test("the narrow invisible-text policy removes separator controls without breaking legitimate Unicode", () => {
  const strippedInvisibleIdentities = [
    "\u00ad",
    "\u061c",
    "\u115f",
    "\u1160",
    "\u180e",
    "\u200b",
    "\u2060",
    "\u2061",
    "\u2064",
    "\u2065",
    "\u206a",
    "\u206f",
    "\u3164",
    "\ufeff",
    "\uffa0"
  ] as const;
  for (const invisible of strippedInvisibleIdentities) {
    assert.equal(
      applicationFormInspectionReportSchema.safeParse(report([field({ question: invisible })])).success,
      false
    );
    assert.throws(() => build(report([field({ question: invisible })])));
    assert.equal(
      applicationFormInspectionReportSchema.safeParse(
        report([
          field({
            question: "Choice",
            fieldType: "SELECT_ONE",
            autocomplete: null,
            choices: [{ label: invisible, disabled: false }]
          })
        ])
      ).success,
      false
    );
    assert.equal(sanitizeFormDisplayText(`Y${invisible}es`), "Yes");

    const combining = `e${invisible}\u0301`;
    const sanitized = sanitizeFormDisplayText(combining);
    assert.equal(sanitized, "é");
    assert.equal(sanitizeFormDisplayText(sanitized), sanitized);
    assert.equal(
      applicationFormInspectionReportSchema.safeParse(
        report([field({ question: combining, helpText: combining })])
      ).success,
      false
    );
    assert.throws(() => build(report([field({ question: combining, helpText: combining })])));

    for (const helpText of [
      `Your comp${invisible}any LinkedIn profile`,
      `The${invisible}company owns the LinkedIn profile`
    ]) {
      const unsafeReport = report([field({ question: "LinkedIn", helpText })]);
      assert.equal(applicationFormInspectionReportSchema.safeParse(unsafeReport).success, false);
      assert.throws(() => build(unsafeReport));
    }
  }
  const blankBases = ["\u115f", "\u1160", "\u2800", "\u3164", "\uffa0"] as const;
  for (const blankBase of blankBases) {
    assert.equal(hasVisibleBaseCharacter(blankBase), false);
  }
  for (const markOnly of ["\u200c", "\u200d", "\u0301", "\ufe0f", ...blankBases]) {
    assert.equal(
      applicationFormInspectionReportSchema.safeParse(report([field({ question: markOnly })])).success,
      false
    );
    assert.equal(
      applicationFormInspectionReportSchema.safeParse(
        report([
          field({
            question: "Choice",
            fieldType: "SELECT_ONE",
            autocomplete: null,
            choices: [{ label: markOnly, disabled: false }]
          })
        ])
      ).success,
      false
    );
  }

  for (const invisible of strippedInvisibleIdentities) {
    const collisionReport = report(
      [
        field({
          question: "Choose one",
          fieldType: "SELECT_ONE",
          autocomplete: null,
          choices: [
            { label: "Yes", disabled: false },
            { label: `Y${invisible}es`, disabled: false }
          ]
        })
      ]
    );
    assert.equal(
      applicationFormInspectionReportSchema.safeParse(collisionReport).success,
      false,
      JSON.stringify(invisible)
    );
    assert.throws(() => build(collisionReport), JSON.stringify(invisible));
  }

  const legitimateTexts = [
    "العَرَبِيَّة",
    "עברית",
    "안녕하세요",
    "e\u0301",
    "A\u034f\u0301",
    "ក\u17b4",
    "ᠠ\u180b",
    "👩‍💻",
    "✈️",
    "🏴\u{e0067}\u{e0062}\u{e007f}",
    "क्‍ष",
    "می\u200cروم",
    "⠋\u2800⠕"
  ] as const;
  for (const text of legitimateTexts) {
    assert.equal(applicationFormInspectionReportSchema.safeParse(report([field({ question: text })])).success, true);
  }
  assert.equal(sanitizeFormDisplayText("👩‍💻"), "👩‍💻");
  assert.equal(sanitizeFormDisplayText("می\u200cروم"), "می\u200cروم");

  for (const invisible of [
    "\u034f",
    "\u17b4",
    "\u180b",
    "\u200c",
    "\u200d",
    "\ufe0f",
    "\u{e0020}",
    "\u2800"
  ]) {
    const hostileLink = build(
      report([
        field({ question: "LinkedIn", helpText: `Your comp${invisible}any LinkedIn profile` })
      ])
    ).snapshot.forms[0].sections[0].fields[0];
    const boundaryLink = build(
      report([field({ question: "LinkedIn", helpText: `The${invisible}company owns the LinkedIn profile` })])
    ).snapshot.forms[0].sections[0].fields[0];
    const mixedLink = build(
      report([
        field({
          question: "LinkedIn",
          helpText: `The${invisible}co${invisible}mpany owns the LinkedIn profile`
        })
      ])
    ).snapshot.forms[0].sections[0].fields[0];
    assert.notEqual(hostileLink.permittedDisposition, "PROPOSABLE");
    assert.notEqual(boundaryLink.permittedDisposition, "PROPOSABLE");
    assert.notEqual(mixedLink.permittedDisposition, "PROPOSABLE");

    const hostileDocument = build(
      report([
        field({
          question: "Upload your resume",
          helpText: `Resume for the recr${invisible}uiter`,
          fieldType: "FILE_UPLOAD",
          autocomplete: null
        })
      ])
    ).snapshot.forms[0].sections[0].fields[0];
    const boundaryDocument = build(
      report([
        field({
          question: "Upload your resume",
          helpText: `Resume for the${invisible}recruiter`,
          fieldType: "FILE_UPLOAD",
          autocomplete: null
        })
      ])
    ).snapshot.forms[0].sections[0].fields[0];
    assert.notEqual(hostileDocument.permittedDisposition, "PROPOSABLE");
    assert.notEqual(boundaryDocument.permittedDisposition, "PROPOSABLE");
  }

  const baseline = build(report([field({ question: "Visible question" })]));
  for (const blankBase of blankBases) {
    const tampered = structuredClone(baseline.snapshot) as unknown as {
      forms: Array<{ sections: Array<{ fields: Array<{ question: string | null }> }> }>;
    };
    tampered.forms[0].sections[0].fields[0].question = blankBase;
    assert.throws(() => parseNormalizedApplicationFormSnapshot(tampered), JSON.stringify(blankBase));
  }

  for (const legitimate of legitimateTexts) {
    const normalized = build(report([field({ helpText: legitimate })])).snapshot.forms[0].sections[0]
      .fields[0];
    assert.equal(normalized.helpText, sanitizeFormDisplayText(legitimate));
  }
});

test("malformed high and low surrogate variants fail at the raw text boundary", () => {
  for (const malformed of ["\udc00", "before\udc00after", "before\ud800after", "\ud800\ud800", "\udc00\udfff"]) {
    assert.equal(
      applicationFormInspectionReportSchema.safeParse(report([field({ question: malformed })])).success,
      false,
      JSON.stringify(malformed)
    );
  }
});

test("length constraints reject negative zero consistently in raw, builder, and normalized snapshots", () => {
  for (const invalid of [-0, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity]) {
    const candidate = report([field({ constraints: { ...EMPTY_CONSTRAINTS, minLength: invalid } })]);
    assert.equal(applicationFormInspectionReportSchema.safeParse(candidate).success, false);
    assert.throws(() => build(candidate));
  }
  for (const valid of [0, 4_000]) {
    const candidate = report([field({ constraints: { ...EMPTY_CONSTRAINTS, minLength: valid } })]);
    assert.equal(applicationFormInspectionReportSchema.safeParse(candidate).success, true);
    assert.doesNotThrow(() => build(candidate));
  }

  const built = build(report([field({ constraints: { ...EMPTY_CONSTRAINTS, minLength: 0 } })]));
  const tampered = structuredClone(built.snapshot) as unknown as {
    forms: Array<{ sections: Array<{ fields: Array<{ constraints: { minLength: number | null } }> }> }>;
  };
  tampered.forms[0].sections[0].fields[0].constraints.minLength = -0;
  assert.throws(() => parseNormalizedApplicationFormSnapshot(tampered));
  assert.throws(() => canonicalJson(-0));
});

test("classification-sensitive duplicate choices build and reverify against the final unsupported type", () => {
  const cases = [
    ["LinkedIn", "PROFESSIONAL_LINK"],
    ["Availability", "AVAILABILITY"],
    ["Voluntary disability status", "DISABILITY"],
    ["Choose one", "UNKNOWN"]
  ] as const;

  for (const [question, expectedClassification] of cases) {
    const built = build(
      report([
        field({
          question,
          fieldType: "SELECT_ONE",
          autocomplete: null,
          choices: [
            { label: "Café", disabled: false },
            { label: " CAFÉ ", disabled: true }
          ]
        })
      ])
    );
    const normalized = built.snapshot.forms[0].sections[0].fields[0];
    assert.equal(normalized.fieldType, "UNSUPPORTED", question);
    assert.equal(normalized.unsupportedReason, "AMBIGUOUS_CHOICES", question);
    assert.equal(normalized.classification, expectedClassification, question);
    assert.notEqual(normalized.permittedDisposition, "PROPOSABLE", question);
    assert.deepEqual(normalized.choices, []);
    assert.deepEqual(parseNormalizedApplicationFormSnapshot(structuredClone(built.snapshot)), built.snapshot);
    assert.deepEqual(
      verifyNormalizedApplicationFormSnapshot({
        authoritativeApplyHost: "jobs.example.com",
        expectedFormFingerprint: built.formFingerprint,
        snapshot: structuredClone(built.snapshot)
      }),
      built.snapshot
    );
  }
});

test("form and section presentation order is immaterial", () => {
  const forms = [
    {
      title: "First",
      sections: [
        { heading: "Links", fields: [field({ question: "LinkedIn URL" })] },
        {
          heading: "Timing",
          fields: [field({ question: "When can you start?", fieldType: "DATE", autocomplete: null })]
        }
      ]
    },
    {
      title: "Second",
      sections: [{ heading: "Contact", fields: [field({ question: "Email address", fieldType: "EMAIL", autocomplete: "email" })] }]
    }
  ];
  const baseline = build(report(undefined, { forms }));
  const reorderedForms = build(report(undefined, { forms: [...forms].reverse() }));
  const reorderedSections = build(
    report(undefined, {
      forms: [{ ...forms[0], sections: [...forms[0].sections].reverse() }, forms[1]]
    })
  );
  assert.deepEqual(reorderedForms.snapshot, baseline.snapshot);
  assert.equal(reorderedForms.formFingerprint, baseline.formFingerprint);
  assert.deepEqual(reorderedSections.snapshot, baseline.snapshot);
  assert.equal(reorderedSections.formFingerprint, baseline.formFingerprint);
});

test("each field-fingerprint material input changes identity one at a time", () => {
  const fingerprint = (candidate: Record<string, unknown>) =>
    build(report([candidate as unknown as ReturnType<typeof field>])).snapshot.forms[0].sections[0].fields[0]
      .fieldFingerprint;
  const choiceBase = field({
    question: "Availability",
    fieldType: "SELECT_ONE",
    autocomplete: null,
    choices: [
      { label: "Morning", disabled: false },
      { label: "Evening", disabled: false }
    ]
  });
  const choiceFingerprint = fingerprint(choiceBase);
  for (const mutant of [
    { ...choiceBase, required: false },
    { ...choiceBase, helpText: "Choose one schedule" },
    {
      ...choiceBase,
      choices: [
        { label: "Morning", disabled: true },
        { label: "Evening", disabled: false }
      ]
    },
    {
      ...choiceBase,
      choices: [
        { label: "Morning", disabled: false },
        { label: "Night", disabled: false }
      ]
    },
    { ...choiceBase, fieldType: "RADIO_GROUP" }
  ]) {
    assert.notEqual(fingerprint(mutant), choiceFingerprint);
  }

  const textBase = field({ question: "Portfolio URL", fieldType: "URL", autocomplete: null });
  assert.notEqual(fingerprint({ ...textBase, autocomplete: "url" }), fingerprint(textBase));
  const constrained = field({ question: "Profile", fieldType: "TEXT", autocomplete: null });
  assert.notEqual(
    fingerprint({ ...constrained, constraints: { ...EMPTY_CONSTRAINTS, maxLength: 100 } }),
    fingerprint(constrained)
  );
});

test("canonical JSON handles object descriptors and Unicode keys without hidden execution", () => {
  let getterCalls = 0;
  const accessor: Record<string, unknown> = {};
  Object.defineProperty(accessor, "value", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return "dynamic";
    }
  });
  assert.throws(() => canonicalJson(accessor));
  assert.equal(getterCalls, 0);

  const symbolKeyed = { visible: true } as Record<PropertyKey, unknown>;
  symbolKeyed[Symbol("hidden")] = true;
  assert.throws(() => canonicalJson(symbolKeyed));
  assert.throws(() => canonicalJson(Object.assign(Object.create({ inherited: true }), { own: true })));
  assert.equal(canonicalJson({ "😀": 3, "é": 2, a: 1 }), "{\"a\":1,\"é\":2,\"😀\":3}");
});
