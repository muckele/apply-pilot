import type { FitEstimateBasis } from "@/lib/jobs/fit-estimate";
import type { WorkStyle } from "@/lib/jobs/listing-labels";
import type { ChecklistCounts, ChecklistItem } from "@/lib/jobs/requirement-checklist";

// Serializable view models shared by the job page and the feed's preview pane.

export type JobHeaderView = {
  id: string;
  title: string;
  company: string;
  location: string | null;
  workStyle: WorkStyle | null;
  salary: string | null;
  postedAge: string;
  source: string;
};

export type JobDetailView = JobHeaderView & {
  description: string;
  requirements: string[];
  preferredQualifications: string[];
  workStyleQuotes: string[];
  listedWorkStyle: string | null;
};

export type EstimateView = {
  score: number;
  basis: FitEstimateBasis;
  scoredAt: string;
  compensation: { score: number | null; explanation: string } | null;
  resumeAngle: string | null;
  coverLetterAngle: string | null;
};

export type ChecklistView = { items: ChecklistItem[]; counts: ChecklistCounts };

export type SalaryTargetView = { min: number | null; max: number | null } | null;

export type JobTab = "overview" | "match" | "salary";
