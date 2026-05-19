import type { JobSourceProvider, JobSearchCriteria, NormalizedJob, RawJob } from "@/lib/job-sources/types";
import { detectTechStack, htmlToText, splitRequirementText } from "@/lib/job-sources/utils";

type AshbyJob = {
  title: string;
  department?: string;
  location?: string;
  jobUrl: string;
  applyUrl?: string;
  descriptionHtml?: string;
  publishedDate?: string;
  compensation?: { compensationTierSummary?: string };
};

export class AshbyProvider implements JobSourceProvider {
  sourceType = "ASHBY" as const;

  async searchJobs(criteria: JobSearchCriteria) {
    const organization = criteria.company ?? criteria.boardToken;
    if (!organization) {
      throw new Error("Ashby sync requires an organization slug.");
    }

    const response = await fetch(
      `https://api.ashbyhq.com/posting-api/job-board/${organization}?includeCompensation=true`,
      { next: { revalidate: 900 } }
    );

    if (!response.ok) {
      throw new Error(`Ashby returned ${response.status}.`);
    }

    const payload = (await response.json()) as { jobs: AshbyJob[] };
    return payload.jobs.slice(0, criteria.limit ?? 50) as RawJob[];
  }

  async getJobDetails(url: string) {
    const response = await fetch(url, { next: { revalidate: 900 } });
    if (!response.ok) {
      throw new Error(`Unable to fetch Ashby posting: ${response.status}.`);
    }

    return { sourceUrl: url, html: await response.text() };
  }

  normalizeJob(rawJob: RawJob): NormalizedJob {
    const job = rawJob as AshbyJob & { sourceUrl?: string; html?: string };
    const description = htmlToText(job.descriptionHtml ?? job.html ?? "");

    return {
      title: job.title,
      company: "",
      location: job.location,
      datePosted: job.publishedDate ? new Date(job.publishedDate) : undefined,
      sourceUrl: job.jobUrl ?? job.sourceUrl ?? "",
      applyUrl: job.applyUrl ?? job.jobUrl ?? job.sourceUrl,
      description,
      requirements: splitRequirementText(description),
      preferredQualifications: [],
      benefits: job.compensation?.compensationTierSummary
        ? [job.compensation.compensationTierSummary]
        : [],
      detectedTechStack: detectTechStack(description),
      sourceType: "ASHBY"
    };
  }

  async validateAllowedSource(url?: string) {
    if (!url) {
      return true;
    }

    return new URL(url).hostname.includes("ashbyhq.com");
  }
}
