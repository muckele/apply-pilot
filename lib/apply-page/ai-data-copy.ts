// What the Apply page's paid steps send to Google Gemini, said once so every question says the
// same true thing (the in-page Confirm also stands for consent to send it: x-ai-data-confirmed).
// Re-scoring (JOB_MATCH, lib/ai/job-match.ts), writing documents (RESUME_TAILOR / COVER_LETTER,
// lib/ai/resume-tailoring-payload.ts) and Prepare (APPLICATION_PLAN, lib/ai/application-plan.ts)
// each send the job, the master résumé (its text and parsed facts), the profile's job preferences
// (target roles, locations, remote preference, salary target, skills to stress or not overstate)
// and the lines saved for this job. None of them sends contact details or saved answers.
export const SENT_TO_GEMINI =
  "this job, your résumé, your job preferences from your profile (such as target roles, locations and salary) and the lines you added for this job";
