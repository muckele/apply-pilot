# Compliance Notes

## Human-In-The-Loop Rules

JobMatch CRM is designed to assist, not act autonomously.

- The app may open an apply link, but it must not submit applications.
- The app may draft emails, but it must not send them without explicit approval.
- The app may search Gmail after OAuth consent, but it must not delete email.
- The app may save recruiter messages only when the user chooses to save them.
- The app may process interview audio only after consent confirmation.

## Job Discovery Rules

Allowed sources:

- Manual paste/import
- Public Greenhouse board APIs
- Public Lever posting APIs
- Public Ashby posting APIs
- Remotive public jobs API
- Adzuna jobs API with user-provided app credentials
- TheirStack licensed jobs API with user-provided API key
- SerpApi Google Jobs API with user-provided API key
- USAJOBS official API when configured with valid credentials
- Workable API only when the user has an approved token/account
- Company career pages where access is permitted
- RSS feeds or public APIs where allowed
- USAJobs, Remotive, or similar APIs when terms permit

Disallowed:

- Unauthorized scraping of LinkedIn, Indeed, ZipRecruiter, CareerBuilder, Glassdoor, or similar sites
- Circumventing robots.txt or terms of service
- Automating logged-in job-board activity
- Auto-applying or submitting forms without the user

Restricted board handling:

- LinkedIn, Indeed, ZipRecruiter, and CareerBuilder are treated as approved-API-required sources.
- The app may store links, manually pasted postings, Gmail alerts, user-reviewed imports, or results returned by a licensed API provider whose terms allow that use.
- The app must not crawl their search pages, use logged-in browser automation, bypass rate limits, solve bot challenges, rotate proxies, or disguise itself as a human job seeker.
- Scheduled job-source sync must use the same approved-source provider layer as manual sync and must remain protected by `CRON_SECRET`.

## Resume and ATS Claims

The app should use the phrase “ATS compatibility and job-fit score.” It must not claim to guarantee an ATS score, interview, recruiter response, or offer.

Resume tailoring must stay honest:

- Do not invent tools, employers, metrics, certifications, degrees, or titles.
- Do not include keywords that are not supported by real experience.
- Prefer concise, measurable, truthful bullets.
- Keep formatting ATS-friendly: no tables, columns, graphics, text boxes, or overly designed layouts.

## Interview Recording

Before recording, uploading, or transcribing interview audio, the user must confirm:

> I confirm that all participants have been informed and have consented to recording/transcription.

Recording laws vary by location. This app-level confirmation does not replace legal advice or employer/interviewer policies.
