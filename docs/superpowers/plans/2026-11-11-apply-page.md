# Apply Page Implementation Plan (D036 Part B)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the job page's tailoring section, the Apply Kit's panels and the application page's run panels with one Apply page per job that walks a ten-step route. Lines save in the browser as they're typed, Update my score only saves and re-scores, documents attach themselves, and Prepare is one in-page step.

**Architecture:**
- Pure derivations in `lib/apply-page/*` decide the current step, the ready list and auto-attach. Each is unit-tested.
- Thin client components in `components/apply-page/*` call the existing APIs only: evidence snapshots, match, tailored résumé, cover letter, applications, application runs, automation policy and prepare.
- One step dictionary (`lib/assisted-apply/control-steps.ts`) serves the Apply page, the application page and the control page.
- Every confirmation moves from `window.confirm` to an injectable `confirm` backed by an in-page component.

**Tech Stack:** Next.js 16 App Router, React, TypeScript, node:test with JSDOM (`tests/fixtures/dom-harness.ts`), Playwright smoke tests (`npm run test:browser`).

**Spec:** `docs/superpowers/specs/2026-11-11-get-ready-redesign-design.md` (§4, §5, §6, §7). Decision D036.

## Global Constraints

- **Step names**, in order: `Your match`, `Your experience`, `Your documents`, `Prepare`, `Open the Apply Pilot browser`, `Open and read the form`, `Check the answers`, `Fill`, `Finish and submit`, `Record it`.
- **Step heading format:** `Step N of 10 · <name>`.
- **Exact copy:**
  - `Apply →`, `Continue: step N`, `Apply on my own`
  - `If you have this, say what you did in one sentence.`, `It's on my résumé`, `Saved on this computer`
  - `Everything I wrote above is true.`, `Update my score · about N¢`, `Nothing to add · update my score`
  - `Write my résumé and cover letter · up to N¢`, `Write my résumé · up to N¢`
  - `Used for this application`, `Use this version`, `Older versions (n)`
  - `Assisted Fill needs an A. You can still apply on your own with these documents.`
  - `Allow and prepare`, `Turn off`, `Turn on Fill for this form`
- **Owner lines:** `OWNER_FACT_MAX_CHARACTERS = 200` and one sentence. This applies to new or changed lines only; kept lines are untouched.
- **Drafts:**
  - Kept in `localStorage` under key `apply-pilot:experience:<userKey>:<jobId>`, where `userKey` is the first 16 hex characters of `sha256(userId)`, computed on the server.
  - Every storage call is wrapped in `try`/`catch`.
  - Drafts are deleted after a successful Update and at sign-out.
- **Confirmations:**
  - No `window.confirm` in the tailoring, document, Prepare or Fill-switch flows.
  - `x-ai-cost-confirmed` is sent only after the in-page Confirm. Cancel sends nothing.
- **Cost-question mode:** `aiCostQuestionsMode()` in `lib/ai/cost-questions.ts` is the only reader. It returns `"ASK"`; `OFF` is not built.
- **Server rules:**
  - No Prisma schema change in B1–B5.
  - Prepare, Fill and completion rules are unchanged, except that a run completing or being cancelled turns Assisted Fill off (D035 D-B).
- **Wording:** "ATS score" never appears.
- **Public repo:** tests use synthetic people and jobs only.
- **Every PR runs** `npm test`, `npm run lint`, `npm run typecheck` and `npm run test:browser`.
  - Browser baseline: everything passes except `the local screen binds exact consent and pauses four mocked calls for post-response review`.
  - In a worktree, build with `npx next build --webpack`.
- **PRs:** agents open draft PRs (D030), and the owner merges.

## Review Focus

1. **Two tabs.** A review saved in another tab makes this tab's save stale. Expected: the server refuses, drafts are kept, and the page says "This job's review changed in another tab. Reload to continue; your lines are kept on this computer." Test in Task 9.
2. **Requirements change after a re-score.** A draft whose requirement disappeared is dropped, with "1 line no longer matches this job's requirements and was removed." Test in Task 9.
3. **Storage unavailable** (private mode, a throwing `localStorage`). The page still works, shows "Not kept between visits on this browser", and Update still succeeds. Tests in Tasks 8 and 9.
4. **Sentence false positives.** `U.S.`, `e.g.`, `v2.1` and `Inc.` inside a line still count as one sentence. Test in Task 6.
5. **Double clicks or a slow network** on Update my score or Allow and prepare. Exactly one save, one match, one run creation and one prepare. Tests in Tasks 9 and 13.

---

## PR B1: the Apply page shell

### Task 1: Ten-step dictionary, control page renumbered

**Files:**
- Modify: `lib/assisted-apply/control-steps.ts`:
  - L17–33: the names, the step numbers, and `CONTROL_STEP_NUMBERS = [6,7,8,9,10]`.
  - L162–166: `stepHeading`.
  - L313, L363, L369–370, L444–448, L465–642: shift the step numbers in copy as mapped below.
  - L655: `step <= 3` becomes `step <= 5`.
