"use client";

import { useState, type ReactNode } from "react";

import { PrimaryButton, SecondaryButton } from "@/components/ui";
import {
  deriveManualFieldPresentations,
  missingDetailHint,
  presentProposal,
  REVIEW_REASON_LABELS,
  type AnswerPacket,
  type AnswerPacketAnswer,
  type CommandNotice,
  type ManualFieldPresentation,
  type ReviewRunAuthority
} from "@/lib/application-browser/control-presentation";
import type { FillStatusPresentation } from "@/lib/application-browser/fill-status-presentation";
import {
  answerSourceLabel,
  approveButtonLabel,
  ASSISTED_APPLY_STEP_NAMES,
  ASSISTED_APPLY_STEP_NUMBERS,
  stepHeading,
  type ControlActionState,
  type ControlStepAction,
  type ControlStepNumber,
  type ControlStepsView,
  type StepProgress
} from "@/lib/assisted-apply/control-steps";
import {
  dispositionLabel,
  dispositionReasonLabel,
  fieldTypeLabel,
  manualCategoryLabel
} from "@/lib/assisted-apply/plain-language";

// Presentational pieces of the control page (redesign UX-4). They hold no authority: every
// handler and every enabled/disabled decision comes from ApplicationBrowserControl.

export function noticeClass(tone: CommandNotice["tone"]): string {
  if (tone === "SUCCESS") return "bg-emerald-50 text-emerald-800";
  if (tone === "WARNING") return "bg-amber-50 text-amber-900";
  if (tone === "ERROR") return "bg-rose-50 text-rose-800";
  return "bg-sky-50 text-sky-800";
}

export function displayDate(value: string | null): string {
  return value === null ? "Not acknowledged" : new Date(value).toLocaleString();
}

export function Notice({ notice }: { notice: CommandNotice | null }) {
  if (notice === null) return null;
  return <p
    aria-live="polite"
    role={notice.tone === "ERROR" ? "alert" : undefined}
    className={`rounded-lg px-3 py-2 text-sm ${noticeClass(notice.tone)}`}
  >{notice.text}</p>;
}

// One step button. It is the page's single primary action when `primary` is true; anywhere
// else it is a plain secondary button. A disabled button always says why, in one line.
export function StepActionButton({
  action,
  state,
  primary,
  onClick,
  describedBy,
  label
}: {
  action: ControlStepAction;
  state: ControlActionState;
  primary: boolean;
  onClick: () => void;
  describedBy?: string;
  label?: string;
}) {
  const reasonId = `${action.toLowerCase().replace(/_/g, "-")}-reason`;
  const described = [describedBy, state.enabled ? null : reasonId].filter(Boolean).join(" ") || undefined;
  const Button = primary ? PrimaryButton : SecondaryButton;
  return <div className="space-y-1">
    <Button
      type="button"
      data-primary-action={primary ? action : undefined}
      data-step-action={action}
      aria-describedby={described}
      disabled={!state.enabled}
      onClick={onClick}
    >{label ?? state.label}</Button>
    {!state.enabled && state.reason ? <p
      id={reasonId}
      data-testid="disabled-reason"
      data-reason-for={action}
      className="text-sm text-slate-600"
    >{state.reason}</p> : null}
  </div>;
}

const PROGRESS_MARK: Record<StepProgress, string> = { done: "✓", now: "•", later: "○" };
const PROGRESS_WORD: Record<StepProgress, string> = { done: "done", now: "now", later: "later" };

export function StepList({ progress }: { progress: ControlStepsView["progress"] }) {
  return <ol aria-label="All ten steps" data-testid="step-list" className="flex flex-wrap gap-x-4 gap-y-1 border-t border-slate-200 pt-3 text-xs text-slate-600">
    {ASSISTED_APPLY_STEP_NUMBERS.map((step) => <li
      key={step}
      aria-current={progress[step] === "now" ? "step" : undefined}
      data-progress={progress[step]}
      className={progress[step] === "now" ? "font-semibold text-slate-950" : undefined}
    >
      <span aria-hidden="true">{PROGRESS_MARK[progress[step]]} </span>
      {step} {ASSISTED_APPLY_STEP_NAMES[step]}
      <span className="sr-only"> ({PROGRESS_WORD[progress[step]]})</span>
    </li>)}
  </ol>;
}

