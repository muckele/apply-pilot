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

<!-- APPLY_PILOT_ROADMAP_REFERENCE_V2_START -->
## Apply Pilot project direction and references

Read `PRODUCT_ROADMAP.md`, `docs/APPLY_PILOT_PROJECT_STATE.md`, and `docs/APPLY_PILOT_DECISIONS.md` before roadmap-sensitive work. Read the relevant specialist brief and `prompts/APPLY_PILOT_MASTER_PROMPT.md` for a fresh architectural task. The state ledger distinguishes planned, implemented, independently reviewed, committed, pushed, merged, deployed, and verified in the intended user flow; historic SHAs are not reset instructions. Its current reference checkpoint is PR #11 (`4644e4f`) and its active milestone is P0.4, not yet passed.

The approved delivery direction is **web-first**: no required Chrome extension for core public value. P2 is **Managed Application Workspace / Browser Copilot**, with provider/architecture validation before real hosted execution. The current local Chromium companion remains the self-beta baseline; extensions/desktop surfaces are optional. Technical Human-Submit acceptance and no-download public-release acceptance are separate gates.

P0 multi-ATS priority is Greenhouse/Lever/Ashby; Workday characterization first. P0.4 genuine intended applications are active, with only necessary P1 intelligence pulled forward. Then complete P1 application intelligence and P2 managed delivery before broad no-download public claims; P3 hybrid assistance, P4 separately granted autonomous submission, and P5 mature outcomes/commercialization follow. The proposed next bounded experiment is `GEMINI_JOB_MATCH_QUALIFICATION`, not a new phase or a provider decision. Measurement starts early. A roadmap is not an execution, spending, live-testing or submission grant.

Current Human-Submit authority stays unchanged: exact target, owner isolation, current approved packet, existing-value preservation, one permanent Fill; only the current six supported types with eligible sources. Contact/source expansion, uploads, frames, custom widgets, login, navigation and submission need separate scope. Agent never activates employer Submit in P0–P2; completion is the user's explicit attestation, not independent receipt.

Hosting is a new trust boundary. Do not expose provider/debug credentials, conflate viewer access with permission, let human/agent writes overlap, retain recording by default, or assume cloud protocol parity. Read `docs/MANAGED_APPLICATION_WORKSPACE.md` and `docs/MANAGED_BROWSER_PROVIDER_EVALUATION.md` before hosted design.

Truth outranks scores. Internal 90+ goals are not employer scores or hiring probabilities. Reuse current tailoring/exports/cost controls; validate facts and actual files independently. Never fabricate qualifications or use synthetic applicants on arbitrary live forms.

Preserve all existing database rules. No raw reset/dev/db-push or remote test mutation. Respect scoped authorization and the latest explicit amendment without bypassing enforced access gates. Use genuine TDD and risk-matched evidence; documentation-only/mechanical tasks do not automatically require a full DB/browser ladder. Never suppress failures or call a failed security export sealed.

Start task prompts with Model / Reasoning / Window. Report actual model/settings availability; a requested Codex label is not a production API ID. Stage/commit/push/merge/deploy only when authorized. Leave work in the requested state and give one next bounded action.
<!-- APPLY_PILOT_ROADMAP_REFERENCE_V2_END -->
