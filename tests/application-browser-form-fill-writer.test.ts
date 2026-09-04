import assert from "node:assert/strict";
import { before, test } from "node:test";

import type { ElementHandle, Frame, Page } from "playwright";

import { installTrustedFormFillDomCapability } from "@/lib/application-browser/form-fill-dom";
import { writeApplicationFormField } from "@/lib/application-browser/form-fill-writer";
import type { ApplicationAnswerProposal } from "@/lib/application-runs/answer-packet-domain";

type ScriptStep = unknown | Error;
type HandleCallCounts = { evaluate: number; check: number };
let scriptedUrl = "about:blank";
let scriptedDomContentLoaded: (() => void) | undefined;
const scriptedMainFrame = { page: () => scriptedPage, url: () => scriptedUrl } as unknown as Frame;
const scriptedChildFrame = { page: () => scriptedPage, url: () => "data:text/html,child" } as unknown as Frame;
const scriptedPage = {
  url: () => scriptedUrl,
  mainFrame: () => scriptedMainFrame,
  addInitScript: async () => undefined,
  on(event: string, listener: () => void) {
    if (event === "domcontentloaded") scriptedDomContentLoaded = listener;
    return scriptedPage;
  },
  off: () => scriptedPage
} as unknown as Page;

before(async () => {
  await installTrustedFormFillDomCapability(scriptedPage);
  scriptedUrl = "data:text/html,fixture";
  scriptedDomContentLoaded?.();
});

function scriptedHandle(
  steps: ScriptStep[],
  onCheck?: () => Promise<void>,
  counts?: HandleCallCounts,
  frame: Frame = scriptedMainFrame
): ElementHandle {
  return {
    async ownerFrame() {
      return frame;
    },
    async evaluate() {
      if (counts) counts.evaluate += 1;
      const step = steps.shift();
      if (step instanceof Error) throw step;
      return step;
    },
    async check() {
      if (counts) counts.check += 1;
      await onCheck?.();
    }
  } as unknown as ElementHandle;
}

const scalar = (value = "Ada Lovelace") => ({ kind: "SCALAR", value } as const);
const options = { kind: "OPTIONS", optionKeys: ["a".repeat(64)] } satisfies ApplicationAnswerProposal;

test("rejects impossible field/proposal combinations without touching a handle", async () => {
  let calls = 0;
  const handle = scriptedHandle([], async () => { calls += 1; });
  const result = await writeApplicationFormField({
    fieldType: "TEXT",
    handle,
    proposal: { kind: "BOOLEAN", value: true }
  });

  assert.deepEqual(result, { result: "FAILED", errorCode: "FILL_INTERNAL" });
  assert.equal(calls, 0);
});

