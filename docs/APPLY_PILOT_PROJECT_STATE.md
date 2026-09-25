# Apply Pilot — Project State and Evidence Ledger

Reference checkpoint: 2026-09-24, America/Los_Angeles
**Mutable status record.** Read the root [product roadmap](../PRODUCT_ROADMAP.md) for strategy and the [decision log](APPLY_PILOT_DECISIONS.md) for approved direction. A historical SHA is evidence, never a reset instruction.

## 1. Active product checkpoint

**ACTIVE MILESTONE: P0.4 — GENUINE INTENDED APPLICATION TRIAL.** It has not passed. Mathew must use Apply Pilot on an application he genuinely intends to submit. The intended journey is:

`job discovery/import → evidence-backed fit evaluation → prepare application → inspect employer form → review answer packet → Fill only approved supported fields → manual/sensitive/unsupported completion → Mathew personally activates employer Submit → explicit Apply Pilot attestation`

The immediate blocker for the current unscored candidate workflow is unresolved production-quality `JOB_MATCH` scoring. A successful import with unavailable scoring is an honest saved job, not a usable fit judgment or permission to prepare. The next proposed bounded mission is **`GEMINI_JOB_MATCH_QUALIFICATION`**: evaluate Gemini 3.8 Flash against a frozen small corpus starting with DBeaver and about 4–6 diverse real jobs, using Mathew's approved résumé/profile evidence and the existing conceptual rubric. It is a candidate experiment, without production writes, DBeaver record changes, ApplicationRun changes, employer interaction, or production provider routing changes. Its result does not select a permanent provider.

The technical/self-beta MVP is primarily P0 plus the P1 intelligence needed for genuinely useful applications. Complete P1 quality maturity after initial P0 self-beta evidence. P2 managed no-download delivery is required before claiming broad nontechnical public usability. P3/P4 autonomous execution is outside the immediate MVP critical path.

## 2. Repository and release identity

