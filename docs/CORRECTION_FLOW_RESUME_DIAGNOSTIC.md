# Synthetic application-document diagnostics

## Visible local review implementation

Status: **first live review completed with both documents marked needs revision; offline correction implemented; no repeat paid run**. Contract version `2` now composes the prompt-version `8` résumé-first, cover-letter-second generation path with a one-shot validated bundle and a tokenized `127.0.0.1` review session. The session shows full source résumé and target-job context before two full-width, independently scrollable exact PDFs, page-aligned text fallbacks, and server-resolved evidence bindings. It accepts only ordered approve/needs-revision decisions with affirmative all-pages, writing-quality, and visual-layout attestations for both exact document hashes.

The live envelope remains exactly two Gemini 3.8 Flash LOW calls, no JOB_MATCH call, no retry, no fallback, 180 seconds per call, and a `$0.112125` conservative ceiling. Raw provider output is never retained. A validated first document can exist transiently while the second bounded call and export verification finish. Once the two-document bundle is ready, its validated strings and mutable PDF buffers remain only in the local process for a review session capped at 15 minutes; they are released on completion, cancellation, signal, startup/output failure, or timeout. The safe receipt contains only hashes, bounded disposition/reason categories, attestations, usage, cost, and bounded failure metadata. It creates no database row and grants no preparation, export-for-use, Fill, employer, submission, merge, or deployment authority.

After independent review, a clean pushed exact head, and green exact-head CI, the supported command is:

```sh
npm run correction-flow:review-documents:live -- --expected-head=<full-reviewed-git-sha>
```

The launcher prints the immutable safe manifest, requires the owner to type its exact hash, and only then reads the existing Gemini credential through hidden `/dev/tty` input. After both outputs pass decoding, server-owned fact assembly, factual validation, source-aware completeness validation, and canonical export verification, it prints one tokenized loopback URL. It does not open a browser or capture a screenshot. The owner must be present at the Mac to inspect and decide before the 15-minute deadline. The first attended review used two calls and returned `needs_revision` for both documents; it retained no raw provider response or generated prose. The correction described here is offline only and does not authorize another paid run.

The v8 correction replaces the sparse diagnostic source with a realistic fully synthetic résumé and target job, expands the catalog from 37 to 70 source-bound facts, requires the résumé to cover every available source fact (including each bullet and record), requires a complete multi-evidence cover letter, and uses distinct résumé and business-letter PDF layouts. The factual validator remains unchanged in authority: applicant claims still require exact server-owned source bindings and retain negation, quantity, qualifier, ownership, and scope guards. Incomplete but factual documents now fail separately with `APPLICATION_DOCUMENT_INCOMPLETE` and a bounded field path.

The triggering attended review ran at exact head `21c6144cecbe4a5b7522080a7fd7b13e2f3b005e`. Its safe receipt recorded two completed calls, 5,841 input tokens, 1,391 output tokens, known estimated cost `$0.009598`, no retry, no fallback, and no billing uncertainty. The owner marked both documents `needs_revision` with the bounded reason `length`. Because validated prose and raw provider output were not retained, the correction is based on the reproducible sparse-fixture and layout defects rather than a retrospective reconstruction of provider text.

## Current two-document conformance launcher

Status: **hosted synthetic conformance passed** on 2026-10-10 at reviewed head `81bae91cc74516e8854719ec5c53d21e363fc1bf`. The separately approved run exercised both changed prompt-version `7` document wires without repeating either JOB_MATCH call. It requested a tailored résumé first and requested a cover letter only after the résumé passed the production decoder, server-owned fact assembly, final factual validators, and conservative cost check. It then rendered both accepted documents to DOCX and PDF entirely in memory, re-extracted their text, verified critical facts, and retained hashes and booleans only.

