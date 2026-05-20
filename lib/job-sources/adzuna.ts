import type { JobSourceProvider, JobSearchCriteria, NormalizedJob, RawJob } from "@/lib/job-sources/types";
import { detectTechStack, htmlToText, splitRequirementText } from "@/lib/job-sources/utils";

type AdzunaJob = {
  id?: string;
  title?: string;
  description?: string;
  redirect_url?: string;
  created?: string;
  salary_min?: number;
  salary_max?: number;
  company?: { display_name?: string };
  location?: { display_name?: string; area?: string[] };
  category?: { label?: string };
  contract_time?: string;
  contract_type?: string;
};

export class AdzunaProvider implements JobSourceProvider {
  sourceType = "ADZUNA" as const;

  async searchJobs(criteria: JobSearchCriteria) {
    const appId = process.env.ADZUNA_APP_ID;
    const appKey = process.env.ADZUNA_APP_KEY;
    const country = (process.env.ADZUNA_COUNTRY || "us").toLowerCase();

    if (!appId || !appKey) {
      throw new Error("Adzuna sync requires ADZUNA_APP_ID and ADZUNA_APP_KEY.");
    }

    const params = new URLSearchParams({
      app_id: appId,
      app_key: appKey,
      "content-type": "application/json",
      results_per_page: String(criteria.limit ?? 25),
      sort_by: "date"
    });

    if (criteria.query) {
      params.set("what", criteria.query);
    }
    if (criteria.location && !criteria.remote) {
      params.set("where", criteria.location);
    }

    const response = await fetch(`https://api.adzuna.com/v1/api/jobs/${country}/search/1?${params.toString()}`, {
      headers: { Accept: "application/json" },
      next: { revalidate: 900 }
    });

    if (!response.ok) {
      throw new Error(`Adzuna returned ${response.status}.`);
    }

    const payload = (await response.json()) as { results?: AdzunaJob[] };
    return (payload.results ?? []).slice(0, criteria.limit ?? 25) as RawJob[];
  }

  async getJobDetails(url: string) {
    const response = await fetch(url, { next: { revalidate: 900 } });
    if (!response.ok) {
      throw new Error(`Unable to fetch Adzuna posting: ${response.status}.`);
    }

    return { sourceUrl: url, html: await response.text() };
  }

  normalizeJob(rawJob: RawJob): NormalizedJob {
    const job = rawJob as AdzunaJob;
    const description = htmlToText(job.description ?? "");
    const textForRemote = `${job.title ?? ""} ${description}`.toLowerCase();

    return {
      title: job.title ?? "Adzuna job posting",
      company: job.company?.display_name ?? "Company not listed",
      location: job.location?.display_name ?? job.location?.area?.join(", "),
      remoteStatus: textForRemote.includes("remote") ? "Remote" : undefined,
      salaryMin: job.salary_min ? Math.round(job.salary_min) : undefined,
      salaryMax: job.salary_max ? Math.round(job.salary_max) : undefined,
      datePosted: job.created ? new Date(job.created) : undefined,
      sourceUrl: job.redirect_url ?? "",
      applyUrl: job.redirect_url,
      description,
      requirements: splitRequirementText(description),
      preferredQualifications: [],
      benefits: [],
      detectedTechStack: detectTechStack(description),
      seniorityLevel: [job.contract_time, job.contract_type, job.category?.label].filter(Boolean).join(" · ") || undefined,
      sourceType: "ADZUNA"
    };
  }

  async validateAllowedSource(url?: string) {
    if (!url) {
      return true;
    }

    return new URL(url).hostname.includes("adzuna.");
  }
}
