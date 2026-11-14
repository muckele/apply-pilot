// What the Apply page says when an AI step fails. The page never talks about money (D037), so
// server wording about charges and costs is left out or replaced.
export type AiErrorPayload = { error?: unknown; code?: unknown; billingStatus?: unknown; [field: string]: unknown } | null;

const MONEY = /[$¢]|\bcents?\b|\bcharged?\b|\bcost\b/iu;
const LIMIT_CODES: ReadonlySet<string> = new Set(["AI_BUDGET_EXCEEDED"]);

export const MONTHLY_LIMIT_TEXT = "You've reached this month's AI limit.";
export const UNCERTAIN_TEXT = "Apply Pilot can't tell whether this finished. Wait a moment, then reload this page before you try again.";

export function aiErrorText(json: AiErrorPayload, fallback: string): string {
  if (typeof json?.code === "string" && LIMIT_CODES.has(json.code)) return MONTHLY_LIMIT_TEXT;
  if (json?.billingStatus === "uncertain") return UNCERTAIN_TEXT;
  const error = typeof json?.error === "string" ? json.error.trim() : "";
  return error && !MONEY.test(error) ? error : fallback;
}
