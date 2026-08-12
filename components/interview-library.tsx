"use client";

import { useState } from "react";
import { Check, Loader2, Plus, Save, Star, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";

import { PrimaryButton, SecondaryButton } from "@/components/ui";
import { formatInterviewCategory, interviewQuestionCategories } from "@/lib/interviews/library";

type QuestionRecord = {
  id: string;
  question: string;
  category: string;
  answer: string | null;
  improvedAnswer: string | null;
  tags: string[];
  timesAsked: number;
  lastAskedAt: string | null;
};

type StoryRecord = {
  id: string;
  title: string;
  situation: string;
  task: string;
  action: string;
  result: string;
  skills: string[];
  roleContext: string | null;
  isFavorite: boolean;
};

async function requestJson(url: string, method: string, body?: unknown) {
  const response = await fetch(url, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  const json = (await response.json().catch(() => null)) as { error?: string } | null;
  if (!response.ok) throw new Error(json?.error ?? "The interview library could not be updated.");
  return json;
}

function QuestionCard({ question, onChanged }: { question: QuestionRecord; onChanged: (message: string, refresh?: boolean) => void }) {
  const [answer, setAnswer] = useState(question.answer ?? "");
  const [improvedAnswer, setImprovedAnswer] = useState(question.improvedAnswer ?? "");
  const [pending, setPending] = useState(false);

  async function patch(body: unknown, message: string) {
    setPending(true);
    try {
      await requestJson(`/api/interview-library/questions/${question.id}`, "PATCH", body);
      onChanged(message);
    } catch (error) {
      onChanged(error instanceof Error ? error.message : "Question could not be updated.", false);
    } finally {
      setPending(false);
    }
  }

  return (
    <article className="rounded-lg border border-slate-200 p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <span className="rounded-md bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-600">
            {formatInterviewCategory(question.category)}
          </span>
          <h3 className="mt-2 text-sm font-semibold leading-6 text-slate-950">{question.question}</h3>
          <p className="mt-1 text-xs text-slate-500">Asked {question.timesAsked} time{question.timesAsked === 1 ? "" : "s"}</p>
        </div>
        <div className="flex gap-2">
          <SecondaryButton
            type="button"
            disabled={pending}
            onClick={() => patch({ timesAsked: question.timesAsked + 1, lastAskedAt: new Date().toISOString() }, "Question marked as asked.")}
          >
            <Check className="mr-2" size={15} /> Asked
          </SecondaryButton>
          <button
            type="button"
            disabled={pending}
            onClick={async () => {
              if (!window.confirm("Delete this interview question?")) return;
              setPending(true);
              try {
                await requestJson(`/api/interview-library/questions/${question.id}`, "DELETE");
                onChanged("Question deleted.");
              } catch (error) {
                onChanged(error instanceof Error ? error.message : "Question could not be deleted.", false);
              } finally {
                setPending(false);
              }
            }}
            className="rounded-lg border border-red-200 p-2 text-red-700 hover:bg-red-50 disabled:opacity-50"
            title="Delete question"
            aria-label="Delete question"
          >
            {pending ? <Loader2 className="animate-spin" size={16} /> : <Trash2 size={16} />}
          </button>
        </div>
      </div>
      <div className="mt-4 grid gap-3 xl:grid-cols-2">
        <label className="text-xs font-semibold text-slate-600">
          Your answer
          <textarea value={answer} onChange={(event) => setAnswer(event.target.value)} rows={5} className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm font-normal leading-6 text-slate-700" />
        </label>
        <label className="text-xs font-semibold text-slate-600">
          Improved answer
          <textarea value={improvedAnswer} onChange={(event) => setImprovedAnswer(event.target.value)} rows={5} className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm font-normal leading-6 text-slate-700" />
        </label>
      </div>
      <PrimaryButton type="button" disabled={pending} onClick={() => patch({ answer: answer || null, improvedAnswer: improvedAnswer || null }, "Question answers saved.")} className="mt-3">
        {pending ? <Loader2 className="mr-2 animate-spin" size={15} /> : <Save className="mr-2" size={15} />}
        Save answers
      </PrimaryButton>
    </article>
  );
}

function StoryCard({ story, onChanged }: { story: StoryRecord; onChanged: (message: string, refresh?: boolean) => void }) {
  const [draft, setDraft] = useState(story);
  const [pending, setPending] = useState(false);

  function update(key: keyof StoryRecord, value: StoryRecord[keyof StoryRecord]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  return (
    <article className="rounded-lg border border-slate-200 p-4">
      <div className="flex items-start justify-between gap-3">
        <input value={draft.title} onChange={(event) => update("title", event.target.value)} className="min-w-0 flex-1 border-0 p-0 text-sm font-semibold text-slate-950 outline-none" />
        <button
          type="button"
          onClick={() => update("isFavorite", !draft.isFavorite)}
          className="rounded-lg border border-slate-200 p-2 text-amber-600 hover:bg-amber-50"
          title={draft.isFavorite ? "Remove favorite" : "Favorite story"}
          aria-label={draft.isFavorite ? "Remove favorite" : "Favorite story"}
        >
          <Star size={16} fill={draft.isFavorite ? "currentColor" : "none"} />
        </button>
      </div>
      <div className="mt-3 grid gap-3 md:grid-cols-2">
        {(["situation", "task", "action", "result"] as const).map((field) => (
          <label key={field} className="text-xs font-semibold capitalize text-slate-600">
            {field}
            <textarea
              value={draft[field]}
              onChange={(event) => update(field, event.target.value)}
              rows={4}
              className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm font-normal leading-6 text-slate-700"
            />
          </label>
        ))}
      </div>
      <label className="mt-3 block text-xs font-semibold text-slate-600">
        Skills, comma separated
        <input value={draft.skills.join(", ")} onChange={(event) => update("skills", event.target.value.split(",").map((item) => item.trim()).filter(Boolean))} className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm font-normal" />
      </label>
      <div className="mt-3 flex flex-wrap gap-2">
        <PrimaryButton
          type="button"
          disabled={pending}
          onClick={async () => {
            setPending(true);
            try {
              await requestJson(`/api/interview-library/star-stories/${story.id}`, "PATCH", {
                title: draft.title,
                situation: draft.situation,
                task: draft.task,
                action: draft.action,
                result: draft.result,
                skills: draft.skills,
                roleContext: draft.roleContext,
                isFavorite: draft.isFavorite
              });
              onChanged("STAR story saved.");
            } catch (error) {
              onChanged(error instanceof Error ? error.message : "STAR story could not be saved.", false);
            } finally {
              setPending(false);
            }
          }}
        >
          {pending ? <Loader2 className="mr-2 animate-spin" size={15} /> : <Save className="mr-2" size={15} />}
          Save story
        </PrimaryButton>
        <button
          type="button"
          disabled={pending}
          onClick={async () => {
            if (!window.confirm("Delete this STAR story?")) return;
            setPending(true);
              try {
                await requestJson(`/api/interview-library/star-stories/${story.id}`, "DELETE");
                onChanged("STAR story deleted.");
              } catch (error) {
                onChanged(error instanceof Error ? error.message : "STAR story could not be deleted.", false);
              } finally {
              setPending(false);
            }
          }}
          className="inline-flex items-center rounded-lg border border-red-200 px-3 py-2 text-sm font-semibold text-red-700 hover:bg-red-50 disabled:opacity-50"
        >
          <Trash2 className="mr-2" size={15} /> Delete
        </button>
      </div>
    </article>
  );
}

export function InterviewLibrary({ initialQuestions, initialStories }: { initialQuestions: QuestionRecord[]; initialStories: StoryRecord[] }) {
  const router = useRouter();
  const [view, setView] = useState<"questions" | "stories">("questions");
  const [question, setQuestion] = useState("");
  const [category, setCategory] = useState("GENERAL");
  const [story, setStory] = useState({ title: "", situation: "", task: "", action: "", result: "", skills: "" });
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  function changed(nextMessage: string, refresh = true) {
    setMessage(nextMessage);
    if (refresh) router.refresh();
  }

  async function addQuestion() {
    setPending(true);
    setMessage(null);
    try {
      await requestJson("/api/interview-library/questions", "POST", { question, category, tags: [] });
      setQuestion("");
      changed("Question added.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Question could not be added.");
    } finally {
      setPending(false);
    }
  }

  async function addStory() {
    setPending(true);
    setMessage(null);
    try {
      await requestJson("/api/interview-library/star-stories", "POST", {
        ...story,
        skills: story.skills.split(",").map((item) => item.trim()).filter(Boolean)
      });
      setStory({ title: "", situation: "", task: "", action: "", result: "", skills: "" });
      changed("STAR story added.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "STAR story could not be added.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-5 p-5">
      <div className="inline-flex rounded-lg border border-slate-200 bg-slate-50 p-1">
        <button type="button" onClick={() => setView("questions")} className={`rounded-md px-3 py-2 text-sm font-semibold ${view === "questions" ? "bg-white text-slate-950 shadow-sm" : "text-slate-600"}`}>Questions</button>
        <button type="button" onClick={() => setView("stories")} className={`rounded-md px-3 py-2 text-sm font-semibold ${view === "stories" ? "bg-white text-slate-950 shadow-sm" : "text-slate-600"}`}>STAR stories</button>
      </div>

      {message ? <p className="rounded-lg bg-slate-100 px-3 py-2 text-sm text-slate-700">{message}</p> : null}

      {view === "questions" ? (
        <>
          <section className="grid gap-3 rounded-lg border border-slate-200 bg-slate-50 p-4 md:grid-cols-[180px_minmax(0,1fr)_auto] md:items-end">
            <label className="text-xs font-semibold text-slate-600">Category<select value={category} onChange={(event) => setCategory(event.target.value)} className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-normal">{interviewQuestionCategories.map((item) => <option key={item} value={item}>{formatInterviewCategory(item)}</option>)}</select></label>
            <label className="text-xs font-semibold text-slate-600">Interview question<input value={question} onChange={(event) => setQuestion(event.target.value)} className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-normal" /></label>
            <PrimaryButton type="button" onClick={addQuestion} disabled={pending || question.trim().length < 5}>{pending ? <Loader2 className="mr-2 animate-spin" size={15} /> : <Plus className="mr-2" size={15} />}Add</PrimaryButton>
          </section>
          <div className="grid gap-4">{initialQuestions.length ? initialQuestions.map((item) => <QuestionCard key={item.id} question={item} onChanged={changed} />) : <p className="rounded-lg border border-slate-200 p-8 text-center text-sm text-slate-600">No interview questions saved yet.</p>}</div>
        </>
      ) : (
        <>
          <section className="rounded-lg border border-slate-200 bg-slate-50 p-4">
            <label className="text-xs font-semibold text-slate-600">Story title<input value={story.title} onChange={(event) => setStory((current) => ({ ...current, title: event.target.value }))} className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-normal" /></label>
            <div className="mt-3 grid gap-3 md:grid-cols-2">{(["situation", "task", "action", "result"] as const).map((field) => <label key={field} className="text-xs font-semibold capitalize text-slate-600">{field}<textarea value={story[field]} onChange={(event) => setStory((current) => ({ ...current, [field]: event.target.value }))} rows={3} className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-normal" /></label>)}</div>
            <label className="mt-3 block text-xs font-semibold text-slate-600">Skills, comma separated<input value={story.skills} onChange={(event) => setStory((current) => ({ ...current, skills: event.target.value }))} className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-normal" /></label>
            <PrimaryButton type="button" onClick={addStory} disabled={pending || !story.title.trim() || !story.situation.trim() || !story.task.trim() || !story.action.trim() || !story.result.trim()} className="mt-3">{pending ? <Loader2 className="mr-2 animate-spin" size={15} /> : <Plus className="mr-2" size={15} />}Add STAR story</PrimaryButton>
          </section>
          <div className="grid gap-4">{initialStories.length ? initialStories.map((item) => <StoryCard key={item.id} story={item} onChanged={changed} />) : <p className="rounded-lg border border-slate-200 p-8 text-center text-sm text-slate-600">No STAR stories saved yet.</p>}</div>
        </>
      )}
    </div>
  );
}
