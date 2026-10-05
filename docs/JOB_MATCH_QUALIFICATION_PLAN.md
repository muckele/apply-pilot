# JOB_MATCH four-job qualification plan

Status: **prepared only; corpus not frozen; provider execution not authorized**

Candidate: Gemini `gemini-3.8-flash`, medium thinking, JOB_MATCH result contract `3`, prompt/cache `3.1`

Current source baseline: `534d3797a43baa899d78b8696c4b68aeb9df1f72`

## Purpose and decision boundary

Qualify whether the already-merged JOB_MATCH candidate produces useful, source-backed fit assessments for the owner's P0.4 workflow. This is not another adapter-selection experiment, a permanent provider decision, rubric calibration, a production routing change, or permission to prepare or submit an employer application.

The live phase, if separately approved, is exactly four sequential calls with no automatic retry. DBeaver is a roadmap-named starting candidate, but it is not frozen by this plan. Every job remains unselected until the owner confirms the exact posting and provenance.

## Evidence already available

| Evidence | Proven | Limit |
|---|---|---|
| PR #13 JOB_MATCH V3 | Evidence-linked factual matches, exact structured requirement gaps, null-safe compensation, uncalibrated confidence labeling | No paid/live model qualification |
| PR #14 guarded Gemini route | Gemini 3.8 Flash adapter, medium thinking, strict JSON, one request/no retry, budget/cache isolation, readiness reporting | Synthetic provider responses only; production-quality scoring was not accepted |
| Current V9 consumer | JOB_MATCH receives summary, raw source, skills, achievements, work history, projects, education, certifications, and profile preferences | Saved structured-array readback is not production-verified until the new read-only view is deployed and inspected |
| Real V9 intake, 2026-10-05 | Owner-reported production parse persisted successfully; Gemini configuration reached a different model (`gemini-3.5-flash-lite`) | Does not prove Gemini 3.8 availability or JOB_MATCH quality |
| Current offline qualification suites | Schema, evidence refs, false-gap guards, cache isolation, pricing, no-retry behavior, and privacy-safe readiness | Provider transport is stubbed; no human-labeled real-job corpus |

The historical `ai:evaluate` runner is not accepted evidence. It lives only on an unmerged branch, selected up to twenty mutable database jobs rather than a frozen corpus, predates the current V9 input shape, and used normal database-backed budget/cache persistence. No reviewed result artifact was found.

## Corpus and provenance inventory

No four-job corpus is frozen yet. Private applicant or job content must not be committed.

| Slot | Current candidate state | Required provenance before freeze |
|---|---|---|
| 1 | DBeaver is named in the roadmap only; exact posting unverified and not selected | Owner confirmation; saved job ID; source URL; captured-at time; immutable job-input hash; confirmation that the posting may be used for this private evaluation |
| 2 | Unselected | Same fields; materially different fit/gap profile from slot 1 |
| 3 | Unselected | Same fields; materially different fit/gap profile from slots 1–2 |
| 4 | Unselected | Same fields; include a clear-gap or sparse-evidence control if the owner selects one |

Applicant provenance required for every slot:

- exact saved-master ID and parse timestamp;
- hash of the exact JOB_MATCH résumé projection, including raw source and structured arrays;
- hash of the exact profile projection;
- owner confirmation that the résumé/profile facts are current enough for this evaluation;
- explicit approval to send those exact applicant and job inputs to Google Gemini for four bounded requests.

Earlier approval to parse the résumé does not by itself approve JOB_MATCH reuse. The read-only master endpoint may be used to verify the résumé projection after deployment, but this plan does not authorize that deployment or any production request.

## Frozen human rubric

Before any provider call, an owner/reviewer must complete the following for each selected job. Do not set a target score and then label evidence to reach it.

1. **Requirement snapshot** — exact required and preferred strings, with stable array indexes.
2. **Expected supported evidence** — exact allowed applicant ref(s), exact excerpt(s), and the exact job ref(s) they support.
3. **Expected material gaps** — the complete requirement string, keywords genuinely absent from all submitted positive applicant evidence, and whether the gap is required, preferred, or uncertain.
4. **Unknowns** — ambiguous posting language or missing applicant evidence that must remain unknown rather than matched or missing.
5. **Preference checks** — location/work style and compensation only where both sides provide evidence.
6. **Recommendation band** — `apply now`, `consider`, or `skip`, with human rationale independent of the model score.

Per-case acceptance requires:

- HTTP success, finish reason `STOP`, usage within policy, and valid V3 JSON;
- every factual match resolves to allowed exact refs and source-contained excerpts;
- no skill marked `skillsNotToExaggerate` supports a positive match;
- every reported gap preserves a full structured requirement and does not mark an applicant-supported keyword missing;
- all human-labeled material gaps are reported or explicitly recorded as a reviewer disagreement;
- compensation remains unknown when either side lacks salary evidence;
- advice is clearly advisory and contains no new qualification claim;
- recommendation is defensible against the frozen human rationale without treating the model's confidence as calibrated.

Qualification-level acceptance requires all four cases to pass structural/factual gates, zero unresolved material fabrication, zero wrong-user evidence, a reviewed disagreement log, and retained privacy-safe metadata only. Four cases can support a P0.4 candidate decision; they cannot establish population-wide calibration or P1 acceptance.

## Bounded live envelope for later approval

- Calls: four maximum, sequential; DBeaver first only if the owner freezes it.
- Retry: none. Any transport uncertainty, schema rejection, unsupported evidence, or privacy mismatch stops the run.
- Model/prompt: `gemini-3.8-flash`, medium thinking, contract `3`, prompt/cache `3.1`.
- Per-call policy ceiling: 56,000 input tokens and 8,192 total output/thinking tokens.
- Per-call maximum reservation: 72,720 micros (`$0.072720`).
- Four-call maximum reservation: 290,880 micros (`$0.290880`).
- Retained report: hashes, safe job labels/IDs, versions, pass/fail gates, disagreement categories, latency, token counts, cached-token counts, and cost. Do not retain provider raw output or private input in the repository.

The production `/api/jobs/:id/match` route is not an evaluation runner: it updates the job posting and writes AI analysis, usage, reservation, and cache state. A future live qualification requires a separately reviewed private runner and isolated non-production accounting path, or separate authorization that explicitly changes the no-write boundary.

## Offline readiness before any call

Offline checks may confirm current source identity, exact prompt/model/schema, pricing validity, input-size preflight, evidence-reference enumeration, local semantic validation, no-retry behavior, and configuration state. Deployment readiness intentionally reports configured credentials as `configured_unverified`; it cannot prove key validity, model entitlement, endpoint reachability, or output quality without a provider request.

## Stop/go record

The corpus is not ready for live execution until all four rows have owner-selected job provenance, private immutable input hashes, completed human labels, explicit Gemini data-sharing approval, a reviewed runner, and a separately approved maximum budget. Until then, the correct state is **offline ready, live qualification blocked**.
