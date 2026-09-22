import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { chromium, type Browser, type Page } from "playwright";

import {
  ApplicationFormDomExtractionError,
  extractSafeApplicationForm
} from "@/lib/application-browser/form-inspection-dom";
import { MISSING_CHROMIUM_MESSAGE } from "@/lib/application-browser/browser-runtime";
import {
  FORM_INSPECTION_TEXT_LIMITS,
  MAX_FIELDS_TOTAL,
  MAX_FORMS,
  applicationFormInspectionReportSchema
} from "@/lib/application-runs/form-inspection";
import {
  PROMPT_LIKE_EMPLOYER_TEXT,
  SECRET_HIDDEN_VALUE,
  SECRET_OPTION_VALUE,
  SECRET_PASSWORD_VALUE,
  closedShadowComboboxFixture,
  createSyntheticFixturePage,
  externalGroupIframeFixture,
  fileAndUnsupportedFixture,
  iframeFixture,
  interactiveAriaFixture,
  nativeApplicationFixture,
  nestedCustomInteractionFixture,
  nonHyphenShadowComboboxFixture,
  obviousAriaRoleFixture,
  ownerlessFixture,
  ownershipAndVisibilityFixture,
  privacyFixture,
  readFormInspectionTraps,
  repeatedFieldsFixture,
  repeatedFormsFixture,
  shadowInteractionFixture,
  shadowFixture,
  unrelatedIframeFixture,
  unknownMultipleFileFixture
} from "@/tests/browser/form-inspection-fixtures";

let browser: Browser;

