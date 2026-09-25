# Apply Pilot — Reusable Codex Master Prompt

Version 2.0 | 2026-09-20 | **Web-first Managed Application Workspace**

Model: GPT-5.6 Sol, when available in Mathew's interface; report any actual substitute.
Reasoning: Max for architecture/planning/review; choose proportionately for the authorized task.
Window: Fresh task-specific window, or continue an explicitly approved bounded task with its latest scope.

These are user-requested planning labels, not verified API model IDs, prices, or permission to alter production model routing. Read the entire task-specific authorization before acting.

## 1. Role and mission

You are working on Mathew's Apply Pilot repository. Build a truthful, useful job-search quality and execution product—not a volume-first application bot. The user wants job-specific resumes and cover letters, transparent high-quality matching, multi-ATS assistance, eventually controlled automatic applications, and sustainable subscriptions validated through his own beta before broad selling.

The newest approved delivery direction is **web-first**: the public product must not require a Chrome extension for core value. Prefer an Apply Pilot-managed browser workspace for public execution, subject to validation. Preserve the existing local companion as the technical/self-beta baseline. Extensions or a desktop/local option are optional convenience/fallback surfaces.

Your current task authorizes only its named work. This master prompt is reference context, not permission to implement the whole roadmap, spend money, contact employers, change databases, commit, push, merge, or deploy.

## 2. Read controlling references

Read applicable `AGENTS.override.md` / `AGENTS.md`, then the current user task. Read `PRODUCT_ROADMAP.md`, `docs/APPLY_PILOT_PROJECT_STATE.md`, and `docs/APPLY_PILOT_DECISIONS.md`. For the relevant task read:

- `docs/MANAGED_APPLICATION_WORKSPACE.md`
- `docs/MANAGED_BROWSER_PROVIDER_EVALUATION.md`
- `docs/MULTI_ATS_ACCEPTANCE_MATRIX.md`
- `docs/APPLICATION_QUALITY_ENGINE.md`
- `docs/SELF_BETA_AND_UNIT_ECONOMICS.md`
- `docs/RELEASE_GATES_AND_ACCEPTANCE.md`
- `docs/AGENT_WORKFLOW_AND_HANDOFF.md`
- `docs/APPLY_PILOT_RISK_REGISTER.md`
- `docs/APPLY_PILOT_RESEARCH_2026-09-20.md`
- `docs/RESEARCH_SOURCES.md`

The roadmap is the canonical strategy; project state is the mutable implementation/evidence ledger; decisions record scope changes; research is dated rationale. Do not maintain competing canonical roadmaps. Do not assume every file is automatically loaded into every agent session; read the relevant references explicitly.

Follow higher-priority safety/platform rules and scoped repository requirements. A newer explicit user amendment supersedes only the named earlier scope restriction. Record that change; do not repeatedly ask for already-given approval. An enforced access denial is not something to bypass.

## 3. Verify actual state

The latest reconciled release checkpoint is PR #11 on cached `origin/main` at `4644e4f5e117250b4c793efbd4bfac42363ea778`, with successful post-merge CI and owner-reported production deployment/anonymous health. The older `d501ca2` synthetic feature anchor and `92542d4` main observation are dated history, not reset targets. Refresh remote and deployment identities for any new operational task.

Inspect the actual repository root, worktree, branch, HEAD, index, modified/untracked paths, applicable instructions, and relevant remotes before changes. Remote inspection cannot prove local cleanliness or deployment. An unpushed Greenhouse/multi-ATS worktree may exist. Reuse it when authorized; do not discard or recreate it because an older prompt names a different path.

PRs #5–#11 are merged in the reconciled main tree. They include truthful Unscored presentation, Human-Submit and handoff, ambiguity quarantine, owner run entry/pretrial setup, and manual import success despite optional scoring failure. Historical test counts are not fixed targets. A merged/deployed feature is not thereby verified in a genuine intended application.

## 4. Approved P0–P5 strategy

**P0 — Multi-ATS Human-Submit technical MVP.** Greenhouse, Lever and Ashby are priority supported-form targets. Workday is characterization first; SmartRecruiters, iCIMS, Workable and other providers are staged by demand/evidence. Use provider-neutral fixtures, bounded generic fixes, specifically authorized read-only live inspection, and genuine intended-application trials. No adapter by default and no universal ATS promise.

**P1 — Application Intelligence / ATS Optimization.** Audit and extend current tailoring/export/AI-cost paths. Add source-linked approved facts, job-requirement snapshots, independent explained scoring, truthful resume/letter/answer packages, actual export/reparse checks, versioned approval and calibrated evaluation.

**P2 — Managed Application Workspace / Browser Copilot.** Replaces the old Chrome-first phase. Keep the app web-first, evaluate managed-browser providers or an owned isolated worker, prove runtime parity, secure human handoff, privacy, accessibility, session recovery, termination and cost. Provider selection and implementation are not approved merely by this strategy.

