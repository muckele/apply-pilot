import Link from "next/link";

import { Panel, PanelHeader } from "@/components/ui";
import type { LoadedWeeklyMetrics } from "@/lib/metrics/weekly-metrics-loader";
import {
  WEEKLY_METRIC_DEFINITIONS,
  type MoneyPerItemMetric,
  type NotEnoughData,
  type NotMeasured,
  type PeriodMetrics,
  type RatioMetric
} from "@/lib/metrics/weekly-metrics";

export const INSIGHTS_WEEK_OPTIONS = Object.freeze([4, 8, 13] as const);
const DEFAULT_INSIGHTS_WEEKS = 8;

type MetricResult = RatioMetric | MoneyPerItemMetric | NotEnoughData | NotMeasured;
type FunnelKey = keyof PeriodMetrics["funnel"];
type SupportingKey = Exclude<keyof PeriodMetrics["metrics"], "interviewsPerApplicantHour">;

const FUNNEL_KEYS: readonly FunnelKey[] = ["jobsAdded", "jobsSaved", "kitsPrepared", "applied", "interviews"];
const SUPPORTING_KEYS: readonly SupportingKey[] = [
  "effortMinutesPerApplication",
  "tailoredShare",
  "completeTracking",
  "interviewRate",
  "feedSaveRate",
  "aiCostPerApplication"
];
const SUPPORTING_TABLE_KEYS = ["tailoredShare", "completeTracking", "interviewRate", "feedSaveRate"] as const;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const TIME_ZONE_NAMES: Record<string, string> = { "America/Los_Angeles": "Pacific time" };

const NOT_MEASURED_ITEMS = [
  "The time you spend applying. Without it there are no applicant-hours, so interviews per applicant-hour and minutes of effort per application can't be computed.",
  "Which feed jobs you opened. \"Jobs added to your feed\" counts jobs that arrived, not jobs you looked at.",
  "The factual-error rate in reviewed documents. Apply Pilot keeps no log of errors found in review yet, so there is nothing to count.",
  "Weekly active users. That is a beta-wide number, not one for your own search."
];

export function resolveInsightsWeekCount(raw: string | string[] | undefined) {
  const value = Array.isArray(raw) ? raw[0] : raw;
  const parsed = value && /^\d+$/u.test(value) ? Number(value) : Number.NaN;
  return (INSIGHTS_WEEK_OPTIONS as readonly number[]).includes(parsed) ? parsed : DEFAULT_INSIGHTS_WEEKS;
}

function formatMoney(micros: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 4 }).format(
    micros / 1_000_000
  );
}

function formatPercent(value: number) {
  return `${Math.round(value * 100)}%`;
}

