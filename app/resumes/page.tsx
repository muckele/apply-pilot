import { Upload } from "lucide-react";

import { PageHeader, Panel, PanelHeader, StatusBadge } from "@/components/ui";
import { requirePageUserId } from "@/lib/page-context";
import { prisma } from "@/lib/prisma";

export default async function ResumesPage() {
  const userId = await requirePageUserId();
  const [masterResume, versions] = await Promise.all([
    prisma.resume.findFirst({ where: { userId, isMaster: true }, orderBy: { updatedAt: "desc" } }),
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
          <form className="space-y-4 p-5" action="/api/resumes/parse" method="post" encType="multipart/form-data">
            <label className="block text-sm font-medium text-slate-700">
              Resume title
              <input name="title" defaultValue="Master Resume" className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2" />
            </label>
            <label className="block text-sm font-medium text-slate-700">
              Resume file
              <input name="file" type="file" accept=".pdf,.docx,.txt" className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2" />
            </label>
            <label className="block text-sm font-medium text-slate-700">
              Or paste text
              <textarea name="pastedText" rows={8} className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2" />
            </label>
            <button className="inline-flex items-center gap-2 rounded-lg bg-brand-600 px-3 py-2 text-sm font-semibold text-white">
              <Upload size={16} aria-hidden="true" />
              Parse resume
            </button>
          </form>
        </Panel>

        <section className="space-y-6">
          <Panel>
            <PanelHeader title="Master resume profile" />
            {masterResume ? (
              <div className="space-y-4 p-5">
                <div>
                  <p className="text-sm font-semibold text-slate-950">{masterResume.title}</p>
                  <p className="mt-1 text-xs text-slate-500">
                    Parsed {masterResume.parsedAt ? masterResume.parsedAt.toISOString().slice(0, 10) : "date unavailable"}
                  </p>
                </div>
                {masterResume.summary ? <p className="text-sm leading-6 text-slate-700">{masterResume.summary}</p> : null}
                <div className="flex flex-wrap gap-2">
                  {masterResume.skills.slice(0, 16).map((skill) => (
                    <StatusBadge key={skill} status={skill} />
                  ))}
                </div>
              </div>
            ) : (
              <div className="p-5 text-sm text-slate-600">No master resume uploaded yet.</div>
            )}
          </Panel>

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
