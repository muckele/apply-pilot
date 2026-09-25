> **Historical research snapshot (2026-09-20):** Branch and next-task statements below describe the evidence available then. For the PR #11 release and active P0.4 checkpoint, read [project state](APPLY_PILOT_PROJECT_STATE.md).

# Apply Pilot — Research-backed Execution Strategy, Version 2.0

**Prepared:** 2026-09-20, America/Los_Angeles
**Owner:** Mathew
**Purpose:** Execute the approved multi-ATS Human-Submit MVP and the post-MVP intelligence, web-first Managed Application Workspace, hybrid, autonomy and commercialization roadmap.
**Status:** Research and recommended design. Not authorization to implement every phase, submit applications, change production, or spend money.

Source IDs refer to [RESEARCH_SOURCES.md](RESEARCH_SOURCES.md). **Revision provenance:** the scoring, tailoring, ATS, outcome and market sections derive from the supplied v1 memo; version 2 explicitly revises delivery architecture and pricing treatment. Selected repository state and the new MB-series sources were freshly checked; not every inherited W-series source was re-researched. This is a detailed product reference, not a fresh independent security audit. Repository observations, externally documented facts, and proposed product decisions are identified separately. No live employer application was opened or submitted in this research. No repository file was changed, no tests were rerun, and no deployment was performed. The read-only repository inspection was selective, not a new independent code audit.

**Adoption note:** the preceding statement describes preparation of this research memo. During repository adoption later on 2026-09-20, a local read-only inspection added R08 and the memo itself was installed as documentation. That adoption did not re-browse the external sources, rerun product tests, or convert dated/proposed claims into current implementation evidence.

## Executive recommendation

Build a **candidate-controlled application quality and execution system**, not a volume-first application bot. Preserve the accepted execution engine; add reusable quality and browser surfaces around it. The differentiator should be trustworthy evidence, useful application coverage, transparent quality scores, measurable time savings and honest outcome reporting.

Keep the approved phase sequence:

1. Multi-ATS Human-Submit MVP and release acceptance.
2. Application Intelligence and ATS Optimization.
3. Managed Application Workspace / Browser Copilot; extensions optional.
4. Hybrid Agentic Apply.
5. Selective Autonomous Auto-Apply.
6. Outcome Learning and Commercialization maturity.

Two cross-cutting workstreams begin earlier: cost/outcome instrumentation during self-beta, and privacy/safety architecture from the start. Neither requires implementing autonomous submission before MVP. Do not defer all product learning or all potential paid value until full autonomy.

## 1. What exists and should be reused

**Repository evidence.** The connected branch listing confirms `feature/synthetic-full-workflow-e2e` at `d501ca214c94e52b17d97978e0cd3e3c24819698`, while `main` is at a different commit, `92542d4198e8c75061593d8ba6cb12da4fb14723`. A pushed feature branch is not a merge or production release. The listing does not establish any local worktree's current state. [R01]

The accepted baseline's README documents multiple job-discovery providers, resume tailoring, cover-letter drafting, Markdown/DOCX/PDF exports, a review-before-save capture extension, Answer Vault, user ownership and an AI reservation/cost ledger. These should be inspected and extended before new subsystems are proposed. Existing documentation calling some features “private MVP” must not be confused with completing the currently approved Human-Submit release gate. [R02, R05]

**Important audit item.** `lib/ai/resume.ts` accepts model-generated `atsCompatibilityScore` and `jobFitScore` as schema-validated 0–100 values. Its fallback also contains fixed scores and fixed career content. That file is not an independent scoring algorithm, and schema validation is not score calibration. Before broad multi-user beta, trace callers and fallbacks, prove user-specific provenance, and prevent fixed demo content or unevaluated scores from being presented as a real applicant evaluation. This is an audit requirement, not a claim that a cross-user incident has been observed. [R03, W17]

Current classification keeps contact details manual and permits some professional-link and availability proposals. A DOM control being writable does not mean the packet has authority to propose a value for it. Measure actual eligible-field coverage rather than counting supported HTML types. [R06]

**Recommended reuse:** retain the existing ApplicationRun lifecycle, immutable target, short-lived authority, protected browser writer, one-Fill rule, explicit user completion, scoped database runner and cost controls. The next roadmap must change the root `PRODUCT_ROADMAP.md` deliberately and preserve AGENTS.md's existing database-safety section. [R02, R04, R05]

## 2. A defensible meaning for “90+”

