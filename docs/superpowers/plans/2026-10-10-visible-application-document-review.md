# Visible Application Document Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the owner inspect and explicitly accept or reject one newly generated synthetic tailored resume and cover letter in their actual rendered form, while binding the local decision to the exact validated documents and current source/job/evidence/model envelope.

**Architecture:** Keep the existing two-call Gemini diagnostic as the generation and validation authority, but add a separately versioned, explicitly consented owner-review mode. After both outputs pass the production decoders, factual validators, and in-memory export checks, a tokenized `127.0.0.1` session holds only the validated assembled documents and their rendered PDFs for at most 15 minutes. One review page shows both documents and their server-resolved evidence bindings; each decision is bound to the immutable review-envelope and output hashes. Final submission, cancellation, navigation, signal, error, or timeout closes the server and releases the in-process document references. The safe receipt contains hashes, bounded review attestations, categorical dispositions, usage, and cost only.

**Tech Stack:** TypeScript, Zod, Node HTTP, canonical DOCX/PDF renderer, Node test runner, Playwright, Gemini JSON transport.

**Spec:** `docs/CORRECTION_FLOW_RESUME_DIAGNOSTIC.md`

## Global Constraints

- This plan is not implementation, provider-call, retention, commit/push, or production-approval authorization. The consolidated approval gate below must be granted before Task 1.
- Do not repeat either JOB_MATCH call. The future live proof is exactly one resume call followed by one cover-letter call, with no retry or fallback and a conservative combined cap of `$0.112125`.
- The data sent to Google remains the public synthetic correction-flow fixture. The owner's local browser on `127.0.0.1` receives only the validated assembled documents, evidence bindings, and rendered PDFs during review. Afterward, the existing GitHub draft PR may receive only the sanitized hash/category/attestation/cost receipt and proof limits—never document prose, source text, rendered bytes, raw output, credentials, or request bodies.
- Raw Gemini response bodies remain unretained and unrendered. Only decoded, server-assembled, fact-validated documents and their in-memory renderings may enter the review session.
- Do not persist document prose, rendered bytes, free-text review notes, or production approval authority to files, stdout, logs, cache, or database. Stdout is limited to the tokenized local URL during the active session and the final safe hash/category/attestation/cost receipt. That sanitized synthetic receipt may be recorded in the two scoped proof documents and pushed to the existing draft PR; it is evidence metadata, not reusable document approval. Do not take screenshots.
- Do not add or infer durable production `ApplicationDocumentApproval` authority. Local review attestation is proof evidence only and never authorizes preparation, export-for-use, employer Fill, navigation, or Submit.
- Do not add a migration or change production rows. A future durable approval design remains a separate schema and authority decision.
- Keep the historical contract-v1 no-output diagnostic behavior and receipt replayable. The visible-review manifest, consent, session, and receipt use a new contract identity and cache-isolated command.
- Require a clean exact Git head, local interactive TTY, exact manifest-hash consent, and hidden owner-side credential entry before the credential can be read.
- Offline implementation/testing/commit/push and the later live step are blocked until the owner grants the one consolidated approval below. The live step additionally requires a reviewed clean exact head, green exact-head CI, unchanged scope, and exact runtime manifest-hash consent.

## Review Focus

- A valid output with a changed document hash, source-resume hash, reviewed-evidence hash, job-projection hash, prompt/model/thinking identity, manifest hash, exact head, or generation identity must not inherit a prior decision.
- The review endpoint must never expose the raw provider packet, credential, request body, private exception text, unvalidated output, or document prose through a safe receipt or console output.
- The actual canonical PDF bytes must be reviewed, not only a page-count estimate. They remain in memory and are served inline from tokenized same-origin routes with `no-store`; no download action is added. Submission requires both exact PDF hashes to have been delivered and the owner to attest for each document that every page, the writing, and the visual layout were reviewed.
- Both documents appear on one review page. Do not replay the four JOB_MATCH questions or create another multi-step wizard.
- A partial decision, duplicated submission, reordered document identity, concurrent submission, stale envelope, expired session, wrong Host, wrong Origin, guessed path, or post-close request must fail closed.
- Cleanup is best-effort for JavaScript strings and explicit for Buffers: fill render buffers before release, clear all document references, destroy active request bodies, and close the loopback server.
- The existing `SyntheticOneJobReview` is not reused as the authority state machine: it is a client-only fixture that combines applicant questions and editable text snapshots, does not bind cryptographic source/job/evidence/model hashes, and previews estimated pages rather than the exact PDF. The new page reuses its proven single-page interaction, `FormattedDocumentPreview`/pagination semantics, and edit-invalidation expectation, while Task 1 remains the sole decision/currentness authority. Boundary tests must prevent copied question/answer or text-snapshot state from entering the new contract.

