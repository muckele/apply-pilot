# Assisted Apply: making the journey self-explanatory

Status: **proposal for owner approval.** Docs only; nothing is built yet. 2026-11-10.
Read with: `docs/APPLY_PILOT_MVP_BIBLE.md` §3 (WP1.6), `docs/APPLICATION_BROWSER_COMPANION.md`, `docs/CONTROLLED_APPLICATION_AUTOMATION.md`.

## 1. The short version

- **It works.** On 2026-11-10 the owner finished the first real assisted application on a Greenhouse form in production. Apply Pilot read the form, proposed two answers, the owner approved them, one Fill typed them in (the LinkedIn and GitHub fields), and the owner pressed the employer's Submit.
- **Nobody could do it without help.** The owner needed someone telling them each step. In their words: "If we keep it the way that it is, no one's going to understand what to do."
- **Why.** The journey is spread over five pages, three browser windows and a terminal command, and no screen says "you are here; do this next". Several things block you silently. Most labels are engineering words.
- **The proposal.** Use one guide with eight numbered steps, and the same step names everywhere.
  - In your usual browser, the guide lives on the job's Apply Kit page.
  - In the Apply Pilot browser, the control page shows the same steps.
  - Every screen shows three things: which step you are on, what is happening in plain words, and one button for the next thing.
  - Anything that would block a later step is checked at the start, with the fix next to it.
- **Safety rules don't move.** There are no new browser commands, the server stays in charge of every permission, Apply Pilot never presses Submit, and Fill still runs once, only after you approve (§7).
- **Build it in ten small pieces** (§8). The first three are small, and they fix the mistakes that cost the most time: working in the wrong window, the Google sign-in dead end, and losing the companion window. **Nine owner decisions** are listed in §9, each with a recommendation.

## 2. What happened in the first trial

Kept anonymous on purpose: the repository is public.

1. **Before the day.** The job was scored, the evidence reviewed (Prepare needs a *reviewed* match of 85 or more), documents created and attached, and the run prepared. Two earlier attempts stopped at Prepare and at companion sign-in. Both are recorded in the Bible.
2. **Fill switch.** The owner turned on the Assisted Fill switch on the application page.
3. **Companion start.** The companion was started from a terminal.
4. **Sign-in.** In the companion window the login page offered Google first. The owner clicked it three times, and Google refused each time ("This browser or app may not be secure"). Two sign-in codes were refused before one worked.
5. **Opening and reading the form.** On the control page the owner worked several times in the look-alike copy of the page in their usual Chrome, which shows "UNKNOWN / UNAVAILABLE". In the right window they opened the form and read it ("Inspect form").
6. **Answers.** Apply Pilot proposed two answers (LinkedIn and GitHub). The owner approved both, resolved the review, ticked the acknowledgement and pressed **Fill approved fields** once.
7. **Fill.** Two fields were filled. Everything else was done by hand, including the contact fields, any dropdowns and the file uploads.
8. **Submit.** The owner pressed the employer's Submit and recorded it. The run ended `COMPLETED_BY_USER`.

**This proves** that the guarded path works end to end on a real Greenhouse form: inspection, review, one Fill, a personal submission and the record of it.

**It does not prove** that a new user could do it. It also doesn't prove that Fill saves much time on a standard Greenhouse form: two of many fields were filled (§10).

## 3. The journey today, screen by screen

```
YOUR USUAL BROWSER                 TERMINAL                    APPLY PILOT BROWSER (separate app)
──────────────────                 ────────                    ──────────────────────────────────
Job page: score, tailor            npm run application-       Window A: sign-in, then the control page
Apply Kit: documents, answers,       browser -- --app-origin  Window B: the employer's form
  "Open application", "I applied"    … --run-id …
Application page: browser run,
  sign-in code, Pretrial setup
Settings ▸ Answers (Answer Vault)
```

Nothing on any of these surfaces tells you which one to use next.

Friction numbers F1–F10 are the owner's starting list. F11–F13 are new findings from this audit.

### S1. Job page (`/jobs/[id]`): score and tailor

**What you see:**
- A match card with **Score this job**.
- A Tailor area that lists gaps and has **Create my résumé and cover letter** (or **Create new versions** once documents exist).
- Cost lines under each button: "Each AI step asks you to confirm its cost" and "One confirmation · at most N¢".

**What goes wrong:**
- **F9.** Two cost lines look alike. The confirmations are browser pop-ups (`window.confirm`), which look like system warnings and block the page.
- **F8.** A first score is only a baseline: Prepare later needs a *reviewed* score of 85 or more, plus match confidence of 85 or more. This page never says so.
- **F8.** A nightly job-source sync can quietly make a reviewed score stale. You only find out when Prepare is blocked.

### S2. Apply Kit (`/jobs/[id]/apply`)

**What you see:** four numbered panels.
1. Documents: a version dropdown such as "v3 · status · date", with a hash.
2. Answers to copy.
3. Open the application.
4. I applied.

**What goes wrong:**
- The Kit never mentions assisted Fill, so nothing tells you there's a second way to apply or where it starts.
- **F8.** Choosing a version here doesn't attach it to the application, but Prepare needs both documents attached. No production screen attaches them without also marking the application Applied.
- **F9.** Versions v1–v4 are listed with no hint which one to use.
- **F12.** After an assisted application is recorded from the control page, the application is already Applied. Step 4 then no longer offers to record the "what I sent" documents or the minutes.

### S3. Application page (`/applications/[id]`)

**What you see:** a tracker record (status, timeline, notes), with three panels squeezed into the right-hand column:
- **Browser run:** "Create browser run", "Current browser run state: DRAFT", **Open browser run**.
- **Companion sign-in:** "Get a companion sign-in code".
- **Pretrial setup:**
  - Facts: "Run state", "Canonical target host", "Automation policy: owner enabled yes; effective enabled yes; mode PREPARE_ONLY", "Execution host: allowed".
  - Buttons: **Enable PREPARE_ONLY for this run** (a browser pop-up) and **Prepare with Gemini**.
  - The **Assisted Fill** switch.

