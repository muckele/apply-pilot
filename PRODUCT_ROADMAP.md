# Apply Pilot — Master Product Roadmap

Version: **2.0 — Web-first Managed Application Workspace**<br>
Effective product-reference date: **2026-09-20, America/Los_Angeles**<br>
Product owner: **Mathew**<br>
Status: **Strategic direction approved for documentation; detailed implementation, procurement, live trials, submission, and release remain separately gated.**

## 1. Controlling product decision

**Apply Pilot is web-first. A Chrome extension must not be required for core customer value. The preferred public execution experience is an Apply Pilot-managed browser workspace. The accepted local browser companion remains the technical/self-beta baseline. Extensions and a desktop/local companion are optional delivery surfaces, not mandatory customer prerequisites.**

The hosted direction is a product decision, not a claim that a particular cloud provider has passed our security or usability tests. Browserbase, Browserless, and an explicitly owned browser-worker deployment are evaluation options; none is selected or procured by this roadmap.

This version replaces the earlier **P2 — Chrome Copilot** phase with **P2 — Managed Application Workspace / Browser Copilot**. It preserves P0–P5 identifiers so existing work remains traceable. Multi-ATS scope, truthful tailoring, self-beta, cost instrumentation, and the current Human-Submit boundary remain intact. See [decision history](docs/APPLY_PILOT_DECISIONS.md) and [change log](docs/APPLY_PILOT_ROADMAP_CHANGELOG.md).

## 2. Mission, audience, and success

Help jobseekers identify suitable jobs, represent their actual experience accurately, prepare job-specific resumes, cover letters, and answers, complete supported application workflows with less effort, and understand their outcomes. Mathew will test the product through his own genuine job search before broad commercial marketing.

The target audience includes people who are uncomfortable installing extensions, downloading a desktop application, running terminal commands, managing browser drivers, or switching browsers. The desired public journey is **sign in → review profile → select suitable job → approve package → open workspace → finish manual steps → personally submit**. No-download is a customer-experience goal; it is not a claim of zero setup, universal employer compatibility, or mobile accessibility already proven.

Optimize for truthful materials, useful application coverage, qualified interviews per applicant-hour, reduced active effort, and sustainable delivered-result cost. Application volume is secondary. Scores and throughput do not override safety, factuality, permission, or fit.

## 3. Two release milestones; one strategy

| Milestone | Meaning | What it does not mean |
|---|---|---|
| **Technical Human-Submit self-beta** | The accepted local engine works on the declared multi-ATS subset, with Mathew operating the companion and personally submitting | A consumer-ready no-download service or autonomous product |
| **No-download public Human-Submit release** | Technical evidence plus accepted hosted delivery, end-user usability, privacy, operations, billing, and rollout gates | Universal ATS support, mobile parity, or automated employer submission |

P0 technical acceptance can close before P2 public-delivery acceptance. A public release marketed as no-download cannot close until the required P2 workspace gates pass. If a limited document-only product is offered sooner, label its deliverable accurately and do not imply managed application execution is available.

Do not silently redefine MVP whenever a new idea appears. The technical milestone remains useful and executable; public delivery adds its own explicit acceptance criteria. A requested commercial capability is not automatically an existing implementation.

## 4. Released baseline and active checkpoint

**ACTIVE MILESTONE: P0.4 — Genuine Intended Application Trial.** P0.4 has not passed. The next proof is useful assistance on an application Mathew genuinely intends to submit, with a truthful fit assessment, reviewed materials and answers, supported-field Fill, manual completion, his personal employer Submit, and separate Apply Pilot attestation. Synthetic tests and read-only inspection remain valuable evidence but cannot substitute for this trial.

