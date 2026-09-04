import type { Browser, ElementHandle, Page } from "playwright";

export type FormFillTrapSnapshot = Readonly<{
  submit: number;
  formdata: number;
  requestSubmit: number;
  formSubmit: number;
  submitControlClick: number;
  navigation: number;
  popup: number;
  syntheticSubmissionRequest: number;
  input: number;
  change: number;
  inputSetter: number;
  textAreaSetter: number;
  optionSetter: number;
  eventConstructor: number;
  dispatchEvent: number;
  eventLog: readonly string[];
}>;

declare global {
  interface Window {
    __formFillTraps?: Omit<FormFillTrapSnapshot, "navigation" | "popup" | "syntheticSubmissionRequest">;
  }
}

export function boundedWriterFixture(): string {
  return `<!doctype html><html><body>
    <form action="https://fixture.invalid/__apply_pilot_submit" method="post">
      <input id="text-empty" type="text"><input id="text-occupied" type="text" value="SECRET-OCCUPIED-TEXT">
      <input id="email-empty" type="email"><input id="tel-empty" type="tel"><input id="url-empty" type="url">
      <textarea id="textarea-empty"></textarea><input id="readonly-empty" readonly><input id="disabled-empty" disabled>
      <input id="throwing-setter"><input id="mismatch-text"><input id="replace-text">
      <input id="controlled-text"><input id="controlled-replace-text">
      <select id="select-empty"><option id="placeholder-a" value="" selected disabled>Choose</option><option id="choice-a" value="SECRET-A">A</option></select>
      <select id="select-occupied"><option id="choice-b" value="SECRET-B" selected>B</option><option id="choice-c" value="SECRET-C">C</option></select>
      <select id="select-enabled-empty"><option id="enabled-empty-original" value="" selected>Decline to answer</option><option id="enabled-empty-choice" value="yes">Yes</option></select>
      <select id="select-enabled-empty-proposed"><option id="enabled-empty-proposed" value="" selected>Decline to answer</option><option id="enabled-empty-other" value="yes">Yes</option></select>
      <select id="select-disabled-nonempty"><option id="disabled-nonempty-original" value="existing" selected disabled>Unavailable existing choice</option><option id="disabled-nonempty-choice" value="yes">Yes</option></select>
      <select id="select-disabled-optgroup"><optgroup disabled><option id="disabled-optgroup-original" value="" selected>Unavailable group choice</option></optgroup><option id="disabled-optgroup-choice" value="yes">Yes</option></select>
      <select id="select-no-selection"><option id="no-selection-placeholder" value="" disabled>Choose</option><option id="no-selection-choice" value="yes">Yes</option></select>
      <select id="select-disabled" disabled><option id="placeholder-disabled-select" value="" selected disabled>Choose</option><option id="choice-disabled-select">A</option></select>
      <select id="select-disabled-option"><option id="placeholder-disabled-option" value="" selected disabled>Choose</option><option id="choice-disabled" disabled>A</option></select>
      <select id="select-mismatch"><option id="placeholder-mismatch" value="" selected disabled>Choose</option><option id="choice-mismatch">A</option></select>
      <fieldset><input id="radio-a" type="radio" name="radio-empty"><input id="radio-b" type="radio" name="radio-empty"></fieldset>
      <fieldset><input id="radio-occupied-a" type="radio" name="radio-occupied" checked><input id="radio-occupied-b" type="radio" name="radio-occupied"></fieldset>
      <input id="radio-disabled" type="radio" name="radio-disabled" disabled>
      <input id="checkbox-unchecked" type="checkbox"><input id="checkbox-checked" type="checkbox" checked>
      <button id="submit-control" type="submit">Submit application</button>
    </form>
    <script>
      (() => {
        const traps = window.__formFillTraps = {
          submit: 0, formdata: 0, requestSubmit: 0, formSubmit: 0, submitControlClick: 0,
          input: 0, change: 0, inputSetter: 0, textAreaSetter: 0, optionSetter: 0,
          eventConstructor: 0, dispatchEvent: 0, eventLog: []
        };
        document.addEventListener('submit', event => { traps.submit += 1; event.preventDefault(); }, true);
        document.addEventListener('formdata', () => { traps.formdata += 1; }, true);
        document.addEventListener('click', event => {
          const target = event.target;
          if (target instanceof HTMLButtonElement && target.type === 'submit') traps.submitControlClick += 1;
        }, true);
        document.addEventListener('input', event => { traps.input += 1; traps.eventLog.push(event.target.id + ':input'); }, true);
        document.addEventListener('change', event => { traps.change += 1; traps.eventLog.push(event.target.id + ':change'); }, true);
        HTMLFormElement.prototype.requestSubmit = function() { traps.requestSubmit += 1; };
        HTMLFormElement.prototype.submit = function() { traps.formSubmit += 1; };
        const nativeInputValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
        const nativeTextAreaValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
        const nativeOptionSelected = Object.getOwnPropertyDescriptor(HTMLOptionElement.prototype, 'selected');
        const NativeEvent = Event;
        const nativeDispatchEvent = EventTarget.prototype.dispatchEvent;
        if (!nativeInputValue?.get || !nativeInputValue.set || !nativeTextAreaValue?.set || !nativeOptionSelected?.set) {
          throw new Error('Fixture native primitives are unavailable.');
        }
        document.getElementById('select-no-selection').selectedIndex = -1;

        const publishControlledState = (control, state) => {
          control.dataset.modelValue = state.modelValue;
          control.dataset.trackedValue = state.trackedValue;
          control.dataset.renderCount = String(state.renderCount);
          control.dataset.frameworkWrites = String(state.frameworkWrites);
        };
        const installControlledModel = (id, replaceOnInput) => {
          const state = { modelValue: '', trackedValue: '', renderCount: 0, frameworkWrites: 0 };
          const bind = control => {
            Object.defineProperty(control, 'value', {
              configurable: true,
              get() { return nativeInputValue.get.call(control); },
              set(value) {
                state.trackedValue = String(value);
                state.frameworkWrites += 1;
                nativeInputValue.set.call(control, value);
              }
            });
            control.addEventListener('input', event => {
              const source = event.currentTarget;
              const currentValue = nativeInputValue.get.call(source);
              if (currentValue !== state.trackedValue) {
                state.trackedValue = currentValue;
                state.modelValue = currentValue;
              }
              state.renderCount += 1;
              if (replaceOnInput) {
                const replacement = source.cloneNode(false);
                bind(replacement);
                replacement.value = state.modelValue;
                publishControlledState(replacement, state);
                source.replaceWith(replacement);
              } else {
                source.value = state.modelValue;
                publishControlledState(source, state);
              }
            });
            publishControlledState(control, state);
          };
          bind(document.getElementById(id));
        };
        // This models framework-controlled value tracking: the model and tracker
        // are distinct from the DOM, input updates state, and render writes state
        // back either to the same node or to a replacement node.
        installControlledModel('controlled-text', false);
        installControlledModel('controlled-replace-text', true);

        Object.defineProperty(HTMLInputElement.prototype, 'value', {
          configurable: nativeInputValue.configurable,
          get: nativeInputValue.get,
          set(value) {
            traps.inputSetter += 1;
            document.forms[0].requestSubmit();
            return nativeInputValue.set.call(this, value);
          }
        });
        Object.defineProperty(HTMLTextAreaElement.prototype, 'value', {
          configurable: nativeTextAreaValue.configurable,
          get: nativeTextAreaValue.get,
          set(value) {
            traps.textAreaSetter += 1;
            document.forms[0].requestSubmit();
            return nativeTextAreaValue.set.call(this, value);
          }
        });
        Object.defineProperty(HTMLOptionElement.prototype, 'selected', {
          configurable: nativeOptionSelected.configurable,
          get: nativeOptionSelected.get,
          set(value) {
            traps.optionSetter += 1;
            document.forms[0].requestSubmit();
            return nativeOptionSelected.set.call(this, value);
          }
        });
        window.Event = function(type, init) {
          traps.eventConstructor += 1;
          document.forms[0].requestSubmit();
          return new NativeEvent(type, init);
        };
        window.Event.prototype = NativeEvent.prototype;
        EventTarget.prototype.dispatchEvent = function(event) {
          traps.dispatchEvent += 1;
          document.forms[0].requestSubmit();
          return nativeDispatchEvent.call(this, event);
        };
        document.getElementById('mismatch-text').addEventListener('input', event => {
          nativeInputValue.set.call(event.currentTarget, '');
        });
        document.getElementById('replace-text').addEventListener('input', event => {
          const replacement = event.currentTarget.cloneNode(); replacement.id = 'replace-text'; event.currentTarget.replaceWith(replacement);
        });
        document.getElementById('select-mismatch').addEventListener('change', event => {
          nativeOptionSelected.set.call(event.currentTarget.options[0], true);
        });
      })();
    </script>
  </body></html>`;
}