test("runtime input gate rejects unsupported families and malformed graphs before any handle method", async () => {
  const unsupportedFieldTypes = [
    "NUMBER", "DATE", "SELECT_MANY", "CHECKBOX_GROUP", "FILE_UPLOAD", "UNSUPPORTED", "UNKNOWN"
  ];

  for (const fieldType of unsupportedFieldTypes) {
    const counts = { evaluate: 0, check: 0 };
    const handle = scriptedHandle([], undefined, counts);
    const result = await writeApplicationFormField({ fieldType, handle, proposal: scalar() } as never);
    assert.deepEqual(result, { result: "FAILED", errorCode: "FILL_INTERNAL" }, fieldType);
    assert.deepEqual(counts, { evaluate: 0, check: 0 }, fieldType);
  }

  const malformedInputs = [
    (handle: ElementHandle) => ({ handle, proposal: scalar() }),
    (handle: ElementHandle) => ({ fieldType: "SELECT_ONE", handle, proposal: options }),
    (handle: ElementHandle) => ({ fieldType: "SELECT_ONE", handle, choiceHandles: [], proposal: options }),
    (handle: ElementHandle) => ({ fieldType: "SELECT_ONE", handle, choiceHandles: "not-an-array", proposedChoiceHandle: handle, proposal: options }),
    (handle: ElementHandle) => ({ fieldType: "SELECT_ONE", handle, choiceHandles: [handle, handle], proposedChoiceHandle: handle, proposal: options }),
    (handle: ElementHandle) => ({ fieldType: "SELECT_ONE", handle, choiceHandles: [scriptedHandle([])], proposedChoiceHandle: handle, proposal: options }),
    (handle: ElementHandle) => ({ fieldType: "RADIO_GROUP", handle, proposal: options }),
    (handle: ElementHandle) => ({ fieldType: "RADIO_GROUP", handle, choiceHandles: [], proposedChoiceHandle: handle, proposal: options }),
    (handle: ElementHandle) => ({ fieldType: "RADIO_GROUP", handle, choiceHandles: null, proposedChoiceHandle: handle, proposal: options }),
    (handle: ElementHandle) => ({ fieldType: "TEXT", handle, choiceHandles: [handle], proposedChoiceHandle: handle, proposal: scalar() }),
    (handle: ElementHandle) => ({ fieldType: "CHECKBOX_BOOLEAN", handle, choiceHandles: [handle], proposedChoiceHandle: handle, proposal: { kind: "BOOLEAN", value: true } })
  ];

  for (const [index, makeInput] of malformedInputs.entries()) {
    const counts = { evaluate: 0, check: 0 };
    const handle = scriptedHandle([], undefined, counts);
    const result = await writeApplicationFormField(makeInput(handle) as never);
    assert.deepEqual(result, { result: "FAILED", errorCode: "FILL_INTERNAL" }, `malformed ${index}`);
    assert.deepEqual(counts, { evaluate: 0, check: 0 }, `malformed ${index}`);
  }

  const primaryCounts = { evaluate: 0, check: 0 };
  const targetCounts = { evaluate: 0, check: 0 };
  const primary = scriptedHandle(["EMPTY", "MATCHED"], undefined, primaryCounts);
  const target = scriptedHandle([], undefined, targetCounts);
  assert.deepEqual(await writeApplicationFormField({
    fieldType: "RADIO_GROUP", handle: primary, choiceHandles: [target],
    proposedChoiceHandle: target, proposal: options
  }), { result: "FAILED", errorCode: "FILL_INTERNAL" });
  assert.deepEqual(primaryCounts, { evaluate: 0, check: 0 });
  assert.deepEqual(targetCounts, { evaluate: 0, check: 0 });

  let fieldTypeReads = 0;
  const accessorCounts = { evaluate: 0, check: 0 };
  const accessorHandle = scriptedHandle([], undefined, accessorCounts);
  const accessorInput = {
    get fieldType() {
      fieldTypeReads += 1;
      return fieldTypeReads < 3 ? "TEXT" : "NUMBER";
    },
    handle: accessorHandle,
    proposal: scalar()
  };
  assert.deepEqual(await writeApplicationFormField(accessorInput as never), {
    result: "FAILED", errorCode: "FILL_INTERNAL"
  });
  assert.equal(fieldTypeReads, 0);
  assert.deepEqual(accessorCounts, { evaluate: 0, check: 0 });

  let arrayMethodCalls = 0;
  const choiceArray = [target] as ElementHandle[] & { every: Array<ElementHandle>["every"]; includes: Array<ElementHandle>["includes"] };
  Object.defineProperties(choiceArray, {
    every: { value: () => { arrayMethodCalls += 1; return true; } },
    includes: { value: () => { arrayMethodCalls += 1; return true; } }
  });
  assert.deepEqual(await writeApplicationFormField({
    fieldType: "SELECT_ONE", handle: primary, choiceHandles: choiceArray,
    proposedChoiceHandle: target, proposal: options
  }), { result: "FAILED", errorCode: "FILL_INTERNAL" });
  assert.equal(arrayMethodCalls, 0);
  assert.deepEqual(primaryCounts, { evaluate: 0, check: 0 });
  assert.deepEqual(targetCounts, { evaluate: 0, check: 0 });
});

