import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { chromium, type Browser, type ElementHandle, type Page } from "playwright";

import * as formFillDom from "@/lib/application-browser/form-fill-dom";
import { writeApplicationFormField } from "@/lib/application-browser/form-fill-writer";
import { MISSING_CHROMIUM_MESSAGE } from "@/lib/application-browser/browser-runtime";
import type { ApplicationAnswerProposal } from "@/lib/application-runs/answer-packet-domain";
import {
  assertNoSubmission,
  boundedWriterFixture,
  createFormFillFixturePage
} from "@/tests/browser/form-fill-fixtures";

let browser: Browser;

before(async () => {
  try { browser = await chromium.launch({ headless: true }); }
  catch (error) {
    if (error instanceof Error && /executable.*(doesn'?t exist|missing|not found)|playwright install/i.test(error.message)) {
      throw new Error(MISSING_CHROMIUM_MESSAGE);
    }
    throw error;
  }
});
after(async () => { await browser?.close(); });

const scalar = (value: string) => ({ kind: "SCALAR", value } as const);
const optionProposal = { kind: "OPTIONS", optionKeys: ["a".repeat(64)] } satisfies ApplicationAnswerProposal;
const installTrustedCapability = (formFillDom as unknown as {
  installTrustedFormFillDomCapability?: (page: Page) => Promise<void>;
}).installTrustedFormFillDomCapability;

async function withFixture(
  run: (fixture: Awaited<ReturnType<typeof createFormFillFixturePage>>) => Promise<void>,
  options: { installCapability?: boolean } = {}
) {
  const beforeNavigation = options.installCapability === false ? undefined : installTrustedCapability;
  const fixture = await createFormFillFixturePage(browser, beforeNavigation);
  try { await run(fixture); } finally { await fixture.page.context().close(); }
}

function countedCheck(handle: ElementHandle, counter: { count: number }): ElementHandle {
  const check = handle.check.bind(handle);
  Object.defineProperty(handle, "check", {
    configurable: true,
    value: async (...args: Parameters<ElementHandle["check"]>) => {
      counter.count += 1;
      await check(...args);
    }
  });
  return handle;
}

function countedEvaluate(handle: ElementHandle, counter: { count: number }): ElementHandle {
  const evaluate = handle.evaluate.bind(handle);
  Object.defineProperty(handle, "evaluate", {
    configurable: true,
    value: async (...args: Parameters<ElementHandle["evaluate"]>) => {
      counter.count += 1;
      return evaluate(...args);
    }
  });
  return handle;
}

test("writes all five text-like families with native setter/input and preserves occupied values", async () => {
  await withFixture(async (fixture) => {
    for (const [fieldType, id, value] of [
      ["TEXT", "text-empty", "Ada"], ["EMAIL", "email-empty", "ada@example.test"],
      ["TEL", "tel-empty", "5550100"], ["URL", "url-empty", "https://example.test"],
      ["TEXTAREA", "textarea-empty", "Hello"]
    ] as const) {
      const handle = await fixture.handle(id);
      assert.deepEqual(await writeApplicationFormField({ fieldType, handle, proposal: scalar(value) }), { result: "FILLED", errorCode: null });
      assert.equal(await handle.evaluate((node, expected) => (node as HTMLInputElement | HTMLTextAreaElement).value === expected, value), true);
    }
    const occupied = await fixture.handle("text-occupied");
    assert.deepEqual(await writeApplicationFormField({ fieldType: "TEXT", handle: occupied, proposal: scalar("replacement") }), {
      result: "PRESERVED_EXISTING", errorCode: null
    });
    assert.equal(await occupied.evaluate((node) => (node as HTMLInputElement).value === "SECRET-OCCUPIED-TEXT"), true);
    const controlled = await fixture.handle("controlled-text");
    assert.deepEqual(await controlled.evaluate((node) => ({
      modelValue: (node as HTMLElement).dataset.modelValue,
      trackedValue: (node as HTMLElement).dataset.trackedValue,
      value: (node as HTMLInputElement).value
    })), { modelValue: "", trackedValue: "", value: "" });
    assert.deepEqual(await writeApplicationFormField({ fieldType: "TEXT", handle: controlled, proposal: scalar("Grace") }), {
      result: "FILLED", errorCode: null
    });
    assert.deepEqual(await controlled.evaluate((node) => ({
      connected: node.isConnected,
      modelValue: (node as HTMLElement).dataset.modelValue,
      trackedValue: (node as HTMLElement).dataset.trackedValue,
      renderCount: (node as HTMLElement).dataset.renderCount,
      frameworkWrites: (node as HTMLElement).dataset.frameworkWrites,
      value: (node as HTMLInputElement).value
    })), {
      connected: true,
      modelValue: "Grace",
      trackedValue: "Grace",
      renderCount: "1",
      frameworkWrites: "1",
      value: "Grace"
    });
    const traps = await fixture.traps();
    assert.deepEqual(traps.eventLog, [
      "text-empty:input", "email-empty:input", "tel-empty:input", "url-empty:input", "textarea-empty:input",
      "controlled-text:input"
    ]);
    assert.deepEqual({
      inputSetter: traps.inputSetter,
      textAreaSetter: traps.textAreaSetter,
      eventConstructor: traps.eventConstructor,
      dispatchEvent: traps.dispatchEvent
    }, { inputSetter: 0, textAreaSetter: 0, eventConstructor: 0, dispatchEvent: 0 });
    assertNoSubmission(traps);
  });
});

test("text-like readonly/disabled are manual; detached, replacement, and mismatch fail closed", async () => {
  await withFixture(async (fixture) => {
    for (const id of ["readonly-empty", "disabled-empty"]) {
      assert.deepEqual(await writeApplicationFormField({ fieldType: "TEXT", handle: await fixture.handle(id), proposal: scalar("Ada") }), {
        result: "MANUAL", errorCode: null
      });
    }
    const detached = await fixture.handle("text-empty");
    await detached.evaluate((node) => (node as Element).remove());
    assert.deepEqual(await writeApplicationFormField({ fieldType: "TEXT", handle: detached, proposal: scalar("Ada") }), {
      result: "FAILED", errorCode: "FILL_UNEXPECTED_MUTATION"
    });
    for (const [id, code] of [["mismatch-text", "FILL_UNEXPECTED_MUTATION"], ["replace-text", "FILL_UNEXPECTED_MUTATION"]] as const) {
      assert.deepEqual(await writeApplicationFormField({ fieldType: "TEXT", handle: await fixture.handle(id), proposal: scalar("Ada") }), {
        result: "FAILED", errorCode: code
      });
    }
    assertNoSubmission(await fixture.traps());
  });
});

test("controlled replacement reconciles state but the writer verifies only the detached exact handle", async () => {
  await withFixture(async (fixture) => {
    const original = await fixture.handle("controlled-replace-text");
    assert.deepEqual(await original.evaluate((node) => ({
      modelValue: (node as HTMLElement).dataset.modelValue,
      trackedValue: (node as HTMLElement).dataset.trackedValue,
      value: (node as HTMLInputElement).value
    })), { modelValue: "", trackedValue: "", value: "" });
    assert.deepEqual(await writeApplicationFormField({ fieldType: "TEXT", handle: original, proposal: scalar("Katherine") }), {
      result: "FAILED", errorCode: "FILL_UNEXPECTED_MUTATION"
    });
    assert.equal(await original.evaluate((node) => node.isConnected), false);
    const replacement = await fixture.handle("controlled-replace-text");
    assert.deepEqual(await replacement.evaluate((node) => ({
      modelValue: (node as HTMLElement).dataset.modelValue,
      trackedValue: (node as HTMLElement).dataset.trackedValue,
      renderCount: (node as HTMLElement).dataset.renderCount,
      frameworkWrites: (node as HTMLElement).dataset.frameworkWrites,
      value: (node as HTMLInputElement).value
    })), {
      modelValue: "Katherine",
      trackedValue: "Katherine",
      renderCount: "1",
      frameworkWrites: "1",
      value: "Katherine"
    });
    const traps = await fixture.traps();
    assert.equal(traps.input, 1);
    assertNoSubmission(traps);
  });
});

test("select writes only an exact valid choice, preserves occupied, and fails closed on replacement", async () => {
  await withFixture(async (fixture) => {
    const select = await fixture.handle("select-empty");
    const placeholder = await fixture.handle("placeholder-a");
    const choice = await fixture.handle("choice-a");
    assert.deepEqual(await writeApplicationFormField({ fieldType: "SELECT_ONE", handle: select, choiceHandles: [placeholder, choice], proposedChoiceHandle: choice, proposal: optionProposal }), {
      result: "FILLED", errorCode: null
    });
    assert.deepEqual(await select.evaluate((node) => ({ selected: (node as HTMLSelectElement).selectedOptions[0]?.id, valueIsSecret: (node as HTMLSelectElement).value === "SECRET-A" })), {
      selected: "choice-a", valueIsSecret: true
    });
    assert.deepEqual((await fixture.traps()).eventLog, ["select-empty:input", "select-empty:change"]);
    const occupied = await fixture.handle("select-occupied");
    const occupiedOriginal = await fixture.handle("choice-b");
    const occupiedChoice = await fixture.handle("choice-c");
    assert.deepEqual(await writeApplicationFormField({ fieldType: "SELECT_ONE", handle: occupied, choiceHandles: [occupiedOriginal, occupiedChoice], proposedChoiceHandle: occupiedChoice, proposal: optionProposal }), {
      result: "PRESERVED_EXISTING", errorCode: null
    });
    for (const [selectId, originalId, proposedId, otherId] of [
      ["select-enabled-empty", "enabled-empty-original", "enabled-empty-choice", null],
      ["select-enabled-empty-proposed", "enabled-empty-proposed", "enabled-empty-proposed", "enabled-empty-other"],
      ["select-disabled-nonempty", "disabled-nonempty-original", "disabled-nonempty-choice", null],
      ["select-disabled-optgroup", "disabled-optgroup-original", "disabled-optgroup-choice", null]
    ] as const) {
      const before = await fixture.traps();
      const evaluations = { count: 0 };
      const enabledEmpty = countedEvaluate(await fixture.handle(selectId), evaluations);
      const original = await fixture.handle(originalId);
      const proposed = await fixture.handle(proposedId);
      const choices = otherId === null ? [original, proposed] : [proposed, await fixture.handle(otherId)];
      assert.deepEqual(await writeApplicationFormField({
        fieldType: "SELECT_ONE", handle: enabledEmpty, choiceHandles: choices,
        proposedChoiceHandle: proposed, proposal: optionProposal
      }), { result: "PRESERVED_EXISTING", errorCode: null });
      assert.equal(evaluations.count, 1);
      assert.equal(await original.evaluate((node) => (node as HTMLOptionElement).selected), true);
      const after = await fixture.traps();
      assert.equal(after.optionSetter, before.optionSetter);
      assert.equal(after.input, before.input);
      assert.equal(after.change, before.change);
    }
    const noSelectionBefore = await fixture.traps();
    const noSelectionEvaluations = { count: 0 };
    const noSelection = countedEvaluate(await fixture.handle("select-no-selection"), noSelectionEvaluations);
    const noSelectionPlaceholder = await fixture.handle("no-selection-placeholder");
    const noSelectionChoice = await fixture.handle("no-selection-choice");
    assert.deepEqual(await writeApplicationFormField({
      fieldType: "SELECT_ONE", handle: noSelection,
      choiceHandles: [noSelectionPlaceholder, noSelectionChoice], proposedChoiceHandle: noSelectionChoice,
      proposal: optionProposal
    }), { result: "FAILED", errorCode: "FILL_UNEXPECTED_MUTATION" });
    assert.equal(noSelectionEvaluations.count, 1);
    assert.equal(await noSelection.evaluate((node) => (node as HTMLSelectElement).selectedIndex), -1);
    const noSelectionAfter = await fixture.traps();
    assert.equal(noSelectionAfter.optionSetter, noSelectionBefore.optionSetter);
    assert.equal(noSelectionAfter.input, noSelectionBefore.input);
    assert.equal(noSelectionAfter.change, noSelectionBefore.change);
    const disabledSelect = await fixture.handle("select-disabled");
    const disabledSelectPlaceholder = await fixture.handle("placeholder-disabled-select");
    const disabledSelectChoice = await fixture.handle("choice-disabled-select");
    assert.deepEqual(await writeApplicationFormField({ fieldType: "SELECT_ONE", handle: disabledSelect, choiceHandles: [disabledSelectPlaceholder, disabledSelectChoice], proposedChoiceHandle: disabledSelectChoice, proposal: optionProposal }), {
      result: "MANUAL", errorCode: null
    });
    const disabledOptionSelect = await fixture.handle("select-disabled-option");
    const disabledPlaceholder = await fixture.handle("placeholder-disabled-option");
    const replaced = await fixture.handle("choice-disabled");
    assert.deepEqual(await writeApplicationFormField({ fieldType: "SELECT_ONE", handle: disabledOptionSelect, choiceHandles: [disabledPlaceholder, replaced], proposedChoiceHandle: replaced, proposal: optionProposal }), {
      result: "MANUAL", errorCode: null
    });
    await replaced.evaluate((node) => (node as Element).replaceWith(node.cloneNode(true)));
    assert.deepEqual(await writeApplicationFormField({ fieldType: "SELECT_ONE", handle: await fixture.handle("select-disabled-option"), choiceHandles: [disabledPlaceholder, replaced], proposedChoiceHandle: replaced, proposal: optionProposal }), {
      result: "FAILED", errorCode: "FILL_UNEXPECTED_MUTATION"
    });
    const changedSelect = await fixture.handle("select-disabled-option");
    const retainedPlaceholder = await fixture.handle("placeholder-disabled-option");
    const currentChoice = await fixture.handle("choice-disabled");
    await changedSelect.evaluate((node) => (node as HTMLSelectElement).append(new Option("New", "new")));
    assert.deepEqual(await writeApplicationFormField({ fieldType: "SELECT_ONE", handle: changedSelect, choiceHandles: [retainedPlaceholder, currentChoice], proposedChoiceHandle: currentChoice, proposal: optionProposal }), {
      result: "FAILED", errorCode: "FILL_UNEXPECTED_MUTATION"
    });
    const mismatchSelect = await fixture.handle("select-mismatch");
    const mismatchPlaceholder = await fixture.handle("placeholder-mismatch");
    const mismatchChoice = await fixture.handle("choice-mismatch");
    assert.deepEqual(await writeApplicationFormField({ fieldType: "SELECT_ONE", handle: mismatchSelect, choiceHandles: [mismatchPlaceholder, mismatchChoice], proposedChoiceHandle: mismatchChoice, proposal: optionProposal }), {
      result: "FAILED", errorCode: "FILL_UNEXPECTED_MUTATION"
    });
    const traps = await fixture.traps();
    assert.equal(traps.optionSetter, 0);
    assertNoSubmission(traps);
  });
});

test("registered initial document cannot self-authorize with an exact frozen lookalike", async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  let navigation = 0;
  let popup = 0;
  let syntheticSubmissionRequest = 0;
  let initContent = "";
  page.on("framenavigated", (frame) => { if (frame === page.mainFrame()) navigation += 1; });
  page.on("popup", () => { popup += 1; });
  await context.route("**/__apply_pilot_submit", async (route) => {
    syntheticSubmissionRequest += 1;
    await route.fulfill({ status: 204, body: "" });
  });
  const addInitScript = page.addInitScript.bind(page);
  Object.defineProperty(page, "addInitScript", {
    configurable: true,
    value: async (script: { content?: string }) => {
      initContent = script.content ?? "";
      await addInitScript(script);
    }
  });
  try {
    assert.ok(installTrustedCapability);
    await installTrustedCapability(page);
    const capabilityKey = initContent.match(/__applyPilotTrustedFormFillDomV1_[a-f0-9]+/)?.[0];
    assert.ok(capabilityKey);
    await page.setContent(boundedWriterFixture(), { waitUntil: "domcontentloaded" });
    navigation = 0;
    await page.evaluate((key) => {
      const calls = { integrity: 0, classify: 0, write: 0, verify: 0 };
      (window as unknown as Record<string, unknown>).__fakeCapabilityCalls = calls;
      const fake = Object.freeze({
        integrity() { calls.integrity += 1; return true; },
        classifyTextLike() { calls.classify += 1; return "EMPTY"; },
        writeTextLike(node: Element, _shape: unknown, proposal: string) {
          calls.write += 1;
          document.forms[0].requestSubmit();
          node.setAttribute("data-fake-write", proposal);
          return "WRITTEN";
        },
        verifyTextLike() { calls.verify += 1; return "MATCHED"; }
      });
      Object.defineProperty(window, key, {
        configurable: false, enumerable: false, writable: false, value: fake
      });
    }, capabilityKey);
    const evaluations = { count: 0 };
    const handle = countedEvaluate((await page.$("#text-empty"))!, evaluations);
    assert.deepEqual(await writeApplicationFormField({ fieldType: "TEXT", handle, proposal: scalar("Ada") }), {
      result: "FAILED", errorCode: "FILL_INTERNAL"
    });
    assert.equal(evaluations.count, 0);
    const evidence = await page.evaluate(() => ({
      calls: (window as unknown as Record<string, unknown>).__fakeCapabilityCalls,
      value: (document.getElementById("text-empty") as HTMLInputElement).value,
      marker: document.getElementById("text-empty")?.getAttribute("data-fake-write"),
      traps: window.__formFillTraps!
    }));
    assert.deepEqual(evidence.calls, { integrity: 0, classify: 0, write: 0, verify: 0 });
    assert.deepEqual({ value: evidence.value, marker: evidence.marker }, { value: "", marker: null });
    assertNoSubmission({ ...evidence.traps, navigation, popup, syntheticSubmissionRequest });
  } finally {
    await context.close();
  }
});

