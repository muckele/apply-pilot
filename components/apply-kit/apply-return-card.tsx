"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CheckCircle2, Loader2, Undo2 } from "lucide-react";

// "Did you apply?": the in-page card shown when the user comes back after opening the employer's
// application (never a browser dialog), and the notice that lets a "Not applying" answer be undone.
// "Yes" never records anything by itself: it leads to the existing "I applied" confirmation.

export type ApplyReturnAction = "NOT_APPLYING" | "UNDO_NOT_APPLYING";

type Variant = "kit" | "job";

const STYLES: Record<Variant, { card: string; title: string; copy: string; primary: string; secondary: string; error: string }> = {
  kit: {
    card: "space-y-3 rounded-lg border border-brand-200 bg-brand-50 p-4",
    title: "text-base font-semibold text-slate-950",
    copy: "text-sm text-slate-700",
    primary: "inline-flex items-center justify-center rounded-lg bg-brand-600 px-3 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-60",
    secondary: "inline-flex items-center justify-center rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-800 hover:bg-slate-50 disabled:opacity-60",
    error: "rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900"
  },
  job: {
    card: "job-card job-apply-return",
    title: "job-card-title",
    copy: "job-card-copy",
    primary: "job-button job-button-primary",
    secondary: "job-button",
    error: "job-message job-message-error"
  }
};

// Records that the user opened the employer's application. keepalive lets the request finish while
// the browser switches to the new tab. "nothing-to-ask": the application has already moved past
// the point where "I applied" can be recorded (from another tab or device, say).
export async function recordApplicationOpened(jobId: string): Promise<"recorded" | "nothing-to-ask" | "failed"> {
  try {
    const response = await fetch(`/api/jobs/${jobId}/apply-return`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "OPENED" }),
      keepalive: true
    });
    if (!response.ok) return "failed";
    const json = (await response.json().catch(() => null)) as { opened?: unknown } | null;
    return json && json.opened === null ? "nothing-to-ask" : "recorded";
  } catch {
    return "failed";
  }
}

export function useApplyReturnAnswer(jobId: string) {
  const router = useRouter();
  const [busy, setBusy] = useState<ApplyReturnAction | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function send(action: ApplyReturnAction) {
    setBusy(action);
    setError(null);
    try {
      const response = await fetch(`/api/jobs/${jobId}/apply-return`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action })
      });
      if (!response.ok) {
        const json = (await response.json().catch(() => null)) as { error?: string } | null;
        setError(json?.error ?? "Apply Pilot could not save your answer. Nothing changed; try again.");
        // 409: answered or changed elsewhere (another tab or device); reload to show where it stands.
        if (response.status === 409) router.refresh();
        return false;
      }
      router.refresh();
      return true;
    } catch {
      setError("Could not reach Apply Pilot. Nothing changed; try again.");
      return false;
    } finally {
      setBusy(null);
    }
  }

  return { busy, error, send, clearError: () => setError(null) };
}

export function ApplyReturnCard({
  company,
  variant,
  yes,
  onNotYet,
  onNotApplying,
  busy,
  error
}: {
  company: string;
  variant: Variant;
  yes: { onClick: () => void } | { href: string };
  onNotYet: () => void;
  onNotApplying: () => void;
  busy: boolean;
  error: string | null;
}) {
  const style = STYLES[variant];
  const yesContent = (
    <>
      <CheckCircle2 className="mr-2" size={15} aria-hidden="true" />
      Yes, I applied
    </>
  );
  return (
    <section className={style.card} aria-labelledby="apply-return-title" aria-live="polite" data-apply-return>
      <h2 id="apply-return-title" className={style.title}>Did you submit your application to {company}?</h2>
      <p className={style.copy}>
        You opened the employer&apos;s application from Apply Pilot. It is recorded as applied only when you confirm that you submitted it.
      </p>
      {error ? <p role="alert" className={style.error} data-apply-return-error>{error}</p> : null}
      <div className="flex flex-wrap gap-2">
        {"href" in yes ? (
          <Link href={yes.href} className={style.primary} data-apply-return-yes>{yesContent}</Link>
        ) : (
          <button type="button" onClick={yes.onClick} disabled={busy} className={style.primary} data-apply-return-yes>{yesContent}</button>
        )}
        <button type="button" onClick={onNotYet} disabled={busy} className={style.secondary} data-apply-return-not-yet>Not yet</button>
        <button type="button" onClick={onNotApplying} disabled={busy} className={style.secondary} data-apply-return-not-applying>
          {busy ? <Loader2 className="mr-2 animate-spin" size={15} aria-hidden="true" /> : null}
          Not applying
        </button>
      </div>
    </section>
  );
}

export function ApplyReturnDeclinedNotice({
  variant,
  onUndo,
  busy,
  error
}: {
  variant: Variant;
  onUndo: () => void;
  busy: boolean;
  error: string | null;
}) {
  const style = STYLES[variant];
  return (
    <div role="status" className={variant === "kit" ? "space-y-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700" : "job-card job-apply-return"} data-apply-return-declined>
      <p className={variant === "kit" ? undefined : style.copy}>
        You said you are not applying for this job, so it is archived and out of your active applications.
      </p>
      {error ? <p role="alert" className={style.error} data-apply-return-error>{error}</p> : null}
      <button type="button" onClick={onUndo} disabled={busy} className={style.secondary} data-apply-return-undo>
        {busy ? <Loader2 className="mr-2 animate-spin" size={15} aria-hidden="true" /> : <Undo2 className="mr-2" size={15} aria-hidden="true" />}
        Undo
      </button>
    </div>
  );
}
