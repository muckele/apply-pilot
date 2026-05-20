import type { JobSourceProvider, JobSearchCriteria, NormalizedJob, RawJob } from "@/lib/job-sources/types";
import { detectTechStack, htmlToText, splitRequirementText } from "@/lib/job-sources/utils";

type WorkableJob = {
  shortcode?: string;
  title?: string;
  full_title?: string;
  shortlink?: string;
  url?: string;
  location?: {
    location_str?: string;
    city?: string;
    region?: string;
    country?: string;
    telecommuting?: boolean;
  };
  description?: string;
  requirements?: string;
  benefits?: string;
  published_on?: string;
  employment_type?: string;
};

export class WorkableProvider implements JobSourceProvider {
  sourceType = "WORKABLE" as const;

  async searchJobs(criteria: JobSearchCriteria) {
    const token = process.env.WORKABLE_API_TOKEN;
    const subdomain = criteria.company ?? criteria.boardToken;

    if (!token || !subdomain) {
      throw new Error("Workable sync requires WORKABLE_API_TOKEN and a Workable account subdomain.");
    }

    const params = new URLSearchParams({
      state: "published",
      limit: String(criteria.limit ?? 50)
    });

    const response = await fetch(`https://${subdomain}.workable.com/spi/v3/jobs?${params.toString()}`, {
      headers: { Authorization: `Bearer ${token}` },
      next: { revalidate: 900 }
    });

    if (!response.ok) {
      throw new Error(`Workable returned ${response.status}.`);
    }

    const payload = (await response.json()) as { jobs?: WorkableJob[] };
    return (payload.jobs ?? []).slice(0, criteria.limit ?? 50) as RawJob[];
  }

  async getJobDetails(url: string) {
    const response = await fetch(url, { next: { revalidate: 900 } });
    if (!response.ok) {
      throw new Error(`Unable to fetch Workable posting: ${response.status}.`);
    }

    return { sourceUrl: url, html: await response.text() };
  }

  normalizeJob(rawJob: RawJob): NormalizedJob {
    const job = rawJob as WorkableJob & { sourceUrl?: string; company?: string };
    const description = htmlToText([job.description, job.requirements, job.benefits].filter(Boolean).join("\n\n"));
    const location = job.location?.location_str || [job.location?.city, job.location?.region, job.location?.country].filter(Boolean).join(", ");

    return {
      title: job.full_title ?? job.title ?? "Workable posting",
      company: String(job.company ?? ""),
      location,
      remoteStatus: job.location?.telecommuting ? "Remote" : undefined,
      datePosted: job.published_on ? new Date(job.published_on) : undefined,
      sourceUrl: job.shortlink ?? job.url ?? job.sourceUrl ?? "",
      applyUrl: job.shortlink ?? job.url ?? job.sourceUrl,
      description,
      requirements: splitRequirementText(htmlToText(job.requirements ?? description)),
      preferredQualifications: [],
      benefits: job.benefits ? splitRequirementText(htmlToText(job.benefits)) : [],
      detectedTechStack: detectTechStack(description),
      seniorityLevel: job.employment_type,
      sourceType: "WORKABLE"
    };
  }

  async validateAllowedSource(url?: string) {
    if (!url) {
      return true;
    }

    const host = new URL(url).hostname;
    return host.includes("workable.com");
  }
}
