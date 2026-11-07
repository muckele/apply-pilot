import assert from "node:assert/strict";
import test from "node:test";

import { APPLICATION_DOCUMENT_MODEL, APPLICATION_DOCUMENT_PROMPT_VERSION } from "@/lib/ai/application-document-version";
import { guardedGeminiMaximumCostMicros } from "@/lib/ai/guarded-gemini";
import { JOB_MATCH_MODEL } from "@/lib/ai/job-match-version";
import { buildDocumentCreationQuote } from "@/lib/jobs/document-creation-quote";

test("the combined quote uses exactly the maxima the guarded requests reserve", () => {
  assert.deepEqual(buildDocumentCreationQuote(), {
    provider: "gemini",
    model: APPLICATION_DOCUMENT_MODEL,
    promptVersion: APPLICATION_DOCUMENT_PROMPT_VERSION,
    jobMatchMicros: guardedGeminiMaximumCostMicros("JOB_MATCH", JOB_MATCH_MODEL),
    resumeMicros: guardedGeminiMaximumCostMicros("RESUME_TAILOR", APPLICATION_DOCUMENT_MODEL),
    coverMicros: guardedGeminiMaximumCostMicros("COVER_LETTER", APPLICATION_DOCUMENT_MODEL)
  });
});

test("without registered pricing there is no quote, so each request asks on its own", () => {
  assert.equal(buildDocumentCreationQuote(new Date("2099-01-01T00:00:00.000Z")), null);
});