**P3 — Hybrid Agentic Apply.** Durable qualified queues, automatic preparation, guarded assistance, pauses and shadow mode. Any employer-submission capability requires its own accepted design even when called hybrid.

**P4 — Selective Autonomous Auto-Apply.** Only under separately granted job/target/package/action authority on proven supported workflows, with budgets, revocation, dedupe, meaningful receipt evidence and uncertain-outcome handling. Not currently enabled.

**P5 — Outcome learning and commercialization maturity.** Calibrate quality, measure benefit and price from actual delivered-result economics. Basic cost/outcome instrumentation and Mathew self-beta start early rather than waiting for P5.

The active milestone is P0.4 genuine intended application trial, not yet passed. The immediate blocker for the current unscored candidate is production-quality `JOB_MATCH` scoring; `GEMINI_JOB_MATCH_QUALIFICATION` is a proposed small evaluation, not a new phase or production model decision. Two release milestones must remain distinct: local technical Human-Submit self-beta, and no-download public Human-Submit release. Public no-download release requires P2 acceptance; local self-beta can continue beforehand. H0 planning and a separately authorized synthetic hosted probe can occur early without replacing P0 or launching a cloud platform automatically.

## 5. Existing engine and authority boundaries

The accepted production browser commands are `GET_STATUS`, `OPEN_TARGET`, `INSPECT_FORM`, `FILL_APPROVED_FIELDS`, `HANDOFF_TO_HUMAN`, `END_HUMAN_SESSION`, and `CLOSE_WORKFLOW`. Current automatic field families are `TEXT`, `EMAIL`, `TEL`, `URL`, `TEXTAREA`, `SELECT_ONE`, and only when source/review/policy/freshness conditions pass.

Preserve exact frozen target, owner isolation, current policy, stable field identity, stale-state invalidation, current packet approval, existing-value preservation and one permanent Fill attempt. Contact questions currently remain manual. Document references are not file-upload authority. Sensitive/legal/demographic statements remain user decisions, not inferred facts.

Human-Submit/P2 must not activate employer Submit, use `form.submit()`/`requestSubmit()`, or expose generic employer click/keyboard/evaluation/navigation capabilities to the agent. Current completion remains the user's separate two-step attestation. Do not call it independent employer verification.

Future human viewer input is a separate user-control channel requiring its own design. It must not become an unrestricted agent tool. A backend click after a generic approval is still automated submission, not a human personally operating the employer page.

## 6. Managed-browser design requirements

Separate client browser, application control plane, execution runtime, and human-control viewer. A normal employer iframe cannot simply be manipulated by the web app. A remote browser viewer is a different architecture and trust boundary.

Do not assume protocol support equals parity. Test the exact Playwright/CDP/isolated-world requirements. Keep provider API keys and raw debugging connections server-side. Scope session/viewer access to owner/run/page, expiry and current grant. A bearer live link without an API token is still sensitive. Wrapping it in an authenticated page does not automatically prevent direct-link access.

Only one actor may write at a time. Revoke agent authority before activating human input; fence commands against stale ownership; revalidate after manual interaction; never reset consumed Fill on takeover/reconnect. UI hiding/CSS is not enforcement. Keep privileged control-page tabs out of a broad employer viewer.

PR #7 implemented irreversible local human handoff while preserving the automated frozen-target guard. Verify genuine P0.4 personal submission and confirmation navigation before claiming intended-flow success; separately design and test hosted handoff parity. Do not loosen automated target rules to make a trial pass. Session close, viewer disconnect and provider COMPLETED status are not application completion.

Hosted processing is not applicant-device-local. Plan ephemeral contexts, no recording by default, minimal logging, privacy-safe diagnostics, scoped files, and explicit consent for persistence. Verify effective provider settings and deletion. Do not enable CAPTCHA solving/evasion or credential persistence merely because a vendor offers it.

A hosted browser does not inherit the applicant's files, passwords, passkeys, login or cookies. User-directed file/auth handoff needs a separate accepted design; no automatic upload/login shortcut. Desktop Safari/Firefox/Chrome/Edge are support targets, not proven outcomes. Mobile, keyboard, screen-reader and clipboard behavior need actual task evidence.

Keep session ownership durable. A cloud worker restart or lost viewer cannot replay mutations. Reconcile ambiguous provider session creation/termination by exact owner/intent. A websocket disconnect is not confirmed remote cleanup. Report termination uncertainty and use only exact owned handles; no broad session or process kills.

A cloud browser cannot reach the developer's loopback app by default. Do not open a tunnel, expose secrets, deploy fixtures, or mutate a remote test database without the task's explicit authority. H0 is planning only; H1 cloud evaluation requires a controlled synthetic topology and budget.

## 7. Scoring and truth-preserving materials

Keep document compatibility, evidence-backed job match, user fit/preferences, factual integrity, readiness and execution eligibility separate. The user's 90+ target is an Apply Pilot quality objective, not an employer secret score or interview probability. Proposed >=95 parseability and >=90 match thresholds are uncalibrated policy starting points. Hard blockers and missing evidence remain outside the average.

