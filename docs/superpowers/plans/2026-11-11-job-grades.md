# Job Grades Implementation Plan (D036 Part A)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every job on the jobs page and in the review queue shows an A–D grade from a light, batched background AI grade (`JOB_GRADE`), after a one-time opt-in with daily and monthly limits. The detailed match replaces the grade when you apply.

**Architecture:**
- A new AI feature runs through the existing guarded Gemini path (`generateGuardedGeminiJson`, `lib/ai/guarded-gemini.ts:224`) with `automation: true`, so it uses the background allowance and never asks.
- A pure normalizer drops any job whose answer fails the truth checks, without failing the batch.
- Grades are stored as `AIAnalysis` rows of a new enum value `JOB_GRADE`, one per job.
- `gradeNewJobs` replaces today's discovery scoring (`scoreTopImportedJobs`, which ran the full JOB_MATCH) in sync, discovery and manual import.
- The feed resolves one grade per job: the detailed match if current, otherwise the quick grade.

**Tech Stack:** Next.js 16, TypeScript, Prisma 5.22 (Postgres), Gemini through `lib/ai/guarded-gemini.ts`, node:test with JSDOM.

**Spec:** `docs/superpowers/specs/2026-11-11-get-ready-redesign-design.md` (§3, §5, §6, §7). Decision D036.

## Global Constraints

- **Letters:** A = 85–100, B = 70–84, C = 55–69, D = below 55, via `gradeLetter` in `lib/jobs/grade.ts`. That file is shared with the Apply-page plan, and its content is identical whichever plan lands first.
- **The feature:**
  - `JOB_GRADE`, with prompt name `jobGradePrompt` and `JOB_GRADE_PROMPT_VERSION = "1"`.
  - Policy `{ maxOutputTokens: 4_000, maxInputTokens: 40_000, modelTier: "fast" }`.
  - Model `getAiModel("JOB_GRADE", settings)`, which is `gemini-3.5-flash-lite` today. The guarded path defaults to Flash, so the model must be passed explicitly.
  - Batches of at most 10 jobs.
- **When grading runs:**
  - Only when `AISettings.aiDiscoveryEnabled` is true. `scoreImported` no longer gates anything.
  - Every call uses `{ automation: true }`.
- **Limits:**
  - Daily: `AISettings.maxAnalysesPerSync` jobs per UTC day, counted as `JOB_GRADE` `AIAnalysis` rows created since UTC midnight. No per-day counter existed before.
  - Monthly: the existing effective background allowance (`effectiveBudgetMicros`, `lib/ai/application-plan-budget.ts:41–56`).
- **Exact copy:**
  - `Grade new jobs automatically`, `Jobs graded per day`, `Not graded yet`, `Best grade`
  - `Apply Pilot's grade of how well your résumé fits this job. Not the employer's.`
  - `from an older résumé`, `detailed`
  - `Today's grading limit is used up. Grading resumes tomorrow.`
- **Wording:** "ATS score" never appears, and grades are never called a hiring probability.
- **No AI from pages:** rendering the jobs page, the review queue or Settings never makes an AI call.
- **Database:**
  - One migration, `ALTER TYPE "AIAnalysisType" ADD VALUE IF NOT EXISTS 'JOB_GRADE';`, created only with `npm run prisma:migrate -- --name add_job_grade_analysis_type --create-only` against the local loopback database.
  - Never raw `prisma migrate dev`, `migrate reset` or `db push`.
  - Production `migrate deploy` only with the owner's explicit authorization and endpoint check (`AGENTS.md`).
- **Public repo:** tests use synthetic résumés and jobs only.
- **Every PR runs** `npm test`, lint, typecheck and `npm run test:browser`, plus `npm run test:postgres` for the migration.
  - Browser baseline: everything passes except `the local screen binds exact consent and pauses four mocked calls for post-response review`.

## Review Focus

