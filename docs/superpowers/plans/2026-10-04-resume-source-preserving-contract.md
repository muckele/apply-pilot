# Source-Preserving Resume Parse Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace model-copied lossless résumé text with server-bound exact section envelopes and validated structural line spans while preserving all current guards and consumers.

**Architecture:** The server builds one immutable normalized source catalog and sends an annotated line-ID representation to the provider. The model returns semantic projections and structural span references; the server validates those references, slices the original source exactly, and assembles the canonical parsed resume before persistence.

**Tech Stack:** TypeScript, Zod, Node test runner, Next.js route tests, Gemini/OpenAI adapters.

**Spec:** `docs/RESUME_SOURCE_PRESERVING_PARSE_CONTRACT.md`

## Global Constraints

- This plan is not implementation authorization.
- Preserve exact source order, omission, invention, adjacent-record merge, and typed source-support guards.
- Do not change provider keys, default models, financial limits, production data, or database schema without separate approval.
- Do not rewrite stored v3/v5 results; decode them centrally.
- No paid provider call, merge, or deployment without a new explicit authorization.
- Build the complete synthetic DOCX path before requesting another diagnostic.

## Review Focus

- A blank-line-heavy structural section must retain exact source slices without turning separators into facts; Task 3 tests coverage and slicing.
- A model span that uses valid IDs from two different sections must fail before assembly; Task 3 tests section ownership.
- Unicode source lines must not depend on model-counted character offsets; Task 1 tests line-ID catalog stability.
- Repeated identical lines must remain distinguishable by position IDs; Tasks 1 and 3 test duplicate text at distinct IDs.
- A legacy cached v5 result must never replay under the new prompt/cache grammar; Task 5 tests version isolation.

---

### Task 1: Immutable source catalog

**Files:**
- Create: `lib/ai/resume-source-catalog.ts`
- Modify: `lib/ai/resume.ts`
- Test: `tests/resume-source-catalog.test.ts`

**Interfaces:**
- Produces: `buildResumeSourceCatalog(rawSource: string): ResumeSourceCatalog`.
- Produces: stable section and line IDs mapped to exact normalized slices and offsets.
- Consumes: existing heading recognition and line-ending normalization behavior from `lib/ai/resume.ts`.

- [ ] **Step 1: Write failing catalog tests** for the full synthetic fixture, CRLF normalization, Unicode, repeated identical lines, blank separators, unsupported unheaded structure, and exact section order.
- [ ] **Step 2: Run `node --import tsx --test tests/resume-source-catalog.test.ts`** and verify failures are caused by the missing catalog.
- [ ] **Step 3: Implement `buildResumeSourceCatalog`** with deterministic position IDs and exact offset ownership; move only the minimum existing private helpers needed to avoid duplicate heading rules.
- [ ] **Step 4: Run the catalog tests** and verify all pass.
- [ ] **Step 5: Record a verified checkpoint** and commit it independently only if the owner has separately authorized commits for the implementation phase.

### Task 2: Provider span contract and version isolation

**Files:**
- Modify: `lib/ai/resume.ts`
- Modify: `prompts/resumeParsePrompt.ts`
- Test: `tests/resume-parse-provider.test.ts`
- Test: `tests/resume-contract-v5.test.ts`

**Interfaces:**
- Consumes: `ResumeSourceCatalog` from Task 1.
- Produces: new provider-output Zod and JSON schemas with `{ sectionId, startLineId, endLineId }` spans and typed-record `spanIndex` references.
- Produces: coherent prompt, cache, contract, and Gemini wire revisions.

- [ ] **Step 1: Write failing schema tests** proving the provider no longer returns source envelopes or structural `sourceText`, every structural record references one bounded span, generic Gemini and OpenAI behavior remain isolated, and old caches miss.
- [ ] **Step 2: Run the focused provider tests** and verify the old v5 wire shape causes the expected failures.
- [ ] **Step 3: Implement the new schema and prompt** without changing local source authority or consumers yet.
- [ ] **Step 4: Run focused tests** and verify the exact wire delta and version constants.
- [ ] **Step 5: Record a verified checkpoint** and commit it separately only if the owner has separately authorized commits for the implementation phase.

