import { notFound } from "next/navigation";
import { AlertTriangle, CheckCircle2, ExternalLink } from "lucide-react";
import type { JobPosting } from "@prisma/client";

import { ApplyPacketBuilder } from "@/components/apply-packet-builder";
import { EvidenceCorrectionReview } from "@/components/evidence-correction-review";
import { JobContactNotesForm } from "@/components/job-contact-notes-form";
import { JobDocumentWorkspace, type JobCoverLetterOption, type JobResumeVersionOption } from "@/components/job-document-workspace";
import { PageHeader, Panel, PanelHeader, ScoreBadge, StatusBadge } from "@/components/ui";
import { buildEvidenceCorrectionReview } from "@/lib/jobs/evidence-correction-review";
import {
  acceptedEvidenceFactsFromSnapshot,
  CURRENT_EVIDENCE_SNAPSHOT_SELECT,
  isEvidenceBindingCurrent
} from "@/lib/jobs/evidence-snapshot-contracts";
import {
  CURRENT_JOB_MATCH_ANALYSIS_WHERE,
  JOB_MATCH_PROFILE_SELECT,
  buildCurrentJobMatchContext,
  currentJobMatchInputHash,
  hasCurrentJobMatchAnalysis
} from "@/lib/jobs/current-job-match";
import { getJobMatchAnalysisPresentation } from "@/lib/jobs/fit-presentation";
import { requirePageUserId } from "@/lib/page-context";
import { prisma } from "@/lib/prisma";

type Props = {
  params: Promise<{ id: string }>;
};

function formatSalary(job: JobPosting) {
  if (job.salaryMin && job.salaryMax) {
    return `$${Math.round(job.salaryMin / 1000)}k - $${Math.round(job.salaryMax / 1000)}k`;
  }

  return "Salary not listed";
}

function mapJobPosting(job: JobPosting, analysisOutput: unknown) {
  const fitPresentation = getJobMatchAnalysisPresentation(job, analysisOutput);
  return {
    id: job.id,
    title: job.title,
    company: job.company,
    location: job.location || "Location not listed",
    remoteStatus: job.remoteStatus || "Work style not listed",
    salary: formatSalary(job),
    datePosted: (job.datePosted ?? job.firstDiscoveredAt).toISOString().slice(0, 10),
    ...fitPresentation,
    status: job.status,
    recommendation: fitPresentation.isCurrentAnalysis ? job.matchRecommendation ?? "Review" : "Review",
    sourceType: job.sourceType,
    keyReason:
      fitPresentation.factualMatches[0]?.claim ??
      (fitPresentation.isCurrentAnalysis ? job.keyMatchReason : null) ??
      "Imported from an allowed source. Run fit scoring to generate a targeted match summary.",
    missingKeywords: fitPresentation.isCurrentAnalysis ? job.missingKeywords : [],
    supportedKeywords: fitPresentation.isCurrentAnalysis ? job.supportedKeywords : [],
    description: job.description,
    concerns: fitPresentation.isCurrentAnalysis ? job.concerns : [],
    applyUrl: job.applyUrl || job.sourceUrl,
    importedAt: job.firstDiscoveredAt.toISOString().slice(0, 10)
  };
}

async function getJobDetail(id: string) {
  const userId = await requirePageUserId();

  const [job, masterResume, profile, resumeVersions, coverLetters, application, contacts, matchAnalysis] = await Promise.all([
    prisma.jobPosting.findFirst({
      where: { id, userId },
      include: {
        currentEvidenceSnapshot: {
          select: CURRENT_EVIDENCE_SNAPSHOT_SELECT
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
        atsCompatibility: true,
        jobFitScore: true,
        evidenceSnapshotId: true,
        createdAt: true
      }
    }),
    prisma.generatedDocument.findMany({
      where: { userId, jobPostingId: id, type: "COVER_LETTER" },
      orderBy: { createdAt: "desc" },
      select: { id: true, title: true, content: true, evidenceSnapshotId: true, createdAt: true }
    }),
    prisma.application.findUnique({
      where: { userId_jobPostingId: { userId, jobPostingId: id } },
      select: {
        id: true,
        status: true,
        resumeVersionId: true,
        coverLetterVersionId: true,
        dateApplied: true
      }
    }),
    prisma.contact.findMany({
      where: { userId, jobPostingId: id },
      orderBy: { createdAt: "desc" },
      take: 10,
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        profileUrl: true,
        notes: true
      }
    }),
    prisma.aIAnalysis.findFirst({
      where: {
        userId,
        jobPostingId: id,
        ...CURRENT_JOB_MATCH_ANALYSIS_WHERE
      },
      orderBy: { createdAt: "desc" },
      select: { id: true, inputHash: true, model: true, promptVersion: true, evidenceSnapshotId: true, output: true }
    })
  ]);

  if (job) {
    const context = buildCurrentJobMatchContext({ job, resume: masterResume, profile });
    const matchInput = context.matchInput;
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
    return {
      job: mapJobPosting(job, currentAnalysis?.output),
      resumeVersions: resumeVersions.map(
        (version): JobResumeVersionOption => ({
          ...version,
          evidenceCurrent: isEvidenceBindingCurrent({
            currentEvidenceSnapshotId: job.currentEvidenceSnapshotId,
            currentEvidenceSourceValid: context.currentEvidenceSourceValid,
            artifactEvidenceSnapshotId: version.evidenceSnapshotId
          }),
          createdAt: version.createdAt.toISOString()
        })
      ),
      coverLetters: coverLetters.map(
        (document): JobCoverLetterOption => ({
          ...document,
          evidenceCurrent: isEvidenceBindingCurrent({
            currentEvidenceSnapshotId: job.currentEvidenceSnapshotId,
            currentEvidenceSourceValid: context.currentEvidenceSourceValid,
            artifactEvidenceSnapshotId: document.evidenceSnapshotId
          }),
          createdAt: document.createdAt.toISOString()
        })
      ),
      application: application
        ? {
            ...application,
            dateApplied: application.dateApplied?.toISOString() ?? null
          }
        : null,
      contacts,
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
              : []
          })
        : null
    };
  }

  return null;
}

