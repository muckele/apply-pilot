# JOB_MATCH four-job qualification plan

Status: **offline runner and local owner-review workflow implemented; public corpus frozen; private review not completed; provider execution not authorized**

Candidate: Gemini `gemini-3.8-flash`, medium thinking, JOB_MATCH result contract `3`, prompt/cache `3.4`

The earlier reviewed qualification artifacts were produced for prompt/cache `3.3`; they are historical evidence only and do not qualify `3.4`. This change does not authorize or perform another paid qualification run.

Current source baseline: `d60354297bba1919a63309b8c305f28f7d660ab0`

## Purpose and decision boundary

Qualify whether the already-merged JOB_MATCH candidate produces useful, source-backed fit assessments for the owner's P0.4 workflow. This is not another adapter-selection experiment, a permanent provider decision, rubric calibration, a production routing change, or permission to prepare or submit an employer application.

The live phase, if separately approved, is exactly four sequential calls with no automatic retry. DBeaver remains a historic roadmap fixture because no current official posting was verified. The approved public corpus is Laserfiche, Sentry, Flint, and Roku; selecting these evaluation cases is not an application decision.

## Evidence already available

| Evidence | Proven | Limit |
|---|---|---|
| PR #13 JOB_MATCH V3 | Evidence-linked factual matches, exact structured requirement gaps, null-safe compensation, uncalibrated confidence labeling | No paid/live model qualification |
| PR #14 guarded Gemini route | Gemini 3.8 Flash adapter, medium thinking, strict JSON, one request/no retry, budget/cache isolation, readiness reporting | Synthetic provider responses only; production-quality scoring was not accepted |
| Current V9 consumer | JOB_MATCH receives summary, raw source, skills, achievements, work history, projects, education, certifications, and profile preferences | Exact current private projection hashes still require the owner-mediated read-only handoff |
| Real V9 intake, 2026-10-05 | Owner-reported production parse persisted successfully; Gemini configuration reached a different model (`gemini-3.5-flash-lite`) | Does not prove Gemini 3.8 availability or JOB_MATCH quality |
| Current offline qualification suites | Schema, evidence refs, false-gap guards, cache isolation, pricing, no-retry behavior, privacy-safe readiness, no-write orchestration, and a bounded one-shot bridge | Provider transport remains synthetic; private evidence labels and provider quality remain untested |

The historical `ai:evaluate` runner is not accepted evidence. It lives only on an unmerged branch, selected up to twenty mutable database jobs rather than a frozen corpus, predates the current V9 input shape, and used normal database-backed budget/cache persistence. No reviewed result artifact was found.

## Corpus and provenance inventory

The public job projections are frozen in `evaluation/job-match-qualification-corpus.ts`. Private applicant content must never be committed. Page-body hashes preserve the original capture identity. Each case also retains a bounded array of exact, normalized public-source excerpts with its own reproducible hash, so reviewers can verify the source evidence represented by the projection without relying on an unavailable page body. The job-projection hashes are the immutable values used by the runner.

| Slot | Public case and independent expected band | Job projection SHA-256 | Remaining human review |
|---|---|---|---|
| 1 | Laserfiche — Presales Engineer I; `apply now` / likely-fit conditional | `52031f913656015dc6f2b790f2532f0e1f046e949b389e2d0c7c5ef49e2db3bc` | Private evidence refs for education, demos/presentations, work authorization, travel, and Long Beach attendance |
| 2 | Sentry — Solutions Engineer; `consider` / borderline | `ea8651b522a6ff3f6201e2260ab77e6189b62c031b23546c4daf1e155109915f` | Private evidence refs for tenure, project leadership, observability/SDK work, workshops, and San Francisco hybrid constraints |
| 3 | Flint — Customer Success Engineer; `consider` / borderline | `fd86863498043f64aee0ff9357a0607dc04c8ea0d65b439433cc446e454874e1` | Private evidence refs for account/renewal ownership, AI/EdTech work, training, New York City, and onsite sessions |
| 4 | Roku — Technical Account Manager (10909); `skip` / clear gap | `6b0bca5bc8bdd182022ede402fd8aa0679684c3b0a3bcd2862d8a8884147e493` | Confirm the apparent absence of programmatic-advertising, CTV, bidding, ad-server, and related integration evidence |

Applicant provenance required for every slot:

