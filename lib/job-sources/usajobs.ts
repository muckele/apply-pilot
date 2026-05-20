import type { JobSourceProvider, JobSearchCriteria, NormalizedJob, RawJob } from "@/lib/job-sources/types";
import {
  detectTechStack,
  htmlToText,
  parseSalaryRange,
  pickFirstText,
  splitRequirementText
} from "@/lib/job-sources/utils";

type UsaJobsDescriptor = {
  PositionTitle?: string;
  OrganizationName?: string;
  PositionLocationDisplay?: string;
  PositionURI?: string;
  ApplyURI?: string[];
  PublicationStartDate?: string;
  QualificationSummary?: string;
  UserArea?: {
    Details?: {
      JobSummary?: string;
      MajorDuties?: string[];
      Requirements?: string;
      Evaluations?: string;
      Benefits?: string;
      RemoteIndicator?: boolean;
    };
  };
  PositionRemuneration?: Array<{
    MinimumRange?: string;
    MaximumRange?: string;
    RateIntervalCode?: string;
  }>;
};

type UsaJobsSearchItem = {
  MatchedObjectDescriptor?: UsaJobsDescriptor;
};

export class UsaJobsProvider implements JobSourceProvider {
  sourceType = "USAJOBS" as const;

  async searchJobs(criteria: JobSearchCriteria) {
    const apiKey = process.env.USAJOBS_API_KEY;
    const userAgent = process.env.USAJOBS_USER_AGENT;

    if (!apiKey || !userAgent) {
      throw new Error("USAJOBS sync requires USAJOBS_API_KEY and USAJOBS_USER_AGENT.");
    }

    const params = new URLSearchParams({
      ResultsPerPage: String(criteria.limit ?? 25)
    });

    if (criteria.query) {
      params.set("Keyword", criteria.query);
    }
    if (criteria.location && !criteria.remote) {
      params.set("LocationName", criteria.location);
    }

    const response = await fetch(`https://data.usajobs.gov/api/Search?${params.toString()}`, {
      headers: {
        Host: "data.usajobs.gov",
        "User-Agent": userAgent,
        "Authorization-Key": apiKey
      },
      next: { revalidate: 900 }
    });

    if (!response.ok) {
      throw new Error(`USAJOBS returned ${response.status}.`);
    }

    const payload = (await response.json()) as {
      SearchResult?: { SearchResultItems?: UsaJobsSearchItem[] };
    };

    return (payload.SearchResult?.SearchResultItems ?? [])
      .map((item) => item.MatchedObjectDescriptor)
      .filter(Boolean)
      .slice(0, criteria.limit ?? 25) as RawJob[];
  }

  async getJobDetails(url: string) {
    const response = await fetch(url, { next: { revalidate: 900 } });
    if (!response.ok) {
      throw new Error(`Unable to fetch USAJOBS posting: ${response.status}.`);
    }

    return { sourceUrl: url, html: await response.text() };
  }

  normalizeJob(rawJob: RawJob): NormalizedJob {
    const job = rawJob as UsaJobsDescriptor & { sourceUrl?: string; html?: string };
    const details = job.UserArea?.Details;
    const description = htmlToText(
      [
        details?.JobSummary,
        ...(details?.MajorDuties ?? []),
        job.QualificationSummary,
        details?.Requirements,
        details?.Evaluations
      ]
        .filter(Boolean)
        .join("\n\n")
    );
    const salaryText = job.PositionRemuneration
      ?.map((range) => `${range.MinimumRange ?? ""} ${range.MaximumRange ?? ""}`)
      .join(" ");
    const salary = parseSalaryRange(salaryText);

    return {
      title: pickFirstText(job.PositionTitle, "USAJOBS posting"),
      company: pickFirstText(job.OrganizationName, "Federal agency"),
      location: job.PositionLocationDisplay,
      remoteStatus: details?.RemoteIndicator ? "Remote" : undefined,
      salaryMin: salary.salaryMin,
      salaryMax: salary.salaryMax,
      datePosted: job.PublicationStartDate ? new Date(job.PublicationStartDate) : undefined,
      sourceUrl: job.PositionURI ?? job.sourceUrl ?? "",
      applyUrl: job.ApplyURI?.[0] ?? job.PositionURI ?? job.sourceUrl,
      description,
      requirements: splitRequirementText(description),
      preferredQualifications: [],
      benefits: details?.Benefits ? [htmlToText(details.Benefits)] : [],
      detectedTechStack: detectTechStack(description),
      sourceType: "USAJOBS"
    };
  }

  async validateAllowedSource(url?: string) {
    if (!url) {
      return true;
    }

    const host = new URL(url).hostname;
    return host.includes("usajobs.gov");
  }
}