The frozen envelope is two calls maximum to `gemini-3.8-flash` at LOW thinking, with 180 seconds per call, no retry, no fallback, and stop after the first failure or billing uncertainty. The résumé reservation is `$0.064500`; the cover-letter reservation is `$0.047625`; the exact total ceiling is `$0.112125`. The fixture has 37 exact source-bound facts. Raw output retention and document-output emission are both disabled. No database, production, or employer interaction is part of the launcher.

The supported command used for this bounded run was:

```sh
npm run correction-flow:diagnose-documents:live -- --expected-head=81bae91cc74516e8854719ec5c53d21e363fc1bf
```

The launcher requires a clean matching head and a local interactive terminal. It displays the immutable safe manifest before credential acquisition, requires the owner to type its exact hash, and reads the existing Gemini key only from an echo-disabled `/dev/tty` prompt. This recorded execution does not authorize another paid run. A new execution requires separate approval of its exact reviewed head, displayed manifest, data-sharing scope, cost, and retention behavior.

## Observed two-document receipt

Manifest `54c9817b4bf546ad2f566d46157bf9c5ef6fa139174e9a720285be480725c238` was generated at `2026-10-10T02:52:54.363Z` for the exact 37-fact synthetic fixture. Both approved calls started and completed. The receipt reported 5,841 input tokens, 1,143 output tokens, zero cached tokens, known estimated cost `$0.008668`, and zero calls with unknown billing. No retry or fallback occurred. Every failure field was null; raw output was not retained and document output was not emitted.

The validated tailored-résumé hash was `fb66e9564ff12b8b40c9e6ae107cc37e44618c434cda24d3dab70fe8515e0f7d`; the validated cover-letter hash was `82065edfe1b83d7e65957c9f12536c790944674b798cd7f0b8c2a90ac67cd8a0`.

| Artifact | Byte hash | Re-extracted text hash | Result |
| --- | --- | --- | --- |
| Résumé DOCX | `c52f51bc26ccb7900df61de6d99435e511e4372e0187299b7bf0937635ce607c` | `6b55ab1d8addde808203d71f93158304c6e94108a4004d902b40da350a238a49` | Exact canonical round-trip and critical facts present |
| Résumé PDF | `484c553b45ca6aec1c472163dedac90f11222b76759223f598e8dde8c432c08e` | `f563a7459441ebdabf3719869e31bbdb06082cac6eb2a5404a91f40e4fc13d45` | Critical facts present |
| Cover-letter DOCX | `f91883c35be19c8f37ef07bfaec509e1f9a5f34e25bfcf6f469cd026e71c1fb8` | `dd9dd2270eaf6e6562ec7c1957a0e0c980516099f67965ed0978bd90c144d952` | Exact canonical round-trip and critical facts present |
| Cover-letter PDF | `eb418ab7f087b0664affddaf0e38c7e378dcc1c75ff55ba23b0609f273d10a99` | `86824138f65aadb532d4669e5f121e5fc9c605a8288dfd67d23cb553c8d78df0` | Critical facts present |

This proves bounded hosted schema/transport compatibility, server-owned fact assembly, factual-validator acceptance, and text-preserving in-memory export for this synthetic fixture. It does not prove writing quality, visual document quality, real-owner data behavior, durable approval, production persistence/currentness, employer compatibility, or the full P0/P1 journey. Because neither validated document nor raw provider response was retained, the generated prose cannot be recovered, displayed, edited, reused, or approved retrospectively.

## Minimum next approval

Do not repeat JOB_MATCH. The separately approved smallest writing-quality step is the contract-v2 two-document generation above against an unchanged, hash-bound evidence snapshot. It retains only post-decoder, post-assembly, post-factual-validation documents long enough for local visible review; raw provider output remains unretained.

The implementation presents the formatted résumé and cover letter plus their current source-fact bindings, binds each accept/reject decision to the exact validated output hash, source/evidence snapshot, job projection, prompt/model version, and generation, and invalidates the decision when any binding changes. It does not infer durable production `ApplicationDocumentApproval` authority from document selection, packet-answer approval, or this synthetic receipt. This local in-memory review proof needs no database migration; durable production approval still requires an explicit schema/authority decision before implementation. No document should enter preparation, export-for-use, or employer flow on a stale or absent production approval.