- Modify: `components/application-browser-steps.tsx`:
  - L102: `aria-label="All ten steps"`.
  - L417: "listed in step 7" becomes "listed in step 9".
- Test: `tests/application-browser-control-steps.test.ts` (L439: 10 `li`), `tests/application-browser-control-presentation.test.ts` (L1897), `tests/browser/user-fill-activation.smoke.test.ts` (L349: `Step 7 of 10 · Check the answers`).

Mapping from old to new step numbers:
- 1 and 2 → 4
- 3 → 5
- 4 → 6
- 5 → 7
- 6 → 8
- 7 → 9
- 8 → 10

The copy at L313 becomes "Finish step 4 on the Apply page."

**Interfaces:**
- Produces: the existing export names, with ten entries: `ASSISTED_APPLY_STEP_NAMES: Record<AssistedApplyStepNumber, string>`, `ASSISTED_APPLY_STEP_NUMBERS`, `CONTROL_STEP_NUMBERS`, `type AssistedApplyStepNumber = 1|2|3|4|5|6|7|8|9|10`, `type ControlStepNumber = 6|7|8|9|10` and `stepHeading(step: AssistedApplyStepNumber): string`.

- [ ] **Step 1:** Update the three tests to the new names, ten list items and `Step 7 of 10 · Check the answers`.
- [ ] **Step 2:** Run `node --import tsx --test tests/application-browser-control-steps.test.ts tests/application-browser-control-presentation.test.ts`. Expected: FAIL on step counts and names.
- [ ] **Step 3:** Implement the dictionary and the copy shifts.
- [ ] **Step 4:** Re-run both files, then `npm run test:browser`. Expected: PASS, apart from the browser baseline.
- [ ] **Step 5:** Commit `Renumber the assisted-apply steps to ten`.

### Task 2: Shared job-detail loader

**Files:**
- Create: `lib/jobs/job-detail.ts`
- Modify: `app/(product)/jobs/[id]/page.tsx` (move `getJobDetail`, L35–198, out unchanged)
- Test: existing `tests/job-page-view.test.ts`, plus a new `tests/job-detail-loader.test.ts`

**Interfaces:**
- Produces: `loadJobDetail(userId: string, jobId: string): Promise<JobDetail | null>`, where `JobDetail` is today's return type plus:
  - `draftUserKey: string`: the first 16 hex characters of `sha256(userId)`
  - `currentConfidenceScore: number | null`: from the current JOB_MATCH analysis output's `confidenceScore`, and null unless that analysis is current. Today's `EstimateView` carries no confidence.

- [ ] **Step 1:** Write `draft user key is 16 hex chars and never the raw id` (assert `/^[0-9a-f]{16}$/` and `!== userId`) and `confidence is null without a current match`.
- [ ] **Step 2:** Run it. Expected: FAIL (module not found).
- [ ] **Step 3:** Move the loader, add `draftUserKey`, and import it in the job page.
- [ ] **Step 4:** Run `node --import tsx --test tests/job-detail-loader.test.ts tests/job-page-view.test.ts`. Expected: PASS.
- [ ] **Step 5:** Commit `Share the job-detail loader`.

### Task 3: Grade letters and apply progress

**Files:**
- Create: `lib/jobs/grade.ts`. Shared with the job-grades plan; whichever lands first creates it, with identical content.
- Create: `lib/apply-page/apply-progress.ts`
- Test: `tests/job-grade-letter.test.ts`, `tests/apply-progress.test.ts`

**Interfaces:**
- Produces:
  - `type GradeLetter = "A"|"B"|"C"|"D"`
  - `gradeLetter(score: number | null | undefined): GradeLetter | null`: A from 85, B from 70, C from 55, D below. Anything other than an integer from 0 to 100 gives `null`.
  - `GRADE_EXPLANATION = "Apply Pilot's grade of how well your résumé fits this job. Not the employer's."`
- Produces:
  - `type ApplyProgressInput = { hasMasterResume: boolean; hasCurrentMatch: boolean; reviewSaved: boolean; resumeAttached: boolean; coverAttached: boolean; coverRequired: boolean; automationAvailable: boolean; run: { state: string; companionState: string | null } | null; applied: boolean }`
  - `type ApplyProgress = { current: AssistedApplyStepNumber; steps: Array<{ number: AssistedApplyStepNumber; name: string; state: "done"|"now"|"later" }>; now: string; next: string | null }`
  - `deriveApplyProgress(input: ApplyProgressInput): ApplyProgress`
- Rules:
  - The current step is 1 without a current match, then 2 without a saved review, then 3 until the documents are attached, then 4 until the run is `READY`.
  - From `READY` the current step is 5. Task 15 refines steps 6 to 10.
  - `applied` marks every step done.
  - `now` is the spec §4 table's "The one thing you do" for the current step. `next` is the next step's name, or `null` after step 10.

