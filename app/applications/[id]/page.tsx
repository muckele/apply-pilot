import { notFound } from "next/navigation";

import { ButtonLink, PageHeader, Panel, PanelHeader, ScoreBadge, StatusBadge } from "@/components/ui";
import { demoApplications } from "@/lib/demo-data";

type Props = {
  params: Promise<{ id: string }>;
};

export default async function ApplicationDetailPage({ params }: Props) {
  const { id } = await params;
  const application = demoApplications.find((item) => item.id === id);

  if (!application) {
    notFound();
  }

  return (
    <>
      <PageHeader
        title={application.title}
        description={`${application.company} · Application CRM record`}
        action={<ButtonLink href={`/jobs/${application.jobId}`}>View job</ButtonLink>}
      />

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.2fr)_380px]">
        <section className="space-y-6">
          <Panel>
            <PanelHeader title="Pipeline status" />
            <div className="grid gap-4 p-5 md:grid-cols-4">
              <div>
                <p className="text-xs text-slate-500">Status</p>
                <div className="mt-2"><StatusBadge status={application.status} /></div>
              </div>
              <div>
                <p className="text-xs text-slate-500">Fit score</p>
                <div className="mt-2"><ScoreBadge score={application.score} /></div>
              </div>
              <div>
                <p className="text-xs text-slate-500">Date applied</p>
                <p className="mt-2 text-sm font-medium text-slate-800">{application.dateApplied || "Not applied"}</p>
              </div>
              <div>
                <p className="text-xs text-slate-500">Follow-up due</p>
                <p className="mt-2 text-sm font-medium text-slate-800">{application.followUpDue}</p>
              </div>
            </div>
          </Panel>

          <Panel>
            <PanelHeader title="Timeline" />
            <div className="divide-y divide-slate-100">
              {[
                "Application saved",
                "Fit analysis reviewed",
                application.dateApplied ? "Marked as applied" : "Awaiting application",
                "Next action assigned"
              ].map((event) => (
                <div key={event} className="px-5 py-4 text-sm text-slate-700">{event}</div>
              ))}
            </div>
          </Panel>

          <Panel>
            <PanelHeader title="Notes and lessons learned" />
            <div className="space-y-3 p-5">
              <textarea rows={7} className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm" defaultValue="Track recruiter notes, interview observations, objections, outcomes, and lessons learned here." />
            </div>
          </Panel>
        </section>

        <aside className="space-y-6">
          <Panel>
            <PanelHeader title="Next action" />
            <div className="p-5">
              <p className="text-sm leading-6 text-slate-700">{application.nextAction}</p>
              <div className="mt-4 flex gap-2">
                <button className="rounded-lg bg-brand-600 px-3 py-2 text-sm font-semibold text-white">Mark applied</button>
                <button className="rounded-lg border border-slate-200 px-3 py-2 text-sm font-semibold text-slate-700">Add note</button>
              </div>
            </div>
          </Panel>

          <Panel>
            <PanelHeader title="Contacts" />
            <div className="space-y-3 p-5">
              <input className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm" placeholder="Name" />
              <input className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm" placeholder="Email" />
              <input className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm" placeholder="LinkedIn/profile URL" />
            </div>
          </Panel>

          <Panel>
            <PanelHeader title="Documents used" />
            <div className="space-y-2 p-5 text-sm text-slate-700">
              <p>Tailored resume: not selected</p>
              <p>Cover letter: not selected</p>
            </div>
          </Panel>
        </aside>
      </div>
    </>
  );
}
