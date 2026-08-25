# Controlled Application Automation

Canonical developer and operator reference for Apply Pilot's current controlled application automation capability. Runtime source and the Prisma schema remain authoritative if this document ever drifts. Branch positions and local commit hashes are operational context, not product invariants.

## Current status

The authenticated backend foundation for controlled application preparation exists. It includes per-user policy, preparation, deterministic review, cancellation, execution-token, audit, application-timeline, and PostgreSQL concurrency controls.

The current capability is deliberately narrow:

- `PREPARE_ONLY` is the only `AutomationMode`.
- `APPLICATION_READ` is the only execution-token scope that can be issued.
- The per-user policy has an authenticated API at `/api/application-automation-policy`; there is no user-facing policy-management UI.
- Preparation produces an evidence-grounded advisory plan and review state. It does not inspect or operate an employer form.
- Browser/form execution and application submission are not implemented.

This is not a completed Human-Submit workflow. Forward-compatible schema names do not make future execution behavior operational.

## Safety boundaries and current non-goals

Application planning must remain grounded in candidate evidence. Unknown evidence references are removed, unsupported requirements become gaps, and the planner is not allowed to fabricate candidate claims.

The current system has:

- no CAPTCHA bypass;
- no anti-bot evasion;
- no automation against statically restricted job boards;
- no employer application-form inspection;
- no live-form answer packet;
- no browser form fill;
- no Greenhouse application-form adapter;
- no generic ATS application-form adapter;
- no automated application submission or auto-submit; and
- no current replacement for a human submit action.

The existing Greenhouse integration under `lib/job-sources/greenhouse.ts` is for job discovery. A future Greenhouse application-form adapter would be a separate capability requiring its own design, safety review, and implementation.

The manual browser capture extension is also separate. It performs a user-initiated, review-before-save capture workflow with its own credentials; it does not execute an ApplicationRun, fill a form, or submit an application.

## Control planes

These controls are independent and must not be conflated:

| Control | Purpose | Current behavior |
| --- | --- | --- |
| `APPLICATION_AUTOMATION_ENABLED` | Global controlled-application emergency stop | Only exact lowercase `true` permits capability-increasing automation. |
| `ApplicationAutomationPolicy.enabled` | Per-user capability gate | The global switch cannot override a disabled user policy. Both must permit capability. |
| `AI_ENABLED` | Paid/provider execution switch | Exact `true` permits configured provider calls. When false, mocked, or missing usable provider credentials, deterministic local planning can still occur. |
| Compile-time/internal constants | Fixed safety invariants | READ-token TTL, preparation lease duration, and daily-cap window are code-defined rather than environment knobs. |

## Global automation emergency stop

The parser is an exact comparison:

```ts
env.APPLICATION_AUTOMATION_ENABLED === "true"
```

Only exact lowercase `"true"` enables the global capability. Missing values, `"false"`, `"TRUE"`, `"1"`, whitespace-padded variants, and every other value fail closed.

### Operation matrix while disabled

| Operation | Behavior |
| --- | --- |
| DRAFT run creation | Allowed because the run is inert. Normal ownership, safe-target, idempotency, and active-run constraints still apply. |
| Preparation acquisition | Capability is not acquired. An otherwise acquirable run is recorded `BLOCKED` with `automation_disabled`; a conflicting live preparation owner retains precedence. |
| In-flight provider/local planning | If the attempt remains authoritative at TX2, its output is discarded and the run is recorded `BLOCKED` with `automation_disabled_during_preparation`. A stale or cancelled fence is resolved first. |
| Execution-token issuance | Blocked before a new credential is created. |
| Reusable authorization | Input structure and expected binding are validated first; the global stop is then enforced before clock access, hashing, `lastUsedAt`, or any capability-side database mutation. |
| Single-use consumption | The same global-stop principle applies before hashing or capability-side database mutation. An internal atomic primitive exists, but no public issuance path currently creates a single-use execution token. |
| Policy GET/PATCH | Available so operators and users can inspect or manage policy while the global capability remains paused. |
| Cancellation | Available, including its internal run-token invalidation. |
| Review resolution and answer review | Available, subject to their normal state, version, reason, and ownership checks. |
| Individual token revocation | Available and idempotent. |
| Run-wide/user-wide revocation | Internal transactional helpers remain available to operations such as cancellation and real policy changes. They are not standalone public bulk endpoints. |

