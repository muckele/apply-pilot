type AiErrorPayload = {
  error?: string;
  code?: string;
  maximumCostMicros?: number;
  provider?: string;
  dataType?: string;
  feature?: string;
  model?: string;
  promptVersion?: string;
};

// Data-sharing confirmations for Gemini features that send the user's own records.
const AI_DATA_DESCRIPTIONS: Record<string, string> = {
  interview_prep_packet: "Your master-resume facts and the linked job post",
  interview_notes_packet: "Your interview notes, any pasted transcript, and your master-resume facts",
  email_reply_packet: "The email text and the linked job title and company"
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
  const confirmsApplicationPacket = details.dataType === "application_packet";
  const sharedDataDescription = details.dataType ? AI_DATA_DESCRIPTIONS[details.dataType] : undefined;
  const provider = details.provider === "gemini" ? "Google Gemini" : "the configured AI provider";
  const confirmed = window.confirm(
    confirmsResumeData
      ? `Your complete resume text will be sent to ${provider} for structured parsing. This AI request could cost up to ${maximum}; the final charge is usually lower. Your current master resume will not change unless the parsed result passes validation and is saved. Continue?`
      : confirmsApplicationPacket
        ? `Your projected job, resume, and profile data will be sent to ${provider} to create a ${details.feature === "COVER_LETTER" ? "cover letter" : "tailored resume"} using ${details.model ?? "the configured model"}, prompt/cache version ${details.promptVersion ?? "the configured version"}. This request could cost up to ${maximum}. There is no automatic retry; an uncertain provider outcome may still be billed. Continue?`
        : sharedDataDescription
          ? `${sharedDataDescription} will be sent to ${provider} using ${details.model ?? "the configured model"}. This request could cost up to ${maximum}; the final charge is usually lower. There is no automatic retry; an uncertain provider outcome may still be billed. Continue?`
          : `This AI request could cost up to ${maximum}. The final charge is usually lower. Continue?`
  );
  if (!confirmed) {
    throw new Error("AI request canceled before any provider charge was made.");
  }

  const headers = new Headers(init?.headers);
  headers.set("x-ai-cost-confirmed", "true");
  if (confirmsResumeData || confirmsApplicationPacket || sharedDataDescription) {
    headers.set("x-ai-data-confirmed", "true");
  }
  return fetch(input, { ...init, headers });
}
