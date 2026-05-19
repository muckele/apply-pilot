import type { JobSourceProvider, JobSearchCriteria, NormalizedJob, RawJob } from "@/lib/job-sources/types";
import { detectTechStack, htmlToText, splitRequirementText } from "@/lib/job-sources/utils";

type GreenhouseJob = {
  id: number;
  title: string;
  absolute_url: string;
  content?: string;
  location?: { name?: string };
  updated_at?: string;
  offices?: Array<{ name: string }>;
};

export class GreenhouseProvider implements JobSourceProvider {
  sourceType = "GREENHOUSE" as const;

  async searchJobs(criteria: JobSearchCriteria) {
    if (!criteria.boardToken) {
      throw new Error("Greenhouse sync requires a board token.");
    }

    const limit = criteria.limit ?? 50;
    const response = await fetch(
      `https://boards-api.greenhouse.io/v1/boards/${criteria.boardToken}/jobs?content=true`,
      { next: { revalidate: 900 } }
    );

    if (!response.ok) {
      throw new Error(`Greenhouse returned ${response.status}.`);
    }

    const payload = (await response.json()) as { jobs: GreenhouseJob[] };
    return payload.jobs.slice(0, limit) as RawJob[];
  }

  async getJobDetails(url: string) {
    const response = await fetch(url, { next: { revalidate: 900 } });
    if (!response.ok) {
      throw new Error(`Unable to fetch Greenhouse posting: ${response.status}.`);
    }

    return { sourceUrl: url, html: await response.text() };
  }

  normalizeJob(rawJob: RawJob): NormalizedJob {
    const job = rawJob as GreenhouseJob & { sourceUrl?: string; html?: string };
    const description = htmlToText(job.content ?? job.html ?? "");

    return {
      title: job.title,
      company: "",
      location: job.location?.name ?? job.offices?.map((office) => office.name).join(", "),
      datePosted: job.updated_at ? new Date(job.updated_at) : undefined,
      sourceUrl: job.absolute_url ?? job.sourceUrl ?? "",
      applyUrl: job.absolute_url ?? job.sourceUrl,
      description,
      requirements: splitRequirementText(description),
      preferredQualifications: [],
      benefits: [],
      detectedTechStack: detectTechStack(description),
      sourceType: "GREENHOUSE"
    };
  }

  async validateAllowedSource(url?: string) {
    if (!url) {
      return true;
    }

    const host = new URL(url).hostname;
    return host.includes("greenhouse.io") || host.includes("greenhouse.com");
  }
}
