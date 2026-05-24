import { notFound } from "next/navigation";
import { AlertTriangle, CheckCircle2, ExternalLink } from "lucide-react";
import type { JobPosting } from "@prisma/client";

import { JobActions } from "@/components/job-actions";
import { JobCrmActions } from "@/components/job-crm-actions";
import { JobDocumentWorkspace, type JobCoverLetterOption, type JobResumeVersionOption } from "@/components/job-document-workspace";
import { PageHeader, Panel, PanelHeader, ScoreBadge, StatusBadge } from "@/components/ui";
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

function mapJobPosting(job: JobPosting) {
  return {
    id: job.id,
    title: job.title,
    company: job.company,
    location: job.location || "Location not listed",
    remoteStatus: job.remoteStatus || "Work style not listed",
    salary: formatSalary(job),
    datePosted: (job.datePosted ?? job.firstDiscoveredAt).toISOString().slice(0, 10),
    fitScore: job.overallFitScore ?? 50,
    status: job.status,
    recommendation: job.matchRecommendation ?? "Review",
    sourceType: job.sourceType,
    keyReason:
      job.keyMatchReason ??
      "Imported from an allowed source. Run fit scoring to generate a targeted match summary.",
    missingKeywords: job.missingKeywords,
    supportedKeywords: job.supportedKeywords,
    description: job.description,
    concerns: job.concerns,
    suggestedResumeAngle:
      job.suggestedResumeAngle ??
      "Lead with the most relevant customer-facing, operations, and technical experience that is honestly supported by your resume.",
    suggestedCoverLetterAngle:
      job.suggestedCoverLetterAngle ??
      "Connect Mathew's software training, customer-facing sales background, and operations leadership to this role.",
    applyUrl: job.applyUrl || job.sourceUrl,
    importedAt: job.firstDiscoveredAt.toISOString().slice(0, 10)
  };
}

async function getJobDetail(id: string) {
  const userId = await requirePageUserId();

  const [job, resumeVersions, coverLetters, application] = await Promise.all([
    prisma.jobPosting.findFirst({ where: { id, userId } }),
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
        createdAt: true
      }
    }),
    prisma.generatedDocument.findMany({
      where: { userId, jobPostingId: id, type: "COVER_LETTER" },
      orderBy: { createdAt: "desc" },
      select: { id: true, title: true, content: true, createdAt: true }
    }),
    prisma.application.findUnique({
      where: { userId_jobPostingId: { userId, jobPostingId: id } },
      select: { resumeVersionId: true, coverLetterVersionId: true }
    })
  ]);

  if (job) {
    return {
      job: mapJobPosting(job),
      resumeVersions: resumeVersions.map(
        (version): JobResumeVersionOption => ({
          ...version,
          createdAt: version.createdAt.toISOString()
        })
      ),
      coverLetters: coverLetters.map(
        (document): JobCoverLetterOption => ({
          ...document,
          createdAt: document.createdAt.toISOString()
        })
      ),
      application
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

  const { job, resumeVersions, coverLetters, application } = data;

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
          <Panel>
            <PanelHeader title="Fit analysis" />
            <div className="space-y-5 p-5">
              <div className="flex flex-wrap items-center gap-2">
                <ScoreBadge score={job.fitScore} />
                <StatusBadge status={job.recommendation} />
                <StatusBadge status={job.sourceType} />
              </div>
              <p className="text-sm leading-6 text-slate-700">{job.keyReason}</p>
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
                      <p className="text-xs leading-5 text-slate-500">Run AI fit scoring for deeper keyword support.</p>
                    )}
                  </div>
                </div>
                <div>
                  <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-950">
                    <AlertTriangle size={17} className="text-amber-600" aria-hidden="true" />
                    Missing or risky keywords
                  </h3>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {job.missingKeywords.length ? (
                      job.missingKeywords.map((keyword) => (
                        <span key={keyword} className="rounded-md bg-amber-50 px-2 py-1 text-xs font-medium text-amber-700">
                          {keyword}
                        </span>
                      ))
                    ) : (
                      <p className="text-xs leading-5 text-slate-500">No major weak spots flagged yet.</p>
                    )}
                  </div>
                </div>
              </div>
              {job.concerns.length ? (
                <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
                  <p className="text-xs font-semibold uppercase text-amber-900">Honesty checks</p>
                  <ul className="mt-2 space-y-1 text-sm leading-6 text-amber-900">
                    {job.concerns.map((concern) => (
                      <li key={concern}>{concern}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          </Panel>

          <Panel>
            <PanelHeader title="Resume optimization suggestions" />
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
            <PanelHeader
              title="CRM actions"
              description="Save means not applied yet. Mark applied records the selected documents in your CRM."
            />
            <div className="p-5">
              <JobCrmActions
                key={`${application?.resumeVersionId ?? resumeVersions[0]?.id ?? "no-resume"}-${
                  application?.coverLetterVersionId ?? coverLetters[0]?.id ?? "no-cover"
                }`}
                jobId={job.id}
                resumeVersions={resumeVersions.map(({ id, title }) => ({ id, title }))}
                coverLetters={coverLetters.map(({ id, title }) => ({ id, title }))}
                defaultResumeVersionId={application?.resumeVersionId}
                defaultCoverLetterVersionId={application?.coverLetterVersionId}
              />
            </div>
          </Panel>

          <Panel>
            <PanelHeader title="AI actions" description="Drafts are saved for review. Nothing is sent or submitted automatically." />
            <div className="p-5">
              <JobActions jobId={job.id} />
            </div>
          </Panel>

          <Panel>
            <PanelHeader title="Cover letter angle" />
            <p className="p-5 text-sm leading-6 text-slate-700">{job.suggestedCoverLetterAngle}</p>
          </Panel>

          <Panel>
            <PanelHeader title="Contacts and notes" />
            <div className="space-y-3 p-5">
              <input placeholder="Recruiter or hiring manager" className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm" />
              <textarea placeholder="Notes" rows={5} className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm" />
            </div>
          </Panel>
        </aside>
      </div>
    </>
  );
}
