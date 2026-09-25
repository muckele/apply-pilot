# Apply Pilot — Research Source Register, Version 2.0

Reference date: **2026-09-20 (America/Los_Angeles)**. Repository branch entries below are dated research, not the current release checkpoint. See [project state](APPLY_PILOT_PROJECT_STATE.md) for PR #11 and later status.

**Provenance:** R01/R04 were freshly re-read during pack preparation; R07 was a new direct source read, and R08 was added from the local read-only repository inspection during adoption. R02/R03/R05/R06 and W01–W30 are inherited from the supplied v1 research pack unless explicitly refreshed below. They retain their original claimed research date and were not all independently rechecked in v2. MB01–MB11 are the managed-browser/documentation checks dated below. Adoption did not re-browse them. This is not a claim that 30 sources were all newly browsed.

The earlier v1 ZIP remains unchanged outside this pack. The active v2 memo revises delivery strategy and removes unverified named-model price scenarios from its operational baseline. Older raw price entries below are historical observations to revalidate, not current procurement authority.

 Prices, product features, platform rules and API contracts are point-in-time evidence, not permanent constants. This register distinguishes repository evidence from outside research. URLs are provided as code for portability. No source below is evidence that Apply Pilot improves interview conversion or can reproduce an employer's private ranking system.

## Repository evidence, read through the connected GitHub integration

**R01 — Remote branch inventory.** Read-only GitHub branch listing confirmed `feature/synthetic-full-workflow-e2e` at `d501ca214c94e52b17d97978e0cd3e3c24819698` and `main` at `92542d4198e8c75061593d8ba6cb12da4fb14723`. No remotely published Greenhouse/multi-ATS branch appeared in that listing. This says nothing about unpushed local work.
`https://api.github.com/repos/muckele/apply-pilot/branches?per_page=100`

**R02 — Existing product inventory and cost controls.** README at the accepted baseline documents document tailoring/export, multiple discovery providers, a capture extension, private multi-user ownership, Answer Vault and AI budget/reservation controls. These are existing surfaces to audit and extend, not proof of commercial release acceptance.
`https://github.com/muckele/apply-pilot/blob/d501ca214c94e52b17d97978e0cd3e3c24819698/README.md`

**R03 — Existing resume scoring and fallback.** `TailoredResumeOutput` has `atsCompatibilityScore` and `jobFitScore`; the inspected schema accepts/coerces model-provided 0–100 numbers. The fallback includes fixed scores and fixed career content. This file alone does not establish actual user-facing reachability or an independent calibrated score.
`https://github.com/muckele/apply-pilot/blob/d501ca214c94e52b17d97978e0cd3e3c24819698/lib/ai/resume.ts`

**R04 — Mandatory repository database safety.** Preserve all existing AGENTS.md rules. Reset tests use the guarded runner; raw reset/dev/db-push and remote test mutation are prohibited.
`https://github.com/muckele/apply-pilot/blob/d501ca214c94e52b17d97978e0cd3e3c24819698/AGENTS.md`

**R05 — Existing roadmap requires reconciliation.** The root PRODUCT_ROADMAP.md describes an older private-MVP feature backlog, not the newly approved multi-ATS/intelligence/copilot/autonomy sequence. Update it deliberately rather than maintaining competing authoritative roadmaps.
`https://github.com/muckele/apply-pilot/blob/d501ca214c94e52b17d97978e0cd3e3c24819698/PRODUCT_ROADMAP.md`

**R06 — Current answer-source restrictions.** The classifier maps CONTACT to MANUAL_ONLY and UNCONFIRMED_APPLICANT_CONTACT; PROFESSIONAL_LINK and AVAILABILITY are proposable, subject to other checks. A writable DOM type does not imply an eligible proposed answer.
`https://github.com/muckele/apply-pilot/blob/d501ca214c94e52b17d97978e0cd3e3c24819698/lib/application-runs/question-classification.ts`

