"use client";

import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Sparkles } from "lucide-react";

import { useInPageConfirm } from "@/components/ui/in-page-confirm";
import { fetchWithApprovedAiCost } from "@/lib/ai/browser-request";
import { SENT_TO_GEMINI } from "@/lib/apply-page/ai-data-copy";
import { formatCentsCeiling, formatUsdMicros, type DocumentCreationQuote } from "@/lib/jobs/document-creation-plan";
import type { EvidenceCorrectionReview, EvidenceReviewGap } from "@/lib/jobs/evidence-correction-review";
import { evidenceSnapshotSaveResponseSchema } from "@/lib/jobs/evidence-snapshot-contracts";
import {
  clearExperienceDrafts,
  readExperienceDrafts,
  writeExperienceDrafts,
  type ExperienceDraft,
  type ExperienceDrafts
} from "@/lib/jobs/experience-drafts";
import {
  OWNER_FACT_MAX_CHARACTERS,
  ownerFactProblems,
  ownerFactShapeProblems,
  type OwnerFactProblem
} from "@/lib/jobs/owner-fact-cleanup";
import {
  EMPTY_GAP_DRAFT,
  EMPTY_SAVED_LINE_DRAFT,
  buildEvidenceSaveBody,
  resumeLines,
  type GapDraft,
  type SavedLineAction,
  type SavedLineDraft
} from "@/lib/jobs/tailor-decisions";

// Step 2 of the Apply page: one box per requirement (blank = skip), drafts kept in this browser
// as you type, problems shown as you type, one truth tick, and "Update my score", which only
// saves the lines and re-scores. Nothing reaches the server before Update.

export type ExperienceStepProps = {
  jobId: string;
  // Needs a master résumé; the page says so itself when there is none.
  review: EvidenceCorrectionReview;
  hasValidCurrentSnapshot: boolean;
  // The shown estimate was scored on the saved review (basis REVIEWED_EVIDENCE), which is what
  // Prepare requires. Then, with nothing changed, this step is done.
  matchBoundToReview: boolean;
  quote: DocumentCreationQuote | null;
  draftKey: string;
  // A real AI provider is configured. Without one the re-score can't run (JOB_MATCH refuses
  // local mode), so Update stays off.
  generationAvailable: boolean;
  // Unsaved lines or changes: the documents in step 3 don't include them yet.
  onPendingChanges?: (pending: boolean) => void;
};

const PLACEHOLDER = "If you have this, say what you did.";
const TRUTH = "Everything I wrote above is true.";
const STALE = "This job's review changed in another tab. Reload to continue; your lines are kept on this computer.";
const STALE_NOT_KEPT = "This job's review changed in another tab. Copy your lines, then reload to continue; this browser can't keep them.";
const STALE_CODES = new Set(["EVIDENCE_SOURCE_STALE", "EVIDENCE_ANALYSIS_STALE"]);

type Item = { key: string; gap: EvidenceReviewGap };
type Mode = "write" | "resume";
type Message = { tone: "success" | "error" | "info"; text: string };
type Phase = "asking" | "saving" | "scoring";
type ErrorPayload = { error?: unknown; code?: unknown; billingStatus?: unknown; actualCostMicros?: unknown } | null;

// Drafts are matched to requirements by their text, so they survive a re-score that renumbers them.
function requirementKey(text: string) {
  return text.trim().replace(/\s+/gu, " ");
}

function hasContent(draft: ExperienceDraft | undefined) {
  return Boolean(draft && (draft.line.trim() || draft.resumeLine));
}