export default async function JobDetailPage({ params }: Props) {
  const { id } = await params;
  const data = await getJobDetail(id);

  if (!data) {
    notFound();
  }

  const { job, resumeVersions, coverLetters, application, contacts, evidenceReview } = data;

  return (
    <>
      <PageHeader
        title={job.title}
        description={`${job.company} · ${job.location} · ${job.remoteStatus} · ${job.salary}`}
        action={
          <a
            href={job.applyUrl}
            target={job.applyUrl.startsWith("http") ? "_blank" : undefined}
            rel={job.applyUrl.startsWith("http") ? "noreferrer" : undefined}
            className="inline-flex items-center justify-center rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
          >
            <ExternalLink className="mr-2" size={16} aria-hidden="true" />
            Open apply link
          </a>
        }
      />

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.3fr)_380px]">
        <section className="space-y-6">
          {evidenceReview ? (
            <Panel>
              <PanelHeader
                title="Evidence correction review"
                description="Inspect extracted facts and resolve disputed gaps before any later reassessment or document rewrite."
              />
              <EvidenceCorrectionReview review={evidenceReview} />
            </Panel>
          ) : null}

          <Panel>
            <PanelHeader
              title="Apply packet builder"
              description="Review the match, generate documents, export files, and update the CRM record."
            />
            <ApplyPacketBuilder
              key={`${application?.id ?? "no-application"}-${resumeVersions[0]?.id ?? "no-resume"}-${
                coverLetters[0]?.id ?? "no-cover"
              }`}
              job={job}
              resumeVersions={resumeVersions.map(({ id, title, atsCompatibility, jobFitScore, evidenceCurrent, createdAt }) => ({
                id,
                title,
                atsCompatibility,
                jobFitScore,
                evidenceCurrent,
                createdAt
              }))}
              coverLetters={coverLetters.map(({ id, title, evidenceCurrent, createdAt }) => ({ id, title, evidenceCurrent, createdAt }))}
              application={application}
            />
          </Panel>

          <Panel>
            <PanelHeader title="Fit analysis" />
            <div className="space-y-5 p-5">
              <div className="flex flex-wrap items-center gap-2">
                <ScoreBadge score={job.fitScore} />
                <StatusBadge status={job.recommendation} />
                <StatusBadge status={job.sourceType} />
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm leading-6 text-slate-700">
                  <p className="font-semibold text-slate-950">Confidence</p>
                  {job.confidence ? (
                    <>
                      <p>{job.confidence.score}% · {job.confidence.label}</p>
                      <p className="text-xs text-slate-500">Basis: {job.confidence.basis}</p>
                    </>
                  ) : (
                    <p>Not recorded</p>
                  )}
                </div>
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm leading-6 text-slate-700">
                  <p className="font-semibold text-slate-950">Compensation fit</p>
                  <p>{job.compensation.score === null ? "Unknown" : `${job.compensation.score}%`}</p>
                  <p className="text-xs text-slate-500">{job.compensation.explanation}</p>
                </div>
              </div>
              {job.factualMatches.length ? (
                <div>
                  <h3 className="text-sm font-semibold text-slate-950">
                    {job.isLegacyAnalysis ? "Legacy match summary" : "Evidence-linked factual matches"}
                  </h3>
                  <ul className="mt-2 space-y-3 text-sm leading-6 text-slate-700">
                    {job.factualMatches.map((match) => (
                      <li
                        key={`${match.claim}-${match.applicantEvidence.map((citation) => citation.ref).join("-")}`}
                        className={job.isLegacyAnalysis
                          ? "rounded-lg border border-slate-200 bg-slate-50 p-3"
                          : "rounded-lg border border-emerald-100 bg-emerald-50 p-3"}
                      >
                        <p>{match.claim}</p>
                        {match.applicantEvidence.length || match.jobEvidence.length ? (
                          <p className="mt-1 text-xs text-emerald-800">
                            Applicant refs: {match.applicantEvidence.map((citation) => citation.ref).join(", ") || "Legacy analysis: none"}
                            {" · "}Job refs: {match.jobEvidence.map((citation) => citation.ref).join(", ") || "Legacy analysis: none"}
                          </p>
                        ) : (
                          <p className="mt-1 text-xs text-emerald-800">Legacy analysis: evidence references were not recorded.</p>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : (
                <p className="text-sm leading-6 text-slate-700">{job.keyReason}</p>
              )}
              <div className="grid gap-4 md:grid-cols-2">
                <div>
                  <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-950">
                    <CheckCircle2 size={17} className="text-emerald-600" aria-hidden="true" />
                    Supported keywords
                  </h3>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {job.supportedKeywords.length ? (
                      job.supportedKeywords.map((keyword) => (
                        <span key={keyword} className="rounded-md bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-700">
                          {keyword}
                        </span>
                      ))
                    ) : (
                      <p className="text-xs leading-5 text-slate-500">Run fit scoring to assess supported keywords.</p>
                    )}
                  </div>
                </div>
                <div>
                  <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-950">
                    <AlertTriangle size={17} className="text-amber-600" aria-hidden="true" />
                    Exact terms not found in submitted resume
                  </h3>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {job.missingKeywords.length ? (
                      job.missingKeywords.map((keyword) => (
                        <span key={keyword} className="rounded-md bg-amber-50 px-2 py-1 text-xs font-medium text-amber-700">
                          {keyword}
                        </span>
                      ))
                    ) : (
                      <p className="text-xs leading-5 text-slate-500">No current evidence-review terms recorded.</p>
                    )}
                  </div>
                </div>
              </div>
              {job.requirementGaps.length ? (
                <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
                  <p className="text-xs font-semibold uppercase text-amber-900">Requirements not evidenced in the submitted resume</p>
                  <p className="mt-1 text-xs leading-5 text-amber-800">Not evidenced is not proof that the applicant lacks the capability.</p>
                  <ul className="mt-2 space-y-1 text-sm leading-6 text-amber-900">
                    {job.requirementGaps.map((gap) => (
                      <li key={`${gap.requirement}-${gap.jobRequirement?.ref ?? "legacy"}`}>
                        {gap.requirement}
                        {gap.jobRequirement ? <span className="ml-1 text-xs">({gap.jobRequirement.ref})</span> : null}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          </Panel>

          <Panel>
            <PanelHeader title="Resume optimization suggestions" description="Writing advice, not a factual finding." />
            <div className="space-y-4 p-5 text-sm leading-6 text-slate-700">
              <p>{job.suggestedResumeAngle}</p>
              <p className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                Keep the tailored resume single-column, concise, measurable, and honest. Do not add unsupported keywords.
              </p>
            </div>
          </Panel>

          <Panel>
            <PanelHeader
              title="Generated documents"
              description="Preview, edit, and export saved resume and cover letter versions for this job."
            />
            <JobDocumentWorkspace
              key={`${resumeVersions[0]?.id ?? "no-resume"}-${coverLetters[0]?.id ?? "no-cover"}`}
              resumeVersions={resumeVersions}
              coverLetters={coverLetters}
            />
          </Panel>

          <Panel>
            <PanelHeader title="Full posting" />
            <div className="p-5 text-sm leading-7 text-slate-700">{job.description}</div>
          </Panel>

          <Panel>
            <PanelHeader title="Timeline" />
            <div className="divide-y divide-slate-100">
              {[`Job imported ${job.importedAt}`, "Relevance filter scored", "Ready for CRM review"].map((event) => (
                <div key={event} className="px-5 py-4 text-sm text-slate-700">
                  {event}
                </div>
              ))}
            </div>
          </Panel>
        </section>

        <aside className="space-y-6">
          <Panel>
            <PanelHeader title="Cover letter angle" />
            <p className="p-5 text-sm leading-6 text-slate-700">{job.suggestedCoverLetterAngle}</p>
          </Panel>

          <Panel>
            <PanelHeader title="Contacts and notes" />
            <JobContactNotesForm jobPostingId={job.id} applicationId={application?.id} contacts={contacts} />
          </Panel>
        </aside>
      </div>
    </>
  );
}