1. **The résumé changes after grading.** Old grades show `from an older résumé`, are never presented as current, and are re-graded within the limits. Tests in Tasks 4 and 5.
2. **Gemini returns the wrong set of jobs** (missing, extra, duplicated or unknown `jobId`s). Unknown and duplicate entries are dropped, and missing jobs stay `Not graded yet`. Test in Task 3.
3. **Several syncs in one day** (a manual `/api/jobs/sync` plus the 14:00 UTC cron). The total graded per UTC day never passes the limit. Test in Task 5.
4. **Grading is off.** No grading request is ever made in sync, discovery or import. Test in Task 5.
5. **The background allowance runs out mid-run.** Grading stops for that run without failing the sync, and the remaining jobs stay `Not graded yet`. Test in Task 5.

---

### Task 1: Grade letters

**Files:**
- Create: `lib/jobs/grade.ts`. Skip it if the Apply-page plan already created it, and verify the content matches.
- Test: `tests/job-grade-letter.test.ts`

**Interfaces:**
- Produces:
  - `type GradeLetter = "A"|"B"|"C"|"D"`
  - `gradeLetter(score: number | null | undefined): GradeLetter | null`. Anything other than an integer from 0 to 100 gives `null`.
  - `GRADE_EXPLANATION` (exact copy above).

