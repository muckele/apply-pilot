# Apply Pilot

**Automate the search. Own the results.**

Apply Pilot is a private, AI-assisted job discovery and controlled application workflow app for individual users. It helps discover compliant job postings, compare them against a master resume and career goals, create honest tailored documents, track applications, manage recruiter communications, and prepare for interviews. It is intentionally human-in-the-loop: it does not auto-apply, secretly scrape prohibited job boards, send emails without review, or record/transcribe interviews without consent confirmation.

## MVP Scope

- Next.js App Router, TypeScript, Tailwind CSS
- PostgreSQL with Prisma ORM
- Auth.js / NextAuth scaffolding
- User profile and master resume model
- Resume upload/paste parsing route
- Manual job import with deduplication
- Automated job discovery from compliant APIs, licensed aggregators, ATS feeds, RSS feeds, and permitted company career pages
- Greenhouse, Lever, Ashby, Remotive, Adzuna, TheirStack, SerpApi Google Jobs, USAJOBS, RSS, Workable, and generic company-careers provider layer
- Gemini resume parsing, job matching, resume tailoring, cover-letter drafting, interview prep (brief, likely questions, STAR stories from master-resume facts), post-interview feedback and thank-you drafts, email reply drafts, and application planning, all through one hard monthly budget ledger
- Dashboard, jobs, job detail, applications, resumes, profile settings, integrations, interviews, and tasks pages
- Configurable job-source settings page with source CRUD, test, manual sync, sync status, and sync errors
- Gmail OAuth connect/search/disconnect route scaffolding using readonly access
- Interview consent gate before audio upload
- DOCX, PDF, and Markdown export route for generated documents
- Seed data for a local demo profile and sample CRM records
- Private multi-user mode: each signed-in Google account owns isolated profile, job, CRM, document, Gmail, and interview data
- Account data export and delete-my-data controls
- Review-before-save browser extension for permitted job pages, using short-lived scoped capture tokens
- Application Answer Vault with explicit copy-only handoff and no automatic form submission
- Resume version editor with live page preview and formatting-aware ATS-friendly DOCX/PDF export
- Two-stage discovery: deterministic filtering first, then capped AI analysis for the strongest candidates
- Reusable interview question and STAR story library populated by prep and feedback workflows
- Per-user AI model, discovery, usage, and monthly budget controls

## Install

Requirements:

- Node.js 24.x
- npm (bundled with Node.js)

The repository includes `.nvmrc`, so an `nvm`-managed environment can select the supported runtime before installation:

```bash
nvm install
nvm use
```

```bash
npm install
cp .env.example .env
```

Fill in `.env`, then create and seed a disposable local database. The guarded migrate and seed scripts run only against the localhost database `apply_pilot_local_dev`, and they read their target from shell variables rather than `.env` (see the local-only section of `.env.example`):

```bash
export APPLY_PILOT_LOCAL_DESTRUCTIVE=1
export LOCAL_DATABASE_URL="postgresql://postgres:postgres@localhost:5432/apply_pilot_local_dev?schema=public"
export LOCAL_DIRECT_URL="$LOCAL_DATABASE_URL"
npm run prisma:generate
npm run prisma:migrate
npm run prisma:seed
npm run dev
```

The seed and the local demo fallback use a fictional "Sample User" persona with invented employers.

Open `http://localhost:3000/dashboard`.

## Environment Variables

`.env.example` lists every variable the code reads, each with a one-line comment and a `[required]`, `[required in production]`, `[optional]` or `[local only]` label. `.env.production.example` is the production equivalent. `tests/env-example-coverage.test.ts` fails when code reads a variable that the examples do not document, and when either file holds something that looks like a real value. Platform variables such as `NODE_ENV` and `VERCEL_*` are not listed.