---

### Consolidated approval gate: required before Task 1

- [ ] **Ask one explicit owner approval:** authorize the offline TDD implementation, independent review, commits, push to the existing draft PR, and exact-head CI for this plan; then, only if that reviewed exact head is clean and green and the scope/cost/retention manifest is unchanged, authorize exactly two sequential Gemini 3.8 Flash LOW calls using the public synthetic fixture, with no retries/fallbacks/JOB_MATCH calls and a maximum reserved cost of `$0.112125`; allow only the validated assembled resume/cover letter, their source bindings, and canonical PDF bytes to be retained in the local process and displayed to the owner's loopback browser for at most 15 minutes; require terminal cleanup on decision, cancellation, error, signal, or timeout by clearing document references, overwriting PDF Buffers, destroying active requests, and closing the server; raw provider output remains unretained; allow the final hash/category/attestation/cost-only synthetic receipt and proof limits to be committed/pushed to the existing GitHub draft PR, while generated document prose/rendered files remain unpersisted; no database, production, employer, screenshot, merge, or deployment action occurs.
- [ ] **Require exact runtime consent as a second safety latch, not a scope expansion:** after offline work and CI, the launcher prints the final safe manifest and proceeds only when the owner types its exact hash before hidden credential entry. Any scope, model, cost, recipient, lifetime, or retention change requires new owner approval rather than relying on the earlier grant.
- [ ] **Stop if the consolidated approval is not granted.** Planning may be retained, but no implementation, commit, push, provider call, or document retention begins.

---

### Task 1: Freeze the immutable review envelope and decision contract

**Files:**
- Create: `lib/ai/correction-flow-document-review-contract.ts`
- Test: `tests/correction-flow-document-review-contract.test.ts`

**Interfaces:**
- Produces: `buildCorrectionFlowDocumentReviewEnvelope(input): CorrectionFlowDocumentReviewEnvelope`.
- Produces: `createCorrectionFlowDocumentReviewAttestation(envelope, delivery, submission, reviewedAt)`.
- Produces: `isCorrectionFlowDocumentReviewCurrent(attestation, envelope)`.
- Consumes: the diagnostic manifest, synthetic payload, server-resolved fact catalog, validated resume/cover-letter objects, and export hashes.
- Binds: `manifestHash`, `exactHead`, `payloadHash`, `sourceResumeHash`, `profileHash`, `jobProjectionHash`, `reviewedEvidenceHash`, `factCatalogHash`, prompt version, model, thinking level, generation identity, each validated-output hash, and each rendered-PDF hash.

- [ ] **Step 1: Write failing positive tests** for a complete immutable envelope, ordered resume/cover-letter decisions, deterministic envelope hashing, exact PDF-delivery hashes, per-document `reviewedAllPages`/`reviewedWritingQuality`/`reviewedVisualLayout` attestations, and one final hash-only attestation.
- [ ] **Step 2: Write failing currentness tests** that independently change every binding above and prove the previous attestation becomes stale.
- [ ] **Step 3: Write failing validation tests** for a missing decision, missing/false review attestation, missing PDF delivery, duplicate document kind, reversed order, unknown disposition/category, hash mismatch, document prose, raw packet fields, and free-text notes.
- [ ] **Step 4: Run `node --import tsx --test tests/correction-flow-document-review-contract.test.ts`** and confirm the missing contract is the only failure cause.
- [ ] **Step 5: Implement the strict Zod schemas and hash construction** using `hashAiInput`; dispositions are `approved` or `needs_revision`, and optional reasons are bounded enums such as `clarity`, `tone`, `formatting`, `length`, and `other`.
- [ ] **Step 6: Re-run the focused test** and verify the safe serialized attestation contains no document/source/provider prose.
- [ ] **Step 7: Commit this task independently only under the consolidated approval.**

### Task 2: Build the single-page local review surface from existing primitives

