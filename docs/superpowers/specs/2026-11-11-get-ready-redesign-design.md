# Get ready to apply: one Apply page and an A–D grade on every job

Status: **owner-approved 2026-11-11 as D036.**
Builds on D035 (the assisted-apply redesign). D035 fixed the Fill half of the journey (the control page). This design fixes the half before it: choosing a job, grading it, adding experience, writing documents and preparing.

## 1. Why

The third live trial (a Lever sales-engineering job, 2026-11-11) stopped before Prepare. These are what the owner ran into:

- **Scoring happens too late.** A job shows "Unscored" until you open it and pay for an AI score, so the jobs list can't help you decide which jobs to put your effort into.
- **Tailoring has too many moving parts.** Each requirement asks for a three-way choice, a text box and its own "this is true" tick. Then a single button saves your lines, re-scores the job, writes the résumé and writes the cover letter, all under one cost question.
- **You can't see your new score before paying for documents.** Re-scoring only happens as part of "Create my résumé and cover letter".
- **Errors show up late and point nowhere.** A fill-in placeholder left in a line was reported only after the click, in a box at the bottom, and the message said to "save again" when there is no Save button.
- **Long lines fail after you've paid.** The scorer must quote each line you added word for word. Long, multi-sentence lines made a re-score fail after it had been charged (an earlier trial, 2026-11-10).
- **Three step lists.** The job page has 4 steps, the Apply Kit has 4 panels and the control page has 8. Nothing shows the whole route.
- **Known blockers come next.** These were found in D035 and haven't been built yet: attaching documents (impossible without marking the job Applied), Prepare's separate Enable pop-up, the Fill switch, and browser pop-ups for every cost.

Owner direction: "It shouldn't be this difficult … we need to keep this very simple for our users." Lines should save automatically as they're written, and jobs should be graded on the jobs page so applicants know which to prioritize.

## 2. Owner decisions (2026-11-11)

| # | Question | Decision |
|---|---|---|
| 1 | How far to simplify before the trial resumes | **One Apply page per job**, with the whole route as one numbered list. Folds in draft PR #66 and the unbuilt D035 pieces (UX-5a, 5b, 5c, 6 and 8). |
| 2 | How lines you add are confirmed as true | **One tick for all lines** ("Everything I wrote above is true"), replacing one tick per line. |
| 3 | How documents get written after the score | **One click, with the cost shown in the page.** It works below an A too, so you can apply by hand. |
| 4 | Where unfinished lines are kept | **In this browser** until the score is updated. |
| 5 | How jobs on the list get graded | **AI in the background.** A light, batched AI grade for new jobs that fit your preferences, up to a daily limit, after a one-time opt-in with a monthly limit. No algorithm grade. |
| 6 | How a grade is shown | **A to D**, on one scale: A = 85–100, B = 70–84, C = 55–69, D = below 55. The quick grade on the list and the detailed match when you apply use the same letters. |
| 7 | Cost questions | **Only while testing.** They're asked in the page, never in a pop-up. At launch users see no cost questions; the server's existing limits still apply (§6). |

## 3. Part A: a grade on every job

### What you see

- **Every job card** on the jobs page and in the review queue shows a letter and one short reason, instead of "Unscored" and a Score button. For example: **B · strong SaaS sales background; no Active Directory**.
- **A job that hasn't been graded** shows **Not graded yet**. That happens when you haven't turned grading on, the day's limit is used up, or the AI was unavailable. Its job page offers step 1 of the Apply page instead.
- **A new sort, "Best grade"**, alongside the existing sorts.
- **One click shows the detail:** up to three strengths and three gaps, each in plain words.
- **One plain sentence explains it:** "Apply Pilot's grade of how well your résumé fits this job. Not the employer's."
- **Never called an "ATS score"**, and never presented as a hiring probability (MVP Bible non-negotiable 2).
- **After the detailed match runs** (Apply page, step 1), the job's letter comes from it and is marked **Detailed**, for example **A · detailed**.

### How grades are made (JOB_GRADE v1)

1. **Opt-in, once.**
   - Settings ▸ AI gets **Grade new jobs automatically**. It reuses today's `aiDiscoveryEnabled` switch, which is off for every account now.
   - Turning it on shows, in the page, what's sent (your résumé summary and each job's listing, to Google Gemini), the daily job limit and the monthly limit.
   - That one confirmation replaces cost questions for this feature, so background grading never asks per job.
