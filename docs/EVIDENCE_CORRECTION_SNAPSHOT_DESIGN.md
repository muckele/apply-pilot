# Evidence correction snapshot — decision-ready persistence design

Status: **approved local implementation in review; additive migration, authenticated save endpoint, reassessment, generation bindings, and stale-consumer guards implemented but not deployed**

## Plain-English outcome

The local implementation lets Apply Pilot remember one owner-reviewed, job-specific evidence correction and reliably answer three questions:

1. Which exact résumé and JOB_MATCH analysis did the owner review?
2. Which disputed gaps were left unresolved, corrected from existing source text, or supplied as an explicit owner attestation?
3. Were a later assessment, tailored résumé, or cover letter created from that same reviewed evidence snapshot?

It does not rewrite the master résumé, make an attested fact globally reusable, approve an application document, call a provider merely by saving, or authorize an application. Deployment and production migration remain separate decisions.

## Current correction contract

The review surface displays `apply-pilot/reviewed-evidence-snapshot/v1`; the authenticated save route now emits the bounded `apply-pilot/evidence-snapshot-save/v2` request and persists the server-reconstructed `apply-pilot/evidence-snapshot-payload/v2` authority. The decoder still accepts historical v1 requests and immutable v1 payloads; a v1 save retains every current accepted fact, while v2 requires one ordered retain, remove, or owner-attested replacement action for every current accepted fact.

The persisted authority contains:

- job ID, source résumé ID, and source résumé `updatedAt`;
- the ordered extracted-fact projection, including raw-source fallback and typed summary, grouped skills, achievements, work, projects, education, and certifications;
- current disputed requirement gaps and their exact job references;
- one decision per current gap: unresolved, existing-source correction, or owner-attested addition;
- the complete effective set of current accepted job-only facts, with stable fact IDs independent of positional gap IDs;
- provenance, reuse scope, and explicit master-profile opt-in state;
- privacy-safe invalidation IDs and counts for the current assessment and selected documents;
- a review timestamp and SHA-256 hash over canonical JSON, excluding the hash field itself.

Typed projections remain visible for parser review, but only raw résumé text and per-record `sourceText` are source-authoritative citation targets. A source correction must select one or more complete contiguous server-owned source lines, and the source-backed fact must equal that complete selection. The server derives the persisted line range from its authoritative source rather than trusting a browser substring. Substring extraction is rejected so a correction cannot strip negation or other semantic context. An owner-attested addition is a different provenance class and requires an explicit attestation.

The durable design intentionally stores less than the browser preview: payload v2 stores effective accepted facts, unresolved gap IDs, and the minimum exact provenance needed to explain them, plus hashes of the server-reconstructed source and gap projections. It does not duplicate the complete raw résumé or the complete displayed fact catalog. Retained source-backed facts are revalidated against the current authoritative résumé source; owner attestations remain job-scoped and are never promoted to the master profile.

## Existing storage audit and reuse decision

| Existing record | What it already provides | Why it cannot be the correction authority | Reuse decision |
|---|---|---|---|
| `Resume` | Raw text, typed parsed fields, source file metadata, and `updatedAt` | It is the parser output and master source. Mutating it with job-specific corrections would mix source evidence, attestations, and generated projections; it also cannot represent one correction per job/analysis without duplicating résumés. | Reference the exact row and `updatedAt`; do not mutate it. |
| `AIAnalysis` | Immutable-looking model/prompt/input-hash record with full input/output JSON | Its output is a model result, not owner-reviewed authority. Putting owner decisions in `output` would blur model and owner provenance and make retries/versioning ambiguous. | Reference the reviewed analysis and add a nullable snapshot binding for later analyses. |
| `JobPosting` denormalized fit fields | Fast presentation of the latest scores and angles | They have no evidence identity and can be stale independently of the model/prompt/input hash. They cannot establish which reviewed facts produced a score. | Keep unchanged; add one nullable current-snapshot pointer. |
| `Application.resumeVersionId` / `coverLetterVersionId` | The documents currently selected for an application | Selection is not approval. These fields contain no content hash, approval time, provenance, or evidence identity. | Keep selection semantics. Determine staleness through the selected document’s snapshot binding. |
| `ResumeVersion` / `GeneratedDocument` | Generated or edited document content and job/application ownership | Neither records the reviewed evidence snapshot used to create it. `changeNotes` and `metadata` are not relational currentness guarantees. | Add one nullable snapshot binding to each type. |
| `ApplicationRun.evidenceCatalogSnapshot` | A bounded evidence catalog captured when a managed application run is prepared | It exists only after run preparation, is a lossy planner projection, lacks correction decisions and owner-attestation provenance, and is deleted with the run. Using it would make correction authority depend on a later execution phase. | Continue using it as a run snapshot, not correction storage. |
| `ApplicationRunAnswer.evidenceIds` and answer review fields | Run/packet-scoped employer-field provenance and review state | These rows concern individual employer form answers. Current packet rules do not make them a general career-evidence ledger, and they cannot precede a run. | Do not reuse. |
| `AuditLog.metadata` | Append-only operational audit events | It has no typed foreign keys, current pointer, uniqueness/idempotency contract, or efficient currentness query. Audit metadata should describe a committed change, not become the change’s authority. | Optionally write a bounded audit event later; never use it as the snapshot record. |
| Synthetic local document approval | A tested UI concept that invalidates when fixture text changes | It is intentionally browser-local and synthetic. There is no durable production document-approval record to reuse. | Do not infer durable approval from it. |

