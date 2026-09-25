# Apply Pilot — Application Quality Engine

Version 2.0 | 2026-09-20
**Status:** proposed P1 specification to refine against current source before implementation. No new generator, schema, model routing, source authority, or score threshold is implemented by this document.

## 1. Goal and non-goal

Create a truthful job-specific resume, cover letter, and answer package that is readable, relevant, consistent, and explainably evaluated. Pursue the user's 90+ quality objective without inventing credentials or implying access to an employer's hidden ATS ranking.

ATS hardening has two different meanings: browser/form compatibility and document/requirement compatibility. Neither is a hiring probability. Provider detection can inform documented formatting constraints and test cases; it cannot expose private employer weights or configuration. Official Greenhouse Talent Matching guidance describes configured criteria rather than one universal public numeric score. [W01]

## 2. Audit existing paths first

Read existing resume parse/tailor prompts, `lib/ai/resume.ts`, document generation/export, UI presentation, AI client/ledger, and version storage. Prior source research observed model-returned `atsCompatibilityScore`/`jobFitScore` and fixed fallback persona/content. PR #5 removed unsafe personalized local fallbacks and fixed persona content, separated discovery relevance from applicant fit, and displays unknown fit as Unscored. Continue auditing current invocation, model-returned scores, persistence, exports, and tenant display; do not revive fixed applicant content or claim an incident without evidence. [R02, R03]

Prefer extending the current pipeline and reservation/cost architecture. A new quality label should not create parallel resume truth, inconsistent document versions, or a second uncoordinated AI cost system.

## 3. Score and readiness contract

| Output | Meaning | Proposed target | Non-negotiable caveat |
|---|---|---|---|
| Document compatibility | Actual exported structure/text/readability against declared rubric | >=95 | Local evidence, not certified employer parser equivalence |
| Evidence-backed match | Supported coverage of this job's stated criteria | >=90 for preferred queue | Not employer score, eligibility guarantee, or interview odds |
| Job preference/fit | User's role/location/pay/work constraints and background alignment | User policy, transparent | Do not average away explicit preferences or hard requirements |
| Factual integrity | Every material factual claim supported by eligible user evidence | No unresolved material invented claim | Source-linked is not independent authentication |
| Application readiness | Documents, answers, manual work, consent and approval completeness | Explicit checklist | A missing item is not rescued by a numeric average |
| Execution eligibility | Current policy, exact target, supported action, current approved versions | Allow / review / block | Deterministic authority, not model confidence |

Thresholds are proposed product policy to calibrate. A truthful 84 can be shown for user review; it must not become 93 by keyword repetition, invisible text, made-up experience, or selectively removing unmet criteria.

## 4. Career-fact ledger

Suggested fact fields: opaque fact ID; exact claim; source document/span; employer/project/education context; dates; quantity/unit; skill evidence and recency; source status; user-confirmation timestamp; allowed use; superseded version; and unresolved conflicts.

Use explicit statuses such as imported claim, user-confirmed claim, and independently corroborated record. Do not call all imported or user-approved statements verified. An AI-generated resume is a derivative artifact, not a new factual source. Trace generated bullets back to original eligible evidence.

Capture qualifications accurately: assisting is not leading; coursework is not employment; using an API is not operating the vendor's infrastructure; overlapping roles do not produce additive calendar years; a certificate is not a professional license. Ask for missing facts rather than infer sensitive or legal details.

Before multi-user beta, test wrong-user facts, stale facts, conflicts, future dates, malformed metrics, duplicated employers, and accidental fixed fallback content. A sample person's history must not be the default content for every account.

## 5. Job requirements snapshot

Extract criteria into a versioned structure before generation. Each criterion should have a source span, category, required/preferred/unclear status, alternatives, any explicit prerequisite, matched fact IDs, coverage status, and explanation. Preserve uncertainty when the posting is ambiguous.

Normalize synonyms conservatively. JS and JavaScript can align; JavaScript does not establish Java. Employer language may contain alternatives, approximate seniority, or requirements that do not apply equally; do not invent rigid knockouts from vague prose. Location, compensation, remote eligibility, work authorization and legal answers remain subject to user/source policy.

Freeze the requirement set and evaluation rubric for each revision batch. Changing weights or removing missing criteria to make the score rise is not improvement.

## 6. Generation and independent evaluation

Recommended flow:

`approved facts → job snapshot → evidence mapping → structured draft → factual checks → formatting/export → extract actual file text → independent evaluation → user diff and approval → immutable package`

