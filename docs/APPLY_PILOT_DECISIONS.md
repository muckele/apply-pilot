# Apply Pilot — Decision Log

Version 2.0 | Updated checkpoint: 2026-09-24 | Owner: Mathew

This log distinguishes strategic approval, implementation proposals, and observed evidence. The user's request to update the documents adopts the web-first direction for reference; it does not approve provider procurement, production edits, remote mutation, live applications, or autonomous submission.

## 1. Earlier decisions retained

| ID | Status | Decision | Meaning |
|---|---|---|---|
| D001 | User-approved strategy | Multi-ATS, not Greenhouse-only | Reuse Greenhouse work and broaden evidence, not unrestricted execution |
| D002 | User-approved strategy | Greenhouse/Lever/Ashby priority; Workday characterization | No universal provider-support claim |
| D003 | User-approved boundary | Human-Submit is the current authority model | Agent never activates employer Submit |
| D004 | Approved objective; metrics proposed | Aim for 90+ useful application quality | Internal explained metrics; not employer score or interview odds |
| D005 | Partly superseded by D016 | P0–P5: intelligence, Copilot, hybrid, autonomy, outcomes | P2 extension-first delivery is replaced; other phase intent retained |
| D006 | User-approved strategy | Mathew self-beta before broad commercialization | Measure actual value, not just volume |
| D007 | Research recommendation retained | Begin cost/outcome instrumentation early | Extend current ledger; no new analytics platform by default |
| D008 | Documentation task approved | One canonical roadmap plus concise AGENTS pointers | Preserve existing database and scoped rules |
| D009 | Research recommendation retained | Independent scoring and actual exported-file checks | Model self-scores are not certifications |
| D010 | Resolved for fixed personalized local fallbacks by PR #5 | Fail closed and remove fixed applicant/persona fallback content | Continue broader fact/source audits without implying this removed path remains live |
| D011 | Proposed acceptance model | Provider/host/form/action/runtime evidence matrix | Support is granular and dated |
| D012 | Reclassified optional | Narrow packaged extension executor if built | Not a public-use prerequisite |
| D013 | Future capability design required | Submission grants bind approved facts/materials/target | No auto-submit from subscription, score, or Fill permission alone |
| D014 | Proposed commercial control | Distinct delivered units for credits | Attested completion is not confirmed employer receipt |
| D015 | Retained execution discipline | Risk-matched verification | No full test ladder merely for Markdown or accepted mechanical steps |

## 2. Web-first amendment

### D016 — Core value without a mandatory extension
**Status:** user-requested roadmap adoption in this revision.

The web application is the primary customer product. Users should not have to install Chrome, a browser extension, drivers, or a desktop companion to receive the public managed-application service. An extension may improve capture or assistance in a user's existing browser, but cannot be the only route to core paid value.

**Supersedes:** earlier default P2 title and installation prerequisite, not existing extension code or P0 safeguards.

### D017 — Preferred managed-browser delivery, provider undecided
**Status:** strategic direction adopted; implementation is proposed and gated.

A separate Apply Pilot-managed browser is the preferred public executor. Evaluate vendor-hosted sessions and owned isolated workers. No provider is chosen, no billable session authorized, and no portability/parity claim made. Retain the local companion for self-beta and comparison.

### D018 — Two release definitions
**Status:** adopted planning clarification.

Technical local Human-Submit self-beta and no-download public Human-Submit release are distinct milestones. The latter requires accepted managed-delivery evidence. Do not retroactively call the local technical phase failed or public-ready merely because delivery requirements change.

### D019 — Human control is not a new agent command
**Status:** proposed architecture requirement for P2; current code unchanged.

Remote viewing and human interaction must be separated from automation authority. A human viewer may eventually need pointer/keyboard/file interaction under a user-control grant. The agent retains only approved fixed operations. Shared input APIs must not make human-only controls available to the model or worker policy. Visible UI gating is not enough; enforce ownership server-side.

