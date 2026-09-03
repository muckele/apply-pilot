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
- AI job matching, resume tailoring, cover letter drafting, email reply drafting, interview prep, and interview feedback prompt contracts
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

Create the disposable local PostgreSQL database `apply_pilot_local_dev`, fill in `.env`, then run the guarded local migration and seed commands. Both commands require dedicated local URLs and the exact acknowledgement marker; they do not take mutation authority from generic `DATABASE_URL` or `DIRECT_URL`:

```bash
npm run prisma:generate
APPLY_PILOT_LOCAL_DESTRUCTIVE=1 \
LOCAL_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:5432/apply_pilot_local_dev?schema=public' \
LOCAL_DIRECT_URL='postgresql://postgres:postgres@127.0.0.1:5432/apply_pilot_local_dev?schema=public' \
npm run prisma:migrate
APPLY_PILOT_LOCAL_DESTRUCTIVE=1 \
LOCAL_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:5432/apply_pilot_local_dev?schema=public' \
LOCAL_DIRECT_URL='postgresql://postgres:postgres@127.0.0.1:5432/apply_pilot_local_dev?schema=public' \
npm run prisma:seed
npm run dev
```

Open `http://localhost:3000/dashboard`.

## Environment Variables

- `DATABASE_URL`: PostgreSQL connection string.
- `AUTH_SECRET`: random secret for Auth.js and local OAuth state signing.
- `AUTH_URL`: canonical Auth.js app URL.
- `NEXTAUTH_URL`: local or deployed app URL.
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`: Google OAuth credentials.
- `AUTH_ALLOWED_EMAILS`: comma-separated Google account allowlist for private production access.
- `AUTH_ALLOW_PUBLIC_SIGNUPS`: set `true` only if you intentionally want public Google signups.
- `GMAIL_REDIRECT_URI`: usually `http://localhost:3000/api/gmail/callback`.
- `GMAIL_SCOPES`: defaults to `https://www.googleapis.com/auth/gmail.readonly`.
- `APPLICATION_AUTOMATION_ENABLED`: global controlled-application emergency stop. Only exact lowercase `true` enables capability-increasing automation, and the user's database policy must also be enabled; missing or any other value fails closed.
- `AI_ENABLED`: paid/provider execution switch. Paid calls occur only when this is exactly `true`; this setting does not enable or disable the overall controlled-application capability.
- `AI_PROVIDER`: default paid provider, currently `gemini` or `openai`.
- `AI_MOCK_MODE`: set `true` to force deterministic local output even when a provider key exists.
- `AI_ALLOWED_MODELS`: narrow comma-separated model allowlist. Every entry must exist in the server pricing registry.
- `AI_HARD_CAP_CENTS`: application hard cap, limited in code to `500` ($5.00).
- `AI_AUTOMATION_CAP_CENTS`: discovery automation sub-cap, limited to `150` ($1.50).
- `AI_MAX_REQUEST_COST_CENTS`: maximum reserved cost for one request, limited to `10` ($0.10).
- `AI_CONFIRMATION_THRESHOLD_CENTS`: browser confirmation threshold, limited to `5` ($0.05).
- `GEMINI_API_KEY`: server-only Gemini API Auth key. Never prefix this variable with `NEXT_PUBLIC_`.
- `GEMINI_FAST_MODEL` / `GEMINI_QUALITY_MODEL`: provider models selected by each feature policy.
- `MOONSHOT_API_KEY`: server-only Kimi (Moonshot) credential, required only when a feature override routes to Kimi. Never prefix with `NEXT_PUBLIC_`.
- `KIMI_MODEL`: Kimi model, default `kimi-k3`. Must exist in the server pricing registry; unknown models fail closed.
- `KIMI_REASONING_EFFORT`: `low` (default), `high`, or `max`. Higher effort raises reasoning-token cost, which is billed as output.
- `AI_PROVIDER_OVERRIDES`: feature-level provider routing, e.g. `APPLICATION_PLAN:kimi`. Only `APPLICATION_PLAN` is eligible; all other features remain on the default provider.
- `AI_EVAL_PLAN_TOP`: application-planning cases per evaluation run, default `0` (no planning calls).
- `KIMI_EVAL_MODE`: `synthetic` (default, fixture data only), `sanitized`, or `real`. Real-data planning evaluation additionally requires `KIMI_EVAL_DATA_ACKNOWLEDGED=true`.
- `OPENAI_API_KEY` / `OPENAI_MODEL`: optional alternative provider configuration.
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
- `ALLOW_DEMO_USER`: allows local API routes to use `demo-user` without a session. Ignored in production.

