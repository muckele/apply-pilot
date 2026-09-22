import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { chromium, type Browser, type Page } from "playwright";

import { MISSING_CHROMIUM_MESSAGE } from "@/lib/application-browser/browser-runtime";
import {
  correlateProtectedApplicationFormExtraction,
  type CorrelatedProtectedApplicationFormExtraction
} from "@/lib/application-browser/form-inspection-correlation";
import {
  createProtectedApplicationBrowserSession,
  type ProtectedApplicationBrowserSession,
  type ProtectedApplicationFormExtraction,
  type ProtectedCandidateFieldWriteRequest,
  type ProtectedWriterTargetBinding
} from "@/lib/application-browser/protected-browser-session";
import type { NormalizedApplicationFormField } from "@/lib/application-runs/form-inspection";

import {
  assertNoSubmission,
  createFormFillFixturePage
} from "./form-fill-fixtures";

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

type WriterFixture = Readonly<{
  page: Page;
  session: ProtectedApplicationBrowserSession;
  correlated: CorrelatedProtectedApplicationFormExtraction;
  traps: Awaited<ReturnType<typeof createFormFillFixturePage>>["traps"];
}>;

async function writerFixture(
  observeSeal?: (
    extraction: ProtectedApplicationFormExtraction,
    bindings: readonly ProtectedWriterTargetBinding[]
  ) => void
): Promise<WriterFixture> {
  let protectedSession: ProtectedApplicationBrowserSession | null = null;
  const fixture = await createFormFillFixturePage(browser, async (page) => {
    protectedSession = await createProtectedApplicationBrowserSession({ page });
  });
  assert.ok(protectedSession);
  const session = protectedSession as ProtectedApplicationBrowserSession;
  await session.waitUntilReady();
  const extraction = await session.extractApplicationForm();
  const correlationExtraction: ProtectedApplicationFormExtraction = observeSeal ? {
    candidate: extraction.candidate,
    report: extraction.report,
    fields: extraction.fields,
    async sealWriterTargets(bindings) {
      observeSeal(extraction, bindings);
      await extraction.sealWriterTargets(bindings);
    },
    dispose: () => extraction.dispose()
  } : extraction;
  const correlated = await correlateProtectedApplicationFormExtraction({
    extraction: correlationExtraction,
    authoritativeApplyHost: "fixture.invalid"
  });
  return { page: fixture.page, session, correlated, traps: fixture.traps };
}

async function cleanup(value: WriterFixture): Promise<void> {
  await value.correlated.dispose().catch(() => undefined);
  await value.session.close();
  await value.page.context().close();
}

function fields(value: WriterFixture): NormalizedApplicationFormField[] {
  return value.correlated.normalizedSnapshot.forms.flatMap((form) =>
    form.sections.flatMap((section) => section.fields)
  );
}

function fieldFor(value: WriterFixture, question: string): NormalizedApplicationFormField {
  const matches = fields(value).filter((field) => field.question === question);
  assert.equal(matches.length, 1, `expected one normalized field for ${question}`);
  return matches[0];
}

function sourceFieldFor(
  extraction: ProtectedApplicationFormExtraction,
  question: string
): Readonly<{
  field: ProtectedApplicationFormExtraction["report"]["forms"][number]["sections"][number]["fields"][number];
  sourceOrdinal: Readonly<{ form: number; section: number; field: number }>;
}> {
  const matches = extraction.report.forms.flatMap((form, formIndex) =>
    form.sections.flatMap((section, sectionIndex) =>
      section.fields.flatMap((field, fieldIndex) => field.question === question ? [{
        field,
        sourceOrdinal: { form: formIndex, section: sectionIndex, field: fieldIndex }
      }] : [])
    )
  );
  assert.equal(matches.length, 1, `expected one protected source field for ${question}`);
  return matches[0];
}

