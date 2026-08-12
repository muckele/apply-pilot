"use client";

import { useState } from "react";
import { Check, Clipboard, Eye, EyeOff, Loader2, Pencil, Plus, Trash2, X } from "lucide-react";
import { useRouter } from "next/navigation";

import {
  applicationAnswerCategories,
  formatApplicationAnswerCategory
} from "@/lib/application-answers";
import { PrimaryButton, SecondaryButton } from "@/components/ui";

type AnswerRecord = {
  id: string;
  category: string;
  question: string;
  answer: string;
  sensitive: boolean;
  isActive: boolean;
};

type Draft = Omit<AnswerRecord, "id">;

const emptyDraft: Draft = {
  category: "GENERAL",
  question: "",
  answer: "",
  sensitive: false,
  isActive: true
};

async function readJson(response: Response) {
  return (await response.json().catch(() => null)) as { error?: string } | null;
}

export function ApplicationAnswerVault({ initialAnswers }: { initialAnswers: AnswerRecord[] }) {
  const router = useRouter();
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState<string | null>(null);

  function updateDraft<Key extends keyof Draft>(key: Key, value: Draft[Key]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  function beginEdit(answer: AnswerRecord) {
    setEditingId(answer.id);
    setDraft({
      category: answer.category,
      question: answer.question,
      answer: answer.answer,
      sensitive: answer.sensitive,
      isActive: answer.isActive
    });
    setMessage(null);
  }

  function cancelEdit() {
    setEditingId(null);
    setDraft(emptyDraft);
  }

  async function saveAnswer() {
    if (!draft.question.trim() || !draft.answer.trim()) {
      setMessage("Enter both a question and an answer.");
      return;
    }

    setPendingId(editingId ?? "new");
    setMessage(null);
    const response = await fetch(
      editingId ? `/api/application-answers/${editingId}` : "/api/application-answers",
      {
        method: editingId ? "PATCH" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(draft)
      }
    );
    const json = await readJson(response);
    setPendingId(null);

    if (!response.ok) {
      setMessage(json?.error ?? "The answer could not be saved.");
      return;
    }

    setMessage(editingId ? "Answer updated." : "Answer added to your vault.");
    setEditingId(null);
    setDraft(emptyDraft);
    router.refresh();
  }

  async function patchAnswer(id: string, input: Partial<Draft>) {
    setPendingId(id);
    setMessage(null);
    const response = await fetch(`/api/application-answers/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input)
    });
    const json = await readJson(response);
    setPendingId(null);

    if (!response.ok) {
      setMessage(json?.error ?? "The answer could not be updated.");
      return;
    }

    router.refresh();
  }

  async function deleteAnswer(id: string) {
    if (!window.confirm("Delete this saved answer?")) return;

    setPendingId(id);
    setMessage(null);
    const response = await fetch(`/api/application-answers/${id}`, { method: "DELETE" });
    const json = await readJson(response);
    setPendingId(null);

    if (!response.ok) {
      setMessage(json?.error ?? "The answer could not be deleted.");
      return;
    }

    setMessage("Answer deleted.");
    router.refresh();
  }

  async function copyAnswer(answer: AnswerRecord) {
    try {
      await navigator.clipboard.writeText(answer.answer);
      setMessage(`Copied "${answer.question}". Review it before using it in an application.`);
    } catch {
      setMessage("Clipboard access was blocked by the browser. Reveal the answer and copy it manually.");
    }
  }

  function toggleReveal(id: string) {
    setRevealed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="space-y-6 p-5">
      <section className="grid gap-4 rounded-lg border border-slate-200 bg-slate-50 p-4 lg:grid-cols-2">
        <p className="text-xs leading-5 text-slate-500 lg:col-span-2">
          Do not store passwords, Social Security numbers, identity documents, banking details, or other secrets here.
        </p>
        <label className="text-sm font-medium text-slate-700">
          Category
          <select
            value={draft.category}
            onChange={(event) => updateDraft("category", event.target.value)}
            className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2"
          >
            {applicationAnswerCategories.map((category) => (
              <option key={category} value={category}>
                {formatApplicationAnswerCategory(category)}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm font-medium text-slate-700">
          Application question
          <input
            value={draft.question}
            onChange={(event) => updateDraft("question", event.target.value)}
            placeholder="Are you authorized to work in the United States?"
            className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2"
          />
        </label>
        <label className="text-sm font-medium text-slate-700 lg:col-span-2">
          Reviewed answer
          <textarea
            rows={4}
            value={draft.answer}
            onChange={(event) => updateDraft("answer", event.target.value)}
            placeholder="Write the exact answer you want available for copying."
            className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 leading-6"
          />
        </label>
        <div className="flex flex-wrap items-center gap-4 lg:col-span-2">
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={draft.sensitive}
              onChange={(event) => updateDraft("sensitive", event.target.checked)}
            />
            Mask this answer by default
          </label>
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={draft.isActive}
              onChange={(event) => updateDraft("isActive", event.target.checked)}
            />
            Available for use
          </label>
          <div className="ml-auto flex gap-2">
            {editingId ? (
              <SecondaryButton type="button" onClick={cancelEdit} disabled={pendingId !== null}>
                <X className="mr-2" size={15} /> Cancel
              </SecondaryButton>
            ) : null}
            <PrimaryButton type="button" onClick={saveAnswer} disabled={pendingId !== null}>
              {pendingId === (editingId ?? "new") ? (
                <Loader2 className="mr-2 animate-spin" size={15} />
              ) : editingId ? (
                <Check className="mr-2" size={15} />
              ) : (
                <Plus className="mr-2" size={15} />
              )}
              {editingId ? "Save changes" : "Add answer"}
            </PrimaryButton>
          </div>
        </div>
      </section>

      {message ? <p className="rounded-lg bg-slate-100 px-3 py-2 text-sm text-slate-700">{message}</p> : null}

      <div className="divide-y divide-slate-100 rounded-lg border border-slate-200">
        {initialAnswers.length ? (
          initialAnswers.map((answer) => {
            const visible = !answer.sensitive || revealed.has(answer.id);
            return (
              <article key={answer.id} className="p-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="rounded-md bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-600">
                        {formatApplicationAnswerCategory(answer.category)}
                      </span>
                      {!answer.isActive ? (
                        <span className="rounded-md bg-amber-50 px-2 py-1 text-xs font-semibold text-amber-700">Paused</span>
                      ) : null}
                    </div>
                    <h3 className="mt-2 text-sm font-semibold text-slate-950">{answer.question}</h3>
                    <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-slate-700">
                      {visible ? answer.answer : "Sensitive answer hidden"}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-wrap gap-2">
                    {answer.sensitive ? (
                      <button
                        type="button"
                        onClick={() => toggleReveal(answer.id)}
                        className="rounded-lg border border-slate-200 p-2 text-slate-600 hover:bg-slate-50"
                        title={visible ? "Hide answer" : "Reveal answer"}
                        aria-label={visible ? "Hide answer" : "Reveal answer"}
                      >
                        {visible ? <EyeOff size={16} /> : <Eye size={16} />}
                      </button>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => copyAnswer(answer)}
                      className="rounded-lg border border-slate-200 p-2 text-slate-600 hover:bg-slate-50"
                      title="Copy reviewed answer"
                      aria-label="Copy reviewed answer"
                    >
                      <Clipboard size={16} />
                    </button>
                    <button
                      type="button"
                      onClick={() => beginEdit(answer)}
                      className="rounded-lg border border-slate-200 p-2 text-slate-600 hover:bg-slate-50"
                      title="Edit answer"
                      aria-label="Edit answer"
                    >
                      <Pencil size={16} />
                    </button>
                    <button
                      type="button"
                      onClick={() => patchAnswer(answer.id, { isActive: !answer.isActive })}
                      disabled={pendingId === answer.id}
                      className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-50"
                    >
                      {answer.isActive ? "Pause" : "Enable"}
                    </button>
                    <button
                      type="button"
                      onClick={() => deleteAnswer(answer.id)}
                      disabled={pendingId === answer.id}
                      className="rounded-lg border border-red-200 p-2 text-red-700 hover:bg-red-50 disabled:opacity-50"
                      title="Delete answer"
                      aria-label="Delete answer"
                    >
                      {pendingId === answer.id ? <Loader2 className="animate-spin" size={16} /> : <Trash2 size={16} />}
                    </button>
                  </div>
                </div>
              </article>
            );
          })
        ) : (
          <div className="p-8 text-center text-sm text-slate-600">
            No saved answers yet. Add the recurring questions that slow down your applications.
          </div>
        )}
      </div>
    </div>
  );
}
