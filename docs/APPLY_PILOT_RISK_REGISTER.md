# Apply Pilot — Risk and Open-Decision Register

Version 2.0 | 2026-09-20
**Statuses below are planning/evidence statuses, not findings from a fresh production audit.** PR #5 and PR #7 resolved specific earlier source risks; P0.4 intended-flow verification remains open. See [project state](APPLY_PILOT_PROJECT_STATE.md).

| ID | Risk / uncertainty | Current evidence status | Required mitigation / gate | Owner decision |
|---|---|---|---|---|
| RISK-01 | Required extension alienates target users | User-identified product requirement | Web-first no-download P2; optional extensions | Direction adopted |
| RISK-02 | Hosted protocol breaks isolated-world or target protections | Unverified | H1 actual runtime parity; reject unsupported provider | Provider/runtime selection |
| RISK-03 | Human viewer overlaps agent writes | Proposed architecture risk | Server-enforced ownership epoch/fencing and race tests | H2 design approval |
| RISK-04 | Bearer viewer/debug URL leaks control | Unverified vendor-specific | Scoped credentials, direct-link/replay/revocation tests | Access model acceptance |
| RISK-05 | Hosted page data retained by default | Vendor docs show recording/default controls; implementation unverified | Recording/logging/persistence review and effective-setting tests | Processor/privacy approval |
| RISK-06 | Human Submit navigation blocked by frozen target | PR #7 merged irreversible human handoff; genuine intended navigation remains unverified | Verify actual personal submission and confirmation in P0.4 | Intended trial gate |
| RISK-07 | Field input transmits before Submit | Existing architecture permits page handlers | Explicit trial consent, synthetic-only experiments, no false locality claim | Live target/data authorization |
| RISK-08 | Hosted file/auth flow unusable | Not implemented/verified | User-directed file/auth design and actual task tests | Scope approval; no auto-upload shortcut |
| RISK-09 | Cross-browser/mobile/assistive gaps | Not tested for managed workspace | Client matrix and less-technical user beta | Declared release limitations |
| RISK-10 | Provider disconnect leaves paid orphan session | Unverified remote behavior | Durable exact ownership, termination reconciliation, watchdog and cost cap | Runtime operations gate |
| RISK-11 | Restart/reconnect replays Fill or completion | Current local safeguards accepted; remote adaptation unverified | Durable intents, consumed authority, uncertain-outcome reconciliation | H/P3 threat review |
| RISK-12 | Model score inflated to hit 90 | Existing model-score source observation | Independent frozen evaluator, hard blockers, honest below-target outcome | Rubric calibration |
| RISK-13 | Fixed/demo resume fallback reaches wrong user | PR #5 removed unsafe personalized local fallback and fixed persona content | Preserve fail-closed safeguard; continue broader wrong-user/fact audits | P1.1 residual scope |
| RISK-14 | Most form fields remain manual and value is low | Current contact/source restriction | Measure active time and actual eligible coverage | Possible separate contact-source decision |
| RISK-15 | Provider logo oversells variant coverage | No universal support evidence | Provider/host/form/action/runtime/client matrix | Support scope acceptance |
| RISK-16 | Employer-side API credentials assumed | Public feeds do not imply write permission | Candidate-facing flow or legitimate approved partner credentials | API partnership scope |
| RISK-17 | Raw request/log/artifact leaks applicant data | Test-only artifacts historically reviewed, cloud differs | Data minimization, safe sink tests, bounded retention | Logging/diagnostics policy |
| RISK-18 | Guarded DB rules weakened for cloud tests | Existing mandatory local rules | No remote reset/seed; separately designed staging data plan | Explicit DB authority review |
| RISK-19 | Long human dwell makes unit economics poor | Unmeasured for this product | Active/dwell/idle ledger, finite session budgets, full-utilization model | Subscription allowance |
| RISK-20 | Auto-submission creates duplicate or unauthorized application | Future capability, not enabled | Fresh scoped grants, dispatch intent, UNKNOWN and no blind retry | P4 authorization |
| RISK-21 | Live ATS terms/anti-bot restrictions block workflow | Per-target unknown | Review legitimate access; pause/manual fallback; no evasion | Exact live trial |
| RISK-22 | Small beta mistaken for hiring uplift proof | No product causal evidence | Cohort limits, honest metrics, no duplicate A/B applications | Marketing claims |
| RISK-23 | Old prompts conflict with new roadmap | Repeated historical workflow issue | Scope ledger, one canonical roadmap, latest explicit amendment | Documentation adoption |
| RISK-24 | Feature accepted/pushed but public deployment differs | Deployment not verified here | Main/merge/config/deployment identity evidence | Release authorization |

## Mandatory stop conditions

Stop further application mutation on wrong-user material, fabricated essential claims, unauthorized submission, secret exposure, untrusted target, stale approval, ambiguous non-idempotent outcome, unexpected recording, or lost session ownership. Report remaining resources and facts honestly. A stop result may still require safe owned-resource termination; it does not permit broad cleanup or replay.

## Update rules

Every resolved risk needs dated source/test evidence, exact affected version/configuration, residual limitations, and an accepted scope. “Vendor supports it” is not a closure record. “No issue seen in three runs” is bounded evidence, not universal reliability. Do not resurrect closed local issues without a candidate-introduced trigger, but re-evaluate the new hosted boundary rather than inheriting local guarantees blindly.

## Open decisions for the next design

Provider candidate(s), hosted topology, privacy/recording controls, viewer revocation, exact human navigation boundary, upload/manual-auth scope, browser/mobile support, total session budget and post-crash reconciliation. H0 inputs remain a later P2 task; the immediate proposed bounded mission is `GEMINI_JOB_MATCH_QUALIFICATION` for P0.4 scoring readiness, without changing the accepted executor.