**Files:**
- Create: `lib/ai/correction-flow-document-review-page.ts`
- Create: `lib/ai/local-owner-review-http.ts`
- Modify: `lib/ai/job-match-qualification-owner-review-http.ts`
- Test: `tests/correction-flow-document-review-page.test.ts`
- Modify: `tests/job-match-qualification-owner-review.test.ts`

**Interfaces:**
- Consumes: a safe state view with document titles, assembled text, server-resolved evidence bindings, page counts, exact hashes, and review status.
- Produces: one static review shell plus same-origin CSS/JavaScript assets; it does not require Next.js, a database, or a product login.
- Reuses: generic security headers/body bounds extracted from the current owner-review helper and the canonical pagination/profile used by `FormattedDocumentPreview` and export rendering. The qualification-specific page/asset router remains qualification-specific.

- [ ] **Step 1: Write failing markup tests** proving one page contains both document cards, actual-PDF frames, readable assembled text fallback, evidence-binding details, per-document approve/needs-revision controls, required all-pages/writing/layout attestations, and one final submission control.
- [ ] **Step 2: Add negative content tests** proving the page has no JOB_MATCH questionnaire, Apply/Fill/Submit control, edit/regenerate control, download control, raw response view, free-text note field, credential field, or external asset URL.
- [ ] **Step 3: Run `node --import tsx --test tests/correction-flow-document-review-page.test.ts`** and confirm the page module is absent.
- [ ] **Step 4: Extract only the generic HTTP guards** into `local-owner-review-http.ts`, preserve the existing qualification helper API through imports/re-exports, and keep qualification page assets out of the document-review dependency graph.
- [ ] **Step 5: Implement the review page** as a focused variant of the existing owner-review shell, sharing its no-store headers and canonical page sizing rather than adding another product wizard. Its CSP may add only `frame-src 'self'` for tokenized PDF frames; external frames, objects, images, scripts, and connections remain denied.
- [ ] **Step 6: Add an explicit boundary test for the existing synthetic UI.** Prove the new page/session imports Task 1's hash contract and shared pagination only, contains no `SyntheticReviewState`, applicant-question answer map, editable document text, or copied JSON text-snapshot approval logic, and leaves the existing synthetic journey unchanged.
- [ ] **Step 7: Keep the documents read-only.** The current synthetic edit/invalidation demo remains coverage for edit semantics; this proof accepts only the already validated hashes.
- [ ] **Step 8: Re-run the page, synthetic-one-job, and qualification owner-review tests** and inspect the static output for mobile readability, keyboard focus order, labels, explicit synthetic/local/non-authorization copy, and unchanged existing behavior.
- [ ] **Step 9: Commit this task independently only under the consolidated approval.**

### Task 3: Add a tokenized, expiring in-memory owner-review session

**Files:**
- Create: `lib/ai/correction-flow-document-owner-review.ts`
- Test: `tests/correction-flow-document-owner-review.test.ts`
- Test: `tests/browser/correction-flow-document-owner-review.test.ts`

**Interfaces:**
- Produces: `startCorrectionFlowDocumentOwnerReview({ envelope, documents, renderedPdfs, now, sessionTimeoutMs })`.
- Returns: tokenized local URLs plus `finished`, `closed`, `close()`, `hasPrivateInput()`, and safe phase accessors.
- Fixed live lifetime: 15 minutes maximum beginning only after the validated bundle is ready; tests may inject a shorter clock/timeout.