**External research.** Greenhouse Talent Matching uses hiring-team criteria and weights and returns categories, not a universal applicant-visible 100-point score. Workday HiredScore describes its own requisition matching and grading behavior. Identifying the ATS therefore does not reveal all employer criteria, purchased add-ons, knockout logic or recruiter judgment. [W01, W03]

**Product decision:** “90+” should mean **Apply Pilot Quality / Match**, with a published versioned rubric. It must never be labeled “the employer's ATS score,” an interview probability or a guarantee that an application will advance.

Use independent outputs rather than one opaque average:

| Output | Meaning | Proposed initial policy |
|---|---|---|
| Parseability | Whether the exported artifact retains text, headings, contact details and chronology in a defined parse test | Target at least 95/100; required-field loss blocks release regardless of score |
| Evidence-backed job match | Coverage of the job's requirements by actual applicant evidence | Target at least 90/100 for the preferred queue; show gaps and uncertainty |
| Claim support | Whether factual statements have an approved source or explicit user attestation | Zero unresolved unsupported material claims before approval |
| Application readiness | Required answers, selected documents, profile freshness and manual work | A checklist/hard gate; do not average away missing requirements |
| Execution eligibility | Supported host/form version, current consent and safe action capability | Boolean allow/review/block, not an LLM confidence number |

All numeric thresholds are **proposed engineering policy**, not empirically proven hiring cutoffs. The user's 90+ objective remains a quality target. A truthful package below 90 is labeled below target and held for human choice; it is never inflated or fabricated to satisfy a counter. Avoid claiming an exact mathematical “truthful ceiling” unless the rubric genuinely supports it; “best evaluated match under the current evidence and rubric” is more honest.

A candidate with no mandatory professional license should not become eligible because formatting, keywords and tone average to 93. Confirmed requirements and unresolved blockers sit outside the average. Requirements can be mistaken, ambiguous or alternative: preserve the quoted source span and distinguish required, preferred and unclear criteria.

### Proposed matching implementation

Extract job requirements into a versioned structured record before tailoring. Each criterion has a source span, category, importance, alternatives, optional explicit hard gate and an evidence assessment. Normalize synonyms without expanding meaning: JavaScript and JS can match; JavaScript does not prove Java; training is not production experience; overlapping jobs do not produce additive years of experience.

An initial transparent match rubric could weight required skills at 40%, responsibilities/results at 25%, domain/seniority at 20%, and preferred criteria at 15%. Missing categories are reweighted under a documented rule, not silently discarded to increase the score. Weights are provisional and are frozen before each tailoring run. Report matched, partial, absent and unknown evidence separately. Protected traits and inferred sensitive attributes are not ranking features.

Use the LLM for extraction and proposed mappings, not for declaring its own success. A separate deterministic evaluator consumes approved mappings, the frozen rubric and the actual exported document. Independently reviewed labeled examples should test precision and disagreement. Hold out some jobs and profiles from prompt tuning. [W16, W17]

## 3. Truth-preserving document generation

**Recommended pipeline:** source profile → job requirements → evidence selection → structured resume draft → factual checks → ATS-aware rendering → export → reparse exported file → independent scoring → user diff/approval → immutable application package.

Create an evidence ledger with source IDs, statement text, dates, employer/project context, proficiency evidence and provenance status. Distinguish imported claim, user-confirmed claim and independently corroborated record. Do not rename “user confirmed” to “verified” without qualification. An approved profile is the source of truth, not a previous AI-generated resume.

Each generated factual bullet references evidence IDs. Deterministic checks catch altered dates, employers, credentials, counts and unsupported numbers. A separate semantic review flags meaning changes such as “helped” becoming “led,” omitted qualifiers, and training becoming employment. Source IDs and model validation reduce risk but do not prove semantic truth; unresolved material claims require user review.

Generate both resumes and cover letters from the same evidence graph. The letter should explain motivation and role relevance without adding new achievements or invented company research. Prefer one high-quality letter when required or useful, not unnecessary long letters for every field. Job-specific answers share the approved evidence and answer history, preventing contradictions between documents and forms.

Use a structured document model rather than asking an LLM to generate arbitrary office-document markup. Conservative templates should be readable to both people and parsers. Follow current vendor guidance where documented; Greenhouse lists graphics, columns and complex header/table layouts as parsing risks. These are risk indicators, not proof that every table fails on every ATS. [W02]