- `DATABASE_URL`: PostgreSQL connection string.
- `DIRECT_URL`: direct (non-pooled) connection string Prisma uses for migrations.
- `AUTH_SECRET`: random secret for Auth.js and local OAuth state signing.
- `AUTH_URL`: canonical Auth.js app URL.
- `NEXTAUTH_URL`: local or deployed app URL.
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`: Google OAuth credentials.
- `AUTH_ALLOWED_EMAILS`: comma-separated Google account allowlist for private production access.
- `AUTH_ALLOW_PUBLIC_SIGNUPS`: set `true` only if you intentionally want public Google signups.
- `GMAIL_REDIRECT_URI`: usually `http://localhost:3000/api/gmail/callback`.
- `GMAIL_SCOPES`: defaults to `https://www.googleapis.com/auth/gmail.readonly`.
- `AI_ENABLED`, `AI_PROVIDER`, and `AI_MOCK_MODE`: explicit paid-AI runtime gate, provider selection, and test/local mock gate. Use `true`, `gemini` (or leave `AI_PROVIDER` unset), and `false` respectively for live Gemini flows. Gemini is the only AI provider; any other `AI_PROVIDER` value turns every AI feature off.
- `GEMINI_API_KEY`: Gemini API key for every AI feature. Without it, AI features show an explicit "AI unavailable" state and never fall back to another provider or to template output.
- `GEMINI_FAST_MODEL`, `GEMINI_QUALITY_MODEL`, and `AI_ALLOWED_MODELS`: optional resume-parse model choices and the user-selectable override allowlist; each model must be in the compiled Gemini price registry.
- `AI_HARD_CAP_CENTS`, `AI_AUTOMATION_CAP_CENTS`, `AI_MAX_REQUEST_COST_CENTS`, and `AI_CONFIRMATION_THRESHOLD_CENTS`: optional values that can lower, never raise, the compiled $5.00 monthly hard cap, $1.50 automation allowance, $0.15 per-request maximum, and $0.05 confirmation threshold.
- `OPENAI_*`, `MOONSHOT_API_KEY`, `KIMI_*`, and `AI_PROVIDER_OVERRIDES` are retired; no feature reads them.
- `TOKEN_ENCRYPTION_KEY`: base64 encoded 32-byte key for Gmail tokens.
- `USAJOBS_API_KEY`: optional USAJOBS API key for federal job discovery.
- `USAJOBS_USER_AGENT`: required USAJOBS API user-agent, usually your registered email.
- `WORKABLE_API_TOKEN`: optional Workable API token for approved Workable account access.
- `ADZUNA_APP_ID` / `ADZUNA_APP_KEY`: optional Adzuna API credentials for broad job discovery.
- `ADZUNA_COUNTRY`: Adzuna country code, default `us`.
- `THEIRSTACK_API_KEY`: optional TheirStack API key for licensed multi-site job discovery.
- `THEIRSTACK_POSTED_MAX_AGE_DAYS`: date freshness window for TheirStack results.
- `SERPAPI_API_KEY`: optional SerpApi key for Google Jobs API discovery.
- `SERPAPI_MAX_QUERIES_PER_RUN`: caps paid SerpApi searches per discovery run, default `3`.
- `JOB_SOURCE_MAX_POSTED_AGE_DAYS`: pre-import freshness window for dated postings, default `30`.
- `JOB_SOURCE_REMOTIVE_ENABLED` / `JOB_SOURCE_ADZUNA_ENABLED`: compliance gates for Remotive and Adzuna discovery, default `false`. See MVP Bible §6 before turning either on.
- `CRON_SECRET`: bearer token required by the scheduled job-discovery route.
- `CRON_MAX_SOURCES_PER_RUN`: caps scheduled source syncs per cron invocation, default `10`.
- `CRON_MIN_SOURCE_INTERVAL_MINUTES`: skips sources synced more recently than this window, default `360`.
- `CRON_RUNNING_LOCK_MINUTES`: treats a stuck `RUNNING` sync as stale after this window, default `30`.
- `FILE_STORAGE_DRIVER`: `database` for durable MVP production storage, `local` for local development.
- Local-development files are scoped to the repository's ignored `uploads/` directory when `FILE_STORAGE_DRIVER=local`.
- `MAX_UPLOAD_MB`: resume upload limit for files sent through an application route; keep this at `4` on Vercel.
- `MAX_AUDIO_UPLOAD_MB`: interview audio/video fallback limit for files sent through an application route; keep this at `4` on Vercel.
- `BLOB_READ_WRITE_TOKEN`: token for a private Vercel Blob store. When present, interview audio uploads directly from the browser to private object storage.
- `MAX_DIRECT_AUDIO_UPLOAD_MB`: maximum direct private Blob audio upload size; defaults to `25` MB.
- `APP_VERSION`: optional deployment version/commit label shown in health output.
- `LOG_LEVEL`: structured logging threshold: `debug`, `info`, `warn`, or `error`.
- `ALLOW_DEMO_USER`: allows local API routes to act as the fictional `demo-user` ("Sample User") without a session. Ignored in production.
- `DEFAULT_DEMO_USER_ID`: user id for the demo fallback and the local seed, default `demo-user`.
- Local-only tooling (`APPLY_PILOT_LOCAL_DESTRUCTIVE`, `LOCAL_DATABASE_URL`, `LOCAL_DIRECT_URL`, `TEST_DATABASE_URL`, `COMMIT5_POSTGRES_TEST`, and the `APPLY_PILOT_SYNTHETIC_*_PREVIEW` flags) is documented, commented out, in `.env.example`. Export these per command and never set them in production.

