import type { JobSourceProvider, JobSearchCriteria, NormalizedJob, RawJob } from "@/lib/job-sources/types";
import { detectTechStack, htmlToText, splitRequirementText } from "@/lib/job-sources/utils";

type TheirStackJob = {
  id?: number;
  job_title?: string;
  url?: string;
  final_url?: string;
  source_url?: string;
  date_posted?: string;
  company?: string;
  location?: string;
  short_location?: string;
  long_location?: string;
  remote?: boolean;
  hybrid?: boolean;
  salary_string?: string;
  min_annual_salary_usd?: number;
  max_annual_salary_usd?: number;
  description?: string;
  job_seniority?: string;
  technologies?: Array<{ name?: string; slug?: string } | string>;
  company_object?: {
    employee_count_range?: string;
    domain?: string;
  };
};

export class TheirStackProvider implements JobSourceProvider {
  sourceType = "THEIRSTACK" as const;

  async searchJobs(criteria: JobSearchCriteria) {
    const apiKey = process.env.THEIRSTACK_API_KEY;

    if (!apiKey) {
      throw new Error("TheirStack sync requires THEIRSTACK_API_KEY.");
    }

    const body: Record<string, unknown> = {
      page: 0,
      limit: criteria.limit ?? 25,
      posted_at_max_age_days: Number(process.env.THEIRSTACK_POSTED_MAX_AGE_DAYS ?? 30),
      job_country_code_or: ["US"],
      company_type: "direct_employer"
    };

    if (criteria.query) {
      body.job_title_or = [criteria.query];
    }
    if (criteria.remote) {
      body.remote = true;
    } else if (criteria.location) {
      body.job_location_pattern_or = [criteria.location];
    }

    const response = await fetch("https://api.theirstack.com/v1/jobs/search", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body),
      next: { revalidate: 900 }
    });

    if (!response.ok) {
      throw new Error(`TheirStack returned ${response.status}.`);
    }

    const payload = (await response.json()) as { data?: TheirStackJob[] };
    return (payload.data ?? []).slice(0, criteria.limit ?? 25) as RawJob[];
  }

  async getJobDetails(url: string) {
    const response = await fetch(url, { next: { revalidate: 900 } });
    if (!response.ok) {
      throw new Error(`Unable to fetch TheirStack posting URL: ${response.status}.`);
    }

    return { sourceUrl: url, html: await response.text() };
  }

  normalizeJob(rawJob: RawJob): NormalizedJob {
    const job = rawJob as TheirStackJob;
    const description = htmlToText(job.description ?? "");
    const tech = (job.technologies ?? [])
      .map((item) => (typeof item === "string" ? item : item.name ?? item.slug ?? ""))
      .filter(Boolean);
    const sourceUrl = job.final_url ?? job.url ?? job.source_url ?? "";

    return {
      title: job.job_title ?? "TheirStack job posting",
      company: job.company ?? job.company_object?.domain ?? "Company not listed",
      location: job.long_location ?? job.location ?? job.short_location,
      remoteStatus: job.remote ? "Remote" : job.hybrid ? "Hybrid" : undefined,
      salaryMin: job.min_annual_salary_usd ? Math.round(job.min_annual_salary_usd) : undefined,
      salaryMax: job.max_annual_salary_usd ? Math.round(job.max_annual_salary_usd) : undefined,
      datePosted: job.date_posted ? new Date(job.date_posted) : undefined,
      sourceUrl,
      applyUrl: sourceUrl,
      description,
      requirements: splitRequirementText(description),
      preferredQualifications: [],
      benefits: job.salary_string ? [job.salary_string] : [],
      detectedTechStack: [...detectTechStack(description), ...tech].slice(0, 20),
      seniorityLevel: job.job_seniority,
      companySize: job.company_object?.employee_count_range,
      sourceType: "THEIRSTACK"
    };
  }

  async validateAllowedSource(url?: string) {
    if (!url) {
      return true;
    }

    return Boolean(new URL(url).hostname);
  }
}