- [ ] **Step 1: Write failing HTTP tests** for bind-on-random-port `127.0.0.1`, a 256-bit unguessable path token, exact Host validation, exact same-origin POST checks, bounded bodies, `private, no-store`, restrictive CSP, no referrer, no framing, and no external fetches.
- [ ] **Step 2: Write failing concurrency and lifecycle tests** for one active submission, duplicate submit, partial decision, stale hash, expiry boundary, cancel, navigation beacon, owner close, `SIGINT`/`SIGTERM` handoff, active request destruction, and post-close rejection.
- [ ] **Step 3: Write failing artifact-route tests** that serve only the two expected PDF buffers inline from tokenized same-origin paths, record delivery only after the full response finishes for the exact expected hash, and reject unknown kind/hash/token/method/range behavior unless explicitly supported.
- [ ] **Step 4: Run the two focused test files** and verify failures are caused by the missing session.
- [ ] **Step 5: Implement the session** with the extracted local owner-review HTTP guards and repeatable-submission admission, while keeping this contract independent from qualification review state.
- [ ] **Step 6: On every terminal path, fill mutable PDF Buffers, null all held document/render references, destroy active body requests, clear the timer, and close the server.** Expose `hasPrivateInput()` so tests can prove release.
- [ ] **Step 7: Add a Playwright journey** that loads both exact PDF routes, reviews both full text/evidence views on desktop and mobile, checks the required all-pages/writing/layout attestations, submits exact decisions, proves the decision and delivered-PDF hashes match the displayed documents, and confirms the page becomes unavailable after completion. A submission before either PDF delivery or with any unchecked attestation must fail.
- [ ] **Step 8: Run `node --import tsx --test tests/correction-flow-document-owner-review.test.ts` and `node --import tsx --test --test-concurrency=1 tests/browser/correction-flow-document-owner-review.test.ts`.**
- [ ] **Step 9: Commit this task independently only under the consolidated approval.**

### Task 4: Refactor validated rendering into an ephemeral review bundle

**Files:**
- Modify: `lib/ai/correction-flow-document-diagnostic.ts`
- Create: `lib/ai/correction-flow-document-review-bundle.ts`
- Modify: `tests/correction-flow-document-diagnostic.test.ts`
- Test: `tests/correction-flow-document-review-bundle.test.ts`

**Interfaces:**
- Produces: `buildCorrectionFlowDocumentReviewBundle({ tailoredResume, coverLetter, envelopeInput })` with assembled text, server-resolved evidence, exact hashes, export-verification metadata, and mutable in-memory PDF Buffers.
- Preserves: contract-v1 runner return type, `rawOutputRetained: false`, `outputEmitted: false`, and current hashes/receipt for the completed historical diagnostic.
- Allows: the new review runner to consume the bundle exactly once without returning it from a public JSON receipt.

- [ ] **Step 1: Add regression tests** proving the historical runner still emits no document/provider prose and has byte-for-byte-compatible safe receipt semantics.
- [ ] **Step 2: Write failing bundle tests** proving only validated assembled objects can enter, DOCX/PDF critical-fact and round-trip checks still gate creation, actual PDF hashes match the held bytes, and raw provider-shaped objects are rejected.
- [ ] **Step 3: Add failure tests** for any export mismatch, mismatched validated-output hash, evidence-binding mismatch, or attempted second consumption.
- [ ] **Step 4: Run both focused files** and confirm the new path is absent while v1 remains green.
- [ ] **Step 5: Extract the minimum shared render/verify code** from the diagnostic and add the opaque one-shot review bundle. Do not expose a generic callback that could bypass manifest consent.
- [ ] **Step 6: Add explicit disposal tests** proving PDF buffers are overwritten and the bundle no longer exposes text/evidence after terminal cleanup, including failures after bundle creation but before a review session exists.
- [ ] **Step 7: Re-run the focused tests** and verify no historical receipt/hash changed unexpectedly.
- [ ] **Step 8: Commit this task independently only under the consolidated approval.**

### Task 5: Add the separately consented live-review manifest and launcher

**Files:**
- Create: `lib/ai/correction-flow-document-review.ts`
- Create: `scripts/run-correction-flow-document-review-live.ts`
- Modify: `package.json`
- Test: `tests/correction-flow-document-review.test.ts`
- Test: `tests/correction-flow-document-review-live.test.ts`

**Interfaces:**
- Produces: contract-v2 safe manifest and consent with `callCount: 2`, `$0.112125` cap, 180-second per-call timeout, `rawProviderOutputRetention: false`, `validatedDocumentPersistentRetention: false`, `validatedDocumentLocalDisplay: true`, `validatedDocumentLifetimeMs: 900000`, `requiredOwnerAttestations: ["reviewedAllPages", "reviewedWritingQuality", "reviewedVisualLayout"]`, and `safeReceiptOnly: true`.
- Produces: a live command requiring `--expected-head=<40-char-sha>` and exact manifest-hash TTY consent before hidden credential acquisition.
- Consumes: the exact frozen 37-fact synthetic payload; Gemini 3.8 Flash LOW; the existing resume-first, stop-on-failure two-call path; and Tasks 1–4.