## Historical one-call résumé diagnostic

Status: the separately authorized historical one-call diagnostic completed once at reviewed head `527778cc48fb2b11738be0661d52f72bd75c298c`. Later paid synthetic evidence showed that closing reference names alone still left verbatim excerpt generation brittle. Prompt version `7` subsequently passed the bounded two-document hosted conformance run recorded above. No additional provider call, paid retry, production write, employer interaction, merge, or deployment is authorized by either receipt.

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

The first offline correction derived one exact reference catalog from the submitted payload, appended separate applicant and contextual-job allowlists to both application-document prompts, forbade child paths, and placed the same closed enum in both Gemini schemas. That historical prompt/cache version `4` correction was later superseded by stricter deterministic writing contracts.

The current prompt/cache version `8` contract removes provider-authored references and excerpts entirely. The server builds a stable ordered catalog mapping each opaque `factId` to one exact source reference, exact standalone excerpt, and provenance. Gemini receives the selectable fact IDs with their source text and provenance, then returns generated prose plus one `factId` per factual item. The server resolves those IDs, derives bullet originals, assembles the existing persisted `claimEvidence`/`claimsUsed` shape, runs the existing negation, qualifier, number, scope, unsupported-term, and source-relation guards, and then runs the separate completeness validator before caching or persistence. The provider schema contains no `ref`, `excerpt`, `citation`, or free-standing evidence collection. The historical one-call résumé diagnostic contract version `2` uses the same provider decoder and assembler; the current two-document launcher has its own contract version `1`.

Validated caches retain only the assembled public document shape. A cache hit validates that assembled shape directly and does not re-run the incompatible provider-wire schema or decoder. Prompt/cache version `8` isolates these entries from legacy versions; no destructive legacy rewrite or database migration is required.

The corrected wire schema uses only `object`, `array`, `string`, `enum`, `properties`, `required`, `additionalProperties`, `items`, and `minItems`. Google documents those features for structured outputs and separately requires application validation for semantically incorrect structured results: <https://ai.google.dev/gemini-api/docs/structured-output#json-schema-support>.

Google lists Gemini 3.8 Flash as supporting structured outputs and LOW thinking: <https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash>. Google also documents that `max_output_tokens` includes thinking tokens and can hard-truncate output; this diagnostic keeps the production 6,000-token cap and LOW thinking unchanged: <https://ai.google.dev/gemini-api/docs/thinking#token-limits-and-max-output-tokens>.

The historical diagnostic proves that the returned value passed transport, structured JSON parsing, and Zod shape, then failed the factual validator's reference lookup. The current offline corpus additionally covers wrong allowed IDs, unknown IDs, duplicate facts, redundant provider metadata, quotes, backslashes, multiline source text, negation, qualifiers, quantities, reviewed evidence, both document types, assembled-cache isolation, route persistence, and the unchanged export shape. The factual validator was not loosened merely to make a diagnostic pass.

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

Offline tests prove that the current request publishes and schema-constrains opaque atomic fact IDs, keeps exact references and excerpts server-owned, and fails representative ID/meaning mismatches without exposing generated text. The later bounded hosted run proves that the reviewed model followed both changed document schemas once for the exact frozen fixture and that both accepted documents survived the in-memory export checks. It does not predict every future response or establish human writing-quality approval. The next proof is the separately approved visible review/currentness step above, not another match run or an unreviewed application attempt.

## Existing four-call launch guard

The supported four-call command genuinely sets `COMMIT5_POSTGRES_TEST=1` in `package.json`. The launcher independently requires `DATABASE_URL` and `DIRECT_URL` to equal the guarded `TEST_DATABASE_URL`, then verifies the disposable local PostgreSQL identity and PostgreSQL 16 major version. The marker fix is therefore active in the supported invocation; it is not merely diagnostic copy. Direct unsupported invocations without the marker still fail the PostgreSQL safety guard.