test("capability authorization rejects pre-navigation and child-frame handles before DOM work", async () => {
  const preNavigationFrame = { page: () => preNavigationPage, url: () => "about:blank" } as unknown as Frame;
  const preNavigationPage = {
    url: () => "about:blank",
    mainFrame: () => preNavigationFrame,
    addInitScript: async () => undefined,
    on: () => preNavigationPage,
    off: () => preNavigationPage
  } as unknown as Page;
  await installTrustedFormFillDomCapability(preNavigationPage);

  const preNavigationCounts = { evaluate: 0, check: 0 };
  const preNavigationHandle = scriptedHandle(
    ["EMPTY", "WRITTEN", "MATCHED"], undefined, preNavigationCounts, preNavigationFrame
  );
  assert.deepEqual(await writeApplicationFormField({
    fieldType: "TEXT", handle: preNavigationHandle, proposal: scalar()
  }), { result: "FAILED", errorCode: "FILL_INTERNAL" });
  assert.deepEqual(preNavigationCounts, { evaluate: 0, check: 0 });

  const childCounts = { evaluate: 0, check: 0 };
  const childHandle = scriptedHandle(["EMPTY", "WRITTEN", "MATCHED"], undefined, childCounts, scriptedChildFrame);
  assert.deepEqual(await writeApplicationFormField({
    fieldType: "TEXT", handle: childHandle, proposal: scalar()
  }), { result: "FAILED", errorCode: "FILL_INTERNAL" });
  assert.deepEqual(childCounts, { evaluate: 0, check: 0 });

  const mixedPrimaryCounts = { evaluate: 0, check: 0 };
  const mixedChoiceCounts = { evaluate: 0, check: 0 };
  const mixedPrimary = scriptedHandle(["EMPTY", "WRITTEN", "MATCHED"], undefined, mixedPrimaryCounts);
  const mixedChildChoice = scriptedHandle([], undefined, mixedChoiceCounts, scriptedChildFrame);
  assert.deepEqual(await writeApplicationFormField({
    fieldType: "SELECT_ONE", handle: mixedPrimary, choiceHandles: [mixedChildChoice],
    proposedChoiceHandle: mixedChildChoice, proposal: options
  }), { result: "FAILED", errorCode: "FILL_INTERNAL" });
  assert.deepEqual(mixedPrimaryCounts, { evaluate: 0, check: 0 });
  assert.deepEqual(mixedChoiceCounts, { evaluate: 0, check: 0 });

  let ownerFrameCalls = 0;
  const transitioningCounts = { evaluate: 0, check: 0 };
  const transitioningHandle = {
    async ownerFrame() {
      ownerFrameCalls += 1;
      return ownerFrameCalls === 1 ? scriptedMainFrame : scriptedChildFrame;
    },
    async evaluate() {
      transitioningCounts.evaluate += 1;
      return "EMPTY";
    },
    async check() {
      transitioningCounts.check += 1;
    }
  } as unknown as ElementHandle;
  assert.deepEqual(await writeApplicationFormField({
    fieldType: "CHECKBOX_BOOLEAN", handle: transitioningHandle,
    proposal: { kind: "BOOLEAN", value: true }
  }), { result: "FAILED", errorCode: "FILL_INTERNAL" });
  assert.deepEqual(transitioningCounts, { evaluate: 1, check: 0 });

  let radioPrimaryFrameCalls = 0;
  let radioTargetFrame: Frame = scriptedMainFrame;
  const radioPrimaryCounts = { evaluate: 0, check: 0 };
  const radioTargetCounts = { evaluate: 0, check: 0 };
  const radioPrimary = {
    async ownerFrame() {
      radioPrimaryFrameCalls += 1;
      if (radioPrimaryFrameCalls === 3) radioTargetFrame = scriptedChildFrame;
      return scriptedMainFrame;
    },
    async evaluate() {
      radioPrimaryCounts.evaluate += 1;
      return "EMPTY";
    },
    async check() {
      radioPrimaryCounts.check += 1;
    }
  } as unknown as ElementHandle;
  const radioTarget = {
    async ownerFrame() {
      return radioTargetFrame;
    },
    async evaluate() {
      radioTargetCounts.evaluate += 1;
      return "MATCHED";
    },
    async check() {
      radioTargetCounts.check += 1;
    }
  } as unknown as ElementHandle;
  assert.deepEqual(await writeApplicationFormField({
    fieldType: "RADIO_GROUP", handle: radioPrimary,
    choiceHandles: [radioTarget, radioPrimary], proposedChoiceHandle: radioTarget,
    proposal: options
  }), { result: "FAILED", errorCode: "FILL_INTERNAL" });
  assert.deepEqual(radioPrimaryCounts, { evaluate: 1, check: 0 });
  assert.deepEqual(radioTargetCounts, { evaluate: 0, check: 0 });
});