// A step of the page. The current step is the "Now" card: heading, one sentence, its body with
// the one primary button, the next line and the list of all steps. Other steps shrink to one
// line; their body stays on the page but is hidden until the user asks to see it.
export function StepSection({
  step,
  view,
  summary,
  children
}: {
  step: ControlStepNumber;
  view: ControlStepsView;
  summary: string;
  children: ReactNode;
}) {
  const progress = view.progress[step];
  const isNow = view.current === step;
  // Opening a done or later step is remembered only while it stays done or later.
  const [expandedWhile, setExpandedWhile] = useState<StepProgress | null>(null);
  const expanded = expandedWhile === progress;
  const bodyId = `step-${step}-body`;
  const headingId = `step-${step}-heading`;
  return <section
    data-step={step}
    data-progress={progress}
    data-testid={isNow ? "now-card" : undefined}
    aria-labelledby={headingId}
    aria-current={isNow ? "step" : undefined}
    className={isNow
      ? "space-y-4 rounded-lg border-2 border-brand-600 bg-white p-4"
      : "space-y-2 rounded-lg border border-slate-200 px-4 py-3"}
  >
    {isNow ? <p className="text-xs font-semibold uppercase tracking-wide text-brand-700">Now</p> : null}
    <div className="flex items-start justify-between gap-3">
      <h2 id={headingId} className={isNow ? "text-lg font-semibold text-slate-950" : "text-sm font-semibold text-slate-700"}>
        {isNow ? view.heading : stepHeading(step)}
      </h2>
      {isNow ? null : <span className="flex items-center gap-2">
        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">{progress === "done" ? "Done" : "Later"}</span>
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={bodyId}
          aria-label={`${expanded ? "Hide" : "Show"} step ${step}: ${ASSISTED_APPLY_STEP_NAMES[step]}`}
          className="text-xs font-semibold text-brand-700 underline"
          onClick={() => setExpandedWhile(expanded ? null : progress)}
        >{expanded ? "Hide" : "Show"}</button>
      </span>}
    </div>
    {isNow
      ? <p data-testid="now-sentence" className="text-sm text-slate-900">{view.sentence}</p>
      : <p className="text-sm text-slate-600">{summary}</p>}
    <div id={bodyId} hidden={!isNow && !expanded} className="space-y-4">{children}</div>
    {isNow ? <>
      <p data-testid="now-next" className="text-sm text-slate-700">{view.next}</p>
      <StepList progress={view.progress} />
    </> : null}
  </section>;
}

// The card shown instead of a step when the application was stopped.
export function StoppedCard({ view }: { view: ControlStepsView }) {
  return <section data-testid="now-card" aria-labelledby="stopped-heading" className="space-y-3 rounded-lg border-2 border-slate-400 bg-white p-4">
    <h2 id="stopped-heading" className="text-lg font-semibold text-slate-950">{view.heading}</h2>
    <p data-testid="now-sentence" className="text-sm text-slate-900">{view.sentence}</p>
    <p data-testid="now-next" className="text-sm text-slate-700">{view.next}</p>
    <StepList progress={view.progress} />
  </section>;
}

export function ManualFieldList({ fields, intro }: { fields: readonly ManualFieldPresentation[]; intro: string }) {
  if (fields.length === 0) return null;
  return <div className="rounded-lg border border-slate-200 p-4">
    <h3 className="font-medium text-slate-950">Manual fields</h3>
    <p className="mt-1 text-sm text-slate-600">{intro}</p>
    <ul className="mt-3 space-y-2 text-sm text-slate-800">
      {fields.map((field, index) => <li key={`${field.question}:${field.fieldType}:${index}`}>
        <span className="font-medium">{field.question || "Unlabeled field"}</span>
        {` — ${fieldTypeLabel(field.fieldType)} — ${field.required ? "Required" : "Optional"} — ${manualCategoryLabel(field.category)}`}
      </li>)}
    </ul>
  </div>;
}

// Step 6 · Open and read the form.
export function OpenFormStepBody({
  view,
  formRead,
  onOpenAndRead,
  onReadForm
}: {
  view: ControlStepsView;
  formRead: boolean;
  onOpenAndRead: () => void;
  onReadForm: () => void;
}) {
  const primary = view.current === 6 ? view.primary : null;
  if (primary?.action === "OPEN_AND_READ") {
    return <StepActionButton action="OPEN_AND_READ" state={view.actions.OPEN_AND_READ} primary onClick={onOpenAndRead} />;
  }
  if (primary?.action === "READ_FORM") {
    return <StepActionButton action="READ_FORM" state={view.actions.READ_FORM} primary onClick={onReadForm} />;
  }
  return <p className="text-sm text-slate-700">{formRead
    ? "Apply Pilot read the employer's form in the other window. If the form changes, use Read the form again under More."
    : "Apply Pilot opens the employer's form in a second window, then reads it. It doesn't type anything."}</p>;
}

function freshnessText(freshness: "absent" | "current" | "stale" | "unverified"): { className: string; text: string } {
  if (freshness === "current") {
    return {
      className: "border-emerald-200 bg-emerald-50 text-emerald-800",
      text: "These answers match the form Apply Pilot just read in this window."
    };
  }
  if (freshness === "stale") {
    return {
      className: "border-amber-300 bg-amber-50 text-amber-950",
      text: "The employer's form changed. Read the form again before relying on these answers."
    };
  }
  if (freshness === "unverified") {
    return {
      className: "border-slate-300 bg-slate-100 text-slate-800",
      text: "These answers haven't been matched to a reading of the form in this window yet."
    };
  }
  return {
    className: "border-slate-200 bg-slate-50 text-slate-700",
    text: "Apply Pilot hasn't proposed any answers for this form yet."
  };
}

