import { AiSettingsPanel } from "@/components/ai-settings-panel";
import { MetricCard, PageHeader, Panel, PanelHeader, StatusBadge } from "@/components/ui";
import { getMonthlyAiUsage, getOrCreateAiSettings } from "@/lib/ai/application-plan-budget";
import { getAiAvailability, getAiFinancialPolicy, getAllowedAiModels } from "@/lib/ai/config";
import { getAiPricingStatus, type AiPricingStatus } from "@/lib/ai/pricing";
import { effectiveMonthlyBudgetCents } from "@/lib/ai/settings";
import { requirePageUserId } from "@/lib/page-context";
import { prisma } from "@/lib/prisma";

function formatCost(micros: number | null) {
  if (micros === null) return "Not configured";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 4 }).format(
    micros / 1_000_000
  );
}

function formatPricingDate(value: string | null) {
  return value
    ? new Date(value).toLocaleDateString("en-US", { dateStyle: "medium", timeZone: "UTC" })
    : "No end date";
}

function pricingStatusLabel(entry: AiPricingStatus) {
  switch (entry.status) {
    case "expired":
      return "Pricing expired: AI requests on this model are disabled";
    case "expiring_soon":
      return `Pricing expires in ${entry.daysRemaining} day${entry.daysRemaining === 1 ? "" : "s"}`;
    case "not_yet_effective":
      return "Pricing not yet effective";
    case "open_ended":
      return "No registered expiry";
    default:
      return `Pricing current for ${entry.daysRemaining} more days`;
  }
}

const unavailableReasons = {
  disabled: "AI is turned off on this server (AI_ENABLED is not true, or AI mock mode is on).",
  not_configured: "Gemini is not configured on this server (GEMINI_API_KEY is missing).",
  unsupported_provider: "AI_PROVIDER selects a retired provider. Gemini is the only supported AI provider."
} as const;

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
  const availability = getAiAvailability();
  const { hardCapCents } = getAiFinancialPolicy();
  const effectiveBudgetCents = effectiveMonthlyBudgetCents(settings.monthlyBudgetCents);
  const pricing = getAiPricingStatus().filter((entry) => entry.validUntil);
  return (
    <>
      <PageHeader
        title="AI usage controls"
        description="Every AI feature runs on Google Gemini through one hard monthly budget. Track prompt versions and token usage, and prevent unexpected model spend."
        action={<StatusBadge status={settings.aiDiscoveryEnabled ? "Discovery AI enabled" : "Manual AI only"} />}
      />

      <Panel className="mb-6">
        <PanelHeader
          title={availability.available ? "AI available: Google Gemini" : "AI unavailable"}
          description={availability.available
            ? "Resume parsing, job matching, tailored documents, interview prep and feedback, email drafts, and application plans all use Gemini and reserve against the same budget ledger."
            : `${unavailableReasons[availability.reason]} AI features stay off and never fall back to template output.`}
        />
        <div className="divide-y divide-slate-100">
          {pricing.map((entry) => (
            <div key={entry.model} className="grid gap-1 px-5 py-3 text-sm sm:grid-cols-[1fr_auto] sm:items-center">
              <p className="font-semibold text-slate-950">{entry.model}</p>
              <p className={entry.status === "current" ? "text-xs text-slate-600" : "text-xs font-semibold text-amber-700"}>
                {pricingStatusLabel(entry)} · registered through {formatPricingDate(entry.validUntil)}
              </p>
            </div>
          ))}
        </div>
      </Panel>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard label="Requests this month" value={usage.requestCount} />
        <MetricCard label="Input tokens" value={usage.inputTokens.toLocaleString()} />
        <MetricCard label="Output tokens" value={usage.outputTokens.toLocaleString()} />
        <MetricCard
          label="Spent this month"
          value={formatCost(usage.estimatedCostMicros)}
          detail={`$${(effectiveBudgetCents / 100).toFixed(2)} monthly budget (hard cap $${(hardCapCents / 100).toFixed(2)}); ${formatCost(usage.remainingMicros)} remaining`}
        />
      </div>

      <Panel className="mt-6">
        <PanelHeader
          title="Limits and model"
          description="A zero per-sync limit disables automatic AI analysis without disabling manual actions. The monthly budget cannot exceed the hard cap. Model overrides apply only to resume parsing; other features stay pinned to their reviewed Gemini model."
        />
        <AiSettingsPanel
          initialSettings={{
            monthlyBudgetCents: effectiveBudgetCents,
            maxAnalysesPerSync: settings.maxAnalysesPerSync,
            aiDiscoveryEnabled: settings.aiDiscoveryEnabled,
            modelOverride: settings.modelOverride
          }}
          allowedModels={getAllowedAiModels()}
          maxMonthlyBudgetCents={hardCapCents}
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