### Global pause versus durable invalidation

Turning `APPLICATION_AUTOMATION_ENABLED` off does not itself set `revokedAt`. It is an operational pause: an otherwise-live token can become usable again if the switch is restored before the token expires.

Re-enablement does not rewind persistent run state. An authoritative preparation attempt changed to `BLOCKED` while the switch was off does not simply resume; a later request must satisfy the normal preparation rules.

Durable invalidation is a persisted action. Current examples include:

- a real policy change, which revokes currently usable user execution credentials;
- run cancellation, which revokes currently usable run-bound credentials;
- replacement issuance, which revokes equivalent predecessors; and
- explicit individual token revocation.

Those persisted changes remain effective after global re-enablement.

## Application automation policy reference

`lib/application-runs/policy.ts` mirrors the Prisma defaults and defines strict PATCH validation.

| Field | Default | PATCH validation | Current effect |
| --- | --- | --- | --- |
| `enabled` | `false` | Boolean | Per-user half of the capability gate. |
| `mode` | `PREPARE_ONLY` | `PREPARE_ONLY` only | Persisted and snapshotted. There is no alternate current execution mode. |
| `minimumFitScore` | `85` | Integer from 0 through 100 | Required before preparation planning begins. |
| `minimumConfidenceScore` | `85` | Integer from 0 through 100 | Applied to existing match confidence before planning and to deterministic review reasoning after planning. |
| `dailyApplicationCap` | `5` | Integer from 0 through 25 | Rolling 24-hour cap on first successful preparation acquisitions. |
| `allowedHosts` | `[]` | At most 50 canonical hostname entries; each input entry is at most 253 characters | Applied at token issuance. Empty denies every execution-token host. It is not a preparation allowlist. |
| `blockedHosts` | `[]` | At most 50 canonical hostname entries; each input entry is at most 253 characters | Applied during preparation and issuance. Blocking wins. |
| `permittedAdapters` | `[]` | At most 25 values matching `[a-z0-9-]{1,64}` | Persisted and snapshotted; no executable form-adapter path exists today. |
| `coverLetterRequired` | `true` | Boolean | Preparation requires a selectable cover letter when true. |
| `sensitiveAnswerPolicy` | `EXCLUDE` | `EXCLUDE` only | Persisted and snapshotted; no live-form answer generation exists today. |
| `finalReviewRequired` | `true` | Only `true` is accepted | Persisted, snapshotted, and cannot be disabled. Current successful state is driven by deterministic review reasons, not by a generic always-`REVIEW_REQUIRED` branch. |

### Missing policy and PATCH lifecycle

Policy reads and writes intentionally distinguish virtual defaults, first persistence, no-op updates, and real changes:

- GET with no stored policy returns virtual defaults with `persisted: false`. It creates no row or audit record and performs no write.
- Empty `{}` PATCH is a read-only no-op and does not persist a missing policy.
- Every non-empty PATCH locks the owning User `FOR NO KEY UPDATE`, ensures the policy row, then locks the policy row `FOR UPDATE`.
- A first non-empty PATCH equal to all defaults persists the policy, creates the policy-create audit record, reports `changed: false`, and revokes no token.
- A no-op PATCH against an existing row performs no row update, causes no `updatedAt` churn, creates no policy-update audit, and revokes no token.
- A real policy change updates the row, revokes currently usable user execution credentials, and writes audit information in the same transaction. The usable-token predicate excludes expired or already-revoked rows and consumed single-use rows; reusable rows follow their reusable liveness rule.

Preparation has a separate missing-policy ensure path. It locks the owning User, creates and audits the missing default policy, and commits that ensure transaction. Normal preparation TX1 later uses policy-to-run locking. The ensure transaction does not explicitly relock the newly created policy row after creation.

## Host policy

Policy entries are hostnames, not URLs. Canonical validation rejects:

- schemes;
- wildcard syntax;
- user information;
- ports;
- paths, queries, and fragments;
- IP literals;
- localhost and private/local targets; and
- malformed or single-label hostnames.

