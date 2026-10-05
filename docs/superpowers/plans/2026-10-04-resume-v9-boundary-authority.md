# Resume V9 Boundary Authority Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Correct deterministic resume record segmentation and make server-owned V9 record IDs the sole post-preflight boundary authority across the complete source-to-consumer flow.

**Architecture:** Add a versioned V9 source catalog and provider contract while freezing V8 decoding and its pinned diagnostic. V9 shares one section-aware structural-header classifier, assembles exact source records on the server, validates semantic projections only within those records, and exposes bounded failure metadata without retaining provider text.

**Tech Stack:** TypeScript, Node test runner, Zod, Next.js, Prisma route stubs, React Testing Library, DOCX fixtures.

**Spec:** `docs/RESUME_V9_BOUNDARY_AUTHORITY.md`

## Global Constraints

- No private resume content in Git, logs, test output, review packages, or fixtures.
- No provider request, real resume retry, production write, database migration, model/key/default change, merge, deployment, or application submission.
- Never use raw Prisma reset, migrate-dev, db-push, seed, or remote database mutation.
- Contract/prompt/cache/wire versions are exactly `9` / `11` / `12` / `6`.
- V8 and earlier stored outputs remain readable without destructive rewriting.
- Preserve exact source, finite ID, order, coverage, invention, and cross-record safeguards.

## Review Focus

- A final-line education pipe header after a complete narrative must split without a blank line.
- A legitimate certification with issued and expiry dates must not be treated as two records.
- Removing post-binding boundary guesses must not permit cross-record or invented typed values.
- V8 cache replay and pinned V8 diagnostics must retain historical behavior after V9 becomes current.
- Safe failure UI must not echo provider/source content or imply an uncharged failure.

---

### Task 1: Private-free complete structural twin and catalog regression

**Files:**
- Create: `tests/fixtures/resume-v9-structural-twin-data.ts`
- Create: `tests/fixtures/build-synthetic-resume-v9-structural-twin.ts`
- Create: `tests/fixtures/synthetic-resume-v9-structural-twin.docx`
- Modify: `tests/resume-source-catalog.test.ts`
- Modify: `tests/resume-contract-v8-provider.test.ts`

**Interfaces:**
- Produces `resumeV9StructuralTwinText`, canonical V5 semantics, and the exact DOCX extraction fixture.
- Produces a failing V9 catalog expectation of five work, two project, and two education records while V8 still yields its historical education boundary.

- [x] Write fixture extraction and catalog tests before V9 production code.
- [x] Run the focused tests and observe the education record-count failure.
- [x] Add the synthetic fixture builder/data only; preserve the failing production expectation.
- [x] Verify fixture extraction, private-marker absence, and the expected RED failure.

### Task 2: Versioned V9 source catalog and boundary authority

**Files:**
- Modify: `lib/ai/resume-source-catalog.ts`
- Modify: `lib/ai/resume.ts`
- Modify: `tests/resume-source-catalog.test.ts`
- Modify: `tests/resume-contract-v8-provider.test.ts`
- Create: `tests/resume-contract-v9-provider.test.ts`

**Interfaces:**
- Produces `buildResumeSourceCatalogV8`, `buildResumeSourceCatalogV9`, and V9 provider input helpers.
- Produces V9 validation mode in which server records are authoritative and typed projections remain record-local.

- [x] Add failing tests for education/certification pipe boundaries, final-line starts, multi-date legitimate records, connector omission, overlap, and every adversarial ID/source case.
- [x] Run them and confirm failures are caused by missing V9 behavior.
- [x] Implement the shared section-aware classifier and V9-only validation authority.
- [x] Run catalog/V8/V9 suites and refactor only while green.

### Task 3: V9 provider contract, versions, cache isolation, and legacy decoder

**Files:**
- Modify: `prompts/resumeParsePrompt.ts`
- Modify: `lib/ai/resume.ts`
- Modify: `lib/ai/gemini-resume-v8-diagnostic.ts`
- Modify: `tests/fixtures/resume-v8-provider-data.ts`
- Create: `tests/fixtures/resume-v9-provider-data.ts`
- Modify: `tests/resume-parse-provider.test.ts`
- Modify: `tests/gemini-resume-v8-diagnostic.test.ts`
- Modify: `tests/resume-contract-v9-provider.test.ts`

**Interfaces:**
- Produces contract/prompt/cache/wire `9/11/12/6` as the current parser.
- Keeps explicit historical V8 constants and decoder/catalog behavior for pinned evidence and stored data.

- [x] Add failing version, schema, cache-isolation, and V8/V7/V6/V5/V3 decoder tests.
- [x] Run and observe current V8 version failures.
- [x] Implement V9 schemas/request preparation/assembly and version-specific legacy restoration.
- [x] Run provider, contract, estimator, and pinned V8 diagnostic suites.

### Task 4: Full route, consumers, and safe failure presentation

**Files:**
- Modify: `app/api/resumes/parse/route.ts` only if response projection requires it.
- Modify: `components/resume-upload-form.tsx`
- Modify: `tests/resume-parse-route.test.ts`
- Modify: `tests/resume-upload-form.test.ts`
- Modify: `tests/gemini-resume-v8-diagnostic.test.ts` or create a V9 offline acceptance test.

**Interfaces:**
- Consumes the V9 fixture and provider helper.
- Proves extraction, validation, transaction stubs, decoder, job match, tailoring, application plan, absent sections, omissions, and safe UI fields.

- [x] Add failing end-to-end and UI tests, including no-write failures and no raw provider/source retention.
- [x] Run and observe V8/current-UI failures.
- [x] Switch production parsing to V9 and project bounded section/stage/billing/cost diagnostics in the UI.
- [x] Run route, consumer, UI, and privacy-focused suites.

### Task 5: Verification, independent review, and draft PR

**Files:**
- Create: `docs/RESUME_V9_ACCEPTANCE_REPORT.md`
- Modify: only files required by Critical/Important review findings, each through a new RED/GREEN test.

- [x] Run the full unit suite, typecheck, lint, browser suite, and production-build attempts.
- [x] Resolve every Critical/Important independent-review finding and record the final verdict.
- [x] Publish the passed/failed/untested acceptance matrix without suppressing the build blocker.

**Interfaces:**
- Produces the consolidated passed/failed/untested matrix and reviewed draft-PR candidate.

- [x] Run focused acceptance suites and generate the matrix from observed results.
- [x] Run `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`, and `npm run test:browser` with exact counts.
- [x] Confirm no persistent schema change; otherwise stop for migration approval before any PostgreSQL action.
- [x] Request one independent whole-branch adversarial review and resolve all Critical/Important findings with TDD.
- [ ] Re-run affected and full verification, commit approved bytes, push the isolated branch, and open a draft PR without merge or deployment.
