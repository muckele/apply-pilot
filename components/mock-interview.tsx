"use client";

import Link from "next/link";
import { useMemo, useRef, useState } from "react";
import { BookmarkPlus, CheckCircle2, ChevronLeft, ChevronRight, Circle, Loader2, MessageSquareText, Sparkles, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";

import { PrimaryButton, SecondaryButton, StatusBadge } from "@/components/ui";
import { fetchWithAiCostConfirmation } from "@/lib/ai/browser-request";
import {
  buildMockSessionSummary,
  isMockStorySaved,
  isStrongMockAnswer,
  MOCK_ANSWER_MAX_CHARS,
  MOCK_CATEGORY_LABELS,
  MOCK_DIMENSION_LABELS,
  MOCK_FEEDBACK_DIMENSIONS,
  STAR_PARTS,
  type MockAnswerMap,
  type MockAnswerRecord,
  type MockInterviewQuestion,
  type MockLibraryStory
} from "@/lib/ai/mock-interview-session";

// Text mock-interview practice (WP1.8). Every AI step needs Gemini: when it is
// unavailable the page says so and generates nothing in its place.

// Prepare, don't assist live (MVP Bible §5 and §8): some employers disqualify
// candidates who use AI during interviews.
const PRACTICE_NOTICE =
  "For practice before your interview. Don't use AI during a live interview unless the employer allows it.";

type ErrorBody = { error?: unknown; code?: unknown };

async function readError(response: Response, fallback: string) {
  const body = (await response.json().catch(() => null)) as ErrorBody | null;
  if (body?.code === "AI_UNAVAILABLE") return "AI unavailable. Gemini is not configured on this server, so no feedback was generated.";
  return typeof body?.error === "string" ? body.error : fallback;
}

export function MockInterviewPracticeNotice() {
  return (
    <p className="rounded-lg border border-sky-200 bg-sky-50 p-3 text-xs leading-5 text-sky-900">
      {PRACTICE_NOTICE}
    </p>
  );
}

export function MockInterviewUnavailableNotice({ message }: { message: string }) {
  return (
    <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs leading-5 text-amber-900">
      AI unavailable. {message} Mock interviews need Gemini; no template questions or feedback are generated instead.
    </p>
  );
}

type StartSource = { interviewId: string } | { applicationId: string } | { jobPostingId: string };

type AvailabilityProps = {
  aiAvailable: boolean;
  unavailableMessage: string;
};

function useStartSession() {
  const router = useRouter();
  const inFlight = useRef(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function start(source: StartSource) {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setMessage(null);
    try {
      const response = await fetchWithAiCostConfirmation("/api/interviews/mock-sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(source)
      });
      if (!response.ok) {
        setMessage(await readError(response, "The practice session could not be started."));
        return;
      }
      const body = (await response.json()) as { session: { id: string } };
      router.push(`/interviews/mock/${body.session.id}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The practice session status is unknown. Refresh before retrying.");
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  return { start, pending, message };
}

export function MockInterviewStartButton({
  source,
  aiAvailable,
  unavailableMessage,
  disabledReason
}: AvailabilityProps & { source: StartSource; disabledReason?: string | null }) {
  const { start, pending, message } = useStartSession();
  if (!aiAvailable) return <MockInterviewUnavailableNotice message={unavailableMessage} />;
  return (
    <div className="space-y-2">
      <p className="text-xs leading-5 text-slate-600">
        Builds 6–10 questions from the job post and your master-resume facts. You confirm the data sent to Google Gemini and the maximum cost first.
      </p>
      <PrimaryButton type="button" onClick={() => start(source)} disabled={pending || Boolean(disabledReason)}>
        {pending ? <Loader2 className="mr-2 animate-spin" size={15} /> : <Sparkles className="mr-2" size={15} />}
        Start a mock interview
      </PrimaryButton>
      {disabledReason ? <p className="text-xs leading-5 text-slate-600">{disabledReason}</p> : null}
      {message ? <p className="text-xs leading-5 text-slate-700" role="status">{message}</p> : null}
    </div>
  );
}

type PickerOption = { id: string; label: string };

export function MockInterviewPracticePicker({
  applications,
  jobs,
  aiAvailable,
  unavailableMessage
}: AvailabilityProps & { applications: PickerOption[]; jobs: PickerOption[] }) {
  const [choice, setChoice] = useState(applications[0] ? `application:${applications[0].id}` : jobs[0] ? `job:${jobs[0].id}` : "");
  const { start, pending, message } = useStartSession();
  if (!aiAvailable) return <MockInterviewUnavailableNotice message={unavailableMessage} />;
  if (!applications.length && !jobs.length) {
    return <p className="text-sm text-slate-600">Save a job or track an application first; practice questions come from its job post.</p>;
  }
  function submit() {
    const [kind, id] = choice.split(":");
    if (!id) return;
    start(kind === "application" ? { applicationId: id } : { jobPostingId: id });
  }
  return (
    <div className="space-y-3">
      <label className="block text-xs font-semibold text-slate-700">
        Practise for
        <select
          value={choice}
          onChange={(event) => setChoice(event.target.value)}
          className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-normal text-slate-700"
        >
          {applications.length ? (
            <optgroup label="Applications">
              {applications.map((option) => <option key={option.id} value={`application:${option.id}`}>{option.label}</option>)}
            </optgroup>
          ) : null}
          {jobs.length ? (
            <optgroup label="Saved jobs">
              {jobs.map((option) => <option key={option.id} value={`job:${option.id}`}>{option.label}</option>)}
            </optgroup>
          ) : null}
        </select>
      </label>
      <PrimaryButton type="button" onClick={submit} disabled={pending || !choice}>
        {pending ? <Loader2 className="mr-2 animate-spin" size={15} /> : <Sparkles className="mr-2" size={15} />}
        Start a mock interview
      </PrimaryButton>
      <p className="text-xs leading-5 text-slate-600">
        No interview scheduled yet? Practise from the job post. You confirm the data sent to Google Gemini and the maximum cost first.
      </p>
      {message ? <p className="text-xs leading-5 text-slate-700" role="status">{message}</p> : null}
    </div>
  );
}

export function MockInterviewDeleteButton({ sessionId, redirectTo }: { sessionId: string; redirectTo?: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function remove() {
    if (!window.confirm("Delete this practice session and your saved answers? STAR stories you saved to your library stay there.")) return;
    setPending(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/interviews/mock-sessions/${sessionId}`, { method: "DELETE" });
      if (!response.ok) {
        setMessage(await readError(response, "The practice session could not be deleted."));
        return;
      }
      if (redirectTo) router.push(redirectTo);
      else router.refresh();
    } catch {
      setMessage("Delete status is unknown. Refresh before retrying.");
    } finally {
      setPending(false);
    }
  }

  return (
    <span className="inline-flex flex-col items-end gap-1">
      <SecondaryButton type="button" onClick={remove} disabled={pending} aria-label="Delete practice session">
        {pending ? <Loader2 className="mr-2 animate-spin" size={14} /> : <Trash2 className="mr-2" size={14} />}
        Delete
      </SecondaryButton>
      {message ? <span className="text-xs text-slate-700" role="status">{message}</span> : null}
    </span>
  );
}

// ---------------------------------------------------------------- session runner

function formatUsdMicros(micros: number) {
  return `$${(micros / 1_000_000).toFixed(6).replace(/0+$/u, "").replace(/\.$/u, "")}`;
}

const CONFIRMED_HEADERS = { "x-ai-cost-confirmed": "true", "x-ai-data-confirmed": "true" };

// Answer feedback needs the user's explicit consent to send their answer to Gemini.
// They give it once per page visit for this session; the server still requires the
// confirmation headers and the hard budget ledger on every request.
async function postAnswerWithConsent(url: string, body: string, consented: { current: boolean }) {
  const baseHeaders = { "content-type": "application/json" };
  const response = await fetch(url, {
    method: "POST",
    headers: consented.current ? { ...baseHeaders, ...CONFIRMED_HEADERS } : baseHeaders,
    body
  });
  if (response.status !== 428) return response;
  const details = (await response.clone().json().catch(() => null)) as { code?: string; maximumCostMicros?: number } | null;
  if (details?.code !== "AI_COST_CONFIRMATION_REQUIRED") return response;
  const maximum = typeof details.maximumCostMicros === "number" ? formatUsdMicros(details.maximumCostMicros) : "a few cents";
  const confirmed = window.confirm(
    `Your practice answer, the question, and your master-resume facts will be sent to Google Gemini for feedback. ` +
      `Each answer could cost up to ${maximum}; the final charge is usually lower. ` +
      "Allow this for each answer you submit in this practice session until you leave the page?"
  );
  if (!confirmed) throw new Error("Feedback canceled before any AI charge was made.");
  consented.current = true;
  return fetch(url, { method: "POST", headers: { ...baseHeaders, ...CONFIRMED_HEADERS }, body });
}

type SessionView = {
  id: string;
  title: string;
  questions: MockInterviewQuestion[];
  answers: MockAnswerMap;
  completedAt: string | null;
};

function ScoreRow({ label, score, note }: { label: string; score: number; note: string }) {
  return (
    <div className="grid gap-1 sm:grid-cols-[150px_70px_minmax(0,1fr)] sm:items-start">
      <span className="text-xs font-semibold text-slate-700">{label}</span>
      <span className="text-xs font-semibold text-slate-950" aria-label={`${score} out of 5`}>
        {"●".repeat(score)}<span className="text-slate-300">{"●".repeat(5 - score)}</span> {score}/5
      </span>
      <span className="text-xs leading-5 text-slate-600">{note}</span>
    </div>
  );
}

function AnswerFeedback({
  record,
  onSaveStory,
  saving
}: {
  record: MockAnswerRecord;
  onSaveStory: () => void;
  saving: boolean;
}) {
  const { feedback } = record;
  const strong = isStrongMockAnswer(feedback);
  const saved = isMockStorySaved(record);
  const hasEvidenceFlags = feedback.unsupportedClaims.length > 0 || feedback.unverifiedNumbers.length > 0;
  return (
    <div className="space-y-4 rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">
      <div className="space-y-2">
        {MOCK_FEEDBACK_DIMENSIONS.map((dimension) => (
          <ScoreRow
            key={dimension}
            label={MOCK_DIMENSION_LABELS[dimension]}
            score={feedback.scores[dimension].score}
            note={feedback.scores[dimension].note}
          />
        ))}
      </div>
      <div className="flex flex-wrap gap-2" aria-label="STAR coverage">
        {STAR_PARTS.map((part) => (
          <span key={part} className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-semibold ring-1 ${feedback.starCoverage[part] ? "bg-emerald-50 text-emerald-800 ring-emerald-200" : "bg-white text-slate-500 ring-slate-200"}`}>
            {feedback.starCoverage[part] ? <CheckCircle2 size={12} /> : <Circle size={12} />}
            <span className="capitalize">{part}</span>
          </span>
        ))}
      </div>
      {feedback.strengths.length ? (
        <div>
          <p className="font-semibold text-slate-950">What worked</p>
          <ul className="mt-1 list-disc space-y-1 pl-5">{feedback.strengths.map((item) => <li key={item}>{item}</li>)}</ul>
        </div>
      ) : null}
      <div>
        <p className="font-semibold text-slate-950">Try this next</p>
        <ul className="mt-1 list-disc space-y-1 pl-5">
          {feedback.tips.map((tip) => (
            <li key={`${tip.dimension}:${tip.tip}`}>
              <span className="font-medium">{MOCK_DIMENSION_LABELS[tip.dimension]}:</span> {tip.tip}
            </li>
          ))}
        </ul>
      </div>
      {hasEvidenceFlags ? (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs leading-5 text-amber-900">
          <p className="font-semibold">Not found in your resume facts yet</p>
          <p className="mt-1">This isn&apos;t a judgement: it may simply be missing from your master resume. If it&apos;s accurate, add it there so you can back it up in the interview.</p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            {feedback.unsupportedClaims.map((claim) => (
              <li key={claim.quote}>&ldquo;{claim.quote}&rdquo; — {claim.note}</li>
            ))}
            {feedback.unverifiedNumbers.map((token) => (
              <li key={`number:${token}`}>The number {token} doesn&apos;t appear in your resume facts.</li>
            ))}
          </ul>
        </div>
      ) : null}
      {feedback.strongerVersion ? (
        <div className="space-y-2">
          <p className="font-semibold text-slate-950">A stronger version, from your answer and resume only</p>
          <p className="whitespace-pre-line rounded-lg border border-slate-200 bg-white p-3">{feedback.strongerVersion.text}</p>
          {feedback.strongerVersion.metricGaps.length ? (
            <ul className="list-disc space-y-1 pl-5 text-xs text-amber-900">
              {feedback.strongerVersion.metricGaps.map((gap) => <li key={gap}>{gap}</li>)}
            </ul>
          ) : null}
          {feedback.strongerVersion.sources.length ? (
            <p className="text-xs text-slate-500">
              From your resume: {feedback.strongerVersion.sources.map((source) => `“${source.excerpt}”`).join(" · ")}
            </p>
          ) : null}
          <p className="text-xs text-slate-500">Replace every [add a number here] only with a number you can verify.</p>
        </div>
      ) : null}
      <div className="border-t border-slate-200 pt-3">
        {saved ? (
          <p className="text-xs text-emerald-800">
            Saved to your STAR library. <Link className="font-semibold underline" href={`/interviews/library#story-${record.savedStoryId}`}>Open the story</Link>
          </p>
        ) : strong ? (
          <SecondaryButton type="button" onClick={onSaveStory} disabled={saving}>
            {saving ? <Loader2 className="mr-2 animate-spin" size={14} /> : <BookmarkPlus className="mr-2" size={14} />}
            Save as STAR story
          </SecondaryButton>
        ) : (
          <p className="text-xs text-slate-500">Cover all four STAR parts and work on the tips to save this answer as a STAR story.</p>
        )}
      </div>
    </div>
  );
}

function SessionSummary({
  questions,
  answers,
  stories,
  onJump
}: {
  questions: MockInterviewQuestion[];
  answers: MockAnswerMap;
  stories: MockLibraryStory[];
  onJump: (questionId: string) => void;
}) {
  const summary = useMemo(() => buildMockSessionSummary({ questions, answers, stories }), [questions, answers, stories]);
  const numberFor = (questionId: string) => questions.findIndex((question) => question.questionId === questionId) + 1;
  return (
    <section className="space-y-4 rounded-lg border border-slate-200 bg-white p-5 text-sm text-slate-700" aria-label="Session summary">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-slate-950">Session summary</h2>
        <StatusBadge status={`${summary.answeredCount} of ${summary.questionCount} answered`} />
      </div>
      {summary.answeredCount ? (
        <>
          <div className="grid gap-2 sm:grid-cols-4">
            {MOCK_FEEDBACK_DIMENSIONS.map((dimension) => (
              <div key={dimension} className="rounded-lg border border-slate-200 p-3">
                <p className="text-xs text-slate-500">{MOCK_DIMENSION_LABELS[dimension]}</p>
                <p className="text-lg font-semibold text-slate-950">{summary.averages[dimension]?.toFixed(1) ?? "-"}<span className="text-xs font-normal text-slate-500"> / 5</span></p>
              </div>
            ))}
          </div>
          <p className="text-xs text-slate-500">Practice scores from the AI coach. They are not an employer&apos;s score or a hiring prediction.</p>
          {summary.strengths.length ? (
            <div>
              <p className="font-semibold text-slate-950">Strengths</p>
              <ul className="mt-1 list-disc space-y-1 pl-5">{summary.strengths.map((item) => <li key={item}>{item}</li>)}</ul>
            </div>
          ) : null}
          {summary.focusAreas.length ? (
            <div>
              <p className="font-semibold text-slate-950">Top things to work on</p>
              <ol className="mt-1 list-decimal space-y-1 pl-5">
                {summary.focusAreas.map((area) => (
                  <li key={`${area.questionId}:${area.dimension}`}>
                    <span className="font-medium">{MOCK_DIMENSION_LABELS[area.dimension]}:</span> {area.tip}{" "}
                    <button type="button" className="text-xs font-semibold text-brand-700 underline" onClick={() => onJump(area.questionId)}>
                      Question {numberFor(area.questionId)}
                    </button>
                  </li>
                ))}
              </ol>
            </div>
          ) : null}
        </>
      ) : (
        <p>Answer a question to see your summary.</p>
      )}
      <div>
        <p className="font-semibold text-slate-950">STAR stories from your library</p>
        {summary.storyLinks.length ? (
          <ul className="mt-1 space-y-1">
            {summary.storyLinks.map((link) => (
              <li key={link.storyId}>
                <Link className="font-medium text-brand-700 underline" href={`/interviews/library#story-${link.storyId}`}>{link.title}</Link>
                <span className="text-xs text-slate-500">
                  {" "}· {link.reason === "saved_from_session" ? "saved from this session" : "may fit"} question {link.questionIds.map(numberFor).join(", ")}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-1 text-xs text-slate-500">No library stories match these questions yet. Save a strong answer to start one.</p>
        )}
      </div>
    </section>
  );
}

export function MockInterviewSessionRunner({
  session,
  stories,
  aiAvailable,
  unavailableMessage,
  backHref
}: AvailabilityProps & { session: SessionView; stories: MockLibraryStory[]; backHref: string }) {
  const router = useRouter();
  const consented = useRef(false);
  const inFlight = useRef(false);
  const [answers, setAnswers] = useState<MockAnswerMap>(session.answers);
  const [library, setLibrary] = useState<MockLibraryStory[]>(stories);
  const [completedAt, setCompletedAt] = useState<string | null>(session.completedAt);
  const firstOpen = Math.max(0, session.questions.findIndex((question) => !session.answers[question.questionId]));
  const [index, setIndex] = useState(firstOpen);
  const [drafts, setDrafts] = useState<Record<string, string>>(() =>
    Object.fromEntries(Object.entries(session.answers).map(([questionId, record]) => [questionId, record.answer])));
  const [pending, setPending] = useState<"answer" | "story" | "finish" | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const question = session.questions[index];
  if (!question) return <p className="text-sm text-slate-600">This practice session has no questions.</p>;
  const record = answers[question.questionId];
  const draft = drafts[question.questionId] ?? "";

  function go(nextIndex: number) {
    setIndex(Math.min(Math.max(nextIndex, 0), session.questions.length - 1));
    setMessage(null);
  }

  async function submitAnswer() {
    if (inFlight.current || !question) return;
    inFlight.current = true;
    setPending("answer");
    setMessage(null);
    try {
      const response = await postAnswerWithConsent(
        `/api/interviews/mock-sessions/${session.id}/answers`,
        JSON.stringify({ questionId: question.questionId, answer: draft }),
        consented
      );
      if (!response.ok) {
        setMessage(await readError(response, "Feedback could not be generated."));
        return;
      }
      const body = (await response.json()) as { questionId: string; answer: MockAnswerRecord };
      setAnswers((current) => ({ ...current, [body.questionId]: body.answer }));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Feedback status is unknown. Refresh before retrying.");
    } finally {
      inFlight.current = false;
      setPending(null);
    }
  }

  async function saveStory() {
    if (inFlight.current || !question || !record) return;
    inFlight.current = true;
    setPending("story");
    setMessage(null);
    try {
      const response = await fetch(`/api/interviews/mock-sessions/${session.id}/star-story`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ questionId: question.questionId })
      });
      if (!response.ok) {
        setMessage(await readError(response, "The STAR story could not be saved."));
        return;
      }
      const body = (await response.json()) as { story: MockLibraryStory & { id: string } };
      setAnswers((current) => ({
        ...current,
        [question.questionId]: { ...record, savedStoryId: body.story.id, savedStoryAttempt: record.attempts }
      }));
      setLibrary((current) => current.some((story) => story.id === body.story.id) ? current : [...current, {
        id: body.story.id,
        title: body.story.title,
        situation: body.story.situation,
        task: body.story.task,
        action: body.story.action,
        result: body.story.result,
        skills: body.story.skills ?? []
      }]);
      setMessage("Saved to your STAR library.");
    } catch {
      setMessage("Save status is unknown. Refresh before retrying.");
    } finally {
      inFlight.current = false;
      setPending(null);
    }
  }

  async function toggleFinished() {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending("finish");
    setMessage(null);
    try {
      const response = await fetch(`/api/interviews/mock-sessions/${session.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ completed: !completedAt })
      });
      if (!response.ok) {
        setMessage(await readError(response, "The session could not be updated."));
        return;
      }
      const body = (await response.json()) as { completedAt: string | null };
      setCompletedAt(body.completedAt);
      router.refresh();
    } catch {
      setMessage("Update status is unknown. Refresh before retrying.");
    } finally {
      inFlight.current = false;
      setPending(null);
    }
  }

  const answeredCount = session.questions.filter((entry) => answers[entry.questionId]).length;
  const tooShort = draft.trim().length < 20;

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1.3fr)_minmax(320px,1fr)]">
      <section className="space-y-4">
        <nav className="flex flex-wrap gap-2" aria-label="Questions">
          {session.questions.map((entry, position) => (
            <button
              key={entry.questionId}
              type="button"
              onClick={() => go(position)}
              aria-current={position === index ? "step" : undefined}
              className={`h-8 min-w-8 rounded-md px-2 text-xs font-semibold ring-1 ${position === index ? "bg-brand-600 text-white ring-brand-600" : answers[entry.questionId] ? "bg-emerald-50 text-emerald-800 ring-emerald-200" : "bg-white text-slate-600 ring-slate-200"}`}
            >
              {position + 1}
            </button>
          ))}
        </nav>

        <article className="space-y-4 rounded-lg border border-slate-200 bg-white p-5">
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
            <span>Question {index + 1} of {session.questions.length}</span>
            <StatusBadge status={MOCK_CATEGORY_LABELS[question.category]} />
          </div>
          <h2 className="text-lg font-semibold leading-7 text-slate-950">{question.question}</h2>
          <blockquote className="border-l-2 border-slate-200 pl-3 text-xs leading-5 text-slate-600">
            <span className="font-semibold text-slate-700">From the job post{question.jobLine.source === "requirement" ? " (requirement)" : question.jobLine.source === "preferred" ? " (preferred)" : ""}:</span>{" "}
            &ldquo;{question.jobLine.text}&rdquo;
          </blockquote>
          {question.lookingFor ? <p className="text-xs leading-5 text-slate-600"><span className="font-semibold text-slate-700">A strong answer shows:</span> {question.lookingFor}</p> : null}

          <label className="block text-xs font-semibold text-slate-700">
            Your answer
            <textarea
              value={draft}
              onChange={(event) => setDrafts((current) => ({ ...current, [question.questionId]: event.target.value }))}
              rows={9}
              maxLength={MOCK_ANSWER_MAX_CHARS}
              placeholder="Answer as you would out loud. Try STAR: the situation, your task, the actions you took, and the result."
              className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm font-normal leading-6 text-slate-700"
            />
          </label>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="text-xs text-slate-500">{draft.length.toLocaleString("en-US")} / {MOCK_ANSWER_MAX_CHARS.toLocaleString("en-US")} characters · private to you</span>
            <div className="flex flex-wrap gap-2">
              <SecondaryButton type="button" onClick={() => go(index - 1)} disabled={index === 0}>
                <ChevronLeft className="mr-1" size={15} /> Previous
              </SecondaryButton>
              {aiAvailable ? (
                <PrimaryButton type="button" onClick={submitAnswer} disabled={pending !== null || tooShort}>
                  {pending === "answer" ? <Loader2 className="mr-2 animate-spin" size={15} /> : <MessageSquareText className="mr-2" size={15} />}
                  {record ? "Get feedback again" : "Get feedback"}
                </PrimaryButton>
              ) : null}
              <SecondaryButton type="button" onClick={() => go(index + 1)} disabled={index === session.questions.length - 1}>
                Next <ChevronRight className="ml-1" size={15} />
              </SecondaryButton>
            </div>
          </div>
          {!aiAvailable ? <MockInterviewUnavailableNotice message={unavailableMessage} /> : null}
          {message ? <p className="text-xs leading-5 text-slate-700" role="status">{message}</p> : null}
          {record ? <AnswerFeedback record={record} onSaveStory={saveStory} saving={pending === "story"} /> : null}
        </article>
      </section>

      <aside className="space-y-4">
        <SessionSummary questions={session.questions} answers={answers} stories={library} onJump={(questionId) => go(session.questions.findIndex((entry) => entry.questionId === questionId))} />
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 bg-white p-4">
          <SecondaryButton type="button" onClick={toggleFinished} disabled={pending !== null || (!completedAt && answeredCount === 0)}>
            {pending === "finish" ? <Loader2 className="mr-2 animate-spin" size={14} /> : <CheckCircle2 className="mr-2" size={14} />}
            {completedAt ? "Reopen session" : "Finish session"}
          </SecondaryButton>
          <MockInterviewDeleteButton sessionId={session.id} redirectTo={backHref} />
        </div>
      </aside>
    </div>
  );
}

export type MockSessionListItem = {
  id: string;
  title: string;
  createdAt: string;
  completedAt: string | null;
  questionCount: number;
  answeredCount: number;
};

export function MockInterviewSessionList({ sessions, emptyMessage }: { sessions: MockSessionListItem[]; emptyMessage: string }) {
  if (!sessions.length) return <p className="text-sm text-slate-600">{emptyMessage}</p>;
  return (
    <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
      {sessions.map((session) => (
        <li key={session.id} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <Link href={`/interviews/mock/${session.id}`} className="min-w-0">
            <p className="truncate text-sm font-semibold text-slate-950 hover:underline">{session.title}</p>
            <p className="text-xs text-slate-500">
              {new Date(session.createdAt).toLocaleDateString("en-US", { dateStyle: "medium" })} · {session.answeredCount} of {session.questionCount} answered
            </p>
          </Link>
          <div className="flex items-center gap-2">
            <StatusBadge status={session.completedAt ? "Finished" : "In progress"} />
            <MockInterviewDeleteButton sessionId={session.id} />
          </div>
        </li>
      ))}
    </ul>
  );
}