function plural(count: number, singular: string, pluralForm: string) {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

export function formatMetricResult(result: MetricResult): { value: string; detail: string } {
  const small = (smallSample: boolean) => (smallSample ? " · small sample" : "");
  switch (result.kind) {
    case "ratio":
      return {
        value: formatPercent(result.value),
        detail: `${result.numerator} of ${result.denominator}${small(result.smallSample)}`
      };
    case "money_per_item":
      return {
        value: formatMoney(result.valueMicros),
        detail: `${formatMoney(result.totalMicros)} over ${plural(result.items, "application", "applications")}${small(result.smallSample)}`
      };
    case "not_enough_data":
      return { value: "Not enough data", detail: result.reason };
    case "not_measured":
      return { value: "Not measured yet", detail: result.reason };
  }
}

function formatTableCell(result: RatioMetric | MoneyPerItemMetric | NotEnoughData) {
  if (result.kind === "ratio") return `${formatPercent(result.value)} (${result.numerator} of ${result.denominator})`;
  if (result.kind === "money_per_item") return formatMoney(result.valueMicros);
  return "Not enough data";
}

function formatWeekLabel(period: PeriodMetrics) {
  const [, month, day] = period.label.split("-").map(Number);
  return `${MONTHS[month - 1]} ${day}${period.isCurrent ? " (so far)" : ""}`;
}

function formatAiSpend(spend: PeriodMetrics["aiSpend"]) {
  const unpriced = spend.unknownCostRequests ? ` + ${spend.unknownCostRequests} unpriced` : "";
  return `${formatMoney(spend.micros)}${unpriced}`;
}

function HowComputed({ text }: { text: string }) {
  return <p className="product-themed-muted mt-2 text-xs leading-5">{text}</p>;
}

function MetricTile({ metricKey, result }: { metricKey: SupportingKey; result: MetricResult }) {
  const definition = WEEKLY_METRIC_DEFINITIONS[metricKey];
  const formatted = formatMetricResult(result);
  const missing = result.kind === "not_enough_data" || result.kind === "not_measured";
  return (
    <div data-metric={metricKey} className="product-surface rounded-xl border p-4">
      <p className="product-themed-accent text-xs font-semibold uppercase tracking-[0.08em]">{definition.label}</p>
      <p className={`mt-2 font-semibold ${missing ? "product-themed-copy text-base" : "product-themed-title text-2xl"}`}>
        {formatted.value}
      </p>
      <p className="product-themed-copy mt-1 text-xs">{formatted.detail}</p>
      <HowComputed text={definition.howComputed} />
    </div>
  );
}

function DefinitionList({ keys }: { keys: ReadonlyArray<keyof typeof WEEKLY_METRIC_DEFINITIONS> }) {
  return (
    <dl className="grid gap-3 px-5 py-4 md:grid-cols-2">
      {keys.map((key) => (
        <div key={key}>
          <dt className="product-themed-title text-xs font-semibold">{WEEKLY_METRIC_DEFINITIONS[key].label}</dt>
          <dd className="product-themed-muted mt-1 text-xs leading-5">{WEEKLY_METRIC_DEFINITIONS[key].howComputed}</dd>
        </div>
      ))}
    </dl>
  );
}

export function WeeklyMetricsReportView({ report, weekCount }: { report: LoadedWeeklyMetrics; weekCount: number }) {
  const newestFirst = [...report.weeks].reverse();
  const timeZoneName = TIME_ZONE_NAMES[report.timeZone] ?? report.timeZone;
  const primary = WEEKLY_METRIC_DEFINITIONS.interviewsPerApplicantHour;
  const primaryResult = formatMetricResult(report.total.metrics.interviewsPerApplicantHour);
  const aiSpend = WEEKLY_METRIC_DEFINITIONS.aiSpend;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="product-themed-muted text-sm">
          Weeks run Monday to Sunday, {timeZoneName}. Totals cover the {report.total.label.toLowerCase()} shown.
        </p>
        <nav aria-label="Weeks shown" className="flex gap-2">
          {INSIGHTS_WEEK_OPTIONS.map((option) => (
            <Link
              key={option}
              href={`/insights?weeks=${option}`}
              aria-current={option === weekCount ? "page" : undefined}
              className={`inline-flex min-h-11 shrink-0 items-center whitespace-nowrap rounded-lg border px-3 py-2 text-sm font-semibold ${
                option === weekCount ? "product-primary-action" : "product-secondary-action"
              }`}
            >
              {option} weeks
            </Link>
          ))}
        </nav>
      </div>

      <section data-metric="interviewsPerApplicantHour" className="product-surface rounded-xl border p-5" aria-labelledby="primary-metric-title">
        <p className="product-themed-accent text-xs font-semibold uppercase tracking-[0.08em]">Primary metric</p>
        <h2 id="primary-metric-title" className="product-themed-title mt-1 text-lg font-semibold">{primary.label}</h2>
        <p className="product-themed-title mt-3 text-2xl font-semibold">{primaryResult.value}</p>
        <p className="product-themed-copy mt-1 text-sm">{primaryResult.detail}</p>
        <p className="product-themed-copy mt-3 text-sm">
          Interviews in the {report.total.label.toLowerCase()}: <strong>{report.total.funnel.interviews}</strong>
        </p>
        <HowComputed text={primary.howComputed} />
      </section>

      <Panel tone="branded">
        <PanelHeader title="Weekly funnel" description="Counts per week, newest first. A zero here is a real zero." tone="branded" />
        <div className="overflow-x-auto">
          <table data-table="funnel" className="w-full min-w-[640px] text-left text-sm">
            <caption className="sr-only">Weekly job-search funnel</caption>
            <thead className="product-divider product-themed-muted border-b text-xs uppercase">
              <tr>
                <th scope="col" className="px-5 py-3">Week of</th>
                {FUNNEL_KEYS.map((key) => (
                  <th key={key} scope="col" className="px-5 py-3">{WEEKLY_METRIC_DEFINITIONS[key].label}</th>
                ))}
              </tr>
            </thead>
            <tbody className="product-divider divide-y">
              {newestFirst.map((week) => (
                <tr key={week.label}>
                  <th scope="row" className="product-themed-title px-5 py-3 font-medium">{formatWeekLabel(week)}</th>
                  {FUNNEL_KEYS.map((key) => (
                    <td key={key} className="product-themed-copy px-5 py-3 tabular-nums">{week.funnel[key]}</td>
                  ))}
                </tr>
              ))}
            </tbody>
            <tfoot className="product-divider border-t">
              <tr>
                <th scope="row" className="product-themed-title px-5 py-3 font-semibold">{report.total.label}</th>
                {FUNNEL_KEYS.map((key) => (
                  <td key={key} className="product-themed-title px-5 py-3 font-semibold tabular-nums">{report.total.funnel[key]}</td>
                ))}
              </tr>
            </tfoot>
          </table>
        </div>
        <div className="product-divider border-t">
          <DefinitionList keys={FUNNEL_KEYS} />
        </div>
      </Panel>

      <section aria-labelledby="supporting-metrics-title">
        <h2 id="supporting-metrics-title" className="product-themed-title mb-3 text-sm font-semibold">
          Supporting metrics, {report.total.label.toLowerCase()}
        </h2>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {SUPPORTING_KEYS.map((key) => (
            <MetricTile key={key} metricKey={key} result={report.total.metrics[key]} />
          ))}
          <div data-metric="aiSpend" className="product-surface rounded-xl border p-4">
            <p className="product-themed-accent text-xs font-semibold uppercase tracking-[0.08em]">{aiSpend.label}</p>
            <p className="product-themed-title mt-2 text-2xl font-semibold">{formatAiSpend(report.total.aiSpend)}</p>
            <p className="product-themed-copy mt-1 text-xs">{plural(report.total.aiSpend.requests, "AI request", "AI requests")}</p>
            <HowComputed text={aiSpend.howComputed} />
          </div>
        </div>
      </section>

      <Panel tone="branded">
        <PanelHeader title="Supporting metrics by week" description="Small weekly samples swing a lot; read them with the counts beside them." tone="branded" />
        <div className="overflow-x-auto">
          <table data-table="supporting" className="w-full min-w-[860px] text-left text-sm">
            <caption className="sr-only">Supporting metrics by week</caption>
            <thead className="product-divider product-themed-muted border-b text-xs uppercase">
              <tr>
                <th scope="col" className="px-5 py-3">Week of</th>
                {SUPPORTING_TABLE_KEYS.map((key) => (
                  <th key={key} scope="col" className="px-5 py-3">{WEEKLY_METRIC_DEFINITIONS[key].label}</th>
                ))}
                <th scope="col" className="px-5 py-3">{aiSpend.label}</th>
                <th scope="col" className="px-5 py-3">{WEEKLY_METRIC_DEFINITIONS.aiCostPerApplication.label}</th>
              </tr>
            </thead>
            <tbody className="product-divider divide-y">
              {newestFirst.map((week) => (
                <tr key={week.label}>
                  <th scope="row" className="product-themed-title px-5 py-3 font-medium">{formatWeekLabel(week)}</th>
                  {SUPPORTING_TABLE_KEYS.map((key) => (
                    <td key={key} className="product-themed-copy px-5 py-3 tabular-nums">{formatTableCell(week.metrics[key])}</td>
                  ))}
                  <td className="product-themed-copy px-5 py-3 tabular-nums">{formatAiSpend(week.aiSpend)}</td>
                  <td className="product-themed-copy px-5 py-3 tabular-nums">{formatTableCell(week.metrics.aiCostPerApplication)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      {report.dataNotes.length ? (
        <section data-section="data-notes" className="product-callout-warning rounded-xl border p-4 text-sm" aria-labelledby="data-notes-title">
          <h2 id="data-notes-title" className="font-semibold">What the numbers can&apos;t place</h2>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            {report.dataNotes.map((note) => <li key={note}>{note}</li>)}
          </ul>
        </section>
      ) : null}

      <section data-section="not-measured" className="product-callout-neutral rounded-xl border p-4 text-sm" aria-labelledby="not-measured-title">
        <h2 id="not-measured-title" className="font-semibold">Not measured yet</h2>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          {NOT_MEASURED_ITEMS.map((item) => <li key={item}>{item}</li>)}
        </ul>
        {report.hiddenWeeks ? (
          <p className="mt-3">
            {report.hiddenWeeks === 1 ? "1 earlier week is" : `${report.hiddenWeeks} earlier weeks are`} not shown because
            {report.hiddenWeeks === 1 ? " it comes" : " they come"} before your first recorded activity.
          </p>
        ) : null}
      </section>
    </div>
  );
}
