import { boardReferenceFromCriteria, fetchBoardListing } from "@/lib/job-sources/board-fetch";
import { workStyleFromLocation } from "@/lib/job-sources/location-match";
import type { JobSourceProvider, JobSearchCriteria, NormalizedJob, RawJob } from "@/lib/job-sources/types";
import { detectTechStack, htmlToText, splitRequirementText, workStyleLabel } from "@/lib/job-sources/utils";

type AshbyCompensationComponent = {
  compensationType?: string;
  interval?: string;
  currencyCode?: string | null;
  minValue?: number | null;
  maxValue?: number | null;
};

type AshbyJob = {
  title: string;
  department?: string;
  location?: string;
  secondaryLocations?: Array<{ location?: string }>;
  isRemote?: boolean;
  workplaceType?: string;
  jobUrl: string;
  applyUrl?: string;
  descriptionHtml?: string;
  descriptionPlain?: string;
  publishedAt?: string;
  publishedDate?: string;
  compensation?: { compensationTierSummary?: string | null; summaryComponents?: AshbyCompensationComponent[] };
};

function yearlyUsdSalary(components: AshbyCompensationComponent[] | undefined) {
  const salary = components?.find(
    (component) =>
      component.compensationType === "Salary" && component.interval === "1 YEAR" && component.currencyCode === "USD"
  );

  return {
    salaryMin: typeof salary?.minValue === "number" ? Math.round(salary.minValue) : undefined,
    salaryMax: typeof salary?.maxValue === "number" ? Math.round(salary.maxValue) : undefined
  };
}

export class AshbyProvider implements JobSourceProvider {
  sourceType = "ASHBY" as const;

  // Public posting API: GET api.ashbyhq.com/posting-api/job-board/{name}. Unlisted postings are dropped.
  async searchJobs(criteria: JobSearchCriteria) {
    const jobs = await fetchBoardListing(boardReferenceFromCriteria("ASHBY", criteria));
    return jobs.slice(0, criteria.limit ?? 50) as RawJob[];
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
    const description = job.descriptionPlain?.trim() || htmlToText(job.descriptionHtml ?? job.html ?? "");
    const locations = [job.location, ...(job.secondaryLocations ?? []).map((entry) => entry.location)]
      .map((value) => value?.trim())
      .filter((value): value is string => Boolean(value));
    const publishedAt = job.publishedAt ?? job.publishedDate;

    return {
      title: job.title?.trim(),
      company: "",
      location: [...new Set(locations)].join("; ") || undefined,
      remoteStatus: job.isRemote ? "Remote" : workStyleLabel(job.workplaceType) ?? workStyleFromLocation(locations.join("; ")),
      ...yearlyUsdSalary(job.compensation?.summaryComponents),
      datePosted: publishedAt ? new Date(publishedAt) : undefined,
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
