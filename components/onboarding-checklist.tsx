import { CircleCheck, ListChecks } from "lucide-react";
import Link from "next/link";

import { ButtonLink, SecondaryButton } from "@/components/ui";
import {
  resolveOnboardingChecklistDisplay,
  type OnboardingChecklist as OnboardingChecklistData,
  type OnboardingStep,
  type OnboardingStepStatus
} from "@/lib/onboarding";

export const ONBOARDING_CHECKLIST_ANCHOR = "onboarding-checklist";

type FormAction = (formData: FormData) => void | Promise<void>;

const STATUS_LABELS: Record<OnboardingStepStatus, string> = {
  complete: "Done",
  next: "Next step",
  pending: "To do"
};

const STATUS_BADGE_CLASSES: Record<OnboardingStepStatus, string> = {
  complete: "product-badge-status",
  next: "product-badge-medium",
  pending: "product-badge-neutral"
};

function progressText(checklist: OnboardingChecklistData) {
  return `${checklist.completedCount} of ${checklist.totalCount} steps done`;
}

function StepMarker({ step }: { step: OnboardingStep }) {
  if (step.status === "complete") {
    return <CircleCheck size={28} strokeWidth={1.75} className="product-themed-accent shrink-0" aria-hidden="true" />;
  }
  return (
    <span
      aria-hidden="true"
      className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-xs font-semibold ${
        step.status === "next"
          ? "border-[var(--product-mint)] bg-[var(--product-mint)] text-[var(--product-primary-text)]"
          : "product-divider product-themed-muted"
      }`}
    >
      {step.number}
    </span>
  );
}

function OnboardingStepItem({ step }: { step: OnboardingStep }) {
  const surfaceClass = step.status === "next" ? "product-surface-raised" : "product-divider";

  return (
    <li
      data-status={step.status}
      aria-current={step.status === "next" ? "step" : undefined}
      className={`flex flex-col gap-3 rounded-lg border p-4 sm:flex-row sm:items-center sm:justify-between ${surfaceClass}`}
    >
      <div className="flex min-w-0 items-start gap-3">
        <StepMarker step={step} />
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="product-themed-title text-sm font-semibold">{step.title}</h3>
            <span
              data-step-state
              className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-semibold ring-1 ${STATUS_BADGE_CLASSES[step.status]}`}
            >
              {STATUS_LABELS[step.status]}
            </span>
          </div>
          <p className="product-themed-muted mt-1 text-xs leading-5">{step.description}</p>
        </div>
      </div>
      {step.status === "complete" ? null : (
        <div className="shrink-0">
          <ButtonLink href={step.href} variant={step.status === "next" ? "primary" : "secondary"} tone="branded">
            {step.actionLabel}
          </ButtonLink>
        </div>
      )}
    </li>
  );
}

export function OnboardingChecklist({
  checklist,
  hidden,
  hideAction,
  showAction
}: {
  checklist: OnboardingChecklistData;
  hidden: boolean;
  hideAction: FormAction;
  showAction: FormAction;
}) {
  const display = resolveOnboardingChecklistDisplay(checklist, { hidden });
  if (display === "none") return null;

  const progress = progressText(checklist);

  if (display === "collapsed") {
    return (
      <section
        id={ONBOARDING_CHECKLIST_ANCHOR}
        aria-label="Setup checklist"
        className="product-surface mb-6 flex scroll-mt-24 flex-col gap-3 rounded-xl border px-5 py-3 sm:flex-row sm:items-center sm:justify-between"
      >
        <p className="product-themed-copy flex items-start gap-2 text-sm">
          <ListChecks size={17} className="product-themed-accent mt-0.5 shrink-0" aria-hidden="true" />
          <span>
            <span className="font-semibold">Setup checklist hidden.</span> {progress}
            {checklist.nextStep ? <>. Next: {checklist.nextStep.title}.</> : "."}
          </span>
        </p>
        <form action={showAction} className="shrink-0">
          <SecondaryButton type="submit" tone="branded">
            Show checklist
          </SecondaryButton>
        </form>
      </section>
    );
  }

  const percent = Math.round((checklist.completedCount / checklist.totalCount) * 100);

  return (
    <section
      id={ONBOARDING_CHECKLIST_ANCHOR}
      aria-labelledby="onboarding-checklist-title"
      className="product-surface mb-6 scroll-mt-24 rounded-xl border"
    >
      <div className="product-divider flex flex-col gap-4 border-b px-5 py-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="product-themed-accent text-xs font-semibold uppercase tracking-[0.08em]">Getting started</p>
          <h2 id="onboarding-checklist-title" className="product-themed-title mt-1 text-lg font-semibold tracking-[-0.01em]">
            Set up your job search
          </h2>
          <p className="product-themed-muted mt-1 max-w-2xl text-sm leading-6">
            Five steps take you from your resume to your first tracked application. Each step checks itself off once
            the data is in Apply Pilot.
          </p>
        </div>
        <form action={hideAction} className="shrink-0">
          <SecondaryButton type="submit" tone="branded">
            Hide for now
          </SecondaryButton>
        </form>
      </div>

      <div className="px-5 pt-4">
        <p className="product-themed-copy text-sm font-medium">{progress}</p>
        <div
          role="progressbar"
          aria-label="Setup progress"
          aria-valuemin={0}
          aria-valuemax={checklist.totalCount}
          aria-valuenow={checklist.completedCount}
          aria-valuetext={progress}
          className="mt-2 h-2 overflow-hidden rounded-full bg-[var(--product-divider)]"
        >
          <div className="h-full rounded-full bg-[var(--product-mint)]" style={{ width: `${percent}%` }} />
        </div>
      </div>

      <ol className="space-y-3 p-5">
        {checklist.steps.map((step) => (
          <OnboardingStepItem key={step.id} step={step} />
        ))}
      </ol>
    </section>
  );
}

export function OnboardingSetupHint({ checklist }: { checklist: OnboardingChecklistData }) {
  if (checklist.isComplete || !checklist.nextStep) return null;

  return (
    <p className="product-themed-muted mt-2 text-sm">
      <Link
        href={`#${ONBOARDING_CHECKLIST_ANCHOR}`}
        className="product-themed-link font-semibold underline underline-offset-4"
      >
        Continue setup: {checklist.nextStep.title}
      </Link>
    </p>
  );
}
