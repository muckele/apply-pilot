"use client";

import { useRef, useState } from "react";

import { fetchWithAiCostConfirmation } from "@/lib/ai/browser-request";
import {
  normalizeEvidenceCorrectionDecisions,
  type EvidenceCorrectionDecision,
  type EvidenceCorrectionReview as EvidenceCorrectionReviewModel
} from "@/lib/jobs/evidence-correction-review";
import {
  evidenceSnapshotSaveResponseSchema,
  type EvidenceSnapshotSaveResponse
} from "@/lib/jobs/evidence-snapshot-contracts";

type Draft = {
  kind: "UNRESOLVED" | "SOURCE_CORRECTION" | "OWNER_ATTESTATION";
  sourceFactId: string;
  sourceExcerpt: string;
  fact: string;
  ownerAttested: boolean;
};

const emptyDraft: Draft = {
  kind: "UNRESOLVED",
  sourceFactId: "",
  sourceExcerpt: "",
  fact: "",
  ownerAttested: false
};

export function EvidenceCorrectionReview({ review }: { review: EvidenceCorrectionReviewModel }) {
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [result, setResult] = useState<EvidenceSnapshotSaveResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [snapshotInvalidated, setSnapshotInvalidated] = useState(false);
  const [pending, setPending] = useState<"save" | "reassess" | null>(null);
  const [reassessmentSaved, setReassessmentSaved] = useState(false);
  const reviewRevision = useRef(0);
  const requestId = useRef<string | null>(null);
  const draftFor = (gapId: string) => drafts[gapId] ?? emptyDraft;
  const update = (gapId: string, patch: Partial<Draft>) => {
    reviewRevision.current += 1;
    requestId.current = null;
    setDrafts((current) => ({ ...current, [gapId]: { ...(current[gapId] ?? emptyDraft), ...patch } }));
    setError(null);
    setReassessmentSaved(false);
    if (result) {
      setResult(null);
      setSnapshotInvalidated(true);
    }
  };

  async function saveSnapshot() {
    const startedRevision = reviewRevision.current;
    setError(null);
    setPending("save");
    try {
      const decisions: EvidenceCorrectionDecision[] = review.gaps.map((gap) => {
        const draft = draftFor(gap.id);
        const reuse = {
          reuseScope: "JOB_ONLY" as const,
          masterProfileOptIn: false as const
        };
        if (draft.kind === "SOURCE_CORRECTION") return {
          gapId: gap.id,
          kind: draft.kind,
          sourceFactId: draft.sourceFactId,
          sourceExcerpt: draft.sourceExcerpt,
          correctedFact: draft.fact,
          ...reuse
        };
        if (draft.kind === "OWNER_ATTESTATION") return {
          gapId: gap.id,
          kind: draft.kind,
          attestedFact: draft.fact,
          ownerAttested: draft.ownerAttested,
          ...reuse
        };
        return { gapId: gap.id, kind: "UNRESOLVED", ...reuse };
      });
      normalizeEvidenceCorrectionDecisions(review, decisions);
      if (
        !review.analysisId || !review.analysisInputHash ||
        !review.analysisModel || !review.analysisPromptVersion
      ) {
        throw new Error("Run a current fit assessment before saving reviewed evidence.");
      }
      requestId.current ??= crypto.randomUUID();
      const response = await fetch(`/api/jobs/${review.jobId}/evidence-snapshots`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          schema: "apply-pilot/evidence-snapshot-save/v1",
          requestId: requestId.current,
          resumeId: review.resumeId,
          resumeUpdatedAt: review.resumeUpdatedAt,
          reviewedAnalysis: {
            id: review.analysisId,
            inputHash: review.analysisInputHash,
            model: review.analysisModel,
            promptVersion: review.analysisPromptVersion
          },
          decisions
        })
      });
      const json: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const message = json && typeof json === "object" && typeof Reflect.get(json, "error") === "string"
          ? String(Reflect.get(json, "error"))
          : "The reviewed evidence could not be saved.";
        throw new Error(message);
      }
      const saved = evidenceSnapshotSaveResponseSchema.parse(json);
      if (startedRevision !== reviewRevision.current) {
        setResult(null);
        setSnapshotInvalidated(true);
        return;
      }
      setResult(saved);
      setSnapshotInvalidated(false);
    } catch (cause) {
      if (startedRevision !== reviewRevision.current) {
        setResult(null);
        setSnapshotInvalidated(true);
        return;
      }
      setError(cause instanceof Error ? cause.message : "The reviewed evidence could not be saved.");
    } finally {
      setPending(null);
    }
  }

  async function reassess() {
    if (!result?.snapshot.isCurrent) return;
    const startedRevision = reviewRevision.current;
    const startedSnapshotId = result.snapshot.id;
    setPending("reassess");
    setError(null);
    try {
      const response = await fetchWithAiCostConfirmation(`/api/jobs/${review.jobId}/match`, { method: "POST" });
      const json = await response.json().catch(() => null) as { error?: string } | null;
      if (!response.ok) throw new Error(json?.error ?? "The reassessment could not be completed.");
      if (
        startedRevision !== reviewRevision.current ||
        result.snapshot.id !== startedSnapshotId
      ) return;
      setReassessmentSaved(true);
    } catch (cause) {
      if (startedRevision !== reviewRevision.current) return;
      setError(cause instanceof Error ? cause.message : "The reassessment could not be completed.");
    } finally {
      setPending(null);
    }
  }

  return (
    <section className="space-y-5 p-5" aria-labelledby="evidence-correction-heading">
      <div>
        <p className="text-xs font-semibold uppercase text-amber-700">Correction-first · durable review</p>
        <h3 id="evidence-correction-heading" className="mt-1 text-base font-semibold text-slate-950">
          Review extracted evidence before rewriting
        </h3>
        <p className="mt-2 text-sm leading-6 text-slate-700">
          Saving creates an immutable reviewed-evidence snapshot. The prior fit assessment and documents become stale until they are regenerated from that snapshot.
        </p>
        <p className="mt-1 text-xs leading-5 text-slate-600">
          Reviewed facts are saved for this job only. The master resume is not rewritten, and owner-attested facts remain distinct from submitted-resume evidence.
        </p>
      </div>

      <details className="rounded-lg border border-slate-200 bg-slate-50 p-3">
        <summary className="cursor-pointer text-sm font-semibold text-slate-900">
          Actual extracted facts ({review.facts.length})
        </summary>
        <div className="mt-3 space-y-3">
          {review.facts.map((fact) => (
            <article key={fact.id} className="rounded-md border border-slate-200 bg-white p-3">
              <p className="text-xs font-semibold uppercase text-slate-500">{fact.label} · {fact.ref}</p>
              <p className="mt-1 whitespace-pre-wrap text-sm leading-6 text-slate-700">{fact.value}</p>
            </article>
          ))}
        </div>
      </details>

      <div className="space-y-4">
        <div>
          <h4 className="text-sm font-semibold text-slate-950">Uncertain or disputed gaps</h4>
          <p className="mt-1 text-xs leading-5 text-slate-600">Not evidenced is not proof that the applicant lacks the capability.</p>
        </div>
        {review.gaps.length ? review.gaps.map((gap) => {
          const draft = draftFor(gap.id);
          return (
            <fieldset key={gap.id} className="space-y-3 rounded-lg border border-amber-200 bg-amber-50 p-4">
              <legend className="px-1 text-sm font-semibold text-amber-950">{gap.requirement}</legend>
              <label className="block text-xs font-semibold text-slate-700">
                Review outcome
                <select
                  className="mt-1 w-full rounded-md border border-slate-300 bg-white p-2 text-sm"
                  value={draft.kind}
                  onChange={(event) => update(gap.id, { kind: event.target.value as Draft["kind"] })}
                >
                  <option value="UNRESOLVED">Keep unresolved</option>
                  <option value="SOURCE_CORRECTION">Existing-source correction</option>
                  <option value="OWNER_ATTESTATION">Owner-attested addition</option>
                </select>
              </label>
              {draft.kind === "SOURCE_CORRECTION" ? (
                <>
                  <label className="block text-xs font-semibold text-slate-700">
                    Extracted source
                    <select
                      className="mt-1 w-full rounded-md border border-slate-300 bg-white p-2 text-sm"
                      value={draft.sourceFactId}
                      onChange={(event) => update(gap.id, { sourceFactId: event.target.value })}
                    >
                      <option value="">Choose exact source…</option>
                      {review.facts.filter((fact) => fact.sourceAuthoritative).map((fact) => (
                        <option key={fact.id} value={fact.id}>{fact.label} · {fact.ref}</option>
                      ))}
                    </select>
                  </label>
                  <label className="block text-xs font-semibold text-slate-700">
                    Exact source excerpt
                    <textarea className="mt-1 w-full rounded-md border border-slate-300 bg-white p-2 text-sm" value={draft.sourceExcerpt} onChange={(event) => update(gap.id, { sourceExcerpt: event.target.value })} />
                  </label>
                </>
              ) : null}
              {draft.kind !== "UNRESOLVED" ? (
                <label className="block text-xs font-semibold text-slate-700">
                  {draft.kind === "SOURCE_CORRECTION"
                    ? "Confirmed source fact (must match the excerpt exactly)"
                    : "Owner-attested fact"}
                  <textarea className="mt-1 w-full rounded-md border border-slate-300 bg-white p-2 text-sm" value={draft.fact} onChange={(event) => update(gap.id, { fact: event.target.value })} />
                </label>
              ) : null}
              {draft.kind === "OWNER_ATTESTATION" ? (
                <label className="flex items-start gap-2 text-xs leading-5 text-slate-700">
                  <input type="checkbox" checked={draft.ownerAttested} onChange={(event) => update(gap.id, { ownerAttested: event.target.checked })} />
                  I attest that this fact is accurate even though it is not present in the current resume source.
                </label>
              ) : null}
            </fieldset>
          );
        }) : <p className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-600">No current disputed gaps were recorded.</p>}
      </div>

      <button type="button" onClick={saveSnapshot} disabled={Boolean(pending)} className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60">
        {pending === "save" ? "Saving…" : "Save reviewed evidence"}
      </button>
      {error ? <p role="alert" className="text-sm text-rose-700">{error}</p> : null}
      {snapshotInvalidated ? (
        <p role="status" className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">
          Review changed. Save a new reviewed snapshot before relying on this evidence review.
        </p>
      ) : null}
      {result ? (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">
          <p className="font-semibold">Saved reviewed snapshot {result.snapshot.hash}</p>
          {result.replayed ? (
            <p className="mt-1">This request was already committed. No new invalidation count was calculated for the replay.</p>
          ) : (
            <p className="mt-1">{result.invalidations.totalCount} prior assessment/document binding(s) are stale.</p>
          )}
          {result.snapshot.isCurrent ? (
            <button type="button" onClick={reassess} disabled={Boolean(pending)} className="mt-3 rounded-lg border border-amber-300 bg-white px-3 py-2 text-sm font-semibold text-amber-950 disabled:opacity-60">
              {pending === "reassess" ? "Reassessing…" : "Reassess fit with saved evidence"}
            </button>
          ) : <p className="mt-2">This idempotent replay is historical and did not change the current snapshot.</p>}
          {reassessmentSaved ? <p role="status" className="mt-2 font-semibold">Reassessment saved with the reviewed evidence. Refresh the page to view the updated score.</p> : null}
        </div>
      ) : null}
    </section>
  );
}