test("intrinsic capture failure leaves an immutable inert gate that rejects lookalikes", async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  let navigation = 0;
  let popup = 0;
  let syntheticSubmissionRequest = 0;
  let capabilityKey = "";
  page.on("framenavigated", (frame) => { if (frame === page.mainFrame()) navigation += 1; });
  page.on("popup", () => { popup += 1; });
  await context.route("**/__apply_pilot_submit", async (route) => {
    syntheticSubmissionRequest += 1;
    await route.fulfill({ status: 204, body: "" });
  });
  const addInitScript = page.addInitScript.bind(page);
  Object.defineProperty(page, "addInitScript", {
    configurable: true,
    value: async (script: { content?: string }) => {
      const trustedContent = script.content ?? "";
      capabilityKey = trustedContent.match(/__applyPilotTrustedFormFillDomV1_[a-f0-9]+/)?.[0] ?? "";
      await addInitScript({
        content: `Object.defineProperty(EventTarget.prototype, "dispatchEvent", { configurable: true, value: undefined }); ${trustedContent}`
      });
    }
  });
  try {
    assert.ok(installTrustedCapability);
    await installTrustedCapability(page);
    assert.notEqual(capabilityKey, "");
    const employerScript = `<script>
      window.__captureFailure = { installedFake: false, integrity: 0, classify: 0, write: 0, verify: 0, requestSubmit: 0 };
      HTMLFormElement.prototype.requestSubmit = function() { window.__captureFailure.requestSubmit += 1; };
      const fake = Object.freeze({
        integrity() { window.__captureFailure.integrity += 1; return true; },
        classifyTextLike() { window.__captureFailure.classify += 1; return "EMPTY"; },
        writeTextLike(node, shape, proposal) {
          window.__captureFailure.write += 1;
          document.forms[0].requestSubmit();
          node.setAttribute("data-fake-write", proposal);
          return "WRITTEN";
        },
        verifyTextLike() { window.__captureFailure.verify += 1; return "MATCHED"; }
      });
      try {
        Object.defineProperty(window, ${JSON.stringify(capabilityKey)}, {
          configurable: false, enumerable: false, writable: false, value: fake
        });
        window.__captureFailure.installedFake = true;
      } catch {}
    </script>`;
    await page.goto(`data:text/html;charset=utf-8,${encodeURIComponent(
      `<form action="https://fixture.invalid/__apply_pilot_submit"><input id="capture-failure"></form>${employerScript}`
    )}`, { waitUntil: "domcontentloaded" });
    navigation = 0;
    const handle = (await page.$("#capture-failure"))!;
    assert.deepEqual(await writeApplicationFormField({ fieldType: "TEXT", handle, proposal: scalar("Ada") }), {
      result: "FAILED", errorCode: "FILL_INTERNAL"
    });
    const evidence = await page.evaluate((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(window, key);
      return {
        gateFrozen: descriptor ? Object.isFrozen(descriptor.value) : false,
        configurable: descriptor?.configurable,
        writable: descriptor?.writable,
        value: (document.getElementById("capture-failure") as HTMLInputElement).value,
        marker: document.getElementById("capture-failure")?.getAttribute("data-fake-write"),
        calls: (window as unknown as Record<string, unknown>).__captureFailure
      };
    }, capabilityKey);
    assert.deepEqual({
      gateFrozen: evidence.gateFrozen,
      configurable: evidence.configurable,
      writable: evidence.writable
    }, { gateFrozen: true, configurable: false, writable: false });
    assert.deepEqual(evidence.calls, {
      installedFake: false, integrity: 0, classify: 0, write: 0, verify: 0, requestSubmit: 0
    });
    assert.deepEqual({ value: evidence.value, marker: evidence.marker }, { value: "", marker: null });
    assertNoSubmission({
      submit: 0, formdata: 0, requestSubmit: 0, formSubmit: 0, submitControlClick: 0,
      navigation, popup, syntheticSubmissionRequest,
      input: 0, change: 0, inputSetter: 0, textAreaSetter: 0, optionSetter: 0,
      eventConstructor: 0, dispatchEvent: 0, eventLog: []
    });
  } finally {
    await context.close();
  }
});