## Private Multi-User Mode

The MVP is multi-user but not team-based. There are no organizations, shared workspaces, shared jobs, or manager/admin views. Every CRM record is tied to the signed-in `userId`.

For a private deployment, keep `AUTH_ALLOW_PUBLIC_SIGNUPS=false` and add every approved Google account to `AUTH_ALLOWED_EMAILS`:

```env
AUTH_ALLOWED_EMAILS="you@gmail.com,second.user@gmail.com"
AUTH_ALLOW_PUBLIC_SIGNUPS="false"
ALLOW_DEMO_USER="false"
```

In production, an empty `AUTH_ALLOWED_EMAILS` blocks sign-in unless `AUTH_ALLOW_PUBLIC_SIGNUPS=true`. The demo user fallback is also disabled in production even if the env var is accidentally set.

Each user can update their own target profile at `/settings/profile`, export their account data, and delete their account records. Exports intentionally omit encrypted OAuth tokens, sessions, and raw stored file bytes.

## Neon PostgreSQL Setup

Neon works for this app because it is PostgreSQL. In the Neon dashboard, copy your database connection string and set it as `DATABASE_URL` in `.env`.

Use a URL like this:

```env
DATABASE_URL="postgresql://USER:PASSWORD@HOST.neon.tech/DB?sslmode=require"
DIRECT_URL="postgresql://USER:PASSWORD@DIRECT_HOST.neon.tech/DB?sslmode=require"
```

Never run the seed, tests, or `npm run prisma:migrate` against Neon or any other remote database; the guarded scripts refuse non-localhost targets. Remote schema changes use forward-only `prisma migrate deploy` only after explicit owner authorization and endpoint verification (see `AGENTS.md`).

After saving `.env`, run `npm run prisma:generate`, then restart the dev server:

```bash
npm run dev -- -H 127.0.0.1 -p 3000
```

If Neon gives you both pooled and direct connection strings, use the pooled string for `DATABASE_URL` and the direct/non-pooled string for `DIRECT_URL`. Prisma uses `DIRECT_URL` for migrations and `DATABASE_URL` for normal app runtime.

## AI Provider Setup

The active paid structured-output flows use these prompts in `/prompts`:

- `jobMatchPrompt`
- `resumeTailorPrompt`
- `coverLetterPrompt`

`applicationPlanPrompt` is the Gemini application-planning contract. Interview prep, interview feedback, and email reply prompts live with their features in `lib/ai/interview-prep.ts`, `lib/ai/interview-feedback.ts`, and `lib/ai/email-reply.ts`, and share one source-of-truth contract: the user's own records are the only applicant facts, and job posts, emails, and transcripts are untrusted data.

Set `GEMINI_API_KEY`, `AI_ENABLED=true`, and `AI_MOCK_MODE=false` for resume parsing, JOB_MATCH, tailored résumé, and cover-letter calls. JOB_MATCH is pinned to Gemini 3.8 Flash with MEDIUM thinking; tailored résumé and cover-letter calls are pinned to Gemini 3.8 Flash with LOW thinking and do not automatically fall back to another provider or model. Interview prep, interview feedback, email reply drafts, and application plans also run on Gemini 3.8 Flash with LOW thinking, with strict JSON schemas and server-side grounding: STAR stories cite master-resume facts, and numbers those facts do not contain become `[add a number here]` gaps. Without Gemini, AI features report "AI unavailable"; only application planning keeps its deterministic, evidence-only local plan, labeled as local.

