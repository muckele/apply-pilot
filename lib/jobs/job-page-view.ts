import type { EstimateView, JobDetailView } from "@/lib/jobs/job-view-types";
import type { FitEstimateBasis } from "@/lib/jobs/fit-estimate";
import { compensationExplanation, validFitScore } from "@/lib/jobs/fit-presentation";
import { extractWorkStyleQuotes, normalizeWorkStyle, postedAgeLabel, salaryLabel } from "@/lib/jobs/listing-labels";

const SOURCE_LABELS: Record<string, string> = {
  GREENHOUSE: "Greenhouse",
  LEVER: "Lever",
  ASHBY: "Ashby",
  WORKABLE: "Workable",
  USAJOBS: "USAJOBS",
  REMOTIVE: "Remotive",
  ADZUNA: "Adzuna",
  THEIRSTACK: "TheirStack",
  SERPAPI: "SerpApi",
  RSS: "RSS feed",
  COMPANY_CAREERS: "Company careers page",
  MANUAL: "Added by you"
};

export function sourceLabel(sourceType: string) {
  return SOURCE_LABELS[sourceType] ?? sourceType.replaceAll("_", " ").toLowerCase();
}

type DetailJob = {
  id: string;
  title: string;
  company: string;
  location: string | null;
  remoteStatus: string | null;
  salaryMin: number | null;
  salaryMax: number | null;
  datePosted: Date | null;
  firstDiscoveredAt: Date;
  sourceType: string;
  description: string;
  requirements: string[];
  preferredQualifications: string[];
};

export function buildJobDetailView(job: DetailJob, now: Date = new Date()): JobDetailView {
  return {
    id: job.id,
    title: job.title,
    company: job.company,
    location: job.location?.trim() || null,
    workStyle: normalizeWorkStyle(job.remoteStatus, job.location),
    salary: salaryLabel(job.salaryMin, job.salaryMax),
    postedAge: postedAgeLabel(job.datePosted ?? job.firstDiscoveredAt, now),
    source: sourceLabel(job.sourceType),
    description: job.description,
    requirements: job.requirements,
    preferredQualifications: job.preferredQualifications,
    workStyleQuotes: extractWorkStyleQuotes(job.description),
    listedWorkStyle: job.remoteStatus?.trim() || null
  };
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function buildEstimateView(estimate: {
  score: number;
  basis: FitEstimateBasis;
  analysis: { createdAt: Date; output: unknown };
}): EstimateView {
  const output = record(estimate.analysis.output);
  const compensation = record(output.compensationAssessment);
  return {
    score: estimate.score,
    basis: estimate.basis,
    scoredAt: estimate.analysis.createdAt.toISOString(),
    compensation: Object.keys(compensation).length
      ? { score: validFitScore(compensation.score), explanation: compensationExplanation(compensation.reason) }
      : null,
    resumeAngle: text(output.suggestedResumeAngle),
    coverLetterAngle: text(output.suggestedCoverLetterAngle)
  };
}
