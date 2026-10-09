# Evidence-correction verification matrix

Status: local PR verification only; no production migration, provider call, deployment, Fill, or application submission.

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
| Tailored résumé and cover letter generation | Generation reads the current source and snapshot, and persists the exact snapshot binding | Tested with stubbed providers and route persistence; no paid generation call |
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
| DOCX/PDF output integrity | Synthetic application documents survive canonical DOCX round-trip and PDF rendering tests | Tested locally as structural/text integrity; no visual document approval or durable selection authority is implied |
| Durable exact-document approval | No production `ApplicationDocumentApproval` authority exists | Deliberately deferred; existing selection, packet answer approval, and currentness fences must not be described as durable document approval |
| Correction-flow provider qualification envelope | One frozen synthetic applicant drives initial match → predetermined job-only correction → updated match → tailored résumé → cover letter → both DOCX exports through the production composition points with provider stubs | Guarded PostgreSQL proof is complete. The prepare-only command requires a clean exact head and emits the complete hash-only manifest: four-call order, provider/model/prompt identities, input hashes/categories, 180-second step bound, and 166,740-micro conservative reservation while starting zero calls. No credential-bearing live adapter is included or authorized |
| Four-job real qualification runner | Existing runner measures model qualification behavior | Not evidence-correction coverage: it does not exercise persisted corrections. Running another eight paid calls requires separate owner scope and consent |

## Release interpretation

Green rows prove only the bounded synthetic and local database behaviors named above. Component tests, the mocked Chromium flow, and the composed PostgreSQL journey are distinct evidence layers; together they do not constitute an authenticated intended-runtime or live-employer proof. They do not authorize a production migration, real provider call, live employer form, document approval claim, merge, or deployment. Independent read-only review and exact-head CI are additional quality gates, not production-release authority.

The correction-flow envelope can be inspected without reading credentials or starting a provider request:

```sh
npm run correction-flow:qualify:prepare -- --expected-head=<full-reviewed-git-sha>
```

The command fails closed unless the current checkout exactly matches that SHA with no tracked, staged, or untracked changes. It emits the complete safe manifest needed to reconstruct and review its identity, but no raw fixture content. It does not accept consent, open a database, read a provider key, or expose an execution action. A later live run would require a separately reviewed, secure credential-activation adapter that proves abort settlement before cleanup, plus new per-provider/per-call exact-input consent for Google and OpenAI data sharing, the four calls, no retries, and the displayed conservative reservation.