Validate the **actual export**, not merely the model's plain text. Check selectable text, reading order, critical entity preservation, page breaks, overflow, headings, hyperlinks and applicable file constraints. Render for visual review and parse with an independent extraction path. Local parsing success is not a reproduction of an employer's proprietary parser; mark profile evidence as documented guidance, local test, authorized live observation or unknown.

Limit automated revisions (proposed: at most two focused repair passes). Change only identified defects. Stop when the target is met, improvement stalls, evidence is missing or budget is exhausted. Rewriting until the same model reports 90 encourages score inflation.

## 4. Multi-ATS hardening without building six products

Treat three integrations as separate:

- **Discovery:** job feeds, URLs, job text and deduplication.
- **Document compatibility:** formats, parser tests and documented vendor constraints.
- **Browser execution:** exact host, form variant, field families, navigation, manual work and submission handoff.

An API for reading jobs does not grant application write access. Greenhouse's submission API requires a Job Board key; Lever's POST API requires an employer-account API key; Ashby's submission endpoint requires candidatesWrite. SmartRecruiters similarly protects application endpoints. A consumer tool must not assume those credentials or reverse-engineer a private endpoint as a shortcut. Use approved hosted workflows now and explicit partner/customer integrations only when legitimately available. [W04–W09]

**Approved priority:** Greenhouse, Lever and Ashby are pre-MVP hardening targets. Workday gets characterization and safely authorized inspection first; complete support only if a form fits current authority. SmartRecruiters and iCIMS are discovery/characterization/manual-fallback targets. Workable remains a discovery surface already documented by the repository; promote browser hardening based on actual user demand and evidence, not a promise to cover every provider. [R02]

Represent compatibility by **provider + exact host + form variant + locale + tested action**, not one “supported” flag. Suggested dimensions: detect, import, open, inspect, propose, fill, preserve, upload-manual, submit-handoff, complete-attestation. Evidence states: unknown → local-characterized → live-inspected → assisted-trial-verified → limited-supported. A known out-of-scope form remains manual even if its provider has supported variants.

Build provider-neutral fixtures first and small adapter metadata only for proven recurring differences. Do not create a general browser scripting language or a separate workflow engine per ATS. Reuse one form identity/policy/writer core.

Two existing project risks deserve early local tests: page handlers may transmit values on input/change before Submit, and the immutable target guard may block real human confirmation navigation. The prior synthetic success path used an in-page submission; it is not evidence for navigational submissions. Characterize locally before a real trial, preserve the guard, and require a distinct handoff design if a real flow needs it. Do not discover this first during a high-value application.

For supported claims across all three priority providers, require an authorized intended-application trial for each claimed form family. Two providers can support a clearly labeled narrower beta if Mathew approves that scope; the third must remain “inspection only” until its trial passes. No silent downgrade from the approved three-provider target.

## 5. Browser architecture: hybrid intelligence, deterministic execution

Compare three designs:

| Design | Benefit | Cost/risk | Decision |
|---|---|---|---|
| DOM-only deterministic execution | Auditable, inexpensive, repeatable | Limited on ambiguous/custom flows | Execution foundation |
| Unconstrained visual/computer-use agent | Broad exploratory capability | Harder to constrain, variable latency/cost, wrong-action risk | Not the core applicant executor |
| AI interpretation plus typed deterministic actions | Semantic flexibility with constrained authority | Requires explicit schemas, evaluations and abstention | Recommended |

Treat job descriptions and employer DOM as untrusted data, including instructions aimed at agents. A page cannot change the user's preferences, facts, budgets, destinations or capabilities. Models propose typed answers or classifications; deterministic code decides whether execution is allowed. [W28]

### Web-first Managed Application Workspace — adopted direction

The revised default is a web application with a separately managed application browser. The user's Safari, Firefox, Chrome or Edge is the client/control surface; the executor may be a remote isolated Chromium session. The current repository already has a separate local headed Chromium runtime; it is not an extension executor. Keep that accepted local path for technical self-beta and parity comparison. [R07]

A required extension or desktop download conflicts with the intended low-technical-friction public journey. An optional extension can later help inside a user's existing session, but is no longer the P2 dependency. Multi-browser WebExtensions do not remove installation, permission or platform-maintenance work. The product itself should deliver core value without them.

Compare three delivery candidates: preserve local companion for self-beta; evaluate managed sessions with an interactive viewer for public delivery; or operate an owned isolated browser worker if vendor constraints prevent required protections. Do not build active multi-provider failover until one narrow runtime is proven.

### What fresh primary evidence establishes