### Task 3: Span validation and exact server slicing

**Files:**
- Create: `lib/ai/resume-source-spans.ts`
- Modify: `lib/ai/resume.ts`
- Test: `tests/resume-source-spans.test.ts`
- Test: `tests/resume-contract-v5.test.ts`

**Interfaces:**
- Consumes: source catalog and provider span output from Tasks 1 and 2.
- Produces: `assembleParsedResumeFromSpans(catalog, providerOutput): ParsedResumeVNext`.

- [ ] **Step 1: Write failing negative tests** for unknown IDs, reversed ranges, cross-section ranges, overlap, gap, duplicate range, wrong order, adjacent merge, invented split, and typed-record/span cardinality mismatch.
- [ ] **Step 2: Write failing positive tests** for declared paragraph/date/pipe boundaries, repeated lines with distinct IDs, connector words, grouped skills, typed overlap, and Unicode exact slicing.
- [ ] **Step 3: Run the span tests** and verify every case fails because assembly is absent.
- [ ] **Step 4: Implement bounded span validation and exact slicing** by reusing the current boundary guards; never infer a replacement span after a rejection.
- [ ] **Step 5: Run span and contract tests** and verify all source characters are covered exactly once where required.
- [ ] **Step 6: Record a verified checkpoint** and commit it independently only if the owner has separately authorized commits for the implementation phase.

### Task 4: Route persistence and consumer parity

**Files:**
- Modify: `app/api/resumes/parse/route.ts` only if the assembled type requires a narrow call-site change.
- Modify: `tests/resume-parse-route.test.ts`
- Modify: `tests/gemini-resume-diagnostic.test.ts`

**Interfaces:**
- Consumes: assembled canonical resume from Task 3.
- Produces: unchanged persisted canonical fields for application-plan, job-match, and tailoring consumers.

- [ ] **Step 1: Write one failing full synthetic DOCX test** covering extraction, stubbed provider spans, assembly, persistence stubs, and all three consumers in one path.
- [ ] **Step 2: Add failure cases** proving omitted spans, invented IDs, reversed order, and merged adjacent records produce no resume, analysis, audit, or cache write.
- [ ] **Step 3: Run route and diagnostic tests** and verify the old provider response cannot satisfy the new path.
- [ ] **Step 4: Make the minimum route/diagnostic adaptations**; do not alter consumer contracts unless a parity test proves it necessary.
- [ ] **Step 5: Run focused tests** and verify every source line and canonical fact remains reachable.
- [ ] **Step 6: Record a verified checkpoint** and commit it separately only if the owner has separately authorized commits for the implementation phase.

### Task 5: Bounds, legacy reads, and full verification

**Files:**
- Modify: `lib/ai/resume.ts`
- Modify: `lib/ai/gemini-resume-diagnostic.ts`
- Modify: relevant estimator, legacy, and diagnostic tests.

**Interfaces:**
- Consumes: final new wire and assembled output shapes.
- Produces: measured admission, response, token, and cost bounds; retained v3/v5 decoder behavior.

- [ ] **Step 1: Write failing estimator tests** from the exact full synthetic annotated request and maximum legal response shape.
- [ ] **Step 2: Write failing legacy/cache tests** proving v3/v5 reads remain valid and no prior cache revision can satisfy the new request.
- [ ] **Step 3: Recalculate and implement bounds** without raising global policy limits; pin diagnostic hashes only after the final request is stable.
- [ ] **Step 4: Run focused tests, `npm test`, `npm run test:browser`, `npm run typecheck`, and `npm run lint`** serially.
- [ ] **Step 5: Obtain independent review** focused on source coverage, span authority, privacy, cache isolation, and unchanged consumers.
- [ ] **Step 6: Stop for owner approval** before any provider call, merge, or deployment.