test("trusted capability is immutable after pre-navigation capture and missing capability fails internally without writes", async () => {
  await withFixture(async (fixture) => {
    const integrity = await fixture.page.evaluate(() => {
      const key = Object.getOwnPropertyNames(window).find((name) => name.startsWith("__applyPilotTrustedFormFillDomV1_"));
      if (!key) return null;
      const capability = (window as unknown as Record<string, unknown>)[key];
      const descriptor = Object.getOwnPropertyDescriptor(window, key);
      const replacement = Object.freeze({});
      const assignment = Reflect.set(window, key, replacement);
      const deletion = Reflect.deleteProperty(window, key);
      const originalClassify = (capability as { classifyTextLike?: unknown }).classifyTextLike;
      const methodReplacement = Reflect.set(
        capability as object,
        "classifyTextLike",
        () => "EMPTY"
      );
      let redefinition = true;
      try { Object.defineProperty(window, key, { value: replacement }); } catch { redefinition = false; }
      const fakeCalls = { classify: 0, write: 0, verify: 0, requestSubmit: 0 };
      const fake = Object.freeze({
        classifyTextLike() { fakeCalls.classify += 1; return "EMPTY"; },
        writeTextLike() {
          fakeCalls.write += 1;
          fakeCalls.requestSubmit += 1;
          document.forms[0].requestSubmit();
          return "WRITTEN";
        },
        verifyTextLike() { fakeCalls.verify += 1; return "MATCHED"; }
      });
      Object.defineProperties(window, {
        __applyPilotTrustedFormFillDomV1_static: { configurable: true, value: fake },
        __similarFormFillCapability: { configurable: true, value: fake },
        __navigatedFakeCapabilityCalls: { configurable: true, value: fakeCalls }
      });
      return {
        writable: descriptor?.writable,
        configurable: descriptor?.configurable,
        frozen: Object.isFrozen(capability),
        assignment,
        deletion,
        redefinition,
        retained: (window as unknown as Record<string, unknown>)[key] === capability,
        methodReplacement,
        methodRetained: (capability as { classifyTextLike?: unknown }).classifyTextLike === originalClassify
      };
    });
    assert.deepEqual(integrity, {
      writable: false, configurable: false, frozen: true,
      assignment: false, deletion: false, redefinition: false, retained: true,
      methodReplacement: false, methodRetained: true
    });
    const handle = await fixture.handle("text-empty");
    assert.deepEqual(await writeApplicationFormField({ fieldType: "TEXT", handle, proposal: scalar("Ada") }), {
      result: "FILLED", errorCode: null
    });
    assert.deepEqual(await fixture.page.evaluate(() => ({
      value: (document.getElementById("text-empty") as HTMLInputElement).value,
      fakeCalls: (window as unknown as Record<string, unknown>).__navigatedFakeCapabilityCalls
    })), {
      value: "Ada",
      fakeCalls: { classify: 0, write: 0, verify: 0, requestSubmit: 0 }
    });
    assertNoSubmission(await fixture.traps());
  });

  await withFixture(async (fixture) => {
    const evaluations = { count: 0 };
    const handle = countedEvaluate(await fixture.handle("text-empty"), evaluations);
    assert.deepEqual(await writeApplicationFormField({ fieldType: "TEXT", handle, proposal: scalar("Ada") }), {
      result: "FAILED", errorCode: "FILL_INTERNAL"
    });
    assert.equal(evaluations.count, 0);
    assert.equal(await handle.evaluate((node) => (node as HTMLInputElement).value), "");
    const traps = await fixture.traps();
    assert.deepEqual({
      inputSetter: traps.inputSetter,
      eventConstructor: traps.eventConstructor,
      dispatchEvent: traps.dispatchEvent
    }, { inputSetter: 0, eventConstructor: 0, dispatchEvent: 0 });
    assertNoSubmission(traps);
  }, { installCapability: false });
});