### D020 — Hosted privacy boundary
**Status:** proposed public-release requirement.

A hosted session is not the user's device. Default toward ephemeral user-isolated contexts, no persistent recordings, minimal logs, and no credential retention unless separately approved. Verify actual provider behavior, plan-level controls, deletion, subprocessors, and contractual terms. “Recording off” does not prove logs, cookies, or server-held data are absent.

### D021 — Cross-browser public experience
**Status:** proposed support target, not tested support.

Target current desktop Safari, Firefox, Chrome, and Edge. Validate shell, viewer, handoff, uploads, clipboard, and recovery separately. Internet Explorer is outside the launch target. Mobile and assistive-technology claims require actual testing; responsive layout is not sufficient.

### D022 — Early bounded feasibility work
**Status:** recommended sequencing, not runtime authorization.

Plan H0 early, alongside—not replacing—P0 multi-ATS work. H1 synthetic hosted sessions require a separate approved environment and budget. Avoid building a complete cloud platform before a protocol/privacy/usability stop/go result.

### D023 — No silent resume/submit recovery
**Status:** retained and made explicit across delivery modes.

A viewer reconnect, worker restart, or provider switch cannot replay an application mutation or renew consumed Fill authority. A lost employer outcome remains unknown until reconciled by permitted evidence. Human attestation and independently confirmed receipt remain different evidence classes.

### D024 — P0.4 first, necessary P1 intelligence pulled forward
**Status:** owner-approved sequencing clarification; 2026-09-24.

The active next product milestone is a genuine intended P0.4 application. Its technical/self-beta MVP is primarily P0, supported by the P1 job-fit and material quality work necessary to make Mathew's actual applications effective. Complete the broader P1 intelligence program after initial P0 evidence. P2 managed delivery remains required for the complete no-download public consumer product. P3/P4 submission autonomy is outside the immediate MVP critical path. This clarifies order without redefining P0–P5 or treating synthetic trials as genuine submissions.

### D025 — Replaceable `JOB_MATCH` model qualification
**Status:** bounded candidate experiment proposed; no production-model decision.

Current unscored candidate flow needs production-quality `JOB_MATCH` scoring before useful P0.4 preparation. `GEMINI_JOB_MATCH_QUALIFICATION` may compare Gemini 3.8 Flash on a small frozen corpus against the existing conceptual rubric and approved applicant evidence. It is an evaluation inside Application Intelligence, not a roadmap phase. It grants no production routing, schema, provider commitment, database mutation, DBeaver re-score, ApplicationRun change, or employer interaction.

### D026 — MVP Bible defines MVP scope and order
**Status:** owner-requested 2026-11-03.

[`docs/APPLY_PILOT_MVP_BIBLE.md`](APPLY_PILOT_MVP_BIBLE.md) defines the MVP as six pillars (master resume, job discovery, tailored documents, apply, tracker, interview prep) delivered through milestones M0–M3. It supersedes the scope and ordering parts of D024 and D025: P0.4 browser-fill acceptance is one part of the Apply pillar rather than the whole critical path, and the pending `JOB_MATCH` qualification becomes a short task rather than a gate. Every safety boundary in this log and in `AGENTS.md` remains.

### D027 — MVP apply mode: the user clicks Submit
**Status:** owner-approved 2026-11-03.

Apply Pilot prepares documents and answers and fills supported fields; the user activates the employer's Submit. Automatic submission is outside the MVP. This confirms D003 for the MVP.

### D028 — Review and land the PR #31–#35 stack
**Status:** owner-approved 2026-11-03.

The evidence-bound generation stack (`codex/job-match-gap-evidence-v33` and its base PRs) is reviewed, repaired to green CI and offered for owner merge.

### D029 — Gemini as the single MVP AI provider
**Status:** owner-approved 2026-11-03.

