import type { JobSourceProvider, JobSearchCriteria, NormalizedJob, RawJob } from "@/lib/job-sources/types";
import {
  detectTechStack,
  htmlToText,
  parseSalaryRange,
  splitRequirementText
} from "@/lib/job-sources/utils";

type RemotiveJob = {
  id: number;
  url: string;
  title: string;
  company_name: string;
  category?: string;
  job_type?: string;
  candidate_required_location?: string;
  salary?: string;
  description?: string;
  publication_date?: string;
  tags?: string[];
};

export class RemotiveProvider implements JobSourceProvider {
  sourceType = "REMOTIVE" as const;

  async searchJobs(criteria: JobSearchCriteria) {
    const params = new URLSearchParams();
    if (criteria.query) {
      params.set("search", criteria.query);
    }

    const response = await fetch(`https://remotive.com/api/remote-jobs?${params.toString()}`, {
      next: { revalidate: 900 }
    });

    if (!response.ok) {
      throw new Error(`Remotive returned ${response.status}.`);
    }

    const payload = (await response.json()) as { jobs?: RemotiveJob[] };
    return (payload.jobs ?? []).slice(0, criteria.limit ?? 50) as RawJob[];
  }

  async getJobDetails(url: string) {
    const response = await fetch(url, { next: { revalidate: 900 } });
    if (!response.ok) {
      throw new Error(`Unable to fetch Remotive posting: ${response.status}.`);
    }

    return { sourceUrl: url, html: await response.text() };
  }

  normalizeJob(rawJob: RawJob): NormalizedJob {
    const job = rawJob as RemotiveJob & { sourceUrl?: string; html?: string };
    const description = htmlToText(job.description ?? job.html ?? "");
    const salary = parseSalaryRange(job.salary);

    return {
      title: job.title,
      company: job.company_name,
      location: job.candidate_required_location ?? "Remote",
      remoteStatus: "Remote",
      salaryMin: salary.salaryMin,
      salaryMax: salary.salaryMax,
      datePosted: job.publication_date ? new Date(job.publication_date) : undefined,
      sourceUrl: job.url ?? job.sourceUrl ?? "",
      applyUrl: job.url ?? job.sourceUrl,
      description,
      requirements: splitRequirementText(description),
      preferredQualifications: [],
      benefits: job.salary ? [job.salary] : [],
      detectedTechStack: [...detectTechStack(description), ...(job.tags ?? [])].slice(0, 20),
      seniorityLevel: job.job_type,
      sourceType: "REMOTIVE"
    };
  }

  async validateAllowedSource(url?: string) {
    if (!url) {
      return true;
    }

    return new URL(url).hostname.includes("remotive.com");
  }
}
