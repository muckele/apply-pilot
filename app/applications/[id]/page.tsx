import { notFound } from "next/navigation";

import { ButtonLink, PageHeader, Panel, PanelHeader, ScoreBadge, StatusBadge } from "@/components/ui";
import { requirePageUserId } from "@/lib/page-context";
import { prisma } from "@/lib/prisma";

type Props = {
  params: Promise<{ id: string }>;
};

function formatDate(value: Date | null | undefined) {
  return value ? value.toISOString().slice(0, 10) : "Not set";
}

export default async function ApplicationDetailPage({ params }: Props) {
  const userId = await requirePageUserId();
  const { id } = await params;
  const application = await prisma.application.findFirst({
    where: { id, userId },
    include: {
      jobPosting: true,
      events: { orderBy: { occurredAt: "desc" } },
      contacts: true,
      emails: { orderBy: [{ receivedAt: "desc" }, { createdAt: "desc" }] },
      interviews: { orderBy: { scheduledAt: "asc" } },
      resumeVersion: true,
      coverLetterVersion: true,
      tasks: { orderBy: [{ dueAt: "asc" }, { createdAt: "desc" }] }
    }
  });

  if (!application) {
    notFound();
  }

  return (
    <>
      <PageHeader
        title={application.jobPosting.title}
        description={`${application.jobPosting.company} · Application CRM record`}
        action={<ButtonLink href={`/jobs/${application.jobPostingId}`}>View job</ButtonLink>}
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
                <div className="mt-2"><ScoreBadge score={application.jobPosting.overallFitScore ?? 50} /></div>
              </div>
              <div>
                <p className="text-xs text-slate-500">Date applied</p>
                <p className="mt-2 text-sm font-medium text-slate-800">{formatDate(application.dateApplied)}</p>
              </div>
              <div>
                <p className="text-xs text-slate-500">Follow-up due</p>
                <p className="mt-2 text-sm font-medium text-slate-800">{formatDate(application.followUpDueAt)}</p>
              </div>
            </div>
          </Panel>

          <Panel>
            <PanelHeader title="Timeline" />
            <div className="divide-y divide-slate-100">
              {application.events.length ? (
                application.events.map((event) => (
                  <div key={event.id} className="px-5 py-4 text-sm text-slate-700">
                    <p className="font-medium text-slate-950">{event.title}</p>
                    {event.body ? <p className="mt-1 leading-6">{event.body}</p> : null}
                    <p className="mt-1 text-xs text-slate-500">{formatDate(event.occurredAt)}</p>
                  </div>
                ))
              ) : (
                <div className="px-5 py-4 text-sm text-slate-600">No timeline events yet.</div>
              )}
            </div>
          </Panel>

          <Panel>
            <PanelHeader title="Notes and lessons learned" />
            <div className="space-y-3 p-5 text-sm leading-6 text-slate-700">
              <p>{application.notes || "No notes yet."}</p>
              {application.lessonsLearned ? (
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                  <p className="font-semibold text-slate-950">Lessons learned</p>
                  <p className="mt-1">{application.lessonsLearned}</p>
                </div>
              ) : null}
            </div>
          </Panel>
        </section>

        <aside className="space-y-6">
          <Panel>
            <PanelHeader title="Next action" />
            <div className="p-5">
              <p className="text-sm leading-6 text-slate-700">{application.nextAction ?? "Review next step."}</p>
            </div>
          </Panel>

          <Panel>
            <PanelHeader title="Contacts" />
            <div className="divide-y divide-slate-100">
              {application.contacts.length ? (
                application.contacts.map((contact) => (
                  <div key={contact.id} className="px-5 py-4 text-sm text-slate-700">
                    <p className="font-semibold text-slate-950">{contact.name}</p>
                    <p className="text-xs text-slate-500">{contact.email ?? "No email saved"}</p>
                  </div>
                ))
              ) : (
                <div className="px-5 py-4 text-sm text-slate-600">No contacts saved.</div>
              )}
            </div>
          </Panel>

          <Panel>
            <PanelHeader title="Documents used" />
            <div className="space-y-2 p-5 text-sm text-slate-700">
              <p>Tailored resume: {application.resumeVersion?.title ?? "not selected"}</p>
              <p>Cover letter: {application.coverLetterVersion?.title ?? "not selected"}</p>
            </div>
          </Panel>

          <Panel>
            <PanelHeader title="Related activity" />
            <div className="space-y-2 p-5 text-sm text-slate-700">
              <p>Emails: {application.emails.length}</p>
              <p>Interviews: {application.interviews.length}</p>
              <p>Tasks: {application.tasks.length}</p>
            </div>
          </Panel>
        </aside>
      </div>
    </>
  );
}
