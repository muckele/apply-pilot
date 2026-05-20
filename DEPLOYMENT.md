# Deployment Checklist

JobMatch CRM is ready to deploy after these production settings are configured in the hosting provider.

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
- `OPENAI_API_KEY`
- `OPENAI_MODEL`
- `OPENAI_MOCK_MODE=false`
- `GMAIL_REDIRECT_URI`
- `GMAIL_SCOPES`
- `TOKEN_ENCRYPTION_KEY`

Optional provider keys:

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

## Storage

Local `UPLOAD_DIR` is acceptable for development only. Before relying on resume or interview audio uploads in production, use durable storage such as S3, Cloudflare R2, Vercel Blob, or an equivalent provider.

## Runtime

For a single-user MVP, manual discovery from `/jobs` is enough. For scheduled discovery, configure a provider cron job that calls the discovery route with a user-reviewed scope and rate limits.

Replace the in-memory rate limiter with Redis or Upstash before running multiple server instances.

## Logging and monitoring

The app writes structured JSON logs to stdout/stderr with sensitive values redacted. Configure the host to retain and search application logs. Use `LOG_LEVEL=info` in production and `LOG_LEVEL=debug` only during temporary troubleshooting.

Health endpoints:

```text
GET /api/health
GET /api/health/readiness
```

Use `/api/health/readiness` for uptime checks because it verifies database connectivity and returns `503` when the app cannot reach PostgreSQL.

## Pre-deploy validation

Run:

```bash
npm test
npm run lint
npm run typecheck
npm run build
```