- [ ] **Step 1:** Write the tests:
  - grade boundaries: 84 → B, 85 → A, 69 → C, 70 → B, 54 → D, 55 → C, 0 → D, 100 → A, 101 → null, 85.5 → null, null → null
  - progress: `unscored job is step 1`, `saved review without documents is step 3`, `ready run is step 5`, `applied marks all ten done`
- [ ] **Step 2:** Run both files. Expected: FAIL (modules missing).
- [ ] **Step 3:** Implement both modules.
- [ ] **Step 4:** Run both files. Expected: PASS.
- [ ] **Step 5:** Commit `Add grade letters and apply progress`.

### Task 4: The Apply page, the Now card and the job page's Apply button

**Files:**
- Create: `components/apply-page/now-card.tsx`, `components/apply-page/apply-page.tsx`
- Modify: `app/(product)/jobs/[id]/apply/page.tsx`. It loads `loadJobDetail`, `loadApplyKitView` and `isApplicationAutomationEnabled()`, then renders `ApplyPage`.
- Modify: `components/job-workspace/job-workspace.tsx`. Remove `<section id="tailor">` and `#documents` (L142–180), and add an Apply card linking to `/jobs/${id}/apply`.
- Test: `tests/apply-page-ui.test.ts` (new), `tests/job-workspace.test.ts`

**Interfaces:**
- Produces:
  - `NowCard({ progress: ApplyProgress; action?: React.ReactNode })`. It renders the heading via `stepHeading`, the `now` sentence, the action, `Next: <name>`, and an `<ol>` of the steps with a `data-state` attribute on each.
  - `ApplyPage(props: { detail: JobDetail; kit: ApplyKitView; automationAvailable: boolean; progress: ApplyProgress })`, with sections `#step-1`, `#step-2`, `#step-3` and `#step-4`.
    - In B1, step 1 is the existing `MatchCard`, and steps 2–3 are the existing `TailorFlow` plus `JobDocumentWorkspace`, moved here unchanged.
    - The existing `ApplyKit` sits under a `<details>` labelled `Apply on my own`.
- Behavior:
  - The job page's card label is `Apply →` when the progress is at step 1, otherwise `Continue: step N`.
  - The job page's `MatchCard` no longer shows a Score button: pass `showScoreButton={false}`, a new prop that defaults to `true`. Scoring happens at step 1.
  - Step 1 on the Apply page shows, after a match: `<letter> · fit <fit>, confidence <confidence>. Assisted Fill needs an A, with confidence of 85 or more.` The letter comes from `gradeLetter(fit)`, and the second sentence is dropped once both reach 85.

- [ ] **Step 1:** Write the tests:
  - `apply page shows Step 1 of 10 · Your match for an unscored job`
  - `job page links Apply → to /jobs/:id/apply and has no Create my résumé button`
  - update the job-workspace test cases that expected the tailor section
- [ ] **Step 2:** Run `node --import tsx --test tests/apply-page-ui.test.ts tests/job-workspace.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement the components and both pages.
- [ ] **Step 4:** Run the two files, then the full gate (`npm test`, lint, typecheck, `npm run test:browser`). Expected: PASS, apart from the browser baseline.
- [ ] **Step 5:** Commit `Add the Apply page and move tailoring onto it`. Push the branch and open draft PR "B1: Apply page shell (D036)".

---

## PR B2: Your experience

### Task 5: Bring over PR #66's server side

**Files:**
- Apply from PR #66 (`refs/pull/66/head` = `1b36750`, base `4284bf2`) only these paths:
  - `lib/job-sources/requirement-lines.ts`, `lib/job-sources/manual.ts`
  - `lib/jobs/evidence-correction-review.ts`, `lib/jobs/evidence-snapshots.ts`, `lib/jobs/tailor-decisions.ts`
  - `tests/evidence-snapshot-unchecked-save.test.ts`, `tests/manual-job-import-evidence.test.ts`, `tests/tailor-unchecked-requirements.test.ts`, `tests/postgres/evidence-snapshot-service.test.ts`
- Leave out #66's `tailor-flow.tsx`, `app/(product)/jobs/[id]/page.tsx`, `product.css` and its `job-tailor-flow` test additions.

**Interfaces:**
- Produces:
  - `EvidenceCorrectionReview.uncheckedRequirements: EvidenceReviewGap[]`, with ids `requirement:<index>`
  - `extractRequirementLines(text: string, maxLength = 220): string[]`
  - `buildEvidenceSaveBody`, which accepts drafts keyed by those ids

- [ ] **Step 1:** `git fetch origin pull/66/head`, then `git diff 4284bf2 1b36750 -- <the paths above> | git apply --3way`. Resolve any conflicts in favour of main's current code plus #66's additions.
- [ ] **Step 2:** Run `node --import tsx --test tests/evidence-snapshot-unchecked-save.test.ts tests/manual-job-import-evidence.test.ts tests/tailor-unchecked-requirements.test.ts`. Expected: PASS.
- [ ] **Step 3:** Run `npm run test:postgres`. This is the guarded runner, against a disposable local database only. Expected: PASS. If no local database is available, say so in the PR body.
- [ ] **Step 4:** Commit `Accept answers for requirements the match didn't check (from #66)`.

