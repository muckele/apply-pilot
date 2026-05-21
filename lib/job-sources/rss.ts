import type { JobSourceProvider, JobSearchCriteria, NormalizedJob, RawJob } from "@/lib/job-sources/types";
import { assertNotProhibitedHost, detectTechStack, htmlToText, splitRequirementText } from "@/lib/job-sources/utils";
import { assertSafePublicHttpUrl, fetchTextFromSafeUrl } from "@/lib/security/safe-url";

type RssJob = {
  title: string;
  link: string;
  description: string;
  pubDate?: string;
  sourceTitle?: string;
};

function extractTag(xml: string, tag: string) {
  const match = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  if (!match) {
    return "";
  }

  return match[1]
    .replace(/^<!\[CDATA\[/, "")
    .replace(/\]\]>$/, "")
    .trim();
}

export class RssProvider implements JobSourceProvider {
  sourceType = "RSS" as const;

  async searchJobs(criteria: JobSearchCriteria) {
    if (!criteria.url) {
      throw new Error("RSS sync requires a feed URL.");
    }

    const allowed = await this.validateAllowedSource(criteria.url);
    if (!allowed) {
      throw new Error("This RSS feed host is not allowed.");
    }

    const { response, text } = await fetchTextFromSafeUrl(criteria.url, { next: { revalidate: 900 } });
    if (!response.ok) {
      throw new Error(`RSS feed returned ${response.status}.`);
    }

    const xml = text;
    const sourceTitle = htmlToText(extractTag(xml, "title"));
    const items = [...xml.matchAll(/<item\b[\s\S]*?<\/item>/gi)]
      .map((match) => match[0])
      .map((item) => ({
        title: htmlToText(extractTag(item, "title")),
        link: htmlToText(extractTag(item, "link")),
        description: extractTag(item, "description"),
        pubDate: htmlToText(extractTag(item, "pubDate")),
        sourceTitle
      }))
      .filter((item) => item.title && item.link);

    return items.slice(0, criteria.limit ?? 50) as RawJob[];
  }

  async getJobDetails(url: string) {
    const { response, text } = await fetchTextFromSafeUrl(url, { next: { revalidate: 900 } });
    if (!response.ok) {
      throw new Error(`Unable to fetch RSS posting: ${response.status}.`);
    }

    return { sourceUrl: url, html: text };
  }

  normalizeJob(rawJob: RawJob): NormalizedJob {
    const job = rawJob as RssJob;
    const description = htmlToText(job.description);
    const host = new URL(job.link).hostname.replace(/^www\./, "");

    return {
      title: job.title,
      company: job.sourceTitle || host,
      sourceUrl: job.link,
      applyUrl: job.link,
      datePosted: job.pubDate ? new Date(job.pubDate) : undefined,
      description,
      requirements: splitRequirementText(description),
      preferredQualifications: [],
      benefits: [],
      detectedTechStack: detectTechStack(description),
      sourceType: "RSS"
    };
  }

  async validateAllowedSource(url?: string) {
    if (!url) {
      return false;
    }

    assertNotProhibitedHost(url);
    await assertSafePublicHttpUrl(url);
    return true;
  }
}
