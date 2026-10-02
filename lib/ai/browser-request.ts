type AiErrorPayload = {
  error?: string;
  code?: string;
  maximumCostMicros?: number;
  provider?: string;
  dataType?: string;
};

function formatUsdMicros(micros: number) {
  return `$${(micros / 1_000_000).toFixed(6).replace(/0+$/, "").replace(/\.$/, "")}`;
}

export async function fetchWithAiCostConfirmation(input: RequestInfo | URL, init?: RequestInit) {
  const response = await fetch(input, init);
  if (response.status !== 428) return response;

  const details = (await response.clone().json().catch(() => null)) as AiErrorPayload | null;
  if (details?.code !== "AI_COST_CONFIRMATION_REQUIRED") return response;

  const maximum = typeof details.maximumCostMicros === "number"
    ? formatUsdMicros(details.maximumCostMicros)
    : "more than $0.05";
  const confirmsResumeData = details.dataType === "resume_text";
  const provider = details.provider === "gemini"
    ? "Google Gemini"
    : details.provider === "openai"
      ? "OpenAI"
      : "the configured AI provider";
  const confirmed = window.confirm(
    confirmsResumeData
      ? `Your complete resume text will be sent to ${provider} for structured parsing. This AI request could cost up to ${maximum}; the final charge is usually lower. Your current master resume will not change unless the parsed result passes validation and is saved. Continue?`
      : `This AI request could cost up to ${maximum}. The final charge is usually lower. Continue?`
  );
  if (!confirmed) {
    throw new Error("AI request canceled before any provider charge was made.");
  }

  const headers = new Headers(init?.headers);
  headers.set("x-ai-cost-confirmed", "true");
  if (confirmsResumeData) headers.set("x-ai-data-confirmed", "true");
  return fetch(input, { ...init, headers });
}
