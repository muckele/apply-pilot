# Ashby apply page off — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Board sync learns when an Ashby board's hosted page is switched off and the job then says "apply on the company's own site" instead of offering Prepare, the Apply Pilot browser or Fill.

**Architecture:** A pure classifier reads the HTTP status and Ashby's `window.__appData` from one GET of `jobs.ashbyhq.com/<board>`. `syncBoard` runs it next to the listing fetch (shared cache) and sets or clears a new nullable `JobPosting.atsApplyPageOffAt`. Views, the Apply page progress, the Apply Kit and the Prepare gate read that column.

**Tech Stack:** Next.js 16, Prisma/Postgres, node:test with tsx, JSDOM UI tests.

**Spec:** `docs/superpowers/specs/2026-11-15-ats-apply-page-off-design.md`

## Global Constraints

- Public repo: synthetic board names and IDs only (`northwindlabs`, `Northwind Labs`); no real company, person or record IDs.
- Database: forward-only migration written by hand; never raw `migrate dev/reset` or `db push`; PostgreSQL proof only through `npm run test:postgres` on a throwaway loopback container.
- Never fetch `jobs.ashbyhq.com/api/` (robots.txt disallows it). Tests make no network requests (`globalThis.fetch` throws).
- The check never throws out of a sync; an unknown answer changes nothing.
- Copy: "Apply on company site" (feed badge), "Apply on the company's own site" (job header).

## Review Focus

- Page data containing `};` or `</script>` inside a JSON string must still parse (string-aware scan) — Task 1.
- A 404 without page data (Ashby or CDN error page) or with `maintenanceMode: true` is "unknown", never "off" — Task 1.
- An Ashby outage on one sync must not clear or set flags — Task 2 ("fetch throws" test).
- Two users syncing the same board in one cron run make one hosted-page request — Task 2.
- A job already prepared before the flag must stop offering the browser step even though its run is READY — Task 4.

---

### Task 1: Hosted-page classifier and check

**Files:**
- Create: `lib/job-sources/ashby-hosted-page.ts`
- Test: `tests/ashby-hosted-page.test.ts`

**Interfaces:**
- Produces: `type HostedPageState = "served" | "off" | "unknown"`; `readAshbyAppData(html: string): Record<string, unknown> | null`; `classifyAshbyHostedPage(status: number, html: string): HostedPageState`; `checkAshbyHostedPage(token: string, fetchImpl?: typeof fetch): Promise<HostedPageState>`.

- [ ] Step 1: tests — off (404 + `organization:null, jobBoard:null, maintenanceMode:false`) → "off"; served (200 + organization and jobBoard objects) → "served"; 404 with no page data, 500, 200 with `organization:null`, 404 with `maintenanceMode:true` → "unknown"; page data with `"};</script>"` inside a string still parses; `checkAshbyHostedPage("northwindlabs", fake)` requests exactly `https://jobs.ashbyhq.com/northwindlabs`; a throwing fetch → "unknown"; token `"a/b"` → "unknown" with no request.
- [ ] Step 2: run `node --import tsx --test tests/ashby-hosted-page.test.ts` → FAIL (module missing).
- [ ] Step 3: implement. URL from `boardPageUrl({ ats: "ASHBY", token, region: "global" })` (it validates the token). Fetch with `AbortSignal.timeout(10_000)`; any throw → "unknown".
- [ ] Step 4: run → PASS. Commit.

### Task 2: Schema column, migration and sync marking

**Files:**
- Modify: `prisma/schema.prisma` (JobPosting: `atsApplyPageOffAt DateTime?`)
- Create: `prisma/migrations/20261115120000_add_job_posting_ats_apply_page_off/migration.sql` = `ALTER TABLE "JobPosting" ADD COLUMN "atsApplyPageOffAt" TIMESTAMP(3);`
- Modify: `lib/job-sources/board-sync.ts`
- Test: `tests/ashby-apply-page-sync.test.ts`

**Interfaces:**
- Consumes: `checkAshbyHostedPage` (Task 1).
- Produces: `BoardListingCache = Map<string, Promise<BoardListing>>`, `BoardListing = { jobs: RawJob[]; hostedPage: HostedPageState }`; column `atsApplyPageOffAt`.

