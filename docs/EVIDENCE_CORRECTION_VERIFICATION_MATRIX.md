# Evidence-correction verification matrix

Status: bounded prompt-version `7` hosted conformance is complete for the tailored-résumé and cover-letter wires. The local visible-review implementation is complete offline, while its attendance-dependent live proof remains pending. No production migration, deployment, Fill, employer interaction, or application submission occurred. The result does not yet establish writing quality, durable document approval, or the whole intended user flow.

This matrix bounds what the coordinated correction proves. It complements the targeted independent review; it is not a claim that the whole repository or every future provider response is defect-free.

| Surface or failure mode | Synthetic proof | Status and boundary |
|---|---|---|
| Extraction and parse authority | Complete synthetic DOCX extraction → stubbed provider JSON → v9 validation → route persistence → canonical consumers; omission, invention, reordering, and adjacent-record merge negatives | Tested locally; no real provider or private résumé used |
| Existing reviewed fact survives a no-gap reassessment | Save an owner attestation, reassess with the production JOB_MATCH runner to zero gaps, then save again | Tested on PostgreSQL; legacy v1 is centrally decoded as retain-all |
| Explicit retain/remove/replace contract | v2 requires one ordered action for every current accepted fact; stable fact IDs are independent of positional gap IDs | Retain, remove, and owner-attested replacement tested through the PostgreSQL service; ordered/cross-job IDs and the combined 100-fact bound fail closed; no master-profile promotion |
| Retained source-backed fact | Server rechecks the exact source fact/ref and complete contiguous source lines before carry-forward | Tested through PostgreSQL service persistence; mismatched source provenance is rejected as `EVIDENCE_REVIEW_INVALID` |
| Repeated edits and interrupted UI work | A changed draft invalidates saved UI state; an in-flight reassessment cannot publish stale success; request IDs rotate only after a material draft change | Tested in mounted component and Chromium flow |
| Duplicate clicks and concurrent tabs | Pending UI disables repeat activation; owner-scoped request IDs provide exact replay/conflict semantics; concurrent identical saves converge to one snapshot/pointer | Tested in component, route, and PostgreSQL serialization tests |
| Reassessment currentness | JOB_MATCH input includes current reviewed evidence and publishes only if pointer/generation/source stay current | Tested with pointer-change-during-score and deletion/rebase cases |
| Tailored résumé and cover letter generation | Generation reads the current source and snapshot, and persists the exact snapshot binding | Route-persistence proof uses stubbed providers; the separate paid hosted proof below did not exercise persistence |
| Linked correction-to-document journey | Synthetic DOCX extraction and v9 validation → persisted résumé/job/gaps → v1 decisions → reassessment → v2 retain/replace/remove → reassessment → both generation route handlers → DOCX exports | Tested as one composed PostgreSQL integration with stubbed scorers/providers; exported text contains the retained/replaced facts and excludes the removed fact. This is not an authenticated browser, paid-provider, or intended-runtime proof |
| Ordinary document export | Export rejects a selected document whose binding is null, stale, deleted, or source-invalid | Tested in document-route currentness coverage |
| Application preparation | Preparation requires current analysis and current résumé/cover-letter bindings and rechecks the captured pointer before commit | Tested in unit and PostgreSQL preparation-concurrency coverage |
| Answer-packet publication/rebuild | Current run evidence is checked before packet artifact writes | Tested with zero-write stale unit case; generation-zero legacy runs remain compatible |
| Fill acquisition | Current run evidence is checked before packet verification or attempt persistence; stale evidence maps to the closed `FILL_STALE` result | Tested with zero-write unit coverage; no employer Fill executed |
| Active Fill evidence change | Guarded status rechecks evidence immediately before each field writer; source/snapshot invalidation observed by a check closes permission, finalizes a safe prefix with an untouched tail, and never invokes a later writer | Tested in unit orchestration plus PostgreSQL source-revision, snapshot-deletion, and status-lock races. The response-to-DOM-write interval is unbounded and non-atomic: a change after a successful check can precede that one field write; the next check prevents subsequent writers |
| Consumed Fill | A previously consumed Fill attempt remains the permanent first fence even if evidence later becomes stale | Tested; stale evidence cannot create a second Fill |
| Approved-run document export | Export locks the run and job pointer, then obtains nonblocking shared locks on the master source, snapshot, and selected document binding before returning bytes | Tested on PostgreSQL for supersession, deletion, source revision, concurrent pointer replacement, and delete-lock conflict mapped to privacy-safe stale authority |
| Concurrent pointer replacement | An in-flight export holds current authority; pointer replacement waits, then the next export fails stale | Tested with PostgreSQL lock observation and pinned actor sessions |
| Deletion and source replacement | Snapshot/master-source deletion leaves nonzero generation with no authority; source edit/replacement invalidates the snapshot source fence | Tested sequentially and under PostgreSQL lock races; deletion cannot deadlock an in-flight export, and no historical snapshot is revived |
| Desktop/mobile correction UI | Current accepted facts and explicit actions render without overflow; save/reassess/stale-draft flow works at desktop, 390 px, and 320 px | Tested in real Chromium with mocked save/reassessment responses; this proves layout and client behavior, not the linked persistence journey |
| DOCX/PDF output integrity | Synthetic application documents survive canonical DOCX round-trip and PDF rendering tests | Tested locally and in the separately approved two-document hosted run. Both hosted DOCX artifacts round-tripped exactly and both DOCX/PDF pairs retained critical facts; only hashes and booleans were retained. No visual document approval or durable selection authority is implied |
| Durable exact-document approval | No production `ApplicationDocumentApproval` authority exists | Deliberately deferred; existing selection, packet answer approval, and currentness fences must not be described as durable document approval |
| Correction-flow provider qualification envelope | One frozen synthetic applicant drives initial match → predetermined job-only correction → updated match → tailored résumé → cover letter → both DOCX exports through the production composition points using the manifest-bound provider adapter | Guarded PostgreSQL proof is complete with a dummy credential and stub HTTP transport. All four calls use the production Gemini request path: JOB_MATCH stays on Gemini 3.8 Flash with MEDIUM thinking, while résumé and cover-letter generation use Gemini 3.8 Flash with LOW thinking. The adapter enforces exact order and fixture hashes, sets zero retries, rejects a fifth call, returns privacy-safe diagnostics, and settles an aborted provider operation before cleanup. One separately approved live synthetic run completed both match calls, then stopped after Gemini returned a parseable `STOP` résumé response that failed the local document-acceptance layer. Raw provider output was intentionally not retained, so the exact structural or factual mismatch is unknown. Follow-up coverage separates those failure categories and preserves safe field-path, usage, cost, and provider-completion evidence without retaining output |
| Prompt-v7 hosted document conformance | The reviewed exact 37-fact synthetic payload runs tailored résumé first and cover letter only after résumé validation, then renders and re-extracts both DOCX/PDF pairs in memory | Passed at exact reviewed head `81bae91cc74516e8854719ec5c53d21e363fc1bf`, manifest `54c9817b4bf546ad2f566d46157bf9c5ef6fa139174e9a720285be480725c238`: 2 started/2 completed, 5,841 input and 1,143 output tokens, zero cached, known cost `$0.008668`, zero billing uncertainty, no retry/fallback, all failure fields null. Both document validators and every DOCX/PDF text-integrity check passed. Raw and validated documents were not retained or emitted, so this proves bounded conformance—not prose quality, visual quality, reuse, human approval, persistence/currentness, or intended-flow readiness |
| Visible exact-document review | Contract-v2 offline fixed outputs traverse the production decoders, server-owned fact assembly, factual validators, exact DOCX/PDF verification, one-shot bundle, tokenized loopback delivery, and six required owner attestations | Implemented and tested locally on desktop/mobile with no provider call. Exact output/PDF/source/profile/job/evidence/fact/prompt/model/thinking/generation hashes are bound; wrong origin/host/token/order/hash, missing PDF delivery, partial attestation, duplicate submission, cancellation, timeout, startup failure, and URL-emission failure fail closed with private references cleared and PDF buffers overwritten. The authorized live two-call review remains pending owner attendance, reviewed exact head, and green exact-head CI; offline success is not human writing/visual approval |
| Four-job real qualification runner | Existing runner measures model qualification behavior | Not evidence-correction coverage: it does not exercise persisted corrections. Running another eight paid calls requires separate owner scope and consent |