### Task 6: One sentence, at most 200 characters

**Files:**
- Modify: `lib/jobs/owner-fact-cleanup.ts`
- Modify: `lib/jobs/evidence-correction-review.ts`, at the new-attestation check near L343
- Modify: `lib/jobs/evidence-snapshots.ts`, at the REPLACE check near L98. Do not touch RETAIN at L90.
- Test: `tests/owner-fact-shape.test.ts` (new), `tests/evidence-snapshot-route.test.ts`

**Interfaces:**
- Produces:
  - `OWNER_FACT_MAX_CHARACTERS = 200`
  - `type OwnerFactShapeProblem = { kind: "too_long" | "more_than_one_sentence"; detail: string }`
  - `ownerFactShapeProblems(fact: string): OwnerFactShapeProblem[]`
  - `assertNewOwnerFactShape(fact: string): void`. It throws `PublicApiError` 422 with code `OWNER_FACT_TOO_LONG` and the message `Keep each line to one sentence of up to 200 characters.`
- Sentence counting:
  - Use `Intl.Segmenter("en", { granularity: "sentence" })`, and count the segments that contain a letter or digit.
  - Join a segment onto the next one when it ends in `e.g.`, `i.e.`, `etc.`, `vs.`, `U.S.`, `Inc.`, `Jr.`, `Sr.`, `Dr.` or `St.`, or in a single capital letter followed by a period.

- [ ] **Step 1:** Write the tests:
  - 200 characters → `[]`; 201 → `too_long`
  - `Led demos for IT buyers. Ran trials.` → `more_than_one_sentence`
  - `Supported U.S. customers on SAML, e.g. Okta.` → `[]`
  - `Shipped v2.1 of the API at Example Inc. in 2023.` → `[]`
  - route: a new 201-character attestation → 422 `OWNER_FACT_TOO_LONG`; a RETAINED existing 300-character fact is still accepted
