import { notFound } from "next/navigation";

import { JobContactNotesForm } from "@/components/job-contact-notes-form";
import { type JobCoverLetterOption, type JobResumeVersionOption } from "@/components/job-document-workspace";
import { JobWorkspace } from "@/components/job-workspace/job-workspace";
import { readTailoredResumeLeftOut, readTailoredResumeReversions } from "@/lib/ai/tailored-resume-keep-rule";
import { loadApplyReturnState } from "@/lib/applications/apply-return-service";
import { formatApplicationStatus } from "@/lib/applications/pipeline";
import { isDocumentGenerationAvailable } from "@/lib/apply-kit/generation-availability";
import { buildDocumentReviewView } from "@/lib/documents/document-review";
import type { ResumeFormat } from "@/lib/documents/resume-format";
import { buildEvidenceCorrectionReview } from "@/lib/jobs/evidence-correction-review";
import {
  acceptedEvidenceFactsFromSnapshot,
  CURRENT_EVIDENCE_SNAPSHOT_SELECT
} from "@/lib/jobs/evidence-snapshot-contracts";
import {
  CURRENT_JOB_MATCH_ANALYSIS_WHERE,
  JOB_MATCH_PROFILE_SELECT,
  buildCurrentJobMatchContext,
  currentJobMatchInputHash,
  hasCurrentJobMatchAnalysis
} from "@/lib/jobs/current-job-match";
import { buildDocumentCreationQuote } from "@/lib/jobs/document-creation-quote";
import { resolveFitEstimate } from "@/lib/jobs/fit-estimate";
import { buildEstimateView, buildJobDetailView } from "@/lib/jobs/job-page-view";
import { buildRequirementChecklist } from "@/lib/jobs/requirement-checklist";
import { requirePageUserId } from "@/lib/page-context";
import { prisma } from "@/lib/prisma";

type Props = {
  params: Promise<{ id: string }>;
};

