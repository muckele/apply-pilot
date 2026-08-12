"use client";

import { useState } from "react";
import { Archive, Check, Loader2, RotateCcw } from "lucide-react";
import { useRouter } from "next/navigation";

type TaskActionsProps = {
  taskId: string;
  status: "OPEN" | "DONE" | "ARCHIVED";
};

async function readError(response: Response) {
  const json = (await response.json().catch(() => null)) as { error?: string } | null;
  return json?.error ?? "Could not update task.";
}

export function TaskActions({ taskId, status }: TaskActionsProps) {
  const router = useRouter();
  const [pending, setPending] = useState<"OPEN" | "DONE" | "ARCHIVED" | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function updateStatus(nextStatus: "OPEN" | "DONE" | "ARCHIVED") {
    setPending(nextStatus);
    setMessage(null);

    try {
      const response = await fetch(`/api/tasks/${taskId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: nextStatus })
      });

      if (!response.ok) {
        setMessage(await readError(response));
        return;
      }

      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not update task.");
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap justify-end gap-2">
        {status === "DONE" ? (
          <button
            type="button"
            onClick={() => updateStatus("OPEN")}
            disabled={Boolean(pending)}
            className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {pending === "OPEN" ? <Loader2 className="animate-spin" size={14} /> : <RotateCcw size={14} />}
            Reopen
          </button>
        ) : (
          <button
            type="button"
            onClick={() => updateStatus("DONE")}
            disabled={Boolean(pending)}
            className="inline-flex items-center gap-2 rounded-lg bg-brand-600 px-3 py-2 text-xs font-semibold text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {pending === "DONE" ? <Loader2 className="animate-spin" size={14} /> : <Check size={14} />}
            Mark done
          </button>
        )}
        <button
          type="button"
          onClick={() => updateStatus("ARCHIVED")}
          disabled={Boolean(pending)}
          className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {pending === "ARCHIVED" ? <Loader2 className="animate-spin" size={14} /> : <Archive size={14} />}
          Archive
        </button>
      </div>
      {message ? <p className="rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">{message}</p> : null}
    </div>
  );
}
