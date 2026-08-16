# Security Notes

## Implemented MVP Controls

- Auth.js / NextAuth scaffold with Prisma adapter.
- User-owned Prisma queries in API routes.
- Production Google sign-in is private by default through `AUTH_ALLOWED_EMAILS`; public signups require `AUTH_ALLOW_PUBLIC_SIGNUPS=true`.
- Demo-user fallback is gated by `ALLOW_DEMO_USER`, and server-side fallback is disabled automatically in production.
- Profile, jobs, applications, documents, Gmail snippets, interviews, tasks, and files are scoped to the signed-in `userId`; no team/shared workspace model exists yet.
- Users can export their account data and delete account records from profile settings.
- Gmail tokens are encrypted with AES-256-GCM.
- Production resume and document uploads default to database-backed private storage. Local disk storage is intended only for development.
- Consented interview audio can upload directly to a private Vercel Blob store through short-lived, authenticated client-upload tokens. Completion verifies ownership, the private host, interview-specific pathname, content type, and size before saving the CRM record.
- Sensitive actions write audit-log records.
- Structured production logs redact tokens, API keys, passwords, database credentials, and email addresses.
- Health and readiness endpoints are available for uptime monitoring.
- Scheduled job discovery is protected by `CRON_SECRET`, only syncs enabled/configured sources, caps sources per run, skips recently synced sources, and uses a source-level lock to reduce overlapping runs.
- URL-based job-source fetching blocks prohibited job-board hosts, local/private/internal hosts, private DNS resolutions, oversized responses, long-running requests, and unsafe redirects.
- API routes use PostgreSQL-backed rate-limit buckets that are shared across serverless instances.
- Browser capture tokens are random, hashed before storage, scope-limited, revocable, expiring, rate-limited, and never included in account exports.
- The browser extension requests `activeTab` access only after a click and stores its raw token in Chrome session storage rather than long-lived extension storage.
- Paid AI calls use an atomic monthly reservation ledger. The app reserves the maximum registered request cost before provider access, reconciles actual usage afterward, and treats interrupted calls as fully spent until reconciled.
- Paid AI is disabled by `AI_ENABLED=false`; unknown models and missing pricing fail closed. Discovery automation has a separate allowance, duplicate request hashes are claimed atomically, and no provider tools or search grounding are enabled.
- AI usage records capture provider, model, feature, prompt version, token counts, request hash, automation status, reservation, and estimated cost without repeating raw prompt inputs.
- Resume uploads validate file type and size.
- Interview audio upload requires explicit consent confirmation.
- `.env` is ignored and `.env.example` contains no secrets.

## Production Hardening

- Set `ALLOW_DEMO_USER=false`.
- Keep `AUTH_ALLOW_PUBLIC_SIGNUPS=false` for private deployments and populate `AUTH_ALLOWED_EMAILS` with approved users.
- Use a managed PostgreSQL database with encrypted storage and backups.
- Keep server-routed uploads at 4 MB on Vercel. Use authenticated direct private-object uploads for larger files and add malware scanning before accepting uploads from untrusted users.
- Move rate limits to Redis or another low-latency atomic store if database contention becomes measurable at larger scale.
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
- Application answers can be revealed and copied, but the app and extension do not fill or submit employer forms.
- The Answer Vault is for recurring job-application responses, not passwords, government identifiers, identity documents, or financial credentials.