- [ ] **Step 1:** Write the tests: 84 → B, 85 → A, 69 → C, 70 → B, 54 → D, 55 → C, 0 → D, 100 → A, 101 → null, 85.5 → null, null → null.
- [ ] **Step 2:** Run `node --import tsx --test tests/job-grade-letter.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Re-run. Expected: PASS.
- [ ] **Step 5:** Commit `Add A–D grade letters`.

### Task 2: The JOB_GRADE enum value

**Files:**
- Modify: `prisma/schema.prisma`. Add `JOB_GRADE` to `enum AIAnalysisType` (L108–117).
- Create: `prisma/migrations/<timestamp>_add_job_grade_analysis_type/migration.sql`, generated by the guarded script. It's a comment line plus `ALTER TYPE "AIAnalysisType" ADD VALUE IF NOT EXISTS 'JOB_GRADE';`, following `20260520183500_add_serpapi_job_source`.
- Test: `tests/postgres/job-grade-migration.test.ts` (new)

- [ ] **Step 1:** Write `JOB_GRADE is a valid AIAnalysisType after migrations`. Insert and read back an `AIAnalysis` row with `type: "JOB_GRADE"` in the disposable database.
- [ ] **Step 2:** Run `npm run test:postgres`. Expected: FAIL (invalid enum value).
- [ ] **Step 3:** Edit the schema, then run `npm run prisma:migrate -- --name add_job_grade_analysis_type --create-only`. Check that the generated SQL is the single `ALTER TYPE` line.
- [ ] **Step 4:** Run `npm run test:postgres`. Expected: PASS.
- [ ] **Step 5:** Commit `Add the JOB_GRADE analysis type`.

### Task 3: The JOB_GRADE feature and its truth checks

**Files:**
- Modify: `lib/ai/policy.ts`. Add `"JOB_GRADE"` to the `AiFeature` union (L3–15) and to `AI_FEATURE_POLICIES` (L25–56).
- Modify: `lib/ai/feature-registry.ts`. Add an `AI_FEATURE_REGISTRY` entry modelled on JOB_MATCH (L61–71):
  - `confirmation: "cost_threshold"`, the same `dataType` as JOB_MATCH
  - `label: "Job grade"`, `requestNoun: "grade request"`, `outputNoun: "job grades"`, `errorCodePrefix: "JOB_GRADE"`
- Create: `prompts/job-grade.ts`, exporting `jobGradePrompt`. The prompt says:
  - grade 0–100 how well the résumé summary meets each job's listed requirements
  - judge meaning and transferable experience
  - never invent experience
  - each gap must be copied word for word from that job's requirements or preferred qualifications
  - each strength must name a skill, title or credential from the résumé summary
  - return JSON only
- Create: `lib/ai/job-grade.ts`
- Modify: `tests/ai-feature-ledger-coverage.test.ts`. Add a JOB_GRADE invoker to `FEATURE_INVOKERS` (~L120–193).
- Test: `tests/job-grade-normalize.test.ts`, `tests/job-grade-gemini.test.ts`. Both are new; follow the stub pattern in `tests/interview-email-plan-gemini.test.ts` (`paidEnvironment`, `installLedger`, `installGemini`).

**Interfaces:**
- Produces, in `lib/ai/job-grade.ts`:
  - `JOB_GRADE_PROMPT_NAME = "jobGradePrompt"`, `JOB_GRADE_PROMPT_VERSION = "1"`, `JOB_GRADE_BATCH_SIZE = 10`
  - `type JobGradeJobInput = { jobId: string; title: string; location: string | null; requirements: string[]; preferredQualifications: string[] }`
  - `type JobGradeResumeSummary = { summary: string | null; titles: string[]; skills: string[]; certifications: string[]; achievements: string[] }`
  - `buildJobGradeResumeSummary(resume: { summary: string | null; skills: string[]; achievements: string[]; workHistory: unknown; certifications: unknown }): JobGradeResumeSummary`
    - `titles` reads `"<title>, <company> (<start>–<end>)"`, from the work-history shape in `lib/ai/resume.ts:115–189`.
    - At most 80 skills, 12 achievements and 20 certifications.
  - `type JobGrade = { jobId: string; score: number; reason: string; strengths: string[]; gaps: string[] }`
  - `type JobGradeRejection = { jobId: string; reason: "UNKNOWN_JOB" | "DUPLICATE_JOB" | "BAD_SCORE" | "GAP_NOT_A_REQUIREMENT" | "STRENGTH_NOT_ON_RESUME" }`
  - `jobGradeOutputSchema` (zod), plus the matching JSON schema:
    - `{ grades: Array<{ jobId: string; score: int 0..100; reason: string ≤140; strengths: string[] ≤3, each ≤80; gaps: string[] ≤3, each ≤220 }> }`
  - `normalizeJobGrades(raw: z.infer<typeof jobGradeOutputSchema>, jobs: JobGradeJobInput[], resume: JobGradeResumeSummary): { grades: JobGrade[]; rejected: JobGradeRejection[] }`. It's pure:
    - a gap must equal one of that job's requirement or preferred lines under `comparableEvidenceText` (`lib/ai/evidence-text.ts`)
    - a strength passes when each of its tokens of three or more letters, apart from `and, the, with, for, experience, years, year, strong, background, skills, knowledge`, appears in the comparable résumé-summary token set
    - one bad gap or strength rejects that job
  - `gradeJobsBatch(input: { userId: string; resume: JobGradeResumeSummary; jobs: JobGradeJobInput[]; model: string; options: AiInvocationOptions }): Promise<{ grades: JobGrade[]; rejected: JobGradeRejection[]; model: string }>`
    - It calls `generateGuardedGeminiJson` with `feature: "JOB_GRADE"`, `schema: jobGradeOutputSchema` and no throwing `validate`. A thrown hook would fail the whole batch (`guarded-gemini.ts:389–402`).
    - It then runs `normalizeJobGrades`.
    - It throws when `jobs.length > JOB_GRADE_BATCH_SIZE`.

- [ ] **Step 1:** Write the normalize tests:
  - an unknown `jobId` → `UNKNOWN_JOB`
  - the same `jobId` twice → keep the first, reject the second as `DUPLICATE_JOB`
  - a job missing from the output → absent from `grades`
  - a paraphrased gap → `GAP_NOT_A_REQUIREMENT`
  - the strength `Kubernetes` when it's not on the résumé → `STRENGTH_NOT_ON_RESUME`
  - the strength `strong SaaS sales background` with `SaaS` and `sales` on the résumé → accepted
- [ ] **Step 2:** Write the Gemini tests:
  - `one request grades ten jobs`
  - `the request uses gemini-3.5-flash-lite`
  - `automation calls never return 428`
  - `a reservation is reconciled SUCCEEDED`
  - `eleven jobs throw before any request`
  - the ledger-coverage test includes JOB_GRADE
- [ ] **Step 3:** Run `node --import tsx --test tests/job-grade-normalize.test.ts tests/job-grade-gemini.test.ts tests/ai-feature-ledger-coverage.test.ts`. Expected: FAIL.
- [ ] **Step 4:** Implement the policy, registry entry, prompt and `lib/ai/job-grade.ts`.
- [ ] **Step 5:** Re-run the same command. Expected: PASS.
- [ ] **Step 6:** Commit `Add the JOB_GRADE AI feature`.

### Task 4: Storing and resolving grades

**Files:**
- Create: `lib/jobs/job-grades.ts`
- Modify: `lib/job-sources/ingestion.ts`. Export `jobContentFingerprint` (L85) if it isn't exported.
- Test: `tests/job-grade-resolve.test.ts`

**Interfaces:**
- Produces:
  - `jobGradeInputHash(input: { resumeId: string; resumeUpdatedAt: Date; jobFingerprint: string }): string`. It's the sha256 of `` `${JOB_GRADE_PROMPT_VERSION}|${resumeId}|${resumeUpdatedAt.toISOString()}|${jobFingerprint}` ``.
  - `saveJobGrades(tx: Prisma.TransactionClient, input: { userId: string; model: string; resumeId: string; resumeUpdatedAt: Date; grades: JobGrade[]; fingerprints: Map<string, string> }): Promise<number>`. It writes one `AIAnalysis` per grade:
    - `type: "JOB_GRADE"`, `jobPostingId`, `model`, `promptName`, `promptVersion`, `inputHash`
    - `input: { jobId, resumeId, resumeUpdatedAt, jobFingerprint }`
    - `output: grade`, `confidence: null`
  - `CURRENT_JOB_GRADE_ANALYSES`: a Prisma relation selection, `where type JOB_GRADE, orderBy createdAt desc, take 1, select { output, inputHash, createdAt }`.
  - `countJobGradesToday(db: Pick<PrismaClient, "aIAnalysis">, userId: string, now?: Date): Promise<number>`
  - `type ResolvedJobGrade = { letter: GradeLetter; score: number; source: "DETAILED" | "QUICK"; stale: boolean; reason: string | null; strengths: string[]; gaps: string[] }`
  - `resolveJobGrade(input: { detailedScore: number | null; quick: { output: unknown; inputHash: string | null } | null; currentHash: string | null }): ResolvedJobGrade | null`. A valid detailed score wins (`source: "DETAILED"`, `stale: false`). Otherwise the quick grade is used, with `stale` set when its `inputHash !== currentHash`.

- [ ] **Step 1:** Write the tests:
  - `detailed score wins over the quick grade`
  - `quick grade with a different hash is stale`
  - `no grades → null`
  - `malformed quick output → null`
  - `counts only today's JOB_GRADE rows in UTC` (fake db)
