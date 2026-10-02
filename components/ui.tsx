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
    ? "text-3xl font-semibold tracking-[-0.04em] text-[#f3f6f2] sm:text-[2.35rem] sm:leading-tight"
    : "text-2xl font-semibold tracking-normal text-slate-950";
  const descriptionClass = tone === "branded"
    ? "mt-3 max-w-3xl text-[15px] leading-6 text-[#aeb9b5]"
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
  const borderClass = tone === "branded" ? "border-white/10" : "border-slate-200";

  return (
    <div className={`flex flex-col gap-3 border-b px-5 py-4 sm:flex-row sm:items-center sm:justify-between ${borderClass}`}>
      <div>
        <h2 className={`text-sm font-semibold ${tone === "branded" ? "text-[#f3f6f2]" : "text-slate-950"}`}>{title}</h2>
        {description ? <p className={`mt-1 text-xs leading-5 ${tone === "branded" ? "text-[#aeb9b5]" : "text-slate-500"}`}>{description}</p> : null}
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
      ? "border border-brand-300 bg-gradient-to-br from-[#62dc9a] to-[#4ccf88] text-[#03110b] shadow-[0_12px_34px_rgba(43,202,122,0.12)] hover:border-[#73e3a6] hover:from-[#73e3a6] hover:to-[#59d793]"
      : "border border-[rgba(106,183,152,0.45)] bg-[#071411]/80 text-[#e8eeeb] hover:border-brand-300 hover:bg-brand-500/10 hover:text-brand-300"
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
    ? "min-h-11 border border-brand-300 bg-gradient-to-br from-[#62dc9a] to-[#4ccf88] text-[#03110b] shadow-[0_12px_34px_rgba(43,202,122,0.12)] transition-colors hover:border-[#73e3a6] hover:from-[#73e3a6] hover:to-[#59d793]"
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
    ? "min-h-11 border-[rgba(106,183,152,0.45)] bg-[#071411]/80 text-[#e8eeeb] transition-colors hover:border-brand-300 hover:bg-brand-500/10 hover:text-brand-300"
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
        ? "text-xs font-semibold uppercase tracking-[0.08em] text-brand-300"
        : "text-xs font-medium uppercase text-slate-500"}>{label}</p>
      <p className={`mt-2 text-2xl font-semibold ${tone === "branded" ? "text-[#f3f6f2]" : "text-slate-950"}`}>{value}</p>
      {detail ? <p className={`mt-1 text-xs ${tone === "branded" ? "text-[#aeb9b5]" : "text-slate-500"}`}>{detail}</p> : null}
    </div>
  );
}

export function ScoreBadge({ score, tone = "default" }: { score: number | null | undefined; tone?: UiTone }) {
  const fitScore = validFitScore(score);
  const toneClass = tone === "branded"
    ? fitScore === null
      ? "bg-white/[0.05] text-[#c5cfcb] ring-white/15"
      : fitScore >= 80
        ? "bg-brand-500/10 text-brand-300 ring-brand-400/35"
        : fitScore >= 65
          ? "bg-sky-400/10 text-sky-200 ring-sky-300/30"
          : "bg-amber-400/10 text-amber-200 ring-amber-300/30"
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
    ? "bg-brand-500/10 text-brand-300 ring-brand-400/30"
    : "bg-slate-100 text-slate-700 ring-slate-200";

  return (
    <span className={`inline-flex items-center rounded-md px-2 py-1 text-xs font-semibold ring-1 ${toneClass}`}>
      {status.replaceAll("_", " ")}
    </span>
  );
}
