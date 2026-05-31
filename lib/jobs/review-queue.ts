import type { JobPosting, JobSourceType, PostingStatus } from "@prisma/client";

export type JobReviewCategory =
  | "best"
  | "needs_review"
  | "weak"
  | "duplicate"
  | "missing_details"
  | "questionable";

export type ReviewableJob = Pick<
  JobPosting,
  | "id"
  | "title"
  | "company"
  | "location"
  | "remoteStatus"
  | "salaryMin"
  | "salaryMax"
  | "datePosted"
  | "firstDiscoveredAt"
  | "status"
  | "sourceType"
  | "overallFitScore"
  | "confidenceScore"
  | "matchRecommendation"
  | "keyMatchReason"
  | "missingKeywords"
  | "supportedKeywords"
  | "concerns"
  | "applyUrl"
  | "sourceUrl"
  | "normalizedCompany"
  | "normalizedTitle"
  | "normalizedLocation"
  | "normalizedApplyUrl"
>;

export type ReviewQueueJob = {
  id: string;
  title: string;
  company: string;
  location: string;
  remoteStatus: string;
  salary: string;
  datePosted: string;
  discoveredAt: string;
  status: PostingStatus;
  sourceType: JobSourceType;
  fitScore: number | null;
  confidenceScore: number | null;
  recommendation: string;
  keyReason: string;
  applyUrl: string;
  category: JobReviewCategory;
  flags: string[];
  whyMatched: string[];
  whyReviewNeeded: string[];
  supportedKeywords: string[];
  missingKeywords: string[];
  concerns: string[];
  applicationStatus?: string;
};

type CategoryInfo = {
  label: string;
  description: string;
};

export const reviewCategoryInfo: Record<JobReviewCategory, CategoryInfo> = {
  best: {
    label: "Best matches",
    description: "High-fit jobs that are ready for apply-packet work."
  },
  needs_review: {
    label: "Needs review",
    description: "Jobs that need a human decision, fit refresh, or CRM action."
  },
  weak: {
    label: "Weak matches",
    description: "Low-fit jobs to skip, archive, or keep only if there is a strong reason."
  },
  duplicate: {
    label: "Duplicate / likely duplicate",
    description: "Similar company and title combinations that should be deduped manually."
  },
  missing_details: {
    label: "Missing salary/location/details",
    description: "Jobs missing practical details that affect the decision to apply."
  },
  questionable: {
    label: "Expired or questionable",
    description: "Expired, stale, or low-confidence postings to verify before acting."
  }
};

export const reviewCategoryOrder: JobReviewCategory[] = [
  "best",
  "needs_review",
  "weak",
  "duplicate",
  "missing_details",
  "questionable"
];

function formatSalary(job: Pick<ReviewableJob, "salaryMin" | "salaryMax">) {
  if (job.salaryMin && job.salaryMax) {
    return `$${Math.round(job.salaryMin / 1000)}k - $${Math.round(job.salaryMax / 1000)}k`;
  }

  if (job.salaryMin) {
    return `$${Math.round(job.salaryMin / 1000)}k+`;
  }

  if (job.salaryMax) {
    return `Up to $${Math.round(job.salaryMax / 1000)}k`;
  }

  return "Salary not listed";
}

function daysSince(value: Date | null) {
  if (!value) {
    return null;
  }

  return Math.floor((Date.now() - value.getTime()) / 86_400_000);
}

function hasMissingDetails(job: ReviewableJob) {
  return !job.location || !job.applyUrl || (!job.salaryMin && !job.salaryMax);
}

function hasFitAnalysis(job: ReviewableJob) {
  return Boolean(
    job.overallFitScore !== null ||
      job.confidenceScore !== null ||
      job.matchRecommendation ||
      job.keyMatchReason ||
      job.supportedKeywords.length ||
      job.missingKeywords.length
  );
}