async function getJobDetail(id: string) {
  const userId = await requirePageUserId();

  const [job, masterResume, profile, resumeVersions, coverLetters, application, contacts, matchAnalysis] = await Promise.all([
    prisma.jobPosting.findFirst({
      where: { id, userId },
      include: {
        currentEvidenceSnapshot: {
          select: { ...CURRENT_EVIDENCE_SNAPSHOT_SELECT, reviewedAnalysisId: true }
        }
      }
    }),
    prisma.resume.findFirst({
      where: { userId, isMaster: true },
      orderBy: { updatedAt: "desc" },
      select: {
        id: true,
        updatedAt: true,
        rawText: true,
        summary: true,
        skills: true,
        achievements: true,
        workHistory: true,
        projects: true,
        education: true,
        certifications: true
      }
    }),
    prisma.userProfile.findUnique({ where: { userId }, select: JOB_MATCH_PROFILE_SELECT }),
    prisma.resumeVersion.findMany({
      where: { userId, jobPostingId: id },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        title: true,
        summary: true,
        fullText: true,
        template: true, pageSize: true, fontFamily: true, accentColor: true, fontSize: true, lineSpacing: true,
        atsCompatibility: true,
        jobFitScore: true,
        evidenceSnapshotId: true,
        metadata: true,
        createdAt: true
      }
    }),
    prisma.generatedDocument.findMany({
      where: { userId, jobPostingId: id, type: "COVER_LETTER" },
      orderBy: { createdAt: "desc" },
      select: { id: true, title: true, content: true, evidenceSnapshotId: true, metadata: true, createdAt: true }
    }),
    prisma.application.findUnique({
      where: { userId_jobPostingId: { userId, jobPostingId: id } },
      select: { id: true, status: true, resumeVersionId: true, coverLetterVersionId: true }
    }),
    prisma.contact.findMany({
      where: { userId, jobPostingId: id },
      orderBy: { createdAt: "desc" },
      take: 10,
      select: { id: true, name: true, email: true, role: true, profileUrl: true, notes: true }
    }),
    prisma.aIAnalysis.findFirst({
      where: { userId, jobPostingId: id, ...CURRENT_JOB_MATCH_ANALYSIS_WHERE },
      orderBy: { createdAt: "desc" },
      select: { id: true, inputHash: true, model: true, promptVersion: true, evidenceSnapshotId: true, output: true, createdAt: true }
    })
  ]);

  if (!job) return null;
  const applyReturn = await loadApplyReturnState(prisma, { userId, application });

  const context = buildCurrentJobMatchContext({ job, resume: masterResume, profile });
  const matchInput = context.matchInput;
  // Unchanged review rules: a gap review may be saved only against the current analysis, or
  // against the unreviewed baseline analysis when no reviewed evidence is in force.
  const currentAnalysis = hasCurrentJobMatchAnalysis({
    currentEvidenceSnapshotId: job.currentEvidenceSnapshotId,
    currentEvidenceSourceValid: context.currentEvidenceSourceValid,
    aiAnalyses: matchAnalysis ? [matchAnalysis] : []
  }, matchInput)
    ? matchAnalysis
    : null;
  const baselineReviewAnalysis = matchAnalysis?.evidenceSnapshotId === context.effectiveEvidenceSnapshotId &&
    matchAnalysis.inputHash === currentJobMatchInputHash(matchInput)
    ? matchAnalysis
    : null;
  const reviewAnalysis = currentAnalysis ?? baselineReviewAnalysis;
  // Display only (lib/jobs/fit-estimate.ts): which saved analysis the page may show, and why.
  const estimate = resolveFitEstimate({
    job,
    resume: masterResume,
    profile,
    latestAnalysis: matchAnalysis,
    currentSnapshotReviewedAnalysisId: job.currentEvidenceSnapshot?.reviewedAnalysisId ?? null
  });
  const checklist = buildRequirementChecklist(job.requirements, estimate?.analysis.output ?? null, { description: job.description });

  return {
    view: buildJobDetailView(job),
    estimate: estimate ? buildEstimateView(estimate) : null,
    checklist: { items: checklist.items, counts: checklist.counts },
    readOnlyGaps: estimate && !reviewAnalysis
      ? checklist.items.filter((item) => item.status === "not_shown").map((item) => item.requirement)
      : [],
    hasValidCurrentSnapshot: context.effectiveEvidenceSnapshotId !== null,
    sourceText: masterResume?.rawText ?? "",
    // D031: "evidenceCurrent" is export/packet readiness — exactly generated from current evidence,
    // or edited/legacy with the owner's review covering the saved bytes.
    resumeVersions: resumeVersions.map(({ metadata, ...version }): JobResumeVersionOption => {
      const review = buildDocumentReviewView({
        kind: "RESUME",
        jobBound: true,
        currentEvidenceSnapshotId: job.currentEvidenceSnapshotId,
        currentEvidenceSourceValid: context.currentEvidenceSourceValid,
        artifact: { evidenceSnapshotId: version.evidenceSnapshotId, content: version.fullText, metadata }
      });
      return {
        ...version,
        resumeFormat: { template: version.template as ResumeFormat["template"], pageSize: version.pageSize as ResumeFormat["pageSize"], fontFamily: version.fontFamily as ResumeFormat["fontFamily"], accentColor: version.accentColor, fontSize: version.fontSize, lineSpacing: version.lineSpacing },
        evidenceCurrent: review.exportReady,
        review,
        leftOut: readTailoredResumeLeftOut(metadata),
        reverted: readTailoredResumeReversions(metadata),
        createdAt: version.createdAt.toISOString()
      };
    }),
    coverLetters: coverLetters.map(({ metadata, ...document }): JobCoverLetterOption => {
      const review = buildDocumentReviewView({
        kind: "COVER_LETTER",
        jobBound: true,
        currentEvidenceSnapshotId: job.currentEvidenceSnapshotId,
        currentEvidenceSourceValid: context.currentEvidenceSourceValid,
        artifact: { evidenceSnapshotId: document.evidenceSnapshotId, content: document.content, metadata }
      });
      return {
        ...document,
        evidenceCurrent: review.exportReady,
        review,
        createdAt: document.createdAt.toISOString()
      };
    }),
    application: application ? { id: application.id, statusLabel: formatApplicationStatus(application.status) } : null,
    applyReturn,
    contacts,
    salaryTarget: profile ? { min: profile.salaryTargetMin, max: profile.salaryTargetMax } : null,
    evidenceReview: masterResume
      ? buildEvidenceCorrectionReview({
          jobId: job.id,
          resumeId: masterResume.id,
          resumeUpdatedAt: masterResume.updatedAt.toISOString(),
          resume: masterResume,
          analysisId: reviewAnalysis?.id ?? null,
          analysisInputHash: reviewAnalysis?.inputHash ?? null,
          analysisModel: reviewAnalysis?.model ?? null,
          analysisPromptVersion: reviewAnalysis?.promptVersion ?? null,
          analysisOutput: reviewAnalysis?.output,
          selectedResumeDocumentId: application?.resumeVersionId,
          selectedCoverLetterDocumentId: application?.coverLetterVersionId,
          acceptedFacts: context.effectiveEvidenceSnapshotId && job.currentEvidenceSnapshot
            ? acceptedEvidenceFactsFromSnapshot(job.currentEvidenceSnapshot)
            : [],
          // The same job fields the save rebuilds this review from (lib/jobs/evidence-snapshots.ts).
          job: { requirements: job.requirements, description: job.description }
        })
      : null
  };
}

export default async function JobDetailPage({ params }: Props) {
  const { id } = await params;
  const data = await getJobDetail(id);

  if (!data) {
    notFound();
  }

  return (
    <JobWorkspace
      job={data.view}
      estimate={data.estimate}
      checklist={data.checklist}
      salaryTarget={data.salaryTarget}
      tailor={{
        review: data.evidenceReview,
        hasValidCurrentSnapshot: data.hasValidCurrentSnapshot,
        readOnlyGaps: data.readOnlyGaps,
        quote: buildDocumentCreationQuote(),
        generationAvailable: isDocumentGenerationAvailable()
      }}
      documents={{ resumeVersions: data.resumeVersions, coverLetters: data.coverLetters }}
      application={data.application}
      applyReturn={data.applyReturn}
      masterResumeText={data.sourceText}
      notes={<JobContactNotesForm key="contact-notes" jobPostingId={data.view.id} applicationId={data.application?.id} contacts={data.contacts} />}
    />
  );
}