test("text-like fields preserve occupied controls with zero writes", async () => {
  const handle = scriptedHandle(["OCCUPIED"]);
  assert.deepEqual(await writeApplicationFormField({ fieldType: "TEXT", handle, proposal: scalar() }), {
    result: "PRESERVED_EXISTING", errorCode: null
  });
  assert.equal((handle.evaluate as unknown as { mock?: unknown }).mock, undefined);
});

test("text-like fields map one native write and closed verification", async () => {
  const matched = scriptedHandle(["EMPTY", "WRITTEN", "MATCHED"]);
  assert.deepEqual(await writeApplicationFormField({ fieldType: "EMAIL", handle: matched, proposal: scalar("a@example.test") }), {
    result: "FILLED", errorCode: null
  });

  const mismatch = scriptedHandle(["EMPTY", "WRITTEN", "MISMATCHED"]);
  assert.deepEqual(await writeApplicationFormField({ fieldType: "TEL", handle: mismatch, proposal: scalar("5550100") }), {
    result: "FAILED", errorCode: "FILL_UNEXPECTED_MUTATION"
  });

  const writeFailure = scriptedHandle(["EMPTY", new Error("SECRET-EMPLOYER-VALUE")]);
  assert.deepEqual(await writeApplicationFormField({ fieldType: "URL", handle: writeFailure, proposal: scalar("https://example.test") }), {
    result: "FAILED", errorCode: "FILL_WRITE_FAILED"
  });
});

test("text-like stable invalid states are manual and detached states fail closed", async () => {
  assert.deepEqual(await writeApplicationFormField({
    fieldType: "TEXTAREA", handle: scriptedHandle(["UNWRITABLE"]), proposal: scalar("Hello")
  }), { result: "MANUAL", errorCode: null });
  assert.deepEqual(await writeApplicationFormField({
    fieldType: "TEXT", handle: scriptedHandle(["DETACHED"]), proposal: scalar()
  }), { result: "FAILED", errorCode: "FILL_UNEXPECTED_MUTATION" });
});

test("missing trusted capability maps to FILL_INTERNAL at every DOM boundary", async () => {
  for (const steps of [
    ["CAPABILITY_MISSING"],
    ["EMPTY", "CAPABILITY_MISSING"],
    ["EMPTY", "WRITTEN", "CAPABILITY_MISSING"]
  ]) {
    assert.deepEqual(await writeApplicationFormField({
      fieldType: "TEXT", handle: scriptedHandle(steps), proposal: scalar()
    }), { result: "FAILED", errorCode: "FILL_INTERNAL" });
  }

  let checks = 0;
  const radio = scriptedHandle(["CAPABILITY_MISSING"]);
  const choice = scriptedHandle([], async () => { checks += 1; });
  assert.deepEqual(await writeApplicationFormField({
    fieldType: "RADIO_GROUP", handle: radio, choiceHandles: [radio, choice], proposedChoiceHandle: choice, proposal: options
  }), { result: "FAILED", errorCode: "FILL_INTERNAL" });
  assert.equal(checks, 0);
});

test("contradictory live control structure fails closed and malformed proposals never reach the page", async () => {
  assert.deepEqual(await writeApplicationFormField({
    fieldType: "TEXT", handle: scriptedHandle(["INVALID"]), proposal: scalar()
  }), { result: "FAILED", errorCode: "FILL_UNEXPECTED_MUTATION" });
  assert.deepEqual(await writeApplicationFormField({
    fieldType: "TEXT", handle: scriptedHandle([]), proposal: { kind: "SCALAR", value: "" }
  }), { result: "FAILED", errorCode: "FILL_INTERNAL" });
});