test("registered Page rejects child-frame text and checked controls before DOM work", async () => {
  await withFixture(async (fixture) => {
    await fixture.page.evaluate(async () => {
      const frame = document.createElement("iframe");
      frame.srcdoc = `<input id="child-text"><input id="child-checkbox" type="checkbox"><script>
        window.__childEvents = { input: 0, change: 0 };
        document.addEventListener("input", () => { window.__childEvents.input += 1; });
        document.addEventListener("change", () => { window.__childEvents.change += 1; });
      <\/script>`;
      document.body.append(frame);
      await new Promise<void>((resolve) => frame.addEventListener("load", () => resolve(), { once: true }));
    });
    const childFrame = fixture.page.frames().find((frame) => frame !== fixture.page.mainFrame());
    assert.ok(childFrame);
    const textCounts = { count: 0 };
    const text = countedEvaluate((await childFrame.$("#child-text"))!, textCounts);
    assert.deepEqual(await writeApplicationFormField({ fieldType: "TEXT", handle: text, proposal: scalar("Ada") }), {
      result: "FAILED", errorCode: "FILL_INTERNAL"
    });
    assert.equal(textCounts.count, 0);

    const checkboxEvaluateCounts = { count: 0 };
    const checkboxCheckCounts = { count: 0 };
    const checkbox = countedCheck(
      countedEvaluate((await childFrame.$("#child-checkbox"))!, checkboxEvaluateCounts),
      checkboxCheckCounts
    );
    assert.deepEqual(await writeApplicationFormField({
      fieldType: "CHECKBOX_BOOLEAN", handle: checkbox, proposal: { kind: "BOOLEAN", value: true }
    }), { result: "FAILED", errorCode: "FILL_INTERNAL" });
    assert.equal(checkboxEvaluateCounts.count, 0);
    assert.equal(checkboxCheckCounts.count, 0);
    assert.deepEqual(await childFrame.evaluate(() => ({
      text: (document.getElementById("child-text") as HTMLInputElement).value,
      checked: (document.getElementById("child-checkbox") as HTMLInputElement).checked,
      events: (window as unknown as Record<string, unknown>).__childEvents
    })), { text: "", checked: false, events: { input: 0, change: 0 } });
    assertNoSubmission(await fixture.traps());
  });
});