## Release interpretation

Green rows prove only the bounded synthetic, hosted-document, and local database behaviors named above. Component tests, the mocked Chromium flow, the composed PostgreSQL journey, and the two-call hosted receipt are distinct evidence layers; together they do not constitute an authenticated intended-runtime or live-employer proof. They do not authorize an additional provider call, production migration, live employer form, document approval claim, merge, or deployment. Independent read-only review and exact-head CI are additional quality gates, not production-release authority.

After independent review and green exact-head CI, the attendance-dependent visible-review command is:

```sh
npm run correction-flow:review-documents:live -- --expected-head=<full-reviewed-git-sha>
```

It has no database path and never repeats JOB_MATCH. It displays a contract-v2 safe manifest for exact-hash consent before hidden credential input, then permits at most one résumé call and one cover-letter call. Only validated assembled documents and exact canonical PDFs enter the tokenized loopback session for at most 15 minutes. The command prints no document prose, provider body, credential, or rendered bytes, opens no browser, and takes no screenshot. The current implementation must not be invoked until the owner can attend the local review; no live visible-review receipt exists yet.

The correction-flow envelope can be inspected without reading credentials or starting a provider request:

```sh
npm run correction-flow:qualify:prepare -- --expected-head=<full-reviewed-git-sha>
```

