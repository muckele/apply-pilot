import { act } from "react";

// react-dom is imported before a test installs its JSDOM globals, so React watches text inputs
// through its legacy fallback (focus, then keyup) instead of the input event. JSDOM lacks the old
// IE hooks that fallback attaches, so they are stubbed; React's own change detection then runs.
export async function typeInto(input: HTMLInputElement, value: string) {
  Object.assign(input, { attachEvent: () => undefined, detachEvent: () => undefined });
  const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    input.dispatchEvent(new window.FocusEvent("focusin", { bubbles: true }));
    setValue.call(input, value);
    input.dispatchEvent(new window.KeyboardEvent("keyup", { bubbles: true }));
  });
}