All MVP AI features run on Gemini through the hard budget ledger. OpenAI and Kimi paths leave the MVP critical path. Model IDs and prices are still recorded per call; this is not a claim about any model's quality.

### D030 — Agent git authority
**Status:** owner-approved 2026-11-03.

Agents may commit to feature branches, push them and open draft pull requests. Only the owner merges to `main`. Agents do not deploy, spend money, interact with live employer pages or submit applications.

### D031 — Edited documents: allow edits, mark them
**Status:** owner-approved 2026-11-03.

Users may edit tailored resumes and cover letters and export them. AI-generated lines keep their fact citations; user-authored edits are marked as the user's own; an edit that changes a factual claim is flagged for the user's review before export. This relaxes the PR #35 rule that any manual edit blocks export permanently. It does not allow AI-generated text without citations.

### D032 — Stay on Gemini 3.8 Flash through the January 2027 price increase
**Status:** owner-approved 2026-11-04.

Google's Standard price for Gemini 3.8 Flash doubles on 2027-01-01, from $0.75/$3.75/$0.075 to $1.50/$7.50/$0.15 per million input/output/cached tokens. Apply Pilot keeps using Gemini 3.8 Flash, and the compiled price registry records both prices. After the increase takes effect, the owner revisits the model choice, including whether to stay on Gemini or move to another AI platform. This confirms D029 until then. So that every feature still fits at the new price, the compiled per-request maximum rises from 10¢ to 15¢ (the largest worst case, `JOB_MATCH`, is about 14.5¢). The $5 monthly hard cap, $1.50 automation allowance and 5¢ confirmation threshold are unchanged.