test("radio preservation and exact one-check behavior use retained handles only", async () => {
  await withFixture(async (fixture) => {
    const first = await fixture.handle("radio-a");
    const secondRaw = await fixture.handle("radio-b");
    const counter = { count: 0 };
    const second = countedCheck(secondRaw, counter);
    assert.deepEqual(await writeApplicationFormField({ fieldType: "RADIO_GROUP", handle: first, choiceHandles: [first, second], proposedChoiceHandle: second, proposal: optionProposal }), {
      result: "FILLED", errorCode: null
    });
    assert.equal(counter.count, 1);
    assert.deepEqual(await writeApplicationFormField({ fieldType: "RADIO_GROUP", handle: first, choiceHandles: [first, second], proposedChoiceHandle: second, proposal: optionProposal }), {
      result: "PRESERVED_EXISTING", errorCode: null
    });
    assert.equal(counter.count, 1);
    const occupiedA = await fixture.handle("radio-occupied-a");
    const occupiedB = countedCheck(await fixture.handle("radio-occupied-b"), counter);
    assert.deepEqual(await writeApplicationFormField({ fieldType: "RADIO_GROUP", handle: occupiedA, choiceHandles: [occupiedA, occupiedB], proposedChoiceHandle: occupiedB, proposal: optionProposal }), {
      result: "PRESERVED_EXISTING", errorCode: null
    });
    assert.equal(counter.count, 1);
    const replacedTarget = await fixture.handle("radio-disabled");
    await replacedTarget.evaluate((node) => (node as Element).replaceWith(node.cloneNode(true)));
    assert.deepEqual(await writeApplicationFormField({ fieldType: "RADIO_GROUP", handle: replacedTarget, choiceHandles: [replacedTarget], proposedChoiceHandle: replacedTarget, proposal: optionProposal }), {
      result: "FAILED", errorCode: "FILL_UNEXPECTED_MUTATION"
    });
    const disabled = await fixture.handle("radio-disabled");
    assert.deepEqual(await writeApplicationFormField({ fieldType: "RADIO_GROUP", handle: disabled, choiceHandles: [disabled], proposedChoiceHandle: disabled, proposal: optionProposal }), {
      result: "MANUAL", errorCode: null
    });
    assertNoSubmission(await fixture.traps());
  });
});