function AnswerTechnicalDetails({ answer, proposalLabel }: { answer: AnswerPacketAnswer; proposalLabel: string | null }) {
  return <details data-technical className="mt-3 text-sm">
    <summary className="cursor-pointer text-xs font-semibold text-slate-600">Details (for troubleshooting)</summary>
    <dl className="mt-2 grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
      <div><dt className="text-xs text-slate-500">Field type</dt><dd className="mt-1 font-mono text-xs text-slate-900">{answer.fieldType}</dd></div>
      <div><dt className="text-xs text-slate-500">Question type</dt><dd className="mt-1 font-mono text-xs text-slate-900">{answer.classification}</dd></div>
      <div><dt className="text-xs text-slate-500">Review status</dt><dd className="mt-1 font-mono text-xs text-slate-900">{answer.status}</dd></div>
      <div><dt className="text-xs text-slate-500">Required</dt><dd className="mt-1 text-slate-900">{answer.required ? "Yes" : "No"}</dd></div>
      <div><dt className="text-xs text-slate-500">Requires review</dt><dd className="mt-1 text-slate-900">{answer.requiresReview ? "Yes" : "No"}</dd></div>
      <div><dt className="text-xs text-slate-500">Reviewed by user</dt><dd className="mt-1 text-slate-900">{answer.reviewedByUser ? "Yes" : "No"}</dd></div>
      <div><dt className="text-xs text-slate-500">Reviewed at</dt><dd className="mt-1 text-slate-900">{displayDate(answer.reviewedAt)}</dd></div>
      <div><dt className="text-xs text-slate-500">Sensitive</dt><dd className="mt-1 text-slate-900">{answer.sensitive ? "Yes" : "No"}</dd></div>
      <div><dt className="text-xs text-slate-500">Value redacted</dt><dd className="mt-1 text-slate-900">{answer.valueRedacted ? "Yes" : "No"}</dd></div>
      <div className="sm:col-span-2"><dt className="text-xs text-slate-500">Disposition</dt><dd className="mt-1 text-slate-900">{answer.disposition}</dd></div>
      {answer.dispositionReason ? <div className="sm:col-span-2"><dt className="text-xs text-slate-500">Disposition reason</dt><dd className="mt-1 font-mono text-xs text-slate-900">{answer.dispositionReason}</dd></div> : null}
      {proposalLabel ? <div className="sm:col-span-2"><dt className="text-xs text-slate-500">Proposal</dt><dd className="mt-1 text-slate-900">{proposalLabel}</dd></div> : null}
    </dl>
  </details>;
}

// A field Apply Pilot didn't propose an answer for: what it is, why, and where to add a detail.
function AnswerCard({ answer }: { answer: AnswerPacketAnswer }) {
  const hint = missingDetailHint(answer);
  return <article className="rounded-lg border border-slate-200 p-4">
    <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
      <div>
        <h3 className="font-medium text-slate-950">{answer.question}</h3>
        <p className="mt-1 text-xs text-slate-500">{fieldTypeLabel(answer.fieldType)}{answer.required ? " · required" : ""}</p>
      </div>
      <span className="w-fit rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-700">{dispositionLabel(answer.disposition)}</span>
    </div>
    {answer.dispositionReason ? <p className="mt-2 text-sm text-slate-700">{dispositionReasonLabel(answer.dispositionReason)}</p> : null}
    {hint ? <p className="mt-2 text-sm text-slate-700">{hint.text} {/* A new tab: this tab must stay on the run for the companion's connection. */}
      <a href={hint.href} target="_blank" rel="noopener noreferrer" className="font-medium text-brand-700 underline">Open Your application details</a>
    </p> : null}
    {answer.choices.length > 0 ? <div className="mt-4">
      <h4 className="text-xs font-semibold text-slate-500">Choices on the form</h4>
      <ul className="mt-2 space-y-1 text-sm text-slate-700">{answer.choices.map((choice, index) => <li key={`${choice.key}:${index}`}>{choice.label}{choice.disabled ? " — can't be chosen" : ""}</li>)}</ul>
    </div> : null}
    <AnswerTechnicalDetails answer={answer} proposalLabel={null} />
  </article>;
}