## Smallest sound additive package

The smallest sound first persistence package is **one new immutable table, four nullable binding columns, and one monotonic job generation marker**. It does not include the previously proposed status enum, parent pointer, document-approval table, or reusable `CareerFact` ledger.

### New `EvidenceSnapshot` table

| Field | Type | Why it is necessary | Retained data |
|---|---|---|---|
| `id` | `String @id @default(cuid())` | Stable opaque identity for equality checks and foreign keys | Random identifier |
| `userId` | `String` | Enforces tenant ownership and supports account deletion/export | Owner reference only |
| `jobPostingId` | `String` | Corrections are job-specific and must not silently affect another job | Job reference only |
| `resumeId` | `String` | Identifies the exact parsed source authority | Résumé reference only |
| `reviewedAnalysisId` | `String` | Identifies the exact disputed-gap/model result the owner reviewed | Analysis reference only |
| `requestId` | `String` | Makes uncertain client retries idempotent and detects reuse with different content | Opaque client-generated key |
| `requestHash` | `String` | Distinguishes an exact retry from reuse of the same request ID with a different bounded request body | SHA-256 of the normalized request envelope |
| `schemaVersion` | `Int @default(1)` | Allows future readers to decode the immutable payload safely | Small integer |
| `sourceResumeUpdatedAt` | `DateTime` | Fails closed if the source résumé changed between review and save | Timestamp copied from the source fence |
| `snapshotHash` | `String` | Canonical identity for exact replay/deduplication | SHA-256 only |
| `sourceProjectionHash` | `String` | Proves which ordered server-reconstructed fact projection was reviewed without storing the full résumé again | SHA-256 only |
| `gapProjectionHash` | `String` | Proves which ordered server-reconstructed disputed-gap projection was reviewed | SHA-256 only |
| `reviewPayload` | `Json` | Retains schema-versioned effective facts, unresolved gaps, provenance, reuse scope, exact cited excerpts for source corrections, and attested text | Minimum reviewed excerpts and decisions; no complete raw résumé |
| `createdAt` | `DateTime @default(now())` | Server-authoritative review-save/audit time | Timestamp |

Required constraints and indexes:

- unique `(userId, requestId)` for owner-scoped idempotency;
- index `(userId, jobPostingId, snapshotHash)` for canonical-equality lookup within a job;
- index `(userId, jobPostingId, createdAt)` for history;
- index `(resumeId, sourceResumeUpdatedAt)` for source-currentness checks;
- index `reviewedAnalysisId` for analysis linkage;
- tenant-scoped foreign keys to `User`, `JobPosting`, `Resume`, and `AIAnalysis`;
- immutable snapshot content after insert.

`reviewPayload` is a closed, schema-versioned object. In this first package, every durable decision must have `reuseScope: "JOB_ONLY"`. `MASTER_PROFILE` remains preview-only and is rejected by the save endpoint.

`requestHash` is only an equality fingerprint for retry handling. It is computed from a normalized, bounded request envelope containing the submitted IDs, source/version fences, and ordered decisions. It does not make browser claims authoritative. `snapshotHash` remains the server-derived canonical identity after current source and gap projections have been reconstructed and validated.

### Four nullable bindings

1. `JobPosting.currentEvidenceSnapshotId String?`
   - This is the single current pointer for the job.
   - Without it, “current” would have to be inferred from timestamps or a mutable status on multiple snapshot rows, which is race-prone.
   - A snapshot is current exactly when its ID equals this pointer; every other snapshot is historical.

