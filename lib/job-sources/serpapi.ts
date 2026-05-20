import type { JobSourceProvider, JobSearchCriteria, NormalizedJob, RawJob } from "@/lib/job-sources/types";
import { isRemoteLikeText } from "@/lib/job-sources/remote";
import {
  assertNotProhibitedHost,
  detectTechStack,
  htmlToText,
  parseSalaryRange,
  splitRequirementText
} from "@/lib/job-sources/utils";

type SerpApiApplyOption = {
  title?: string;
  link?: string;
};

type SerpApiJob = {
  title?: string;
  company_name?: string;
  location?: string;
  via?: string;
  share_link?: string;
  description?: string;
  extensions?: string[];
  detected_extensions?: {
    posted_at?: string;
    schedule_type?: string;
    work_from_home?: boolean;
    salary?: string;
  };
  apply_options?: SerpApiApplyOption[];
  job_id?: string;
};

function dateFromPostedAt(postedAt?: string) {
  if (!postedAt) {
    return undefined;
  }

  const lower = postedAt.toLowerCase();
  const match = lower.match(/(\d+)\s+(minute|hour|day|week|month)s?\s+ago/);
  if (!match) {
    return undefined;
  }

  const amount = Number(match[1]);
  const unit = match[2];
  const date = new Date();
  const days =
    unit === "minute" || unit === "hour"
      ? 0
      : unit === "day"
        ? amount
        : unit === "week"
          ? amount * 7
          : amount * 30;

  date.setDate(date.getDate() - days);
  return date;
}

function isRemoteJob(job: SerpApiJob) {
  if (job.detected_extensions?.work_from_home === true) {
    return true;
  }

  return (
    isRemoteLikeText(htmlToText(job.location ?? "")) ||
    isRemoteLikeText(htmlToText(job.description ?? "")) ||
    isRemoteLikeText((job.extensions ?? []).join(" "))
  );
}

function isRestrictedApplyOption(option: SerpApiApplyOption) {
  if (!option.link) {
    return true;
  }

  try {
    assertNotProhibitedHost(option.link);
    return false;
  } catch {
    return true;
  }
}

function pickApplyUrl(job: SerpApiJob) {
  const directApplyOption = job.apply_options?.find((option) => !isRestrictedApplyOption(option));

  return directApplyOption?.link ?? job.share_link;
}

export class SerpApiProvider implements JobSourceProvider {
  sourceType = "SERPAPI" as const;

  async searchJobs(criteria: JobSearchCriteria) {
    const apiKey = process.env.SERPAPI_API_KEY;

    if (!apiKey) {
      throw new Error("SerpApi sync requires SERPAPI_API_KEY.");
    }

    const params = new URLSearchParams({
      engine: "google_jobs",
      api_key: apiKey,
      q: criteria.query ?? "jobs",
      gl: "us",
      hl: "en"
    });

    if (criteria.location) {
      params.set("location", criteria.location);
    }

    const response = await fetch(`https://serpapi.com/search?${params.toString()}`, {
      headers: { Accept: "application/json" },
      next: { revalidate: 900 }
    });

    if (!response.ok) {
      throw new Error(`SerpApi returned ${response.status}.`);
    }

    const payload = (await response.json()) as { jobs_results?: SerpApiJob[]; error?: string };
    if (payload.error) {
      if (/hasn't returned any results/i.test(payload.error)) {
        return [];
      }

      throw new Error(payload.error);
    }

    const jobs = payload.jobs_results ?? [];
    const filteredJobs = criteria.remote ? jobs.filter(isRemoteJob) : jobs;

    return filteredJobs.slice(0, criteria.limit ?? 10) as RawJob[];
  }

  async getJobDetails(url: string) {
    assertNotProhibitedHost(url);
    const host = new URL(url).hostname.toLowerCase();

    if (!host.includes("google.com") && !host.includes("serpapi.com")) {
      throw new Error(
        "SerpApi detail fetching is disabled for third-party apply links. Use the SerpApi search result payload or manual import."
      );
    }

    const response = await fetch(url, { next: { revalidate: 900 } });
    if (!response.ok) {
      throw new Error(`Unable to fetch SerpApi job link: ${response.status}.`);
    }

    return { sourceUrl: url, html: await response.text() };
  }

  normalizeJob(rawJob: RawJob): NormalizedJob {
    const job = rawJob as SerpApiJob;
    const description = htmlToText(job.description ?? "");
    const applyUrl = pickApplyUrl(job);
    const salary = parseSalaryRange(
      job.detected_extensions?.salary ?? job.extensions?.find((extension) => extension.includes("$"))
    );

    return {
      title: job.title ?? "Google Jobs posting",
      company: job.company_name ?? "Company not listed",
      location: job.location,
      remoteStatus: job.detected_extensions?.work_from_home ? "Remote" : undefined,
      salaryMin: salary.salaryMin,
      salaryMax: salary.salaryMax,
      datePosted: dateFromPostedAt(job.detected_extensions?.posted_at),
      sourceUrl: job.share_link ?? applyUrl ?? "",
      applyUrl,
      description,
      requirements: splitRequirementText(description),
      preferredQualifications: [],
      benefits: [],
      detectedTechStack: detectTechStack(description),
      seniorityLevel: job.detected_extensions?.schedule_type,
      sourceType: "SERPAPI"
    };
  }

  async validateAllowedSource(url?: string) {
    if (!url) {
      return true;
    }

    assertNotProhibitedHost(url);
    return Boolean(new URL(url).hostname);
  }
}