// One proposed answer on the approval screen (W6): tick box, the question, what Apply Pilot will
// type and where the value comes from.
function ApprovalRow({
  answer,
  ticked,
  locked,
  fillsThisKind,
  onToggle
}: {
  answer: AnswerPacketAnswer;
  ticked: boolean;
  locked: boolean;
  fillsThisKind: boolean;
  onToggle: () => void;
}) {
  const proposal = answer.proposal ? presentProposal(answer.proposal, answer.choices, answer) : null;
  const value = proposal?.values.map((entry) => `${entry.text}${entry.annotation ? ` (${entry.annotation})` : ""}`).join(", ") ?? "";
  const decided = answer.status !== "PENDING";
  return <li data-testid="approval-row" data-question={answer.question} className="rounded-lg border border-slate-200 p-3">
    <label className="flex items-start gap-3">
      <input
        type="checkbox"
        data-testid="answer-tick"
        data-question={answer.question}
        className="mt-1"
        checked={ticked}
        disabled={decided || locked}
        onChange={onToggle}
      />
      <span className="grid flex-1 gap-1 text-sm sm:grid-cols-3 sm:gap-3">
        <span className="font-medium text-slate-950">{answer.question}{answer.required ? <span className="font-normal text-slate-500"> · required</span> : null}</span>
        <span className="break-words text-slate-900">{value}</span>
        <span className="text-slate-600">{answerSourceLabel(answer)}</span>
      </span>
    </label>
    {decided ? <p className="mt-2 pl-7 text-xs text-slate-600">{answer.status === "APPROVED" ? "Already approved." : "Already set not to be filled."}</p> : null}
    {!fillsThisKind ? <p className="mt-2 pl-7 text-xs text-slate-600">Apply Pilot doesn&apos;t fill this kind of field ({fieldTypeLabel(answer.fieldType)}), so you&apos;ll choose it yourself.</p> : null}
    <AnswerTechnicalDetails answer={answer} proposalLabel={proposal?.label ?? null} />
  </li>;
}

const NO_IDS: ReadonlySet<string> = new Set();

