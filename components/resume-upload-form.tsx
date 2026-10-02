"use client";

import { useRef, useState } from "react";
import { Loader2, Upload } from "lucide-react";
import { useRouter } from "next/navigation";

import { fetchWithAiCostConfirmation } from "@/lib/ai/browser-request";

type FormResult =
  | { kind: "success"; replayed: boolean; warnings: string[] }
  | { kind: "error"; message: string; retryable: boolean }
  | { kind: "uncertain" };

export function ResumeUploadForm() {
  const router = useRouter();
  const pendingRef = useRef(false);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<FormResult | null>(null);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    setResult(null);
    const formData = new FormData(event.currentTarget);
    try {
      const response = await fetchWithAiCostConfirmation("/api/resumes/parse", {
        method: "POST",
        body: formData
      });
      const body = await response.json().catch(() => null) as {
        error?: unknown;
        retryable?: unknown;
        replayed?: unknown;
        resume?: { id?: unknown; isMaster?: unknown };
        parsed?: { warnings?: unknown };
      } | null;
      if (!response.ok) {
        setResult({
          kind: "error",
          message: typeof body?.error === "string" ? body.error : "Resume parsing could not be completed.",
          retryable: body?.retryable === true
        });
        return;
      }
      if (
        typeof body?.resume?.id !== "string" ||
        body.resume.isMaster !== true ||
        typeof body.replayed !== "boolean"
      ) {
        setResult({
          kind: "error",
          message: "Resume parsing returned an invalid confirmation. Check the Master resume profile before retrying.",
          retryable: false
        });
        return;
      }
      const warnings = Array.isArray(body.parsed?.warnings)
        ? body.parsed.warnings.filter((warning): warning is string => typeof warning === "string")
        : [];
      setResult({ kind: "success", replayed: body.replayed, warnings });
      router.refresh();
    } catch (error) {
      if (error instanceof Error && /canceled before any provider charge/i.test(error.message)) {
        setResult({ kind: "error", message: error.message, retryable: true });
      } else {
        setResult({ kind: "uncertain" });
      }
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }

  return (
    <form className="space-y-4 p-5" onSubmit={submit}>
      <label className="block text-sm font-medium text-slate-700">
        Resume title
        <input name="title" defaultValue="Master Resume" className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2" />
      </label>
      <label className="block text-sm font-medium text-slate-700">
        Resume file
        <input name="file" type="file" accept=".pdf,.docx,.txt" className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2" />
      </label>
      <label className="block text-sm font-medium text-slate-700">
        Or paste text
        <textarea name="pastedText" rows={8} className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2" />
      </label>
      <p className="text-xs leading-5 text-slate-500">
        Parsing sends the complete extracted resume text to the configured AI provider only after you confirm the recipient and maximum cost. Your current master remains unchanged unless the structured result passes validation and is saved.
      </p>
      <button
        type="submit"
        disabled={pending}
        className="inline-flex items-center gap-2 rounded-lg bg-brand-600 px-3 py-2 text-sm font-semibold text-white"
      >
        {pending ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <Upload size={16} aria-hidden="true" />}
        {pending ? "Parsing resume" : "Parse resume"}
      </button>
      {result?.kind === "success" ? (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-950" role="status">
          <p>{result.replayed ? "This resume was already saved; the existing master record was reused." : "Master resume saved after validated structured parsing."}</p>
          {result.warnings.length ? (
            <ul className="mt-2 list-disc space-y-1 pl-5">
              {result.warnings.map((warning) => <li key={warning}>{warning}</li>)}
            </ul>
          ) : null}
        </div>
      ) : result?.kind === "error" ? (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950" role="alert">
          <p>{result.message}</p>
          <p className="mt-1">{result.retryable ? "You may retry after reviewing the request." : "Review the source or parser issue before retrying."}</p>
        </div>
      ) : result?.kind === "uncertain" ? (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950" role="alert">
          Parse status could not be confirmed. Check the Master resume profile before retrying; Apply Pilot will not retry automatically.
        </div>
      ) : null}
    </form>
  );
}