function isLikelyDuplicate(job: ReviewableJob, jobs: ReviewableJob[]) {
  return jobs.some(
    (candidate) =>
      candidate.id !== job.id &&
      candidate.normalizedCompany === job.normalizedCompany &&
      candidate.normalizedTitle === job.normalizedTitle &&
      candidate.normalizedLocation === job.normalizedLocation &&
      candidate.normalizedApplyUrl === job.normalizedApplyUrl
  );
}

function buildFlags(job: ReviewableJob, jobs: ReviewableJob[]) {
  const flags: string[] = [];

  if (isLikelyDuplicate(job, jobs)) flags.push("Likely duplicate");
  if (!hasFitAnalysis(job)) flags.push("Needs fit score");
  if (!job.salaryMin && !job.salaryMax) flags.push("Salary missing");
  if (!job.location) flags.push("Location missing");
  if (!job.applyUrl) flags.push("Apply URL missing");
  if (job.status !== "ACTIVE") flags.push(job.status.replaceAll("_", " "));
  if ((job.confidenceScore ?? 100) < 60) flags.push("Low confidence");

  const age = daysSince(job.datePosted ?? job.firstDiscoveredAt);
  if (age !== null && age > 30) flags.push("Older than 30 days");

  return flags;
}

function categorizeJob(job: ReviewableJob, jobs: ReviewableJob[]): JobReviewCategory {
  const score = job.overallFitScore;
  const age = daysSince(job.datePosted ?? job.firstDiscoveredAt);

  if (job.status === "EXPIRED" || (age !== null && age > 45) || (job.confidenceScore ?? 100) < 45) {
    return "questionable";
  }

  if (isLikelyDuplicate(job, jobs)) {
    return "duplicate";
  }

  if (score !== null && score >= 75) {
    return "best";
  }

  if (score !== null && score < 60) {
    return "weak";
  }

  if (hasMissingDetails(job)) {
    return "missing_details";
  }

  return "needs_review";
}

function buildWhyMatched(job: ReviewableJob) {
  const reasons = [
    job.keyMatchReason,
    job.matchRecommendation ? `Recommendation: ${job.matchRecommendation}` : null,
    job.supportedKeywords.length ? `Supported keywords: ${job.supportedKeywords.slice(0, 8).join(", ")}` : null
  ].filter(Boolean);

  return reasons.length ? (reasons as string[]) : ["Run or refresh fit scoring to generate match reasoning."];
}

function buildWhyReviewNeeded(job: ReviewableJob, flags: string[]) {
  const reasons = [
    ...flags,
    job.missingKeywords.length ? `Missing keywords: ${job.missingKeywords.slice(0, 8).join(", ")}` : null,
    job.concerns.length ? `Concerns: ${job.concerns.slice(0, 3).join("; ")}` : null
  ].filter(Boolean);

  return reasons.length ? (reasons as string[]) : ["No major review flags. Confirm the posting and apply manually."];
}

export function mapJobForReviewQueue(
  job: ReviewableJob,
  jobs: ReviewableJob[],
  applicationStatus?: string
): ReviewQueueJob {
  const flags = buildFlags(job, jobs);

  return {
    id: job.id,
    title: job.title,
    company: job.company,
    location: job.location || "Location not listed",
    remoteStatus: job.remoteStatus || "Work style not listed",
    salary: formatSalary(job),
    datePosted: (job.datePosted ?? job.firstDiscoveredAt).toISOString().slice(0, 10),
    discoveredAt: job.firstDiscoveredAt.toISOString().slice(0, 10),
    status: job.status,
    sourceType: job.sourceType,
    fitScore: job.overallFitScore,
    confidenceScore: job.confidenceScore,
    recommendation: job.matchRecommendation ?? "Review",
    keyReason: job.keyMatchReason ?? "Run or refresh fit scoring before deciding whether to apply.",
    applyUrl: job.applyUrl || job.sourceUrl,
    category: categorizeJob(job, jobs),
    flags,
    whyMatched: buildWhyMatched(job),
    whyReviewNeeded: buildWhyReviewNeeded(job, flags),
    supportedKeywords: job.supportedKeywords,
    missingKeywords: job.missingKeywords,
    concerns: job.concerns,
    applicationStatus
  };
}