2. `AIAnalysis.evidenceSnapshotId String?`
   - A newly run JOB_MATCH analysis must state which reviewed evidence snapshot it consumed.
   - Currentness requires the existing model/prompt/input-hash checks **and** equality with `JobPosting.currentEvidenceSnapshotId`.
   - The analysis that originally exposed the disputed gaps remains historical after a new correction snapshot; it is referenced by `reviewedAnalysisId` but is not rebound as if it consumed the correction.

3. `ResumeVersion.evidenceSnapshotId String?`
   - A tailored résumé must state which reviewed evidence snapshot it used.
   - A selected résumé is stale when this ID is null or differs from the job pointer.

4. `GeneratedDocument.evidenceSnapshotId String?`
   - A generated cover letter or other job document needs the same exact evidence binding.
   - A selected cover letter is stale when this ID is null or differs from the job pointer.

### Monotonic deletion marker

`JobPosting.evidenceSnapshotGeneration Int @default(0)` distinguishes a never-reviewed legacy job from a job whose reviewed snapshot was later deleted and whose nullable pointer was consequently cleared. A successful new snapshot save increments the generation exactly once in the same transaction that installs its non-null pointer. Deleting a snapshot may clear the pointer through `ON DELETE SET NULL`, but it does not decrease or reset the generation.

The generation is server-owned freshness metadata, not applicant evidence. It participates in JOB_MATCH input hashing so an old null-bound/bootstrap analysis cannot become current again after a reviewed snapshot is deleted. Database checks and triggers reject negative values, decreases, pointer changes without the required increment, and generation-only changes while the pointer is unchanged. Existing jobs remain at generation zero; no backfill guesses history.

Existing rows remain null and therefore historical/unbound. No backfill may guess which evidence produced them.

## Why the earlier status enum is not recommended

The earlier proposal added `EvidenceSnapshotStatus(REVIEWED, SUPERSEDED)` and changed the previous row whenever a new snapshot became current. That duplicates the meaning of `JobPosting.currentEvidenceSnapshotId` and creates two authorities that can disagree.

The smaller design keeps snapshots immutable and derives state:

- current: `snapshot.id == job.currentEvidenceSnapshotId`;
- historical: any other snapshot for that job;
- deleted: no row, following the deletion rules below.

This removes an enum, a mutable update, and a consistency invariant from every save transaction. A parent snapshot pointer is also unnecessary for the first workflow because ordered history is available from `(jobPostingId, createdAt)` and currentness comes from the job pointer. Exact lineage can be proposed later only if a real merge/branch use case appears.

## Why a document-approval table is deferred

The existing application fields select a résumé and cover letter; they do not approve them. Reusing those fields as approval would be unsafe because selection can happen before review and carries no content hash or approval event.

A dedicated `ApplicationDocumentApproval` table would eventually be the sound design for durable exact-document approval, because it could bind:

- owner and application/job;
- evidence snapshot;
- exactly one résumé version or generated document;
- content hash and document kind;
- approval and invalidation timestamps/reasons.

However, that table is not necessary to persist the approved **evidence correction** workflow. In the first package, changing the current evidence snapshot makes selected documents stale through their snapshot-ID mismatch. Nothing becomes approved merely because it is selected. Adding durable document approval now would create retention, export, editing, and invalidation semantics beyond the approved correction scope.

Recommendation: defer `ApplicationDocumentApproval` to the separately reviewed exact-document-approval phase. When proposed, its SQL must enforce exactly one document reference. Do not repurpose `ApplicationRunAnswer` approvals, because those authorize run-specific employer-field answers rather than the résumé or cover letter as a whole.

## Why reusable master-profile evidence is deferred

Do not write owner-attested or job-specific corrections into the parsed `Resume` JSON. A reusable fact needs its own provenance-bearing `CareerFact` design: claim text, source or attestation class, allowed use, conflict/supersession state, and explicit promotion audit.

That is broader fact-authority work. The smallest package rejects durable `MASTER_PROFILE` decisions and stores job-only review. A later owner decision can approve a `CareerFact` ledger without rewriting these immutable snapshots.

## Save endpoint trust boundary

The browser-built fact list, gap list, hashes, provenance markers, and `sourceAuthoritative` flags are untrusted preview data. The implemented save endpoint:

1. authenticate the owner;
2. parse and validate a bounded request, normalize its submitted IDs, source/version fences, and ordered decisions, and compute `requestHash`;
3. begin a transaction and lock the tenant-owned `JobPosting` row before making a currentness decision;
4. look up `(userId, requestId)` immediately after the lock:
   - if an existing row has the same `requestHash`, return that original snapshot as a read-only idempotent replay, reporting whether it is still current without changing the job pointer;
   - if an existing row has a different `requestHash`, fail closed with an idempotency conflict;
