import { z } from "zod";

import { getAiFinancialPolicy } from "@/lib/ai/config";

// The ledger enforces min(stored monthlyBudgetCents, hard cap). This mirrors that clamp
// for display so the settings page never shows a spendable budget above the hard cap.
export function effectiveMonthlyBudgetCents(storedMonthlyBudgetCents: number) {
  return Math.max(0, Math.min(storedMonthlyBudgetCents, getAiFinancialPolicy().hardCapCents));
}

export function aiSettingsUpdateSchema() {
  const { hardCapCents } = getAiFinancialPolicy();
  return z.object({
    monthlyBudgetCents: z.coerce.number().int().min(Math.min(100, hardCapCents)).max(hardCapCents, {
      message: `The monthly AI budget cannot exceed the $${(hardCapCents / 100).toFixed(2)} hard cap.`
    }).optional(),
    maxAnalysesPerSync: z.coerce.number().int().min(0).max(25).optional(),
    aiDiscoveryEnabled: z.boolean().optional(),
    modelOverride: z.string().trim().max(100).nullable().optional()
  });
}