### D033 — Cover-letter readability: employer lead lines and tense-safe grammar
**Status:** owner-approved 2026-11-06 (PR #60).

Cover letters only; the tailored-résumé grammar is unchanged.

1. **Employer lead line.** Each work record publishes one stock line, built only from that record's own fields: "From <start> to <end>, I was <title> at <employer>." for a past role, or "Since <start>, I have been <title> at <employer>." for the current role. A record with no title, employer or start date, or a past role with no end date, gets no line. The line is allowed only as the first sentence of a paragraph whose every evidence sentence cites that record. The finalizer puts it there, and the claim check rejects it anywhere else. Other stock lines stay allowed anywhere.
2. **Past-tense was/were.** The grammar allows was or were before a passive participle ("I was recognized for …", "I was promoted to …", "<Team> playbooks were adopted by …"). It never allows them before an active résumé verb unless "by" follows, and never allows "I were". The forced "I recognized for …" wording is gone.
3. **Tense tightened.**
   - An added am, is or are needs a present-tense source: the summary, a skill, the current role, or a fact that itself says am/is/are. So "I am a <title>" is allowed only for the current role or the summary.
   - An added I stands only where the verb rule puts it: directly before the fact's own active verb, at the start or after up to three leading framing phrases.
   - Letters that passed before may now fail. The repair rewrites such a claim from its own cited fact when a wording passes, and otherwise removes and reports it ("truth outranks scores").
4. **Employer order** stays résumé order (most recent first).
5. **Prompt version** stays 14.

### D034 — Fill may use the applicant's own confirmed contact details and links
**Status:** owner-approved 2026-11-10, after the first real Greenhouse Fill trial filled only 2 of 19 fields ("The process should be completely streamlined … if some of the information is missing, perhaps we can flag it to the user").

1. **Source.** The owner confirms their application details once on a "Your application details" screen: name, preferred name, email, phone, LinkedIn, GitHub and website. The screen is prefilled from the parsed master résumé and from earlier answers. Confirmed values are stored as ordinary, unmasked Answer Vault rows (contact rows in a `CONTACT` category), so no migration is needed.
2. **Fill authority.** `CONTACT` questions become proposable, like `PROFESSIONAL_LINK`, but only from a confirmed, active, non-sensitive vault row whose question classifies to the same field. A "confirm your email" field uses the confirmed email. A contact field that may belong to someone else (a reference, referrer, emergency contact, manager or recruiter) or to a non-personal channel (work or company email) is never proposable, and neither is an unlabeled field with only an autocomplete hint. This is classifier version 2, so inspections made under version 1 are stale and the form must be inspected again.
3. **Missing details are flagged, never guessed.** With no confirmed value, a contact field stays manual with reason `UNCONFIRMED_APPLICANT_CONTACT`, and the screen lists what's missing.
4. **Nothing else changes.** Each proposed answer is still reviewed. Fill is still one permanent attempt that fills only empty fields. The applicant still clicks Submit. Uploads, dropdown widgets, sponsorship and demographic answers still need their own decisions.

### D036 — Get ready to apply: one Apply page and an A–D grade on every job
**Status:** owner-approved 2026-11-11, after the third live trial stalled in tailoring ("It shouldn't be this difficult … we need to keep this very simple for our users"). Full design: `docs/superpowers/specs/2026-11-11-get-ready-redesign-design.md`. Builds on D035 (PR #69).

1. **One Apply page per job** (`/jobs/[id]/apply`) with one ten-step list: match, your experience, documents, Prepare, then D035's Apply Pilot browser steps. It folds in draft PR #66 and D035's unbuilt UX-5a, 5b, 5c, 6 and 8.
2. **Your experience:**
   - One sentence per requirement, kept in this browser as you type.
   - Checked in the page before anything is sent, with one sentence of at most 200 characters.
   - One "Everything I wrote above is true" tick.
   - **Update my score** only saves the lines and re-scores.
3. **Documents** take one click with the cost shown in the page. A document that's ready to use is attached to the application without changing its status.
4. **Grades A–D on one scale:** A = 85–100, B = 70–84, C = 55–69, D = below 55.
   - A light AI grade (`JOB_GRADE`) covers new jobs that fit the user's preferences, in batches, within daily and monthly limits, after a one-time opt-in.
   - The detailed match replaces the quick grade when you apply.
   - Never called an ATS score. No algorithm grade.
5. **Cost questions only while testing, asked in the page.** `AI_COST_QUESTIONS=OFF` for launch waits for a one-time consent at sign-up.
6. **Unchanged:** Prepare's 85 fit and confidence rule on a current reviewed match, owner-attested facts, Fill and completion rules, server-side cost control.
   - One additive enum value (`JOB_GRADE`), migrated in production only with the owner's explicit authorization.

## 3. Still requires an explicit decision

- Provider/region/account plan, DPA/retention terms, funded experiment budget, and credentials.
- Implementation of a session broker, runtime provider adapter, queue, schema change, or remote worker.
- Exact human navigation handoff and whether/how automation can resume after manual interaction.
- User-directed hosted file transfer; this is distinct from automatic file upload.
- User-directed hosted login/passkey/MFA flow or persistent employer identity.
- Additional writable families beyond confirmed contact details and links (contact-profile values were decided in D034).
- Acceptable mobile/accessibility limitations and release support scope.
- Two-provider narrower beta versus three-provider priority target.
- Any automated submission, legal-answer automation, or unattended operation.
- Actual subscription prices, credit allowances, refunds/rollover, or claimed hiring impact.

## 4. Precedence and amendment record

Apply platform/safety instructions and current explicit user authorization first, then applicable repository instructions and the accepted scoped task. This roadmap supplies strategy and cannot overrule mandatory database rules or an active narrower action limit.

When a newer user authorization explicitly changes scope, record exactly which old restriction it supersedes and which restrictions remain. Do not repeatedly ask for approval already granted. If an enforced tool/workspace access gate still denies the change, stop and report the actual gate; do not bypass it.

Approval of this document permits maintaining this reference. It does not authorize everything described inside it. Future proposals become implementation scope only through an explicit task.