The documentation baseline is the PR #11 merge on `origin/main`, `4644e4f5e117250b4c793efbd4bfac42363ea778` (tree `961d2bafb0e445d27a687889fdfd11ed8d895e3c`). The local ref and GitHub commit/PR pages confirm the merge identity; GitHub Actions run `36094635592` reports success. The owner-supplied production checkpoint names Vercel deployment `dpl_8TLCy6f5odvdFQNvckynQWmCVcnU` and anonymous health/readiness responses for version `4644e4f5e117`. This documentation task did not independently query Vercel or authenticated production workflows. See the [mutable project state](docs/APPLY_PILOT_PROJECT_STATE.md) for evidence classes, release details, and limitations.

PRs #5–#11 brought truthful Unscored presentation, the Human-Submit engine, irreversible human handoff, duplicate-field ambiguity quarantine, owner run entry, explicit PREPARE_ONLY setup/preparation, and successful manual import when optional scoring is unavailable onto main. This is released implementation, not a claim that P0.4 has passed. The older Private MVP delivered-history list remains historical; its deferred ideas are in section 14.

The immediate P0.4 blocker is production-quality `JOB_MATCH` scoring for the current unscored candidate workflow. The proposed next bounded experiment is `GEMINI_JOB_MATCH_QUALIFICATION`: evaluate Gemini 3.8 Flash on a small frozen corpus using approved résumé/profile evidence, without production writes, DBeaver record changes, ApplicationRun changes, or employer interaction. No provider or production routing decision follows automatically from this experiment. Model choice remains replaceable implementation policy within P1 Application Intelligence.

## 5. Permanent product boundaries

The current production browser command grammar is limited to `GET_STATUS`, `OPEN_TARGET`, `INSPECT_FORM`, `FILL_APPROVED_FIELDS`, `HANDOFF_TO_HUMAN`, `END_HUMAN_SESSION`, and `CLOSE_WORKFLOW`. The current automatic field families are `TEXT`, `EMAIL`, `TEL`, `URL`, `TEXTAREA`, and `SELECT_ONE`, subject to eligible evidence, review, current authority, and all existing restrictions.

Preserve exact frozen targets, ownership, packet and form-generation freshness, preservation of existing values, and one permanent Fill attempt. A writable input type does not imply an eligible proposal. Contact questions remain manual under the current classifier; document references do not grant file-upload automation. Sensitive and legal declarations remain user decisions.

Human-Submit and Copilot do not activate employer Submit. The existing completion ceremony is explicit user attestation, not independent employer receipt. Future automatic submission needs a separately designed capability, protocol, threat model, consent, evidence, and rollout. Hosting the existing browser does not grant new commands.

Job descriptions, employer DOM, model responses, remote-view events, and third-party outputs are untrusted data. None can grant policy exceptions, change approved facts, authorize payment, add executable code, or redirect application authority. No fabricated qualifications, hidden-text keyword stuffing, CAPTCHA evasion, unauthorized credentials, duplicate applications, or covert submission.

## 6. Phase map and dependencies

| Phase | Objective | Delivery role | Exit evidence |
|---|---|---|---|
| **P0** | Multi-ATS Human-Submit technical MVP | Existing local companion/self-beta | Useful supported workflows and honest manual fallback |
| **P1** | Application Intelligence and ATS Optimization | Extend current tailoring/export services | Proven factuality, independent scores, actual artifact quality |
| **P2** | Managed Application Workspace / Browser Copilot | Web-first public execution; no required extension | Hosted parity, secure handoff, usability, privacy, reliability, cost |
| **P3** | Hybrid Agentic Apply | Qualified queues, automatic preparation, guarded assistance | Durable orchestration, pauses, consent, operational controls |
| **P4** | Selective Autonomous Auto-Apply | Separately granted submission on proven variants | Reliable outcome accounting and authorization beyond Human-Submit |
| **P5** | Outcome learning and commercialization maturity | Calibrated optimization and sustainable plans | Measured user value, clear credits, privacy and support maturity |

Basic cost/outcome measurement begins during P0/P1 and continues throughout. P2's feasibility planning and tightly authorized synthetic runtime evaluation may occur early so the team does not discover delivery incompatibility after finishing P1. This overlap does not authorize parallel agents to edit shared code without a conflict/ownership plan. Full P2 integration requires accepted P0 behavior; P1 enhancements need not all be complete for a narrow hosted Human-Submit beta if Mathew expressly approves its scope.