- [ ] **Step 2:** Run `node --import tsx --test tests/owner-fact-shape.test.ts tests/evidence-snapshot-route.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement and wire the two call sites.
- [ ] **Step 4:** Run the same command. Expected: PASS.
- [ ] **Step 5:** Commit `Limit new lines to one sentence of 200 characters`.

### Task 7: In-page confirmation

**Files:**
- Modify: `lib/ai/browser-request.ts`. `fetchWithApprovedAiCost` (L34) awaits `deps.confirm`. `fetchWithAiCostConfirmation(input, init?, deps?)` (L63) takes the same `deps` and defaults to `window.confirm`.
- Create: `lib/ai/cost-questions.ts`, `components/ui/in-page-confirm.tsx`
- Modify: `components/job-workspace/score-job-button.tsx`. Add optional props `confirm?: ConfirmFn` (passed through to `fetchWithAiCostConfirmation`) and `maximumMicros?: number`. With the latter, the label becomes `Check my match · about N¢`. Apply page step 1 renders it with the in-page `confirmFn`.
- Test: `tests/ai-browser-request.test.ts`, `tests/in-page-confirm.test.ts` (new), `tests/score-job-button.test.ts` (new: `step 1 asks in the page, not with window.confirm`)

**Interfaces:**
- Produces:
  - `type ConfirmFn = (message: string) => boolean | Promise<boolean>`
  - `fetchWithAiCostConfirmation(input: RequestInfo | URL, init?: RequestInit, deps?: { fetchImpl?: typeof fetch; confirm?: ConfirmFn }): Promise<Response>`
- Produces:
  - `type AiCostQuestionsMode = "ASK"`
  - `aiCostQuestionsMode(): AiCostQuestionsMode`. It returns `"ASK"`, with a comment that `OFF` waits for sign-up consent (spec §6).
- Produces:
  - `type InPageConfirmRequest = { title: string; body: string; confirmLabel?: string }`
  - `useInPageConfirm(): { confirm: (request: InPageConfirmRequest) => Promise<boolean>; confirmFn: ConfirmFn; dialog: React.ReactNode }`
  - `dialog` renders `role="group"` with Confirm (default label `Confirm`) and Cancel. Confirm takes focus, and Escape cancels.

- [ ] **Step 1:** Write the tests:
  - an async confirm that resolves false → exactly one request
  - one that resolves true → the second request carries `x-ai-cost-confirmed: true`
  - the dialog resolves true on Confirm, false on Cancel and false on Escape
  - Confirm has focus when the dialog opens
- [ ] **Step 2:** Run both files. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run both files. Expected: PASS.
- [ ] **Step 5:** Commit `Ask cost questions in the page`.

### Task 8: Drafts in this browser, cleared at sign-out

**Files:**
- Create: `lib/jobs/experience-drafts.ts`, `components/sign-out-button.tsx`
- Modify: `components/auth-menu.tsx`, L30–35. Use `SignOutButton` with the existing server action.
- Test: `tests/experience-drafts.test.ts`, `tests/sign-out-button.test.ts`

**Interfaces:**
- Produces:
  - `type ExperienceDraft = { line: string; resumeLine: string }`
  - `type ExperienceDrafts = Record<string, ExperienceDraft>`, keyed by requirement text
  - `experienceDraftKey(userKey: string, jobId: string): string`
  - `readExperienceDrafts(key: string, storage?: Storage | null): { drafts: ExperienceDrafts; available: boolean }`
  - `writeExperienceDrafts(key: string, drafts: ExperienceDrafts, storage?: Storage | null): boolean`
  - `clearExperienceDrafts(key: string, storage?: Storage | null): void`
  - `clearAllExperienceDrafts(storage?: Storage | null): void`. It removes only keys with the prefix `apply-pilot:experience:`.
- Stored value: `{"v":1,"drafts":{…}}`. Any other `v` reads as empty.
- Produces: `SignOutButton({ action }: { action: () => Promise<void> })`, a client form whose `onSubmit` calls `clearAllExperienceDrafts()` before the action runs.

- [ ] **Step 1:** Write the tests:
  - round trip
  - a storage whose getter throws → `{ drafts: {}, available: false }`, without throwing
  - `clearAll` leaves other keys alone
  - an unknown version reads as empty
  - submitting the sign-out form clears the drafts
- [ ] **Step 2:** Run both files. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run both files. Expected: PASS.
- [ ] **Step 5:** Commit `Keep experience drafts in this browser`.

### Task 9: The Your experience step

**Files:**
- Create: `components/apply-page/experience-step.tsx`
- Modify: `components/apply-page/apply-page.tsx`. Step 2 renders `ExperienceStep` in place of the gap part of `TailorFlow`.
- Test: `tests/experience-step-ui.test.ts` (dom-harness)

**Interfaces:**
- Consumes:
  - `ownerFactProblems` and `ownerFactShapeProblems` (Task 6)
  - `useInPageConfirm` (Task 7)
  - the draft helpers (Task 8)
  - `buildEvidenceSaveBody`, `resumeLines` and `SavedLineDraft` (`lib/jobs/tailor-decisions.ts`)
  - `formatUsdCentsCeiling` (`lib/jobs/document-creation-plan.ts`)
- Produces: `ExperienceStep(props: { jobId: string; review: EvidenceCorrectionReview; hasValidCurrentSnapshot: boolean; hasCurrentMatch: boolean; quote: DocumentCreationQuote | null; draftKey: string; generationAvailable: boolean })`.

Behavior:
- **The list:** `review.gaps` followed by `review.uncheckedRequirements`, de-duplicated by requirement text.
- **Each requirement:**
  - A textarea with the placeholder from the Global Constraints.
  - A counter `N/200`.
  - Problems shown under the textarea with `data-problem`.
  - `Saved on this computer`, or `Not kept between visits on this browser` when storage is unavailable.
  - `It's on my résumé` switches to a `<select>` of `resumeLines(review)`; `Write my own line instead` switches back.
- **Saved lines:** `review.acceptedFacts` appear under `Lines you've added before`, with Keep, Remove and Change. They use `SavedLineDraft` and are counted as a change when not Keep.
- **Mapping drafts to the save body:**
  - a non-empty line → `{choice:"add", line, attested: tick, resumeLine:""}`
  - a chosen résumé line → `{choice:"onResume", line:"", attested:false, resumeLine}`
  - blank → `{choice:"skip"}`
- **The button:**
  - With any change it reads `Update my score · about ${formatUsdCentsCeiling(quote.jobMatchMicros)}`.
  - With no change, while the match isn't tied to a saved review, it reads `Nothing to add · update my score`.
  - With no change, when the match is tied to a saved review, it's replaced by `Done`.
- **Blocked reasons:**
  - `Fix the line for "<requirement>" first.`
  - `Tick "Everything I wrote above is true." first.`
- **Sequence:**
  1. POST `/api/jobs/${jobId}/evidence-snapshots`. Keep the `requestId` across retries.
  2. `fetchWithApprovedAiCost(\`/api/jobs/${jobId}/match\`, { method: "POST" }, quote.jobMatchMicros, { confirm: confirmFn })`
  3. `clearExperienceDrafts(draftKey)`, then `router.refresh()`
- **Single flight:** the button is disabled while running.
- **Errors:**
  - 422 shows the server message under the step.
  - A stale review (409, or a response with `snapshot.isCurrent === false`) shows Review Focus 1's text and keeps the drafts.

- [ ] **Step 1:** Write the tests:
  - `a placeholder is flagged under its box before any request` (no fetch calls)
  - `a 201-character line shows the limit and blocks Update`
  - `Update my score sends exactly save then match` (the second request carries the header, after the in-page Confirm)
  - `Cancel sends no match request`
  - `drafts survive a remount and are cleared after success`
  - `a throwing storage still lets you update`
  - `a double click sends one save and one match`
  - `a stale review keeps drafts and asks to reload`
  - `a draft whose requirement disappeared is dropped with a notice`
  - `window.confirm is never called` (the harness `confirm` records nothing)
