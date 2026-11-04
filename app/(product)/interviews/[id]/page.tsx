import { notFound } from "next/navigation";
import { ShieldCheck } from "lucide-react";

import { InterviewFeedbackAction, InterviewPrepAction } from "@/components/interview-ai-actions";
import { InterviewAudioUpload } from "@/components/interview-audio-upload";
import { PageHeader, Panel, PanelHeader, StatusBadge } from "@/components/ui";
import { getAiAvailability } from "@/lib/ai/config";
import { directAudioMaxBytes, directAudioUploadsEnabled, serverAudioMaxBytes } from "@/lib/interviews/audio-storage";
import { requirePageUserId } from "@/lib/page-context";
import { prisma } from "@/lib/prisma";

type Props = {
  params: Promise<{ id: string }>;
};

type StoredStarStory = {
  theme: string;
  situation: string;
  task: string;
  action: string;
  result: string;
  sources: Array<{ factId: string; excerpt: string }>;
  metricGaps: string[];
};

type StoredFeedback = {
  summary?: string;
  strongMoments?: string[];
  weakAnswers?: string[];
  betterAnswers?: Array<{ question: string; suggestion: string; metricGaps?: string[] }>;
};

function formatDate(value: Date | null) {
  return value ? value.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }) : "Not scheduled";
}

function strings(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function starStories(value: unknown): StoredStarStory[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const story = item as Record<string, unknown>;
    const fields = ["theme", "situation", "task", "action", "result"] as const;
    if (!fields.every((field) => typeof story[field] === "string")) return [];
    return [{
      theme: story.theme as string,
      situation: story.situation as string,
      task: story.task as string,
      action: story.action as string,
      result: story.result as string,
      sources: Array.isArray(story.sources)
        ? story.sources.filter((source): source is { factId: string; excerpt: string } =>
            Boolean(source) && typeof (source as { excerpt?: unknown }).excerpt === "string")
        : [],
      metricGaps: strings(story.metricGaps)
    }];
  });
}

function storedFeedback(value: unknown): StoredFeedback | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as StoredFeedback : null;
}

const unavailableMessages = {
  disabled: "AI is turned off on this server.",
  not_configured: "Gemini is not configured on this server.",
  unsupported_provider: "The server selects a retired AI provider; Gemini is the only supported provider."
} as const;