## 7. P0 — Multi-ATS Human-Submit technical MVP

### P0.0 — Documentation reconciliation and state recovery
The Web-first v2 strategy is the canonical roadmap; this documentation checkpoint reconciles it with the PR #11 main/release state. Historical branch SHAs remain evidence, not reset instructions. Keep the project-state ledger current after later releases.

### P0.1 — Multi-ATS characterization
Prioritize Greenhouse, Lever, and Ashby; characterize Workday without assuming full multi-step support. Keep SmartRecruiters, iCIMS, Workable, and other providers staged by demand. Separate discovery, document compatibility, DOM inspection, source eligibility, Fill, manual handoff, and completion evidence. Characterize native/manual/custom controls, duplicate questions, dynamic changes, hidden data, page-owned network effects, and submission navigation using synthetic fixtures before real interaction.

### P0.2 — Evidence-driven compatibility repairs
Fix only concrete demonstrated gaps. Reuse the generic protected inspection/correlation/writer core. A discovered provider-host substring weakness is not permission to alter every host policy. No adapter by default, no blanket redirects, no new field/source capabilities, and no quiet weakening of no-submit tests. Changes to protected code need targeted threat-focused acceptance.

### P0.3 — Authorized live read-only inspection
Select exact public application targets after a separate authorization. No applicant values, upload, mutation, or submit. A page load may generate page-owned network activity; do not claim zero traffic. Record sanitized structural evidence, then reproduce failures locally. Treat custom, iframe, login, and CAPTCHA cases as limited/unsupported rather than pressure to bypass controls.

### P0.4 — Genuine intended trials and technical acceptance
**Active; not yet accepted.** Mathew chooses applications he actually intends to submit and understands that field input may transmit data before Submit. Prove approved Fill on useful eligible fields, preservation, manual responsibilities, actual human submission and confirmation navigation, and subsequent explicit Apply Pilot attestation. Use no fake applicants on arbitrary live forms. Store no real applicant payload in committed evidence.

**Proposed scope gate:** at least two materially different read-only forms and one genuine useful intended trial per provider/form family claimed as supported. These counts are a starting acceptance policy, not a certification of an entire vendor. A smaller two-provider beta needs an explicit scope decision; the third remains unclaimed.

**Technical exit:** relevant suites and independent security acceptance, accurate support matrix, operator runbook, emergency stop, privacy/cleanup evidence, and an actual merge/release plan. The user can still run the local companion for self-beta. No hosted or autonomous readiness is implied.

### Practical MVP interpretation and sequence

The technical/self-beta MVP is primarily P0, with only the P1 intelligence needed to make genuine applications effective. The working journey is **discovery/import → evidence-backed fit → preparation → employer-form inspection → reviewed answer packet → approved supported-field Fill → manual/sensitive/unsupported completion → Mathew's employer Submit → explicit Apply Pilot attestation**. Success means materially less active effort without lower application quality, with truthful materials and outcome tracking.

Finish P0 through genuine intended applications. Pull forward the necessary P1 scoring and quality work for those trials, then complete P1 Application Intelligence from self-beta evidence. P2 managed no-download delivery is required before claiming a broadly usable public consumer application: core paid value must not require a terminal, browser driver, Chrome extension, or local Playwright setup. P3/P4 autonomous execution is outside the immediate MVP critical path.

## 8. P1 — Application Intelligence and ATS Optimization

### P1.1 — Audit and fact authority
PR #5 removed unsafe personalized local fallback content and made unknown fit display as Unscored. Continue auditing model-returned scores, exported documents, tenancy, and AI budget behavior; trace reachability before calling a source observation an incident. Introduce an approved career-fact ledger with source references, status, and versioning. User-confirmed facts are not automatically independently verified.

