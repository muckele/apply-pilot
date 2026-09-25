# Apply Pilot — Self-Beta, Outcomes, and Unit Economics

Version 2.0 | 2026-09-20
**Status:** proposed measurement and pricing framework. No price, credit allowance, efficacy claim, or paid-provider budget is approved here.

## 1. Validate customer value before scale

Mathew is the first longitudinal user. Measure whether the product accurately prepares materials, saves active effort, handles supported applications reliably, and produces useful outcomes. Do not treat “the browser completed a test” as proof of customer value or “many applications sent” as proof of better hiring outcomes.

Separate technical self-beta using the current local runtime from a no-download hosted usability beta with less-technical participants. The second must demonstrate the delivery decision, not merely the accepted local executor again.

## 2. Define lifecycle units before counting or charging

| Unit | Evidence | What it is not |
|---|---|---|
| Job considered | Imported/deduplicated job record | Application made |
| Package prepared | Validated, versioned artifacts delivered | Form completed or employer receipt |
| Assisted Fill completed | Accepted guarded Fill result | Human manual work done |
| Human-attested submission | Explicit completion ceremony | Independent employer acknowledgement |
| Automated submission attempted | Future approved dispatch intent/action | Confirmed receipt |
| Confirmed submission | Permitted reliable receipt evidence under future contract | Interview invitation |
| Unknown outcome | Ambiguous remote result | Failure that is safe to retry blindly |
| Recruiter response / interview / offer | User-confirmed or authorized evidence | Automatic causal attribution to Apply Pilot |

The unit on an invoice must match the actual deliverable. Keep money and customer credits as separate ledgers. A subscription payment is not a grant to apply to arbitrary jobs.

## 3. Beta stages and proposed sample sizes

**Stage A — technical supervised cohort:** roughly 20–30 genuinely intended applications for workflow usability and critical safety defects. These counts are planning suggestions, not a required quota or reliability proof. Stop immediately for an unauthorized submit, wrong-user data, fabricated material claim, destructive cleanup error, or leaked secret.

**Stage B — operational cohort:** roughly 50–100 suitable applications to learn active time, manual burden, reliability by form/runtime, and cost. Do not force low-fit applications to meet a sample goal.

**Stage C — no-download usability cohort:** a small opt-in group including Safari/Firefox users and people uncomfortable with technical setup. Observe sign-in, profile review, package approval, workspace start, manual control, session recovery, and completion without an extension or terminal. Record where staff help was necessary.

**Stage D — controlled multi-user expansion:** only after privacy, isolation, support, billing, release and declared capability evidence passes. Avoid extrapolating from one person's role mix or accessibility needs.

## 4. Metrics and outcome interpretation

Primary product objective: **qualified interviews per applicant-hour**, accompanied by factual error rate, active minutes per intended application, editing burden, supported-field usefulness, manual-step count, safe-stop rate, duplicates/unauthorized-action incidents, latency, support effort and fully loaded delivered-result cost.

Track role family, seniority, ATS/form variant, runtime/provider, client browser, job age, referral status, profile/package/rubric versions, date applied, follow-up window, and outcome confidence. Keep pending separate from rejection. Users must be able to correct outcomes and delete/export their data under accepted policy.

A small before/after series is confounded by role choice, market changes, timing, and referrals. To compare tailoring, use distinct eligible jobs and predeclared assignment/analysis; never submit two variants to the same employer. Both variants must be truthful and user-approved. Do not claim causality from correlations between internal scores and response rates.

No score is an interview guarantee. The earlier research's writing-assistance result is context-specific, not a product forecast. [W27]

## 5. Instrument cost at the operation boundary

Reuse the existing cost/reservation architecture after source inspection. Record operation ID, user/job/package/run, provider/model and pricing version, token counts, cache/reasoning usage where billed, document processing, browser-session ID, runtime duration, human dwell, egress/storage, safe retries, failed attempts and support cost. Use opaque IDs instead of applicant content in telemetry.

A browser session needs its own reservation and reconciliation lifecycle. Include provisioning failures and termination uncertainty in costs. Do not equate websocket disconnection with stopped billing. A provider session created twice because of an ambiguous response is both a cost and ownership problem.

Suggested decomposition:

`C_total = C_discovery + C_generation + C_evaluation + C_document + C_browser + C_worker + C_storage_egress + C_failed_attempts + C_support + C_payment + C_refunds`

Use the appropriate denominator: prepared packages, assisted completions, or confirmed autonomous results. Count failed-attempt costs in the numerator. Track median and tail behavior; one difficult ATS may dominate support even when average token cost is tiny.

## 6. Browser time model

For a session:

`billable minutes = startup + automated work + human review + idle + recovery + teardown`,

