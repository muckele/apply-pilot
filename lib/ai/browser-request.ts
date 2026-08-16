type AiErrorPayload = {
  error?: string;
  code?: string;
  maximumCostMicros?: number;
};

export async function fetchWithAiCostConfirmation(input: RequestInfo | URL, init?: RequestInit) {
  const response = await fetch(input, init);
  if (response.status !== 428) return response;

  const details = (await response.json().catch(() => null)) as AiErrorPayload | null;
  if (details?.code !== "AI_COST_CONFIRMATION_REQUIRED") return response;

  const maximum = typeof details.maximumCostMicros === "number"
    ? `$${(details.maximumCostMicros / 1_000_000).toFixed(3)}`
    : "more than $0.05";
  const confirmed = window.confirm(
    `This AI request could cost up to ${maximum}. The final charge is usually lower. Continue?`
  );
  if (!confirmed) {
    throw new Error("AI request canceled before any provider charge was made.");
  }

  const headers = new Headers(init?.headers);
  headers.set("x-ai-cost-confirmed", "true");
  return fetch(input, { ...init, headers });
}