### P1.2 — Requirements and independent scoring
Freeze a job-requirements snapshot and score rubric before tailoring. Separate document parseability, evidence-backed job match, user preference/fit, application readiness, and execution eligibility. The user's 90+ objective is an internal Apply Pilot target; proposed parseability >=95 and match >=90 must be calibrated. Missing hard requirements and unknown evidence remain visible outside averages. Never claim the employer's hidden score or interview probability.

### P1.3 — Tailored, validated packages
Build resumes, cover letters, and answers from the same source facts; verify chronology, entities, quantities, credentials, and meaning. Export DOCX/PDF and re-extract text to validate actual delivered bytes, not only a model response. Show changes and unresolved gaps to the user. Freeze approved package hashes and prompt/model/rubric versions. Revisions are bounded by usefulness, factuality, and cost.

### P1.4 — Evaluation and self-beta
Use holdouts, diverse profiles, human review, unsupported-claim adversarial cases, export checks, and actual editing burden. Start with Mathew, then carefully expand. No duplicate applications for A/B tests. Existing measurements do not prove a causal improvement in interviews.

**Exit:** no unresolved material fabrication or wrong-user contamination in release evidence; independent scores explained; exported materials usable; user approval and auditability; measured latency and cost. See [quality engine](docs/APPLICATION_QUALITY_ENGINE.md).

## 9. P2 — Managed Application Workspace / Browser Copilot

### H0 — Source-led feasibility design
Compare local companion, vendor-managed browser, and owned isolated worker. Inventory exact CDP/Playwright requirements and deployment/network topology. Specify human-control transfer, token isolation, provider privacy controls, file handling, expiry, and cleanup. Use [provider evaluation](docs/MANAGED_BROWSER_PROVIDER_EVALUATION.md). No paid session, deployment, live employer visit, or production modification is authorized by planning alone.

### H1 — Controlled hosted runtime proof
After explicit environment and spending approval, test only synthetic resources under a known authority. Prove remote protected-world behavior, target guard, context separation, deterministic cancellation/termination, recording/logging defaults, transport security, and failure outcomes. Provider support for a protocol is not parity evidence. Do not expose a local development server publicly or reuse production/database credentials as a shortcut.

### H2 — Workspace and human-control boundary
Design and implement the web application session broker and workspace, with server-enforced exclusive actor ownership. Revoke agent writes before human interaction becomes possible. Scope remote viewing/control to exact owner/session/page; do not expose debugging credentials or the control-page tab through a broad viewer. Human takeover must not reauthorize another Fill. Submission handoff and allowed human navigation require explicit design; do not remove the frozen-target guard broadly.

### H3 — User files, identity, accessibility, and session recovery
Prove any required user-directed upload path separately from automated file-upload authority. Do not assume local files, passwords, passkeys, or logged-in sessions exist remotely. Test current Safari, Firefox, Chrome, and Edge. Keyboard, screen-reader, clipboard, mobile, and slow-network limitations must be observed and disclosed. Internet Explorer is not a launch support target. Current mobile capability remains unverified until tested.

### H4 — Operational private beta
Measure session startup, review dwell time, queueing, provider failures, reconnect behavior, unit cost, deletion, and orphan-session termination. Treat unknown termination as a visible operational failure, not confirmed cleanup. Test less-technical participants completing the journey without an extension, driver, terminal, or staff intervention. Vendor procurement, region and retention policy must be accepted before real applicant data enters hosted sessions.

### H5 — No-download public-release acceptance
Close required hosted evidence, support matrix, security/privacy review, accessibility limitations, cost limits, billing definitions, incident response, rollout, and actual deployment verification. Cross-browser shell usability is separate from remote interaction usability and from ATS compatibility. No “works everywhere” claim.

**Exit:** the no-download journey works for the declared desktop/browser/ATS subset; human Submit remains human-controlled; existing workflow authority is preserved. Local companion and future extensions remain optional. See [workspace architecture](docs/MANAGED_APPLICATION_WORKSPACE.md) and [release gates](docs/RELEASE_GATES_AND_ACCEPTANCE.md).