Browserbase and Browserless document interactive remote browser delivery. Their documents establish possible surfaces, not our security/UX parity. Browserbase identifies mobile keyboard limitations; Browserless documents live-session duration limits and server-enforced view-only controls. Apply Pilot still needs owner-bound access, direct-link revocation, exclusive actor control, client-browser tests, and accessible manual fallbacks. [MB01, MB03, MB04]

An employer iframe inside an ordinary webpage is not equivalent to this remote-runtime design. Cross-origin access is restricted. Embedding a remote viewer embeds the viewer surface; it does not exempt the application from employer policy or browser security. [MB08]

Playwright's documented protocol distinction is material: remote CDP connectivity alone does not prove the protected-world/routing/currentness behavior relied on by the accepted executor. Test the actual pinned versions and required capabilities. [MB05]

### Delivery migration is a trust-boundary project

“Browser-local” in a hosted design means data may exist on provider infrastructure. It does not mean the information remains on the user's laptop. Browserbase's default recording and disable control make privacy configuration a concrete acceptance requirement, not a future disclaimer. Inspect logs, cookies, uploaded files, support access, regions, and deletion separately; disabling video is not a complete retention proof. [MB02, MB06, MB11]

Proposed architecture: web shell and package review; backend policy/ApplicationRun authority; scoped session broker; durable execution worker; provider adapter; separately authorized human viewer; cost/outcome ledger; owned-session reconciler. These are responsibilities, not a mandate for a distributed platform or eight services.

Automation retains only fixed approved commands. Revoke writes before human input begins; bind access to user/run/session/page and a current ownership epoch; invalidate stale form authority; do not issue a second Fill after takeover. A remote “Submit for me” command is automatic submission, not Human-Submit. The person must activate the employer control in the human channel under a separately designed handoff.

### Important unresolved feasibility checks

The local runtime's guard may reject real human confirmation navigation. A remote session may not expose the supported file chooser, passkeys, or user login context. Human viewer URLs may be reusable bearer credentials. A disconnected automation channel may leave an active paid browser. Cloud workers cannot reach a developer's loopback server by default. These are specific probe/design questions, not reasons to weaken policy or open a development tunnel without authorization.

Keep P0 technical acceptance distinct from no-download public acceptance. Plan H0 early; run H1 only under an explicit synthetic environment and budget. Public claims require current client-browser, privacy, human-control, hosted runtime, cleanup and cost proof. See the [workspace brief](MANAGED_APPLICATION_WORKSPACE.md) and [provider evaluation](MANAGED_BROWSER_PROVIDER_EVALUATION.md).

### Optional extension remains a separate surface

If later built, reuse current capture work, request narrow user-invoked permissions, package finite logic, retain backend authority across worker restarts, and independently review its shared-DOM boundary. Do not ship arbitrary model-written JavaScript or assume content-script isolation is the protected CDP model. This work is optional and must not block core public access. [W10–W14]

## 6. Autonomy must be a new, explicit capability

Do not make current Human-Submit code submit by switching one flag. The MVP's no-submit guarantee is still active. Future Hybrid and Autonomous modes require separately approved protocol/state changes, a threat model, rollback and pilot evidence.

A future submission grant should bind the user, canonical job/target, exact approved document hashes, answer packet version, declared submission action, expiry and action limit. Revalidate just before dispatch. Do not infer permission from a high score, a matching job, an earlier Fill, or a subscription purchase.

External employer submission usually cannot be made globally “exactly once” by Apply Pilot alone. If a request succeeds remotely but its response is lost, retry can duplicate an application. Use at-most-once dispatch intent, durable local state and an explicit uncertain result; reconcile with permitted evidence rather than blindly replaying. Keep future submission evidence distinct from the current user-attested COMPLETED_BY_USER state. A receipt is evidence of a technical event, not a hiring decision.

Pause on CAPTCHA, unfamiliar forms, sensitive questions, consent/attestation choices, employer login, contradictory data, policy restrictions, changed target, unsupported upload, low-confidence mapping or ambiguous outcome. The roadmap does not authorize anti-bot evasion, identity deception or automatic legal assertions. Workday-specific multi-step and session support is a later bounded capability project, not a loophole around current restrictions.

## 7. Self-beta and proof of actual benefit

Mathew should be the first longitudinal user. Start with a small supervised technical cohort, then a larger qualified-job cohort. Suggested pilot: 20–30 intended applications for workflow/UX, followed by 50–100 for time and operational behavior, then an opt-in multi-user beta. These are planning ranges, not statistically sufficient proof of interview improvement.