AI calls use schema-validated structured outputs and record prompt version, token usage, cached input tokens, and available cost metadata, including failed responses that report usage. Every AI call reserves against one hard monthly budget ledger and uses the compiled, expiring model-price registry (Gemini 3.8 Flash has Google's dated prices registered, $0.75/$3.75 per million input/output tokens through 2026-12-31 and $1.50/$7.50 from 2027-01-01, through 2027-04-01; `/settings/ai` and `/api/health/readiness` show the expiry). Users can cap discovery-time AI and set a monthly budget, up to the hard cap, at `/settings/ai`. Model overrides apply only to resume parsing; every other feature is pinned to its reviewed Gemini model. Put stable instructions before changing payload data in prompts to improve provider-side prompt-cache reuse.

## Google Sign-In Setup

Create an OAuth client in Google Cloud Console:

- Application type: Web application
- Authorized JavaScript origin: `http://localhost:3000`
- Authorized redirect URI: `http://localhost:3000/api/auth/callback/google`

Then set these in `.env`:

```env
GOOGLE_CLIENT_ID="..."
GOOGLE_CLIENT_SECRET="..."
AUTH_ALLOWED_EMAILS="your-email@gmail.com"
```

Restart the dev server after changing `.env`. Sign in at `/login`.

## Gmail OAuth Setup

Create a Google OAuth client and add the exact redirect URI shown on `/settings/integrations`. For local development with the default dev server in this repo, use:

```text
http://localhost:3000/api/gmail/callback
```

Then set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GMAIL_REDIRECT_URI` in `.env`. PostgreSQL must be running and migrated before Gmail OAuth can connect because the app stores encrypted OAuth tokens in the database.

The Gmail integration requests readonly access only. It can search for job-related messages and show snippets. It does not send or delete emails. Full bodies should only be stored when the user explicitly saves them to an application record.

### Recruiter Inbox Triage

After Google sign-in and Gmail OAuth are connected, go to `/settings/integrations` and use **Scan Gmail** in the recruiter email scanner. The scanner searches recent Gmail metadata/snippets for recruiter outreach, hiring-manager messages, interview requests, assessments, offers, rejections, and application updates. It intentionally ignores low-confidence LinkedIn/social notifications, newsletters, job-alert digests, vendor quotes, invoices, and unrelated appointment messages. Use **Save flagged snippets** to explicitly store flagged snippets in the CRM.

The scanner uses `gmail.readonly`, does not send email, does not delete email, and does not store full email bodies.

## Browser Capture and Answer Vault

The unpacked Manifest V3 extension is in `browser-extension/`. Load that directory from `chrome://extensions` in Developer mode, create a scoped token on `/settings/integrations`, and paste the token into the extension. The raw token is shown once and stored in Chrome session storage, so restarting the browser requires re-entering it.

The extension reads only the active tab after the user clicks it. It prefers public `JobPosting` JSON-LD, falls back to visible page text, and always presents an editable review form before saving. It cannot apply, submit a form, or run background searches. Answer Vault entries at `/settings/application-answers` are available to the extension only when the token has the answer-read scope, and each answer must be copied explicitly.

## Job Source Providers

Provider interface: `lib/job-sources/types.ts`.

Implemented:

- `ManualJobImportProvider`
- `GreenhouseProvider`
- `LeverProvider`
- `AshbyProvider`
- `RemotiveProvider`
- `AdzunaProvider`
- `TheirStackProvider`
- `SerpApiProvider`
- `UsaJobsProvider`
- `RssProvider`
- `WorkableProvider`
- `GenericCompanyCareersProvider`

Go to `/settings/job-sources` to add, edit, enable/disable, test, manually sync, and monitor configured sources. URL-based RSS and company-careers sources require the explicit "reviewed as permitted or API-approved" checkbox before test, manual sync, or scheduled sync. Go to `/jobs` and run **Automated discovery** to search enabled providers, deduplicate postings, and save them to PostgreSQL. Discovery applies deterministic filters before import, ranks the remaining candidates, and sends only the highest-ranked capped set to AI when discovery-time AI is enabled.

### Company boards (Greenhouse, Lever, Ashby)

The employer's own public ATS board is the primary job source: it is free, fresh, and carries the real apply URL.

- **Follow a company.** On `/settings/job-sources`, paste any Greenhouse (`boards.greenhouse.io`, `job-boards.greenhouse.io`), Lever (`jobs.lever.co`, `jobs.eu.lever.co`) or Ashby (`jobs.ashbyhq.com`) job or board link. `lib/job-sources/board-url.ts` resolves it to the board token without fetching the link, and `POST /api/job-sources/follow` creates (or re-enables) a job source for the signed-in user. Disable a followed board to stop checking it; a disabled board is also excluded from the directory.
- **Seed directory.** `data/job-board-directory.json` is a reviewed list of public boards tagged by industry, location and remote availability. Each entry was verified with one read-only GET to its board API; it is never scraped or extended automatically. Discovery checks directory boards whose tags match the user's industries, locations and remote preference (every board when the user has none of these). Postings from directory boards are attributed to a managed "Apply Pilot board directory" source per ATS.
- **Per-run cap and rotation.** Each run checks followed boards first, then directory boards, up to `JOB_DISCOVERY_MAX_BOARDS_PER_RUN` (default `40`, max `100`). Remaining directory boards rotate into later runs on a daily window. Board fetches run four at a time and each board is fetched once per run.
- **Freshness and dedupe.** Unchanged postings are not rewritten (a fingerprint of the stored fields is compared). Duplicates are dropped across sources by normalized apply URL, then by normalized company, title and location; boards run before aggregators so the employer's posting wins. Active postings that disappear from their board are marked `EXPIRED`; applied, archived and other statuses are never changed.
- Board discovery keeps the existing deterministic relevance prefilter and the AI-scoring cap. Boards the user follows skip the target-search keyword filter (every relevant role at a company you follow is shown); location, remote-only and the relevance prefilter still apply. Directory boards keep the keyword filter. Location matching uses each user's own preferred and home locations (a city match, then the same US state); no locale is built in.

### Compliance-gated and paid sources

- `JOB_SOURCE_REMOTIVE_ENABLED`: Remotive is **off unless set to `true`**. Its API terms prohibit showing its jobs to collect sign-ups; enable only after a compliance review or private agreement.
- `JOB_SOURCE_ADZUNA_ENABLED`: Adzuna is **off unless set to `true`**, even with `ADZUNA_APP_ID` and `ADZUNA_APP_KEY` configured. Adzuna requires a commercial licence after its trial for revenue-generating products.
- `JOB_DISCOVERY_MAX_BOARDS_PER_RUN`: boards checked per discovery run or per user in the cron, default `40`.

The gates apply to automated discovery, manual source sync and test, and the cron. TheirStack requires `THEIRSTACK_API_KEY` and may consume paid credits. SerpApi requires `SERPAPI_API_KEY` and may consume paid search credits; `SERPAPI_MAX_QUERIES_PER_RUN` caps how many SerpApi searches one discovery run can use. USAJOBS requires `USAJOBS_API_KEY` and `USAJOBS_USER_AGENT`. Workable requires an approved API token.

For scheduled discovery, configure the host to call:

```text
GET /api/cron/job-discovery
Authorization: Bearer your-CRON_SECRET
```

The cron route first runs preference discovery over company boards (followed and matching directory boards) for each approved user with saved discovery preferences, up to 25 users per run, least recently run first. One listing cache serves the whole invocation, so each board is fetched at most once however many users match it. It never calls the query aggregators. The route declares `maxDuration = 300` (fits Vercel Pro) and stops scheduling new users, boards and sources once 80% of that (240 s) has elapsed; deferred work is listed in the response's `timeBudget` and leads the next run. AI scoring follows each user's saved "score imported jobs" choice and the same cap. It then syncs other enabled job sources, skips recently synced sources (including boards just checked), skips compliance-gated sources, caps sources per run, blocks overlapping source syncs, and never submits applications.
The included Vercel schedule runs once daily at 14:00 UTC; the route still enforces the configured per-source interval and provider caps.

The generic provider rejects prohibited job-board hosts, blocks local/private/internal URLs, checks DNS resolution to reduce SSRF risk, limits fetch size/time, follows only validated redirects, and checks `robots.txt` before fetching. The app does not directly scrape LinkedIn, Indeed, ZipRecruiter, CareerBuilder, Glassdoor, or similar restricted job boards. Those sources require approved APIs, licensed aggregator APIs, partner feeds, exports, or user-reviewed manual import.

## What Is Not Automated

- No automatic application submission.
- No automated LinkedIn, Indeed, ZipRecruiter, or similar job-board activity.
- No CareerBuilder or other restricted job-board data mining.
- No email sending without explicit user review and approval.
- No hidden meeting bot.
- No interview recording/transcription without consent confirmation.
- No dishonest resume claims or unsupported keyword stuffing.

## Interview Recording Caution

Recording and transcription laws vary by jurisdiction. The app requires this confirmation before audio upload:

> I confirm that all participants have been informed and have consented to recording/transcription.

This is a product control, not legal advice. Confirm applicable law before recording.

## Useful Scripts

```bash
npm run dev
npm run build
npm run typecheck
npm run prisma:migrate
npm run prisma:seed
```

## Architecture Notes

- API routes use `requireUserId()` and user-owned Prisma queries for row-level ownership checks.
- Production sign-in is private by default through `AUTH_ALLOWED_EMAILS`; public signups require an explicit opt-in.
- Gmail tokens are encrypted with AES-256-GCM.
- Structured JSON logs are written to stdout/stderr with sensitive values redacted.
- `/api/health` and `/api/health/readiness` support production uptime checks.
- API routes use PostgreSQL-backed rate-limit buckets so limits work across serverless instances.
- Audit logs are written for sensitive actions.
- File upload validation is enforced for resume parsing and consented interview audio.

See `SECURITY_NOTES.md`, `COMPLIANCE_NOTES.md`, `PRODUCT_ROADMAP.md`, and `DELIVERY_LOOP_PROMPT.md`.