// Step 7 · Check the answers: one approval screen (D-H, W6).
export function CheckAnswersStepBody({
  view,
  packet,
  run,
  freshness,
  approving,
  isTickLocked,
  onApproveAndContinue
}: {
  view: ControlStepsView;
  packet: AnswerPacket | null;
  run: ReviewRunAuthority | null;
  freshness: "absent" | "current" | "stale" | "unverified";
  approving: boolean;
  isTickLocked: (answer: AnswerPacketAnswer) => boolean;
  onApproveAndContinue: (displayed: AnswerPacket, ticked: ReadonlySet<string>) => void;
}) {
  const isNow = view.current === 7;
  const freshnessCopy = freshnessText(freshness);
  const ambiguous = packet?.summary.ambiguousQuestionCount ?? 0;
  const proposedAnswers = packet?.answers.filter((answer) => answer.disposition === "PROPOSABLE" && answer.proposal !== null) ?? [];
  const otherAnswers = packet?.answers.filter((answer) => !(answer.disposition === "PROPOSABLE" && answer.proposal !== null)) ?? [];
  // Unticked answers are remembered for this exact set of answers only.
  const packetKey = packet ? `${packet.answerPacketVersion}:${packet.packetHash}` : "none";
  const [unticked, setUnticked] = useState<Readonly<{ key: string; ids: ReadonlySet<string> }>>({ key: packetKey, ids: NO_IDS });
  const untickedIds = unticked.key === packetKey ? unticked.ids : NO_IDS;
  const isTicked = (answer: AnswerPacketAnswer) => answer.status === "PENDING" ? !untickedIds.has(answer.id) : answer.status === "APPROVED";
  const pending = proposedAnswers.filter((answer) => answer.status === "PENDING").length;
  // The button names exactly what one click approves: answers still waiting and left ticked.
  const tickedCount = proposedAnswers.filter((answer) => answer.status === "PENDING" && isTicked(answer)).length;
  // Whether Fill types this kind of field, decided from the answer itself (labels can repeat).
  const fillsThisKind = (answer: AnswerPacketAnswer) => packet === null || !deriveManualFieldPresentations({ ...packet, answers: [answer] })
    .some((field) => field.category === "MANUAL_CONTROL_FAMILY" || field.category === "UNSUPPORTED");
  const toggle = (answer: AnswerPacketAnswer) => {
    const next = new Set(untickedIds);
    if (next.has(answer.id)) next.delete(answer.id);
    else next.add(answer.id);
    setUnticked({ key: packetKey, ids: next });
  };
  const approve = () => {
    if (packet === null) return;
    onApproveAndContinue(packet, new Set(proposedAnswers
      .filter((answer) => answer.status === "PENDING" && isTicked(answer))
      .map((answer) => answer.id)));
  };
  return <>
    <p className={`rounded-lg border px-3 py-2 text-sm ${freshnessCopy.className}`}>{freshnessCopy.text}</p>
    {proposedAnswers.length > 0 ? <div className="space-y-2">
      <div className="hidden grid-cols-3 gap-3 pl-7 text-xs font-semibold text-slate-500 sm:grid" aria-hidden="true">
        <span>Form asks</span><span>Apply Pilot will type</span><span>From</span>
      </div>
      <ul data-testid="approval-list" aria-label="Proposed answers" className="space-y-2">
        {proposedAnswers.map((answer) => <ApprovalRow
          key={answer.id}
          answer={answer}
          ticked={isTicked(answer)}
          locked={isTickLocked(answer)}
          fillsThisKind={fillsThisKind(answer)}
          onToggle={() => toggle(answer)}
        />)}
      </ul>
      <p className="text-xs text-slate-600">Untick anything you don&apos;t want Apply Pilot to fill. Nothing is sent until you press the button below.</p>
    </div> : null}
    {otherAnswers.length > 0 ? <div className="space-y-3">
      <h3 className="text-sm font-semibold text-slate-950">You&apos;ll answer these yourself</h3>
      {otherAnswers.map((answer) => <AnswerCard key={answer.id} answer={answer} />)}
    </div> : null}
    {packet || isNow ? <div className="space-y-3 rounded-lg border border-slate-200 bg-slate-50 p-4">
      <h3 className="text-sm font-semibold text-slate-950">Before you continue</h3>
      {run ? <div id="review-reasons">
        {run.reviewReasons.length === 0
          ? <p className="text-sm text-slate-700">Nothing else needs your attention before you continue.</p>
          : <ul className="list-disc space-y-1 pl-5 text-sm text-slate-700">{run.reviewReasons.map((reason) => <li key={reason}>{REVIEW_REASON_LABELS[reason]}</li>)}</ul>}
        <details data-technical className="mt-2 text-sm">
          <summary className="cursor-pointer text-xs font-semibold text-slate-600">Details (for troubleshooting)</summary>
          <dl className="mt-2 grid gap-3 text-sm sm:grid-cols-2">
            <div><dt className="text-xs text-slate-500">Run state</dt><dd className="mt-1 font-medium text-slate-900">{run.state}</dd></div>
            <div><dt className="text-xs text-slate-500">State version</dt><dd className="mt-1 font-medium text-slate-900">{run.stateVersion}</dd></div>
          </dl>
        </details>
      </div> : null}
      {ambiguous > 0 ? <p className="text-sm text-amber-900">{ambiguous} {ambiguous === 1 ? "question" : "questions"} on the form couldn&apos;t be read clearly. You&apos;ll answer {ambiguous === 1 ? "it" : "them"} yourself; continuing doesn&apos;t answer {ambiguous === 1 ? "it" : "them"}.</p> : null}
      {otherAnswers.length > 0 ? <p className="text-sm text-slate-700">{otherAnswers.length} {otherAnswers.length === 1 ? "field is" : "fields are"} yours to fill (listed in step 9).</p> : null}
      {packet ? <p id="review-readiness" className="text-sm text-slate-700">{pending > 0
        ? "When you continue, ticked answers are approved and unticked ones won't be filled."
        : packet.summary.readyForRunResolution
          ? "Every proposed answer has your decision."
          : "Apply Pilot is still checking the answers."}</p> : null}
      <StepActionButton
        action="CONTINUE_REVIEW"
        state={view.actions.CONTINUE_REVIEW}
        primary={isNow && view.primary?.action === "CONTINUE_REVIEW"}
        describedBy="review-readiness review-reasons"
        label={approving ? undefined : approveButtonLabel(tickedCount, pending)}
        onClick={approve}
      />
    </div> : null}
    {packet ? <details data-technical className="rounded-lg border border-slate-200 p-3 text-sm">
      <summary className="cursor-pointer text-xs font-semibold text-slate-600">Details (for troubleshooting)</summary>
      <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
        <div><dt className="text-xs font-semibold uppercase text-slate-500">Inspection version</dt><dd className="mt-1 text-slate-900">{packet.inspectionVersion}</dd></div>
        <div><dt className="text-xs font-semibold uppercase text-slate-500">Packet version</dt><dd className="mt-1 text-slate-900">{packet.answerPacketVersion}</dd></div>
        <div><dt className="text-xs font-semibold uppercase text-slate-500">Created</dt><dd className="mt-1 text-slate-900">{displayDate(packet.createdAt)}</dd></div>
        <div><dt className="text-xs font-semibold uppercase text-slate-500">Review time</dt><dd className="mt-1 text-slate-900">{displayDate(packet.reviewedAt)}</dd></div>
        <div className="sm:col-span-2 lg:col-span-4"><dt className="text-xs font-semibold uppercase text-slate-500">Packet hash</dt><dd className="mt-1 break-all font-mono text-xs text-slate-700">{packet.packetHash}</dd></div>
      </dl>
      <dl className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-3 lg:grid-cols-5">
        {([
          ["Fields", packet.summary.fieldCount], ["Proposable", packet.summary.proposableCount],
          ["Observed controls", packet.summary.observedFieldCount], ["Ambiguous manual questions", packet.summary.ambiguousQuestionCount],
          ["Ambiguous required", packet.summary.ambiguousRequiredCount],
          ["Pending review", packet.summary.pendingReviewCount], ["Approved", packet.summary.approvedCount],
          ["Rejected", packet.summary.rejectedCount], ["Manual only", packet.summary.manualOnlyCount],
          ["Excluded", packet.summary.excludedCount], ["Unsupported", packet.summary.unsupportedCount],
          ["Manual required", packet.summary.manualRequiredCount]
        ] as const).map(([label, value]) => <div key={label}><dt className="text-xs text-slate-500">{label}</dt><dd className="mt-1 font-medium text-slate-900">{value}</dd></div>)}
      </dl>
    </details> : null}
  </>;
}