Log job/role family, provider/form version, profile version, package hashes, score versions, user edits, manual minutes, outcomes, costs and failure classifications. Keep aggregate metrics de-identified where possible. Separate technical completion from candidate response and interview outcomes.

Primary value metric: **qualified interviews per applicant-hour**, accompanied by time per approved application, material factual-error rate, duplicate/unauthorized action incidents, observed field accuracy, safe-stop rate, support burden and cost per successful outcome. Do not optimize applications/day alone.

For tailoring evaluation, compare the strongest current resume with the tailored version, only where both are truthful and user-approved. Randomize across distinct eligible jobs within similar role/seniority/source strata where practical; never submit duplicate variants to one employer. Prespecify the follow-up window (for example 30 days), keep pending outcomes separate from rejection, record referrals and allow uncertain outcome labels. A single person's before/after comparison is confounded by role mix, timing and market conditions.

There is credible evidence that better writing can help: a large randomized online-labor-market study reports roughly 8% higher hiring for resume-writing assistance. That does not establish that a 90+ score, keyword matching, cover-letter generation or bulk applying improves this product's interviews. Apply Pilot needs its own evidence. [W27]

Zero errors in a small pilot is not a reliability guarantee. Under independent comparable Bernoulli trials, zero incidents in 100 observations still permits roughly a 2.95% one-sided 95% upper bound; 300 gives about 0.99%. That is a mathematical illustration, not a sufficient automation certification. Use much larger synthetic/adversarial suites and strict incident stops alongside live pilots.

## 8. Unit economics and honest credits

AIApply documents $49/month for 100 applications and $99/month for 250, plus optional tailoring add-ons; Simplify+ documents $39.99/month and an Autopilot allowance of 20 successful applications weekly with tailoring included. Vendor help pages can conflict on thresholds or upgrades, so validate checkout before any pricing decision. These prices show offers exist, not customer counts, margins or efficacy. [W18–W21]

Correct the earlier benchmark interpretation: AIApply's larger “buy more credits” amounts must not all be described as recurring subscription tiers. Quarterly 750-credit pricing is also not 750 credits every month. Compare equivalent deliverables and billing periods.

### Updated cost treatment — measured inputs, not historical model labels

Version 1 included named-model token-price scenarios. They are not carried forward as current routing or budget facts: this revision did not independently revalidate those exact labels/rates. Use current official model IDs and rates, measured token/reasoning/cache/tool usage, and a dated pricing registry before spending. A Codex architecture-model preference is not a recommendation to use Max reasoning for every user application. [W22 provenance note]

Fresh browser pricing research shows a Browserbase developer offer of $20/month with 100 browser hours and $0.12/hour overage. At that marginal rate, ten minutes is $0.02, but allocating a $20 minimum across 100 monthly applications is $0.20/application before other costs. Neither number is whole-product cost. Review time, worker/streaming costs, concurrency, provider failures and idle sessions matter. [MB07]

The managed-browser change makes dwell time especially important. Prepare packages before browser allocation where practical, start sessions near actual use, and do not assume session suspension preserves unsaved employer fields. Measure automation, manual review, idle, reconnect and cleanup duration separately.

Track distinct money and customer-credit ledgers. `Cost per delivered result = all relevant successful/failed/allocated operating costs divided by delivered units`. A prepared package, assisted Fill, human-attested application and confirmed autonomous receipt are different units. Count support/refunds/payment fees and do not double-count fixed allocation with marginal fees. See [self-beta and economics](SELF_BETA_AND_UNIT_ECONOMICS.md).

### Subscription sensitivity model

**Illustrative assumptions only:** 70% target contribution margin; U.S. domestic-card Stripe + pay-as-you-go Billing at 3.6% plus $0.30 per monthly charge; $3/user/month allocated support/hosting allowance; full credit utilization. Taxes, cross-border fees, refunds, acquisition spend and fixed development expense are excluded. The fee inputs are historical assumptions from v1 and were not freshly revalidated in this revision. Recheck before pricing decisions. [W24]

`maximum included outcomes = floor((0.30 × monthly price − payment/Billing fees − $3) / variable cost per delivered outcome)`

For this table only, variable cost includes the per-outcome model/browser/discovery/failure burden but excludes the separately allocated $3 support/hosting amount and payment fees. Do not count those expenses twice.

