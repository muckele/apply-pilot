# One-call synthetic resume diagnostic

Status: the separately authorized one-call diagnostic completed once at reviewed head `527778cc48fb2b11738be0661d52f72bd75c298c`. The resulting reference-contract correction is implemented and tested offline. No additional provider call, paid retry, production write, employer interaction, merge, or deployment is authorized.

## Purpose

The earlier separately authorized correction-flow run completed both JOB_MATCH calls. Gemini then returned an HTTP-successful, `STOP`, nonempty parseable JSON response for tailored-resume generation, but the old combined local acceptance catch did not distinguish structural schema rejection from factual-claim rejection. Raw provider output was intentionally not retained, so that historical response cannot be diagnosed retrospectively.

The smallest useful follow-up was one synthetic tailored-resume call. It did not repeat matching, correction, cover-letter generation, persistence, or export. The exact post-correction payload was deterministic and contained the synthetic job, resume, profile, and one job-only owner-attested fact. The diagnostic manifest hashed the complete payload and the complete reviewed-evidence object, including snapshot ID and snapshot hash.

## Frozen envelope

- Calls: exactly 1, stage `tailored_resume`
- Provider/model: Google Gemini Developer API / `gemini-3.8-flash`
- Executed prompt version: `3`
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

## Observed receipt

The authorized call returned HTTP 200, `STOP`, and parseable JSON. Exactly one call started and completed, with 1,297 input tokens, 1,081 output tokens, no cached input, and known estimated cost `$0.005027`. Billing uncertainty was zero; no retry or fallback occurred and no raw output was retained.

Local factual validation stopped at `APPLICATION_DOCUMENT_UNKNOWN_REFERENCE`, path `output.claimEvidence[4].citations[0].ref`. This proves that the fifth claim's first citation used a reference string outside the local resolver namespace. It does not prove the exact generated string because raw output was intentionally not retained. The trailing shell message `zsh: command not found: 2.` occurred only after the launcher had returned to the shell and did not affect the completed request.

## Provider compatibility audit

No provider request-schema rejection occurred. The executed schema allowed citation `ref` as any nonempty string, while the local resolver accepted only an input-dependent closed namespace. The base prompt gave examples and the special reviewed-fact form but did not enumerate every exact permitted reference or forbid child paths. That contract gap allowed a structurally valid response to reach the stricter local unknown-reference guard.

The offline correction derives one exact reference catalog from the submitted payload, appends separate applicant and contextual-job allowlists to both application-document prompts, forbids child paths, and places the same closed enum in both Gemini schemas. Prompt/cache version `4` isolates the corrected contract. The factual validator is unchanged and remains authoritative; unknown citations, unsupported excerpts, job-only support, and fabricated claims still fail closed.

The corrected wire schema uses only `object`, `array`, `string`, `enum`, `properties`, `required`, `additionalProperties`, `items`, and `minItems`. Google documents those features for structured outputs and separately requires application validation for semantically incorrect structured results: <https://ai.google.dev/gemini-api/docs/structured-output#json-schema-support>.

Google lists Gemini 3.8 Flash as supporting structured outputs and LOW thinking: <https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash>. Google also documents that `max_output_tokens` includes thinking tokens and can hard-truncate output; this diagnostic keeps the production 6,000-token cap and LOW thinking unchanged: <https://ai.google.dev/gemini-api/docs/thinking#token-limits-and-max-output-tokens>.

The diagnostic now proves that the returned value passed transport, structured JSON parsing, and Zod shape, then failed the factual validator's reference lookup. A separate prompt/validator tension remains possible for future outputs: the prompt permits stronger action verbs, while the factual validator admits only narrowly source-equivalent rewrites and rejects changed leadership or scope. That validator was not loosened merely to make a diagnostic pass.

## Activation contract

The supported command is:

```sh
npm run correction-flow:diagnose-resume:live -- --expected-head=<full-reviewed-git-sha>
```

The launcher requires a clean exact head and local interactive terminal. It displays one immutable manifest before requesting a credential. The owner must type the exact manifest hash; only then is the existing Gemini key requested through an echo-disabled `/dev/tty` prompt. Keys are not accepted through arguments, environment variables, or repository files.

The one-call runner directly reuses the production Gemini request builder and transport, the input-specific résumé schema/prompt builders, `tailoredResumeSchema`, and `validateTailoredResumeClaims`. A live manifest forbids transport injection. The runner becomes permanently spent after the first attempt, including uncertain transport outcomes.

No additional paid execution is approved. A future call requires separate owner approval of a new exact reviewed head and displayed manifest.

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

The completed call proved that the exact frozen post-correction synthetic input reached Gemini and returned an HTTP-successful, complete, parseable, structurally valid response; it then localized rejection to one unknown citation reference. It did not qualify matching, correction persistence, reassessment, cover-letter generation, exports, browser behavior, real-owner data, or future provider responses.

Offline tests prove that the corrected request publishes and schema-constrains the exact frozen applicant/job reference namespace and that representative child-path and reviewed-fact namespace mistakes still fail locally without exposing generated text. Only a separately approved future provider call could prove current-model conformance to the corrected wire contract; the existing receipt cannot prove that correction prospectively.

## Existing four-call launch guard

The supported four-call command genuinely sets `COMMIT5_POSTGRES_TEST=1` in `package.json`. The launcher independently requires `DATABASE_URL` and `DIRECT_URL` to equal the guarded `TEST_DATABASE_URL`, then verifies the disposable local PostgreSQL identity and PostgreSQL 16 major version. The marker fix is therefore active in the supported invocation; it is not merely diagnostic copy. Direct unsupported invocations without the marker still fail the PostgreSQL safety guard.