**What goes wrong:**
- **Wrong home.** The most involved task in the product lives in the side column of a tracker record.
- **Wrong order.** The panels don't follow the steps: the sign-in code you need at step 3 sits above Prepare, which is step 2.
- **F7: the switch.**
  - It covers the whole account, but it sits on a per-application panel.
  - It must be **off** to set up and Prepare, and **on** to Fill.
  - It disappears once a run is completed, so there is no screen left to turn Fill off.
- **F8: blocked messages.**
  - They don't give the numbers: "The job's current fit score does not meet the existing policy threshold."
  - The fix link, "Review the job packet and assign the required document", goes to the job page, which cannot attach documents.
- **F1.** **Open browser run** opens the control page in your usual browser. That copy looks identical to the real one and can never work.
- **F4.** The sign-in code is here, in a different browser from the window that needs it.
- **Jargon.** "Pretrial", "canonical target host", "PREPARE_ONLY", "effective enabled".

### S4. Terminal

**F11 (new).** Starting the companion needs a command:

```
npm run application-browser -- --app-origin <site> --run-id <run>
```

No screen shows this command, the address to use or the run ID. Without outside help, a user cannot start step 3 at all.

### S5. Apply Pilot browser: sign-in

**What you see:** the normal login page, with **Sign in with Google** first. A small link underneath reads "Signing in the Apply Pilot companion? Use a sign-in code instead."

**What goes wrong:**
- **F3.** Google always refuses automated browsers, so the first button can never work in this window. The owner clicked it three times.
- **F4: getting the code.**
  - You go back to the application page in your usual browser, find the code panel, get a code and type it into the other window.
  - Refused codes get one generic message.
  - Found in the code: **"Get a new code" silently cancels the previous code.** Typing the older of two codes is the most likely cause of a refusal, along with the 5-minute expiry and typos.
  - The alphabet leaves out O, I, 0 and 1, but nothing tells you that.

### S6. Apply Pilot browser: control page (`/application-runs/<id>/browser`)

**What you see, top to bottom:**
1. A facts grid: Workflow state, Local connection, Run ID, Target host.
2. A button row: Refresh status, **Open frozen target**, **Inspect form**, Close workflow.
3. Finish manually.
4. Personal submission.
5. Fill approved fields: an acknowledgement checkbox, the Fill button, result counts and the manual fields.
6. Current answer packet:
   - headed "Read-only proposed answers…";
   - Refresh review data;
   - packet and inspection versions, a packet hash, and twelve counts;
   - review reasons and **Resolve review**;
   - answer cards, each with seven technical facts and **Approve** / **Reject**.

**What goes wrong (F5):**
- **Upside down.** You approve answers at the bottom of the page, then scroll back up to Fill. "Finish manually" (the last thing you do) is near the top.
- **No current step.** Six separate actions must happen in a set order:
  1. Open frozen target
  2. Inspect form
  3. Refresh review data
  4. Approve each answer
  5. Resolve review
  6. Tick the acknowledgement, then Fill

  Nothing says which one comes next.
- **Fails without saying why.** "Inspect form" stays disabled until the form is open *in this companion session*. After a restart, or in the look-alike window, it just doesn't work.
- **Contradiction.** The answer list is labelled "Read-only" but holds the Approve buttons.
- **Jargon.** Frozen target, answer packet, packet hash, disposition, TARGET_OPEN, REVIEW_REQUIRED, "Resolve review", "Runtime manual", "Proposable".
- **F1.** The same page in your usual browser looks identical but shows "UNKNOWN / UNAVAILABLE". The companion attaches its connection only to the control tab it opened itself (`exposeBinding` on `controlPage`).

### S7. Apply Pilot browser: the employer's form

**What you see:** a second window from the same "Google Chrome for Testing" app, with nothing to say it belongs to Apply Pilot.

**What goes wrong:**
- **F2.** The windows opened on another macOS desktop or behind other windows, and nothing labels them.
- **F13 (new): lock and handover.**
  - While Apply Pilot is attached, the form is locked to its exact page. That is a safety rule. A form that submits by loading a new page can't be submitted until you press **Finish manually in this browser**.
  - Reloading or closing the control page ends the employer session, and anything not yet submitted is lost.
  - After handover you have at most 60 minutes.
  - These rules are explained only in small print.

### S8. Recording the application

**What you see:** two different "I applied" actions. The control page has **I personally submitted this application**; the Apply Kit has **I applied**.

**What goes wrong:**
- **F12 (new).** The control page's version sets the application to Applied, but it doesn't record which documents were sent or how many minutes it took. After that, the Kit can't add them either. The "what I sent" ledger (one of the product's main promises) stays empty for assisted applications.

### S9. Settings ▸ Answers (Answer Vault)

**What you see:** a form with Category, Application question, Reviewed answer, **Mask this answer by default** and **Available for use**.

**What goes wrong (F6):**
- **Links live only here.** Fill can only use answers saved here, one saved answer per question. A LinkedIn link on your profile or résumé is never used.
- **"Mask" means "never fill".** Ticking "Mask this answer by default" marks the answer sensitive, and Fill then leaves it out completely, with no message. The label suggests it only hides the answer on screen.
- **No way to add from review.** When the form asks for something you haven't saved, the review shows a field Apply Pilot "can't answer". There is no way to add the answer there.

### Root causes

| # | Cause | Friction it explains |
|---|---|---|
| R1 | No journey on screen: nothing says "step N of 8" or names the next action | F5, F7, F8, F11 |
| R2 | The work is spread over several surfaces, and nothing points to the right one or warns about the wrong one | F1, F2, F4, F11 |
| R3 | Silent gates: rules that block you without saying so where you are | F6, F7, F8, F13 |
| R4 | Engineering vocabulary on user screens | F5, F7 |
| R5 | Browser pop-ups and fix links that lead nowhere useful | F8, F9 |

## 4. Design principles

