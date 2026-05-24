import { notFound } from "next/navigation";
import { Mic, ShieldCheck } from "lucide-react";

import { PageHeader, Panel, PanelHeader, StatusBadge } from "@/components/ui";
import { requirePageUserId } from "@/lib/page-context";
import { prisma } from "@/lib/prisma";

type Props = {
  params: Promise<{ id: string }>;
};

function formatDate(value: Date | null) {
  return value ? value.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }) : "Not scheduled";
}

export default async function InterviewDetailPage({ params }: Props) {
  const userId = await requirePageUserId();
  const { id } = await params;
  const interview = await prisma.interview.findFirst({
    where: { id, userId },
    include: {
      jobPosting: true,
      application: { include: { jobPosting: true } },
      recordings: { orderBy: { createdAt: "desc" } },
      notesList: { orderBy: { createdAt: "desc" } }
    }
  });

  if (!interview) {
    notFound();
  }

  const job = interview.jobPosting ?? interview.application?.jobPosting;

  return (
    <>
      <PageHeader
        title={`${job?.company ?? "Interview"} interview`}
        description={`${job?.title ?? interview.type} · ${formatDate(interview.scheduledAt)}`}
      />

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.2fr)_420px]">
        <section className="space-y-6">
          <Panel>
            <PanelHeader title="Prep brief" />
            <div className="space-y-4 p-5 text-sm leading-6 text-slate-700">
              <p>{interview.prepBrief ?? "Generate prep from a linked job or application to populate this brief."}</p>
              <div className="flex flex-wrap gap-2">
                {interview.likelyQuestions.slice(0, 6).map((item) => (
                  <StatusBadge key={item} status={item} />
                ))}
              </div>
            </div>
          </Panel>

          <Panel>
            <PanelHeader title="Live notes" />
            <div className="space-y-3 p-5 text-sm leading-6 text-slate-700">
              {interview.notes ? <p>{interview.notes}</p> : <p>No interview notes saved yet.</p>}
              {interview.notesList.length ? (
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                  <p className="font-semibold text-slate-950">Saved note records</p>
                  <p className="mt-1">{interview.notesList.length} note record(s)</p>
                </div>
              ) : null}
            </div>
          </Panel>

          <Panel>
            <PanelHeader title="Feedback" />
            <div className="p-5 text-sm leading-6 text-slate-700">
              {interview.followUpEmailDraft ? (
                <p>{interview.followUpEmailDraft}</p>
              ) : (
                "Generate feedback after saving notes or a consented transcript."
              )}
            </div>
          </Panel>
        </section>

        <aside className="space-y-6">
          <Panel>
            <PanelHeader title="Recording consent" action={<ShieldCheck className="text-brand-600" size={18} />} />
            <form className="space-y-4 p-5 text-sm text-slate-700" action={`/api/interviews/${interview.id}/audio`} method="post" encType="multipart/form-data">
              <label className="flex gap-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
                <input type="checkbox" name="consentConfirmed" value="true" className="mt-1" />
                <span>
                  I confirm that all participants have been informed and have consented to recording/transcription.
                </span>
              </label>
              <label className="block font-medium">
                Audio file
                <input name="file" type="file" accept="audio/*,video/mp4,video/webm" className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2" />
              </label>
              <button className="inline-flex items-center gap-2 rounded-lg bg-brand-600 px-3 py-2 text-sm font-semibold text-white">
                <Mic size={16} aria-hidden="true" />
                Upload consented audio
              </button>
            </form>
            <div className="border-t border-slate-100 p-5 text-sm text-slate-700">
              Recordings saved: {interview.recordings.length}
            </div>
          </Panel>

          <Panel>
            <PanelHeader title="Likely questions" />
            <div className="space-y-3 p-5 text-sm text-slate-700">
              {interview.likelyQuestions.length ? (
                interview.likelyQuestions.map((question) => <p key={question}>{question}</p>)
              ) : (
                <p>No questions generated yet.</p>
              )}
            </div>
          </Panel>
        </aside>
      </div>
    </>
  );
}
