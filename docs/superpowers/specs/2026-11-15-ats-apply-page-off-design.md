# Ashby jobs whose hosted page is switched off — design

Owner-approved 2026-11-15 (design, one additive migration, one-time read-only probe).

## Why

In a live trial an Ashby job passed every Prepare gate. The Apply Pilot browser then opened the run's
`applyUrlSnapshot` (Ashby's posting-API `applyUrl`, verbatim) and Ashby rendered "Page not found", in the
companion and in normal Chrome alike. The company takes applications on its own careers site and its
Ashby-hosted job board is switched off, while Ashby's public posting API still lists the job with
`isListed: true`. The owner spent paid scoring and document generation before finding out.

Goal: know at sync time, before any time or paid AI goes into the job, and say "apply on the company's
own site" instead of offering Prepare, the Apply Pilot browser or Fill.

## Evidence

- Ashby's posting API documents only `includeCompensation`; `jobUrl` and `applyUrl` always point at
  jobs.ashbyhq.com; no field shows whether the hosted page is on. Ashby's "Disable Ashby-hosted jobs page"
  doc says disabling also hides jobs from the unauthenticated API, which the trial contradicts.
- One-time read-only probe (owner-approved, 2026-11-15), no sign-in, no company sites:
  - `jobs.ashbyhq.com/robots.txt` allows board pages; disallows `/api/`, `/b/`, `/meeting/`.
  - Switched-off board page and its job's `/application` page: HTTP 404; `window.__appData` has
    `organization: null`, `jobBoard: null`, `posting: null`, `maintenanceMode: false`.
  - A working board page: HTTP 200; `organization` is an object (with `hostedJobsPageSlug`), `jobBoard`
    is an object with `jobPostings`.
- So a plain GET of `jobs.ashbyhq.com/<board>` tells "off" from "served". Ashby's internal `/api/` is
  disallowed by robots.txt and is not used.

## Design

1. **Check:** in `syncBoard`, for Ashby boards only, one GET of `jobs.ashbyhq.com/<board>` per board per
   sync, shared across users through the run's listing cache. Never on a page view, never at Prepare.
   `<board>` is the slug exactly as the listing's own `jobUrl`/`applyUrl` write it (the page the Apply Pilot
   browser opens), so a board saved under another case or alias is never misread as off; no listed job on
   jobs.ashbyhq.com means no read. Redirects are not followed (a 3xx is "unknown"), and each result is logged
   as `job_sources.ashby_hosted_page`. A failed mark write is captured and never fails the sync.
   - "off": HTTP 404 and page data with `organization === null` and `jobBoard === null`, not in maintenance.
   - "served": HTTP 200 and page data with `organization` and `jobBoard` objects.
   - Anything else (network error, timeout, other status, no page data, maintenance) is "unknown" and
     changes nothing. The check never fails a sync.
2. **Storage:** `JobPosting.atsApplyPageOffAt DateTime?` (additive, nullable, no backfill). "off" sets it
   on the user's postings whose `normalizedApplyUrl` is listed on that board and which are not marked yet
   (keeps the first time it was found); "served" clears it; "unknown" leaves it.
3. **What the owner sees:**
   - Feed card badge and job header line: "Apply on company site" / "Apply on the company's own site".
   - Apply page: steps 1–3 unchanged (score and write documents to send yourself). Steps 4 and 5 say the
     job board's page is switched off, so there is nothing to prepare and no Apply Pilot browser. The
     progress card switches to "Apply on my own", which opens. Its "Open application" link is replaced by
     "find the posting on the company's own careers site".
   - Prepare refuses on the server with blocker `apply_page_off`, before any AI call.
4. **Jobs already imported:** the next sync of their board marks them (daily cron, or Sync on a followed
   board). A run that was already prepared is left as it is; the page stops offering the browser.

## Non-goals

- Linking to the company's careers page (the switched-off page carries no organization data).
- Per-job checks (a served board with one missing job page) and Greenhouse/Lever equivalents.
- Detecting it from the companion after it opens a page.