**R08 — Local adoption-time repository inspection. Checked 2026-09-20.** Read-only Git commands verified `/Users/Matt/Projects/apply-pilot` on `feature/form-inspection-answer-packet` at `2e697b0f1b7b4b81358bcc839040380919e724bc`, initially clean and aligned with its configured upstream. The current commit is the merge base and direct ancestor of `d501ca2`, which is four commits ahead in a separate clean worktree. Current source was inspected at `README.md`, `docs/CONTROLLED_APPLICATION_AUTOMATION.md`, `docs/APPLICATION_BROWSER_COMPANION.md`, `lib/application-browser/types.ts`, `lib/application-browser/fill-orchestration.ts`, `lib/application-browser/browser-runtime.ts`, `lib/application-runs/question-classification.ts`, `lib/ai/resume.ts`, and `lib/job-sources/`. This establishes local source/worktree observations only; it is not a fresh test, remote fetch, deployment check, external-research refresh, or security acceptance.

## ATS, parsing and application access

**W01 — Greenhouse Talent Matching / FAQ.** Matching depends on hiring-team calibration and weights; output categories are Strong, Good, Partial, Limited and Needs manual review. Additional keyword occurrences need not improve the category. This contradicts the idea of one universal employer ATS score.
`https://support.greenhouse.io/hc/en-us/articles/41396009937307-Talent-Matching`
`https://support.greenhouse.io/hc/en-us/articles/41131886674075-Talent-Matching-FAQ`

**W02 — Greenhouse unsuccessful resume parse.** Documents parser risks including images, columns, tables, headers/footers and contact details in text boxes; its stated parsing limit is 2.5 MB. This is vendor guidance, not proof that every tenant uses identical downstream screening.
`https://support.greenhouse.io/hc/en-us/articles/200989175-Unsuccessful-resume-parse`

**W03 — Workday HiredScore recruiter productivity.** Grades applicants against required skills and qualifications and provides recruiter filters. This describes a specific optional product surface, not every Workday installation.
`https://doc.workday.com/hiredscore/en-us/workday-hiredscore/recruiter-productivity-/concept--spotlight-filters.html`

**W04 — Greenhouse Job Board API.** Public GET job data is separate from credentialed application submission. Submission requires a Job Board API key; do not treat it as a public jobseeker write API.
`https://docs.greenhouse.io/job-board.html`

**W05 — Lever Postings API.** Public postings include hosted/apply URLs. The documented POST submission API requires an account API key generated by a Super Admin; custom questions are not exposed by the postings API.
`https://github.com/lever/postings-api`

**W06 — Ashby public Job Postings API.** Provides published posting information and application URLs. Public discovery is distinct from authenticated recruiting APIs.
`https://developers.ashbyhq.com/docs/public-job-posting-api`

**W07 — Ashby application submission.** The documented applicationForm.submit endpoint requires candidatesWrite permission.
`https://developers.ashbyhq.com/reference/applicationformsubmit`

**W08 — Ashby authentication and forms.** API access uses keys and endpoint permissions. Forms can be customized per posting and include varied native and structured fields.
`https://developers.ashbyhq.com/reference/authentication`
`https://docs.ashbyhq.com/application-forms`

**W09 — SmartRecruiters application access.** Application endpoints are protected; OAuth scope candidate_applications_manage is required for OAuth access. Public posting access must not be confused with customer/partner write access.
`https://developers.smartrecruiters.com/docs/application-api`
`https://developers.smartrecruiters.com/docs/authentication`

**W29 — Greenhouse hosted versus embedded boards.** Official documentation describes hosted boards and customer-domain iframe integration. The material inspected names boards.greenhouse.io; do not derive a complete current host allowlist from that single document. Add any additional hostname only after current primary evidence and exact-target validation.
`https://support.greenhouse.io/hc/en-us/articles/360020776251-Job-board-URL-for-Greenhouse-hosted-job-board`
`https://support.greenhouse.io/hc/en-us/articles/46365908766875-Embed-a-Greenhouse-job-board-on-your-career-site`