## 10. P3 — Hybrid Agentic Apply

Add durable qualification queues, automatic truthful package preparation, bounded execution scheduling, user review batching, policy-constrained pauses, and shadow-mode evaluation. Use backend state rather than a viewer or browser process as the sole truth. Host worker retries must not replay consumed Fill or ambiguous completion actions.

Human-Submit remains the initial execution mode. If P3 introduces any employer submission action, that sub-capability requires the same explicit authorization and evidence standard as P4; the word hybrid does not waive it. Pause for unsupported forms, legal/sensitive answers, changed facts, changed job requirements, expired approval, identity ambiguity, authentication, CAPTCHA, unexpected cost, or uncertain mutation outcome.

**Exit:** reliable queues and pauses, clear user controls, budget enforcement, duplicate protection, transparent outcomes, and no unauthorized autonomous dispatch.

## 11. P4 — Selective Autonomous Auto-Apply

Design a new submission capability, separate from the current seven-command grammar. Bind the grant to the user, exact job/target, approved package hashes, answer versions, permitted action, expiry, spend/rate limit, and revocation state. Test in shadow mode and then per-application approval before narrow unattended cohorts.

Record dispatch intent durably before an external action. Distinguish attempted, independently confirmed, user-attested, failed, and unknown outcomes. A timeout after a possible employer receipt is not permission to resend. A new provider/browser session cannot reset consumed application authority. Receiver-side exactly-once delivery cannot be promised without appropriate employer-side support.

Require genuine user benefit and operational reliability, not just an internal 90 score. Sensitive/legal decisions and unknown support remain manual. No employer-side API use without legitimate permission. No automatic CAPTCHA evasion or deception-based workaround.

## 12. P5 — Outcome learning and commercialization maturity

Mature the telemetry begun earlier: role/provider cohorts, rubric calibration, time saved, manual burden, interview outcomes, support requests, success-related churn, total delivery cost, and pricing stress tests. Differentiate prepared package, assisted session, user-attested submission, and confirmed autonomous submission in both reporting and credits.

Commercialize useful verified services before full autonomy if their scope is accurately described. Never sell a successful auto-application credit while only producing a document or attestation. Do not base business viability on headline token costs or competitor offer popularity. Use full-utilization, long-review, failed-run, refund, and support scenarios.

## 13. Parallel foundations and release conditions

Security, provenance, quality, tenant isolation, cost measurement, support evidence, and policy compliance are continuous tracks. They do not wait for P5. Hosted sessions add a new trust boundary and must have their own threat model. Keep database testing under existing guarded local workflows; a hosted-worker proposal is not authorization for remote test/reset/seed mutation.

[Agent workflow](docs/AGENT_WORKFLOW_AND_HANDOFF.md) governs proportional testing and evidence handling. Mechanical commit/push steps preserve accepted bytes and do not automatically rerun every suite. Documentation edits require documentation validation, not a database reset.

## 14. Deferred work and decisions

Preserve the previous roadmap's useful backlog without displacing the critical path:

- calendar integration and interview reminders;
- salary and offer comparison;
- company research briefs;
- recruiter-contact/networking CRM and referral tracking;
- LinkedIn profile optimization guidance;
- weekly job-search plans and saved alerts;
- application-quality analytics and truthful resume experiments without duplicate live applications;
- follow-up cadence tools with explicit approval gates;
- AI mock-interview practice;
- a Kanban pipeline view;
- CSV export and scheduled backups;
- mobile-friendly PWA work; and
- duplicate-company detection.

Full Workday automation, automated uploads, contact-source expansion, custom widgets, cross-frame automation, additional ATS families, persistent employer identities, and unattended submission remain separate scope decisions.

This roadmap is strategy, not an execution grant. The next proposed bounded mission is `GEMINI_JOB_MATCH_QUALIFICATION`; its result must be reviewed before any model or routing decision. No employer interaction, production write, or application trial is authorized by this document.