5. only for a new request ID, load and re-read the current source résumé, exact reviewed analysis, and selected artifacts after the lock;
6. require the submitted résumé ID/`updatedAt`, analysis ID, JOB_MATCH input hash, model, and prompt version to remain current;
7. reconstruct the ordered authoritative facts and disputed gaps on the server;
8. revalidate every source correction and attestation against that reconstruction;
9. for v2, require one ordered retain, remove, or replacement action for every current accepted fact; for legacy v1, decode omission as retain-all;
10. revalidate every retained source-backed fact against the current server-owned source and merge by stable fact identity, never by positional gap ID;
11. reject `MASTER_PROFILE` scope in the first persistence version;
12. compute the projection hashes and canonical snapshot hash on the server;
13. insert the immutable snapshot, increment the generation, and update the job pointer in one transaction;
14. optionally append a bounded audit event that contains IDs/counts, not raw résumé text.

The endpoint must never persist a browser-supplied hash as canonical authority or accept a browser-designated typed projection as source authority. The normalized `requestHash` is used only to establish byte-independent request equality for retries; it cannot establish source truth or currentness.

## Idempotency and concurrency

The save transaction uses the job row as the serialization point.

1. Authenticate, bounded-parse, normalize, and compute the incoming `requestHash` before opening the transaction.
2. Start a transaction and lock the tenant-owned `JobPosting` row `FOR UPDATE`.
3. Look up `(userId, requestId)` before validating current source fences:
   - if it exists with the same `requestHash`, return the original snapshot as an idempotent replay; derive and report its current/historical state from the job pointer, but do not update that pointer;
   - if it exists with a different `requestHash`, fail closed with an idempotency conflict and do not update the pointer.
4. Only when the request ID is new, recheck the source résumé and reviewed-analysis fences after the lock.
5. Reconstruct and validate the canonical payload, then compute the server-authoritative projection and snapshot hashes.
6. Insert the snapshot. Two distinct request IDs may create canonically equal immutable rows; this preserves a durable replay record for each idempotency key without adding a separate request table.
7. Update `JobPosting.currentEvidenceSnapshotId` to the newly accepted snapshot ID and increment `evidenceSnapshotGeneration` exactly once.
8. Commit.

Two different requests racing for the same job cannot both believe they are current: the job lock orders them, and the later successful transaction becomes the pointer. The earlier snapshot remains immutable history. No old analysis or document row needs an invalidation write; non-currentness is derived by snapshot-ID comparison, eliminating partial invalidation updates.

A retry of an older successful request is read-only even if its reviewed analysis or résumé fence is now historical. It returns the original snapshot and its derived current/historical state; it never promotes that snapshot or rewinds the current pointer.

Generation and reassessment operations must capture the current pointer and monotonic generation under their own transaction/fence, bind their new row to that exact state, and recheck before commit. If either changes during work, they fail stale rather than publish an artifact against the wrong evidence. A master-résumé source change invalidates the reviewed pointer; a fresh null-bound JOB_MATCH at a nonzero generation is exposed only as a rebase candidate for another owner review, not as permission to reuse deleted or stale corrections.

Prepared-run answer-packet publication, Fill acquisition, and approved document export also lock and re-read the current job pointer, source résumé revision, snapshot, and selected document bindings. After the job lock, dependent-row shared locks use `NOWAIT`: if concurrent snapshot/source deletion already owns a dependent row while waiting to clear the job pointer, the operation rolls back as privacy-safe stale authority instead of completing a circular wait. Pointer replacement serializes behind an in-flight export; deletion, source replacement, or a binding mismatch fails closed before a new Fill attempt or export.

An active Fill rechecks the same evidence authority in its guarded status transaction immediately before every field writer. The transaction holds shared source/snapshot authority through the response, so a concurrent source revision waits behind that check; the next check sees the revision and returns closed `FILL_STALE`. The browser finalizes any already-safe prefix and marks the untouched tail `NOT_ATTEMPTED`, without invoking another writer. The response-to-DOM interval is not bounded or transactionally atomic: if evidence changes after a successful check, the immediately following field may still be written, while the next check prevents every subsequent writer. A run that already consumed its single Fill attempt remains permanently consumed even if its evidence later becomes stale. Generation-zero legacy runs remain readable; once a job has evidence history, a null or stale pointer cannot regain authority.

## Rollback and failure behavior

