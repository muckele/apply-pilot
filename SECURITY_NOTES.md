# Security Notes

## Implemented MVP Controls

- Auth.js / NextAuth scaffold with Prisma adapter.
- User-owned Prisma queries in API routes.
- Demo-user fallback is gated by `ALLOW_DEMO_USER`; disable it outside local development.
- Gmail tokens are encrypted with AES-256-GCM.
- Sensitive actions write audit-log records.
- AI/import/search routes use a basic in-memory rate limiter.
- Resume uploads validate file type and size.
- Interview audio upload requires explicit consent confirmation.
- `.env` is ignored and `.env.example` contains no secrets.

## Production Hardening

- Set `ALLOW_DEMO_USER=false`.
- Use a managed PostgreSQL database with encrypted storage and backups.
- Store uploads in private object storage with per-user paths and signed URLs.
- Replace the in-memory rate limiter with Redis-backed limits.
- Add CSRF protection to mutation forms if using cookie-based auth outside API fetches.
- Add malware scanning for uploaded files.
- Add stricter MIME sniffing for PDF/DOCX/audio.
- Add centralized authorization helpers for every model.
- Add structured logging and alerting for auth, token, upload, and export events.
- Rotate `TOKEN_ENCRYPTION_KEY` with a planned re-encryption process.

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
