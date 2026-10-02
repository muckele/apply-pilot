import Link from "next/link";
import type { ComponentPropsWithoutRef } from "react";

import { validFitScore } from "@/lib/jobs/fit-presentation";

export type UiTone = "default" | "branded";

export function PageHeader({
  title,
  description,
  action,
  tone = "default"
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
  tone?: UiTone;
}) {
  const titleClass = tone === "branded"
    ? "product-themed-title text-3xl font-semibold tracking-[-0.04em] sm:text-[2.35rem] sm:leading-tight"
    : "text-2xl font-semibold tracking-normal text-slate-950";
  const descriptionClass = tone === "branded"
    ? "product-themed-muted mt-3 max-w-3xl text-[15px] leading-6"
    : "mt-1 max-w-3xl text-sm leading-6 text-slate-600";

  return (
    <div className="mb-6 flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
      <div>
        <h1 className={titleClass}>{title}</h1>
        {description ? <p className={descriptionClass}>{description}</p> : null}
      </div>
      {action}
    </div>
  );
}

export function Panel({
  children,
  className = "",
  tone = "default"
}: {
  children: React.ReactNode;
  className?: string;
  tone?: UiTone;
}) {
  const surfaceClass = tone === "branded"
    ? "product-surface rounded-xl"
    : "rounded-lg border-slate-200 bg-white shadow-soft";

  return (
    <section className={`border ${surfaceClass} ${className}`}>
      {children}
    </section>
  );
}

export function PanelHeader({
  title,
  description,
  action,
  tone = "default"
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
  tone?: UiTone;
}) {
  const borderClass = tone === "branded" ? "product-divider" : "border-slate-200";

  return (
    <div className={`flex flex-col gap-3 border-b px-5 py-4 sm:flex-row sm:items-center sm:justify-between ${borderClass}`}>
      <div>
        <h2 className={`text-sm font-semibold ${tone === "branded" ? "product-themed-title" : "text-slate-950"}`}>{title}</h2>
        {description ? <p className={`mt-1 text-xs leading-5 ${tone === "branded" ? "product-themed-muted" : "text-slate-500"}`}>{description}</p> : null}
      </div>
      {action}
    </div>
  );
}

export function ButtonLink({
  href,
  children,
  variant = "primary",
  tone = "default"
}: {
  href: string;
  children: React.ReactNode;
  variant?: "primary" | "secondary";
  tone?: UiTone;
}) {
  const classes = tone === "branded"
    ? variant === "primary"
      ? "product-primary-action border"
      : "product-secondary-action border"
    : variant === "primary"
      ? "bg-brand-600 text-white hover:bg-brand-700"
      : "border border-slate-200 bg-white text-slate-700 hover:bg-slate-50";
  const interactionClass = tone === "branded" ? "min-h-11 transition-colors" : "";

  return (
    <Link
      href={href}
      className={`inline-flex items-center justify-center rounded-lg px-3 py-2 text-sm font-semibold ${interactionClass} ${classes}`}
    >
      {children}
    </Link>
  );
}

export function PrimaryButton({
  tone = "default",
  className = "",
  ...props
}: ComponentPropsWithoutRef<"button"> & { tone?: UiTone }) {
  const toneClass = tone === "branded"
    ? "product-primary-action border"
    : "bg-brand-600 text-white hover:bg-brand-700";

  return (
    <button
      {...props}
      className={`inline-flex items-center justify-center rounded-lg px-3 py-2 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-60 ${toneClass} ${className}`}
    />
  );
}

export function SecondaryButton({
  tone = "default",
  className = "",
  ...props
}: ComponentPropsWithoutRef<"button"> & { tone?: UiTone }) {
  const toneClass = tone === "branded"
    ? "product-secondary-action"
    : "border border-slate-200 bg-white text-slate-700 hover:bg-slate-50";

  return (
    <button
      {...props}
      className={`inline-flex items-center justify-center rounded-lg border px-3 py-2 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-60 ${toneClass} ${className}`}
    />
  );
}

export function MetricCard({
  label,
  value,
  detail,
  tone = "default"
}: {
  label: string;
  value: string | number;
  detail?: string;
  tone?: UiTone;
}) {
  const surfaceClass = tone === "branded"
    ? "product-surface rounded-xl"
    : "rounded-lg border-slate-200 bg-white shadow-soft";

  return (
    <div className={`border p-4 ${surfaceClass}`}>
      <p className={tone === "branded"
        ? "product-themed-accent text-xs font-semibold uppercase tracking-[0.08em]"
        : "text-xs font-medium uppercase text-slate-500"}>{label}</p>
      <p className={`mt-2 text-2xl font-semibold ${tone === "branded" ? "product-themed-title" : "text-slate-950"}`}>{value}</p>
      {detail ? <p className={`mt-1 text-xs ${tone === "branded" ? "product-themed-muted" : "text-slate-500"}`}>{detail}</p> : null}
    </div>
  );
}

export function ScoreBadge({ score, tone = "default" }: { score: number | null | undefined; tone?: UiTone }) {
  const fitScore = validFitScore(score);
  const toneClass = tone === "branded"
    ? fitScore === null
      ? "product-badge-neutral"
      : fitScore >= 80
        ? "product-badge-high"
        : fitScore >= 65
          ? "product-badge-medium"
          : "product-badge-low"
    : fitScore === null
      ? "bg-slate-100 text-slate-700 ring-slate-200"
      : fitScore >= 80
        ? "bg-emerald-50 text-emerald-700 ring-emerald-200"
        : fitScore >= 65
          ? "bg-sky-50 text-sky-700 ring-sky-200"
          : "bg-amber-50 text-amber-700 ring-amber-200";

  return (
    <span className={`inline-flex items-center rounded-md px-2 py-1 text-xs font-semibold ring-1 ${toneClass}`}>
      {fitScore === null ? "Unscored" : `${fitScore}% fit`}
    </span>
  );
}

export function StatusBadge({ status, tone = "default" }: { status: string; tone?: UiTone }) {
  const toneClass = tone === "branded"
    ? "product-badge-status"
    : "bg-slate-100 text-slate-700 ring-slate-200";

  return (
    <span className={`inline-flex items-center rounded-md px-2 py-1 text-xs font-semibold ring-1 ${toneClass}`}>
      {status.replaceAll("_", " ")}
    </span>
  );
}