// The Fill switch at step 8 (D035 D-B). Assisted Fill is account-wide and turns itself off when
// an application ends, so step 8 offers to turn it on. Turning it on is one in-page question (like
// Unlock and Record on this page); the server decides, this only asks it.
export type FillSwitchView = Readonly<{
  // The account's mode, from the policy read made when step 8 became current (null: not known).
  mode: "PREPARE_ONLY" | "FILL_AND_REVIEW" | null;
  asking: boolean;
  pending: boolean;
  disabled: boolean;
  notice: CommandNotice | null;
  onAsk: () => void;
  onConfirm: () => void;
  onCancel: () => void;
}>;

export const FILL_SWITCH_QUESTION = {
  title: "Turn on Fill for this form?",
  body: "Fill types only the answers you approved, once. It leaves anything already in the form alone, and you still press the employer's Submit button yourself. Assisted Fill is a setting for your whole account. It turns off by itself when you record or stop an application, and you can turn it off in Settings any time."
} as const;

function FillSwitch({ fillSwitch }: { fillSwitch: FillSwitchView }) {
  const busy = fillSwitch.disabled || fillSwitch.pending;
  return <div className="space-y-2">
    {fillSwitch.mode === "PREPARE_ONLY" ? <div data-testid="fill-switch" className="space-y-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
      {fillSwitch.asking ? <div role="group" aria-labelledby="fill-switch-question" className="space-y-2">
        <h3 id="fill-switch-question" className="font-semibold">{FILL_SWITCH_QUESTION.title}</h3>
        <p>{FILL_SWITCH_QUESTION.body}</p>
        <div className="flex flex-wrap items-start gap-2">
          {/* Secondary: Fill stays the page's one primary action. */}
          <SecondaryButton type="button" data-testid="confirm-turn-on-fill" disabled={busy} onClick={fillSwitch.onConfirm}>Turn on Fill</SecondaryButton>
          <SecondaryButton type="button" disabled={fillSwitch.pending} onClick={fillSwitch.onCancel}>Cancel</SecondaryButton>
        </div>
      </div> : <>
        <p>Assisted Fill is off, so Apply Pilot can&apos;t fill this form yet. Turn it on, then press Fill.</p>
        <SecondaryButton type="button" data-testid="turn-on-fill" disabled={busy} onClick={fillSwitch.onAsk}>Turn on Fill for this form</SecondaryButton>
      </>}
    </div> : null}
    <Notice notice={fillSwitch.notice} />
  </div>;
}

