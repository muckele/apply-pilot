import { Upload } from "lucide-react";

import { PageHeader, Panel, PanelHeader, StatusBadge } from "@/components/ui";
import { demoJobs } from "@/lib/demo-data";

export default function ResumesPage() {
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
            <div className="grid gap-4 p-5 md:grid-cols-3">
              {["Software", "Customer-facing", "Operations"].map((label) => (
                <div key={label} className="rounded-lg border border-slate-200 p-4">
                  <p className="text-sm font-semibold text-slate-950">{label}</p>
                  <p className="mt-2 text-sm leading-6 text-slate-600">
                    Skills and achievements are parsed into structured fields for matching and honest tailoring.
                  </p>
                </div>
              ))}
            </div>
          </Panel>

          <Panel>
            <PanelHeader title="Resume versions by job" />
            <div className="divide-y divide-slate-100">
              {demoJobs.map((job) => (
                <div key={job.id} className="flex flex-col gap-2 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p className="text-sm font-semibold text-slate-950">{job.company}</p>
                    <p className="text-xs text-slate-500">{job.title}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <StatusBadge status="ATS compatible" />
                    <StatusBadge status={`${job.fitScore}% fit`} />
                  </div>
                </div>
              ))}
            </div>
          </Panel>
        </section>
      </div>
    </>
  );
}
