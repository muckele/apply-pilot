# Apply Pilot — Agent Workflow and Handoff Contract

Version 2.0 | 2026-09-20
This guide prevents stale context, repeated approval loops, and unsafe scope drift. It supplements applicable system/tool/repository instructions; it cannot weaken them.

## 1. Read in layers, not an entire archive on every task

Read applicable `AGENTS.override.md`/`AGENTS.md` first, then current user task, `PRODUCT_ROADMAP.md`, project state, decision log, and the relevant specialist brief. Use the source register for research claims. Read the full master prompt for architectural work or a new agent session; use task-relevant references rather than pasting all documents into every small task.

Codex's official instruction guide describes discovered AGENTS files, overrides, and a combined-size limit. Keep the additive AGENTS section small and point to longer references. Do not claim these Markdown files create permanent automatic memory in every agent/tool. Verify the agent can read the repository documents at session start. [MB09]

## 2. Task header and model choice

Start reusable task prompts with **Model / Reasoning / Window**. Mathew's requested architecture/planning label is GPT-5.6 Sol with Max reasoning; use it only when actually available in his interface. Medium or High may fit mechanical identity work. These are user workflow labels, not validated production API model IDs or instructions to spend maximally on every application.

Report actual available model/settings if a requested label is unavailable. Do not silently substitute a different model, invent availability, or alter the application's model registry. Current model pricing and production routing need their own evidence.

## 3. Resolve the task mode

Before action, identify whether the user requests research, documentation, planning, implementation, review, operational testing, mechanical commit, push, or release. Approval of a roadmap authorizes strategy, not every operation inside it. A documentation-only task cannot create cloud sessions. A review cannot quietly repair findings. A push-only task cannot amend source.

Reflect the requested scope once; do not ask for approval already supplied. Use explicit latest scope amendments to resolve specific historical conflicts. Keep unchanged restrictions intact. If a tool-level enforced gate denies access, do not bypass it; report the actual missing authorization or capability.

## 4. Inspect actual state before mutation

Confirm current repository root, worktree, branch, HEAD, index, modified and untracked files, relevant remotes where authorized, and any local instructions. Read files before editing. A historic SHA is a reference, not a reset command. A remote branch listing cannot prove local cleanliness or the deployed version.

Do not recreate a worktree, delete untracked files, broad-stage, or reset accepted commits just because an old prompt names a different path. Existing Greenhouse work should be reconciled into multi-ATS context, not discarded. Separate ownership if multiple agents are working; document allowed files and shared dependencies.

## 5. Scope contract

For each implementation checkpoint state the intended outcome, exact allowed files or a justified bounded category, production versus test changes, frozen authority, test plan, acceptance gate, and stop conditions. File counts are receipts, not a reason to make contradictory requirements. If an integrity-pinned runner change requires its policy test, identify that dependency before promising an impossible fixed inventory.

A newer explicit authorization may supersede an earlier file freeze for a named repair; record it. Do not interpret a four-file amendment as authority to change every related module. Conversely, do not repeatedly block an already-authorized file because an obsolete instruction still appears in copied chat.

## 6. Design and TDD

For new architectural interfaces, inspect source, compare a small number of approaches, present a written design and scoped plan, and obtain the required stage approval. A user-approved short bounded repair does not require a giant design bureaucracy. Preserve any installed skill requirements unless explicitly overridden by the user and permitted by higher-priority instructions.

For new logic or defect repairs, establish meaningful RED before implementation where practicable. Prefer the actual defect trigger, not a deliberately false final-state assertion that proves only the test runner can fail. Characterization can document current defects without shipping permanently failing normal suites or hiding them with skips.

Reuse existing suites and helpers. Do not build a second generic browser engine or duplicate the full synthetic E2E to test a narrow change. Keep page/model text as untrusted data throughout.

## 7. Verification by risk and bytes

Use [release gates](RELEASE_GATES_AND_ACCEPTANCE.md). Documentation-only changes need link/scope/consistency checks; mechanical identity work does not repeat the whole product ladder on identical accepted bytes unless requested. Runtime/database/authority changes need their relevant fresh proof.

Report exact command, environment, exit code and actual count. Distinguish test assertion failures from sandbox/network/permission denials and do not label an unexecuted test passed. Preserve all anomalous application runs and any failed scan finalization. Do not use authoritative-sounding “all secure” language beyond the reviewed surfaces and evidence.

An old passing hash-bound runtime test may remain inherited evidence for a truly unrelated documentation-only change; a changed helper/golden test invalidates relevant integration evidence. Explain the boundary rather than blindly rerun or blindly inherit everything.

## 8. Evidence packaging

Review snapshots must include untracked intended files; ordinary `git diff` omits them. Use a temporary index/archive/manifest outside the repository without altering the real index. Store hashes, paths, current base and relevant results. Final integrity checks should establish candidate bytes did not change during review.

Do not put raw credentials, applicant values, cookies, signed viewer URLs, debug connections, or employer payloads in receipts. Portable reports should name repository-relative paths and durable approved evidence locations, not rely on another agent having access to a previous `/private/tmp` path.

Evidence state labels: `SOURCE_OBSERVED`, `USER_RECEIPT`, `VENDOR_DOCUMENTED`, `LOCALLY_TESTED`, `AUTHORIZED_LIVE_TESTED`, `INFERRED`, `PROPOSED`, and `UNKNOWN`. Keep empirical results apart from product-policy choices.

## 9. Research freshness

Revalidate provider APIs before integration, privacy/defaults before real data, prices before budgets/subscriptions, and current ATS host behavior before live scope. Old source entries remain dated evidence rather than silently becoming current. A vendor feature page does not prove our integration or business outcomes.

Use primary documentation for technical claims; connected repository tools for the user's actual code; exact source attribution for extracted content. Do not replace attached project decisions with generic best-practice advice without identifying the departure and getting scope approval when required.

## 10. Role handoffs

**Planner:** map current source, approved objective, options, proposed writes and acceptance. No hidden implementation.

**Implementer:** execute only the scoped checkpoint, capture RED/GREEN and self-review, leave candidate state as requested. No premature independent-pass label.

**Independent reviewer:** inspect actual candidate, test material claims, classify findings with trigger/impact/minimal correction, and preserve bytes. No repairs inside read-only review.

**Mechanical operator:** only commit/push/identity steps explicitly requested against accepted bytes; stop on mismatch rather than reconcile automatically.

**Release operator:** separate authorization for merge, config, migrations, deployment/promotion and live checks. No production side effect from a general roadmap approval.

## 11. Suggested completion report

- Model / Reasoning / Window and task mode.
- Verified root/branch/base/current identities and authorized scope.
- What changed and what remained frozen.
- Tests/evidence with actual counts, material failures and inherited results.
- Security/correctness findings and affected capability, not merely a global score.
- Exact Git state and separate deployment state.
- Documentation/state updates only where authorized.
- One next bounded action or precise blocker.

Keep mechanical reports brief enough to use. Full hashes can be an attached manifest rather than repeated several times in every narrative. Do not produce a 50-section acceptance template for a one-line documentation fix.

## 12. Stop/go without process loops

Stop for actual safety, authorization, source-state conflict, unbounded external resource ownership, unsupported capability, or scope-changing architecture. Do not stop because a long-unsolved/general engineering problem exists; attempt the permitted analysis and provide concrete evidence and uncertainty.

Do not promise background work. Scheduled tasks require actual authorized scheduling tools. Repository agents may execute long tasks in their active environment, but this reference does not grant ongoing monitoring or future delivery.

The master prompt is a project operating reference. It is never an unrestricted request to implement all future phases.
