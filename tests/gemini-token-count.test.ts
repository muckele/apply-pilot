import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";

import { PublicApiError } from "@/lib/api-errors";
import { countGeminiRequestTokens } from "@/lib/ai/gemini";
import { assertGeminiInputWithinBound } from "@/lib/ai/guarded-gemini";

// The byte-based bound counts every byte as a token. Real requests run ~3-4 bytes
// per token, so an over-bound request asks Gemini's free countTokens method for the
// exact count before giving up. No generateContent call is made here.

function stubFetch(t: TestContext, respond: (url: string, body: unknown) => Response) {
  const calls: Array<{ url: string; body: unknown }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body ?? "null"));
    calls.push({ url, body });
    return respond(url, body);
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = original; });
  return calls;
}

const small = { contents: [{ role: "user", parts: [{ text: "short" }] }] };
const large = { contents: [{ role: "user", parts: [{ text: "x".repeat(80_000) }] }] };

test("countGeminiRequestTokens posts the full request to countTokens and returns the total", async (t) => {
  const calls = stubFetch(t, () => new Response(JSON.stringify({ totalTokens: 21_500 }), { status: 200 }));
  const count = await countGeminiRequestTokens({ apiKey: "key", model: "gemini-3.8-flash", requestBody: small });
  assert.equal(count, 21_500);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:countTokens");
  assert.deepEqual(calls[0]!.body, { generateContentRequest: { model: "models/gemini-3.8-flash", ...small } });
});

test("countGeminiRequestTokens returns null when the count is unavailable", async (t) => {
  stubFetch(t, () => new Response("{}", { status: 500 }));
  assert.equal(await countGeminiRequestTokens({ apiKey: "key", model: "m", requestBody: small }), null);
});

test("a request within the byte bound is admitted without counting", async (t) => {
  const calls = stubFetch(t, () => { throw new Error("must not count"); });
  await assertGeminiInputWithinBound("RESUME_TAILOR", 56_000, small, { apiKey: "key", model: "m" });
  assert.equal(calls.length, 0);
});

test("an over-bound request is admitted when the exact count fits", async (t) => {
  const calls = stubFetch(t, () => new Response(JSON.stringify({ totalTokens: 30_000 }), { status: 200 }));
  await assertGeminiInputWithinBound("RESUME_TAILOR", 56_000, large, { apiKey: "key", model: "m" });
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.url, /:countTokens$/);
});

test("an over-bound request is refused when the exact count is too high or unavailable", async (t) => {
  for (const response of [
    () => new Response(JSON.stringify({ totalTokens: 60_000 }), { status: 200 }),
    () => new Response("{}", { status: 503 })
  ]) {
    stubFetch(t, response);
    await assert.rejects(
      assertGeminiInputWithinBound("RESUME_TAILOR", 56_000, large, { apiKey: "key", model: "m" }),
      (error: unknown) => error instanceof PublicApiError && error.status === 413
    );
  }
});
