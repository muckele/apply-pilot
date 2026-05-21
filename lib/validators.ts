import { z } from "zod";

const emptyStringToNull = (value: unknown) => (value === "" ? null : value);

export const jobSourceTypes = [
  "MANUAL",
  "GREENHOUSE",
  "LEVER",
  "ASHBY",
  "WORKABLE",
  "USAJOBS",
  "REMOTIVE",
  "ADZUNA",
  "THEIRSTACK",
  "SERPAPI",
  "RSS",
  "COMPANY_CAREERS"
] as const;

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
  resumeVersionId: z.string().optional(),
  coverLetterVersionId: z.string().optional(),
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

export const gmailTriageSchema = z.object({
  queries: z.array(z.string().min(2)).max(5).optional(),
  maxResultsPerQuery: z.coerce.number().int().min(1).max(20).default(10),
  saveFlagged: z.boolean().optional().default(false)
});

export const automatedJobDiscoverySchema = z.object({
  queries: z.array(z.string().min(2)).max(8).optional(),
  location: z.string().optional(),
  remoteOnly: z.boolean().optional().default(false),
  limitPerQuery: z.coerce.number().int().min(1).max(25).default(8),
  scoreImported: z.boolean().optional().default(false),
  maxJobsToScore: z.coerce.number().int().min(1).max(12).default(6)
});

const jobSourceBaseSchema = z.object({
  name: z.string().min(2).max(120),
  type: z.enum(jobSourceTypes),
  baseUrl: z.preprocess(emptyStringToNull, z.string().url().nullable().optional()),
  boardToken: z.preprocess(emptyStringToNull, z.string().trim().min(1).max(120).nullable().optional()),
  notes: z.preprocess(emptyStringToNull, z.string().trim().max(1000).nullable().optional())
});

export const jobSourceWriteSchema = jobSourceBaseSchema.extend({
  syncEnabled: z.boolean().optional().default(true),
  allowlisted: z.boolean().optional().default(false)
});

export const jobSourcePatchSchema = jobSourceBaseSchema
  .extend({
    syncEnabled: z.boolean().optional(),
    allowlisted: z.boolean().optional()
  })
  .partial();

export const jobSourceSyncSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  location: z.preprocess(emptyStringToNull, z.string().trim().max(120).nullable().optional()),
  remoteOnly: z.boolean().optional().default(false),
  query: z.preprocess(emptyStringToNull, z.string().trim().max(120).nullable().optional())
});

export const cronJobDiscoverySchema = z.object({
  limitPerSource: z.coerce.number().int().min(1).max(50).default(15),
  maxSources: z.coerce.number().int().min(1).max(100).optional(),
  location: z.preprocess(emptyStringToNull, z.string().trim().max(120).nullable().optional()),
  remoteOnly: z.boolean().optional().default(false)
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
