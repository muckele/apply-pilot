import type { AiFeature } from "@/lib/ai/policy";

// Every AI feature has exactly one registration. "active" features have a product
// entry point that runs on Gemini and reserves against the hard monthly budget ledger
// (lib/ai/application-plan-budget.ts#reserveAiBudget) before any provider dispatch.
// "unused" features have a token policy but no caller; adding a caller requires
// registering it here, which the ledger-coverage test then forces to be proven.
export type AiFeatureConfirmation =
  // The user must confirm both the data sent to Gemini and the request's maximum cost.
  | "data_and_cost"
  // Interactive requests above the confirmation threshold need cost confirmation;
  // trusted automation reserves against the smaller automation allowance instead.
  | "cost_threshold";

export type AiFeatureRegistration = Readonly<{
  feature: AiFeature;
  status: "active" | "unused";
  provider: "gemini";
  entryPoint: string | null;
  confirmation: AiFeatureConfirmation;
  dataType: string;
  errorCodePrefix: string;
  label: string;
  requestNoun: string;
  outputNoun: string;
  confirmationMessage: string;
}>;

function registration(
  feature: AiFeature,
  fields: Omit<AiFeatureRegistration, "feature" | "provider">
): AiFeatureRegistration {
  return Object.freeze({ feature, provider: "gemini" as const, ...fields });
}

const APPLICATION_DOCUMENT_FIELDS = {
  status: "active",
  confirmation: "data_and_cost",
  dataType: "application_packet",
  errorCodePrefix: "APPLICATION_DOCUMENT",
  label: "Application-document generation",
  requestNoun: "application-document",
  outputNoun: "an application document",
  confirmationMessage:
    "Confirm sending the projected job, resume, and profile data and this AI request's maximum cost before continuing."
} as const;

export const AI_FEATURE_REGISTRY: Readonly<Record<AiFeature, AiFeatureRegistration>> = Object.freeze({
  RESUME_PARSE: registration("RESUME_PARSE", {
    status: "active",
    entryPoint: "lib/ai/resume.ts#parseResumeTextWithMeta",
    confirmation: "data_and_cost",
    dataType: "resume_text",
    errorCodePrefix: "RESUME_PARSE",
    label: "Resume parsing",
    requestNoun: "resume-parse",
    outputNoun: "a resume result",
    confirmationMessage:
      "Confirm sending the complete resume text and this AI request's maximum cost before continuing."
  }),
  JOB_MATCH: registration("JOB_MATCH", {
    status: "active",
    entryPoint: "lib/ai/job-match.ts#scoreJobMatch",
    confirmation: "cost_threshold",
    dataType: "job_match_packet",
    errorCodePrefix: "JOB_MATCH",
    label: "Job matching",
    requestNoun: "job-match",
    outputNoun: "a job match",
    confirmationMessage: "Confirm this AI request's maximum cost before continuing."
  }),
  RESUME_TAILOR: registration("RESUME_TAILOR", {
    ...APPLICATION_DOCUMENT_FIELDS,
    entryPoint: "lib/ai/resume.ts#tailorResume"
  }),
  COVER_LETTER: registration("COVER_LETTER", {
    ...APPLICATION_DOCUMENT_FIELDS,
    entryPoint: "lib/ai/documents.ts#draftCoverLetter"
  }),
  INTERVIEW_PREP: registration("INTERVIEW_PREP", {
    status: "active",
    entryPoint: "lib/ai/interview-prep.ts#generateInterviewPrep",
    confirmation: "data_and_cost",
    dataType: "interview_prep_packet",
    errorCodePrefix: "INTERVIEW_PREP",
    label: "Interview preparation",
    requestNoun: "interview-preparation",
    outputNoun: "interview preparation",
    confirmationMessage:
      "Confirm sending your master-resume facts and the linked job post, and this AI request's maximum cost, before continuing."
  }),
  INTERVIEW_FEEDBACK: registration("INTERVIEW_FEEDBACK", {
    status: "active",
    entryPoint: "lib/ai/interview-feedback.ts#generateInterviewFeedback",
    confirmation: "data_and_cost",
    dataType: "interview_notes_packet",
    errorCodePrefix: "INTERVIEW_FEEDBACK",
    label: "Interview feedback",
    requestNoun: "interview-feedback",
    outputNoun: "interview feedback",
    confirmationMessage:
      "Confirm sending your interview notes, any pasted transcript, and your master-resume facts, and this AI request's maximum cost, before continuing."
  }),
  EMAIL_REPLY: registration("EMAIL_REPLY", {
    status: "active",
    entryPoint: "lib/ai/email-reply.ts#draftEmailReply",
    confirmation: "data_and_cost",
    dataType: "email_reply_packet",
    errorCodePrefix: "EMAIL_REPLY",
    label: "Email reply drafting",
    requestNoun: "email-reply",
    outputNoun: "an email reply draft",
    confirmationMessage:
      "Confirm sending the email text and linked job details, and this AI request's maximum cost, before continuing."
  }),
  APPLICATION_PLAN: registration("APPLICATION_PLAN", {
    status: "active",
    entryPoint: "lib/ai/application-plan.ts#planApplication",
    confirmation: "cost_threshold",
    dataType: "application_plan_packet",
    errorCodePrefix: "APPLICATION_PLAN",
    label: "Application planning",
    requestNoun: "application-plan",
    outputNoun: "an application plan",
    confirmationMessage: "Confirm this AI request's maximum cost before continuing."
  }),
  JOB_PARSE: registration("JOB_PARSE", {
    status: "unused",
    entryPoint: null,
    confirmation: "data_and_cost",
    dataType: "job_text",
    errorCodePrefix: "JOB_PARSE",
    label: "Job parsing",
    requestNoun: "job-parse",
    outputNoun: "a job parse",
    confirmationMessage: "Confirm this AI request's data and maximum cost before continuing."
  }),
  EMAIL_CLASSIFICATION: registration("EMAIL_CLASSIFICATION", {
    status: "unused",
    entryPoint: null,
    confirmation: "data_and_cost",
    dataType: "email_text",
    errorCodePrefix: "EMAIL_CLASSIFICATION",
    label: "Email classification",
    requestNoun: "email-classification",
    outputNoun: "an email classification",
    confirmationMessage: "Confirm this AI request's data and maximum cost before continuing."
  })
});

export function activeAiFeatures(): AiFeature[] {
  return (Object.keys(AI_FEATURE_REGISTRY) as AiFeature[])
    .filter((feature) => AI_FEATURE_REGISTRY[feature].status === "active");
}
