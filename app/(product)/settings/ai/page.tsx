import { AiSettingsPanel } from "@/components/ai-settings-panel";
import { MetricCard, PageHeader, Panel, PanelHeader, StatusBadge } from "@/components/ui";
import { getAllowedOpenAIModels } from "@/lib/ai/client";
import { getMonthlyAiUsage, getOrCreateAiSettings } from "@/lib/ai/usage";
import { requirePageUserId } from "@/lib/page-context";
import { prisma } from "@/lib/prisma";

function formatCost(micros: number | null) {
  if (micros === null) return "Not configured";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 4 }).format(
    micros / 1_000_000
  );
}

export default async function AiSettingsPage() {
  const userId = await requirePageUserId();
  const [settings, usage, recent] = await Promise.all([
    getOrCreateAiSettings(userId),
    getMonthlyAiUsage(userId),
    prisma.aIUsageEvent.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: 20
    })
  ]);
  const pricingConfigured = Boolean(
    process.env.OPENAI_INPUT_COST_PER_1M_USD && process.env.OPENAI_OUTPUT_COST_PER_1M_USD
  );

  return (
    <>
      <PageHeader
        title="AI usage controls"
        description="Bound discovery volume, track prompt versions and token usage, and prevent unexpected model spend."
        action={<StatusBadge status={settings.aiDiscoveryEnabled ? "Discovery AI enabled" : "Manual AI only"} />}
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard label="Requests this month" value={usage.requestCount} />
        <MetricCard label="Input tokens" value={usage.inputTokens.toLocaleString()} />
        <MetricCard label="Output tokens" value={usage.outputTokens.toLocaleString()} />
        <MetricCard
          label="Estimated cost"
          value={formatCost(usage.estimatedCostMicros)}
          detail={pricingConfigured ? `$${(settings.monthlyBudgetCents / 100).toFixed(2)} monthly limit` : "Add pricing env vars to enforce a dollar limit"}
        />
      </div>

      <Panel className="mt-6">
        <PanelHeader title="Limits and model" description="A zero per-sync limit disables automatic AI analysis without disabling manual actions." />
        <AiSettingsPanel
          initialSettings={{
            monthlyBudgetCents: settings.monthlyBudgetCents,
            maxAnalysesPerSync: settings.maxAnalysesPerSync,
            aiDiscoveryEnabled: settings.aiDiscoveryEnabled,
            modelOverride: settings.modelOverride
          }}
          allowedModels={getAllowedOpenAIModels()}
        />
      </Panel>

      <Panel className="mt-6">
        <PanelHeader title="Recent AI requests" description="Usage metadata only; raw resumes, job descriptions, and prompts are not repeated here." />
        <div className="divide-y divide-slate-100">
          {recent.length ? (
            recent.map((event) => (
              <div key={event.id} className="grid gap-2 px-5 py-4 text-sm sm:grid-cols-[1fr_180px_150px] sm:items-center">
                <div>
                  <p className="font-semibold text-slate-950">{event.feature.replaceAll("_", " ")}</p>
                  <p className="mt-1 text-xs text-slate-500">
                    {event.promptName} v{event.promptVersion} · {event.model}
                  </p>
                </div>
                <p className="text-xs text-slate-600">
                  {event.inputTokens.toLocaleString()} in · {event.outputTokens.toLocaleString()} out
                  {event.cachedInputTokens ? ` · ${event.cachedInputTokens.toLocaleString()} cached` : ""}
                </p>
                <div className="text-left sm:text-right">
                  <p className="text-xs font-semibold text-slate-700">{formatCost(event.estimatedCostMicros)}</p>
                  <p className="mt-1 text-xs text-slate-500">{event.createdAt.toLocaleString()}</p>
                </div>
              </div>
            ))
          ) : (
            <div className="p-8 text-center text-sm text-slate-600">No tracked AI requests yet.</div>
          )}
        </div>
      </Panel>
    </>
  );
}
