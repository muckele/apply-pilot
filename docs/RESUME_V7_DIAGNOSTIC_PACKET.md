# Resume v7 Single-Request Diagnostic Packet

Status: offline preparation complete and independently reviewed with no remaining findings. No provider request has been made by this phase. Running the command remains a separately authorized, potentially billable action.

## Exact target

- Parse contract: `7`
- Prompt version: `8`
- Cache version: `9`
- Gemini wire schema version: `4`
- Model: `gemini-3.5-flash-lite`
- Synthetic fixture: `tests/fixtures/synthetic-resume-estimator-boundary.docx`
- Source SHA-256: `93c706c5e3cec091218647f027fa1c63cccf48ec6240f74615747fcdd303cf06`
- Request SHA-256: `5b65bbb4a36ab0499992d4aa3eaecd96b40a592d9b0a33ba36d0e56c25a2a440`
- Outbound wire-schema SHA-256: `2e8764c96ef1e4c1b13f828bc5fc72a7a1bdae4bb480a224a222c7f6a59656f4`

The request builder uses the same `prepareResumeParseV7Request` function as the production parser. This covers normalized source admission, deterministic server-owned segmentation, exact record cardinality, canonical response schema construction, Gemini wire projection, and input policy checks before transport.

## Reviewed bounds

- Request body: `18,550` UTF-8 bytes
- Outbound wire schema: `3,475` UTF-8 bytes
- Maximum input tokens: `12,000`
- Maximum output tokens: `24,000`
- Maximum estimated cost: `63,600` micros (`$0.0636`)
- Response body cap: `65,536` bytes
- Timeout: `180,000` ms
- Transport attempts: exactly one; no retries; HTTP redirects are rejected rather than followed

Any source mismatch, request/schema hash drift, version drift, policy drift, segmentation ambiguity, record-cardinality overflow, output-capacity overflow, or maximum-cost increase stops locally before transport.

## Explicit owner command

```sh
./scripts/run-gemini-resume-v7-diagnostic.sh
```

The command is distinct from the historical v6/wire3 command, accepts no credential argument or environment-file path, requires a local interactive TTY, and reads the existing Gemini credential through a masked `/dev/tty` prompt. It emits one sanitized JSON packet and clears its in-process credential reference afterward.

The historical command remains unchanged:

```sh
./scripts/run-gemini-resume-schema-diagnostic.sh
```

It remains pinned to contract v6, wire schema 3, request hash `de2e64078a993b8b31daf7908e6ba24b8ad72fc424c064f55566f50df77399b0`, and schema hash `08a6b93669e1c0ff2b5487193a5d9a69bf40cc817cbe3daa7064e2b6304c054d`.

## In-memory validation path

For an HTTP 200 response with finish reason `STOP` and valid usage, the v7 command performs:

1. synthetic DOCX extraction;
2. production-parity source normalization, section cataloging, and deterministic record segmentation;
3. the single provider request using finite record-ID enums;
4. structured JSON parsing and v7 schema validation;
5. exact record-ID cardinality, identity, and order validation;
6. server-side source-block assembly plus source-supported typed-fact and adjacent-merge guards;
7. returned usage checks against the pinned input, output, and estimated-cost ceilings;
8. application-plan evidence and explicit bounded-omission checks, including work records and highlights;
9. job-match evidence-reference checks for every canonical record and list entry; and
10. exact tailoring projection checks for raw source, work fields and bullets, project fields and bullets, education field of study/details, and certification details.

Contract v7 has no model-owned spans. The former span failure class is replaced by server-owned exact record blocks and finite record IDs; the diagnostic therefore reports record authority and structural record cardinality rather than model span counts.

## Sanitized outcomes

- `validated`: usage is present, v7 assembly passes, and all three consumers pass.
- `rejected`: bounded provider rejection metadata only, with allowlisted field paths and redacted/truncated message evidence.
- `invalid_response`: bounded finish/usage/schema/record/fact/consumer classification without provider output or résumé text.
- `transport_error`: fixed CLI category with no raw exception, credential, source, or provider body.

Provider output is held only in memory for parsing and is never returned or persisted. Oversized bodies are canceled at the cap. Provider-controlled paths, IDs, messages, and diagnostic tokens remain allowlisted and bounded.

## Offline evidence

The focused packet tests prove:

- exact production/diagnostic request parity;
- the pinned source, request, and schema hashes;
- v7/prompt8/cache9/wire4 isolation from historical v6/wire3;
- one request and no retry;
- redirect rejection and returned-usage rejection beyond the reserved token/cost bounds;
- complete synthetic validation through every consumer, including explicit bounded omissions and exact canonical tailoring fields;
- privacy-safe record-reference failure classification; and
- ambiguous source segmentation failing before transport.

## Unvalidated limitations

- Gemini has not received this v7 request, so live schema acceptance, actual model output quality, latency, usage, and charged cost remain unvalidated.
- The fixture is synthetic. This packet intentionally does not test an owner résumé or private corpus.
- The diagnostic does not prove production database persistence, cache writes, or release behavior; those are separately covered by offline route tests and remain outside this one-request proof.
- Model availability, provider pricing, and provider behavior can change after review. The local command rechecks registered cost and every pinned hash, but it cannot predict provider-side changes.
- A validated synthetic response would support release consideration only; it would not authorize merge, deployment, a private résumé parse, or application submission.

## Independent review

The reviewer initially found three gaps: redirects could be followed, returned usage was not checked against the reserved ceilings, and consumer checks did not prove every canonical path or bounded omission. Each finding received a regression test and correction. Re-review found no remaining correctness or privacy blocker and marked this offline packet ready, subject to the live-provider limitations above.
