# Apply Pilot — Managed Browser Provider Evaluation

Version 2.0 | 2026-09-20
**Purpose:** define a bounded stop/go evaluation. No provider purchase, account creation, session launch, deployment, credential use, or employer access is authorized by this document.

## 1. Decision to make

Select a delivery mechanism that preserves the accepted executor's behavior and supports a usable no-download Human-Submit workspace. The candidates are a managed-browser vendor, an explicitly owned isolated browser-worker deployment, and the accepted local companion as a reference/fallback. A required extension is no longer the default public route.

The user experiences Apply Pilot, not infrastructure setup. Technical quality, privacy, termination, and human handoff are pass/fail gates before weighted cost or convenience scoring.

## 2. Dated research facts, not acceptance evidence

| Candidate | Public primary-source evidence checked | What is still unproven for Apply Pilot |
|---|---|---|
| Browserbase | Interactive embeddable live view; mobile keyboard caveat; recording default and disable control; session configuration API; browser-hour pricing | Protected-world parity, account-bound/revocable viewer access, safe human-control enforcement, exact cleanup, actual browser/device usability |
| Browserless | Interactive short-lived LiveURL; absolute session-duration limit; server-enforced view-only option; clipboard/mobile behavior documented | Our worker/protocol parity, complete input revocation, recording/logging configuration, session isolation, end-to-end ergonomics and economics |
| Owned isolated worker | Existing project already owns local Chromium through Playwright | Cloud packaging, authenticated streaming, worker operations, tenancy, lifecycle, security maintenance and actual total cost |
| Existing local companion | Accepted local synthetic workflow and cleanup evidence in project history | Nontechnical installation experience; not the no-download public deliverable |

See source register MB01–MB07, MB11 and R07. Vendor documentation does not prove our integration. Do not treat proxy, anti-bot, CAPTCHA or persistence features as part of approved product scope merely because they are listed.

## 3. Mandatory disqualifiers

A candidate fails the intended release if it cannot meet required runtime protections without weakening them; cannot isolate tenants; exposes reusable privileged debugger credentials to customers; cannot revoke human control; cannot disable or suitably constrain sensitive recording/logging; cannot stop/reconcile exactly owned sessions; requires prohibited employer interaction; or requires an extension for every public user.

Treat unknown as NOT YET VERIFIED, not a pass. Where a provider cannot enforce read-only/control separation, an application wrapper alone is not automatically enough. Test direct access outside the wrapper. Where a service reports a disconnect but does not prove termination, require separate status/reconciliation evidence.

## 4. Evaluation scorecard

Use evidence states `UNTESTED`, `DOCS_ONLY`, `SYNTHETIC_VERIFIED`, `AUTHORIZED_LIVE_VERIFIED`, `BLOCKED`, and `NOT_REQUIRED_FOR_SCOPE` for each dimension. The following weights are proposed ranking aids **after** mandatory gates pass:

| Dimension | Proposed weight | Evidence questions |
|---|---:|---|
| Execution parity | 25 | Does actual isolated-world/CDP/routing/DOM identity work with pinned versions? |
| Ownership and termination | 20 | Can sessions and viewer grants be revoked, reconciled and confirmed closed? |
| Human interaction and accessibility | 20 | Can target users operate the exact supported flow without installation or assistance? |
| Privacy/data handling | 20 | What is retained, where, for how long, and who can access/delete it? |
| Cost/operations | 10 | What are fully allocated session costs, duration/concurrency limits, failures and support burden? |
| Portability | 5 | Can the core remain provider-neutral without inventing a generalized abstraction? |

Do not average away a failed security, legal, authority, or accessibility gate. A low-price provider with unrevocable bearer session control is not acceptable because its weighted score is high.

## 5. H0 — planning-only outputs

Read actual runtime, companion, coordinator, protected-world/session, bridge, no-submit policy, accepted synthetic tests, and deployment documentation. Identify every provider API needed and its current evidence. Compare Playwright native connection and CDP support using official docs and the installed versions; do not swap protocols silently.

Return the smallest synthetic probe design, exact permitted files, an estimated billable-session budget with formula/assumptions, an isolated data/fixture topology, required credentials and approvals, cleanup/reconciliation design, and stop conditions. Do not create infrastructure as part of H0.