// Step 8 · Fill.
export function FillStepBody({
  view,
  manualFields,
  fillableCount,
  ambiguousQuestionCount,
  acknowledged,
  onAcknowledge,
  onFill,
  fillStatusBlock,
  fillSwitch
}: {
  view: ControlStepsView;
  manualFields: readonly ManualFieldPresentation[];
  fillableCount: number;
  ambiguousQuestionCount: number;
  acknowledged: boolean;
  onAcknowledge: (checked: boolean) => void;
  onFill: () => void;
  fillStatusBlock: ReactNode;
  fillSwitch?: FillSwitchView;
}) {
  const isNow = view.current === 8;
  const showButton = fillableCount > 0 || (isNow && view.primary?.action === "FILL");
  return <>
    {isNow && fillSwitch ? <FillSwitch fillSwitch={fillSwitch} /> : null}
    <ManualFieldList fields={manualFields} intro="Apply Pilot won't fill these. You'll do them yourself in the employer's window." />
    <label className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
      <input
        data-testid="transmission-ack"
        type="checkbox"
        checked={acknowledged}
        onChange={(event) => onAcknowledge(event.target.checked)}
      />
      <span>I understand that filling a field can trigger the employer page&apos;s own scripts. Values may be sent to the employer or third parties before you press Submit. Apply Pilot will not press Submit and cannot promise network-free filling.</span>
    </label>
    {showButton
      ? <StepActionButton
          action="FILL"
          state={view.actions.FILL}
          primary={isNow && view.primary?.action === "FILL"}
          onClick={onFill}
        />
      : <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">Apply Pilot has no fields it can fill on this form. {ambiguousQuestionCount ? `${ambiguousQuestionCount} employer ${ambiguousQuestionCount === 1 ? "question" : "questions"} couldn't be read clearly and need your own answer. ` : ""}Fill in the employer&apos;s form yourself; no Fill attempt is used from this page.</p>}
    {fillStatusBlock}
  </>;
}

export function FillStatusBlock({
  presentation,
  pendingCopy,
  stoppedErrorCopy,
  hasSteps,
  ambiguousQuestionCount,
  packetAvailable
}: {
  presentation: FillStatusPresentation | null;
  pendingCopy: string;
  stoppedErrorCopy: string | null;
  hasSteps: boolean;
  ambiguousQuestionCount: number;
  packetAvailable: boolean;
}) {
  return <div className="space-y-3">
    {presentation ? <div className={`rounded-lg px-4 py-3 text-sm ${noticeClass(presentation.tone)}`}>
      <h3 className="font-semibold">{presentation.title}</h3>
      <p className="mt-2 leading-6">{presentation.text}</p>
      {presentation.category === "COMPLETED" && ambiguousQuestionCount > 0 ?
        <p className="mt-2 leading-6">Fill finished for approved fields only. {ambiguousQuestionCount} ambiguous employer questions still require manual completion. You submit the employer form yourself.</p> : null}
      {presentation.category === "COMPLETED" && !packetAvailable ?
        <p className="mt-2 leading-6">Fill finished for approved fields only. Employer questions may still require manual completion. Refresh review data to see the verified manual-work count, and submit the employer form yourself.</p> : null}
      {stoppedErrorCopy ? <p className="mt-2">{stoppedErrorCopy}</p> : null}
      {hasSteps ? <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-5">
        {([
          ["Filled", presentation.counts.filled],
          ["Preserved existing", presentation.counts.preservedExisting],
          ["Runtime manual", presentation.counts.runtimeManual],
          ["Failed", presentation.counts.failed],
          ["Not attempted", presentation.counts.notAttempted]
        ] as const).map(([label, count]) => <div key={label}><dt className="text-xs font-medium">{label}</dt><dd className="mt-1 font-semibold">{count}</dd></div>)}
      </dl> : null}
    </div> : <p className="rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-700">{pendingCopy}</p>}
  </div>;
}

// Step 9 · Finish and submit.
export function FinishStepBody({
  view,
  workflowState,
  handoffConfirming,
  fillResultTitle,
  humanMinutesRemaining,
  manualFields,
  canEndSession,
  onUnlock,
  onConfirmUnlock,
  onCancelUnlock,
  onEndSession,
  recordEntry
}: {
  view: ControlStepsView;
  workflowState: "TARGET_OPEN" | "HANDED_OVER" | "OTHER";
  handoffConfirming: boolean;
  fillResultTitle: string | null;
  humanMinutesRemaining: number | null;
  manualFields: readonly ManualFieldPresentation[];
  canEndSession: boolean;
  onUnlock: () => void;
  onConfirmUnlock: () => void;
  onCancelUnlock: () => void;
  onEndSession: () => void;
  recordEntry: ReactNode;
}) {
  const isNow = view.current === 9;
  const unlockPrimary = isNow && view.primary?.action === "UNLOCK";
  const confirmPrimary = isNow && view.primary?.action === "CONFIRM_UNLOCK";
  return <>
    {fillResultTitle ? <p className="text-sm font-medium text-slate-900">{fillResultTitle}.</p> : null}
    {workflowState === "TARGET_OPEN" ? <div className="space-y-3">
      <h3 className="text-sm font-semibold text-slate-950">a) Unlock the form so you can finish it</h3>
      <p className="text-sm text-slate-700">While Apply Pilot is attached, the form is locked to its exact page. Unlocking stops Apply Pilot reading and filling, and the form is yours for up to 60 minutes.</p>
      {!handoffConfirming
        ? <StepActionButton action="UNLOCK" state={view.actions.UNLOCK} primary={unlockPrimary} onClick={onUnlock} />
        : <div className="space-y-3 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950">
            <p>Unlocking is permanent: Apply Pilot won&apos;t read or fill this form again. The form stays open for at most 60 minutes, with warnings at 10 and 2 minutes and no extension. The employer&apos;s page can still send what&apos;s typed. Reloading or closing this page closes the employer&apos;s form, and anything not submitted is lost.</p>
            <div className="flex flex-wrap items-start gap-2">
              <StepActionButton action="CONFIRM_UNLOCK" state={view.actions.CONFIRM_UNLOCK} primary={confirmPrimary} onClick={onConfirmUnlock} />
              <SecondaryButton type="button" onClick={onCancelUnlock}>Not yet</SecondaryButton>
            </div>
          </div>}
      <p className="text-xs text-slate-600">If you can&apos;t unlock the form here, open the job&apos;s application page in your usual browser and fill the form there. You&apos;ll need to type everything again, because nothing is carried over. If you&apos;re not sure whether an earlier attempt was submitted, check with the employer before trying again.</p>
    </div> : null}
    {workflowState === "HANDED_OVER" ? <div className="space-y-2 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950">
      <h3 className="font-semibold">The form is unlocked</h3>
      <p>Apply Pilot has stopped reading and filling. You have {humanMinutesRemaining === null ? "a limited time" : `${humanMinutesRemaining} minute(s)`} left: it&apos;s a 60-minute maximum, with no extension. A page that looks like a confirmation doesn&apos;t prove the employer received it.</p>
      {humanMinutesRemaining !== null && humanMinutesRemaining <= 10 ? <p className="font-semibold">Time is nearly up: {humanMinutesRemaining <= 2 ? "2 minutes or less remain" : "10 minutes or less remain"}. Anything not submitted may be lost.</p> : null}
      <p>Reloading or closing this page closes the employer&apos;s form. If you&apos;re not sure whether it was submitted, check with the employer before trying again.</p>
    </div> : null}
    <div className="space-y-2">
      <h3 className="text-sm font-semibold text-slate-950">b) In the employer&apos;s window, finish the form</h3>
      <ManualFieldList fields={manualFields} intro="Fill in what Apply Pilot can't. Check any field it filled, too." />
      {manualFields.length === 0 ? <p className="text-sm text-slate-700">Check every field, including any Apply Pilot filled.</p> : null}
    </div>
    <h3 className="text-sm font-semibold text-slate-950">c) Press the employer&apos;s Submit button yourself</h3>
    <p className="text-sm text-slate-700">Apply Pilot never presses Submit.</p>
    {recordEntry}
    {workflowState === "HANDED_OVER" ? <SecondaryButton type="button" disabled={!canEndSession} onClick={onEndSession}>End the session</SecondaryButton> : null}
  </>;
}