## Private Multi-User Mode

The MVP is multi-user but not team-based. There are no organizations, shared workspaces, shared jobs, or manager/admin views. Every CRM record is tied to the signed-in `userId`.

For a private deployment, keep `AUTH_ALLOW_PUBLIC_SIGNUPS=false` and add every approved Google account to `AUTH_ALLOWED_EMAILS`:

```env
AUTH_ALLOWED_EMAILS="approved.user@example.test,second.user@example.test"
AUTH_ALLOW_PUBLIC_SIGNUPS="false"
ALLOW_DEMO_USER="false"
```

In production, an empty `AUTH_ALLOWED_EMAILS` blocks sign-in unless `AUTH_ALLOW_PUBLIC_SIGNUPS=true`. The demo user fallback is also disabled in production even if the env var is accidentally set.

Each user can update their own target profile at `/settings/profile`, export their account data, and delete their account records. Exports intentionally omit encrypted OAuth tokens, sessions, and raw stored file bytes.

## Neon / Remote PostgreSQL Deployment

Neon works for the deployed app because it is PostgreSQL. Keep remote credentials out of local repository files. Configure the pooled runtime `DATABASE_URL` and direct `DIRECT_URL` in the hosting environment.

Use a URL like this:

```env
DATABASE_URL="postgresql://USER:PASSWORD@HOST.neon.tech/DB?sslmode=require"
DIRECT_URL="postgresql://USER:PASSWORD@DIRECT_HOST.neon.tech/DB?sslmode=require"
```

Never run reset, migrate-dev, db-push, seed, fixtures, or test resets against Neon or any other remote PostgreSQL target. Remote schema changes are forward-only and require explicit human authorization, endpoint identity verification, and dedicated just-in-time variables:

```bash
DATABASE_URL="$PRODUCTION_DATABASE_URL" \
DIRECT_URL="$PRODUCTION_DIRECT_URL" \
npx prisma migrate status

DATABASE_URL="$PRODUCTION_DATABASE_URL" \
DIRECT_URL="$PRODUCTION_DIRECT_URL" \
npx prisma migrate deploy
```

See `DEPLOYMENT.md` for the complete guarded production procedure. Local migration development and seeding must use the local-only commands in the setup section above.

Restart the local development server with:

```bash
npm run dev -- -H 127.0.0.1 -p 3000
```

If Neon gives you both pooled and direct connection strings, use the pooled string for deployed runtime `DATABASE_URL` and the direct/non-pooled string for explicitly authorized forward migration `DIRECT_URL`. Both URLs are independently authoritative and must be verified together.

## AI Provider Setup

The app uses structured JSON prompts in `/prompts`:

- `jobMatchPrompt`
- `resumeTailorPrompt`
- `coverLetterPrompt`
- `emailReplyPrompt`
- `interviewPrepPrompt`
- `interviewFeedbackPrompt`
- `applicationPlanPrompt` (advisory application planning; routed separately)

The recommended private-MVP configuration uses Gemini 3.5 Flash-Lite for both routine analysis and document workflows. Gemini 3.1 Flash-Lite remains in the allowlist as a lower-cost manual option, but the app never falls back to it automatically. Both models keep every feature's maximum request cost below the compiled ten-cent ceiling at standard real-time pricing. Create a server-side Gemini API Auth key, set `GEMINI_API_KEY`, leave `AI_ENABLED=false` while evaluating, and set it to `true` only after the quality and honesty checks pass. Without an enabled provider and key, the app remains usable with deterministic local output and makes no billable AI request.

Paid calls use schema-validated structured outputs with fixed feature input/output limits and no provider tools or search grounding. Before a call, the app atomically reserves the full ten-cent per-request ceiling from a monthly ledger. It then reconciles actual usage and releases unused funds. Interrupted calls remain charged at their full reservation until reconciled. Unknown models fail closed. Identical request hashes use cached output or an in-progress claim, and only one schema-validation retry is permitted when both attempts fit the ten-cent request ceiling.

