import { notFound } from "next/navigation";
import { Mic, ShieldCheck } from "lucide-react";

import { PageHeader, Panel, PanelHeader, StatusBadge } from "@/components/ui";
import { demoInterviews } from "@/lib/demo-data";

type Props = {
  params: Promise<{ id: string }>;
};

export default async function InterviewDetailPage({ params }: Props) {
  const { id } = await params;
  const interview = demoInterviews.find((item) => item.id === id);

  if (!interview) {
    notFound();
  }

  return (
    <>
      <PageHeader
        title={`${interview.company} interview`}
        description={`${interview.title} · ${interview.scheduledAt}`}
      />

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.2fr)_420px]">
        <section className="space-y-6">
          <Panel>
            <PanelHeader title="Prep brief" />
            <div className="space-y-4 p-5 text-sm leading-6 text-slate-700">
              <p>
                Connect the job requirements to customer-facing technical problem solving, implementation support, full-stack
                training, and operations ownership.
              </p>
              <div className="flex flex-wrap gap-2">
                {["Explain technical concepts", "Operations workflow", "Customer discovery", "API troubleshooting"].map((item) => (
                  <StatusBadge key={item} status={item} />
                ))}
              </div>
            </div>
          </Panel>

          <Panel>
            <PanelHeader title="Live notes" />
            <div className="p-5">
              <textarea rows={10} className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm" placeholder="Capture questions, answers, objections, and follow-up items." />
            </div>
          </Panel>

          <Panel>
            <PanelHeader title="Feedback" />
            <div className="p-5 text-sm leading-6 text-slate-700">
              Generate feedback after saving notes or a consented transcript.
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
                <input name="file" type="file" accept="audio/*" className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2" />
              </label>
              <button className="inline-flex items-center gap-2 rounded-lg bg-brand-600 px-3 py-2 text-sm font-semibold text-white">
                <Mic size={16} aria-hidden="true" />
                Upload consented audio
              </button>
            </form>
          </Panel>

          <Panel>
            <PanelHeader title="Likely questions" />
            <div className="space-y-3 p-5 text-sm text-slate-700">
              <p>Tell me about your transition into technical roles.</p>
              <p>How do you explain APIs to non-technical customers?</p>
              <p>Describe a time you improved an operational workflow.</p>
            </div>
          </Panel>
        </aside>
      </div>
    </>
  );
}