- [ ] **Step 1: Write failing manifest/consent tests** for the exact recipient, retention, lifetime, cost, call count, ordering, no-retry/no-fallback, no-JOB_MATCH, no production/database/employer actions, and review-envelope bindings.
- [ ] **Step 2: Write failing launcher tests** proving bad arguments, head mismatch, dirty tree, manifest mismatch, non-TTY/hosted runtime, pricing-window risk, and owner cancellation stop before credential read or provider execution as applicable.
- [ ] **Step 3: Write failing success-path tests** with fixed provider outputs: resume validates first; cover validates second; the review server starts only after both export checks pass; the local URL is printed without prose; both exact PDFs are delivered; required review attestations are submitted; one decision receipt is printed after cleanup.
- [ ] **Step 4: Add privacy tests** over stdout/stderr, thrown errors, manifest, and receipt for credential, request body, fixture source text, document prose, citations/excerpts, raw provider output, and PDF bytes.
- [ ] **Step 5: Run both focused test files** and verify the new command and contract are absent.
- [ ] **Step 6: Implement the versioned runner and launcher** without changing default production routes, keys, model defaults, pricing registry, or historical diagnostic command.
- [ ] **Step 7: Wrap bundle ownership, review-server startup, URL emission, waiting, and receipt emission in an outer `try/finally`.** Inject bind/start failure, page-construction failure, stdout failure, and cancellation between bundle creation and session establishment; every case must dispose strings/references and overwrite PDF Buffers.
- [ ] **Step 8: Ensure the launcher prints one tokenized loopback review URL, waits for final decision/cancel/timeout, releases the bundle, then emits only the safe hash/category/attestation/cost receipt.** Do not automatically open a browser or capture a screenshot.
- [ ] **Step 9: Run focused tests** and confirm provider-call count is zero for every offline test.
- [ ] **Step 10: Commit this task independently only under the consolidated approval.**

### Task 6: Offline proof, independent review, and live execution gate

**Files:**
- Modify: `docs/CORRECTION_FLOW_RESUME_DIAGNOSTIC.md`
- Modify: `docs/EVIDENCE_CORRECTION_VERIFICATION_MATRIX.md`
- Modify: only tests/files required by review findings.

**Interfaces:**
- Consumes: the consolidated approval granted before Task 1 and the owner's exact runtime manifest-hash consent.
- Produces: an exact-head offline evidence package and, only after the live gates pass, the authorized two-call sanitized receipt.
- Does not produce: a generated document file or screenshot, durable production approval, production write, merge, or deployment.

- [ ] **Step 1: Run the focused contract/page/session/bundle/launcher tests** with independently fixed synthetic outputs, not expectations copied from the fixture.
- [ ] **Step 2: Run `npm test`, `npm run test:browser`, `npm run typecheck`, `npm run lint`, and the repository diff/format check** serially. Run `npm run test:postgres` only if implementation unexpectedly touches a PostgreSQL path, using a new disposable local PostgreSQL 16 database and the official guarded runner.
- [ ] **Step 3: Obtain independent read-only review** focused on output leakage, loopback security, cleanup, exact-hash currentness, consent truthfulness, canonical PDF fidelity, historical v1 preservation, and absence of production authority.
- [ ] **Step 4: Resolve review findings TDD-first, repeat affected checks, commit/push the reviewed exact head to the existing draft PR under the consolidated approval, and wait for exact-head CI.**
- [ ] **Step 5: Reconfirm the consolidated approval still exactly matches the final manifest.** If scope, model, cost, recipient, lifetime, retention, exact-head status, or CI changed, stop for new approval.
- [ ] **Step 6: If unchanged, run once from the approved clean exact head only after the owner types the exact runtime manifest hash and enters the credential through hidden TTY input.** Stop after any failure, rejection, timeout, unknown billing, or cancellation; do not retry.
- [ ] **Step 7: Record only the sanitized receipt and precise proof limits in the two scoped documentation files, then commit/push that metadata to the existing draft PR under the consolidated approval.** Only a result with both exact PDF-delivery hashes and all six affirmative review attestations proves visible synthetic writing/format review for those exact hashes. Any incomplete attestation proves only that documents were made available. Neither result authorizes owner-data generation, durable production approval, application preparation, employer compatibility, merge, or deployment.