function bindingForSource(
  bindings: readonly ProtectedWriterTargetBinding[],
  sourceOrdinal: Readonly<{ form: number; section: number; field: number }>
): ProtectedWriterTargetBinding | undefined {
  return bindings.find((binding) =>
    binding.sourceOrdinal.form === sourceOrdinal.form &&
    binding.sourceOrdinal.section === sourceOrdinal.section &&
    binding.sourceOrdinal.field === sourceOrdinal.field
  );
}

function requestFor(
  field: NormalizedApplicationFormField,
  proposal: ProtectedCandidateFieldWriteRequest["proposal"]
): ProtectedCandidateFieldWriteRequest {
  return {
    normalizedFieldKey: field.normalizedFieldKey,
    fieldFingerprint: field.fieldFingerprint,
    fieldType: field.fieldType as ProtectedCandidateFieldWriteRequest["fieldType"],
    proposal
  };
}

function choiceKeyFor(field: NormalizedApplicationFormField, label: string): string {
  const matches = field.choices.filter((choice) => choice.label === label);
  assert.equal(matches.length, 1, `expected one normalized choice for ${label}`);
  return matches[0].key;
}

function assertNoInteractionAuthority(traps: Awaited<ReturnType<WriterFixture["traps"]>>): void {
  assert.equal(traps.beforeinput, 0);
  assert.equal(traps.click, 0);
  assert.equal(traps.focus, 0);
  assert.equal(traps.keyboard, 0);
  assert.equal(traps.pointer, 0);
  assert.equal(traps.mouse, 0);
  assertNoSubmission(traps);
}

test("protected V2 writes each empty native text-like subtype including search once", async () => {
  let observedSearchBinding = false;
  const value = await writerFixture((extraction, bindings) => {
    const search = sourceFieldFor(extraction, "Empty search");
    assert.equal(search.field.fieldType, "TEXT");
    assert.equal(bindingForSource(bindings, search.sourceOrdinal)?.fieldType, "TEXT");
    for (const question of ["Empty radio", "Unchecked checkbox"]) {
      const unsupported = sourceFieldFor(extraction, question);
      assert.equal(bindingForSource(bindings, unsupported.sourceOrdinal), undefined);
    }
    observedSearchBinding = true;
  });
  try {
    const cases = [
      ["Empty text", "text-empty", "TEXT", "Alice Example"],
      ["Empty search", "search-empty", "TEXT", "search terms"],
      ["Empty email", "email-empty", "EMAIL", "alice@example.test"],
      ["Empty telephone", "tel-empty", "TEL", "+1 555 0100"],
      ["Empty URL", "url-empty", "URL", "https://portfolio.example.test"],
      ["Empty textarea", "textarea-empty", "TEXTAREA", "Exact applicant statement"]
    ] as const;

    assert.equal(observedSearchBinding, true);
    for (const [question, , fieldType, proposal] of cases) {
      const field = fieldFor(value, question);
      assert.equal(field.fieldType, fieldType);
      assert.deepEqual(
        await value.session.writeCandidateField(
          value.correlated.candidate,
          requestFor(field, { kind: "SCALAR", value: proposal })
        ),
        { status: "FILLED" }
      );
    }

    const observed = await value.page.evaluate((ids) => Object.fromEntries(ids.map((id) => [
      id,
      (document.getElementById(id) as HTMLInputElement | HTMLTextAreaElement).value
    ])), cases.map((entry) => entry[1]));
    assert.deepEqual(observed, Object.fromEntries(cases.map(([, id, , proposal]) => [id, proposal])));
    assert.equal(await value.page.locator("#text-occupied").inputValue(), "SECRET-OCCUPIED-TEXT");

    const traps = await value.traps();
    assert.equal(traps.input, cases.length);
    assert.equal(traps.change, 0);
    assert.equal(traps.inputSetter, 0);
    assert.equal(traps.textAreaSetter, 0);
    assert.equal(traps.optionSetter, 0);
    assert.equal(traps.eventConstructor, 0);
    assert.equal(traps.dispatchEvent, 0);
    assert.equal(traps.beforeinput, 0);
    assert.equal(traps.click, 0);
    assert.equal(traps.focus, 0);
    assert.equal(traps.keyboard, 0);
    assert.equal(traps.pointer, 0);
    assert.equal(traps.mouse, 0);
    assert.deepEqual(traps.eventLog, cases.map(([, id]) => `${id}:input`));
    assert.equal(traps.eventLog.filter((entry) => entry === "search-empty:input").length, 1);
    assert.deepEqual(traps.eventDetails, cases.map(([, id]) => ({
      target: id,
      type: "input",
      bubbles: true,
      cancelable: false,
      composed: false,
      isTrusted: false
    })));
    assertNoSubmission(traps);
  } finally {
    await cleanup(value);
  }
});