test("select uses only the exact acquired choice and preserves real selections", async () => {
  const selected = scriptedHandle(["OCCUPIED"]);
  const unusedChoice = scriptedHandle([]);
  assert.deepEqual(await writeApplicationFormField({
    fieldType: "SELECT_ONE", handle: selected, choiceHandles: [unusedChoice], proposedChoiceHandle: unusedChoice,
    proposal: options
  }), { result: "PRESERVED_EXISTING", errorCode: null });

  const choice = scriptedHandle([]);
  const empty = scriptedHandle(["EMPTY", "WRITTEN", "MATCHED"]);
  assert.deepEqual(await writeApplicationFormField({
    fieldType: "SELECT_ONE", handle: empty, choiceHandles: [choice], proposedChoiceHandle: choice, proposal: options
  }), { result: "FILLED", errorCode: null });
});

test("missing select/radio choices and malformed option proposals fail internally before DOM work", async () => {
  const field = scriptedHandle([]);
  const choice = scriptedHandle([]);
  assert.deepEqual(await writeApplicationFormField({
    fieldType: "SELECT_ONE", handle: field, choiceHandles: [], proposedChoiceHandle: choice, proposal: options
  }), { result: "FAILED", errorCode: "FILL_INTERNAL" });
  assert.deepEqual(await writeApplicationFormField({
    fieldType: "RADIO_GROUP", handle: field, choiceHandles: [choice], proposedChoiceHandle: choice,
    proposal: { kind: "OPTIONS", optionKeys: ["a".repeat(64), "b".repeat(64)] }
  }), { result: "FAILED", errorCode: "FILL_INTERNAL" });
});

test("radio invokes check exactly once only from EMPTY and verifies afterward", async () => {
  let checkCount = 0;
  const target = scriptedHandle([], async () => { checkCount += 1; });
  const field = scriptedHandle(["EMPTY", "MATCHED"]);
  assert.deepEqual(await writeApplicationFormField({
    fieldType: "RADIO_GROUP", handle: field, choiceHandles: [field, target], proposedChoiceHandle: target, proposal: options
  }), { result: "FILLED", errorCode: null });
  assert.equal(checkCount, 1);

  checkCount = 0;
  const occupied = scriptedHandle(["OCCUPIED"]);
  assert.deepEqual(await writeApplicationFormField({
    fieldType: "RADIO_GROUP", handle: occupied, choiceHandles: [occupied, target], proposedChoiceHandle: target, proposal: options
  }), { result: "PRESERVED_EXISTING", errorCode: null });
  assert.equal(checkCount, 0);
});

test("checkbox Boolean truth table permits exactly one unchecked-to-true check", async () => {
  const cases = [
    { classification: "EMPTY", proposal: true, result: "FILLED", checks: 1, verification: "MATCHED" },
    { classification: "ALREADY_EQUAL", proposal: false, result: "PRESERVED_EXISTING", checks: 0 },
    { classification: "ALREADY_EQUAL", proposal: true, result: "PRESERVED_EXISTING", checks: 0 },
    { classification: "OCCUPIED_DIFFERENT", proposal: false, result: "MANUAL", checks: 0 }
  ] as const;

  for (const row of cases) {
    let checks = 0;
    const steps: ScriptStep[] = [row.classification];
    if ("verification" in row) steps.push(row.verification);
    const handle = scriptedHandle(steps, async () => { checks += 1; });
    const result = await writeApplicationFormField({
      fieldType: "CHECKBOX_BOOLEAN", handle, proposal: { kind: "BOOLEAN", value: row.proposal }
    });
    assert.equal(result.result, row.result);
    assert.equal(checks, row.checks);
  }
});

test("Playwright check failures are closed FILL_WRITE_FAILED results", async () => {
  const target = scriptedHandle([], async () => { throw new Error("SECRET-CHECK-DETAIL"); });
  const field = scriptedHandle(["EMPTY"]);
  assert.deepEqual(await writeApplicationFormField({
    fieldType: "RADIO_GROUP", handle: field, choiceHandles: [field, target], proposedChoiceHandle: target, proposal: options
  }), { result: "FAILED", errorCode: "FILL_WRITE_FAILED" });
});