- [ ] **Step 2:** Run `node --import tsx --test tests/job-grade-resolve.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Re-run. Expected: PASS.
- [ ] **Step 5:** Commit `Store and resolve job grades`.

### Task 5: Grading new jobs in sync, discovery and import

**Files:**
- Create: `lib/jobs/grade-new-jobs.ts`
- Modify: `lib/job-sources/discovery.ts`. Replace the `scoreTopImportedJobs` calls (L867–874, L940–942) with `gradeNewJobs`, and delete `scoreTopImportedJobs` (L389–468).
- Modify: `lib/job-sources/source-management.ts` (L96–105), the same way.
- Modify: `lib/job-sources/scoring-presentation.ts`. Add `DAILY_LIMIT` with the exact copy.
- Modify: `app/api/jobs/import/route.ts`. When `runMatch` is false, call `gradeNewJobs({ trigger: "import" })` after the upsert. Catch and report errors with `captureException`, and return `grading: { status }`.
- Modify: `components/manual-job-import-form.tsx`. Send `runMatch: false` and drop its cost question.
- Test: `tests/grade-new-jobs.test.ts` (new); update `tests/job-discovery-relevance.test.ts` (L237–336), `tests/job-source-scoring-reporting.test.ts` and `tests/manual-job-import-route.test.ts`.

**Interfaces:**
- Consumes: `gradeJobsBatch`, `buildJobGradeResumeSummary`, `saveJobGrades`, `countJobGradesToday`, `jobGradeInputHash`, `scoreJobRelevance` (`lib/job-sources/relevance.ts:528`), `jobLocationFit` (`lib/job-sources/location-match.ts:344`), `getAiModel`.
- Produces:
  - `type GradingStopReason = DiscoveryScoringStopReason | "DAILY_LIMIT" | "NO_MASTER_RESUME"`
  - `gradeNewJobs(input: { userId: string; jobIds: string[]; trigger: "sync" | "discovery" | "import"; now?: Date; deps?: { gradeBatch?: typeof gradeJobsBatch; db?: PrismaClient } }): Promise<{ graded: number; rejected: number; stopReason: GradingStopReason | null }>`

The steps, in order:
1. With `aiDiscoveryEnabled` off, return `DISABLED_BY_POLICY`. Zero requests.
2. Set `remaining = maxAnalysesPerSync − countJobGradesToday`. At zero or less, return `DAILY_LIMIT`.
3. Load the newest master résumé. Without one, return `NO_MASTER_RESUME`.
4. Keep the jobs with no grade for the current hash, `scoreJobRelevance(...).score >= 60` and `jobLocationFit(...) !== "none"`.
5. Sort by `datePosted`, newest first, and take `remaining`.
6. Grade in chunks of `JOB_GRADE_BATCH_SIZE` with `{ automation: true }`, and save each chunk in its own transaction.
7. On `AI_BUDGET_EXCEEDED` or the AI being unavailable, stop with the existing stop reason. Don't throw.

- [ ] **Step 1:** Write the tests:
  - `grading off makes no request`
  - `two runs in one day grade at most the daily limit in total`
  - `budget exceeded stops without throwing and reports the reason`
  - `a résumé update makes earlier grades stale and they are re-graded`
  - `a job outside the location preference is skipped`
  - `import grades the one job when grading is on and returns grading status`
  - update the discovery and source-sync tests to assert `gradeNewJobs` is called and JOB_MATCH never is
- [ ] **Step 2:** Run `node --import tsx --test tests/grade-new-jobs.test.ts tests/job-discovery-relevance.test.ts tests/job-source-scoring-reporting.test.ts tests/manual-job-import-route.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement and rewire.
- [ ] **Step 4:** Re-run the same command. Expected: PASS.
- [ ] **Step 5:** Commit `Grade new jobs in the background`.