test("protected V2 preserves occupied and whitespace-only text-like inputs exactly", async () => {
  const value = await writerFixture();
  try {
    const occupiedProposal = "PROPOSAL-MUST-NOT-LEAK";
    const occupiedSearchProposal = "SEARCH-PROPOSAL-MUST-NOT-LEAK";
    const occupied = await value.session.writeCandidateField(
      value.correlated.candidate,
      requestFor(fieldFor(value, "Occupied text"), { kind: "SCALAR", value: occupiedProposal })
    );
    const whitespace = await value.session.writeCandidateField(
      value.correlated.candidate,
      requestFor(fieldFor(value, "Whitespace text"), { kind: "SCALAR", value: "replacement" })
    );
    const occupiedSearch = await value.session.writeCandidateField(
      value.correlated.candidate,
      requestFor(fieldFor(value, "Occupied search"), {
        kind: "SCALAR",
        value: occupiedSearchProposal
      })
    );
    const whitespaceSearch = await value.session.writeCandidateField(
      value.correlated.candidate,
      requestFor(fieldFor(value, "Whitespace search"), { kind: "SCALAR", value: "replacement" })
    );
    const readOnly = await value.session.writeCandidateField(
      value.correlated.candidate,
      requestFor(fieldFor(value, "Read only text"), { kind: "SCALAR", value: "replacement" })
    );

    assert.deepEqual(occupied, { status: "PRESERVED_EXISTING" });
    assert.deepEqual(whitespace, { status: "PRESERVED_EXISTING" });
    assert.deepEqual(occupiedSearch, { status: "PRESERVED_EXISTING" });
    assert.deepEqual(whitespaceSearch, { status: "PRESERVED_EXISTING" });
    assert.deepEqual(readOnly, { status: "MANUAL", reason: "UNWRITABLE" });
    const serialized = JSON.stringify([
      occupied,
      whitespace,
      occupiedSearch,
      whitespaceSearch,
      readOnly
    ]);
    for (const secret of [
      "SECRET-OCCUPIED-TEXT",
      "SECRET-OCCUPIED-SEARCH",
      occupiedProposal,
      occupiedSearchProposal,
      "   "
    ]) {
      assert.equal(serialized.includes(secret), false);
    }
    assert.deepEqual(await value.page.evaluate(() => ({
      occupied: (document.getElementById("text-occupied") as HTMLInputElement).value,
      whitespace: (document.getElementById("text-whitespace") as HTMLInputElement).value,
      occupiedSearch: (document.getElementById("search-occupied") as HTMLInputElement).value,
      whitespaceSearch: (document.getElementById("search-whitespace") as HTMLInputElement).value,
      readOnly: (document.getElementById("readonly-empty") as HTMLInputElement).value
    })), {
      occupied: "SECRET-OCCUPIED-TEXT",
      whitespace: "   ",
      occupiedSearch: "SECRET-OCCUPIED-SEARCH",
      whitespaceSearch: "   ",
      readOnly: ""
    });
    const traps = await value.traps();
    assert.equal(traps.input, 0);
    assert.equal(traps.change, 0);
    assertNoInteractionAuthority(traps);
  } finally {
    await cleanup(value);
  }
});

