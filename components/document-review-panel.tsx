"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

import type { ClaimTokenKind, DocumentReadinessState, DocumentReviewView } from "@/lib/documents/document-review";

const claimKindLabels: Record<ClaimTokenKind, string> = {
  NUMBER: "number or metric",
  DATE: "date",
  CREDENTIAL: "degree or credential",
  NAME: "name, title or employer"
};

const confirmedAtFormat = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });

export function formatReviewTimestamp(iso: string) {
  return `${confirmedAtFormat.format(new Date(iso))} UTC`;
}

export function documentReviewStatus(state: DocumentReadinessState): string | null {
  switch (state) {
    case "EVIDENCE_STALE":
      return "Older reviewed evidence — regenerate before export.";
    case "EDITED_NEEDS_REVIEW":
      return "Your edits changed factual details. Confirm each flagged detail below before export.";
    case "LEGACY_REVIEW_REQUIRED":
      return "This document was created before fact citations. Review the whole document, then confirm it to export.";
    case "REVIEW_OUTDATED":
      return "This document changed after its review. Save it again to refresh the review.";
    case "EDITED_READY":
      return "Includes your edits. Export uses the saved text exactly; edit markers are never printed.";
    default:
      return null;
  }
}

// D031 review step: the owner confirms each flagged factual edit, or a legacy document as a whole.
// Confirmations are recorded server-side with a timestamp for the exact saved bytes (contentHash).
export function DocumentReviewPanel({ kind, documentId, review, disabled = false }: {
  kind: "resume" | "cover";
  documentId: string;
  review: DocumentReviewView;
  disabled?: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const endpoint = `/api/${kind === "resume" ? "resume-versions" : "generated-documents"}/${documentId}/review`;
  const userEdits = review.segments.filter((segment) => segment.origin === "USER_EDIT").length;
  const legacy = review.state === "LEGACY_REVIEW_REQUIRED" || review.state === "LEGACY_CONFIRMED";
  // Confirming cannot make stale or outdated text exportable, so it waits for regenerate or save.
  const confirmable = review.state === "EDITED_NEEDS_REVIEW" || review.state === "EDITED_READY";

  async function confirm(body: Record<string, string>, key: string) {
    if (busy || disabled) return;
    setBusy(key);
    setMessage(null);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...body, contentHash: review.contentHash })
      });
      if (!response.ok) {
        const json = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(json?.error ?? "Could not record your confirmation.");
      }
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not record your confirmation.");
    } finally {
      setBusy(null);
    }
  }

  if (!review.flags.length && !legacy && !userEdits) return null;
  return <section className="my-3 space-y-2" data-document-review aria-label="Review your edits">
    {userEdits ? <p className="text-sm product-review-metadata">{userEdits === 1 ? "1 line is" : `${userEdits} lines are`} your edit. AI-written lines keep their citations to your master résumé.</p> : null}
    {review.flags.length ? <ul className="space-y-2">{review.flags.map((flag) => <li key={flag.id} data-review-flag={flag.id} className="application-review-panel">
      <p>{flag.text}</p>
      <p className="text-sm product-review-metadata">Not found in the cited source facts: {flag.claims.map((claim, index) => <span key={claim.token}>{index ? ", " : ""}<strong>{claim.text}</strong> ({claimKindLabels[claim.kind]})</span>)}</p>
      {flag.confirmedAt
        ? <p className="text-sm product-review-metadata">Confirmed {formatReviewTimestamp(flag.confirmedAt)}</p>
        : <button type="button" disabled={disabled || busy !== null || !confirmable} onClick={() => confirm({ action: "CONFIRM_FLAG", flagId: flag.id }, flag.id)}>{busy === flag.id ? "Recording…" : "I confirm this is accurate"}</button>}
    </li>)}</ul> : null}
    {review.state === "LEGACY_REVIEW_REQUIRED" ? <div className="application-review-panel" data-legacy-review>
      <p className="text-sm">Read every line above. This confirms the whole document as your own content; no fact citations are added.</p>
      <button type="button" disabled={disabled || busy !== null} onClick={() => confirm({ action: "CONFIRM_LEGACY_DOCUMENT" }, "legacy")}>{busy === "legacy" ? "Recording…" : "I confirm this is accurate"}</button>
    </div> : null}
    {review.state === "LEGACY_CONFIRMED" && review.legacyConfirmedAt ? <p className="text-sm product-review-metadata">You confirmed this document {formatReviewTimestamp(review.legacyConfirmedAt)}.</p> : null}
    {message ? <p role="status">{message}</p> : null}
  </section>;
}
