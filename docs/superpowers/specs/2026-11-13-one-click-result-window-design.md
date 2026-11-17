# One button, one result window, no prices (G-6) and "Did you apply?" in one click (G-7)

Approved by the owner on 2026-11-13 ("Yes, keep both calls"). MVP Bible goals G-6 and G-7 (decision D037).

## Why

In the live trial the owner clicked "Update my score · about 8¢", missed the second in-page "Update my score?" box, and thought the score had run. The owner's test for every screen: "There should be less touch points. And more ease of access." Apply Pilot will be a flat-fee subscription, so prices per click are wrong for users anyway.

## Goals

- No cents and no per-click cost question anywhere on the Apply page. The hard monthly AI cap and the 15¢ per-request ceiling stay as hidden server guards.
- The user is told once, per account on each browser, that Apply Pilot sends their data to Google Gemini. After "Continue", clicks just run.
- Step 2 has one button. When the user wrote a line, the button reads "These are true · update my match" and the click is the truth attestation (it replaces the tick). Otherwise "Update my match". With nothing written on a master-résumé score: "Nothing to add", which saves the review without a second paid score.
- After every score, one large accessible window (native `<dialog>`: focus moves in, Esc closes, full width on phones) shows the result:
  - A: big grade and score, one line on why, "Create my résumé and cover letter", "Not now".
  - B: grade, the one or two missing requirements, Create, "Add my experience first" (goes to step 2), "Find better-fit jobs" (Jobs page).
  - C/D: "This may not be a good fit. Let's look at other jobs." One button to the Jobs page, and a small "Apply on my own" link. Nothing is created.
  - A credit line ("Uses 1 credit · N left") and an out-of-credits → upgrade route are slots that stay hidden until a real credit source exists.
- An A (or B) on the first score skips step 2: Create saves a "nothing to add" review of exactly that score, then writes both documents. No second paid score.
- "Did you apply?" uses the same window; "Yes, I applied" records Applied in one click with the attached documents.

## Non-goals

- Billing, plans, credits, upgrade pages (separate project, paused under D037).
- Other pages that still ask with cents or `window.confirm` (résumé upload, interviews, job list). AI Controls keeps its cost view.
- Any schema change, and any change to how tailored content is generated.

## The shared current-score rule

One rule in `lib/jobs/current-job-match.ts` decides whether a saved JOB_MATCH answer is current for the evidence in force:

- REVIEWED_EVIDENCE (unchanged): bound to the current reviewed snapshot, on exactly the input that would be sent now.
- NOTHING_TO_ADD (new): the current snapshot reviewed exactly this unbound answer and added no lines, and the answer's input equals the unreviewed input one generation earlier. Gemini saw exactly what the review left in force, so a second score would be asked the same question. This is the proof the display-only `MASTER_RESUME_NO_NEW_FACTS` basis already used.

It replaces the separate checks on the job page, in Prepare (gate and post-capture recheck), in the applications export, and in résumé tailoring's protected-citation lookup (fallback only; generation is unchanged). Saving a new review against a NOTHING_TO_ADD answer is still refused, so step 2 shows the saved state instead of a form.

## Server

No change to AI guards. The Apply page sends `x-ai-cost-confirmed` and `x-ai-data-confirmed` itself after the one-time notice. Prepare's button names the exact host ("Allow jobs.example.com and prepare"), so the host grant stays explicit without a second box.
