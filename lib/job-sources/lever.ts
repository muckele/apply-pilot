import { boardReferenceFromCriteria, fetchBoardListing } from "@/lib/job-sources/board-fetch";
import { workStyleFromLocation } from "@/lib/job-sources/location-match";
import type { JobSourceProvider, JobSearchCriteria, NormalizedJob, RawJob } from "@/lib/job-sources/types";
import {
  boardRequirementLines,
  extractRequirementLines,
  extractRequirementLinesFromSections
} from "@/lib/job-sources/requirement-lines";
import { detectTechStack, htmlListItems, htmlToText, workStyleLabel } from "@/lib/job-sources/utils";
import { uniqueStrings } from "@/lib/normalize";

type LeverJob = {
  id: string;
  text: string;
  hostedUrl: string;
  applyUrl?: string;
  descriptionPlain?: string;
  description?: string;
  lists?: Array<{ text?: string; content?: string }>;
  categories?: {
    team?: string;
    location?: string;
    commitment?: string;
  };
  workplaceType?: string;
  salaryRange?: { min?: number; max?: number; currency?: string; interval?: string };
  createdAt?: number;
};

function yearlyUsdSalary(range: LeverJob["salaryRange"]) {
  if (!range || range.currency !== "USD" || range.interval !== "per-year-salary") {
    return {};
  }

  return {
    salaryMin: typeof range.min === "number" ? Math.round(range.min) : undefined,
    salaryMax: typeof range.max === "number" ? Math.round(range.max) : undefined
  };
}

export class LeverProvider implements JobSourceProvider {
  sourceType = "LEVER" as const;

  // Public Postings API: GET api.lever.co/v0/postings/{site}?mode=json (api.eu.lever.co for EU sites).
  async searchJobs(criteria: JobSearchCriteria) {
    const jobs = await fetchBoardListing(boardReferenceFromCriteria("LEVER", criteria));
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
    const opening = job.descriptionPlain?.trim() || htmlToText(job.description ?? job.html ?? "");
    const sections = (job.lists ?? []).map((list) => ({ title: list.text?.trim(), items: htmlListItems(list.content ?? "") }));
    const lists = sections.map((section) => [section.title, ...section.items].filter(Boolean).join("\n"));
    const description = [opening, ...lists].filter(Boolean).join("\n");
    // The lists are the posting's titled sections. The opening adds only lines it lists under a
    // requirement heading of its own; without any lists, the opening is all there is.
    const sectionAware = sections.length
      ? uniqueStrings([
          ...extractRequirementLines(opening, 220, { withoutHeadings: "none" }),
          ...extractRequirementLinesFromSections(sections)
        ]).slice(0, 24)
      : extractRequirementLines(opening);

    return {
      title: job.text,
      company: "",
      location: job.categories?.location,
      remoteStatus: workStyleLabel(job.workplaceType) ?? workStyleFromLocation(job.categories?.location),
      ...yearlyUsdSalary(job.salaryRange),
      datePosted: job.createdAt ? new Date(job.createdAt) : undefined,
      sourceUrl: job.hostedUrl ?? job.sourceUrl ?? "",
      applyUrl: job.applyUrl ?? job.hostedUrl ?? job.sourceUrl,
      description,
      requirements: boardRequirementLines(sectionAware, description),
      preferredQualifications: [],
      benefits: [],
      detectedTechStack: detectTechStack(description),
      seniorityLevel: job.categories?.commitment,
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