- [ ] **Step 2:** Run `node --import tsx --test tests/experience-step-ui.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement and wire it into `ApplyPage`.
- [ ] **Step 4:** Run the file, then the full gate. Expected: PASS, apart from the browser baseline.
- [ ] **Step 5:** Commit `Add the Your experience step`. Push and open draft PR "B2: Your experience (D036)". Note in the body that it supersedes #66.

---

## PR B3: Your documents

### Task 10: Make sure an application exists, and attach without applying

**Files:**
- Create: `lib/applications/client.ts`
- Test: `tests/application-client.test.ts` (new), `tests/application-update-route.test.ts` (new, for `app/api/applications/[id]/route.ts` PATCH)

**Interfaces:**
- Produces: `ensureApplication(jobId: string, fetchImpl?: typeof fetch): Promise<{ id: string }>`. It sends POST `/api/applications` with `{ jobPostingId, status: "SAVED" }`, the same body `save-job-button.tsx` sends.
- Produces: `attachDocuments(applicationId: string, docs: { resumeVersionId?: string; coverLetterVersionId?: string }, fetchImpl?: typeof fetch): Promise<void>`. It sends PATCH `/api/applications/${applicationId}` with no `status`.

- [ ] **Step 1:** Write the tests:
  - `ensureApplication posts SAVED`
  - `attachDocuments sends no status`
  - route: `PATCH with only resumeVersionId keeps status, dateApplied and followUpDueAt`
- [ ] **Step 2:** Run both files. Expected: FAIL (the module is missing; the route test should pass once it's written).
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run both files. Expected: PASS.
- [ ] **Step 5:** Commit `Attach documents without changing status`.

### Task 11: The Your documents step

**Files:**
- Create: `lib/apply-page/auto-attach.ts`, `components/apply-page/documents-step.tsx`
- Modify: `components/apply-page/apply-page.tsx`. Step 3 renders `DocumentsStep` (with `JobDocumentWorkspace` for review and editing).
- Delete: `components/job-workspace/tailor-flow.tsx`, `tests/job-tailor-flow.test.ts`. First move any case still relevant to `ExperienceStep` or `DocumentsStep`. Then grep for `TailorFlow` and `documentsCreatedKey`; nothing should still import them.
- Test: `tests/auto-attach.test.ts`, `tests/documents-step-ui.test.ts`

**Interfaces:**
- Produces: `chooseAutoAttach(docs: ApplyKitDocument[], attachedId: string | null): string | null`. It returns the newest document whose status is `AI_GROUNDED`, `EDITED_CONFIRMED` or `LEGACY_CONFIRMED` when nothing is attached or the attached document isn't one of those statuses. Otherwise it returns `null`.
- Produces: `DocumentsStep(props: { jobId: string; applicationId: string | null; quote: DocumentCreationQuote | null; generationAvailable: boolean; coverByDefault: boolean; resumes: ApplyKitDocument[]; coverLetters: ApplyKitDocument[]; attached: { resumeId: string | null; coverId: string | null }; letter: GradeLetter | null })`.

Behavior:
- **The button:** `Write my résumé and cover letter · up to N¢`, where N is `documentCreationMaximumMicros(["resume","cover"], quote)`. With the cover letter unticked it reads `Write my résumé · up to N¢`.
- **The in-page question:** `Sends your résumé facts and the lines you added to Google Gemini. Most it can cost: N¢.`
- **The requests:** POST `tailored-resume`, then `cover-letter`, through `fetchWithApprovedAiCost`. No save and no match.
- **Attaching:** after generation, after a review is confirmed, and once on mount, it calls `ensureApplication` (when `applicationId` is null), then `attachDocuments` with `chooseAutoAttach`'s pick.
- **Labels:**
  - `Used for this application` on the attached document
  - `Use this version` on other ready versions
  - older versions inside `<details><summary>Older versions (n)</summary>`
- **Below an A:** when `letter !== "A"`, the step shows the Global Constraints sentence.

- [ ] **Step 1:** Write the tests:
  - auto-attach picks the newest ready document, keeps a ready attached one, and replaces a stale attached one
  - UI: `Write documents sends no save or match request`
  - UI: `the new résumé is attached with a PATCH that has no status`
  - UI: `Cancel sends nothing`
  - UI: `below an A the step says Fill needs an A`
- [ ] **Step 2:** Run both files. Expected: FAIL.
- [ ] **Step 3:** Implement, then delete `TailorFlow`.
- [ ] **Step 4:** Run the full gate. Expected: PASS, apart from the browser baseline.
- [ ] **Step 5:** Commit `Add the Your documents step`. Push and open draft PR "B3: Your documents (D036)".

---

## PR B4: Prepare and the Apply Pilot browser

### Task 12: Ready list and blocker copy

**Files:**
- Create: `lib/application-runs/blocker-copy.ts`. Move `blockingMessages` (`components/application-run-pretrial-setup.tsx:39–52`) here, keeping the texts.
- Create: `lib/apply-page/ready-list.ts`
- Modify: `components/application-run-pretrial-setup.tsx` to import the moved copy.
- Test: `tests/ready-list.test.ts`, `tests/application-run-pretrial-setup.test.ts` (L302: the full key list, now including `automation_disabled_during_preparation`)

**Interfaces:**
- Produces:
  - `type ReadyFix = { label: string; target: "step-1" | "step-2" | "step-3" | "turn-off-fill" | "settings-ai" | "retry" }`
  - `PREPARE_BLOCKER_COPY: Record<PreparationBlockingReason, { text: string; fix: ReadyFix | null }>`
- Produces:
  - `type ReadyLine = { key: PreparationBlockingReason | "fill_on" | "application_details"; ok: boolean; text: string; fix: ReadyFix | null; blocking: boolean }`
  - `buildReadyList(input: { fitScore: number | null; confidenceScore: number | null; hasCurrentMatch: boolean; resumeAttached: boolean; coverAttached: boolean; coverRequired: boolean; fillMode: "PREPARE_ONLY" | "FILL_AND_REVIEW"; hostBlocked: boolean; details: { confirmed: number; total: number; missing: string[] } }): ReadyLine[]`
- Rules:
  - `fill_on` is blocking, because `service.ts:410` refuses Enable unless the mode is `PREPARE_ONLY`. Its fix target is `turn-off-fill`.
  - `application_details` is never blocking.

- [ ] **Step 1:** Write the tests:
  - every `PreparationBlockingReason` has copy (set equality with the union, 12 keys)
  - fit 84 → a blocking line with target `step-1`
  - Fill on → a blocking `fill_on` line
  - missing details → a non-blocking line that names each one
- [ ] **Step 2:** Run both files. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run both files. Expected: PASS.
- [ ] **Step 5:** Commit `Add the Prepare ready list`.

### Task 13: Allow and prepare

**Files:**
- Create: `lib/application-runs/client-run.ts`. Move the create-run idempotency logic out of `components/application-run-entry.tsx`.
- Create: `components/apply-page/prepare-step.tsx`
- Modify: `components/application-run-entry.tsx` and `components/application-run-pretrial-setup.tsx`. Both use the lib helpers, and the `window.confirm` calls at L183 and L275 move to `useInPageConfirm`.
- Test: `tests/prepare-step-ui.test.ts`, `tests/application-run-entry.test.ts`, `tests/application-run-pretrial-setup.test.ts`

**Interfaces:**
- Produces:
  - `ensureApplicationRun(applicationId: string, deps?: { fetchImpl?: typeof fetch; storage?: Storage | null }): Promise<{ id: string; state: string }>`. It POSTs `/api/application-runs` with `{applicationId, idempotencyKey}`, keeping the key in `sessionStorage` under `application-run-create:<applicationId>` and clearing it on success.
  - `allowHostForRun(runId: string, fetchImpl?): Promise<void>`. It sends PATCH `/api/application-automation-policy` with `{ enablePretrialForRunId: runId }` and nothing else.
  - `prepareRun(runId: string, confirm: ConfirmFn, fetchImpl?): Promise<Response>`. It POSTs `/api/application-runs/${runId}/prepare` with body `{}` through `fetchWithAiCostConfirmation(..., { confirm })`.
- Produces: `PrepareStep(props: { jobId: string; applicationId: string | null; applyHost: string; readyList: ReadyLine[]; fillMode: "PREPARE_ONLY" | "FILL_AND_REVIEW"; run: { id: string; state: string } | null })`.

Behavior:
- **The button:** `Allow and prepare` is enabled only when no blocking line fails.
- **The in-page question:** `Prepare plans this application with Google Gemini (usually under 1¢) and lets Apply Pilot work on <host>.`
- **The sequence:** `ensureApplication` → `ensureApplicationRun` → `allowHostForRun` → `prepareRun`, single flight.
- **When the run is blocked:** the step shows `PREPARE_BLOCKER_COPY[reason]` with its fix.
- **When Fill is on:** the `fill_on` line's `Turn off` sends PATCH `{ mode: "PREPARE_ONLY" }`, with no question.

- [ ] **Step 1:** Write the tests:
  - `one click creates one run, allows the host once and prepares once, in that order`
  - `a double click still sends each request once`
  - `Cancel sends nothing`
  - `fit_below_threshold shows its copy and Go to step 1`
  - `Turn off sends PREPARE_ONLY`
  - existing entry and pretrial tests: `no window.confirm`
- [ ] **Step 2:** Run the three files. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the three files. Expected: PASS.
- [ ] **Step 5:** Commit `Prepare in one step on the Apply page`.

### Task 14: The Fill switch at step 8, Fill off when a run ends, and the Settings card

**Files:**
- Modify: `lib/application-runs/service.ts`, in `cancelApplicationRun` (L682) and `completeApplicationRunByUser` (L751). Inside the same transaction: when `mode === "FILL_AND_REVIEW"`, set `PREPARE_ONLY` and write the audit `automation-policy.auto-off` with `{ runId, reason: "run_completed" | "run_cancelled" }`.
- Modify: `components/application-browser-steps.tsx`. When step 8 is current and the policy mode is `PREPARE_ONLY`, show `Turn on Fill for this form`: an in-page question, then PATCH `{ mode: "FILL_AND_REVIEW" }`. The mode comes from the policy read in `lib/application-browser/same-origin-client.ts` (L953–971).
- Create: `components/assisted-fill-settings-card.tsx`, rendered in `app/(product)/settings/application-answers/page.tsx`. It shows `Assisted Fill is on` or `Assisted Fill is off`, with `Turn off`, and when off: `Turn it on at step 8 of an application you've prepared.`
- Test: the existing service test file for completion and cancel (find it with `grep -l completeApplicationRunByUser tests`), `tests/application-browser-control-steps.test.ts`, `tests/assisted-fill-settings-card.test.ts`