2. **Limits.**
   - The daily job limit reuses `maxAnalysesPerSync` (default 5, at most 25), renamed "Jobs graded per day" in the screen.
   - Today that setting applies per sync, and there's no per-day counter. So the daily limit counts the `JOB_GRADE` analyses created since UTC midnight. A manual sync and the daily cron together never grade more than the limit.
   - The monthly limit is the existing background-AI allowance, `automationBudgetCents` (default $1.50), inside the $5 hard cap. It's shown read-only, because it isn't editable today.
   - When either limit is reached, grading stops until the next day or month, and the setting says so.
   - Grading follows `aiDiscoveryEnabled` only. The discovery panel's separate "Run AI fit scoring on the first matches" box (`scoreImported`) is removed from the screen; the stored field is left alone.
3. **Which jobs.**
   - New or changed jobs that pass your saved preferences (location, remote, roles), newest first.
   - A job you import by hand is graded right away, if grading is on.
   - This replaces today's discovery scoring, which runs the full, costlier JOB_MATCH during a sync when `aiDiscoveryEnabled` is on.
4. **The request.**
   - A new AI feature, `JOB_GRADE`, on the "fast" model tier (today `gemini-3.5-flash-lite`). The model is passed explicitly, because the shared guarded AI path defaults to Flash.
   - Up to 10 jobs per request, with your résumé summary sent once per request.
   - **Input:** a compact summary of the parsed master résumé (titles and dates, skills, certifications, top achievements), and for each job its title, location, requirements and preferred qualifications.
   - **Output per job:** a score from 0 to 100, one short reason, up to three strengths and up to three gaps.
5. **Checks on the answer (truth rules):**
   - Each gap must name one of the job's own requirement lines.
   - Each strength may only name a skill, title or credential found in the résumé summary.
   - The score must be a whole number from 0 to 100.
   - A job whose answer fails a check stays **Not graded yet**, and the rest of the batch is kept. Every request is reserved and recorded like any other AI call, including ones whose answers are rejected.
6. **Letter:** A = 85–100, B = 70–84, C = 55–69, D = below 55.
7. **Stored as an AI analysis of type `JOB_GRADE`**, bound to a hash of the résumé version and the job's content.
   - This needs one additive change: a new value in the `AIAnalysisType` enum. That's the only database change in this design (§5).
   - When the résumé or the job changes, the letter shows "from an older résumé" until it's re-graded within the limits.
8. **Cost.** About 0.1¢ per job on Flash-Lite. If Flash-Lite proves too weak, Flash costs about 0.35¢ per job at the January 2027 price.
9. **Calibration after deploy.**
   - The owner's scored jobs live in production, so calibration happens in the app rather than on a local copy.
   - Once grading is on, compare the quick letters with the detailed letters on jobs that have both. That comparison is shared in chat only, as job titles and letters, and isn't committed.
   - If most A and B letters don't agree, adjust the prompt as version 2. Bumping the version makes earlier grades stale.
   - The prompt carries `JOB_GRADE_PROMPT_VERSION = 1`, shown under "Details".

**The grade and the detailed match.** The quick grade is for choosing jobs. The detailed match (the existing JOB_MATCH, with evidence) is what Prepare checks. It runs when you start applying, and its letter replaces the quick one on that job. "Assisted Fill needs an A on the detailed match" is today's 85 rule in letters. Prepare's confidence check of 85 or more also stays.

## 4. Part B: one Apply page per job

### The page

- **The job page** keeps the posting and the job's grade with its detail. Its tailoring section is replaced by one button: **Apply →**, or **Continue: step N** once started.
- **The Apply page** is today's Apply Kit route (`/jobs/[id]/apply`), so decision D-A is unchanged. At its top is D035's **Now card**: step N of 10, one sentence on what's happening, one primary button (or "Continue in the Apply Pilot browser"), what comes next, and the compact step list.
- **The ten step names** come from one shared dictionary used by the Apply page, the application page and the control page:

| # | Step | Where | The one thing you do |
|---|---|---|---|
| 1 | Your match | Apply page | Check my match |
| 2 | Your experience | Apply page | Write a line for anything your résumé doesn't show, then Update my score |
| 3 | Your documents | Apply page | Write my résumé and cover letter, review them |
| 4 | Prepare | Apply page | Fix anything on the ready list, then Allow and prepare |
| 5 | Open the Apply Pilot browser | Terminal, then the new window | Run the start command and sign in with your code |
| 6 | Open and read the form | Apply Pilot browser | One click |
| 7 | Check the answers | Apply Pilot browser | Approve these and continue |
| 8 | Fill | Apply Pilot browser | Turn on Fill if it's off, then Fill once |
| 9 | Finish and submit | Employer window | Complete the rest and press the employer's Submit yourself |
| 10 | Record it | Either browser | Confirm what you sent |

Steps 5–10 are D035's steps 3–8, already built (PRs #71, #76 and #77). The control page only renumbers them.