- exact saved-master ID and parse timestamp;
- hash of the exact JOB_MATCH résumé projection, including raw source and structured arrays;
- hash of the exact profile projection;
- owner confirmation that the résumé/profile facts are current enough for this evaluation;
- explicit approval to send those exact applicant and job inputs to Google Gemini for four bounded requests.

Earlier approval to parse the résumé does not by itself approve JOB_MATCH reuse. The older `npm run job-match:qualify:prepare -- --origin=<exact authenticated app origin>` command is a terminal, hash-only checkpoint utility: its process exits after printing the safe draft manifest, so its private projection is gone and cannot be reviewed later. A matching hash proves a later recapture is byte-equivalent at the canonical projection boundary; it does not prove that the old process retained memory.

The owner-facing path is the single-process `npm run job-match:qualify:review` command. It starts a random-token, `127.0.0.1`-only server, requires all three hashes from the earlier safe checkpoint, and admits a new owner-mediated capture only when the draft-manifest, résumé-projection, and profile-projection hashes all match exactly. The complete admitted projection remains in the running loopback process; only the current case is sent transiently to the review tab's DOM. The emitted browser snippet performs only authenticated same-origin `GET /api/resumes/master` and `GET /api/profile`, selects the exact production JOB_MATCH fields, and sends them once to loopback memory. The review screen uses no external resources or persistent browser storage, cannot access a provider key directly, and cannot write a file/database. No Google request occurs before the server accepts the exact execution consent, including explicit permission to activate the existing credential for this run.

```sh
npm run job-match:qualify:review -- \
  --origin=<exact authenticated app origin> \
  --expected-manifest=<prior safe manifest hash> \
  --expected-resume=<prior résumé projection hash> \
  --expected-profile=<prior profile projection hash>
```

For an entirely public local preview, use `npm run job-match:qualify:review -- --synthetic-preview`. The preview uses the committed synthetic applicant fixture and the same command, server, browser screen, validation, attestation, and final-manifest path as real review. It deliberately has no credential activation or provider-execution action.

The safe draft manifest is deliberately `blocked_human_review_required`. In real mode, exact recapture now builds an in-memory, deterministic pre-provider evidence reference and sends the owner directly to exception review. The local classifier considers applicant facts only: qualification support can cite résumé facts, while location, work style, compensation, career goals, and skills-to-emphasize remain preference context and cannot become qualification evidence. The canonical JOB_MATCH factual-match citation allowlist and missing-keyword search are likewise résumé-only; profile values remain available to the model solely for preference-fit context. Candidate evidence is filtered by the requirement category and remains expandable so the local rule is inspectable. Only complete exact degree-credential matches and atomic exact named-skill matches are promoted automatically; partial composite requirements, substring-only matches, absent evidence, and unsupported inferences remain Unknown. Unknown required items produce an owner question only when the posting text contains an affirmative explicit gate such as authorization, sponsorship, or a stated years threshold; negated requirements and statements that sponsorship is available do not create questions. The server binds review-guide v2 to both the exact JOB_MATCH input hash and exact job-projection hash and retains it only in the same loopback process; it is never written to a file or database.

The resulting owner screen is exception-first: it collapses source-backed supported requirements, shows any independently confirmed material gaps, and asks only the locally identified questions that could change the fit decision. The owner does not author a requirement-by-requirement gold guide. Every exact required and preferred item remains expandable together with its category-bounded source candidates. A Yes that introduces experience requires truthful context and becomes a job-specific `USER_ATTESTATION`; it carries explicit no-résumé/no-profile-mutation flags and is never promoted into applicant history. No, Not sure, and Skip preserve unknown status and do not create positive applicant evidence; only a deliberately confirmed guide entry becomes a confirmed gap. The server still validates question order, case order, and the guide/input/job binding. It also requires location, work-style, compensation, a final fit recommendation, rationale, and current-facts confirmation. Application-document approval is explicitly unavailable in this harness and remains a separate gate. After all four owner reviews, the server rebuilds the final manifest and pauses at `ready_for_separate_execution_consent`; `providerCallCount` remains zero and the existing credential has not been read.

The normal review view presents the exact frozen job projection in owner-readable form: company and title, location, work arrangement, listed compensation, captured responsibilities and requirements, source-posting link, and capture date. Missing source fields are labeled `Not listed`; the workflow does not refetch or infer them. Supported evidence, all requirements, candidate facts, and the source résumé/profile remain expandable while canonical refs remain internal to the saved review. The deterministic reference is independent of the provider output and is intentionally narrow; it is an inspectable review aid, not model self-grading or a hiring judgment. The preview is explicitly the captured **source résumé**, not tailored output. JOB_MATCH neither generates nor approves a résumé or cover letter. Any later application workflow must stop at a separate owner gate that presents the formatted tailored résumé and formatted cover letter before either document can be approved or used; implementing that generation/review gate is outside this qualification scope.

