import type { JobSourceType } from "@prisma/client";

export type JobSearchCriteria = {
  query?: string;
  location?: string;
  remote?: boolean;
  company?: string;
  boardToken?: string;
  url?: string;
  limit?: number;
};

export type RawJob = Record<string, unknown>;

export type NormalizedJob = {
  title: string;
  company: string;
  location?: string;
  remoteStatus?: string;
  salaryMin?: number;
  salaryMax?: number;
  datePosted?: Date;
  sourceUrl: string;
  applyUrl?: string;
  description: string;
  requirements: string[];
  preferredQualifications: string[];
  benefits: string[];
  detectedTechStack: string[];
  seniorityLevel?: string;
  companySize?: string;
  sourceType: JobSourceType;
};

export interface JobSourceProvider {
  sourceType: JobSourceType;
  searchJobs(criteria: JobSearchCriteria): Promise<RawJob[]>;
  getJobDetails(url: string): Promise<RawJob>;
  normalizeJob(rawJob: RawJob): NormalizedJob;
  validateAllowedSource(url?: string): Promise<boolean>;
}