**Applying by hand.** After step 3, **Apply on my own** swaps steps 4–10 for the Kit's existing manual steps: answers to copy, open the application, and I applied. Accounts without application automation always see this path.

### Step 1: Your match

- When the job has no current detailed match, step 1's button is **Check my match**, with its cost shown in the page (§6). It runs the existing JOB_MATCH.
- The result is shown as a letter with its numbers. For example: "**B** · fit 74, confidence 80. Assisted Fill needs an A, with confidence of 85 or more."
- When a current detailed match already exists, step 1 is already done.

### Step 2: Your experience

- **One list** of the requirements the detailed match flagged as missing, plus the ones it didn't check. This is the server side of PR #66, whose screen this replaces; #66 is closed once this merges.
- **One text box per requirement:** "If you have this, say what you did in one sentence." Leaving it blank means skip. A small link, **It's on my résumé**, opens the existing résumé-line picker.
- **Saved as you type, in this browser.**
  - Drafts are kept in `localStorage`, under a key made from a hash of the user ID and the job ID, and matched to requirements by their text.
  - Each box shows "Saved on this computer".
  - Nothing reaches the server, the score or the documents until **Update my score**.
  - Drafts are deleted once they're saved to the account, and at sign-out.
  - Every storage call is wrapped, so a blocked storage only means drafts aren't kept between visits.
- **Checked as you type.**
  - The existing `ownerFactProblems` check (placeholders, notes to yourself, instructions, stray quotes) runs in the page, and the problem appears under that box.
  - Each line is limited to one sentence of at most 200 characters. The box shows a counter, and the server enforces the same limit for new or changed lines. That limit is what stops re-scores failing after the charge.
- **One tick:** "Everything I wrote above is true." It records the same per-line owner attestation the server stores today, so it changes only the screen, not what's stored.
- **Update my score (about 2¢).** It saves the lines and re-scores, and does nothing else. It names the box that needs fixing if any check fails. The result appears in step 1's words, and the job's letter updates.
- **If you add nothing**, the button reads **Nothing to add · update my score**. Prepare only accepts a score tied to your saved review (`isEvidenceBindingCurrent`), so even an empty review needs one re-score. §9 asks whether to drop that.

### Step 3: Your documents

- **Write my résumé and cover letter (up to 20¢)**, or "Write my résumé" when the cover letter is unticked. The cost is shown in the page. It's the existing generation, without the save and re-score steps.
- **Each document is reviewed in the existing editor.** When a document reaches a ready-to-use state from the Apply page, it's **attached to this application** through the existing application update. The application's status and dates don't change.
- **Versions:** the attached one is labelled **Used for this application**, and older versions fold under "Older versions". These are D035 §5.8's labels.
- **Below an A**, the step says so: "Assisted Fill needs an A. You can still apply on your own with these documents."

### Step 4: Prepare

- **The ready list.** It shows every condition the server checks before Prepare, one line per `blockingMessages` key, plus a non-blocking line for your application details. Each line shows ✓ or ✗ with its fix beside it (D035 UX-5a). A test enumerates every key.
- **Allow and prepare.** One in-page confirmation states the planning cost and "let Apply Pilot work on *host*". It then:
  1. creates the browser run if there isn't one, with the same request and idempotency rules as today
  2. adds the employer's host to the allowed sites
  3. runs Prepare

  This replaces the application page's run button, the Enable pop-up and the separate Prepare button (D035 UX-5b).
- **The Fill switch appears where it matters.** At step 4, if Fill is still on from an earlier application, there's **Turn off**. At step 8, **Turn on**. When an application is finished or stopped, Fill turns off automatically (D035 D-B). Settings keeps a permanent off switch (UX-6).

### Steps 5–10 in your usual browser

- The Apply page and the application page show progress for steps 5–10. They read it from the server when the page loads and when you return to the tab: read-only, with no timers (D035 UX-5c).
- The application page's three run panels become one summary card that links to the Apply page.

## 5. What doesn't change

- **Prepare's rules:** fit and confidence of 85 or more (an A, with high confidence) on a current, owner-reviewed detailed match, documents attached, the host allowed, and the daily limits.
- **Lines you add stay your own attested facts.** They're validated by the same cleanup on the server and used only for this job.
- **Fill, review and completion rules are unchanged** (D034, D035). Apply Pilot never presses the employer's Submit.
- **AI cost control stays on the server.** That means the reservation, the monthly and background-AI caps, the per-request maximum and the confirmation header. Only the question moves from a pop-up into the page.
- **Database:** one additive enum value, `JOB_GRADE`, in A1. It's applied in production only with the owner's explicit authorization, through the guarded forward-only `prisma migrate deploy` path in `AGENTS.md`. B1–B5 change no schema.

