# One-call synthetic resume diagnostic

Status: implemented and verified offline only. No provider call, credential read, paid retry, production write, employer interaction, merge, or deployment is authorized by this document.

## Purpose

The earlier separately authorized correction-flow run completed both JOB_MATCH calls. Gemini then returned an HTTP-successful, `STOP`, nonempty parseable JSON response for tailored-resume generation, but the old combined local acceptance catch did not distinguish structural schema rejection from factual-claim rejection. Raw provider output was intentionally not retained, so that historical response cannot be diagnosed retrospectively.

The smallest useful follow-up is one new synthetic tailored-resume call. It does not repeat matching, correction, cover-letter generation, persistence, or export. The exact post-correction payload is already deterministic and contains the synthetic job, resume, profile, and one job-only owner-attested fact. The diagnostic manifest hashes the complete payload and the complete reviewed-evidence object, including snapshot ID and snapshot hash.

## Frozen envelope

- Calls: exactly 1, stage `tailored_resume`
- Provider/model: Google Gemini Developer API / `gemini-3.8-flash`
- Prompt version: `3`
- Thinking: `LOW`
- Maximum input: 56,000 tokens
- Maximum output including thinking: 6,000 tokens
- Standard-price maximum through 2026-12-31: `$0.064500`
- Retry: none
- Provider/model fallback: none
- Raw output retention: none
- Data: synthetic fixture only
- Production/database/employer writes: none

The existing four-call qualification reserves `$0.257565`: two job matches at `$0.072720` each, one tailored resume at `$0.064500`, and one cover letter at `$0.047625`. The one-call diagnostic removes three irrelevant calls and reduces the maximum by `$0.193065`.

The pricing calculation uses the repository's pinned standard rates, which match Google's published rate of `$0.75` per million input tokens and `$3.75` per million output tokens including thinking through 2026-12-31: <https://ai.google.dev/gemini-api/docs/pricing#gemini-3.8-flash>.

## Provider compatibility audit

No concrete request-schema error was found. The wire schema uses only `object`, `array`, `string`, `properties`, `required`, `additionalProperties`, `items`, and `minItems`. Google documents those features for structured outputs and separately requires application validation for semantically incorrect structured results: <https://ai.google.dev/gemini-api/docs/structured-output#json-schema-support>.

Google lists Gemini 3.8 Flash as supporting structured outputs and LOW thinking: <https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash>. Google also documents that `max_output_tokens` includes thinking tokens and can hard-truncate output; this diagnostic keeps the production 6,000-token cap and LOW thinking unchanged: <https://ai.google.dev/gemini-api/docs/thinking#token-limits-and-max-output-tokens>.

The earlier HTTP success, `STOP`, usage metadata, and parseable JSON already show that Gemini accepted the prior request. The remaining unknown is whether the returned value failed the local Zod shape or the factual-claim validator. A prompt/validator tension remains possible: the prompt permits stronger action verbs, while the factual validator admits only narrowly source-equivalent rewrites and rejects changed leadership or scope. That is not a provider-schema defect and must not be loosened merely to make a diagnostic pass.

## Activation contract

The supported command is:

```sh
npm run correction-flow:diagnose-resume:live -- --expected-head=<full-reviewed-git-sha>
```

The launcher requires a clean exact head and local interactive terminal. It displays one immutable manifest before requesting a credential. The owner must type the exact manifest hash; only then is the existing Gemini key requested through an echo-disabled `/dev/tty` prompt. Keys are not accepted through arguments, environment variables, or repository files.

The one-call runner directly reuses the production Gemini request builder and transport, `TAILORED_RESUME_GEMINI_JSON_SCHEMA`, `tailoredResumeSchema`, and `validateTailoredResumeClaims`. A live manifest forbids transport injection. The runner becomes permanently spent after the first attempt, including uncertain transport outcomes.

No paid execution is approved. A future call requires separate owner approval of that exact reviewed head and displayed manifest.

## Privacy-safe receipt

The receipt retains only:

- exact head and manifest hash;
- started/completed call counts;
- HTTP/`STOP`/JSON-parse milestones;
- input, output, cached-input tokens, known cost, and billing uncertainty;
- bounded failure code and output field path;
- a hash of validated output on success;
- explicit no-retry, no-fallback, and no-raw-output flags.

It never retains or emits the model output, credential, request body, applicant text, or private error detail.

## Proof boundary

A passing call would prove that this exact frozen post-correction synthetic input passed the current production Gemini transport, structured schema, Zod schema, and factual validator on that invocation. It would not qualify matching, correction persistence, reassessment, cover-letter generation, exports, browser behavior, real-owner data, or future provider responses. Because generation is nondeterministic, it would not identify the historical response's exact defect.

A structural or factual rejection would localize the new incompatibility by safe code and field path. An HTTP schema rejection would be the first concrete request-schema evidence. A timeout or lost response would remain billing-uncertain and must not be retried.

## Existing four-call launch guard

The supported four-call command genuinely sets `COMMIT5_POSTGRES_TEST=1` in `package.json`. The launcher independently requires `DATABASE_URL` and `DIRECT_URL` to equal the guarded `TEST_DATABASE_URL`, then verifies the disposable local PostgreSQL identity and PostgreSQL 16 major version. The marker fix is therefore active in the supported invocation; it is not merely diagnostic copy. Direct unsupported invocations without the marker still fail the PostgreSQL safety guard.