- [ ] **Step 1:** Write the tests:
  - `completing a run turns Fill off and audits it`
  - `cancelling a run turns Fill off`
  - `an already-off policy is left alone, with no audit`
  - control step 8 shows `Turn on Fill for this form` when the mode is PREPARE_ONLY
  - the settings card's Turn off sends PREPARE_ONLY
- [ ] **Step 2:** Run the files. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the files, then `npm run test:browser`. Expected: PASS, apart from the browser baseline.
- [ ] **Step 5:** Commit `Turn Fill on where it's used and off when a run ends`.

### Task 15: Step 5 on the Apply page

**Files:**
- Create: `components/apply-page/browser-step.tsx`
- Modify: `components/apply-page/apply-page.tsx`
- Test: `tests/browser-step-ui.test.ts`

**Interfaces:**
- Consumes: the existing `CompanionSignInCode({ runId })` component.
- Produces: `BrowserStep(props: { appOrigin: string; runId: string })`. It shows a copyable start command, `npm run application-browser -- --app-origin <appOrigin> --run-id <runId>` (as in `docs/APPLICATION_BROWSER_COMPANION.md:31`), followed by `CompanionSignInCode`.

- [ ] **Step 1:** Write `the start command contains only the origin and the run id`. Assert the exact string, and that there's no `token`, `cookie` or `code` in it.
- [ ] **Step 2:** Run it. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the full gate. Expected: PASS, apart from the browser baseline.
- [ ] **Step 5:** Commit `Show step 5 on the Apply page`. Push and open draft PR "B4: Prepare and the Apply Pilot browser (D036)".

