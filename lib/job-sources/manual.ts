import type { JobSourceProvider, NormalizedJob, RawJob } from "@/lib/job-sources/types";
import { detectTechStack, splitRequirementText } from "@/lib/job-sources/utils";

export class ManualJobImportProvider implements JobSourceProvider {
  sourceType = "MANUAL" as const;

  async searchJobs() {
    return [];
  }

  async getJobDetails(url: string) {
    return { sourceUrl: url };
  }

  normalizeJob(rawJob: RawJob): NormalizedJob {
    const description = String(rawJob.description ?? "");

    return {
      title: String(rawJob.title ?? ""),
      company: String(rawJob.company ?? ""),
      location: String(rawJob.location ?? ""),
      remoteStatus: rawJob.remoteStatus ? String(rawJob.remoteStatus) : undefined,
      salaryMin: rawJob.salaryMin ? Number(rawJob.salaryMin) : undefined,
      salaryMax: rawJob.salaryMax ? Number(rawJob.salaryMax) : undefined,
      datePosted: rawJob.datePosted ? new Date(String(rawJob.datePosted)) : undefined,
      sourceUrl: String(rawJob.sourceUrl ?? rawJob.applyUrl ?? ""),
      applyUrl: rawJob.applyUrl ? String(rawJob.applyUrl) : undefined,
      description,
      requirements: Array.isArray(rawJob.requirements)
        ? rawJob.requirements.map(String)
        : splitRequirementText(description),
      preferredQualifications: Array.isArray(rawJob.preferredQualifications)
        ? rawJob.preferredQualifications.map(String)
        : [],
      benefits: Array.isArray(rawJob.benefits) ? rawJob.benefits.map(String) : [],
      detectedTechStack: Array.isArray(rawJob.detectedTechStack)
        ? rawJob.detectedTechStack.map(String)
        : detectTechStack(description),
      seniorityLevel: rawJob.seniorityLevel ? String(rawJob.seniorityLevel) : undefined,
      companySize: rawJob.companySize ? String(rawJob.companySize) : undefined,
      sourceType: "MANUAL"
    };
  }

  async validateAllowedSource() {
    return true;
  }
}