Execution targets are absolute HTTPS URLs. Relative targets, non-HTTPS schemes, user information, IP literals, and local/private targets fail closed.

Matching is exact-host or DNS-label-boundary subdomain matching. An entry for `example.test` can match that host or a subdomain such as `careers.example.test`; it does not match a mere string suffix such as `notexample.test`.

`blockedHosts` always wins over `allowedHosts`. The static restricted-board policy also always wins; maintainers must consult `lib/security/restricted-hosts.ts` rather than treating a copied prose list as authoritative.

Preparation enforces safe targets, configured blocks, and the static restricted-board policy, but it does not require membership in `allowedHosts`. Token issuance performs the execution allowlist check, and an empty `allowedHosts` list denies issuance for every host.

## Current and future modes, scopes, and states

| Kind | Name | Status |
| --- | --- | --- |
| Automation mode | `PREPARE_ONLY` | Current and the only schema value. |
| Roadmap mode | `FILL_AND_REVIEW` | Future prose only; not a current schema value or selectable mode. |
| Roadmap mode | `AUTO_SUBMIT_ALLOWLISTED` | Future prose only; not a current schema value or selectable mode. Auto-submit is not implemented. |
| Execution scope | `APPLICATION_READ` | Current schema value and the only issuable scope. |
| Execution scope | `APPLICATION_FILL` | Reserved schema value with no current issuance or form-execution path. |
| Execution scope | `APPLICATION_EVENT_WRITE` | Reserved schema value with no current issuance or event-write execution path. |
| Submit scope | None | No submit scope exists. |
| Run state | `DRAFT`, `PREPARING`, `READY`, `REVIEW_REQUIRED`, `BLOCKED`, `FAILED`, `CANCELLED` | Used by the current preparation/review/cancellation lifecycle. |
| Forward-compatible run state | `FILLING`, `READY_FOR_USER_SUBMISSION`, `COMPLETED_BY_USER` | Present in the schema but without current inbound automation transitions; not operational. |

There is no `SUBMITTING` or `SUBMITTED` state.

## Execution tokens

Application execution tokens are run-scoped, canonical-host-bound credentials. They do not themselves add a fill or submit capability.

Current invariants:

- The raw format is the `aet_` prefix followed by 43 base64url characters.
- Generation uses 32 cryptographically secure random bytes, providing 256 bits of secret material.
- The raw credential is never persisted. The database stores its SHA-256 hash and a display-only prefix.
- The raw credential is returned to the caller only after the issuance transaction completes successfully.
- Audit metadata contains neither the raw credential nor its hash.
- Only `APPLICATION_READ` can be issued.
- `APPLICATION_READ` can be issued only for a run in `READY` or `REVIEW_REQUIRED`.
- Its TTL is exactly 15 minutes. This is a compile-time constant, not an environment setting.
- Current issued READ tokens have `singleUse: false`.
- Reusable authorization atomically validates the full hash/user/run/host/scope/liveness binding and updates `lastUsedAt`; it does not set `consumedAt`.
- An atomic single-use consumption primitive exists internally, but no current public issuance path creates a single-use token.

Replacement is serialized on the locked run. Its exact slot is user, run, canonical host, scope, and `singleUse`. Issuing a replacement revokes every equivalent predecessor that is not already consumed or revoked, including an already-expired predecessor, and retains all rows for history rather than deleting them.

Individual revocation is public, ownership-scoped, durable, and idempotent. Run-wide and user-wide revocation are internal transactional effects used by cancellation and real policy changes, not standalone documented public APIs.

These controlled-execution credentials are separate from the browser capture extension's credentials, scopes, routes, and storage model.

## Preparation lifecycle

Preparation uses these fixed invariants:

- `PREPARE_LEASE_MS` is 600,000 milliseconds, exactly 10 minutes.
- `DAILY_CAP_WINDOW_MS` is a rolling 24-hour window.
- `dailyApplicationCap` defaults to 5.
- The first successful acquisition for a run sets `firstPreparingAt` and consumes one cap slot.
- Retry or reclaim of a run that already has `firstPreparingAt` consumes no additional slot.
- Provider or planner failure does not refund the original slot.
- A live `PREPARING` lease cannot be stolen.
- An expired or missing lease can be reclaimed with a fresh attempt ID and lease.