export default async function InterviewDetailPage({ params }: Props) {
  const userId = await requirePageUserId();
  const { id } = await params;
  const interview = await prisma.interview.findFirst({
    where: { id, userId },
    include: {
      jobPosting: true,
      application: { include: { jobPosting: true } },
      recordings: { orderBy: { createdAt: "desc" } },
      notesList: { orderBy: { createdAt: "desc" } },
      aiAnalyses: {
        where: { userId, type: "INTERVIEW_FEEDBACK" },
        orderBy: { createdAt: "desc" },
        take: 1
      }
    }
  });

  if (!interview) {
    notFound();
  }

  const job = interview.jobPosting ?? interview.application?.jobPosting;
  const availability = getAiAvailability();
  const aiAvailable = availability.available;
  const unavailableMessage = availability.available ? "" : unavailableMessages[availability.reason];
  const stories = starStories(interview.starStories);
  const feedback = storedFeedback(interview.aiAnalyses[0]?.output);

  return (
    <>
      <PageHeader
        title={`${job?.company ?? "Interview"} interview`}
        description={`${job?.title ?? interview.type} · ${formatDate(interview.scheduledAt)}`}
      />

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.2fr)_420px]">
        <section className="space-y-6">
          <Panel>
            <PanelHeader
              title="Prep brief"
              description="Built only from your master resume and the linked job post. Preparation only: nothing here is used during the interview."
            />
            <div className="space-y-4 p-5 text-sm leading-6 text-slate-700">
              <p>{interview.prepBrief ?? "No prep brief yet."}</p>
              <InterviewPrepAction
                interviewId={interview.id}
                aiAvailable={aiAvailable}
                unavailableMessage={unavailableMessage}
                hasPrep={Boolean(interview.prepBrief)}
              />
            </div>
          </Panel>

          <Panel>
            <PanelHeader
              title="STAR stories"
              description="Drafted from cited master-resume facts. Numbers not in your resume are replaced with [add a number here] for you to verify."
            />
            <div className="divide-y divide-slate-100">
              {stories.length ? stories.map((story) => (
                <article key={story.theme} className="space-y-2 p-5 text-sm leading-6 text-slate-700">
                  <h3 className="font-semibold text-slate-950">{story.theme}</h3>
                  <p><span className="font-semibold">Situation:</span> {story.situation}</p>
                  <p><span className="font-semibold">Task:</span> {story.task}</p>
                  <p><span className="font-semibold">Action:</span> {story.action}</p>
                  <p><span className="font-semibold">Result:</span> {story.result}</p>
                  {story.metricGaps.length ? (
                    <ul className="list-disc space-y-1 rounded-lg border border-amber-200 bg-amber-50 py-2 pl-7 pr-3 text-xs text-amber-900">
                      {story.metricGaps.map((gap) => <li key={gap}>{gap}</li>)}
                    </ul>
                  ) : null}
                  {story.sources.length ? (
                    <p className="text-xs text-slate-500">
                      From your resume: {story.sources.map((source) => `“${source.excerpt}”`).join(" · ")}
                    </p>
                  ) : null}
                </article>
              )) : (
                <p className="p-5 text-sm text-slate-600">No STAR stories yet.</p>
              )}
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
            <PanelHeader
              title="Feedback and thank-you draft"
              description="After the interview, review your notes or a consented transcript you paste. Apply Pilot never sends the thank-you email."
            />
            <div className="space-y-4 p-5 text-sm leading-6 text-slate-700">
              {feedback?.summary ? <p>{feedback.summary}</p> : null}
              {strings(feedback?.strongMoments).length ? (
                <div>
                  <p className="font-semibold text-slate-950">Strong moments</p>
                  <ul className="list-disc pl-5">{strings(feedback?.strongMoments).map((item) => <li key={item}>{item}</li>)}</ul>
                </div>
              ) : null}
              {strings(feedback?.weakAnswers).length ? (
                <div>
                  <p className="font-semibold text-slate-950">Answers to strengthen</p>
                  <ul className="list-disc pl-5">{strings(feedback?.weakAnswers).map((item) => <li key={item}>{item}</li>)}</ul>
                </div>
              ) : null}
              {feedback?.betterAnswers?.length ? (
                <div className="space-y-2">
                  <p className="font-semibold text-slate-950">Stronger answers from your history</p>
                  {feedback.betterAnswers.map((answer) => (
                    <div key={answer.question} className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                      <p className="font-medium text-slate-950">{answer.question}</p>
                      <p className="mt-1">{answer.suggestion}</p>
                    </div>
                  ))}
                </div>
              ) : null}
              {interview.followUpEmailDraft ? (
                <div className="rounded-lg border border-slate-200 p-3">
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Thank-you draft (review and send it yourself)</p>
                  <p className="mt-2 whitespace-pre-line">{interview.followUpEmailDraft}</p>
                </div>
              ) : (
                <p>No feedback yet.</p>
              )}
              <InterviewFeedbackAction
                interviewId={interview.id}
                aiAvailable={aiAvailable}
                unavailableMessage={unavailableMessage}
              />
            </div>
          </Panel>
        </section>

        <aside className="space-y-6">
          <Panel>
            <PanelHeader title="Recording consent" action={<ShieldCheck className="text-brand-600" size={18} />} />
            <InterviewAudioUpload
              interviewId={interview.id}
              directUploadEnabled={directAudioUploadsEnabled()}
              directUploadMaxMb={Math.floor(directAudioMaxBytes() / 1024 / 1024)}
              serverUploadMaxMb={Math.floor(serverAudioMaxBytes() / 1024 / 1024)}
            />
            <div className="border-t border-slate-100 p-5 text-sm text-slate-700">
              Recordings saved: {interview.recordings.length}. Apply Pilot does not transcribe audio; paste your own transcript for feedback.
            </div>
          </Panel>

          <Panel>
            <PanelHeader title="Likely questions" />
            <div className="space-y-3 p-5 text-sm text-slate-700">
              {interview.likelyQuestions.length ? (
                interview.likelyQuestions.map((question) => <p key={question}>{question}</p>)
              ) : (
                <p>No likely questions yet. Generate a prep brief to add them.</p>
              )}
              {interview.likelyQuestions.length ? (
                <div className="flex flex-wrap gap-2 pt-2">
                  <StatusBadge status={`${interview.likelyQuestions.length} saved to your question library`} />
                </div>
              ) : null}
            </div>
          </Panel>
        </aside>
      </div>
    </>
  );
}
