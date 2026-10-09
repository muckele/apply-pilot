import { notFound } from "next/navigation";

import { ApplyPacketBuilder } from "@/components/apply-packet-builder";
import { EvidenceCorrectionReview } from "@/components/evidence-correction-review";
import { JobDocumentWorkspace } from "@/components/job-document-workspace";
import { JobMatchOmissionNotice } from "@/components/job-match-omission-notice";
import { Panel, PanelHeader } from "@/components/ui";
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

const generatedResume = {
  id: "synthetic-resume-version-1",
  title: "Synthetic Employer - Service Operations Director tailored resume",
  fullText: [
    "EDUCATION",
    "Bachelor of Arts in Business Administration",
    "ACHIEVEMENTS",
    "Synthetic owner confirms leading cross-functional service portfolio reviews."
  ].join("\n"),
  summary: "Bachelor of Arts in Business Administration",
  atsCompatibility: null,
  jobFitScore: null,
  evidenceCurrent: false,
  createdAt: "2026-10-08T15:35:00.000Z"
};

const generatedCoverLetter = {
  id: "synthetic-cover-letter-1",
  title: "Synthetic Employer Service Operations Director cover letter",
  content: [
    "Dear Synthetic Employer Hiring Team,",
    "",
    "Bachelor of Arts in Business Administration",
    "Synthetic owner confirms leading cross-functional service portfolio reviews.",
    "",
    "Sincerely,",
    "Synthetic Candidate"
  ].join("\n"),
  evidenceCurrent: false,
  createdAt: "2026-10-08T15:35:00.000Z"
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
    selectedCoverLetterDocumentId: "synthetic-cover-letter-1",
    acceptedFacts: [{
      factId: "fact:synthetic-current-owner-fact",
      originGapId: "gap:prior",
      fact: "Synthetic owner has current job-specific business operations experience.",
      provenance: { kind: "OWNER_ATTESTED", ownerAttested: true },
      reuseScope: "JOB_ONLY",
      masterProfileOptIn: false
    }]
  });
  const showGeneratedDocuments = process.env.APPLY_PILOT_SYNTHETIC_GENERATED_DOCUMENTS_PREVIEW === "true";

  return (
    <main className="mx-auto min-h-screen max-w-5xl p-3 sm:p-6" data-synthetic-evidence-correction>
      <div className="mb-3">
        <JobMatchOmissionNotice evaluatedCandidateCount={500} omittedCandidateCount={12} viewLabel="correction view" />
      </div>
      <div className={showGeneratedDocuments ? "grid gap-6 xl:grid-cols-[minmax(0,1.3fr)_380px]" : ""}>
        <section className="min-w-0 space-y-6">
          <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-soft">
            <EvidenceCorrectionReview review={review} />
          </div>
          {showGeneratedDocuments ? (
            <>
              <Panel>
                <PanelHeader title="Apply packet builder" description="Synthetic generated-document containment fixture." />
                <ApplyPacketBuilder
                  job={{
                    id: "synthetic-job-1",
                    title: "Service Operations Director",
                    company: "Synthetic Employer",
                    applyUrl: "https://example.test/synthetic-apply",
                    fitScore: 90,
                    recommendation: "apply now",
                    keyReason: "Use only reviewed synthetic evidence.",
                    hasFitAnalysis: true
                  }}
                  resumeVersions={[generatedResume]}
                  coverLetters={[generatedCoverLetter]}
                  application={null}
                />
              </Panel>
              <Panel>
                <PanelHeader title="Generated documents" description="Synthetic stale-document preview and controls." />
                <div data-synthetic-generated-documents>
                  <JobDocumentWorkspace
                    resumeVersions={[generatedResume]}
                    coverLetters={[generatedCoverLetter]}
                  />
                </div>
              </Panel>
            </>
          ) : null}
        </section>
        {showGeneratedDocuments ? (
          <aside className="min-w-0 space-y-6">
            <Panel>
              <PanelHeader title="Synthetic sidebar" />
              <p className="p-5 text-sm leading-6 text-slate-700">Preserved alongside generated documents.</p>
            </Panel>
          </aside>
        ) : null}
      </div>
    </main>
  );
}