**W30 — iCIMS Job Portal API.** Documents customer-specific portal queries and authenticated requests. It does not establish a universal public applicant submission interface.
`https://developer-community.icims.com/applications/applicant-tracking/job-portal`

## Chrome and agent engineering

**W10 — Chrome activeTab.** Temporary access follows user invocation and is revoked on navigation to another origin or tab closure; useful alternative to broad persistent host access.
`https://developer.chrome.com/docs/extensions/develop/concepts/activeTab`

**W11 — Chrome content scripts.** Isolated JavaScript worlds share the page DOM. Isolation of variables is not a network firewall and does not prevent the page observing changes to its controls.
`https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts`

**W12 — Extension service-worker lifecycle.** Workers are event-driven and may terminate. Persist authoritative workflow state; do not treat memory or a keepalive trick as durable execution.
`https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle`

**W13 — Manifest V3 code rules.** Packaged execution logic is required; remote executable code and remote-command interpreters can violate policy even when transported as data. Use fixed packaged actions and bounded declarative data, with a store-policy review.
`https://developer.chrome.com/docs/webstore/program-policies/mv3-requirements`
`https://developer.chrome.com/docs/extensions/develop/migrate/remote-hosted-code`

**W14 — Chrome permissions and disclosure.** Request narrow permissions for actual features, disclose user-data handling and obtain informed consent. Broad access cannot be justified merely as future-proofing.
`https://developer.chrome.com/docs/webstore/program-policies/user-data-faq`
`https://developer.chrome.com/docs/webstore/program-policies/disclosure-requirements`

**W15 — Codex AGENTS.md discovery.** Codex builds an instruction chain at session/run startup, with directory-specific precedence and a default combined 32 KiB limit. A concise AGENTS entry should point to longer versioned project references.
`https://developers.openai.com/codex/guides/agents-md`

**W16 — Evaluation best practices.** Use task-specific evaluations, representative datasets, human calibration and continuous regression evaluation rather than relying on demonstrations alone.
`https://developers.openai.com/api/docs/guides/evaluation-best-practices`

**W17 — Structured Outputs limitations.** Schema-conforming output can still contain wrong values. Structured JSON is not a factuality certificate.
`https://openai.com/index/introducing-structured-outputs-in-the-api/`

**W28 — Agent safety guidance.** Treat untrusted content as data, constrain information flow and tool authority, and use approvals and evaluations around risky actions.
`https://developers.openai.com/api/docs/guides/agent-builder-safety`

## Market, economics, outcomes and privacy

**W18 — AIApply plans and credits.** Published base plans include $49/month for 100 applications, $99/month for 250, and $199/quarter for 750. The page lists optional tailoring add-ons at $12/month each and says failed/unsupported applications do not consume a credit. Larger upgrade credit packs are not automatically equivalent to recurring monthly tiers. Other help pages disagree on some details; checkout must be revalidated.
`https://support.aiapply.co/en/articles/16864279-how-plans-credits-and-charges-work`

**W19 — AIApply modes.** Documents Review, Hybrid and Auto modes. Help pages differ on Hybrid's threshold (70 versus 75); do not use that inconsistent threshold as a product requirement.
`https://support.aiapply.co/en/articles/14182222-what-are-the-application-modes`
`https://support.aiapply.co/en/articles/15692829-how-auto-apply-works`

**W20 — Simplify+ pricing.** Lists $39.99 for one month and other durations. Price is not evidence of vendor profitability.
`https://help.simplify.jobs/articles/5623502-whats-included-in-simplify-features-and-pricing`

**W21 — Simplify Autopilot credits.** Documents 20 weekly credits, no rollover, successful-submission charging, and tailoring included in the auto-apply credit.
`https://help.simplify.jobs/en/articles/4455305-credits-and-failed-applications`