### Task 6: The opt-in in Settings ▸ AI

**Files:**
- Modify: `components/ai-settings-panel.tsx`. The checkbox (L60–62) becomes `Grade new jobs automatically`, with the in-page disclosure under it:
  - `Apply Pilot sends your résumé summary and each new job's listing to Google Gemini to grade how well you fit. Up to {N} jobs a day, within your background AI limit of ${X} a month.`
  - The number input (L89) becomes `Jobs graded per day` (0–25).
  - Saving with the box ticked is the consent; there's no extra dialog.
- Modify: `app/(product)/settings/ai/page.tsx`.
  - The badge reads `Job grading on` / `Job grading off`.
  - The limits copy reads `A limit of 0 turns grading off.`
  - Show the effective monthly background limit, read-only, from `effectiveBudgetMicros`.
- Modify: `components/automated-job-discovery-panel.tsx`. Remove the `scoreImported` checkbox (L157–164) and show `Grading follows Settings ▸ AI.` The stored field is left alone, with no schema change.
- Test: `tests/ai-settings-panel.test.ts` (new or extended)

- [ ] **Step 1:** Write the tests:
  - `the opt-in shows what is sent, the daily limit and the monthly limit`
  - `saving sends aiDiscoveryEnabled and maxAnalysesPerSync only`
  - `the discovery panel has no AI scoring checkbox`
