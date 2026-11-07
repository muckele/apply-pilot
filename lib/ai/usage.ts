// Compatibility module. There is one AI budget: the hard monthly ledger in
// lib/ai/application-plan-budget.ts. The former soft check (a user-editable
// monthlyBudgetCents compared against aggregated usage events, which could be set to
// $1,000) and its environment-priced OpenAI cost estimate are removed.
export { hashAiInput } from "@/lib/ai/input-hash";
export { getMonthlyAiUsage, getOrCreateAiSettings } from "@/lib/ai/application-plan-budget";