- [ ] Step 1: tests through `syncBoard` with an ASHBY target (`northwindlabs`), stubbed `searchJobs`, stubbed fetch and stubbed `prisma.jobPosting.*`: "off" → one `updateMany` with `where: { userId, normalizedApplyUrl: { in: [listed key] }, atsApplyPageOffAt: null }`, `data: { atsApplyPageOffAt: now }`; "served" → `where.atsApplyPageOffAt: { not: null }`, `data: { atsApplyPageOffAt: null }`; fetch throws → no flag `updateMany`; two users, one cache → one hosted-page request; a Greenhouse target → no hosted-page request.
- [ ] Step 2: run → FAIL.
- [ ] Step 3: schema + migration; `listBoard` returns `{ jobs, hostedPage }` (hosted check only for ASHBY, else "unknown", in parallel with the listing); after closure, `updateMany` per the test; skip when no listed keys.
- [ ] Step 4: `npx prisma migrate diff --from-schema-datamodel <main schema> --to-schema-datamodel prisma/schema.prisma --script` prints exactly the migration's statement. Run tests → PASS. Commit.

### Task 3: Job views (feed card, job header)

**Files:**
- Modify: `lib/jobs/job-view-types.ts` (`JobHeaderView.applyOnCompanySite?: boolean`), `lib/jobs/job-page-view.ts` (`DetailJob.atsApplyPageOffAt?: Date | null`), `app/(product)/jobs/page.tsx`, `components/job-feed/feed-card.tsx`, `components/job-workspace/job-header.tsx`
- Test: existing view/UI tests for these components.

- [ ] Steps: test `buildJobDetailView` maps a set date to `applyOnCompanySite: true` and null/absent to false; FeedCard shows badge "Apply on company site" only when set; JobHeader shows "Apply on the company's own site" only when set. FAIL → implement → PASS → commit.

### Task 4: Apply page and Apply Kit

**Files:**
- Modify: `lib/apply-page/apply-progress.ts` (`ApplyProgressInput.applyPageOff?: boolean`; `applyOnYourOwn = (!automationAvailable || applyPageOff) && current >= 4`), `lib/apply-page/load-apply-progress.ts` (facts `applyPageOff` from `detail.view.applyOnCompanySite`), `components/apply-page/apply-page.tsx` (steps 4 and 5 notes, `data-apply-page-off`), `lib/apply-kit/apply-kit-view.ts` (`applyPageOff?: boolean`, `applyLink` null when off), `components/apply-kit/apply-kit.tsx`
- Test: `tests/apply-progress.test.ts`, `tests/apply-page-ui.test.ts`, `tests/apply-kit-view.test.ts`, `tests/apply-kit-ui.test.ts`

- [ ] Steps: tests — progress with `applyPageOff` at step 4 and with a READY run → `applyOnYourOwn` true and now = "Apply on your own with your documents: open Apply on my own."; Apply page with the flag shows the step 4 and step 5 notes, no PrepareStep, no BrowserStep even with a READY run, "Apply on my own" open; Apply Kit view sets `applyPageOff` and no `applyLink`; Apply Kit UI shows the company-site sentence and no `data-apply-link`. FAIL → implement → PASS → commit.

### Task 5: Prepare gate

**Files:**
- Modify: `lib/application-runs/preparation.ts` (`"apply_page_off"` first in `PREPARATION_GATE_BLOCKERS`; required `applyPageOff: boolean` in `PreparationGateInput`, checked first), `lib/application-runs/orchestration.ts` (select `atsApplyPageOffAt`; pass `applyPageOff`), `lib/application-runs/blocker-copy.ts`
- Test: `tests/application-run-preparation.test.ts`, `tests/ready-list.test.ts` (13 reasons)

- [ ] Steps: test `evaluatePreparationGates` returns `"apply_page_off"` ahead of every other blocker and null when false; blocker copy exists. FAIL → implement → PASS → commit.

### Task 6: Verification and PR

- [ ] `npm test`, `npm run lint`, `npm run typecheck`, `npm run test:browser` (baseline failure: "the local screen binds exact consent…"), `npm run test:postgres` on a throwaway loopback postgres:16.
- [ ] Whole-branch review by a fresh reviewer; fix findings (max two rounds).
- [ ] Push, open draft PR against `main` with the existing-jobs note; do not merge.