1. **One journey, eight steps, same names everywhere.** The Kit, the application page, the control page and the companion window all use the step numbers and names from §5.1.
2. **Every screen answers three questions:** where am I, what's happening, and what's the one thing to do next? There is one primary button; everything else is secondary or under "Details".
3. **Check before you start.** Step 1 checks every condition a later step needs, and puts the fix next to anything that's missing.
4. **No silent failures.** A disabled button always says, in one sentence, why it's disabled and how to fix that.
5. **The right window is obvious, and the wrong window says so.**
6. **Plain words.** State codes, IDs, versions and hashes stay under "Details" for troubleshooting.
7. **Ask in the page, not in a pop-up.** Cost and permission questions appear as part of the step.
8. **The safety rules stay exactly as they are** (§7). The redesign changes how things are shown and in what order, not who is allowed to do what.

## 5. The guided flow

### 5.1 The eight steps

| # | Step | Where | You do | Apply Pilot does | Done when |
|---|---|---|---|---|---|
| 1 | **Check you're ready** | Usual browser (Apply Kit) | Fix anything marked ✗ | Checks your reviewed match, the documents attached, your saved link answers, the Fill switch, the employer site and the daily limit | Every required line is ✓ |
| 2 | **Prepare** | Usual browser | One click; the cost and the permission to work on this employer's site are shown in the step | Plans the application | Prepared |
| 3 | **Open the Apply Pilot browser** | Usual browser, then terminal, then the new window | Run the start command; show your sign-in code; type it into the new window | Starts its own browser and signs it in | The Apply Pilot browser says "Connected" |
| 4 | **Open the employer's form** | Apply Pilot browser | One click: **Open and read the form** | Opens the exact form in the second window and reads its fields | "Read N fields. Apply Pilot can fill M." |
| 5 | **Check the answers** | Apply Pilot browser | Approve or skip each proposed answer; add a missing saved answer; then **These are right** | Nothing until you approve | Review finished |
| 6 | **Fill** | Apply Pilot browser | Turn on Fill if it's off; tick "I understand"; press **Fill**, once | Types only the approved answers, once, and leaves anything already typed | Result shown: filled, kept, failed |
| 7 | **Finish and submit** | Employer window | Unlock the form; complete the rest; upload files; press the employer's Submit yourself | Hands the form over to you and stops | You say you submitted |
| 8 | **Record it** | Either browser | Confirm you submitted, which documents you sent and roughly how many minutes it took | Marks it Applied with what you sent; offers to turn Fill off | Tracker shows Applied, with the documents |

Steps 4 to 7 can only happen in the Apply Pilot browser, because that is where the employer's form is open. Everywhere else they appear as progress ("Step 5 of 8: continue in the Apply Pilot browser").

### 5.2 The "Now" card: the single place

Every screen in the journey shows the same card at the top:

- **Step N of 8 · step name**
- **One sentence on what's happening,** for example "Apply Pilot read 18 fields and can fill 2."
- **One primary button,** or, when the step happens elsewhere, one instruction: "Continue in the Apply Pilot browser window."
- **One line on what comes next.**
- **A compact list of all eight steps,** each marked ✓ done, • now, or ○ later.

**Where it appears:**
- **Apply Kit page.** This is the home of the guide (decision D-A).
- **Application page.** A small summary card replaces today's three side panels and links to the guide (W10).
- **Control page (Apply Pilot browser).** The same card heads the page (W6–W9).

**How the usual browser learns about progress.** In your usual browser the card reads progress from the server: run state, the answer summary and the Fill result. It reads them when the page loads and again when you switch back to the tab. Those are read-only fetches, with no timers and no repeated background checks.

**Plain words for every state.** One dictionary turns every code into words; the codes appear only under "Details".

| Code today | Shown as |
|---|---|
| Run `DRAFT` | Not started |
| Run `PREPARING` | Preparing… |
| Run `READY` | Prepared |
| Run `REVIEW_REQUIRED` | Prepared, with things for you to check |
| Run `BLOCKED` | Can't continue yet: *reason in plain words, with a fix* |
| Run `FAILED` | Preparing didn't work: *reason*. You can try again. |
| Run `FILLING` | Filling… |
| Run `READY_FOR_USER_SUBMISSION` | Filled: your turn to finish and submit |
| Run `COMPLETED_BY_USER` | Done: you applied on *date* |
| Run `CANCELLED` | Stopped |
| Companion `STARTING` | Starting the Apply Pilot browser… |
| Companion `APPLY_PILOT_AUTH_REQUIRED` | Sign in the Apply Pilot browser with your code |
| Companion `CONTROL_READY` | Connected |
| Companion `OPENING_TARGET` | Opening the employer's form… |
| Companion `TARGET_OPEN` | Employer's form is open |
| Companion `HANDOFF_PENDING` | Handing the form over to you… |
| Companion `HUMAN_ONLY` | The form is yours: finish and submit (*N* minutes left) |
| Companion `ERROR` | Stopped safely: *reason in plain words* |
| Companion `CLOSED` | Closed |
| Policy `PREPARE_ONLY` / `FILL_AND_REVIEW` | Assisted Fill off / on |
| "Frozen target" | The employer's form (the exact page saved for this job) |
| "Answer packet" | Proposed answers |
| "Inspect form" | Read the form |
| "Resolve review" | These are right |
| "Proposable" / "Manual only" / "Excluded" / "Unsupported" | Apply Pilot can fill this / You fill this / Apply Pilot never fills this kind of question / Apply Pilot can't fill this kind of field |

### 5.3 Which window am I in?

- **In your usual browser,** the control page doesn't pretend to work.
  - On load it checks for the companion's connection. That connection exists only in the tab the companion opened.
  - It waits a few seconds, because the connection arrives a moment after sign-in.
  - If the connection isn't there, the page shows "This page only works inside the Apply Pilot browser", with how to find that window and a link back to the guide (W5). None of the controls appear.