The stable sequence is:

1. Ensure a missing policy if necessary.
2. Run TX1.
3. Execute provider or deterministic local planning outside an interactive database transaction.
4. Run TX2.

TX1 locks policy then run, rereads both authoritatively, classifies lease/acquisition state, evaluates current enablement and preparation gates, checks the rolling cap for a first acquisition, and records attempt/lease ownership. Preparation checks configured/static blocks but does not require the execution allowlist.

TX2 also locks policy then run. It verifies the authoritative completion fence, rechecks the current global and per-user enable switches, and either persists the successful plan or records the controlled-disable result. It preserves the TX1 policy/content snapshot and does not rerun every original policy gate.

The authoritative completion fence conceptually requires all of:

- state `PREPARING`;
- the exact `prepareAttemptId`; and
- the acquired `stateVersion`.

The failure finalizer locks only the run and uses the same attempt fence. Cancellation or another authoritative state/version change makes the old attempt stale. If automation becomes disabled during provider work, an attempt that is still authoritative discards its result and becomes `BLOCKED` with `automation_disabled_during_preparation`; a stale or cancelled fence is resolved before any kill-switch overwrite.

Successful preparation ends in `READY` or `REVIEW_REQUIRED` according to deterministic review reasons. `finalReviewRequired` does not currently replace that reason-based decision with an unconditional review transition.

## Concurrency invariants

Stable lock ordering is deliberately narrow:

| Operation | Lock order |
| --- | --- |
| Non-empty policy PATCH | User → policy |
| Preparation TX1/TX2 | Policy → run |
| Execution-token issuance | Policy → run |
| Cancellation | Run |
| Review resolution | Run |
| Answer review | Run → answer |
| Preparation failure finalization | Run |

Real PostgreSQL 16 tests at `READ COMMITTED` protect policy first-persistence behavior, preparation lease/fence/cap ownership, lifecycle cancellation/review races, execution-token replacement/authorization/revocation, and stable lock ordering. Test-only barriers and instrumentation are not runtime features.

## Audit log versus application timeline

`AuditLog` is the security and operational record for policy, token, and sensitive lifecycle actions. Representative examples include policy creation/change, preparation acquisition/completion, cancellation, and token issuance/revocation.

`ApplicationEvent` is the application-facing timeline for major run lifecycle events attached to the owning Application. Representative examples include run creation, preparation blocked/ready/review-required, review resolution, and cancellation.

The source action names and event titles are authoritative; this document intentionally does not duplicate a complete catalog.

## Evidence-bound planning and provider routing

External job titles, company data, description digests, and requirements are untrusted data, never instructions. Job content may contain embedded instructions, but those instructions must never be followed or override the application-planning contract.

Application planning builds bounded job-requirement and candidate-evidence catalogs locally. The provider references catalog IDs, while human-readable requirement and evidence text is hydrated from those catalogs. Unknown IDs are discarded, do-not-exaggerate controls are enforced, unsupported requirements become explicit gaps, and provider reasoning content is not persisted.

Planner payloads intentionally exclude contact details, raw resume text, file data or paths, Answer Vault content, cookies, browser/session state, hidden page content, and sensitive demographic, disability, veteran, criminal-history, or work-authorization data. Plans remain advisory: the planner cannot invoke tools, execute code, fill forms, send messages, or submit applications.

Provider controls are fail-closed:

- Global `AI_PROVIDER` defaults to `gemini` and accepts only `gemini` or `openai`.
- `AI_PROVIDER=kimi` is invalid and fails with `AI_PROVIDER_UNKNOWN`.
- `AI_PROVIDER_OVERRIDES` currently allows only the `APPLICATION_PLAN` feature to be overridden.
- The `APPLICATION_PLAN` slot can select any registered provider. Kimi is reached through an override such as `APPLICATION_PLAN:kimi`; the slot is not intrinsically Kimi-only.
- Malformed overrides, duplicate features, ineligible features, and unknown providers fail closed.
- Kimi uses `MOONSHOT_API_KEY`, `KIMI_MODEL` (default `kimi-k3`), and `KIMI_REASONING_EFFORT` (`low`, `high`, or `max`). Its endpoint is fixed in code.
- `AI_ENABLED=false`, provider mock mode, or missing usable provider credentials selects deterministic local behavior instead of disabling preparation itself.

