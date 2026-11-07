import { JSDOM } from "jsdom";

// Import this first in DOM interaction tests. React DOM decides at module load whether the
// browser "input" event exists; without a document at that moment, typing into text fields
// never reaches onChange. Each test file runs in its own process, so this stays local.
if (typeof globalThis.document === "undefined") {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://app.example.com/" });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document });
  Object.defineProperty(globalThis, "navigator", { configurable: true, writable: true, value: dom.window.navigator });
}