- **In the Apply Pilot browser,** it's unmistakable.
  - A coloured banner reads "Apply Pilot browser" on every control-page screen.
  - The tab title reads "Apply Pilot browser: Step 5, Check the answers".
  - The companion brings the control window to the front when it starts and again after sign-in, and places the two windows side by side where Chromium allows it.
  - The terminal prints one plain line: what to look for and what to do next.
  - Apply Pilot never adds anything to the employer's own page.
- **Leaving by mistake.** While the employer's form is open or handed over, reloading or closing the control page first asks "Leave? This closes the employer's form and anything not submitted is lost."

### 5.4 Signing in the Apply Pilot browser

- **Code first.** When the login page is opened on the way to a control page (only the companion does that), it leads with the code form. Google moves under "Not in the Apply Pilot browser? Sign in with Google", with one line saying Google blocks automated browsers.
- **The code when you need it.** Step 3 has **Show my sign-in code** in the same place as the start command. The code shows with a Copy button and the time it stops working. The step says plainly: "Getting a new code cancels this one."
- **Typing help.** The code box formats as you type and says at once if you type a character codes never use (O, I, 0 or 1). If a code is refused, the message lists the usual causes: mistyped, older than 5 minutes, replaced by a newer code, or already used.
- **Unchanged:** single use, 5 minutes, bound to one run, stored only as a hash, same-origin only, rate limits, allowlist check, audit. Google's automation check is not bypassed.
- **Later option (D-D):** approve the Apply Pilot browser from your usual browser instead of typing a code. The window shows a short code, and you press Approve where you're already signed in. It's a new sign-in flow, so it needs its own security review, and it isn't proposed now.

### 5.5 Answers that Fill can use

- **Check early.** Step 1 lists the link answers forms usually ask for (LinkedIn, GitHub, website or portfolio) and start date. Each shows "saved", "not saved" or "saved but marked sensitive, so Fill won't use it", with **Add** or **Edit** next to it. These lines never block Prepare; they just say what Fill will have to work with.
- **Suggestions from your profile, never automatic.** If your profile or résumé has a link you haven't saved, step 1 offers "Save this LinkedIn link to your answers?". Nothing is saved without your click, and nothing is generated.
- **Add a missing answer in place.** In step 5, a link or start-date question with no saved answer shows **Add to saved answers**. Saving it offers **Read the form again**, so Apply Pilot proposes it.
- **Say what "sensitive" means.** "Mask this answer by default" becomes "Sensitive: hide on screen and never fill automatically", with one line of help. The Vault list tags such entries "Won't be filled".
- **Unchanged:** each non-document answer still comes from exactly one saved answer; sensitive answers stay excluded; sensitive question types (work authorization, sponsorship, salary, demographics, disability, veteran status, criminal history, legal statements) are never proposed.

### 5.6 The Assisted Fill switch

- **A permanent home in Settings,** next to Answers. **Turn off** is always available there, with one click, in any state, including after an application is finished. **Turn on** points you to step 6 of an application you've prepared, which is the only place it can be turned on safely.
- **Inline where it matters.**
  - Step 2: if Fill is on, "Assisted Fill is on from an earlier application. Turn it off to prepare this one. **[Turn off]**".
  - Step 6: "Turn on Fill for this form **[Turn on]**".
  - Step 8: "Assisted Fill is still on for your account. **[Turn off]**".
- **Unchanged:** the same account-wide setting and API; turning off does no reads first; turning on rereads the run and policy; the server still refuses setup while Fill is on.
- **Decision D-B:** whether finishing or stopping an application should turn Fill off automatically. That would be a small server change, and I recommend it.

### 5.7 Costs and documents

- **Ask in the page.** An in-page confirmation replaces the browser pop-ups for AI cost and data, the Prepare permission and turning Fill on. It names the feature, what's sent and the most it can cost, and has **Confirm** and **Cancel**. The server checks and confirmation headers stay the same.
- **Say which cost is which.** On the job page the two actions are labelled by what they do, in order: "Check your match (up to N¢)" and "Write your résumé and cover letter (up to N¢)".
- **Say which version to use.**
  - The newest version that is ready to use is preselected and labelled **Recommended**.
  - The version attached to this application is labelled **Used for this application**.
  - Versions that need review say so.
  - Older versions sit under "Older versions".
- **Attach without applying.** **Use this version for this application** attaches a document through the existing application update, without changing the status. Step 1 uses the same button.

## 6. Wireframes

Rough layouts only. `<…>` marks a placeholder.

**W1. Apply Kit with the guide: step 1 has two things to fix (usual browser)**

```
┌──────────────────────────────────────────────────────────────────────────┐
│ Apply: <Job title> at <Company>                                          │
│ How do you want to apply?  ( ) Myself, with this Kit                     │
│                            (•) With Apply Pilot filling what it can      │
├──────────────────────────────────────────────────────────────────────────┤
│ STEP 1 OF 8 · Check you're ready                                         │
│ 2 things to fix before Apply Pilot can prepare this application.         │
│                                                                          │
│  ✓ Your reviewed match is 88 (needs 85). Confidence 90 (needs 85).       │
│  ✗ No résumé chosen for this application   [Use résumé v4 (recommended)] │
│  ✓ Cover letter chosen: v2                                               │
│  ✗ Apply Pilot isn't allowed on this employer's site yet                 │
│      You'll allow it in step 2.                                          │
│  ✓ Assisted Fill is off (it must be off while you prepare)               │
│                                                                          │
│  Answers forms often ask for (optional):                                 │
│  ✓ LinkedIn   ✓ GitHub   – Website: not saved [Add]                      │
│                                                                          │
│ Next: Prepare (step 2). It unlocks once everything above is ✓.           │
├──────────────────────────────────────────────────────────────────────────┤
│ • 1 Check you're ready  ○ 2 Prepare  ○ 3 Open the Apply Pilot browser    │
│ ○ 4 Open the form  ○ 5 Check answers  ○ 6 Fill  ○ 7 Finish and submit    │
│ ○ 8 Record it                                                            │
└──────────────────────────────────────────────────────────────────────────┘
  Below: the Kit's documents, answers and application link, for reference.
```