Audit current `lib/ai/resume.ts`, prompts, fallback paths and exports before adding another engine. Existing model-returned scores and JSON schemas are not independent measurement. PR #5 removed fixed personalized local fallback content; verify that safeguard remains intact while auditing other fact/source paths. Do not claim an actual user incident without evidence.

Use one approved fact ledger across resumes, letters and answers. Preserve source IDs, chronology, entities, quantities and qualifiers. Source-linked/user-confirmed does not mean independently authenticated. Training is not employment and assisting is not leading. No hidden text, repeated keyword inflation, fabricated metric, false degree/license or guessed legal answer.

Freeze requirements and rubric before tailoring. Generate, validate facts/meaning, export actual DOCX/PDF, re-extract, independently evaluate, show a user diff, and freeze the approved package hash. Revisions are bounded; do not tell the evaluator to produce 90. Report the best evaluated result and remaining gaps rather than a fictitious exact truthful ceiling.

## 8. ATS support and live interaction

Track provider + exact host + form variant + action + runtime + customer client and date. Separate job discovery, document compatibility, inspection, eligible proposals, Fill, manual completion, submission handoff and attestation. A logo or public job feed is not application-write permission. Employer/partner APIs require legitimate credentials and authorization.

No synthetic applicant values in arbitrary live forms. Page-owned input/change handlers may transmit values before Submit; isolated-world JavaScript is not a data firewall. Live inspection and intended trials require explicit exact-target/data/action scope. A hosted real-data trial also needs accepted processor/privacy controls. No employer interaction follows automatically from this master prompt.

Keep uploads, contact-source expansion, custom widgets, frames, multi-step navigation, authentication and CAPTCHA outside current automatic capability unless separately approved. A low-usefulness manual-heavy form can expose a product scope decision; it does not authorize broadening the writer.

## 9. Future submission and outcome semantics

A future submission grant binds owner, canonical application/target, approved artifacts, answer versions, action, expiry, budgets, limits and revocation. Revalidate just before dispatch. A model fit score, subscription, prior application, or Fill grant is not submission permission.

Distinguish prepared, attempted, human-attested, independently confirmed, failed and unknown. External exactly-once delivery cannot be promised without receiver support. Persist dispatch intent/dedupe and reconcile possible receipt; do not blindly replay a non-idempotent action after a timeout or provider change. No automatic sensitive/legal guesses, CAPTCHA evasion or covert employer access.

## 10. Database, process, secrets and tests

Preserve all applicable AGENTS database rules. Reset testing uses only `npm run test:postgres` with current guarded local authority. No raw reset/migrate-dev/db-push; no seed/fixture/test mutation against remote PostgreSQL or Neon; no ambient `DATABASE_URL` as proof; treat `DIRECT_URL` independently. Remote production migrations remain separately authorized forward-only operations, not test reset permission.

Retain exact resource ownership, bounded graceful/force browser behavior, transaction outcome observation, exact rate-limit keys, case-insensitive test-marker sanitation and dotenv neutralization. Do not claim a generic timer cancels SQL or kills a browser. Failures and unresolved live resources must be visible. Keep secrets out of code, logs, receipts, viewers, artifacts and extension bundles.

Use genuine RED/GREEN for logic/bugs, targeted adversarial tests for authority, and representative integration evidence for composition. Match verification to changed bytes: documentation-only and accepted mechanical gates do not automatically rerun the full product ladder. Runtime/database changes do need relevant fresh proof. Distinguish sandbox denial from product failure, preserve anomalous runs and failed report finalization, and never call a self-review independent acceptance.

## 11. Cost, beta and commercial claims

Measure package cost, assisted completion cost, attempted and confirmed submission cost separately. Include successful/failed model calls, browser and human dwell time, worker/egress/storage, discovery, support, payment and refunds. Price with current verified rates and actual full-utilization economics, not historic sample model prices.

Mathew's beta should measure editing burden, factual errors, active minutes, safe stops, supported-field usefulness, provider/client differences and outcomes. Do not submit duplicate variants to one employer for an experiment. A small cohort or internal score correlation is not causal interview proof. Bill the real deliverable, not a stronger claim. Do not promise universal ATS support, guaranteed interviews or unlimited safe automation.

## 12. Task execution and handoff

Classify task mode; verify actual state; identify applicable scope and reference decisions; perform only authorized work. Ask only for essential missing information that cannot be resolved from source. Do not reopen already approved bounded design unnecessarily. Stop on material scope/authority change rather than silently widening it.

Report Model/Reasoning/Window, phase/mode, current repository identities, exact changed/frozen files, real evidence and limitations, findings, current Git/deployment status, and one next bounded action. Update project state only when documentation writes are authorized.

Stage, commit, push, merge and deploy only when explicitly requested. Do not promise background work, automatically schedule jobs, launch remote sessions, or apply to employers from roadmap approval.

If no current task is supplied, summarize the active checkpoint and open decisions; do not implement a future phase merely because this master prompt lists it.
