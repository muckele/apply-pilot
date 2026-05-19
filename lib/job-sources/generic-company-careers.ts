import type { JobSourceProvider, JobSearchCriteria, NormalizedJob, RawJob } from "@/lib/job-sources/types";
import {
  assertNotProhibitedHost,
  detectTechStack,
  htmlToText,
  splitRequirementText
} from "@/lib/job-sources/utils";

export class GenericCompanyCareersProvider implements JobSourceProvider {
  sourceType = "COMPANY_CAREERS" as const;

  async searchJobs(criteria: JobSearchCriteria) {
    if (!criteria.url) {
      throw new Error("Generic company careers sync requires an explicit URL.");
    }

    const allowed = await this.validateAllowedSource(criteria.url);
    if (!allowed) {
      throw new Error("robots.txt does not allow this careers page path.");
    }

    return [await this.getJobDetails(criteria.url)];
  }

  async getJobDetails(url: string) {
    const allowed = await this.validateAllowedSource(url);
    if (!allowed) {
      throw new Error("robots.txt does not allow this careers page path.");
    }

    const response = await fetch(url, { next: { revalidate: 900 } });
    if (!response.ok) {
      throw new Error(`Unable to fetch careers page: ${response.status}.`);
    }

    return { sourceUrl: url, html: await response.text() };
  }

  normalizeJob(rawJob: RawJob): NormalizedJob {
    const sourceUrl = String(rawJob.sourceUrl ?? "");
    const text = htmlToText(String(rawJob.html ?? rawJob.description ?? ""));
    const host = sourceUrl ? new URL(sourceUrl).hostname.replace(/^www\./, "") : "Company";

    return {
      title: String(rawJob.title ?? "Imported company careers posting"),
      company: String(rawJob.company ?? host),
      location: String(rawJob.location ?? ""),
      sourceUrl,
      applyUrl: String(rawJob.applyUrl ?? sourceUrl),
      description: text,
      requirements: splitRequirementText(text),
      preferredQualifications: [],
      benefits: [],
      detectedTechStack: detectTechStack(text),
      sourceType: "COMPANY_CAREERS"
    };
  }

  async validateAllowedSource(url?: string) {
    if (!url) {
      return false;
    }

    assertNotProhibitedHost(url);
    const parsed = new URL(url);
    const robotsUrl = `${parsed.origin}/robots.txt`;

    try {
      const response = await fetch(robotsUrl, { next: { revalidate: 3600 } });
      if (!response.ok) {
        return true;
      }

      const robots = await response.text();
      const path = parsed.pathname || "/";
      const userAgentBlocks = robots.split(/user-agent:/i).slice(1);
      const wildcardBlock = userAgentBlocks.find((block) => block.trim().startsWith("*"));

      if (!wildcardBlock) {
        return true;
      }

      return !wildcardBlock
        .split(/\n/)
        .map((line) => line.trim())
        .filter((line) => /^disallow:/i.test(line))
        .some((line) => {
          const rule = line.replace(/^disallow:/i, "").trim();
          return rule && path.startsWith(rule);
        });
    } catch {
      return false;
    }
  }
}