### Planning evaluation

The evaluation runner is `npm run ai:evaluate`.

- `AI_EVAL_PLAN_TOP` defaults to `0`, so no planning case is selected for a live evaluation by default.
- `KIMI_EVAL_MODE` defaults to `synthetic`; accepted values are `synthetic`, `sanitized`, and `real`.
- Real-data planning additionally requires exact `KIMI_EVAL_DATA_ACKNOWLEDGED=true` and is an explicit operator decision to send the privacy-minimized payload to Moonshot.
- Evaluation reports write under the gitignored `evaluation-results/` directory.

## PostgreSQL concurrency tests

Docker with Compose support is required. The local harness uses PostgreSQL 16, binds only to loopback, uses the exact disposable database `apply_pilot_commit5_test`, and currently stores the database directory on `tmpfs`.

Start the disposable database:

```bash
docker compose -f compose.postgres-test.yml up -d --wait
```

Run the guarded real-PostgreSQL suite with the minimum caller-required environment:

```bash
COMMIT5_POSTGRES_TEST=1 \
TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55432/apply_pilot_commit5_test?schema=public' \
npm run test:postgres
```

The caller does not need to add `NODE_ENV=test` or `APPLICATION_AUTOMATION_ENABLED=true`. The runner establishes its safe child environment, and individual scenarios provide the automation environment they require.

Stop and remove disposable Compose storage:

```bash
docker compose -f compose.postgres-test.yml down --volumes
```

Although database storage is currently `tmpfs`, `--volumes` preserves the disposable contract if Compose-scoped volumes are introduced later.

### Destructive-reset safety gate

Before any migration reset, the runner requires and verifies:

- `COMMIT5_POSTGRES_TEST` exactly equals `"1"`;
- an explicit `TEST_DATABASE_URL`, with no `DATABASE_URL` or `DIRECT_URL` fallback;
- a PostgreSQL protocol;
- a loopback host;
- the database name exactly equals `apply_pilot_commit5_test`;
- no query parameter other than an optional single `schema=public`;
- the live database identity;
- `READ COMMITTED` transaction isolation; and
- PostgreSQL major version 16.

Only after validation does the runner invoke `prisma migrate reset --force --skip-seed`, discover `tests/postgres/*.test.ts`, and run those files serially. Never point this command at a development, staging, production, or otherwise valuable database, and never bypass its acknowledgement or identity checks.

### `npm test` versus `npm run test:postgres`

`npm test` runs the top-level offline `tests/*.test.ts` suite. That includes static tests for the PostgreSQL runner's safety validator, but it does not execute the nested real-database scenarios under `tests/postgres/`.

`npm run test:postgres` enters the guarded runner, performs the validated disposable migration reset, and executes the nested PostgreSQL concurrency/isolation suite.

### CI coverage

CI has a separate PostgreSQL concurrency job using Node.js 24 and PostgreSQL 16. It uses a disposable database, disables or mocks provider execution, verifies live database identity and `READ COMMITTED`, resets migrations through the guarded runner, and exercises real concurrency and isolation regressions.

## Operator checklist

- Deploy with `APPLICATION_AUTOMATION_ENABLED=false`.
- Configure and inspect each intended user's automation policy.
- Configure reviewed execution hosts before token issuance.
- Enable the global capability only when controlled preparation is intended.
- For an emergency pause, set the global flag false and ensure every runtime instance receives the environment change and restarts or redeploys.
- Remember that the global pause is not persistent revocation.
- Use real policy changes, cancellation, replacement, or explicit revocation when durable invalidation is required.
- Keep AI provider credentials server-only.
- Keep browser form operation and submission unavailable; those capabilities do not exist today.

## Roadmap-only work

The following work remains parked and must not be inferred from current schema placeholders:

- `FILL_AND_REVIEW`: future browser-assisted form review with explicit human control;
- ATS application-form adapters, each requiring individual review and terms-of-service analysis;
- a durable worker for persisted retry-safe execution; and
- `AUTO_SUBMIT_ALLOWLISTED`, which is not implemented and is not a current `AutomationMode`.

No executable employer-form submission path currently exists.
