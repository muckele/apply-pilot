import type { JobSourceProvider, JobSearchCriteria, NormalizedJob, RawJob } from "@/lib/job-sources/types";
import { detectTechStack, htmlToText, splitRequirementText } from "@/lib/job-sources/utils";

type LeverJob = {
  id: string;
  text: string;
  hostedUrl: string;
  applyUrl?: string;
  descriptionPlain?: string;
  description?: string;
  categories?: {
    team?: string;
    location?: string;
    commitment?: string;
  };
  createdAt?: number;
};

export class LeverProvider implements JobSourceProvider {
  sourceType = "LEVER" as const;

  async searchJobs(criteria: JobSearchCriteria) {
    const company = criteria.company ?? criteria.boardToken;
    if (!company) {
      throw new Error("Lever sync requires a company slug.");
    }

    const response = await fetch(`https://api.lever.co/v0/postings/${company}?mode=json`, {
      next: { revalidate: 900 }
    });

    if (!response.ok) {
      throw new Error(`Lever returned ${response.status}.`);
    }

    const jobs = (await response.json()) as LeverJob[];
    return jobs.slice(0, criteria.limit ?? 50) as RawJob[];
  }

  async getJobDetails(url: string) {
    const response = await fetch(url, { next: { revalidate: 900 } });
    if (!response.ok) {
      throw new Error(`Unable to fetch Lever posting: ${response.status}.`);
    }

    return { sourceUrl: url, html: await response.text() };
  }

  normalizeJob(rawJob: RawJob): NormalizedJob {
    const job = rawJob as LeverJob & { sourceUrl?: string; html?: string };
    const description = job.descriptionPlain ?? htmlToText(job.description ?? job.html ?? "");

    return {
      title: job.text,
      company: "",
      location: job.categories?.location,
      remoteStatus: job.categories?.commitment,
      datePosted: job.createdAt ? new Date(job.createdAt) : undefined,
      sourceUrl: job.hostedUrl ?? job.sourceUrl ?? "",
      applyUrl: job.applyUrl ?? job.hostedUrl ?? job.sourceUrl,
      description,
      requirements: splitRequirementText(description),
      preferredQualifications: [],
      benefits: [],
      detectedTechStack: detectTechStack(description),
      sourceType: "LEVER"
    };
  }

  async validateAllowedSource(url?: string) {
    if (!url) {
      return true;
    }

    return new URL(url).hostname.includes("lever.co");
  }
}