export async function createFormFillFixturePage(
  browser: Browser,
  beforeNavigation?: (page: Page) => Promise<void>
): Promise<{
  page: Page;
  handle(id: string): Promise<ElementHandle>;
  traps(): Promise<FormFillTrapSnapshot>;
}> {
  const context = await browser.newContext();
  const page = await context.newPage();
  let navigation = 0;
  let popup = 0;
  let syntheticSubmissionRequest = 0;
  page.on("framenavigated", (frame) => { if (frame === page.mainFrame()) navigation += 1; });
  page.on("popup", () => { popup += 1; });
  await context.route("**/__apply_pilot_submit", async (route) => {
    syntheticSubmissionRequest += 1;
    await route.fulfill({ status: 204, body: "" });
  });
  await beforeNavigation?.(page);
  await page.goto(`data:text/html;charset=utf-8,${encodeURIComponent(boundedWriterFixture())}`, { waitUntil: "domcontentloaded" });
  navigation = 0;
  return {
    page,
    async handle(id) {
      const handle = await page.$(`#${id}`);
      if (!handle) throw new Error("Fixture handle is missing.");
      return handle;
    },
    async traps() {
      const local = await page.evaluate(() => window.__formFillTraps!);
      return { ...local, navigation, popup, syntheticSubmissionRequest };
    }
  };
}

export function assertNoSubmission(snapshot: FormFillTrapSnapshot): void {
  const keys = [
    "submit", "formdata", "requestSubmit", "formSubmit", "submitControlClick",
    "navigation", "popup", "syntheticSubmissionRequest"
  ] as const;
  const counts = keys.map((key) => snapshot[key]);
  if (counts.some((count) => count !== 0)) {
    throw new Error(`Submission trap fired: ${JSON.stringify(Object.fromEntries(keys.map((key) => [key, snapshot[key]])))}`);
  }
}