When the match is the problem, the line reads, for example: "✗ Your match is 84 and hasn't been reviewed. Prepare needs a reviewed match of 85 or more. [Review the evidence on the job page]". When a sync changed the posting: "✗ The job posting changed on <date>, so your reviewed match is out of date. [Check again: up to N¢]".

**W2. Step 2, Prepare (usual browser)**

```
┌──────────────────────────────────────────────────────────────────────────┐
│ STEP 2 OF 8 · Prepare                                                    │
│ Apply Pilot plans this application with Google Gemini. It sends this     │
│ job, your résumé evidence and the lines you added. Up to N¢, usually     │
│ less.                                                                    │
│                                                                          │
│ [✓] Allow Apply Pilot to work on forms at <employer site>                │
│     It can read the form and, after you approve, fill answers. It never  │
│     presses Submit.                                                      │
│                                                  [ Prepare: up to N¢ ]   │
└──────────────────────────────────────────────────────────────────────────┘
```

**W3. Step 3, Open the Apply Pilot browser (usual browser)**

```
┌──────────────────────────────────────────────────────────────────────────┐
│ STEP 3 OF 8 · Open the Apply Pilot browser                               │
│ Apply Pilot fills forms in its own browser, separate from this one, so   │
│ this browser and your sign-ins are never touched.                        │
│                                                                          │
│ a) Start it. In Terminal, in your Apply Pilot folder, run:               │
│    ┌────────────────────────────────────────────────────────────┐ [Copy] │
│    │ npm run application-browser -- --app-origin <this site> \  │        │
│    │   --run-id <this application's run>                        │        │
│    └────────────────────────────────────────────────────────────┘        │
│                                                                          │
│ b) A window titled "Apply Pilot browser" opens. If you can't see it,     │
│    look for "Google Chrome for Testing" in the Dock, or on your other    │
│    desktops.                                                             │
│                                                                          │
│ c) It asks for a sign-in code. Google doesn't work in that window.       │
│    [ Show my sign-in code ]  →  K7QM-4TZP-9HXA  [Copy]  works until 3:42 │
│    Works once. Getting a new code cancels this one.                      │
│                                                                          │
│ Next: step 4 happens in the Apply Pilot browser.                         │
└──────────────────────────────────────────────────────────────────────────┘
```

**W4. Sign-in page inside the Apply Pilot browser**

```
┌ APPLY PILOT BROWSER ─────────────────────────────────────────────────────┐
│ Sign in this window with a code                                          │
│ Get the code from step 3 of the guide in your usual browser.             │
│                                                                          │
│ Code  [ ____-____-____ ]                              [ Sign in ]        │
│ Codes use letters and the digits 2–9. There's no O, I, 0 or 1.           │
│                                                                          │
│ ▸ Not in the Apply Pilot browser? Sign in with Google                    │
│   (Google blocks automated browsers, so it won't work in this window.)   │
└──────────────────────────────────────────────────────────────────────────┘
```

**W5. Control page opened in your usual browser (the look-alike today)**

```
┌──────────────────────────────────────────────────────────────────────────┐
│ This page only works inside the Apply Pilot browser                      │
│                                                                          │
│ You're in your usual browser. Opening, checking and filling the          │
│ employer's form happen in the separate window titled                     │
│ "Apply Pilot browser".                                                   │
│  • Can't find it? Look for "Google Chrome for Testing" in the Dock, or   │
│    on your other desktops.                                               │
│  • Not started yet? Follow step 3 in the guide.                          │
│                                                                          │
│ [ Back to the guide ]                               [ Check again ]      │
└──────────────────────────────────────────────────────────────────────────┘
```

**W6. Control page, step 5: Check the answers (Apply Pilot browser)**

```
┌ APPLY PILOT BROWSER ─────────────────────── <Job title> · <Company> ─────┐
│ STEP 5 OF 8 · Check the answers                                          │
│ Apply Pilot read 18 fields and can fill 2. You'll do the other 16.       │
│                                                                          │
│ ┌ Form asks: "LinkedIn Profile" ──────────────────────────────────────┐  │
│ │ Apply Pilot will type: <your LinkedIn link>                         │  │
│ │ From your saved answers.             [ Approve ]  [ Don't fill ]    │  │
│ └─────────────────────────────────────────────────────────────────────┘  │
│ ┌ Form asks: "GitHub" ────────────────────────────────── ✓ Approved ──┐  │
│ └─────────────────────────────────────────────────────────────────────┘  │
│ ┌ Form asks: "Website" ───────────────────────────────────────────────┐  │
│ │ No saved answer Fill can use, so you'll fill this one.              │  │
│ │ [ Add to saved answers ]                                            │  │
│ └─────────────────────────────────────────────────────────────────────┘  │
│                                                                          │
│ Before you continue:                                                     │
│  • Some job requirements have no evidence on your résumé.                │
│  • 16 fields are yours to fill (listed in step 7).                       │
│                                [ These are right: continue to Fill ]     │
│ ──────────────────────────────────────────────────────────────────────── │
│ ✓1 ✓2 ✓3 ✓4  • 5 Check answers  ○ 6 Fill  ○ 7 Finish  ○ 8 Record         │
│ ▸ Details (for troubleshooting): states, versions, IDs, counts           │
└──────────────────────────────────────────────────────────────────────────┘
```

**W7. Control page, step 6: Fill**

```
┌ APPLY PILOT BROWSER ─────────────────────────────────────────────────────┐
│ STEP 6 OF 8 · Fill                                                       │
│ Apply Pilot will type your 2 approved answers into the form, once.       │
│ It won't change anything already typed there. It won't press Submit.     │
│                                                                          │
│ Assisted Fill is off for your account.                  [ Turn on Fill ] │
│                                                                          │
│ [ ] I understand the employer's page may send what's typed to the        │
│     employer before I press Submit.                                      │
│                                                                          │
│                                        [ Fill 2 fields (runs once) ]     │
│ Fill can't run while: Assisted Fill is off · the box above is unticked   │
└──────────────────────────────────────────────────────────────────────────┘
```