test("initially disabled supported controls require a fresh enabled candidate", async () => {
  const value = await writerFixture();
  let refreshed: CorrelatedProtectedApplicationFormExtraction | null = null;
  try {
    const initialQuestions = fields(value).map((field) => field.question);
    assert.equal(initialQuestions.includes("Disabled text"), false);
    assert.equal(initialQuestions.includes("Disabled select"), false);
    assert.deepEqual(await value.page.evaluate(() => ({
      textDisabled: (document.getElementById("disabled-empty") as HTMLInputElement).disabled,
      textValue: (document.getElementById("disabled-empty") as HTMLInputElement).value,
      selectDisabled: (document.getElementById("select-disabled") as HTMLSelectElement).disabled,
      selectValue: (document.getElementById("select-disabled") as HTMLSelectElement).value
    })), {
      textDisabled: true,
      textValue: "",
      selectDisabled: true,
      selectValue: ""
    });
    assertNoInteractionAuthority(await value.traps());

    await value.page.evaluate(() => {
      (document.getElementById("disabled-empty") as HTMLInputElement).disabled = false;
      (document.getElementById("select-disabled") as HTMLSelectElement).disabled = false;
    });
    assert.deepEqual(
      await value.session.verifyCandidate(value.correlated.candidate),
      { status: "INVALID" }
    );

    refreshed = await correlateProtectedApplicationFormExtraction({
      extraction: await value.session.extractApplicationForm(),
      authoritativeApplyHost: "fixture.invalid"
    });
    const refreshedFields = refreshed.normalizedSnapshot.forms.flatMap((form) =>
      form.sections.flatMap((section) => section.fields)
    );
    const textField = refreshedFields.find((field) => field.question === "Disabled text");
    const selectField = refreshedFields.find((field) => field.question === "Disabled select");
    assert.ok(textField);
    assert.ok(selectField);

    assert.deepEqual(
      await value.session.writeCandidateField(
        refreshed.candidate,
        requestFor(textField, { kind: "SCALAR", value: "Fresh candidate only" })
      ),
      { status: "FILLED" }
    );
    assert.deepEqual(
      await value.session.writeCandidateField(
        refreshed.candidate,
        requestFor(selectField, {
          kind: "OPTIONS",
          optionKeys: [choiceKeyFor(selectField, "A")]
        })
      ),
      { status: "FILLED" }
    );
    assert.deepEqual(await value.page.evaluate(() => ({
      text: (document.getElementById("disabled-empty") as HTMLInputElement).value,
      select: (document.getElementById("select-disabled") as HTMLSelectElement).value
    })), {
      text: "Fresh candidate only",
      select: "A"
    });

    const traps = await value.traps();
    assert.equal(traps.input, 2);
    assert.equal(traps.change, 1);
    assert.deepEqual(traps.eventLog, [
      "disabled-empty:input",
      "select-disabled:input",
      "select-disabled:change"
    ]);
    assertNoInteractionAuthority(traps);
  } finally {
    await refreshed?.dispose().catch(() => undefined);
    await cleanup(value);
  }
});

test("protected V2 writes SELECT_ONE only from a disabled exact-empty placeholder", async () => {
  const value = await writerFixture();
  try {
    const field = fieldFor(value, "Empty select");
    const result = await value.session.writeCandidateField(
      value.correlated.candidate,
      requestFor(field, { kind: "OPTIONS", optionKeys: [choiceKeyFor(field, "A")] })
    );
    assert.deepEqual(result, { status: "FILLED" });
    assert.equal(await value.page.locator("#select-empty").inputValue(), "SECRET-A");
    assert.equal((await value.page.locator("#placeholder-a").evaluate((option: HTMLOptionElement) => option.selected)), false);
    assert.equal((await value.page.locator("#choice-a").evaluate((option: HTMLOptionElement) => option.selected)), true);

    const traps = await value.traps();
    assert.equal(traps.input, 1);
    assert.equal(traps.change, 1);
    assert.equal(traps.optionSetter, 0);
    assert.equal(traps.eventConstructor, 0);
    assert.equal(traps.dispatchEvent, 0);
    assert.deepEqual(traps.eventLog, ["select-empty:input", "select-empty:change"]);
    assert.deepEqual(traps.eventDetails, ["input", "change"].map((type) => ({
      target: "select-empty",
      type,
      bubbles: true,
      cancelable: false,
      composed: false,
      isTrusted: false
    })));
    assertNoInteractionAuthority(traps);
  } finally {
    await cleanup(value);
  }
});