- [ ] **Step 2:** Run `node --import tsx --test tests/ai-settings-panel.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Re-run. Expected: PASS.
- [ ] **Step 5:** Commit `Opt in to job grading in Settings`.

### Task 7: Letters on the jobs page and in the review queue

**Files:**
- Create: `components/job-grade-badge.tsx`
- Modify: `app/(product)/jobs/page.tsx`.
  - Add `CURRENT_JOB_GRADE_ANALYSES` to `feedJobInclude` (L30–39).
  - In `getFeed` (L41–93), resolve `grade` with `resolveJobGrade`. The detailed score comes from today's `resolveFitEstimate`; `currentHash` comes from the master résumé and the job fingerprint.
  - The summary reads `N jobs · M graded`.
- Modify: `lib/jobs/feed-query.ts`.
  - `FeedSort` gains `"grade"`, labelled `Best grade`, in `FEED_SORTS` and in the inline list in `parseFeedFilters` (L59).
  - `sortFeedItems` sorts `grade` by `grade.score` descending, with nulls last.
  - `feedOrderBy` sorts `grade` by `createdAt` descending (the sorting happens in memory).
- Modify: `components/job-feed/feed-card.tsx` (L38–45). Replace `FitBadge` and the Score button with `JobGradeBadge`.
- Modify: `components/job-feed/feed-filter-bar.tsx` (L103–105). Add `Best grade` to the sort menu.
- Modify: `app/(product)/jobs/review/page.tsx` (L140–152, L325) and `lib/jobs/review-queue.ts`.
  - Use `JobGradeBadge`.
  - The `Needs fit score` flag (L160) becomes `Not graded yet`.
  - `categorizeJob` (L173) uses the resolved grade score.
- Modify: `components/job-workspace/match-card.tsx` and `app/(product)/jobs/[id]/page.tsx` (or `lib/jobs/job-detail.ts` if the Apply-page plan's Task 2 has landed).
  - `MatchCard` takes `quickGrade?: ResolvedJobGrade | null` and shows `JobGradeBadge` when there's no detailed estimate.
  - The Apply-page plan also edits `MatchCard` (a `showScoreButton` prop), so rebase onto whichever lands first.
- Test: `tests/job-feed-view.test.ts` (update L47), `tests/job-feed-query.test.ts`, `tests/job-grade-badge.test.ts`, `tests/no-ats-score.test.ts` (new)

**Interfaces:**
- Produces: `JobGradeBadge({ grade: ResolvedJobGrade | null })`. It renders:
  - `Not graded yet` when `grade` is null
  - otherwise the letter, plus ` · detailed` for the detailed source, then the reason
  - `from an older résumé` when stale
  - a `Why` disclosure listing the strengths, the gaps and `GRADE_EXPLANATION`

- [ ] **Step 1:** Write the tests:
  - `an ungraded card shows Not graded yet and no Score button`
  - `a stale grade says from an older résumé`
  - `the detailed source is labelled detailed`
  - `Best grade sorts by score with ungraded last`
  - `getFeed never calls the AI` (stub `generateGuardedGeminiJson`, `scoreJobMatch` and `fetch`; assert no calls)
  - `no source file under app/, components/ or lib/ contains "ATS score"` (case-insensitive)
- [ ] **Step 2:** Run the four files. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the full gate (`npm test`, lint, typecheck, `npm run test:browser`, `npm run test:postgres`). Expected: PASS, apart from the browser baseline.
- [ ] **Step 5:** Commit `Show A–D grades on the jobs page and review queue`. Push and open draft PR "A1: A–D job grades (D036)". In the PR body:
  - The migration needs the owner's explicit authorization before production.
  - Production grading stays off until the owner ticks the opt-in.

### Task 8: Calibration after deploy (owner-run, no code)

The owner's scored jobs live in production. A local calibration would need production data on this machine, so calibration happens in the app instead.

- [ ] **Step 1:** After the owner authorizes the migration and merges A1, the owner turns on grading. Once jobs that already have a detailed match get a quick grade, list for the owner, in chat, each such job's quick letter next to its detailed letter. That's job titles and letters only; nothing is committed.
- [ ] **Step 2:** If fewer than most of the A and B letters agree, propose a prompt change as `JOB_GRADE_PROMPT_VERSION = "2"` in a follow-up PR. Bumping the version makes earlier grades stale.
