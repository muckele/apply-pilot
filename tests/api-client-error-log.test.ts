import assert from "node:assert/strict";
import { test } from "node:test";

import { PublicApiError } from "@/lib/api-errors";
import { apiErrorResponse } from "@/lib/user-context";

// A 422 from a paid AI call says which check failed and where. The browser already receives
// these details; the server log keeps the same enum-like ones so a failed run can be diagnosed,
// and never any other detail value (such as submitted or generated text).
test("client errors log their code and field path, and no other detail values", async (t) => {
  const lines: string[] = [];
  const original = console.warn;
  console.warn = (line: string) => { lines.push(String(line)); };
  t.after(() => { console.warn = original; });

  const response = apiErrorResponse(new PublicApiError("Application document is missing source evidence for generated claim.", 422, {
    code: "APPLICATION_DOCUMENT_EVIDENCE_REQUIRED",
    fieldPath: "resumeText.line[12]",
    failureClass: "source_relation_mismatch",
    relationReason: "ordered_token_mismatch",
    rewordingFailure: "unsupported_word",
    retryable: false,
    claim: "Closed 400 new enterprise accounts"
  }));
  assert.equal(response.status, 422);
  const entry = JSON.parse(lines.at(-1)!);
  assert.equal(entry.message, "api.client_error");
  assert.deepEqual(entry.error, {
    name: "PublicApiError",
    message: "Application document is missing source evidence for generated claim.",
    code: "APPLICATION_DOCUMENT_EVIDENCE_REQUIRED",
    fieldPath: "resumeText.line[12]",
    failureClass: "source_relation_mismatch",
    relationReason: "ordered_token_mismatch",
    rewordingFailure: "unsupported_word"
  });
  assert.doesNotMatch(lines.at(-1)!, /enterprise accounts/u);
});