test("protected V2 preserves every non-placeholder SELECT_ONE state and rejects a disabled proposal", async () => {
  const value = await writerFixture();
  try {
    const preservationCases = [
      ["Occupied select", "C"],
      ["Enabled empty select", "Yes"],
      ["Enabled empty proposed select", "Yes"],
      ["Disabled nonempty select", "Yes"]
    ] as const;
    for (const [question, proposedLabel] of preservationCases) {
      const field = fieldFor(value, question);
      assert.deepEqual(
        await value.session.writeCandidateField(
          value.correlated.candidate,
          requestFor(field, { kind: "OPTIONS", optionKeys: [choiceKeyFor(field, proposedLabel)] })
        ),
        { status: "PRESERVED_EXISTING" }
      );
    }

    const disabledTarget = fieldFor(value, "Disabled option select");
    assert.deepEqual(
      await value.session.writeCandidateField(
        value.correlated.candidate,
        requestFor(disabledTarget, {
          kind: "OPTIONS",
          optionKeys: [choiceKeyFor(disabledTarget, "A")]
        })
      ),
      { status: "MANUAL", reason: "UNWRITABLE" }
    );
    const effectivePlaceholder = fieldFor(value, "Disabled optgroup select");
    assert.deepEqual(
      await value.session.writeCandidateField(
        value.correlated.candidate,
        requestFor(effectivePlaceholder, {
          kind: "OPTIONS",
          optionKeys: [choiceKeyFor(effectivePlaceholder, "Yes")]
        })
      ),
      { status: "FILLED" }
    );
    const traps = await value.traps();
    assert.equal(traps.input, 1);
    assert.equal(traps.change, 1);
    assertNoInteractionAuthority(traps);
  } finally {
    await cleanup(value);
  }
});

test("protected V2 invalidates no-selection and applicant-activity candidates before mutation", async (context) => {
  await context.test("no selection", async () => {
    const value = await writerFixture();
    try {
      const field = fieldFor(value, "No selection select");
      assert.deepEqual(
        await value.session.writeCandidateField(
          value.correlated.candidate,
          requestFor(field, { kind: "OPTIONS", optionKeys: [choiceKeyFor(field, "Yes")] })
        ),
        { status: "FAILED", reason: "TARGET_INVALID" }
      );
      assert.equal((await value.traps()).input, 0);
    } finally {
      await cleanup(value);
    }
  });

  await context.test("applicant input after sealing", async () => {
    const value = await writerFixture();
    try {
      await value.page.dispatchEvent("#text-occupied", "input");
      const field = fieldFor(value, "Empty text");
      assert.deepEqual(
        await value.session.writeCandidateField(
          value.correlated.candidate,
          requestFor(field, { kind: "SCALAR", value: "must not write" })
        ),
        { status: "FAILED", reason: "CANDIDATE_INVALID" }
      );
      assert.equal(await value.page.locator("#text-empty").inputValue(), "");
      assert.equal((await value.traps()).input, 1);
    } finally {
      await cleanup(value);
    }
  });
});