Use the model for semantic extraction and proposed prose. Use deterministic checks for dates, employers, numbers, units, names and output shape. Use separate semantic/human evaluation for meaning changes and unsupported inference. Structured output validation enforces shape but does not certify correct facts. [W17]

A possible initial match rubric allocates emphasis to required skills, relevant responsibilities/results, domain/seniority, and preferred criteria. Exact weights require adoption and evaluation. Report matched, partially matched, absent, and unknown separately; do not present weights from the old research as a universal ATS model.

The evaluator should not be instructed to “find a way to give 90.” Prefer a frozen evaluator version and an independently labeled holdout. Model self-confidence cannot overrule source restrictions. Where a second model reviews content, it is another fallible check—not independent factual ground truth.

## 7. Resumes, letters, and answers share one package

The resume emphasizes supported experience for this role without changing factual history. A cover letter explains relevance and motivation without inventing company research, personal enthusiasm, relationships, or achievements. Answers use approved source facts and maintain consistency with the documents.

Generate a cover letter when required or genuinely useful; do not pad every application with an unnecessary long letter. The user may reject suggested prose. Keep rejected content out of later automatic variants.

Package identity should include user/job IDs, fact snapshot, requirement snapshot, artifact hashes, approved answer versions, evaluation/rubric/model/prompt versions, timestamp, and approval record. Employer submission, whether human or future autonomous, must refer to the approved version rather than whatever file was regenerated most recently.

## 8. Actual artifact validation

Validate DOCX/PDF output bytes: selectable text, reading order, headings, critical contact and employment entities, dates, layout overflow, page breaks, URLs, unsupported glyphs, accessibility considerations, and actual accepted file types/sizes. Visually render for inspection and reparse through an independent extraction path.

Greenhouse's parser guidance identifies common risks from decorative or complex structure. Use that as vendor-specific risk evidence, not a universal assertion that every table or PDF fails. [W02]

A parseable file can still be a poor match. A well-matched plain-text draft can still export incorrectly. Both checks must pass. Local extraction is a proxy; do not claim it reproduces every tenant's proprietary parser.

## 9. Bounded revision policy

Suggested initial policy: one draft and at most two targeted repair passes, configurable only after evaluation. Stop when requirements are met, no meaningful improvement occurs, evidence is insufficient, the user rejects a change, or cost/time budget is reached. This is a proposed bound, not a current implementation.

Report “best evaluated match achieved with the available evidence and this rubric” rather than asserting an exact mathematical truthful ceiling. Explain unresolved gaps and let the user decide about an otherwise permitted application. Do not turn low internal match into an unsupported claim that a person is unemployable or categorically ineligible.

## 10. Evaluation design

Maintain source-linked test profiles and postings with approved usage, human labels, held-out roles, and protected test fixtures. Cover omitted requirements, keyword stuffing, prompt injection, contradictory evidence, unsupported credentials, wrong-user fallback, chronology, semantic exaggeration, multilingual/unicode edge cases, and export damage.

Measure material factual errors, unsupported claim rate, evaluation disagreement, actual exported-file defects, user edits, revision frequency, latency, and full package cost. Stratify by role family and career stage rather than optimizing only for Mathew's background. Calibrate numeric thresholds before advertising them as predictive.

A randomized resume-writing study offers evidence that writing assistance can help in a particular market, but does not validate Apply Pilot's scores, cover letters, bulk applications, or expected interview lift. Keep that boundary in public claims. [W27]

## 11. Integration with managed execution

P1 package generation should not require a browser session. Precompute approved materials where practical, then start the managed browser near actual use to avoid idle-session costs. Remote execution receives only the approved package and permitted facts, not the full career archive by default.

The source policy and score cannot confer browser authority. User-directed attachment of a resume inside a hosted session requires a separate file-delivery design. A high match score does not authorize uploads, legal answers, CAPTCHA interaction, login, or submission.

## 12. P1 acceptance and unresolved decisions

Before release: demonstrate user isolation, source provenance, no unresolved material fabrication in the release corpus, independent explainable metrics, actual artifact quality, approved package versioning, bounded cost/revisions, useful user review, and calibrated limitations. Preserve evidence of failures and disagreement.

Still open: exact fact schema, evaluator implementation, rubric weights, accepted thresholds, model routes, benchmark size, supported languages, document templates, privacy/retention specifics, and any contact-source expansion. Resolve these in bounded tasks; this document is not an instruction to implement a new subsystem all at once.
