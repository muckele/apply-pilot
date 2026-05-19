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
- Company career pages where access is permitted
- RSS feeds or public APIs where allowed
- USAJobs, Remotive, or similar APIs when terms permit

Disallowed:

- Unauthorized scraping of LinkedIn, Indeed, ZipRecruiter, Glassdoor, or similar sites
- Circumventing robots.txt or terms of service
- Automating logged-in job-board activity
- Auto-applying or submitting forms without the user

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