before(async () => {
  try {
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    if (error instanceof Error && /executable.*(doesn'?t exist|missing|not found)|playwright install/i.test(error.message)) {
      throw new Error(MISSING_CHROMIUM_MESSAGE);
    }
    throw error;
  }
});

after(async () => {
  await browser?.close();
});

async function withFixture(html: string, run: (page: Page) => Promise<void>): Promise<void> {
  const page = await createSyntheticFixturePage(browser, html);
  try {
    await run(page);
  } finally {
    await page.close();
  }
}

function assertExtractionCode(error: unknown, code: ApplicationFormDomExtractionError["code"]): boolean {
  assert.ok(error instanceof ApplicationFormDomExtractionError);
  assert.equal(error.code, code);
  assert.equal(error.message, `Safe form inspection failed: ${code}`);
  return true;
}

test("extracts native field semantics and opaque references from one Chromium instant", async () => {
  await withFixture(nativeApplicationFixture(), async (page) => {
    const extraction = await extractSafeApplicationForm(page);
    assert.deepEqual(applicationFormInspectionReportSchema.parse(extraction.report), extraction.report);
    assert.equal(extraction.report.schemaVersion, 1);
    assert.equal(extraction.report.forms.length, 1);
    assert.equal(extraction.report.forms[0].title, "Candidate application");
    assert.deepEqual(extraction.report.forms[0].sections.map((section) => section.heading), [
      "Profile",
      "Work authorization",
      "Preferences",
      "Schedule"
    ]);

    const fields = extraction.report.forms[0].sections.flatMap((section) => section.fields);
    assert.deepEqual(fields.map((field) => field.fieldType), [
      "TEXT", "EMAIL", "TEL", "URL", "TEXTAREA", "NUMBER", "DATE", "SELECT_ONE", "SELECT_MANY",
      "FILE_UPLOAD", "RADIO_GROUP", "CHECKBOX_BOOLEAN", "CHECKBOX_GROUP"
    ]);
    assert.deepEqual(fields[0], {
      question: "Full name Legal name",
      helpText: null,
      fieldType: "TEXT",
      unsupportedReason: null,
      required: true,
      autocomplete: "name",
      constraints: {
        minLength: 2,
        maxLength: 80,
        min: null,
        max: null,
        step: null,
        acceptedFileTypes: [],
        multiple: false
      },
      choices: []
    });
    assert.equal(fields[1].question, "Email address");
    assert.equal(fields[2].question, "Phone number");
    assert.equal(fields[3].question, "Portfolio URL");
    assert.equal(fields[4].helpText, "Plain text is accepted.");
    assert.deepEqual(fields[5].constraints, {
      minLength: null, maxLength: null, min: "0", max: "40", step: "0.5", acceptedFileTypes: [], multiple: false
    });
    assert.deepEqual(fields[6].constraints, {
      minLength: null, maxLength: null, min: "2026-01-01", max: "2027-12-31", step: "1", acceptedFileTypes: [], multiple: false
    });
    assert.deepEqual(fields[7].choices, [
      { label: "Choose a location", disabled: false },
      { label: "United States: New York", disabled: false }
    ]);
    assert.deepEqual(fields[8].choices, [
      { label: "TypeScript", disabled: false },
      { label: "Go", disabled: false }
    ]);
    assert.deepEqual(fields[9].constraints.acceptedFileTypes, ["PDF", "DOC", "TXT"]);
    assert.deepEqual(fields[10].choices, [
      { label: "Yes", disabled: false },
      { label: "No", disabled: true }
    ]);
    assert.equal(fields[10].required, true);
    assert.deepEqual(fields[12].choices, [
      { label: "Weekdays", disabled: false },
      { label: "Weekends", disabled: false }
    ]);

    assert.equal(extraction.fields.length, fields.length);
    const expectedTestIds = [
      "full-name", "email", "phone", "portfolio", "cover-letter", "experience", "start-date", "location",
      "skills", "resume", "auth-yes", "remote", "weekday"
    ];
    for (const [index, reference] of extraction.fields.entries()) {
      assert.deepEqual(reference.sourceOrdinal, {
        form: 0,
        section: index < 10 ? 0 : index === 10 ? 1 : index === 11 ? 2 : 3,
        field: index < 10 ? index : 0
      });
      assert.equal(await reference.handle.getAttribute("data-testid"), expectedTestIds[index]);
    }
    assert.deepEqual(extraction.fields[10].choices.map((choice) => choice.sourceOrdinal), [
      { form: 0, section: 1, field: 0, choice: 0 },
      { form: 0, section: 1, field: 0, choice: 1 }
    ]);
    assert.equal(await extraction.fields[10].choices[1].handle.getAttribute("data-testid"), "auth-no");
    await extraction.dispose();
    await extraction.dispose();
    await assert.rejects(extraction.fields[0].handle.getAttribute("data-testid"));
  });
});

test("disposal tolerates an already closed employer page", async () => {
  await withFixture(nativeApplicationFixture(), async (page) => {
    const extraction = await extractSafeApplicationForm(page);
    await page.close();
    await assert.doesNotReject(extraction.dispose());
    await assert.doesNotReject(extraction.dispose());
  });
});

test("uses native form ownership, deterministic sections, visibility, and truthful disabled choices", async () => {
  await withFixture(ownershipAndVisibilityFixture(), async (page) => {
    const extraction = await extractSafeApplicationForm(page);
    assert.deepEqual(extraction.report.forms.map((form) => form.title), ["First form", "External controls"]);
    assert.deepEqual(extraction.report.forms[0].sections, [{
      heading: "Choices",
      fields: [{
        question: "Level",
        helpText: null,
        fieldType: "SELECT_ONE",
        unsupportedReason: null,
        required: false,
        autocomplete: null,
        constraints: {
          minLength: null, maxLength: null, min: null, max: null, step: null, acceptedFileTypes: [], multiple: false
        },
        choices: [
          { label: "Enabled placeholder", disabled: false },
          { label: "Advanced: Principal", disabled: true },
          { label: "Staff", disabled: true },
          { label: "Senior", disabled: false }
        ]
      }]
    }]);
    assert.deepEqual(extraction.report.forms[1].sections, [{
      heading: null,
      fields: [{
        question: "Externally associated",
        helpText: null,
        fieldType: "TEXT",
        unsupportedReason: null,
        required: false,
        autocomplete: null,
        constraints: {
          minLength: null, maxLength: null, min: null, max: null, step: null, acceptedFileTypes: [], multiple: false
        },
        choices: []
      }]
    }]);
    assert.equal(await extraction.fields[1].handle.getAttribute("data-testid"), "external");
    await extraction.dispose();
  });
});

test("returns clean unsupported descriptors without leaking incompatible native semantics", async () => {
  await withFixture(fileAndUnsupportedFixture(), async (page) => {
    const extraction = await extractSafeApplicationForm(page);
    const fields = extraction.report.forms[0].sections[0].fields;
    assert.deepEqual(fields[0].constraints, {
      minLength: null, maxLength: null, min: null, max: null, step: null,
      acceptedFileTypes: ["DOCX", "RTF"], multiple: true
    });
    for (const [index, reason] of ["UNSUPPORTED_CONTROL", "UNSUPPORTED_CONTROL", "CUSTOM_COMBOBOX", "RICH_TEXT"].entries()) {
      const field = fields[index + 1];
      assert.equal(field.fieldType, "UNSUPPORTED");
      assert.equal(field.unsupportedReason, reason);
      assert.equal(field.autocomplete, null);
      assert.deepEqual(field.constraints, {
        minLength: null, maxLength: null, min: null, max: null, step: null, acceptedFileTypes: [], multiple: false
      });
      assert.deepEqual(field.choices, []);
    }
    assert.equal(JSON.stringify(extraction.report).includes("SECRET-RICH-TEXT-CURRENT-CONTENT"), false);
    await extraction.dispose();
  });
});

test("does not read applicant state or option identities and performs zero employer mutation", async () => {
  await withFixture(privacyFixture(), async (page) => {
    const extraction = await extractSafeApplicationForm(page);
    const serialized = JSON.stringify(extraction.report);
    for (const secret of [SECRET_HIDDEN_VALUE, SECRET_PASSWORD_VALUE, SECRET_OPTION_VALUE, "SECRET-TEXT-CURRENT-VALUE", "SECRET-TEXTAREA-CURRENT-VALUE"]) {
      assert.equal(serialized.includes(secret), false);
    }
    assert.equal(serialized.includes(PROMPT_LIKE_EMPLOYER_TEXT), true);
    assert.deepEqual(await readFormInspectionTraps(page), {
      inputValue: 0,
      textAreaValue: 0,
      selectValue: 0,
      checked: 0,
      optionSelected: 0,
      files: 0,
      hiddenValue: 0,
      passwordValue: 0,
      mutations: 0,
      submissions: 0,
      events: { click: 0, keydown: 0, beforeinput: 0, input: 0, change: 0, submit: 0, formdata: 0 }
    });
    await extraction.dispose();
  });
});

test("fails completely for a visible password without reading its value", async () => {
  await withFixture(privacyFixture({ visiblePassword: true }), async (page) => {
    await assert.rejects(
      extractSafeApplicationForm(page),
      (error) => assertExtractionCode(error, "EMPLOYER_AUTH_REQUIRED_UNSUPPORTED")
    );
    const traps = await readFormInspectionTraps(page);
    assert.equal(traps.passwordValue, 0);
    assert.equal(traps.hiddenValue, 0);
    assert.equal(traps.mutations, 0);
  });
});

test("fails completely for ownerless, iframe, shadow, and unrepresentable multiple-file structures", async (context) => {
  const cases = [
    ownerlessFixture(),
    iframeFixture(),
    shadowFixture(),
    interactiveAriaFixture(),
    unknownMultipleFileFixture()
  ];
  for (const html of cases) {
    await context.test("unsafe structure", async () => {
      await withFixture(html, async (page) => {
        await assert.rejects(
          extractSafeApplicationForm(page),
          (error) => assertExtractionCode(error, "FORM_STRUCTURE_UNSUPPORTED")
        );
        assert.equal((await readFormInspectionTraps(page)).mutations, 0);
      });
    });
  }
});

test("fails completely for every obvious unrepresented ARIA application widget", async (context) => {
  for (const role of ["switch", "slider", "spinbutton", "listbox"] as const) {
    await context.test(`role=${role}`, async () => {
      await withFixture(obviousAriaRoleFixture(role), async (page) => {
        await assert.rejects(
          extractSafeApplicationForm(page),
          (error) => assertExtractionCode(error, "FORM_STRUCTURE_UNSUPPORTED")
        );
        assert.equal((await readFormInspectionTraps(page)).mutations, 0);
      });
    });
  }
});

test("scans exact included semantic roots and ignores an unrelated iframe", async (context) => {
  await context.test("rejects an iframe inside an included external radiogroup", async () => {
    await withFixture(externalGroupIframeFixture(), async (page) => {
      await assert.rejects(
        extractSafeApplicationForm(page),
        (error) => assertExtractionCode(error, "FORM_STRUCTURE_UNSUPPORTED")
      );
    });
  });
  await context.test("allows an iframe outside every included semantic root", async () => {
    await withFixture(unrelatedIframeFixture(), async (page) => {
      const extraction = await extractSafeApplicationForm(page);
      assert.equal(extraction.report.forms.length, 1);
      assert.equal(extraction.report.forms[0].sections[0].fields.length, 1);
      await extraction.dispose();
    });
  });
});

test("fails completely for nested and open-shadow custom interactions", async (context) => {
  await context.test("nested listbox in a represented custom combobox", async () => {
    await withFixture(nestedCustomInteractionFixture(), async (page) => {
      await assert.rejects(
        extractSafeApplicationForm(page),
        (error) => assertExtractionCode(error, "FORM_STRUCTURE_UNSUPPORTED")
      );
    });
  });
  await context.test("switch in an open custom-element shadow root", async () => {
    await withFixture(shadowInteractionFixture(), async (page) => {
      await assert.rejects(
        extractSafeApplicationForm(page),
        (error) => assertExtractionCode(error, "FORM_STRUCTURE_UNSUPPORTED")
      );
    });
  });
  await context.test("button in an open shadow root on a represented non-hyphen combobox", async () => {
    await withFixture(nonHyphenShadowComboboxFixture("interactive"), async (page) => {
      await assert.rejects(
        extractSafeApplicationForm(page),
        (error) => assertExtractionCode(error, "FORM_STRUCTURE_UNSUPPORTED")
      );
    });
  });
  await context.test("represented combobox with a registered closed shadow root", async () => {
    await withFixture(closedShadowComboboxFixture(), async (page) => {
      await assert.rejects(
        extractSafeApplicationForm(page),
        (error) => assertExtractionCode(error, "FORM_STRUCTURE_UNSUPPORTED")
      );
    });
  });
});

test("allows passive open shadow content on a represented non-hyphen combobox", async () => {
  await withFixture(nonHyphenShadowComboboxFixture("passive"), async (page) => {
    const extraction = await extractSafeApplicationForm(page);
    const fields = extraction.report.forms[0].sections[0].fields;
    assert.deepEqual(fields.map((field) => field.fieldType), ["TEXT", "UNSUPPORTED"]);
    assert.equal(fields[1].unsupportedReason, "CUSTOM_COMBOBOX");
    assert.equal(extraction.fields.length, 2);
    await extraction.dispose();
  });
});

test("rejects unexpected enumerable properties in the opaque remote reference arrays", async () => {
  await withFixture(nativeApplicationFixture(), async (page) => {
    await page.evaluate(() => {
      const nativeMap = Array.prototype.map;
      Array.prototype.map = function <U>(
        this: unknown[],
        callback: (value: unknown, index: number, array: unknown[]) => U,
        thisArgument?: unknown
      ): U[] {
        const result = nativeMap.call(this, callback, thisArgument) as U[];
        Object.defineProperty(result, "unexpected", { enumerable: true, value: "not-source-identity" });
        return result;
      };
    });
    await assert.rejects(
      extractSafeApplicationForm(page),
      (error) => assertExtractionCode(error, "FORM_INSPECTION_INVALID")
    );
  });
});

test("enforces structural and safe-text limits without truncation", async (context) => {
  await context.test("accepts exact field and question limits", async () => {
    const question = "q".repeat(FORM_INSPECTION_TEXT_LIMITS.question.codePoints);
    await withFixture(repeatedFieldsFixture(MAX_FIELDS_TOTAL, question), async (page) => {
      const extraction = await extractSafeApplicationForm(page);
      assert.equal(extraction.report.forms[0].sections[0].fields.length, MAX_FIELDS_TOTAL);
      assert.equal(extraction.report.forms[0].sections[0].fields[0].question, question);
      await extraction.dispose();
    });
  });
  await context.test("rejects one field over", async () => {
    await withFixture(repeatedFieldsFixture(MAX_FIELDS_TOTAL + 1, "Question"), async (page) => {
      await assert.rejects(
        extractSafeApplicationForm(page),
        (error) => assertExtractionCode(error, "FORM_INSPECTION_OVERSIZE")
      );
    });
  });
  await context.test("rejects one question code point over", async () => {
    const question = "q".repeat(FORM_INSPECTION_TEXT_LIMITS.question.codePoints + 1);
    await withFixture(repeatedFieldsFixture(1, question), async (page) => {
      await assert.rejects(
        extractSafeApplicationForm(page),
        (error) => assertExtractionCode(error, "FORM_INSPECTION_OVERSIZE")
      );
    });
  });
  // The frozen 4:1 guard ratio means well-formed Unicode can only reach these two
  // question limits together; an independently binding UTF-8-byte case is impossible.
  await context.test("accepts the joint 500-code-point and 2000-byte Unicode boundary", async () => {
    const question = "\u{1F680}".repeat(FORM_INSPECTION_TEXT_LIMITS.question.codePoints);
    assert.equal([...question].length, 500);
    assert.equal(Buffer.byteLength(question, "utf8"), 2_000);
    await withFixture(repeatedFieldsFixture(1, question), async (page) => {
      const extraction = await extractSafeApplicationForm(page);
      assert.equal(extraction.report.forms[0].sections[0].fields[0].question, question);
      await extraction.dispose();
    });
  });
  await context.test("rejects 501 four-byte scalars at the joint one-over boundary", async () => {
    const question = "\u{1F680}".repeat(FORM_INSPECTION_TEXT_LIMITS.question.codePoints + 1);
    assert.equal([...question].length, 501);
    assert.equal(Buffer.byteLength(question, "utf8"), 2_004);
    await withFixture(repeatedFieldsFixture(1, question), async (page) => {
      await assert.rejects(
        extractSafeApplicationForm(page),
        (error) => assertExtractionCode(error, "FORM_INSPECTION_OVERSIZE")
      );
    });
  });
  await context.test("accepts the exact qualifying-form limit", async () => {
    await withFixture(repeatedFormsFixture(MAX_FORMS), async (page) => {
      const extraction = await extractSafeApplicationForm(page);
      assert.equal(extraction.report.forms.length, 4);
      await extraction.dispose();
    });
  });
  await context.test("rejects one form over", async () => {
    await withFixture(repeatedFormsFixture(MAX_FORMS + 1), async (page) => {
      await assert.rejects(
        extractSafeApplicationForm(page),
        (error) => assertExtractionCode(error, "FORM_INSPECTION_OVERSIZE")
      );
    });
  });
});