test("radio graph mutation cannot silently uncheck an omitted existing selection", async () => {
  await withFixture(async (fixture) => {
    const first = await fixture.handle("radio-a");
    const counter = { count: 0 };
    const proposed = countedCheck(await fixture.handle("radio-b"), counter);
    await fixture.page.evaluate(() => {
      const omitted = document.createElement("input");
      omitted.id = "radio-omitted";
      omitted.type = "radio";
      omitted.name = "radio-empty";
      omitted.checked = true;
      document.querySelector("fieldset")?.append(omitted);
    });
    assert.deepEqual(await writeApplicationFormField({
      fieldType: "RADIO_GROUP", handle: first, choiceHandles: [first, proposed],
      proposedChoiceHandle: proposed, proposal: optionProposal
    }), { result: "FAILED", errorCode: "FILL_UNEXPECTED_MUTATION" });
    assert.equal(counter.count, 0);
    assert.deepEqual(await fixture.page.evaluate(() => ({
      proposed: (document.getElementById("radio-b") as HTMLInputElement).checked,
      omitted: (document.getElementById("radio-omitted") as HTMLInputElement).checked
    })), { proposed: false, omitted: true });
    assertNoSubmission(await fixture.traps());
  });
});

test("checkbox truth table proves zero false writes and exactly one true check", async () => {
  await withFixture(async (fixture) => {
    for (const row of [
      { id: "checkbox-unchecked", proposal: true, result: "FILLED", checks: 1 },
      { id: "checkbox-unchecked", proposal: false, result: "PRESERVED_EXISTING", checks: 0 },
      { id: "checkbox-checked", proposal: true, result: "PRESERVED_EXISTING", checks: 0 },
      { id: "checkbox-checked", proposal: false, result: "MANUAL", checks: 0 }
    ] as const) {
      if (row.id === "checkbox-unchecked") await fixture.page.evaluate(() => { (document.getElementById("checkbox-unchecked") as HTMLInputElement).checked = false; });
      const counter = { count: 0 };
      const handle = countedCheck(await fixture.handle(row.id), counter);
      assert.deepEqual(await writeApplicationFormField({ fieldType: "CHECKBOX_BOOLEAN", handle, proposal: { kind: "BOOLEAN", value: row.proposal } }), {
        result: row.result, errorCode: null
      });
      assert.equal(counter.count, row.checks);
    }
    assertNoSubmission(await fixture.traps());
  });
});