## 6. Cost questions: testing now, none at launch

- **A server setting, `AI_COST_QUESTIONS`, with two values:**
  - `ASK` is the default and is used now. Every paid step you start shows its maximum cost and what's sent in the page, with **Confirm** and **Cancel**. Confirm sends the existing `x-ai-cost-confirmed` header; Cancel sends nothing. No `window.confirm` remains in these flows, and a test checks that.
  - `OFF` is for launch. No questions are asked. The server still enforces the caps and per-request maximum and records every charge.
- **Background grading never asks per job**, in either mode. Its one-time opt-in (§3) is the consent and the limit.
- **`OFF` is not built here.** Some of today's questions double as consent to send résumé text to the AI provider, so `OFF` needs a one-time consent, given at sign-up (G-1, M2), first. Until then the setting stays `ASK`. This design only makes sure turning it off later is a single switch: the request paths read the setting in one place.

## 7. Build order

Each item is its own PR. Each runs `npm test`, lint, typecheck and `npm run test:browser`, and has its own "Done when" checklist. The owner merges each one (D030).

| PR | What | Needed before the trial resumes |
|---|---|---|
| B1 | Apply page shell: the shared ten-step dictionary, the Now card on the Apply page, the job page's Apply button, the existing tailoring moved over unchanged, and the control page renumbered | Yes |
| B2 | Step 2, Your experience: one list, browser drafts, inline checks, the 200-character limit, one tick, Update my score. Takes #66's server changes | Yes |
| B3 | Step 3, documents: the in-page cost confirmation component (replacing `window.confirm` on this page), auto-attach, version labels | Yes |
| B4 | Step 4, Prepare: ready list, Allow and prepare, the Fill switch at steps 4 and 8, automatic Fill-off on finish. Also step 5's start command and sign-in code on the Apply page, so the trial path stays on one page | Yes |
| B5 | Progress for steps 6–10 and the application-page summary card | No |
| A1 | Job grades: the `JOB_GRADE` feature and its checks, the enum migration, grading in sync and import within the limits, the opt-in screen, letters with sort and detail on the jobs page and review queue, and calibration | No (independent files, can run alongside B; its migration needs the owner's authorization) |

B1–B4 change `app/(product)/jobs/[id]/*` and `components/apply-kit/*` in sequence, so only one writer works there at a time. A1 touches the AI feature files, the discovery and sync code, Settings ▸ AI and the feed components, so it can be built in parallel. The only shared piece is the letter mapping (`lib/jobs/grade.ts`), which A1 creates and B1 reads; B1 adds it if it lands first.

### Done when (whole design)

- [ ] From a fresh job, the owner reaches a prepared run using only the Apply page, with no pop-ups, no Save button and no step that isn't on the list.
- [ ] A line with a placeholder or more than 200 characters is flagged under its box before any request is sent (JSDOM test), and the server rejects it too (unit test).
- [ ] Update my score sends exactly two requests (save, match), and Write documents sends no save or match request (tests).
- [ ] Drafts survive a reload, are deleted after a successful save and at sign-out, and are never sent before Update (tests).
- [ ] Attaching a document leaves the application status and dates unchanged (test).
- [ ] Every Prepare blocker key has a ready-list line with a working fix (test enumerates keys).
- [ ] With grading on, new preference-matching jobs get a letter after a sync, within the daily and monthly limits. With it off, no grading request is ever made (tests).
- [ ] A grade answer that names a gap not in the job's requirements, or a strength not in the résumé summary, is rejected for that job only (unit test).
- [ ] Rendering the jobs page never makes an AI call (test).
- [ ] The words "ATS score" appear nowhere in the product (test).
- [ ] `npm run test:browser` passes apart from the known job-match owner-review failure.

## 8. Out of scope

- Turning cost questions `OFF` (needs sign-up consent, §6).
- An algorithm grade (decided against: one source, one grade).
- Grading every job regardless of preferences or limits.
- Keeping drafts in the account, which would need another migration.
- A one-question-per-screen wizard (Phase C, M2).
- Fill uploads and dropdowns (D035 D-I and D-J, their own PRs).
- Anything that presses Submit.

## 9. Open question (not blocking B1–B4)

**Should a review that adds nothing reuse the score it reviewed?**
- **Today:** Prepare needs a detailed match bound to the saved review. So someone who checks the gaps and adds nothing still pays for, and waits for, a second identical score.
- **The change:** the existing `MASTER_RESUME_NO_NEW_FACTS` case could be allowed to back Prepare.
- **What that means:** saving about 2¢ and one wait per job, but it changes Prepare's evidence rule, so it needs its own owner decision. Until then, §4 step 2's "Nothing to add" re-scores.
