# One button, one result window, no prices — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One click runs each paid Apply-page step, a large result window follows every score, and "Did you apply?" records Applied in one click.

**Architecture:** A shared current-score rule (bound or "nothing to add") replaces four separate checks. Client steps send the AI consent headers themselves after a once-per-browser Gemini notice. One `BigWindow` dialog shell hosts the Gemini notice, the result window and (PR b) "Did you apply?".

**Tech Stack:** Next.js 16 client components, React 19, node:test + JSDOM, Playwright Chromium (esbuild-bundled harness).

**Spec:** `docs/superpowers/specs/2026-11-13-one-click-result-window-design.md`

## Global Constraints

- No "¢", "$" or "cost" text on the Apply page.
- Do not edit `lib/ai/job-match.ts` or `lib/job-sources/requirement-lines.ts`. No schema change. No change to tailored content generation.
- Synthetic data only in tests (public repo).
- Notice storage key: `apply-pilot:gemini-notice:v1:<draftUserKey>`.

## Review Focus

- Unsaved step-2 lines when Create is clicked in the window: Create must not write documents from stale lines; the window says to update the match first.
- Notice "Not now": nothing is sent and the step says so.
- A failed or budget-capped score: no window, a plain message with no money in it.
- Double click on Create or a step button: one request.
- Esc / "Not now" returns focus to the page and the window does not reopen on the next refresh.

---

### Task 1: Shared current-score rule (PR a)

**Files:** Modify `lib/jobs/current-job-match.ts`, `lib/jobs/fit-estimate.ts`, `lib/jobs/job-detail.ts`, `lib/application-runs/orchestration.ts`, `lib/applications/export-route.ts`, `lib/jobs/application-document-evidence.ts`, `lib/apply-page/load-apply-progress.ts`, `components/apply-page/apply-page.tsx`. Tests: `tests/current-job-match-basis.test.ts` (new), `tests/job-fit-estimate.test.ts`, `tests/job-detail-loader.test.ts`, `tests/application-run-orchestration.test.ts`, `tests/application-export-route.test.ts`, `tests/application-document-evidence.test.ts`.

**Produces:** `currentJobMatchBasis({ job, resume, profile, analysis, context? }): "REVIEWED_EVIDENCE" | "NOTHING_TO_ADD" | null`, where `job.currentEvidenceSnapshot` carries `reviewedAnalysisId`. `estimateIsCurrent(basis)` in `lib/jobs/estimate-basis.ts` (client-safe).

- [ ] Failing tests: bound answer → REVIEWED_EVIDENCE; nothing-to-add answer → NOTHING_TO_ADD; same but snapshot has a fact, or reviewed another analysis, or generation moved twice, or résumé changed → null.
- [ ] Each of the four places gets a test that a nothing-to-add answer counts (Prepare passes its gate, export shows the score, job page gives confidence, tailoring protects that answer's citations) and that one with a line added does not.
- [ ] Implement; fit-estimate uses the rule and marks MASTER_RESUME_NO_NEW_FACTS `isCurrent: true` (still not reviewable).

### Task 2: Consent fetch, error text, Gemini notice memory (PR a)

**Files:** `lib/ai/browser-request.ts` (`fetchWithAiConsent(input, init?, fetchImpl?)`), `lib/apply-page/ai-error-text.ts` (`aiErrorText(json, fallback)`), `lib/apply-page/gemini-notice.ts` (`hasSeenGeminiNotice(storage, key)`, `rememberGeminiNotice(storage, key)`). Tests alongside.

- [ ] Consent fetch sends both headers once, no second request. Error text never contains "$", "¢" or "charged"; AI_BUDGET_EXCEEDED → "You've reached this month's AI limit."; notice memory survives a throwing storage.

### Task 3: BigWindow, ResultWindow, notice hook (PR a)

**Files:** `components/ui/big-window.tsx`, `components/apply-page/result-window.tsx`, `lib/apply-page/result-window.ts` (`resultWindowView({ score, checklist })` → `{ kind: "strong" | "close" | "weak", letter, score, why, missing }`), `components/apply-page/use-gemini-notice.tsx`.

- [ ] Unit tests for `resultWindowView` (85 → strong, 70 → close with ≤2 missing, 54 → weak) and for each window's buttons, the hidden credit slot, and the out-of-credits slot.

### Task 4: Apply page wiring (PR a)

**Files:** `components/apply-page/apply-page.tsx`, `experience-step.tsx`, `documents-step.tsx`, `prepare-step.tsx`, `components/job-workspace/score-job-button.tsx`, `components/apply-kit/apply-kit.tsx`, `lib/application-runs/client-run.ts`, `lib/apply-page/apply-progress.ts`, `lib/apply-page/write-documents.ts` (`writeDocuments(jobId, steps, onProgress)`).

- [ ] UI tests: step 1 one click after notice; step 2 one button (attestation, nothing-to-add skips the score); window after score; A Create saves the nothing-to-add review then writes both documents; pending lines block Create; no "¢" anywhere on the page.

### Task 5: Real-browser test and suites (PR a)

**Files:** `tests/browser/apply-result-window.test.ts` (esbuild harness, page.route mocks).

- [ ] Chromium: notice once, one-click score sends consent headers, A/B/C-D windows are modal, Esc closes and returns focus, 390px width fits, C/D link goes to `/jobs`.
- [ ] `npm test`, `npm run lint`, `npm run typecheck`, `npm run test:browser`; draft PR (a).

### Task 6: "Did you apply?" in the window (PR b, stacked on a)

**Files:** `components/apply-kit/apply-return-card.tsx`, `components/apply-kit/apply-kit.tsx`, `components/job-workspace/job-apply-return-prompt.tsx`, tests `tests/apply-return-ui.test.ts`, browser test extension.

- [ ] "Yes, I applied" posts APPLIED with the attached documents in one click; the Applications list shows it; "Not yet" and "Not applying" unchanged. Suites, draft PR (b).
