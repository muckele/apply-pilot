# JobMatch CRM

Personal job-search CRM and AI resume optimization app for Mathew Uckele.

JobMatch CRM helps discover compliant job postings, compare them against a master resume and career goals, create honest tailored documents, track applications, manage recruiter communications, and prepare for interviews. It is intentionally human-in-the-loop: it does not auto-apply, secretly scrape prohibited job boards, send emails without review, or record/transcribe interviews without consent confirmation.

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
- Gmail OAuth connect/search/disconnect route scaffolding using readonly access
- Interview consent gate before audio upload
- DOCX, PDF, and Markdown export route for generated documents
- Seed data for the target profile and sample CRM records

## Install

```bash
npm install
cp .env.example .env
```

Fill in `.env`, then create and seed the database:

```bash
npm run prisma:generate
npm run prisma:migrate
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
- `AUTH_ALLOWED_EMAILS`: optional comma-separated Google account allowlist.
- `GMAIL_REDIRECT_URI`: usually `http://localhost:3000/api/gmail/callback`.
- `GMAIL_SCOPES`: defaults to `https://www.googleapis.com/auth/gmail.readonly`.
- `OPENAI_API_KEY`: OpenAI API key.
- `OPENAI_MODEL`: default model for structured JSON generations.
- `OPENAI_MOCK_MODE`: set `true` for local deterministic fallback outputs.
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
- `UPLOAD_DIR`: local file storage path for uploaded resumes/interview audio.
- `MAX_UPLOAD_MB`: upload limit.
- `ALLOW_DEMO_USER`: allows local API routes to use `demo-user` without a session.

## Neon PostgreSQL Setup

Neon works for this app because it is PostgreSQL. In the Neon dashboard, copy your database connection string and set it as `DATABASE_URL` in `.env`.

Use a URL like this:

```env
DATABASE_URL="postgresql://USER:PASSWORD@HOST.neon.tech/DB?sslmode=require"
DIRECT_URL="postgresql://USER:PASSWORD@DIRECT_HOST.neon.tech/DB?sslmode=require"
```

After saving `.env`, run:

```bash
npm run prisma:generate
npm run prisma:migrate
npm run prisma:seed
```

Then restart the dev server:

```bash
npm run dev -- -H 127.0.0.1 -p 3000
```

If Neon gives you both pooled and direct connection strings, use the pooled string for `DATABASE_URL` and the direct/non-pooled string for `DIRECT_URL`. Prisma uses `DIRECT_URL` for migrations and `DATABASE_URL` for normal app runtime.

## OpenAI Setup

The app uses structured JSON prompts in `/prompts`:

- `jobMatchPrompt`
- `resumeTailorPrompt`
- `coverLetterPrompt`
- `emailReplyPrompt`
- `interviewPrepPrompt`
- `interviewFeedbackPrompt`

Set `OPENAI_API_KEY` and `OPENAI_MOCK_MODE=false` to call the API. Local mock mode keeps the MVP usable without network/API setup.

## Gmail OAuth Setup

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

Go to `/jobs` and run **Automated discovery** to search enabled providers, deduplicate postings, save them to PostgreSQL, and optionally score the first imported matches. Discovery now applies a deterministic relevance filter before import, so weak matches are skipped and imported jobs get an initial fit score, supported keywords, weak areas to strengthen, and a resume angle before any paid OpenAI scoring runs. Remotive works without credentials. Adzuna requires `ADZUNA_APP_ID` and `ADZUNA_APP_KEY`. TheirStack requires `THEIRSTACK_API_KEY` and may consume paid credits. SerpApi requires `SERPAPI_API_KEY` and may consume paid search credits; `SERPAPI_MAX_QUERIES_PER_RUN` caps how many SerpApi searches one discovery run can use. USAJOBS requires `USAJOBS_API_KEY` and `USAJOBS_USER_AGENT`. Workable requires an approved API token.

The generic provider rejects prohibited job-board hosts and checks `robots.txt` before fetching. The app does not directly scrape LinkedIn, Indeed, ZipRecruiter, CareerBuilder, Glassdoor, or similar restricted job boards. Those sources require approved APIs, licensed aggregator APIs, partner feeds, exports, or user-reviewed manual import.

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
- Gmail tokens are encrypted with AES-256-GCM.
- AI endpoints are rate-limited with an in-memory limiter for MVP.
- Audit logs are written for sensitive actions.
- File upload validation is enforced for resume parsing and consented interview audio.

See `SECURITY_NOTES.md`, `COMPLIANCE_NOTES.md`, and `PRODUCT_ROADMAP.md`.