If evaluating two vendors, run sequential comparable tests rather than building active multi-vendor production failover. Two candidate integrations do not justify a universal plugin framework.

## 6. H1 — proposed synthetic probe stages

Each stage needs the probe's explicit approval and any platform permissions.

**A. No-employer lifecycle:** create one session with safe settings, attach, view a neutral owned page, revoke access, terminate, verify closure and billed duration. No applicant data, provider secrets in artifacts, or unrestricted public targets.

**B. Protected execution parity:** use an approved synthetic form. Test exact target, main-frame ownership, fixed isolated capability, inspection/correlation, currentness invalidation, supported fields and preservation. Reuse accepted fixtures where possible. Do not claim parity from `page.goto` alone.

**C. Human/agent ownership:** agent-only phase, fenced transfer, read-only rejection, human-only manual field/submit simulation, no agent resume after consumed Fill, and separate attestation. Test delayed commands and stale grants, not just successful UI clicks.

**D. Failure/cleanup:** lost viewer, lost worker, API timeout, expired session, partial provisioning, failed termination acknowledgement, and worker crash. Verify no replay and no false closure. Use exactly owned resources; no broad process/session deletion.

**E. Usability:** actual desktop Safari/Firefox/Chrome/Edge, keyboard and assistive tools, clipboard, zoom, slow links, timeout warnings, manual file interaction if separately included, and disconnected-session recovery. Mobile is a separate evidence set.

## 7. Privacy inspection checklist

Inspect effective video/log settings, recording disable behavior, provider administrative access, input capture, cookies, remote storage, uploaded-file copies, replay links, debug URLs, crash reports, backup retention, region, subprocessors, and deletion behavior. Do not assert “no data retention” merely because no application database row contains raw values.

Turn off vendor CAPTCHA solving/evasion features and credential persistence for the probe unless a separate approved legitimate capability requires something different. Keep certificate validation enabled. No new proxy identity strategy or location spoofing.

Do not use real user credentials to test whether logs redact them. Use inert recognizable sentinels and inspect bounded authorized outputs. A sentinel absence test must cover the configured sink, not just one happy-path response.

## 8. Cost experiment

Record reserved budget, actual provider charge, active automation minutes, human review minutes, idle time, stream/egress, recordings/storage, failed launches, failed sessions, API operations, and cleanup completion. Reconcile ledger totals against provider usage before using the figures for pricing.

The Browserbase developer price page checked for this revision lists $20/month, 100 included browser hours, and $0.12 per extra browser-hour. It is an example, not a procurement recommendation or whole-application cost. Do not use overage-only arithmetic to allocate a low-volume fixed monthly plan. [MB07]

Session concurrency is a separate limit from included hours. Review-dwell time can consume capacity without useful automation. Do not assume worker sleep, viewer closure, or websocket disconnect stops billing. Test actual session lifetime and the relevant plan's billing contract.

## 9. Required evidence record

For each provider/configuration: date, account plan/region, SDK/runtime versions, synthetic fixture version, protocol, safe option values, owner/session grant model, tests attempted and actual results, negative cases, unexpected traffic, accessibility findings, termination status, cost ledger, source references, open gaps, and decision. Store no API key, raw connect URL, reusable live URL, applicant values, or sensitive video.

Separate DOCS_ONLY from executable proof. A provider support reply is evidence of a statement, not a substitute for a required test. Record contradictions between documentation and observed behavior.

## 10. Stop/go decision

- **GO TO H2:** all mandatory synthetic gates pass within the approved budget and scope; remaining limitations are explicitly accepted for the next design.
- **REWORK PROBE:** failure caused by an identified test harness issue; preserve failed evidence and repair only within authorization.
- **BLOCKED BY PROVIDER:** required control/protocol/privacy/termination behavior cannot be established; do not weaken product protections.
- **DEFER HOSTED RELEASE:** no candidate satisfies no-download public requirements yet; local self-beta continues, with no public claim of hosted availability.

The final vendor and detailed runtime interface are still unselected. No document here authorizes deploying a gateway, opening a local tunnel, or processing a real applicant through a provider.
