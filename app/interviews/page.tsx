import { CalendarPlus } from "lucide-react";
import Link from "next/link";

import { PageHeader, Panel, PanelHeader, StatusBadge } from "@/components/ui";
import { demoInterviews } from "@/lib/demo-data";

export default function InterviewsPage() {
  return (
    <>
      <PageHeader
        title="Interviews"
        description="Prepare, take notes, upload consented audio, generate feedback, and draft thank-you emails for review."
      />

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_420px]">
        <Panel>
          <PanelHeader title="Upcoming interviews" />
          <div className="divide-y divide-slate-100">
            {demoInterviews.map((interview) => (
              <Link key={interview.id} href={`/interviews/${interview.id}`} className="block px-5 py-4 hover:bg-slate-50">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p className="text-sm font-semibold text-slate-950">{interview.company}</p>
                    <p className="text-xs text-slate-500">{interview.title} · {interview.scheduledAt}</p>
                  </div>
                  <div className="flex gap-2">
                    <StatusBadge status={interview.type} />
                    <StatusBadge status={interview.prepStatus} />
                  </div>
                </div>
              </Link>
            ))}
          </div>
        </Panel>

        <Panel className="h-fit">
          <PanelHeader title="Add interview" />
          <form className="space-y-4 p-5">
            <label className="block text-sm font-medium text-slate-700">
              Interview type
              <select className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2">
                <option>Recruiter</option>
                <option>Hiring manager</option>
                <option>Technical</option>
                <option>Panel</option>
                <option>Final</option>
              </select>
            </label>
            <label className="block text-sm font-medium text-slate-700">
              Date and time
              <input type="datetime-local" className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2" />
            </label>
            <label className="block text-sm font-medium text-slate-700">
              Interviewers
              <input className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2" />
            </label>
            <button className="inline-flex items-center gap-2 rounded-lg bg-brand-600 px-3 py-2 text-sm font-semibold text-white">
              <CalendarPlus size={16} aria-hidden="true" />
              Save interview
            </button>
          </form>
        </Panel>
      </div>
    </>
  );
}