---

## PR B5: Progress and the application-page card

### Task 16: Progress for steps 6–10, read when you return

**Files:**
- Modify: `lib/apply-page/apply-progress.ts`. Map run and companion states to steps 6–10 using the D035 §5.2 words already in `lib/assisted-apply/plain-language.ts`.
- Create: `components/apply-page/use-run-progress.ts`
- Test: `tests/apply-progress.test.ts`, `tests/use-run-progress.test.ts`

**Interfaces:**
- Produces: `useRunProgress(runId: string | null, initial: ApplyProgressInput["run"]): ApplyProgressInput["run"]`. It GETs `/api/application-runs/${runId}` once on mount and again on each `visibilitychange` to `visible`. No timers.

- [ ] **Step 1:** Write the tests:
  - `HUMAN_ONLY is step 9`
  - `COMPLETED_BY_USER marks ten done`
  - `refetches only when the tab becomes visible`
  - `never calls setInterval or setTimeout` (spy on both)
- [ ] **Step 2:** Run both files. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run both files. Expected: PASS.
- [ ] **Step 5:** Commit `Show steps 6–10 progress on the Apply page`.

### Task 17: Application-page summary card

**Files:**
- Create: `components/application-run-summary-card.tsx`
- Modify: `app/(product)/applications/[id]/page.tsx`. Replace the Browser run, Companion sign-in and Pretrial setup panels (L164–213) with the card.
- Test: `tests/application-run-summary-card.test.ts`

**Interfaces:**
- Produces: `ApplicationRunSummaryCard({ jobId: string; progress: ApplyProgress })`. It shows the `stepHeading`, the `now` sentence, and a link `Continue on the Apply page` to `/jobs/${jobId}/apply`. It doesn't link to the control page.

- [ ] **Step 1:** Write the tests:
  - `the card links to the Apply page`
  - `the card does not link to /application-runs/`
- [ ] **Step 2:** Run it. Expected: FAIL.
- [ ] **Step 3:** Implement, and remove the three panels from the page.
- [ ] **Step 4:** Run the full gate. Expected: PASS, apart from the browser baseline.
- [ ] **Step 5:** Commit `Replace the application page's run panels with one card`. Push and open draft PR "B5: Progress and the application card (D036)".
