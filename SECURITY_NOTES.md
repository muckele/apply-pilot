# Security Notes

## Implemented MVP Controls

- Auth.js / NextAuth scaffold with Prisma adapter.
- User-owned Prisma queries in API routes.
- Demo-user fallback is gated by `ALLOW_DEMO_USER`; disable it outside local development.
- Gmail tokens are encrypted with AES-256-GCM.
- Production file uploads default to database-backed private storage. Local disk storage is intended only for development.
- Sensitive actions write audit-log records.
- Structured production logs redact tokens, API keys, passwords, database credentials, and email addresses.
- Health and readiness endpoints are available for uptime monitoring.
- Scheduled job discovery is protected by `CRON_SECRET`, only syncs enabled/configured sources, caps sources per run, skips recently synced sources, and uses a source-level lock to reduce overlapping runs.
- URL-based job-source fetching blocks prohibited job-board hosts, local/private/internal hosts, private DNS resolutions, oversized responses, long-running requests, and unsafe redirects.
- AI/import/search routes use a basic in-memory rate limiter.
- Resume uploads validate file type and size.
- Interview audio upload requires explicit consent confirmation.
- `.env` is ignored and `.env.example` contains no secrets.

## Production Hardening

- Set `ALLOW_DEMO_USER=false`.
- Use a managed PostgreSQL database with encrypted storage and backups.
- For larger-scale production, move uploads from database-backed MVP storage to private object storage with per-user paths and signed URLs.
- Replace the in-memory rate limiter with Redis-backed limits.
- Add CSRF protection to mutation forms if using cookie-based auth outside API fetches.
- Add malware scanning for uploaded files.
- Add stricter MIME sniffing for PDF/DOCX/audio.
- Add centralized authorization helpers for every model.
- Wire production logs to the hosting provider or an external alerting system.
- Rotate `TOKEN_ENCRYPTION_KEY` with a planned re-encryption process.
- Use a staging deployment first, then validate Google OAuth callbacks, Gmail readonly connect, job discovery, document export, and mark-applied CRM linking before exposing production traffic.

## Gmail Data Handling

- Request readonly Gmail scope only.
- Do not request send/delete scopes for the MVP.
- Do not persist full email bodies unless the user explicitly saves a message.
- Clear encrypted tokens on disconnect.
- Support deletion of synced Gmail message records.

## AI Safety

- Prompts instruct the model not to invent experience.
- Matching distinguishes supported keywords from missing or risky keywords.
- Resume tailoring warns against unsupported keywords.
- Drafts are saved for user review; they are not sent automatically.
