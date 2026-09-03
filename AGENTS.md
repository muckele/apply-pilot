# DATABASE SAFETY — MANDATORY

- NEVER run raw `prisma migrate reset` or `npx prisma migrate reset`.
- PostgreSQL reset testing MUST use `npm run test:postgres`; no other reset path is approved.
- NEVER run raw `prisma migrate dev`. Local migration development MUST use `npm run prisma:migrate` with its guarded local-only variables.
- NEVER run `prisma db push`.
- NEVER run seed, fixture, or test mutation against Neon or any other remote PostgreSQL host.
- `DATABASE_URL` alone is NEVER proof of database safety. Prisma also has `DIRECT_URL`; treat both as independently authoritative.
- NEVER assign `TEST_DATABASE_URL` to Neon or use production/remote credentials for test, reset, or seed work.
- Remote schema changes use forward-only `prisma migrate deploy` only after explicit human authorization and endpoint identity verification.
- Production migration credentials must not be stored in repository files.
- Commit 6 PostgreSQL testing MUST continue through the guarded official `npm run test:postgres` runner.

Repository guards protect approved workflows, but they cannot intercept a person or agent that deliberately ignores these rules and directly invokes a Prisma binary with privileged remote credentials.
