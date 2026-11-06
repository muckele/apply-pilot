import { PageHeader } from "@/components/ui";
import { WeeklyMetricsReportView, resolveInsightsWeekCount } from "@/components/weekly-metrics-report";
import { loadWeeklyMetrics } from "@/lib/metrics/weekly-metrics-loader";
import { requirePageUserId } from "@/lib/page-context";
import { prisma } from "@/lib/prisma";

type InsightsPageProps = {
  searchParams?: Promise<{ weeks?: string | string[] }>;
};

export default async function InsightsPage({ searchParams }: InsightsPageProps) {
  const userId = await requirePageUserId();
  const params = (await searchParams) ?? {};
  const weekCount = resolveInsightsWeekCount(params.weeks);
  const report = await loadWeeklyMetrics(prisma, { userId, now: new Date(), weekCount });

  return (
    <div className="product-page product-page-themed">
      <PageHeader
        title="Insights"
        description="Weekly numbers for your own job search, counted from what you have recorded in Apply Pilot. Interviews per hour of effort is the number that matters most; application counts come second."
        tone="branded"
      />
      <WeeklyMetricsReportView report={report} weekCount={weekCount} />
    </div>
  );
}