The command fails closed unless the current checkout exactly matches that SHA with no tracked, staged, or untracked changes. It emits the complete safe manifest needed to inspect the envelope, but no raw fixture content. It does not accept consent, open a database, read a provider key, or start execution. Because the timestamp is part of the manifest, this review-only command creates a new hash on every invocation; the live launcher below instead displays and consumes one immutable manifest in the same process.

The same clean-head gate can execute the four-call adapter entirely offline:

```sh
npm run correction-flow:adapter:offline -- --expected-head=<full-reviewed-git-sha>
```

This command creates one manifest-bound authorization covering the exact four Gemini stages, uses only a compiled dummy credential and local stub transport, and emits hashes plus usage metadata rather than prompts, provider bodies, or credentials. The conservative four-call reservation is $0.257565. It exercises the adapter only.

The complete durable flow can be run offline against the guarded disposable local PostgreSQL database:

```sh
npm run correction-flow:qualify:offline -- --expected-head=<full-reviewed-git-sha>
```

`COMMIT5_POSTGRES_TEST` must be `1`, and `DATABASE_URL`, `DIRECT_URL`, and `TEST_DATABASE_URL` must be identical localhost URLs for the exact `apply_pilot_commit5_test` database on PostgreSQL 16. The command uses dummy credentials and stub transports but composes the production job-match runner, evidence-snapshot save, both production document route handlers, DOCX export handlers, verification, and mandatory synthetic-user cleanup. It never resets or migrates the database.

After exact-head review and separate owner approval of the displayed envelope, the local interactive live command is:

```sh
COMMIT5_POSTGRES_TEST=1 \
DATABASE_URL='<identical localhost PostgreSQL 16 test URL>' \
DIRECT_URL='<identical localhost PostgreSQL 16 test URL>' \
TEST_DATABASE_URL='<identical localhost PostgreSQL 16 test URL>' \
npm run correction-flow:qualify:live -- --expected-head=<full-reviewed-git-sha>
```

The package script also sets `COMMIT5_POSTGRES_TEST=1`, so the supported `npm run` entry point cannot omit the required local-test marker. The explicit marker above keeps the Terminal handoff auditable. The live command performs the same clean-head and guarded-database checks before displaying one immutable manifest. A pre-consent failure emits only a bounded failure code with `providerCallsStarted: 0`; it does not surface raw terminal input. Consent is given by typing that exact manifest hash. Only after a match does it request the existing Gemini key through an echo-disabled `/dev/tty` prompt; keys are not accepted through arguments, repository files, or environment variables. The four calls are serialized with zero retries and no provider/model fallback. Provider cancellation settles before cleanup, cleanup runs in `finally`, and a cleanup failure produces a stopped receipt rather than success. The emitted receipt contains only bounded status, usage, cost, failure-path, and content-hash fields.
