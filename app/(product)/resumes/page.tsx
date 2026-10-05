import Link from "next/link";

import { MasterResumeDetail } from "@/components/master-resume-detail";
import { ResumeUploadForm } from "@/components/resume-upload-form";
import { PageHeader, Panel, PanelHeader, StatusBadge } from "@/components/ui";
import { requirePageUserId } from "@/lib/page-context";
import { prisma } from "@/lib/prisma";
import { getMasterResumeDetail } from "@/lib/resumes/master-resume-detail";

export default async function ResumesPage() {
  const userId = await requirePageUserId();
  const [masterResume, versions] = await Promise.all([
    getMasterResumeDetail(userId),
    prisma.resumeVersion.findMany({
      where: { userId },
      include: { jobPosting: true },
      orderBy: { createdAt: "desc" },
      take: 25
    })
  ]);

  return (
    <>
      <PageHeader
        title="Resumes"
        description="Upload a master resume, parse structured data, tailor honest versions for each job, and export DOCX/PDF."
      />

      <div className="grid gap-6 xl:grid-cols-[420px_minmax(0,1fr)]">
        <Panel className="h-fit">
          <PanelHeader title="Upload or paste resume" />
          <ResumeUploadForm />
        </Panel>

        <section className="space-y-6">
          <MasterResumeDetail resume={masterResume} />

          <Panel>
            <PanelHeader title="Resume versions by job" />
            <div className="divide-y divide-slate-100">
              {versions.length ? (
                versions.map((version) => (
                  <div key={version.id} className="flex flex-col gap-2 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <p className="text-sm font-semibold text-slate-950">{version.title}</p>
                      <p className="text-xs text-slate-500">
                        {version.jobPosting ? `${version.jobPosting.company} · ${version.jobPosting.title}` : "No job linked"}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      {version.atsCompatibility ? <StatusBadge status={`${version.atsCompatibility}% ATS compatible`} /> : null}
                      {version.jobFitScore ? <StatusBadge status={`${version.jobFitScore}% fit`} /> : null}
                      <Link
                        href={`/resumes/${version.id}`}
                        className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                      >
                        Edit and preview
                      </Link>
                    </div>
                  </div>
                ))
              ) : (
                <div className="px-5 py-8 text-center text-sm text-slate-600">
                  No tailored resume versions yet. Generate one from a job detail page.
                </div>
              )}
            </div>
          </Panel>
        </section>
      </div>
    </>
  );
}
