# Deployment Checklist

Apply Pilot is ready to deploy after these production settings are configured in the hosting provider.

## Required production environment variables

Use `.env.production.example` as the source of truth. Configure these in the hosting provider dashboard or CLI, not in Git.

- `DATABASE_URL`
- `DIRECT_URL`
- `AUTH_SECRET`
- `AUTH_URL`
- `NEXTAUTH_URL`
- `APP_BASE_URL`
- `APP_VERSION`
- `LOG_LEVEL=info`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `AUTH_ALLOWED_EMAILS`
- `ALLOW_DEMO_USER=false`
- `APPLICATION_AUTOMATION_ENABLED=false` until the per-user policy and reviewed execution hosts are configured.
- `AI_ENABLED=false` until paid/provider execution is intentionally enabled. Deterministic local output remains available while paid execution is disabled or provider configuration is missing.
- `AI_PROVIDER=gemini` by default. The global provider accepts only `gemini` or `openai`.
- `AI_MOCK_MODE=false` only when live provider execution is intended.
- The server-only key and model variables for each enabled provider. Never expose provider keys through `NEXT_PUBLIC_` variables.
- `GMAIL_REDIRECT_URI`
- `GMAIL_SCOPES`
- `TOKEN_ENCRYPTION_KEY`
- `CRON_SECRET`
- `BLOB_READ_WRITE_TOKEN`
- `JOB_SOURCE_MAX_POSTED_AGE_DAYS`

Optional provider keys:

- `GEMINI_API_KEY`
- `OPENAI_API_KEY`
- `MOONSHOT_API_KEY` when `APPLICATION_PLAN` is explicitly routed to Kimi
- `ADZUNA_APP_ID`
- `ADZUNA_APP_KEY`
- `ADZUNA_COUNTRY`
- `THEIRSTACK_API_KEY`
- `THEIRSTACK_POSTED_MAX_AGE_DAYS`
- `SERPAPI_API_KEY`
- `SERPAPI_MAX_QUERIES_PER_RUN`
- `USAJOBS_API_KEY`
- `USAJOBS_USER_AGENT`
- `WORKABLE_API_TOKEN`

## Database

Use Neon PostgreSQL for production.

1. Set `DATABASE_URL` to the pooled Neon connection string.
2. Set `DIRECT_URL` to the direct Neon connection string.
3. Run migrations in production with:

```bash
npx prisma migrate deploy
```

Do not use `prisma migrate dev` against production.

## Google OAuth

Add these production redirect URIs in Google Cloud Console after the production domain is known:

```text
https://your-production-domain.com/api/auth/callback/google
https://your-production-domain.com/api/gmail/callback
```

Keep Gmail access readonly. The app should remain human-in-the-loop: no automatic email sending, no deletion, and no hidden data capture.

## Controlled application automation

Start every environment fail-closed with:

```env
APPLICATION_AUTOMATION_ENABLED="false"
```

Only exact lowercase `true` enables capability-increasing controlled application operations. Enabling the global flag does not override a user's disabled `ApplicationAutomationPolicy`; configure and inspect that policy and its reviewed execution hosts first. Environment changes must reach every runtime instance, and instances must be restarted or redeployed when the hosting platform does not apply environment changes to already-running processes.

`AI_ENABLED` is a separate paid/provider execution switch. It is not the controlled-application emergency stop. When paid execution is disabled, mocked, or missing usable provider credentials, current planning can use deterministic local behavior.

Global `AI_PROVIDER` defaults to `gemini` and accepts only `gemini` or `openai`. Kimi is not a valid global provider. Kimi can be selected for advisory application planning through a feature override:

```env
AI_PROVIDER_OVERRIDES="APPLICATION_PLAN:kimi"
```

`APPLICATION_PLAN` is currently the only override-eligible feature, but its override slot can select any registered provider; it is not intrinsically Kimi-only. Kimi uses the server-side `MOONSHOT_API_KEY`, `KIMI_MODEL`, and `KIMI_REASONING_EFFORT` settings. Keep the complete provider and evaluation reference in [README.md](README.md) and the controlled-execution invariants in [docs/CONTROLLED_APPLICATION_AUTOMATION.md](docs/CONTROLLED_APPLICATION_AUTOMATION.md).

### Emergency stop

1. Set `APPLICATION_AUTOMATION_ENABLED=false` in the hosting environment.
2. Apply the change consistently and restart or redeploy every runtime instance.
3. Verify that preparation, execution-token issuance, and credential authorization/consumption are paused. Policy reads/updates, cancellation, review, answer review, and revocation remain available for recovery.

The global stop does not itself write `revokedAt`. An otherwise-live token can become usable again after re-enablement, although a preparation run already persisted as `BLOCKED` is not automatically resumed. For durable invalidation, use a real persisted action such as a policy change, run cancellation, token replacement, or explicit token revocation. The current `APPLICATION_READ` lifetime is a fixed 15-minute code invariant, not an environment setting.

## Storage

Use `FILE_STORAGE_DRIVER=database` for private resume and document storage in the MVP. Keep `MAX_UPLOAD_MB=4` and `MAX_AUDIO_UPLOAD_MB=4` because files sent through Vercel Functions are subject to the platform request-body limit.

Create a **Private** Vercel Blob store connected to the project and expose its generated `BLOB_READ_WRITE_TOKEN` to Production. With that token present, consented interview audio uploads directly from the browser to the private store, bypassing the function body limit. `MAX_DIRECT_AUDIO_UPLOAD_MB=25` controls that path. Upload-token issuance verifies authentication, interview ownership, consent, file type, size, and the interview-specific pathname; completion re-verifies Blob metadata before adding the recording to the CRM.

## Runtime

For a single-user MVP, manual discovery from `/jobs` is enough. For scheduled discovery, configure a provider cron job that calls the protected discovery route:

```text
GET https://your-production-domain.com/api/cron/job-discovery
Authorization: Bearer <CRON_SECRET>
```

The route syncs enabled job sources only. It imports and filters postings; it does not apply to jobs, send email, or automate job-board activity.

The included `vercel.json` schedules this route daily at 14:00 UTC. Vercel automatically sends the configured `CRON_SECRET` as a bearer token. Change the schedule deliberately if provider credit limits or search cadence require it.

The MVP uses PostgreSQL-backed rate-limit buckets across instances. Move them to Redis or Upstash when traffic justifies reducing database writes.

## Logging and monitoring

The app writes structured JSON logs to stdout/stderr with sensitive values redacted. Configure the host to retain and search application logs. Use `LOG_LEVEL=info` in production and `LOG_LEVEL=debug` only during temporary troubleshooting.

Health endpoints:

```text
GET /api/health
GET /api/health/readiness
```

Use `/api/health/readiness` for uptime checks because it verifies database connectivity and returns `503` when the app cannot reach PostgreSQL.
It also validates the production Auth.js URLs, Gmail callback, private sign-in configuration, encryption key, cron secret, and Vercel function upload limits. AI-provider and private Blob storage are reported as capabilities rather than required launch dependencies.

## Pre-deploy validation

Run:

```bash
npm test
npm run lint
npm run typecheck
npm run build
```