**W22 — OpenAI pricing reference; v1 named-model scenarios not operationally adopted.** V1 reported named model rates as illustrations. Those exact model labels/rates were not revalidated in v2 and are not a production model registry or budgeting baseline. Recheck current official model IDs, reasoning/cache/tool billing and prices before configuration or spending. The user's Codex UI label is not automatically an API model ID.
`https://developers.openai.com/api/docs/pricing`


**W23 — Browserbase pricing.** Developer plan lists $20/month with 100 browser hours and $0.12/hour overage. Minimum commitments, bandwidth, model/tool charges and utilization affect realized cost. CAPTCHA-solving/stealth features are expressly outside Apply Pilot's recommended scope.
`https://www.browserbase.com/pricing`

**W24 — Stripe U.S. standard prices.** Domestic online cards are listed at 2.9% + $0.30; pay-as-you-go Billing at 0.7% of billing volume. Other products, cross-border cards, taxes and disputes can add cost.
`https://stripe.com/pricing`

**W25 — Stripe usage metering.** Meter events support identifiers/idempotency; keep an independent durable application/credit ledger rather than relying on external processing as the only deduplication mechanism.
`https://docs.stripe.com/billing/subscriptions/usage-based/recording-usage-api`

**W26 — Google restricted-scope verification.** Certain restricted scopes and server-side use/storage can require verification and a security assessment. Gmail expansion should be treated as a separately scoped compliance decision.
`https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification`

**W27 — Resume-writing assistance experiment.** A large randomized online-labor-market study reports about 8% more hiring for treated jobseekers. It studies writing assistance, not Apply Pilot, universal ATS scores, auto-apply, or guaranteed interview improvement.
`https://www.nber.org/papers/w30886`
`https://john-joseph-horton.com/papers/algorithmic-writing-assistance-on-jobseekers-resumes-increases-hires/index.html`


## Fresh repository source in this revision

**R07 — Existing local browser runtime.** Read through the connected GitHub tool at exact d501. It imports Playwright Chromium, launches headed, creates a fresh context/control page, provides cleanup, and reports a missing Chromium installation requirement. It is a local runtime, not a hosted session broker. This read does not establish safety of a future remote provider.
`https://github.com/muckele/apply-pilot/blob/d501ca214c94e52b17d97978e0cd3e3c24819698/lib/application-browser/browser-runtime.ts`

R01 pack-generation result: synthetic branch remained d501 and main remained `92542d4198e8c75061593d8ba6cb12da4fb14723`; no published Greenhouse/multi-ATS branch appeared in the returned list. R04 pack-generation result: existing mandatory database rules were unchanged at the inspected baseline. That research pass did not verify a local worktree or deployment. R08 later verified local worktrees and the adoption checkout without fetching or verifying deployment.

## Managed-browser research rechecked for version 2.0

### MB01 — Browserbase live view
**Checked:** 2026-09-20. **Primary source:** product documentation.
The page documents live viewing/interaction and embedding. It also explicitly notes mobile keyboards are not officially supported in the described live-view flow and describes additional handling. This supports feasibility investigation, not a claim of Apply Pilot Safari/Firefox/mobile parity or secure identity binding. Its example CSS interaction disabling is not adopted as a security control.
`https://docs.browserbase.com/platform/browser/observability/session-live-view`

### MB02 — Browserbase recording/replay controls
**Checked:** 2026-09-20. **Primary source:** product documentation.
Documents video recording by default and `recordSession: false` to disable recording while retaining live view. This does not prove all logs, cookies, files, or provider-held records are absent. Retention and data controls require contract/config verification before real use.
`https://docs.browserbase.com/platform/browser/observability/session-replay`

### MB03 — Browserless hybrid automation
**Checked:** 2026-09-20. **Primary source:** product documentation.
Documents short-lived interactive live links and human handoff; a live-view timeout cannot extend the browser's original absolute session lifetime. A provider event about viewer completion/disconnection is not evidence of employer submission or physical human identity.
`https://docs.browserless.io/baas/monitor-sessions/hybrid-automation`