Private applicant input lives in the loopback server process and the current case is rendered in the review tab's DOM; the app creates no persistent browser copy. An acknowledged Cancel releases workflow references and clears the rendered view. Navigation clears the DOM synchronously and sends best-effort cancellation; if delivery fails, the server's 30-minute session timeout or process exit is the fallback. After final readiness, only the optional real-mode execution session retains the reviewed preparation; the public synthetic preview releases it. JavaScript cannot promise physical memory zeroization or control browser/runtime internals. The bridge never reconstructs private input from hashes and never performs a later database read. A timeout or navigation/cancel signal closes the workflow, prevents later calls, and requires a fresh exact-equality recapture and review. An already in-flight request may finish at the transport boundary, but it cannot be retried or advance to another case after closure.

The real-mode consent screen now accepts a separate explicit approval bound to the displayed final manifest and this exact running process. It displays and validates Google Gemini as recipient, `gemini-3.8-flash`, prompt/cache `3.4`, the frozen four-case order, no retries, the 290,880-micro maximum reservation, sharing the displayed private applicant/job inputs, use of the existing credential, no database/routing writes, and no employer interaction. Only an exact accepted consent activates the credential callback. The existing runner then makes one call at a time and pauses after each normalized response for local human disagreement review; no later call starts until that review is valid. Completion or failure retains only the bounded safe report. Exiting first invalidates the in-memory handoff and requires recapture.

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

Qualification-level acceptance requires all four cases to pass structural/factual gates, zero unresolved material fabrication, zero wrong-user evidence, a reviewed disagreement log, and retained privacy-safe metadata only. After each response passes the production validator, a required transient review callback receives the full normalized result and exact match input; it may retain only fixed disagreement categories. Four cases can support a P0.4 candidate decision; they cannot establish population-wide calibration or P1 acceptance.

## Bounded live envelope for later approval

- Calls: exactly four maximum, sequential, in the frozen Laserfiche/Sentry/Flint/Roku order.
- Retry: none. Any transport uncertainty, schema rejection, unsupported evidence, or privacy mismatch stops the run.
- Model/prompt: `gemini-3.8-flash`, medium thinking, contract `3`, prompt/cache `3.4`.
- Per-call policy ceiling: 56,000 input tokens and 8,192 total output/thinking tokens.
- Per-call maximum reservation: 72,720 micros (`$0.072720`).
- Four-call maximum reservation: 290,880 micros (`$0.290880`).
- Retained report: hashes, safe job labels/IDs, versions, pass/fail gates, disagreement categories, latency, token counts, cached-token counts, and cost. A failed call retains bounded request/status/billing disposition and known usage/cost metadata when available, including validation failures that may still be billable. Do not retain provider raw output, error detail, or private input in the repository.

The production `/api/jobs/:id/match` route is not used: it updates the job posting and writes AI analysis, usage, reservation, and cache state. The local qualification runner calls the shared prompt builder, dynamic schema, semantic validator, pricing registry, input policy, and Gemini transport directly. It has no budget/cache/job/analysis persistence path. Execution consent must exactly bind the recipient, model, prompt version, manifest hash, four-call count, cost ceiling, private-data sharing, no-retry, no-database-write, no-routing-write, and no-employer-interaction terms.

## Offline readiness before any call

Offline checks confirm source identity, exact prompt/model/schema, pricing validity, input-size preflight, evidence-reference enumeration, local semantic validation, sequential/no-retry behavior, request/response/time/cost bounds, immutable hashes, safe retained metadata, and one-shot projection handling. Configuration remains `configured_unverified`; offline work cannot prove key validity, model entitlement, endpoint reachability, or output quality.

## Stop/go record

The corpus is not ready for live execution until the owner-mediated handoff produces private immutable projection/request hashes, the reviewer completes exact applicant-to-job evidence labels and hash-only attestations against those hashes, the runner review passes, and the owner then gives explicit Google/data-sharing/four-call/no-retry/cost consent for the final attested manifest. Until then, the correct state is **offline runner ready, live qualification blocked**.
