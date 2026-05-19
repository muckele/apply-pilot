import { z } from "zod";

export const manualJobImportSchema = z.object({
  title: z.string().min(2),
  company: z.string().min(2),
  location: z.string().optional().default(""),
  remoteStatus: z.string().optional(),
  salaryMin: z.coerce.number().int().positive().optional(),
  salaryMax: z.coerce.number().int().positive().optional(),
  datePosted: z.coerce.date().optional(),
  sourceUrl: z.string().url(),
  applyUrl: z.string().url().optional(),
  description: z.string().min(25),
  requirements: z.array(z.string()).optional().default([]),
  preferredQualifications: z.array(z.string()).optional().default([]),
  benefits: z.array(z.string()).optional().default([]),
  detectedTechStack: z.array(z.string()).optional().default([]),
  seniorityLevel: z.string().optional(),
  companySize: z.string().optional(),
  runMatch: z.boolean().optional().default(true)
});

export const resumeParseSchema = z.object({
  title: z.string().min(1).default("Master Resume"),
  pastedText: z.string().optional(),
  isMaster: z.boolean().optional().default(true)
});

export const applicationUpdateSchema = z.object({
  status: z
    .enum([
      "SAVED",
      "INTERESTED",
      "APPLIED",
      "RECRUITER_SCREEN",
      "HIRING_MANAGER_SCREEN",
      "TECHNICAL_INTERVIEW",
      "FINAL_INTERVIEW",
      "OFFER",
      "REJECTED",
      "GHOSTED",
      "ARCHIVED"
    ])
    .optional(),
  dateApplied: z.coerce.date().optional(),
  followUpDueAt: z.coerce.date().optional(),
  nextAction: z.string().optional(),
  notes: z.string().optional(),
  outcome: z.string().optional(),
  lessonsLearned: z.string().optional()
});

export const interviewUpdateSchema = z.object({
  type: z
    .enum(["RECRUITER", "HIRING_MANAGER", "TECHNICAL", "PANEL", "FINAL", "OTHER"])
    .optional(),
  scheduledAt: z.coerce.date().optional(),
  durationMinutes: z.coerce.number().int().positive().optional(),
  locationOrLink: z.string().optional(),
  interviewerNames: z.array(z.string()).optional(),
  interviewerUrls: z.array(z.string().url()).optional(),
  notes: z.string().optional()
});

export const gmailSearchSchema = z.object({
  query: z.string().min(2).default(
    "from:(greenhouse.io OR lever.co OR ashbyhq.com OR workable.com) subject:(interview OR application OR recruiter OR hiring OR next steps) newer_than:90d"
  ),
  maxResults: z.coerce.number().int().min(1).max(25).default(10)
});

export const emailDraftSchema = z.object({
  emailMessageId: z.string().optional(),
  emailText: z.string().min(10),
  tone: z.enum(["concise", "warm", "confident", "professional"]).default("professional"),
  jobPostingId: z.string().optional()
});

export const interviewAudioSchema = z.object({
  consentConfirmed: z.boolean(),
  consentStatement: z
    .string()
    .default("I confirm that all participants have been informed and have consented to recording/transcription.")
});
