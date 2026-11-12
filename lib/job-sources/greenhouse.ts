import { boardReferenceFromCriteria, fetchBoardListing } from "@/lib/job-sources/board-fetch";
import { workStyleFromLocation } from "@/lib/job-sources/location-match";
import type { JobSourceProvider, JobSearchCriteria, NormalizedJob, RawJob } from "@/lib/job-sources/types";
import { boardRequirementLines, extractRequirementLinesFromHtml } from "@/lib/job-sources/requirement-lines";
import { decodeHtmlEntities, detectTechStack, htmlToText } from "@/lib/job-sources/utils";

type GreenhouseJob = {
  id: number;
  title: string;
  absolute_url: string;
  content?: string;
  location?: { name?: string };
  updated_at?: string;
  first_published?: string;
  offices?: Array<{ name: string }>;
};

export class GreenhouseProvider implements JobSourceProvider {
  sourceType = "GREENHOUSE" as const;

  // Public Job Board API: GET boards-api.greenhouse.io/v1/boards/{token}/jobs. No key; poll politely.
  async searchJobs(criteria: JobSearchCriteria) {
    if (!criteria.boardToken) {
      throw new Error("Greenhouse sync requires a board token.");
    }

    const jobs = await fetchBoardListing(boardReferenceFromCriteria("GREENHOUSE", criteria));
    return jobs.slice(0, criteria.limit ?? 50) as RawJob[];
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
    // With content=true the board API returns HTML-escaped HTML, so decode before stripping tags.
    const html = job.content ? decodeHtmlEntities(job.content) : job.html ?? "";
    const description = htmlToText(html);
    const postedAt = job.first_published ?? job.updated_at;
    const location = job.location?.name ?? job.offices?.map((office) => office.name).join(", ");

    return {
      title: job.title,
      company: "",
      location,
      // The board API has no work-style field; "Remote, Canada; Remote, United States" says it.
      remoteStatus: workStyleFromLocation(location),
      datePosted: postedAt ? new Date(postedAt) : undefined,
      sourceUrl: job.absolute_url ?? job.sourceUrl ?? "",
      applyUrl: job.absolute_url ?? job.sourceUrl,
      description,
      // htmlToText flattens every line break, so requirements are read from the HTML's sections and
      // bullets. A real list item can be a long must-have, so bullets may run to 400 characters.
      requirements: boardRequirementLines(extractRequirementLinesFromHtml(html, 400), description),
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