| Item | Evidence and status | Limit |
|---|---|---|
| Documentation checkout | `/Users/Matt/Documents/ChatGPT/Apply Pilot/apply-pilot-roadmap-state-reconciliation`, branch `codex/roadmap-state-reconciliation`, based on `4644e4f5e117250b4c793efbd4bfac42363ea778` | This documentation candidate is local; it is not pushed, merged, or deployed |
| Cached `origin/main` | `4644e4f5e117250b4c793efbd4bfac42363ea778`; merge tree `961d2bafb0e445d27a687889fdfd11ed8d895e3c`; parents `f5d131c6067d628ac0a0b0386eac0d19da89caf0` and `98d0ce1b1ead87fb8e5b44117a20e557eb645d9f` | Local Git identity verified; the cached ref was copied from an existing checkout. A fresh network fetch was unavailable, so later remote advances are not excluded |
| PR #11 | [Merged GitHub commit](https://github.com/muckele/apply-pilot/commit/4644e4f5e117250b4c793efbd4bfac42363ea778) and [PR](https://github.com/muckele/apply-pilot/pull/11), “Report successful manual imports when match scoring is unavailable” | Public pages and local source confirm merge identity and changed behavior |
| Post-merge CI | [GitHub Actions run 36094635592](https://github.com/muckele/apply-pilot/actions/runs/36094635592) reports Success on `main` at `4644e4f` | CI result, not authenticated production behavior |
| Production deployment | Owner-supplied Vercel deployment `dpl_8TLCy6f5odvdFQNvckynQWmCVcnU` for PR #11 | Not independently queried in this documentation mission |
| Anonymous production health | Owner-supplied `/api/health` HTTP 200, production, version `4644e4f5e117`; `/api/health/readiness` HTTP 200, ready, database/configuration OK; `/dashboard` redirects to authentication; `/api/profile` requires authentication | No authenticated `JOB_MATCH`, ApplicationRun, Fill, or intended-application production flow was tested here |

The older Web-first v2 documentation was an uncommitted candidate on `feature/form-inspection-answer-packet` at `2e697b0`. It is the strategy source for this reconciliation, not the implementation baseline. The root `PRODUCT_ROADMAP.md` on released main still contained the earlier Private MVP feature list before this local documentation change.

## 3. Released implementation through PR #11

The first-parent main history locally confirms the PR #5–#11 merges. “Merged” below refers to source in the `4644e4f` main tree. The owner-supplied deployment checkpoint applies to that tree; it does not make every feature independently verified in its intended production flow.

| Release | Merged capability and boundary | Evidence level |
|---|---|---|
| **#5 — applicant-data integrity** | Unsafe personalized local AI fallback fails closed; fixed persona fallback content removed; discovery relevance separated from applicant fit; stale heuristic-local match reuse prevented; unknown/invalid fit shown as **Unscored**, distinct from real numeric zero | Merged source and prior release evidence; no fresh authenticated production scoring test |
| **#6 — Human-Submit engine** | ApplicationRun services/APIs, protected local browser companion, form inspection/answer packet, reviewed supported-field Fill, permanent one-Fill-attempt boundary, explicit personal-submission completion; browser/PostgreSQL/synthetic evidence | Merged; no employer Submit authority for Apply Pilot |
| **#7 — irreversible human handoff** | Disclosure that employer page scripts can transmit values during Fill; irreversible automation-to-human transfer; distinct human employer submission and Apply Pilot completion attestation | Merged; attestation is not independent employer receipt |
| **#8 — partial ambiguity normalization** | Unique fields survive normalization; all members of an ambiguous duplicate group remain quarantined; ambiguity becomes manual work; all-ambiguous forms do not gain Fill | Merged; no field/source authority expansion |
| **#9 — owner run entry** | Authenticated owner can view an active run and explicitly create a browser run in `DRAFT` | Merged; no automatic preparation, Fill, employer navigation, or submission |
| **#10 — owner pretrial setup** | Owner-facing explicit `PREPARE_ONLY` policy and frozen run-host authorization; preparation is a separate action | Merged; no silent `FILL_AND_REVIEW` grant or automatic employer navigation/submission |
| **#11 — manual import/scoring separation** | JobPosting and Application can persist when optional scoring is unavailable; API represents `scored`, `unavailable`, `failed`, and `not_requested`; UI can open the imported job without fabricating a score | Merged, post-merge CI successful, owner-reported production deployment and anonymous health; unscored preparation gates remain |

**Known PR #11 atomicity limit:** JobPosting and Application writes are separate. An Application persistence failure can leave a JobPosting. The PR did not change AI routing or the `JOB_MATCH` schema.

The Human-Submit browser command set remains `GET_STATUS`, `OPEN_TARGET`, `INSPECT_FORM`, `FILL_APPROVED_FIELDS`, `HANDOFF_TO_HUMAN`, `END_HUMAN_SESSION`, and `CLOSE_WORKFLOW`. Current eligible field families remain `TEXT`, `EMAIL`, `TEL`, `URL`, `TEXTAREA`, and `SELECT_ONE`, under source, review, policy, freshness, ownership, and target constraints. Contact, legal/sensitive, upload, frames, custom widgets, login, navigation, and submission are outside the present automatic write authority. Page scripts may transmit input during Fill. Human employer Submit and later Apply Pilot attestation are separate actions.

## 4. Capability status and next gates

| Capability or claim | Current status |
|---|---|
| Synthetic Human-Submit vertical slice | Implemented and previously reviewed; merged by PR #6 |
| Live read-only multi-ATS characterization | Evidence exists in the repository; it does not prove intended submission |
| Genuine intended P0.4 application | **Planned/active trial; not verified** |
| Production-quality scoring for current unscored candidate | **Blocked pending model/runtime qualification and later production decision** |
| Approved career-fact authority, independently calibrated scoring, validated exported tailored packages | P1 work planned or partial in existing services; not P1-accepted |
| No-download managed browser workspace for ordinary users | P2 planned; no provider selected or hosted execution accepted |
| Hybrid/automatic employer submission | P3/P4 planned; not current authority |
| Public commercial maturity and outcome learning | P5 planned; basic measurement begins earlier |

Lifecycle terms are separate: **planned → implemented → independently reviewed → committed → pushed → merged → deployed → verified in intended user flow**. PR #11 is merged, CI-verified, owner-reported automatically deployed, and anonymously health-verified. Authenticated production `JOB_MATCH` and the P0.4 end-to-end user flow remain unverified.

## 5. Historical documentation provenance

The Web-first v2 reference pack was prepared on 2026-09-20 and locally reconciled as 19 documentation paths in the older checkout. Its [research memo](APPLY_PILOT_RESEARCH_2026-09-20.md), [source register](RESEARCH_SOURCES.md), and archived [adoption prompt](../prompts/CODEX_ROADMAP_ADOPTION_PROMPT.md) preserve dated observations, including a then-current `main` at `92542d4`. Those observations were accurate for their time and must not override the PR #11 release checkpoint above. The original bundle receipt and SHA are historical provenance in the roadmap change log.

For future checkpoints, record exact branch/commit/deployment identities and whether each status was observed in source, independently reviewed, merged, deployed, or verified with the intended user. Keep genuine applicant payload and credentials out of committed evidence. The next bounded mission is `GEMINI_JOB_MATCH_QUALIFICATION`; it is not started by this document.