function browserStorage(): Storage | null {
  try {
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

// The stored shape isn't validated on read: keep only well-formed entries.
function loadDrafts(key: string): { drafts: ExperienceDrafts; available: boolean } {
  const { drafts, available } = readExperienceDrafts(key, browserStorage());
  const valid: ExperienceDrafts = {};
  for (const [text, value] of Object.entries(drafts ?? {})) {
    const candidate = value as Partial<ExperienceDraft> | null;
    if (candidate && typeof candidate.line === "string" && typeof candidate.resumeLine === "string") {
      valid[text] = { line: candidate.line, resumeLine: candidate.resumeLine };
    }
  }
  return { drafts: valid, available };
}

const subscribeNever = () => () => {};

// False on the server and while hydrating, so the first client render matches the server's.
function useHydrated() {
  return useSyncExternalStore(subscribeNever, () => true, () => false);
}

function cleanupMessage(problem: OwnerFactProblem) {
  switch (problem.kind) {
    case "placeholder":
      return `Replace the placeholder “${problem.excerpt}” with what you actually did.`;
    case "note_to_you":
      return `“${problem.excerpt}” reads like a note to you. Write only what you did.`;
    case "instruction":
      return `“${problem.excerpt}” is an instruction, not something you did.`;
    case "stray_quote":
      return `Remove the quotation mark with no match: “${problem.excerpt}”.`;
    case "wrapped_in_quotes":
      return "Remove the quotation marks around the whole line.";
  }
}

function lineProblems(line: string): string[] {
  if (!line.trim()) return [];
  return [
    ...ownerFactProblems(line).map(cleanupMessage),
    ...ownerFactShapeProblems(line).map(() => `Keep it to ${OWNER_FACT_MAX_CHARACTERS} characters.`)
  ];
}

function errorText(json: ErrorPayload, fallback: string) {
  const parts = [typeof json?.error === "string" ? json.error : fallback];
  if (json?.billingStatus === "not_charged") parts.push("You weren't charged for this step.");
  if (json?.billingStatus === "uncertain") parts.push("The charge for this step is uncertain; check AI usage before trying again.");
  if (json?.billingStatus === "known" && typeof json.actualCostMicros === "number" && json.actualCostMicros >= 0) {
    parts.push(`Recorded cost: ${formatUsdMicros(json.actualCostMicros)}.`);
  }
  return parts.join(" ");
}

// The counter and any problems under a box; the box points at both with aria-describedby.
function LineHints({ id, line, problems }: { id: string; line: string; problems: string[] }) {
  return (
    <div id={id}>
      <p className="job-hint" data-counter>{line.trim().length}/{OWNER_FACT_MAX_CHARACTERS}</p>
      {problems.map((problem) => <p key={problem} className="job-hint job-problem" data-problem>{problem}</p>)}
    </div>
  );
}

export function ExperienceStep({
  jobId,
  review,
  hasValidCurrentSnapshot,
  matchBoundToReview,
  quote,
  draftKey,
  generationAvailable,
  onPendingChanges
}: ExperienceStepProps) {
  const router = useRouter();
  const { confirm, confirmFn, dialog } = useInPageConfirm();
  const hydrated = useHydrated();
  const idPrefix = useId();
  const reviewable = Boolean(review.analysisId);

  const items = useMemo(() => {
    const seen = new Set<string>();
    const list: Item[] = [];
    for (const gap of [...review.gaps, ...review.uncheckedRequirements]) {
      const key = requirementKey(gap.requirement);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      list.push({ key, gap });
    }
    return list;
  }, [review.gaps, review.uncheckedRequirements]);
  const lines = useMemo(() => resumeLines(review), [review]);

  // What this browser kept, read once the page is live. Edits replace it from then on.
  const stored = useMemo(() => (hydrated ? loadDrafts(draftKey) : { drafts: {}, available: true }), [hydrated, draftKey]);
  const [edited, setEdited] = useState<ExperienceDrafts | null>(null);
  const [writeFailed, setWriteFailed] = useState(false);
  const [removedEarlier, setRemovedEarlier] = useState(0);
  const allDrafts = edited ?? stored.drafts;
  // A draft whose requirement is no longer listed is dropped (only once a match lists them).
  const { drafts, removedNow } = useMemo(() => {
    if (!reviewable) return { drafts: allDrafts, removedNow: 0 };
    const known = new Set(items.map((item) => item.key));
    const kept: ExperienceDrafts = {};
    let removed = 0;
    for (const [text, draft] of Object.entries(allDrafts)) {
      if (known.has(text)) kept[text] = draft;
      else if (hasContent(draft)) removed += 1;
    }
    return { drafts: kept, removedNow: removed };
  }, [allDrafts, items, reviewable]);
  const removedCount = removedEarlier + removedNow;
  const storageAvailable = stored.available && !writeFailed;

  const [modes, setModes] = useState<Record<string, Mode>>({});
  const [savedLines, setSavedLines] = useState<Record<string, SavedLineDraft>>({});
  const [attested, setAttested] = useState(false);
  const [phase, setPhase] = useState<Phase | null>(null);
  const [message, setMessage] = useState<Message | null>(null);
  const busy = useRef(false);
  // Kept across retries of the same answers, so a repeated save replays instead of duplicating.
  const saveRequest = useRef<{ id: string; signature: string } | null>(null);

  const modeOf = (key: string): Mode => modes[key] ?? (drafts[key]?.resumeLine ? "resume" : "write");
  const savedLine = (factId: string) => savedLines[factId] ?? EMPTY_SAVED_LINE_DRAFT;

  const entries = items.map((item) => {
    const draft = drafts[item.key] ?? { line: "", resumeLine: "" };
    const mode = modeOf(item.key);
    const chosen = lines.includes(draft.resumeLine) ? draft.resumeLine : "";
    const gapDraft: GapDraft = mode === "resume"
      ? (chosen ? { choice: "onResume", line: "", attested: false, resumeLine: chosen } : EMPTY_GAP_DRAFT)
      : (draft.line.trim() ? { choice: "add", line: draft.line, attested, resumeLine: "" } : EMPTY_GAP_DRAFT);
    return { item, draft, mode, chosen, gapDraft, problems: mode === "write" ? lineProblems(draft.line) : [] };
  });
  const factEntries = review.acceptedFacts.map((fact) => {
    const draft = savedLine(fact.factId);
    const replacing = draft.action === "REPLACE_OWNER_ATTESTATION";
    const problems = replacing ? (draft.line.trim() ? lineProblems(draft.line) : ["Write the new line, or choose Keep."]) : [];
    return { fact, draft, replacing, problems };
  });

  const pending = entries.some((entry) => entry.gapDraft.choice !== "skip") ||
    factEntries.some((entry) => entry.draft.action !== "RETAIN");
  const needsTick = entries.some((entry) => entry.gapDraft.choice === "add") || factEntries.some((entry) => entry.replacing);
  const done = matchBoundToReview && !pending;
  // With no analysis to review, a saved review only needs the re-score (for example after
  // "Nothing to add" saved it and the re-score failed or was cancelled).
  const rescoreOnly = !reviewable && hasValidCurrentSnapshot;
  const savesReview = reviewable && (pending || !hasValidCurrentSnapshot);
  const running = phase !== null;

  const firstProblem = entries.find((entry) => entry.problems.length)?.item.gap.requirement ??
    factEntries.find((entry) => entry.problems.length)?.fact.fact ?? null;
  const blockedReason = !generationAvailable
    ? "Scoring is switched off on this server (no AI provider is configured)."
    : firstProblem !== null
      ? `Fix the line for "${firstProblem}" first.`
      : needsTick && !attested
        ? `Tick "${TRUTH}" first.`
        : null;
  const updateLabel = quote ? `Update my score · about ${formatCentsCeiling(quote.jobMatchMicros)}` : "Update my score";
  const label = pending || rescoreOnly ? updateLabel : "Nothing to add · update my score";

  useEffect(() => {
    onPendingChanges?.(pending);
  }, [onPendingChanges, pending]);

  // Forget dropped drafts in this browser too (the notice above says so).
  useEffect(() => {
    if (removedNow > 0) writeExperienceDrafts(draftKey, drafts, browserStorage());
  }, [draftKey, drafts, removedNow]);

  function changed() {
    setMessage(null);
  }

  function updateDraft(key: string, patch: Partial<ExperienceDraft>) {
    changed();
    const next: ExperienceDrafts = { ...drafts };
    const value = { ...(drafts[key] ?? { line: "", resumeLine: "" }), ...patch };
    if (value.line || value.resumeLine) next[key] = value;
    else delete next[key];
    if (removedNow) setRemovedEarlier((count) => count + removedNow);
    setEdited(next);
    setWriteFailed(!writeExperienceDrafts(draftKey, next, browserStorage()));
  }

  function setMode(key: string, mode: Mode) {
    setModes((current) => ({ ...current, [key]: mode }));
    if (mode === "write") updateDraft(key, { resumeLine: "" });
    else changed();
  }

  function updateSavedLine(factId: string, patch: Partial<SavedLineDraft>) {
    changed();
    setSavedLines((current) => ({ ...current, [factId]: { ...(current[factId] ?? EMPTY_SAVED_LINE_DRAFT), ...patch } }));
  }

  // Saved to the account: drop the drafts that went into the save. A line typed before switching
  // to the résumé picker (and so not sent) stays.
  function forgetSavedDrafts(sentKeys: ReadonlySet<string>) {
    const remaining = Object.fromEntries(Object.entries(drafts).filter(([key]) => !sentKeys.has(key)));
    if (Object.keys(remaining).length) setWriteFailed(!writeExperienceDrafts(draftKey, remaining, browserStorage()));
    else clearExperienceDrafts(draftKey, browserStorage());
    setEdited(remaining);
    setRemovedEarlier(0);
    setModes({});
    setSavedLines({});
    setAttested(false);
  }

  function saveBody() {
    const gapDrafts = Object.fromEntries(entries.map((entry) => [entry.item.gap.id, entry.gapDraft]));
    const lineDrafts = Object.fromEntries(factEntries.map((entry) => [entry.fact.factId, { ...entry.draft, attested }]));
    const body = buildEvidenceSaveBody(review, gapDrafts, lineDrafts, "");
    const signature = JSON.stringify(body);
    if (saveRequest.current?.signature !== signature) saveRequest.current = { id: crypto.randomUUID(), signature };
    return { ...body, requestId: saveRequest.current.id };
  }

  async function update() {
    if (busy.current || blockedReason || done || !(reviewable || rescoreOnly)) return;
    busy.current = true;
    setPhase("asking");
    setMessage(null);
    const stale = storageAvailable ? STALE : STALE_NOT_KEPT;
    const sentKeys = new Set(entries.filter((entry) => entry.gapDraft.choice !== "skip").map((entry) => entry.item.key));
    let saved = false;
    try {
      const approved = await confirm({
        title: "Update my score?",
        body: [
          pending ? "Apply Pilot saves your lines for this job first." : null,
          `Sends ${SENT_TO_GEMINI} to Google Gemini to update your score.`,
          quote
            ? `This could cost up to ${formatUsdMicros(quote.jobMatchMicros)}; the final charge is usually lower.`
            : "Its cost is shown before anything is charged.",
          "There is no automatic retry; an uncertain provider outcome may still be billed."
        ].filter(Boolean).join(" ")
      });
      if (!approved) {
        setMessage({ tone: "info", text: "Canceled. Nothing was sent and nothing was charged." });
        return;
      }
      if (savesReview) {
        setPhase("saving");
        const response = await fetch(`/api/jobs/${jobId}/evidence-snapshots`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(saveBody())
        });
        const json = (await response.json().catch(() => null)) as ErrorPayload;
        if (!response.ok) {
          if (response.status === 409 && typeof json?.code === "string" && STALE_CODES.has(json.code)) {
            setMessage({ tone: "error", text: stale });
            return;
          }
          // A request ID already used for other answers can't be reused.
          if (response.status === 409) saveRequest.current = null;
          setMessage({ tone: "error", text: errorText(json, "Your lines couldn't be saved. Nothing was charged.") });
          return;
        }
        const result = evidenceSnapshotSaveResponseSchema.safeParse(json);
        if (!result.success) {
          setMessage({ tone: "error", text: "Apply Pilot couldn't confirm your lines were saved. Reload the page to check." });
          return;
        }
        if (!result.data.snapshot.isCurrent) {
          setMessage({ tone: "error", text: stale });
          return;
        }
        saved = true;
        saveRequest.current = null;
        forgetSavedDrafts(sentKeys);
      }
      setPhase("scoring");
      const response = await fetchWithApprovedAiCost(`/api/jobs/${jobId}/match`, { method: "POST" }, quote?.jobMatchMicros ?? 0, { confirm: confirmFn });
      if (!response.ok) {
        const json = (await response.json().catch(() => null)) as ErrorPayload;
        throw new Error(errorText(json, "Apply Pilot couldn't update your score."));
      }
      setMessage({ tone: "success", text: saved && pending ? "Your lines were saved and your score was updated." : "Your score was updated." });
      router.refresh();
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Something went wrong.";
      setMessage({ tone: "error", text: saved && pending ? `Your lines were saved, but your score wasn't updated. ${reason}` : reason });
      if (saved) router.refresh();
    } finally {
      busy.current = false;
      setPhase(null);
    }
  }

  const outcome = message ? (
    <p role={message.tone === "error" ? "alert" : "status"} className={`job-message job-message-${message.tone}`} data-experience-message>{message.text}</p>
  ) : null;

  // No match to answer against: never scored, or the last save invalidated it (for example when
  // the re-score after a save failed or was cancelled, and the page refreshed). Lines already saved
  // are shown, and with a saved review this step re-scores it itself, so the user is never stuck.
  if (!reviewable) {
    const savedFacts = review.acceptedFacts;
    return (
      <div className="job-tailor" data-experience-step>
        <p className="job-note">
          {!rescoreOnly
            ? "Check your match in step 1 first, so Apply Pilot can see what this job asks for."
            : savedFacts.length
              ? "Your lines are saved. Update my score to use them."
              : "Your review is saved. Update my score to continue."}
        </p>
        {rescoreOnly && savedFacts.length ? (
          <ul className="job-plain-list" data-saved-lines-summary>{savedFacts.map((fact) => <li key={fact.factId}>{fact.fact}</li>)}</ul>
        ) : null}
        {rescoreOnly ? (
          <>
            <div className="job-create-row">
              <button type="button" className="job-button job-button-primary job-button-large" onClick={update} disabled={Boolean(blockedReason) || running}>
                {running ? <Loader2 className="animate-spin" size={18} aria-hidden="true" /> : <Sparkles size={18} aria-hidden="true" />}
                {label}
              </button>
            </div>
            {blockedReason ? <p className="job-hint" data-blocked-reason>{blockedReason}</p> : null}
            {dialog}
            {phase === "scoring" ? <p role="status" className="job-hint">Updating your score…</p> : null}
          </>
        ) : null}
        {outcome}
      </div>
    );
  }

  return (
    <div className="job-tailor" data-experience-step>
      {removedCount ? (
        <p role="status" className="job-message job-message-info" data-drafts-removed>
          {removedCount === 1
            ? "1 line no longer matches this job's requirements and was removed."
            : `${removedCount} lines no longer match this job's requirements and were removed.`}
        </p>
      ) : null}

      <fieldset disabled={running} className="job-gap-list">
        {entries.length ? (
          <p className="job-step-copy" data-experience-intro>
            Apply Pilot couldn&apos;t find these on your résumé, or didn&apos;t check them. Leave a box blank to skip it. Lines are
            used for this job only and never change your master résumé.
          </p>
        ) : (
          <p className="job-note">Apply Pilot didn&apos;t flag any listed requirement as missing from your résumé. It can&apos;t check every requirement (years of experience, for example), so read your match before you apply.</p>
        )}
        {entries.map(({ item, draft, mode, chosen, problems }, index) => (
          <fieldset key={item.key} className="job-gap" data-requirement={item.gap.id}>
            <legend className="job-gap-requirement">{item.gap.requirement}</legend>
            {item.gap.tenureSummary ? <p className="job-hint" data-tenure>{item.gap.tenureSummary}</p> : null}
            {mode === "write" ? (
              <div className="job-gap-detail">
                <div className="job-field">
                  <textarea
                    rows={2}
                    value={draft.line}
                    placeholder={PLACEHOLDER}
                    aria-label={`Your line for: ${item.gap.requirement}`}
                    aria-describedby={`${idPrefix}-requirement-${index}`}
                    onChange={(event) => updateDraft(item.key, { line: event.target.value })}
                  />
                </div>
                <LineHints id={`${idPrefix}-requirement-${index}`} line={draft.line} problems={problems} />
                {lines.length ? (
                  <button type="button" className="job-link-button" onClick={() => setMode(item.key, "resume")}>It&apos;s on my résumé</button>
                ) : null}
              </div>
            ) : (
              <div className="job-gap-detail">
                <label className="job-field">
                  Choose the résumé line that shows it
                  <select value={chosen} onChange={(event) => updateDraft(item.key, { resumeLine: event.target.value })}>
                    <option value="">Choose a line…</option>
                    {lines.map((line) => <option key={line} value={line}>{line}</option>)}
                  </select>
                </label>
                <button type="button" className="job-link-button" onClick={() => setMode(item.key, "write")}>Write my own line instead</button>
              </div>
            )}
            {hasContent(draft) ? (
              <p className="job-hint" data-draft-storage>{storageAvailable ? "Saved on this computer" : "Not kept between visits on this browser"}</p>
            ) : null}
          </fieldset>
        ))}

        {factEntries.length ? (
          <section aria-labelledby="saved-lines-heading" className="job-step">
            <h3 id="saved-lines-heading" className="job-step-title">Lines you&apos;ve added before</h3>
            {factEntries.map(({ fact, draft, replacing, problems }, index) => (
              <fieldset key={fact.factId} className="job-gap" data-saved-line={fact.factId}>
                <legend className="job-gap-requirement">{fact.fact}</legend>
                <div className="job-gap-choices" role="radiogroup" aria-label={`Keep or change: ${fact.fact}`}>
                  {([["RETAIN", "Keep"], ["REMOVE", "Remove"], ["REPLACE_OWNER_ATTESTATION", "Change"]] as Array<[SavedLineAction, string]>).map(([value, text]) => (
                    <label key={value} className="job-choice" data-checked={draft.action === value}>
                      <input type="radio" name={`line-${fact.factId}`} value={value} checked={draft.action === value} onChange={() => updateSavedLine(fact.factId, { action: value })} />
                      {text}
                    </label>
                  ))}
                </div>
                {replacing ? (
                  <div className="job-gap-detail">
                    <label className="job-field">
                      New line
                      <textarea rows={2} value={draft.line} aria-describedby={`${idPrefix}-saved-${index}`} onChange={(event) => updateSavedLine(fact.factId, { line: event.target.value })} />
                    </label>
                    <LineHints id={`${idPrefix}-saved-${index}`} line={draft.line} problems={problems} />
                  </div>
                ) : null}
              </fieldset>
            ))}
          </section>
        ) : null}

        <label className="job-check">
          <input type="checkbox" checked={attested} onChange={(event) => { changed(); setAttested(event.target.checked); }} />
          {TRUTH}
        </label>
      </fieldset>

      {done ? (
        <p role="status" className="job-message job-message-success" data-experience-done>Done</p>
      ) : (
        <div className="job-create-row">
          <button type="button" className="job-button job-button-primary job-button-large" onClick={update} disabled={Boolean(blockedReason) || running}>
            {running ? <Loader2 className="animate-spin" size={18} aria-hidden="true" /> : <Sparkles size={18} aria-hidden="true" />}
            {label}
          </button>
        </div>
      )}
      {blockedReason && !done ? <p className="job-hint" data-blocked-reason>{blockedReason}</p> : null}
      {dialog}
      {phase === "saving" || phase === "scoring" ? (
        <p role="status" className="job-hint">{phase === "saving" ? "Saving your lines…" : "Updating your score…"}</p>
      ) : null}
      {outcome}
    </div>
  );
}