**W8. Control page, step 7: Finish and submit**

```
┌ APPLY PILOT BROWSER ─────────────────────────────────────────────────────┐
│ STEP 7 OF 8 · Finish and submit                                          │
│ ✓ Filled 2 fields. None failed.                                          │
│                                                                          │
│ a) Unlock the form so you can finish it.          [ Unlock the form ]    │
│    Apply Pilot stops reading and filling, and the form is yours for up   │
│    to 60 minutes. Don't reload or close this page until you've           │
│    submitted: that closes the form.                                      │
│                                                                          │
│ b) In the employer's window, fill in what Apply Pilot can't:             │
│    • First name, Last name, Email, Phone (required)                      │
│    • Résumé and cover letter uploads: use résumé v4 and cover letter v2  │
│    • 5 dropdowns and 2 yes/no questions                                  │
│                                                                          │
│ c) Press the employer's Submit button yourself.                          │
│                                                                          │
│ Form time left: 52 min                       [ I submitted it: step 8 ]  │
└──────────────────────────────────────────────────────────────────────────┘
```

**W9. Step 8: Record it (either browser)**

```
┌──────────────────────────────────────────────────────────────────────────┐
│ STEP 8 OF 8 · Record it                                                  │
│ Documents you sent:  Résumé [ v4 ▾ ]   Cover letter [ v2 ▾ ]             │
│ Minutes this took (optional): [ 25 ]                                     │
│ [ ] I personally submitted this application on the employer's site.      │
│                                          [ Record my application ]       │
│ ──────────────────────────────────────────────────────────────────────── │
│ ✓ Recorded on <date>. It's in your tracker with the documents you sent.  │
│ Assisted Fill is still on for your account.               [ Turn off ]   │
└──────────────────────────────────────────────────────────────────────────┘
```

**W10. Application page summary card (replaces the three side panels)**

```
┌ Apply with Apply Pilot ──────────────────────────┐
│ Step 5 of 8 · Check the answers                  │
│ Continue in the Apply Pilot browser window.      │
│ [ Open the guide ]                               │
└──────────────────────────────────────────────────┘
```

**W11. Answer Vault: what "sensitive" means**

```
│ [ ] Sensitive: hide on screen and never fill automatically               │
│     For answers like salary or work authorization. Leave links and       │
│     start dates unticked so Fill can use them.                           │
│                                                                          │
│ LinkedIn · Links · <your link>                         Won't be filled ⓘ │
```

## 7. Safety: what does not change

