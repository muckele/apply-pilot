import { notFound } from "next/navigation";

import { EvidenceCorrectionReview } from "@/components/evidence-correction-review";
import { JobMatchOmissionNotice } from "@/components/job-match-omission-notice";
import { buildEvidenceCorrectionReview } from "@/lib/jobs/evidence-correction-review";

export const dynamic = "force-dynamic";

const syntheticResume = {
  rawText: [
    "SYNTHETIC CANDIDATE",
    "SUMMARY",
    "Customer-facing technical operator.",
    "EDUCATION",
    "Example University | Bachelor of Arts in Business Administration",
    "CERTIFICATIONS",
    "Operations Certificate | 480 hours"
  ].join("\n"),
  summary: "Customer-facing technical operator.",
  skills: ["Languages: TypeScript, SQL", "Methods: Discovery, Workshops"],
  achievements: ["Improved a source-backed synthetic workflow."],
  workHistory: [{
    sourceText: "Example Co | Operations Lead | 2022–2026\nOwned synthetic customer workflows.",
    company: "Example Co",
    title: "Operations Lead",
    bullets: ["Owned synthetic customer workflows."]
  }],
  projects: [{
    sourceText: "Evidence Console | 2026\nBuilt an auditable synthetic review surface.",
    name: "Evidence Console",
    date: "2026",
    bullets: ["Built an auditable synthetic review surface."]
  }],
  education: [{
    sourceText: "Example University | Bachelor of Arts in Business Administration",
    institution: "Example University",
    credential: "Bachelor of Arts",
    fieldOfStudy: "Business Administration"
  }],
  certifications: [{
    sourceText: "Operations Certificate | 480 hours",
    name: "Operations Certificate",
    details: ["480 hours"]
  }]
};

const syntheticAnalysis = {
  contractVersion: "3",
  promptVersion: "3.4",
  requirementGaps: [{
    requirement: "Bachelor's degree in business or equivalent experience",
    jobRequirement: {
      ref: "job.requirements[0]",
      excerpt: "Bachelor's degree in business or equivalent experience"
    },
    missingKeywords: ["business"]
  }]
};

export default function SyntheticEvidenceCorrectionPage() {
  if (process.env.NODE_ENV === "production" || process.env.APPLY_PILOT_SYNTHETIC_EVIDENCE_PREVIEW !== "true") {
    notFound();
  }
  const review = buildEvidenceCorrectionReview({
    jobId: "synthetic-job-1",
    resumeId: "synthetic-resume-1",
    resumeUpdatedAt: "2026-10-08T12:00:00.000Z",
    resume: syntheticResume,
    analysisId: "synthetic-analysis-1",
    analysisInputHash: "a".repeat(64),
    analysisModel: "gemini-3.8-flash",
    analysisPromptVersion: "3.4",
    analysisOutput: syntheticAnalysis,
    selectedResumeDocumentId: "synthetic-resume-version-1",
    selectedCoverLetterDocumentId: "synthetic-cover-letter-1"
  });

  return (
    <main className="mx-auto min-h-screen max-w-5xl p-3 sm:p-6" data-synthetic-evidence-correction>
      <div className="mb-3">
        <JobMatchOmissionNotice evaluatedCandidateCount={500} omittedCandidateCount={12} viewLabel="correction view" />
      </div>
      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-soft">
        <EvidenceCorrectionReview review={review} />
      </div>
    </main>
  );
}