// Step 10 · Record it. Also shown on its own in the wrong window.
export function RecordStepBody({
  show,
  recorded,
  recordedAt,
  phase,
  notice,
  showEntry,
  entryPrimary,
  entryState,
  confirmPrimary,
  confirmState,
  showCheck,
  checkPrimary,
  checkState,
  onEntry,
  onConfirm,
  onCancel,
  onCheck
}: {
  show: boolean;
  recorded: boolean;
  recordedAt: string | null;
  phase: "idle" | "confirming" | "pending" | "confirmed" | "uncertain";
  notice: CommandNotice | null;
  showEntry: boolean;
  entryPrimary: boolean;
  entryState: ControlActionState;
  confirmPrimary: boolean;
  confirmState: ControlActionState;
  showCheck: boolean;
  checkPrimary: boolean;
  checkState: ControlActionState;
  onEntry: () => void;
  onConfirm: () => void;
  onCancel: () => void;
  onCheck: () => void;
}) {
  if (!show) {
    return <p className="text-sm text-slate-700">After you press the employer&apos;s Submit button, you&apos;ll record it here.</p>;
  }
  return <div data-testid="personal-submission" className="space-y-3">
    {recorded
      ? <p className="text-sm text-slate-600">Personal submission recorded from your explicit attestation. Apply Pilot did not submit or independently verify the employer submission.</p>
      : <p className="text-sm text-slate-600">Only confirm after you personally used the employer site&apos;s Submit control. Apply Pilot does not submit the application for you.</p>}
    <Notice notice={notice} />
    {recorded ? <dl className="rounded-lg bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
      <div>
        <dt className="font-semibold">Personal submission recorded</dt>
        <dd className="mt-1">Recorded at {displayDate(recordedAt)}</dd>
      </div>
    </dl> : null}
    {showEntry ? <StepActionButton action="RECORD" state={entryState} primary={entryPrimary} onClick={onEntry} /> : null}
    {!recorded && (phase === "confirming" || phase === "pending") ? <div className="rounded-lg border border-amber-300 bg-amber-50 p-4">
      <p className="text-sm font-medium text-amber-950">Confirm only if you personally submitted on the employer site. This records your attestation; it does not verify the employer&apos;s submission result.</p>
      <div className="mt-3 flex flex-wrap items-start gap-2">
        <StepActionButton action="CONFIRM_RECORD" state={confirmState} primary={confirmPrimary} onClick={onConfirm} />
        <SecondaryButton type="button" disabled={phase === "pending"} onClick={onCancel}>Not yet</SecondaryButton>
      </div>
    </div> : null}
    {showCheck ? <StepActionButton action="CHECK_RECORD" state={checkState} primary={checkPrimary} onClick={onCheck} /> : null}
  </div>;
}

export type MoreAction = Readonly<{
  key: string;
  label: string;
  disabled: boolean;
  onClick: () => void;
}>;

// Secondary actions: reads, retries and closing. Kept out of the way of the one primary action.
export function MoreActions({ actions }: { actions: readonly MoreAction[] }) {
  return <details data-testid="more-actions" className="rounded-lg border border-slate-200 p-3 text-sm">
    <summary className="cursor-pointer text-sm font-semibold text-slate-700">More</summary>
    <p className="mt-2 text-xs text-slate-600">Apply Pilot refreshes these after each step. Use them only if something looks out of date.</p>
    <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
      {actions.map((entry) => <SecondaryButton key={entry.key} type="button" disabled={entry.disabled} onClick={entry.onClick}>{entry.label}</SecondaryButton>)}
    </div>
  </details>;
}

export function stepSummary(step: ControlStepNumber, progress: StepProgress): string {
  const done = progress === "done";
  if (step === 6) return done ? "Apply Pilot opened and read the employer's form." : "Apply Pilot opens the employer's form and reads it.";
  if (step === 7) return done ? "You checked the proposed answers." : "Check what Apply Pilot proposes before anything is typed.";
  if (step === 8) return done ? "Fill is done, or there was nothing to fill." : "Fill types the answers you approved, once.";
  if (step === 9) return done ? "You finished the form." : "Unlock the form, finish it and press Submit yourself.";
  return done ? "Recorded." : "Record that you submitted it.";
}