### Kimi application planning (opt-in)

Application planning (`APPLICATION_PLAN`) can be routed to Kimi K3 while every other feature remains on the default provider: set `AI_PROVIDER_OVERRIDES="APPLICATION_PLAN:kimi"` and `MOONSHOT_API_KEY`. Planning sends a privacy-minimized payload built by `lib/ai/application-plan.ts`: a bounded job-requirements catalog plus a deterministic candidate-evidence catalog with no contact details, raw resume text, file data, or answer-vault content. The model references evidence only by catalog ID; human-readable text is hydrated locally from the catalog, and Kimi reasoning content is never persisted. Plans are advisory only — they never fill forms, send messages, or submit applications. Live planning evaluation is off by default (`AI_EVAL_PLAN_TOP=0`). See `docs/CONTROLLED_APPLICATION_AUTOMATION.md` for the canonical technical and operator reference.

The AI Controls page shows spent, reserved, and remaining balances; automation has a separate allowance so discovery cannot consume the manual writing budget. Warnings appear at 50%, 75%, and 90%. Requests that could exceed five cents require explicit browser confirmation. The default layers are a $5 application cap, $1.50 automation cap, $0.10 per-request cap, and `AI_ENABLED=false` paid-provider switch.

For the Google billing backstop, use a $10 prepaid balance, leave automatic reload disabled, and create billing alerts at $5, $8, and $10. Provider billing may lag, so the application ledger is the primary enforcement mechanism.

## Controlled Application Automation

The authenticated backend includes controlled preparation, deterministic review, cancellation, audit, and execution-token foundations. `PREPARE_ONLY` is the only current policy mode, and `APPLICATION_READ` is the only execution-token scope that can currently be issued.

The local companion can explicitly inspect the frozen anonymous employer form, publish or replay the correlated inspection, and let the authenticated run-owned page present the current answer packet read only. Packet content remains outside the status-only browser binding. Browser form filling, employer uploads or clicks, ATS application-form adapters, answer-review mutation, application submission, and auto-submit are not implemented. The manual browser capture extension remains a separate review-before-save workflow. See [docs/CONTROLLED_APPLICATION_AUTOMATION.md](docs/CONTROLLED_APPLICATION_AUTOMATION.md) for the current capability, safety, policy, token, concurrency, and operator reference.

The headed local browser companion uses the authenticated same-origin control route for `OPEN_TARGET`, payload-free `INSPECT_FORM`, progress and safe retry outcomes, material publication or replay, reinspection-required handling, and authenticated packet reading. It never fills employer fields, uploads documents, clicks employer controls, submits, or auto-submits. See [docs/APPLICATION_BROWSER_COMPANION.md](docs/APPLICATION_BROWSER_COMPANION.md) for launch, operation, privacy, and safe-stop behavior.

## Google Sign-In Setup

Create an OAuth client in Google Cloud Console:

- Application type: Web application
- Authorized JavaScript origin: `http://localhost:3000`
- Authorized redirect URI: `http://localhost:3000/api/auth/callback/google`

Then set these in `.env`:

```env
GOOGLE_CLIENT_ID="..."
GOOGLE_CLIENT_SECRET="..."
AUTH_ALLOWED_EMAILS="approved.user@example.test"
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

Remotive works without credentials. Adzuna requires `ADZUNA_APP_ID` and `ADZUNA_APP_KEY`. TheirStack requires `THEIRSTACK_API_KEY` and may consume paid credits. SerpApi requires `SERPAPI_API_KEY` and may consume paid search credits; `SERPAPI_MAX_QUERIES_PER_RUN` caps how many SerpApi searches one discovery run can use. USAJOBS requires `USAJOBS_API_KEY` and `USAJOBS_USER_AGENT`. Workable requires an approved API token.

For scheduled discovery, configure the host to call:

```text
GET /api/cron/job-discovery
Authorization: Bearer your-CRON_SECRET
```

The cron route syncs only enabled job sources, skips recently synced sources, caps sources per run, blocks overlapping source syncs, and never submits applications.
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
# Guarded local-only commands; require APPLY_PILOT_LOCAL_DESTRUCTIVE=1 and
# matching LOCAL_DATABASE_URL / LOCAL_DIRECT_URL values.
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
