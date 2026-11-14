import assert from "node:assert/strict";
import test from "node:test";

import { aiErrorText } from "@/lib/apply-page/ai-error-text";
import { hasSeenGeminiNotice, geminiNoticeKey, rememberGeminiNotice } from "@/lib/apply-page/gemini-notice";

// The Apply page never talks about money (D037): no cents, no dollars, no "charged".
const MONEY = /[$¢]|\bcents?\b|\bcharged?\b|\bcost\b/iu;

test("AI errors on the Apply page say what happened in plain words, never with money", () => {
  assert.equal(aiErrorText({ error: "Gemini rejected job matching before completion.", billingStatus: "not_charged", actualCostMicros: 0 }, "Fallback."),
    "Gemini rejected job matching before completion.");
  assert.equal(aiErrorText({ error: "This request would exceed your monthly AI budget.", code: "AI_BUDGET_EXCEEDED" }, "Fallback."),
    "You've reached this month's AI limit.");
  assert.equal(aiErrorText({ error: "Gemini returned a job match that could not be accepted.", billingStatus: "known", actualCostMicros: 41_000 }, "Fallback."),
    "Gemini returned a job match that could not be accepted.");
  assert.equal(aiErrorText(null, "Apply Pilot couldn't update your match."), "Apply Pilot couldn't update your match.");
  const uncertain = aiErrorText({ error: "Job matching reached Gemini, but the outcome is uncertain. Review AI usage instead of retrying.", billingStatus: "uncertain" }, "Fallback.");
  assert.match(uncertain, /reload this page before you try again/u);
  for (const text of [uncertain, aiErrorText({ error: "This request exceeds the configured per-request AI limit.", code: "AI_REQUEST_COST_LIMIT" }, "F.")]) {
    assert.doesNotMatch(text, MONEY, text);
  }
});

test("a server message that mentions money is replaced with the fallback", () => {
  assert.equal(aiErrorText({ error: "This step could cost up to $0.07272." }, "Apply Pilot couldn't update your match."), "Apply Pilot couldn't update your match.");
});

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key); },
    setItem: (key, value) => { values.set(key, value); }
  };
}

test("the Gemini notice is remembered per account on this browser", () => {
  const storage = memoryStorage();
  assert.equal(geminiNoticeKey("0123456789abcdef"), "apply-pilot:gemini-notice:v1:0123456789abcdef");
  assert.equal(hasSeenGeminiNotice(storage, "0123456789abcdef"), false);
  rememberGeminiNotice(storage, "0123456789abcdef");
  assert.equal(hasSeenGeminiNotice(storage, "0123456789abcdef"), true);
  assert.equal(hasSeenGeminiNotice(storage, "fedcba9876543210"), false, "another account on this browser still sees it");
});

test("without working storage the notice shows every time instead of never", () => {
  const throwing = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } } as unknown as Storage;
  assert.equal(hasSeenGeminiNotice(throwing, "0123456789abcdef"), false);
  assert.doesNotThrow(() => rememberGeminiNotice(throwing, "0123456789abcdef"));
  assert.equal(hasSeenGeminiNotice(null, "0123456789abcdef"), false);
});