subject to the provider's actual billing contract. Do not count only active Fill milliseconds.

For a hypothetical included-hour plan:

`browser bill = base fee + max(0, total billable hours - included hours) × marginal hourly rate + other metered fees`.

Allocate the base fee once across the actual population/usage. Do not add a full base allocation and also price every included hour at the overage rate unless deliberately making a conservative estimate and labeling it.

One checked benchmark is Browserbase's developer offer: $20/month, 100 included hours, then $0.12/hour. At that marginal rate alone, 5, 10, and 15 minutes cost $0.01, $0.02, and $0.03. Those are **not whole-application costs and do not include the base plan allocation**. Features, limits and terms must be rechecked before purchasing. [MB07]

At 100 monthly applications using a $20 base plan, allocating that base evenly is $0.20/application even if all browser usage fits the included hours. At larger usage, concurrent review sessions and worker/stream costs still matter. Do not claim cheap browser overage proves profitable automation.

## 7. Model usage economics

Use current official rates and actual requested model IDs, not historical chat product labels or v1 illustrative model names. Codex planning model choices are not a production routing recommendation.

`C_model = Σ[(uncached input × input price) + (cached input × cached price) + (billed output/reasoning × output price)] / price unit + tool charges`.

Benchmark inexpensive extraction and routine generation against the same factuality/evaluation corpus. Escalate difficult cases only when measured value justifies it. Do not put Max reasoning on every production request by default. Keep hard reservations and interrupted-call reconciliation; an unknown charge does not become free because a response was lost.

V1 named-model price illustrations are not adopted into the active baseline in v2. Retrieve current official prices and record model/pricing version before any budget or subscription decision. [W22 historical register]

## 8. Pricing sensitivity, not launch pricing

A general capacity formula is:

`max included results = floor(((1 - target margin) × monthly price - payment fees - allocated per-user operating cost) / measured variable cost per delivered result)`.

Use a nonnegative floor and disclose all excluded costs. If support is included in variable cost, do not subtract it again in the allocated allowance.

Purely illustrative inputs: 70% contribution-margin target; a modeled payment/billing fee of 3.6% + $0.30; $3 per subscriber allocated operations; all credits consumed; no taxes, cross-border fees, refunds, acquisition cost, or fixed engineering expense included. The fee number is an **assumption carried from the earlier model, not newly verified pricing in this revision**.

| Monthly price | Variable cost $0.08/result | $0.20/result | $0.50/result |
|---|---:|---:|---:|
| $29 | 54 | 21 | 8 |
| $49 | 120 | 48 | 19 |
| $99 | 285 | 114 | 45 |

These are calculated sensitivities, not promised allowances. Replace inputs with actual self-beta/provider data and stress long-review sessions, failed attempts, refunds, customer support and full utilization. Avoid unlimited automation or economics that only work when customers forget to use credits.

## 9. Credits, fairness, and uncertainty

Reserve credits before eligible work, finalize only for the clearly defined delivered unit, and release/reconcile for unsupported or failed results under a published rule. Guard internal reconciliation against duplicate events. Keep an UNKNOWN state for a possible autonomous submission; do not double-charge or retry automatically while receipt is ambiguous.

For Human-Submit, bill assisted service or package delivery honestly. Do not charge for independently verified employer submission when evidence is only the user's attestation. A pause caused by unsupported fields must be visible before the user consumes unnecessary session time.

Competitor offers are market observations, not cost estimates or proof of efficacy. Historical AIApply/Simplify price entries remain in the inherited source register and must be rechecked against current checkout before comparison. Do not conflate quarterly allowance with monthly or upgrade packs with recurring tiers. [W18–W21]

## 10. Public claims and commercial readiness

Acceptable direction: truthful job-specific materials, declared supported forms, reduced effort demonstrated in beta, and transparent progress. Unacceptable unproven claims: universal 90 ATS, guaranteed interviews, every employer, unlimited safe autonomy, no data leaves the device during hosted use, or confirmed submission from a click alone.

Before paid public managed execution, close usage definitions, cancellation/refunds, privacy and subprocessor disclosures, retention/export/deletion, support ownership, incident handling, spend caps, worker/session cleanup, and browser/ATS limitations. Legal obligations require applicable professional/contract review; the research pack is not a compliance certification.

## 11. Evidence record template

Task/date; approved trial; profile/package/rubric versions; target evidence ID; ATS/form/runtime/client; material edits; eligible/manual fields; active/idle/dwell time; session/account costs; outcome and confidence; errors/pauses; exact delivery unit; user satisfaction; support minutes; privacy-safe evidence references; and next decision.

Do not store real documents, application request bodies, cookies, or applicant identifiers in a general analytics export. Aggregate where possible and preserve deletion behavior.
