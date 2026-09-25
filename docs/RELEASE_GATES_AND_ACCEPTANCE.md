# Apply Pilot — Release Gates and Acceptance Evidence

Version 2.0 | 2026-09-20
**Status:** proposed gate policy for adoption at the relevant checkpoint. This document does not authorize executing tests, spending funds, writing code, or interacting with employers outside the current task.

## 1. Why gates replace a percentage

A subjective percentage can hide a critical missing journey. Use explicit gates, affected capabilities, evidence dates, accepted limitations, and release status. A source change may be small but safety-significant; a long test log may still omit the actual customer's submission handoff.

Track three levels separately: technical accepted behavior; user-facing delivery; commercial/operational release. Never equate a pushed feature branch with main integration, deployed behavior, or user benefit.

## 2. Technical Human-Submit gate (T)

| ID | Requirement | Evidence |
|---|---|---|
| T1 | Existing accepted lifecycle and browser authority preserved | Source and threat-focused regression review |
| T2 | Supported provider/form subset established | Updated Multi-ATS matrix with separate action evidence |
| T3 | Truthful approved materials and answers | Source provenance, no material unsupported claim, correct user/package |
| T4 | Approved Fill occurs once and preserves existing values | Protected writer/orchestration evidence and genuine intended trial |
| T5 | Manual/sensitive/unsupported fields stay non-automated | Negative tests and user guidance |
| T6 | Human can actually complete employer submission/navigation | Controlled intended trial; no automated Submit |
| T7 | Completion requires explicit two-step attestation | API/UI/lifecycle evidence; no inference from employer page |
| T8 | Database/process/privacy safeguards retained | Guarded suite and exact resource cleanup appropriate to changes |
| T9 | Operator setup, emergency stop, safe recovery documented | Mathew self-beta walkthrough |
| T10 | Accepted bytes and rollout state identified | Implementation/review/commit/push/main/deployment records separated |

Technical acceptance may use the current local companion. It does not close no-download public delivery.

## 3. No-download managed-delivery gate (H)

| ID | Requirement | Evidence |
|---|---|---|
| H1 | Provider and runtime parity | Real synthetic hosted proof of required isolated-world/protocol controls |
| H2 | Owner/session/page isolation | Cross-tenant negative tests and exact identifier validation |
| H3 | Agent versus human exclusive control | Race tests, epoch/fencing checks, server-side input revocation |
| H4 | Viewer access is suitably scoped and revocable | Direct-link, replay, expiry, unauthenticated and cross-tenant cases |
| H5 | Hosted privacy configuration is effective | Recording/logging/persistence sentinels, deletion and contractual review |
| H6 | Human submit handoff preserves app authority | Local navigational test plus authorized hosted intended trial |
| H7 | Needed user file/auth flows work within explicit scope | File/credential tests, no assumed local-device state |
| H8 | Modern browser and accessibility target proven | Real Safari/Firefox/Chrome/Edge task evidence and declared limitations |
| H9 | Recovery cannot replay consumed actions | Worker/viewer/provider disconnect scenarios and uncertain-outcome handling |
| H10 | Exact-session termination and cost reconciliation | Failure injection, orphan detection, status evidence and provider usage |
| H11 | Less-technical users can finish without installation | Observed no-extension/no-terminal task sessions |
| H12 | No-download release wording matches capability | Public support matrix, known limits and manual fallback |

A provider iframe renders successfully is not H1–H12. A backend UI saying paused is not H3 unless write authority is actually revoked. Absence of an API key in a live URL is not H4 by itself.

## 4. Application Intelligence gate (Q)

Q1: facts are user-owned/source-linked and current; wrong-user/demo fallbacks audited. Q2: requirements/rubric frozen before generation. Q3: actual export quality checked and re-extracted. Q4: scores separated and explained; hard blockers not averaged away. Q5: factual/semantic evaluation and user diff approval. Q6: bounded revisions/cost. Q7: useful time/edit outcomes measured. Q8: no unsupported employer-score or hiring-effect claim.

The proposed 95/90 targets need explicit adoption and calibration. Hitting a target cannot override Q1 or a missing required qualification. P1 can improve existing quality surfaces incrementally; do not claim the entire engine is delivered because a model returns two numeric fields.

## 5. Future autonomous capability gate (A)

A1: separately approved protocol and threat model. A2: explicit per-user/job/target/package/action grant with expiry/revocation. A3: only proven supported workflow variants. A4: shadow mode and supervised evaluation. A5: no automatic sensitive/legal guesses. A6: durable intent/dedupe before dispatch. A7: confirmed versus attempted/unknown evidence. A8: no blind replay after ambiguity. A9: spend/rate caps and stop controls. A10: verified usefulness and incident-response readiness.