### MB04 — Browserless advanced hybrid configuration
**Checked:** 2026-09-20. **Primary source:** product documentation.
Documents server-enforced read-only mode using `interactable: false`, clipboard permission requirements, and constrained mobile touch/keyboard behavior. It also describes optional multi-tab UI injection, which must not be enabled blindly against Apply Pilot's DOM/currentness protections. All candidate-specific authority and usability remain to be tested.
`https://docs.browserless.io/baas/advanced-configurations/hybrid-automation-configurations`

### MB05 — Playwright BrowserType protocol requirements
**Checked:** 2026-09-20. **Primary source:** official API documentation.
Documents native `connect` version compatibility and Chromium-only `connectOverCDP`, warning that CDP attachment has lower fidelity than native Playwright protocol connections. This motivates exact protocol tests, not a presumption that all remote browsers fail or all native connections pass.
`https://playwright.dev/docs/api/class-browsertype`

### MB06 — Browserbase session creation API
**Checked:** 2026-09-20. **Primary source:** API reference.
Documents session timeout, keepalive, region, browser-settings and returned connection/session fields. Available options include privacy and automation settings; option availability does not authorize their use. Safe defaults, effective configuration, session isolation and termination need actual integration proof.
`https://docs.browserbase.com/reference/api/create-a-session`

### MB07 — Browserbase price benchmark, refreshed
**Checked:** 2026-09-20. **Primary source:** vendor pricing page.
Developer offer displayed $20/month, 100 browser hours, then $0.12/browser-hour, with separate feature/usage limits. This refreshes W23 for the narrow quoted benchmark. It is not a purchase recommendation, total application cost, or guarantee of future availability. Recheck before procurement.
`https://www.browserbase.com/pricing`

### MB08 — Same-origin restrictions
**Checked:** 2026-09-20. **Primary source:** MDN security documentation.
Explains cross-origin document access limitations. The design implication is to use a distinct controlled runtime/viewer rather than assume an ordinary app iframe can manipulate employer pages. The product must still respect other permissions and site constraints.
`https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Same-origin_policy`

### MB09 — Codex repository instructions
**Checked:** 2026-09-20. **Primary source:** official OpenAI documentation, reached through its documented Codex guide URL.
Describes AGENTS instruction discovery, overrides, and default combined size limits. Keep auto-loaded guidance concise and link to longer references; do not assume every file in docs automatically becomes agent memory. The current guide URL redirected to ChatGPT Learn during this check.
`https://developers.openai.com/codex/guides/agents-md`
`https://learn.chatgpt.com/docs/agent-configuration/agents-md`

### MB10 — Internet Explorer lifecycle
**Checked:** 2026-09-20. **Primary source:** Microsoft lifecycle notice.
States IE11 desktop support ended for specified Windows 10 channels on June 15, 2022, with listed exceptions. This supports choosing current Edge rather than IE as the launch client target; do not generalize the notice to every historical Windows edition.
`https://learn.microsoft.com/en-us/lifecycle/announcements/internet-explorer-11-end-of-support-windows-10`

### MB11 — Browserbase recording terms
**Checked:** 2026-09-20. **Primary source:** provider terms page.
Describes recording consent/notice responsibilities and provider handling. This is a due-diligence input, not legal advice or evidence that Apply Pilot is compliant. Detailed negotiated terms, retention differences across pages/plans, and applicable obligations need review before real applicant data is processed.
`https://www.browserbase.com/terms-of-service`

## Unresolved research / access limits

Two attempted legacy documentation paths for Browserbase session-settings and session-contexts did not resolve through the research tool. No claim relies on those failed pages; the available session API and live/replay docs supply the narrower evidence above. There was no vendor account inspection, hosted runtime test, real applicant trial, full repository audit, or procurement.

Do not convert vendor documentation into measured security or compatibility. Sources support the platform facts summarized here; architecture gates, thresholds, examples, beta sizes and operating rules are Apply Pilot design recommendations. Future agents must recheck sources material to their own task.