test("protected V2 rejects stale search replacement or mismatched semantic targets", async (context) => {
  const cases = ["replacement", "field key", "fingerprint", "family", "choice key"] as const;
  for (const kind of cases) {
    await context.test(kind, async () => {
      const value = await writerFixture();
      try {
        const targetQuestion = kind === "replacement" ? "Empty search" : "Empty text";
        const targetId = kind === "replacement" ? "search-empty" : "text-empty";
        const textField = fieldFor(value, targetQuestion);
        let request: ProtectedCandidateFieldWriteRequest = requestFor(
          textField,
          { kind: "SCALAR", value: "must not write" }
        );
        let expectedReason: "CANDIDATE_INVALID" | "TARGET_INVALID" = "TARGET_INVALID";
        if (kind === "replacement") {
          expectedReason = "CANDIDATE_INVALID";
          await value.page.evaluate(() => {
            const control = document.getElementById("search-empty") as HTMLInputElement;
            control.replaceWith(control.cloneNode(true));
          });
        } else if (kind === "field key") {
          request = { ...request, normalizedFieldKey: "a".repeat(64) };
        } else if (kind === "fingerprint") {
          request = { ...request, fieldFingerprint: "b".repeat(64) };
        } else if (kind === "family") {
          request = { ...request, fieldType: "EMAIL" };
        } else {
          const selectField = fieldFor(value, "Empty select");
          request = requestFor(selectField, { kind: "OPTIONS", optionKeys: ["c".repeat(64)] });
        }
        assert.deepEqual(
          await value.session.writeCandidateField(value.correlated.candidate, request),
          { status: "FAILED", reason: expectedReason }
        );
        assert.equal(await value.page.locator(`#${targetId}`).inputValue(), "");
        assert.equal((await value.traps()).input, 0);
      } finally {
        await cleanup(value);
      }
    });
  }
});

test("protected V2 never corrects a hostile postcondition or same-turn target replacement", async (context) => {
  for (const [question, id] of [
    ["Mismatching text", "mismatch-text"],
    ["Replacing text", "replace-text"],
    ["Controlled replacing text", "controlled-replace-text"],
    ["Extra event text", "extra-event-text"]
  ] as const) {
    await context.test(question, async () => {
      const value = await writerFixture();
      try {
        const result = await value.session.writeCandidateField(
          value.correlated.candidate,
          requestFor(fieldFor(value, question), { kind: "SCALAR", value: "one attempt only" })
        );
        assert.deepEqual(result, { status: "FAILED", reason: "UNEXPECTED_ACTIVITY" });
        const traps = await value.traps();
        assert.equal(traps.eventLog.filter((entry) => entry === `${id}:input`).length, 1);
        assertNoInteractionAuthority(traps);
      } finally {
        await cleanup(value);
      }
    });
  }
});

test("protected V2 does not retry when a SELECT_ONE listener reverses the mutation", async () => {
  const value = await writerFixture();
  try {
    const field = fieldFor(value, "Mismatching select");
    assert.deepEqual(
      await value.session.writeCandidateField(
        value.correlated.candidate,
        requestFor(field, { kind: "OPTIONS", optionKeys: [choiceKeyFor(field, "A")] })
      ),
      { status: "FAILED", reason: "UNEXPECTED_ACTIVITY" }
    );
    const traps = await value.traps();
    assert.deepEqual(traps.eventLog, ["select-mismatch:input", "select-mismatch:change"]);
    assert.equal(traps.input, 1);
    assert.equal(traps.change, 1);
    assertNoInteractionAuthority(traps);
  } finally {
    await cleanup(value);
  }
});

test("protected V2 supports a controlled text model without main-world mutation authority", async () => {
  const value = await writerFixture();
  try {
    const result = await value.session.writeCandidateField(
      value.correlated.candidate,
      requestFor(fieldFor(value, "Controlled text"), { kind: "SCALAR", value: "controlled value" })
    );
    assert.deepEqual(result, { status: "FILLED" });
    assert.deepEqual(await value.page.locator("#controlled-text").evaluate((control: HTMLInputElement) => ({
      value: control.value,
      modelValue: control.dataset.modelValue,
      trackedValue: control.dataset.trackedValue,
      renderCount: control.dataset.renderCount,
      frameworkWrites: control.dataset.frameworkWrites
    })), {
      value: "controlled value",
      modelValue: "controlled value",
      trackedValue: "controlled value",
      renderCount: "1",
      frameworkWrites: "1"
    });
    const traps = await value.traps();
    assert.equal(traps.input, 1);
    assert.equal(traps.inputSetter, 0);
    assert.equal(traps.eventConstructor, 0);
    assert.equal(traps.dispatchEvent, 0);
    assertNoInteractionAuthority(traps);
  } finally {
    await cleanup(value);
  }
});