None of T, H, a score, a plan approval, or a subscription payment authorizes automated submission. A is a separate capability project.

## 6. Commercial/operational gate (C)

Define deliverables and credits; reconcile cost at full utilization; publish supported scope; establish privacy/export/deletion; validate processor terms; provide cancellation/refund/support routes; monitor incidents without raw applicant logging; stage rollout; verify actual deployed code/config; and provide rollback/emergency stop.

Qualify material unknowns rather than fabricating a universal compliance or margin claim. A contribution-margin model is not audited profitability. A self-beta outcome is not general customer efficacy.

## 7. Risk-matched verification

| Change class | Minimum validation recommendation | Not automatically required |
|---|---|---|
| Markdown references only | Links, scope, consistency, source provenance, whitespace | Browser/DB reset/full build |
| Mechanical commit/push on accepted identical bytes | Identity, paths, hashes, ancestry, cleanliness, actual remote result | Entire already-accepted suite again |
| Pure helper/validation logic | Focused RED/GREEN and relevant unit suite | Live employer trial |
| Form identity/protected writer/authority | Adversarial unit/browser tests, relevant golden path, independent security review | Broad ATS scope expansion |
| Database runner/lifecycle/cleanup | Existing guard/policy tests and authorized isolated PostgreSQL proof | Raw alternate reset path |
| Hosted provider/session control | Synthetic remote parity, revocation, privacy, cleanup, recovery, cost | Real applicant data before synthetic/privacy gates |
| New public interaction surface | Client/assistive-task evidence and security/tenant checks | Claim of universal browser/mobile support |

The active scoped task may require more. This table never overrides applicable AGENTS or explicit acceptance instructions. If evidence cannot be obtained, state what is missing and its impact rather than silently downgrading a required gate.

## 8. Current guarded acceptance commands

Repository commands in historical accepted evidence include `npm test`, `npm run test:browser`, `npm run lint`, `npm run typecheck`, `npm run build`, `npm run test:postgres`, and the selector `npm run test:postgres -- --suite synthetic-human-submit`.

Database operations must use the required marker and independently validated isolated local authority under current AGENTS rules. No raw reset/dev/db-push and no test/seed/reset against a remote or Neon database. Historical successful credentials, ports, Docker names, and test counts are not reusable authorization. `DATABASE_URL` alone is not safety proof; validate `DIRECT_URL` too as required by the approved workflow.

A hosted integration does not retroactively authorize a cloud reset database. Designing any permitted staging data process requires explicit review outside existing local test reset authority.

## 9. Evidence completeness and truthful verdicts

Every material gate should record code/package hash, environment class, scoped authorization, exact command/test, expected behavior, actual exit/result, anomalous runs, ownership/cleanup state, and privacy-safe artifact location. Mark inherited evidence as inherited.

An implementation self-review is not independent acceptance. A failed report finalizer is not a sealed report; state which result exists and whether finalization was mandatory. A sandbox capability denial is not a product assertion failure, but also not a passing run; rerun only with legitimate needed permissions. Do not keep rerunning flaky assertions until the failure disappears without recording/investigating it.

Tests that prove a timer returned do not automatically prove resource or transaction termination. Preserve transaction settlement observation and exact browser/session ownership. If closure remains unknown, the result stays unverified/failed, not clean.

## 10. Merge, release, and deployment sequence

After accepted implementation: preserve exact bytes; commit only if authorized; identity review; push only if authorized; verify actual remote; create/merge PR only if authorized; validate current main/base and any migration obligations; perform explicit deployment/configuration review; then deploy/promote only if authorized and verify the actual deployment identity.

Do not create a second independent “main” by continuing to call a feature branch deployed. Where Mathew's workflow uses separate mechanical windows, preserve those gates; where an explicit task combines gates safely, do not invent unnecessary repeated approvals.

## 11. Stop conditions and incident response

Immediate stop for wrong-user data, fabricated material claim, unauthorized employer mutation/submission, duplicate ambiguous dispatch, secrets in artifacts, broad cleanup, provider credential exposure, out-of-scope database authority, or broken human/agent fencing. Preserve sanitized evidence, prevent further actions, revoke session authority where safe, and escalate exact remaining resource/transaction uncertainty.

A failed phase gate does not imply all prior work is discarded. Record the narrow blocker and smallest next task. Do not fix it live on an employer page or broaden browser authority to pass a deadline.

## 12. Release record

Use one accepted release record listing T/H/Q/A/C gates applicable to that release, explicitly excluded capabilities, accepted browser/provider/form matrix, current code and deployment identities, evidence links, known limitations, runtime configuration, emergency disable procedure, ownership/support contact, and rollback authority. Require Mathew's release decision before changing public availability.