| Rule | How the redesign keeps it |
|---|---|
| Apply Pilot never presses the employer's Submit | No new browser command. Step 7 tells you to press Submit yourself. The 7 existing payload-free commands stay as they are. |
| Fill only after your explicit approval | You still approve each answer, confirm "These are right" (today's Resolve review, same acknowledgements), tick the acknowledgement and press Fill. Nothing approves or fills on its own. The one new combined click, "Open and read the form", only opens and reads; it never writes (D-C). |
| Fill is one permanent attempt | No retry button and no automatic replay. The button says "runs once". The lost-result handling stays as it is. |
| Owner-attested facts are never invented | New answers come only from what you type or confirm. Profile-link suggestions need your click and are never AI-generated. Sensitive question types are never proposed. |
| The companion keeps its own separate browser profile | The sign-in code path and the separate, non-persistent browser profiles are unchanged. There's no cookie sharing and no reuse of your own Chrome. |
| Google's automation check isn't bypassed | Google stays refused in the companion; the page steers you to the code. |
| The server is the authority | Wrong-window detection, step gating and the Now card are presentation only. The server still rechecks run, policy, host, packet, attempt, lease and target on every action. |
| Nothing is added to the employer's page | The banner and title are on Apply Pilot's own control page only. |

## 8. Build order and acceptance criteria

Each piece is one branch and one draft PR. Work follows the Bible's rules: tests first, then `npm test`, `npm run lint`, `npm run typecheck` and `npm run build`, plus `npm run test:browser` where the companion or control page changes. No piece needs a database migration, unless an owner decision in §9 chooses an option that does.

**Waves (pieces in a wave can run in parallel; their files don't overlap):**
- **Wave 1:** UX-1, UX-2, UX-3, UX-9.
- **Wave 2:** UX-4, UX-5a, UX-7.
- **Wave 3:** UX-5b, UX-5c, UX-6.
- **Wave 4:** UX-8, UX-10.

**Minimum before the next real trial (Lever or Ashby):** UX-1 to UX-4. That removes the wrong-window, sign-in and control-page confusion. The next trial then tests the new control page live.

### UX-1. Wrong-window guard, banner and plain words (control page)

- **Fixes:** F1, part of F2, part of F5.
- **Changes:**
  - The control page checks for the companion's connection and shows W5 when it's missing.
  - In the companion, it shows the "Apply Pilot browser" banner and tab title.
  - A new plain-language dictionary covers run states, companion states, safe-stop codes, answer types and review reasons (§5.2); the page uses it.
  - Codes, IDs, versions and hashes move under "Details".
- **Doesn't change:** commands, gating, mutations, server.
- **Done when:**
  - [ ] In a browser without the companion, the page shows W5. No command button renders, and "UNKNOWN" or "UNAVAILABLE" never appears.
  - [ ] A page that gets its connection within the short wait never flashes W5.
  - [ ] In the companion, the existing flow works unchanged: existing tests and `npm run test:browser` pass.
  - [ ] No state code (DRAFT, TARGET_OPEN, REVIEW_REQUIRED, PREPARE_ONLY…) appears outside "Details". A test fails if a code is shown without a dictionary entry.
  - [ ] Banner and title appear only when the connection is present.
- **Size and risk:** small; presentation only.

### UX-2. Companion sign-in that leads with the code

- **Fixes:** F3; the wording part of F4.
- **Changes:**
  - The login page leads with the code form when its destination is a control page (W4).
  - The code box formats as you type and catches impossible characters.
  - The issuing panel says a new code cancels the old one.
  - The refusal message lists the usual causes.
- **Doesn't change:** code format, single use, 5 minutes, run binding, rate limits, allowlist, audit, server responses.
- **Done when:**
  - [ ] Opening a control page signed out shows the code form first, and Google isn't the first button.
  - [ ] `/login` without a control-page destination is unchanged.
  - [ ] Typing O, I, 0 or 1 shows the hint before submitting. Pasted codes with spaces, dashes or lowercase still work.
  - [ ] The refusal message names: mistyped, older than 5 minutes, replaced by a newer code, already used.
  - [ ] Existing companion sign-in tests pass, and new render tests cover the above.
- **Size and risk:** small; low.

### UX-3. Make the Apply Pilot browser easy to find (companion)

- **Fixes:** F2; part of F11.
- **Changes:**
  - The companion brings the control window to the front at start and after sign-in.
  - It places the control and employer windows side by side where Chromium allows.
  - It prints plain next steps in the terminal: what the window is called and to sign in with the code from step 3.
- **Doesn't change:** separate non-persistent browser profiles, bridge installation rules, the employer page.
- **Done when:**
  - [ ] Companion tests show the control window brought to the front at start and once the signed-in control page loads.
  - [ ] Terminal output is plain words and prints no secrets.
  - [ ] The owner's manual check on macOS is recorded, covering both another desktop and a window behind others: either the window comes to the front, or the terminal and W3 say where to look.
- **Size and risk:** small to medium; it touches the companion script, so review carefully.

### UX-4. Control page as a stepper

- **Fixes:** F5, F13.
- **Changes:**
  - Re-lay out the control page as steps 4–8 with the Now card (W6–W9).
  - **Open and read the form** sends the existing Open command, then the existing Read command, from one click (D-C).
  - Answer cards use plain words; the technical facts go under Details.
  - **These are right** is today's Resolve review, showing the same acknowledgements.
  - One sentence sums up what Fill can and can't do, and the manual-field list shows before Fill.
  - Reads refresh after each step's action, with no timers. Manual refresh moves under Details.
  - Unlocking (today's handover) becomes step 7a.
  - The leave-page warning is on while the form is open or handed over.
  - The 1,760-line component splits into a container that keeps today's logic and step components that only present.
- **Doesn't change:** the seven commands and their payload-free shape; the gating functions in `lib/application-browser/control-presentation.ts` and `fill-status-presentation.ts`; one permanent Fill with no retry; the acknowledgement; the server checks.
- **Done when:**
  - [ ] A table-driven test covers each combination of companion, run, answer and Fill state: exactly one primary action shows, and it belongs to the current step.
  - [ ] "Check the answers" comes before Fill on the page, and the "Read-only" label is gone.
  - [ ] Every disabled button shows a one-line reason.
  - [ ] Fill still needs approved answers, a finished review, the acknowledgement and one click. Existing Fill-gating tests pass unchanged, and no code path calls Fill without a click.
  - [ ] "Open and read the form" sends nothing until clicked. If opening fails it stops, says why and does not retry.
  - [ ] The leave-page warning appears while the employer's form is open or handed over.
  - [ ] `npm test`, lint, typecheck, build and `npm run test:browser` are green.
- **Size and risk:** medium to large. It rearranges the protected Fill screen, so it gets an independent review before merge.

### UX-5. The guide on the Apply Kit

UX-5 is split into three PRs.

**UX-5a. Ready check and attaching documents** (F8)

- **Changes:**
  - Adds "How do you want to apply?" and the step 1 Ready check (W1) for accounts where automation is available.
  - Each Prepare condition shows as a line with today's value, the value needed and its fix.
  - **Use this version for this application** attaches a document without changing the status.
- **Done when:**
  - [ ] Every reason the server can block Prepare (`blockingMessages` keys) has a Ready-check line, with a fix link that lands on a control that can actually fix it. A test enumerates the keys.
  - [ ] Attaching a document leaves the application status and dates unchanged (tested).
  - [ ] Accounts without automation see today's Kit unchanged.

**UX-5b. Prepare and starting the companion** (F4, F11)

- **Changes:**
  - Step 2 merges today's "Enable … for this run" and Prepare into one step with the permission and cost shown in the page (W2).
  - Step 3 shows the start command with this site and this run filled in, and the sign-in code button (W3).
- **Done when:**
  - [ ] Starting from a fresh prepared-ready job, the owner reaches a signed-in Apply Pilot browser using only what's on the Kit page and the terminal.
  - [ ] The command shown contains only this site's address and this run's ID: no token, cookie or code.
  - [ ] Prepare's rules and thresholds are unchanged (existing tests pass).

**UX-5c. Progress and the application-page card** (F1, F7, F11)

- **Changes:**
  - Steps 4–7 show progress read from the server when the page loads and when you return to the tab.
  - On the application page, the "Browser run", "Companion sign-in" and "Pretrial setup" panels become one summary card (W10).
- **Done when:**
  - [ ] Progress reads are read-only, use no timers and stop when the tab is hidden.
  - [ ] The application page no longer links to the control page in your usual browser.
  - [ ] Creating a run still uses the same request and idempotency rules (existing tests pass).

**Size and risk (all three):** large overall, medium per PR; it touches `app/(product)/jobs/[id]/*`, a shared hot spot.

### UX-6. Assisted Fill switch where you need it

- **Fixes:** F7.
- **Changes:**
  - Settings gets an Assisted Fill card (§5.6).
  - The guide shows the switch at steps 2, 6 and 8.
  - Same API and rules.
- **Done when:**
  - [ ] Fill can be turned off from Settings with no run, with a finished run and mid-run.
  - [ ] Turning on is offered only where a prepared run allows it, as today.
  - [ ] Setup while Fill is on is still refused by the server; the guide explains why and offers the one-click fix.
- **Size and risk:** small.

### UX-7. Saved answers that Fill can use

- **Fixes:** F6.
- **Changes:** everything in §5.5 (W11):
  - relabel "Mask" and tag "Won't be filled";
  - link and start-date lines in the Ready check;
  - profile-link suggestions that save only on your click;
  - **Add to saved answers** in step 5, followed by **Read the form again**.
- **Done when:**
  - [ ] A sensitive or inactive LinkedIn entry produces a visible "won't be filled" note in step 1 and in the Vault list, not silence.
  - [ ] The inline add creates a saved answer only on click, and the next read of the form proposes it.
  - [ ] Suggestions never save automatically and never come from AI.
  - [ ] The packet rules are unchanged: one saved answer per question, sensitive answers excluded, sensitive question types never proposed (existing tests pass).
- **Size and risk:** medium.

### UX-8. Costs and versions without pop-ups

- **Fixes:** F9.
- **Changes:**
  - An in-page confirmation replaces `window.confirm` for AI cost and data, the Prepare permission and turning Fill on.
  - The two job-page actions are labelled by step.
  - The Kit marks versions **Recommended** and **Used for this application**, and groups older ones.
- **Done when:**
  - [ ] No `window.confirm` remains in these flows (a test checks).
  - [ ] A request carrying the confirmation headers is sent only after Confirm, and Cancel sends nothing (tested).
  - [ ] The dialog works by keyboard and with a screen reader.
- **Size and risk:** medium; it touches `components/apply-kit/apply-kit.tsx` after UX-5.

### UX-9. A reviewed score doesn't go stale for no reason

- **Fixes:** the sync part of F8.
- **Changes:**
  - Find out why the nightly job-source sync made the reviewed score stale.
  - If the posting's content didn't change, the score stays current.
  - If it did change, the Ready check says so plainly, with the date and the cost to check again.
- **Done when:**
  - [ ] A test syncs an unchanged posting over a manually imported job, and the reviewed score stays current.
  - [ ] A changed posting produces the plain message.
- **Size and risk:** small to medium; it touches job-source code.

### UX-10. Record what you sent after an assisted application

- **Fixes:** F12, plus the duplicate "I applied" actions from S8.
- **Changes:** step 8 (W9) records Applied, the documents sent and the minutes in one confirmation, implemented as decided in D-F.
- **Done when:**
  - [ ] After an assisted application, the tracker shows the documents sent and the minutes.
  - [ ] Applied is still recorded only from your own confirmation.
  - [ ] With the recommended option, the protected run-completion transaction is untouched.
- **Size and risk:** medium.

## 9. Owner decisions needed

Each decision has a recommendation. Nothing here is built until the owner approves this proposal.

| # | Decision | Options | Recommendation |
|---|---|---|---|
| D-A | Where the guide lives | **Apply Kit page** (`/jobs/[id]/apply`) · the application page · a new page | **Apply Kit page.** Every user already has it, it's already numbered steps, and it's where you go to apply. The application page keeps a small summary card. |
| D-B | The Assisted Fill switch | (1) Account-wide, managed from the guide and Settings, no server change · (2) also turn Fill off automatically when an application is finished or stopped (small server change, audited like any policy change) · (3) per-application permission (needs a database change) | **(1) now, plus (2).** A new application then always starts with Fill off, and nobody is left with Fill on by accident. (3) isn't worth a migration yet. |
| D-C | "Open and read the form" as one click | One click sends the existing Open then Read commands · keep two clicks | **One click.** Both only open and read, it's still an explicit action, and nothing new crosses the bridge. |
| D-D | Signing in the Apply Pilot browser | Keep the typed code with the clearer guidance (UX-2, UX-5b) · later: approve the window from your usual browser instead of typing | **Keep the code now.** Revisit approve-instead after the Lever and Ashby trials if typing is still a problem. That needs its own security review. |
| D-E | Starting the companion | Copy-and-run terminal command for the owner self-beta (UX-5b) · build a one-click launcher now | **Terminal command for now.** A one-click start belongs to the M3 delivery decision (optional extension or hosted workspace, Bible §7), not to this redesign. |
| D-F | Recording after an assisted application | (1) Let the Kit's "I applied" add documents and minutes to an application a run already marked Applied, with no status change · (2) extend the run-completion transaction to record them | **(1).** It leaves the protected completion transaction alone and reuses the existing "what I sent" record. |
| D-G | "Sensitive" in the Answer Vault | Relabel only (UX-7) · split "hide on screen" from "never fill" (needs a database change) | **Relabel only.** It's honest about what the box does, with no migration. |
| D-H | Links on the profile or résumé | Suggest saving them to Answers, one click each (UX-7) · let Fill read them directly | **Suggest, don't read directly.** Every filled value stays something you saved and approved. |
| D-I | How much Fill covers on Greenhouse | Out of scope here (§10) | **Decide separately.** The guide states the current limits honestly before Fill. |

## 10. Out of scope here

- **F10: what Fill can fill.** On a standard Greenhouse form, Fill does little whatever the screens look like:
  - contact fields (name, email, phone) are manual by policy;
  - Greenhouse's custom dropdowns aren't supported;
  - uploads are out of scope.

  Widening any of these is a separate owner scope decision, each item needing its own safety review. Until then the guide sets expectations before Fill, for example "Apply Pilot can fill 2 of 18 fields".
- **Already in progress elsewhere:** showing every requirement gap before tailoring (draft PR #66), and the proposed fix for tailored résumés putting bullets under the wrong employer.
- **The hosted workspace** (Bible §7, M3), extensions and auto-submit.
- **Follow-up spotted while reading:** `docs/CONTROLLED_APPLICATION_AUTOMATION.md` still says application planning is always local and never calls an AI provider. Since #67, Prepare can use Gemini. The doc needs a correction in its own small PR.

## 11. How we'll know it worked

- The owner runs the remaining WP1.6 trials (Lever, then Ashby) using only what the screens say, with no outside prompts.
- In those trials: no Google attempts in the Apply Pilot browser, no work done in the wrong window, and no sign-in code refused because of where or how it was shown (owner's report).
- Minutes per application, self-reported in step 8, show on the Insights page as today.