- Validation, authorization, hash, or conflict failure before commit writes nothing.
- An exact retry of an existing request is read-only and cannot change the current pointer, even after a newer snapshot exists.
- Failure inside the transaction rolls back both the snapshot insert and pointer update; the prior pointer remains authoritative.
- A failed reassessment or document generation does not roll the pointer back and does not make an old artifact current.
- Application-code rollback after an additive migration should leave the nullable columns/table in place; production must not use a destructive down migration. Feature activation should be gated so old code is not restored after it has begun treating a new pointer as authoritative.
- A later defect should be corrected with a forward fix or by creating a new reviewed snapshot. Immutable historical snapshots are not edited in place.

No production migration or feature activation is authorized by this implementation review.

## Retention, export, and deletion implications

- The table retains only job-specific decisions, minimal cited excerpts, attested text, hashes, references, and server timestamps. It does not retain another full résumé body.
- Historical snapshots remain until the owner deletes the owning job/résumé/account or a separately approved retention policy safely prunes unreferenced history.
- Account deletion must cascade snapshots with the rest of the owner’s data.
- Deleting the owning job should cascade its snapshots.
- Deleting the source résumé or reviewed analysis should also remove dependent snapshots (or be refused until the job snapshot is removed); the implementation must choose one explicit foreign-key policy and test account/job deletion as a complete graph. The recommended policy is cascade for these job-scoped snapshots, with `JobPosting.currentEvidenceSnapshotId` using `ON DELETE SET NULL` when a snapshot itself is removed.
- Artifact bindings use `ON DELETE SET NULL`. A retained document whose snapshot was deleted becomes clearly unbound/historical; it never becomes current by deletion.
- User data export should include snapshot metadata and `reviewPayload` so owner attestations and cited excerpts are visible to the owner.
- Audit events must not outlive the user as anonymous copies of correction text. If an audit row uses `onDelete: SetNull`, its metadata must contain IDs/counts only, not excerpts or attested facts.
- No automatic TTL is recommended in this first package because deleting a snapshot still referenced by a generated artifact would erase its provenance. A later retention policy must first prove reference-safe pruning.

## Alternatives considered

| Alternative | Advantage | Reason not recommended |
|---|---|---|
| Store corrections in `Resume` JSON | No new table | Mixes source parsing with job-specific owner decisions and silently changes other jobs |
| Store corrections in `AIAnalysis.output` | No new table | Mislabels owner decisions as model output and prevents clean versioning/idempotency |
| Store only an `AuditLog` event | Reuses append-only storage | No current pointer, foreign keys, replay contract, or efficient currentness checks |
| Reuse `ApplicationRun.evidenceCatalogSnapshot` | Existing evidence JSON | Created too late, lossy, run-scoped, and lacks correction provenance |
| Put snapshot IDs inside document `metadata`/analysis `input` JSON | Avoids columns | No relational integrity, poor queryability, and easy for one consumer to forget |
| Status enum without a job pointer | Fewer job columns | Requires mutable multi-row state and a partial-unique invariant; harder concurrency and rollback |
| Add both status and job pointer | Explicit labels | Duplicated authorities can disagree; unnecessary write on the prior snapshot |
| Treat application selection as document approval | No approval table | Selection has no approval/hash semantics and would overstate user intent |
| Add `ApplicationDocumentApproval` now | Future-complete approval history | Expands beyond correction persistence; exact-document approval policy is not yet approved |
| Add `CareerFact` now | Enables global reuse | Expands job-only correction into master-profile authority without a reviewed conflict model |

## Implemented local scope

The reviewed local package contains only:

1. the immutable `EvidenceSnapshot` table and constraints described above;
2. nullable `JobPosting.currentEvidenceSnapshotId` plus monotonic `evidenceSnapshotGeneration`;
3. nullable `AIAnalysis.evidenceSnapshotId`;
4. nullable `ResumeVersion.evidenceSnapshotId`;
5. nullable `GeneratedDocument.evidenceSnapshotId`;
6. required relations/indexes and explicit deletion behavior;
7. no backfill and no rewrite of legacy rows.

Explicitly excluded from this package:

- `EvidenceSnapshotStatus` and mutable supersession state;
- `parentSnapshotId`;
- `ApplicationDocumentApproval`;
- `CareerFact` or any reusable-master-profile write;
- reusable profile persistence, production writes, migration deployment, real provider calls, application submission, or autonomous employer interaction.

The additive migration was exercised only through the guarded disposable PostgreSQL test runner. It has not been run remotely or deployed. A separately approved release would still be required before production persistence is available.
