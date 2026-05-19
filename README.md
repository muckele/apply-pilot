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
- Greenhouse, Lever, Ashby, and generic company-careers provider layer
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

## Job Source Providers

Provider interface: `lib/job-sources/types.ts`.

Implemented:

- `ManualJobImportProvider`
- `GreenhouseProvider`
- `LeverProvider`
- `AshbyProvider`
- `GenericCompanyCareersProvider`

The generic provider rejects prohibited job-board hosts and checks `robots.txt` before fetching. Do not add scraping for LinkedIn, Indeed, ZipRecruiter, Glassdoor, or other sources that prohibit automated access. Use manual paste/bookmarklet import for those workflows.

## What Is Not Automated

- No automatic application submission.
- No automated LinkedIn, Indeed, ZipRecruiter, or similar job-board activity.
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