| Monthly price | At $0.08/outcome | At $0.20/outcome | At $0.50/outcome |
|---|---:|---:|---:|
| $29 | 54 | 21 | 8 |
| $49 | 120 | 48 | 19 |
| $99 | 285 | 114 | 45 |

The lesson is not “sell 120 for $49.” It is that promised volume must depend on measured variable and allocated fixed costs, full-utilization stress testing and delivered value. Avoid unlimited automation and pricing that depends on customers forgetting to use credits.

Separate deliverables: a prepared package credit, an assisted workflow entitlement, and a future confirmed automated-submission credit. Do not sell “successful auto-applications” while the product only records user attestation. Reserve credit before eligible work, finalize exactly once for the declared delivered outcome, release for failure/unsupported outcomes, and show uncertain submissions explicitly. Stripe metering is downstream of an internal durable ledger; external idempotency is not the only duplicate-billing defense. [W25]

Commercialization can begin with paid tailoring/Copilot after evidence of value; full autonomy is not required to charge honestly for a useful assisted product. Offer transparent cancellation and stop/paused states. Track satisfied churn after getting hired separately from dissatisfied churn; do not incentivize keeping jobseekers subscribed unnecessarily.

## 9. Privacy and operational foundations

Before accepting outside users, audit tenant isolation, fallback content, secret handling, deletion/export, document URLs, retention, logs and support access. Prefer no raw DOM, tokens or application values in analytics. Collect optional sensitive information only for a declared purpose and require user decisions where appropriate. Separate consent to provide the service from any later training/research reuse.

Make Gmail optional. The existing project documents a read-only integration; expansion can trigger Google's restricted-scope verification and security-assessment requirements depending on scope and handling. Begin outcome tracking with manual status or explicitly chosen confirmations rather than requiring broad mailbox access to use the product. [R02, W26]

Review provider terms and Chrome policies before each newly enabled automation surface. Site accessibility and a user subscription are not credentials for employer APIs. Partner access can be a later commercial route; do not assume a contract already exists.

## 10. Execution process that avoids endless review loops

Maintain one root product roadmap, one current-state file, one acceptance matrix and an append-only decision log. Add a concise AGENTS pointer without replacing database safeguards. Codex discovers AGENTS instructions at startup and has a default combined size cap; a giant prompt alone is not durable project memory. [W15]

Use bounded checkpoints: plan → implement with behavior-level RED/GREEN → evidence-matched independent review → separately authorized commit/push/release. Map test runs to changed risk. A docs-only step should not require the entire database/browser ladder; changes to execution, authority, scoring or state should. Reuse byte-identical accepted evidence during mechanical commit/push steps.

Do not freeze old SHAs as permanent future branch requirements. Record the accepted baseline and verify ancestry/local changes at each task. Never reset a worktree to match an old prompt. A future roadmap feature is not an active capability grant, and an explicit newer scope authorization supersedes an older task-level restriction only where clearly specified and consistent with repository/system safety.

This memo's documentation-only reconciliation checkpoint is now represented by an unstaged candidate in the repository. After human review, the recommended next bounded task is source-led Multi-ATS Characterization planning from the actual local state, reusing Greenhouse/Lever/Ashby discovery work and any other relevant progress already present. Do not create duplicate infrastructure, discard local work, or start autonomous submission.

## Research limitations

No employer-side scoring model was obtained. No applicant-facing API permission was assumed. No real ATS form trial, private local worktree inspection, product conversion experiment or vendor profitability analysis was performed here. Repository review covered selected files and remote refs only. Estimates and gate thresholds in this document are proposed product policies requiring measurement. Dates and source prices must be refreshed before procurement, launch and any expanded automation authority.


## Version 2 execution priorities and research limits

The references have been reconciled as an unstaged documentation candidate. The next task should inspect current local multi-ATS work and select one bounded characterization plan. H0 managed-delivery feasibility planning can instead be separately approved early without authorizing vendor sessions or replacing the accepted local runtime. No required extension; no automatic submission in Human-Submit; no provider selected by this memo.

The active product roadmap is [PRODUCT_ROADMAP.md](../PRODUCT_ROADMAP.md). Detailed implementation proposals are in the workspace, quality, economics, matrix and release briefs. The source register explicitly marks inherited v1 entries and new MB checks. No remote runtime, browser accessibility, production rollout, interview uplift or subscription profitability was experimentally validated while writing this revision.

This version does not retroactively invalidate accepted local evidence. It introduces explicit additional hosted/public-delivery gates and preserves unresolved questions rather than answering them with untested architecture claims.
