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
  email_reply_packet: "The email text and the linked job title and company",
  mock_interview_questions_packet: "Your master-resume facts and lines from the linked job post",
  mock_interview_answer_packet: "Your practice answer, the question, and your master-resume facts"
};

function formatUsdMicros(micros: number) {
  return `$${(micros / 1_000_000).toFixed(6).replace(/0+$/, "").replace(/\.$/, "")}`;
}

// May be async: the in-page question resolves when the user presses Confirm or Cancel.
export type ConfirmFn = (message: string) => boolean | Promise<boolean>;

type ApprovedAiCostDependencies = {
  fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  confirm?: ConfirmFn;
};

// For a step the user already approved as part of one combined confirmation. The request is
// first sent unconfirmed, so the server still decides whether confirmation is needed and states
// its own maximum. If that maximum is within what the user approved for this step, the request
// is resent with the confirmation headers; if it is higher, the user is asked again.
export async function fetchWithApprovedAiCost(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  approvedMaximumMicros: number,
  dependencies: ApprovedAiCostDependencies = {}
) {
  const fetchImpl = dependencies.fetchImpl ?? ((request, options) => fetch(request, options));
  const confirm = dependencies.confirm ?? ((message: string) => window.confirm(message));
  const response = await fetchImpl(input, init);
  if (response.status !== 428) return response;

  const details = (await response.clone().json().catch(() => null)) as AiErrorPayload | null;
  if (details?.code !== "AI_COST_CONFIRMATION_REQUIRED") return response;

  const maximum = typeof details.maximumCostMicros === "number" ? details.maximumCostMicros : null;
  if (maximum === null || maximum > approvedMaximumMicros) {
    const confirmed = await confirm(
      `This step could cost up to ${maximum === null ? "an unstated amount" : formatUsdMicros(maximum)}, more than the ${formatUsdMicros(approvedMaximumMicros)} you approved for it. The final charge is usually lower. Continue?`
    );
    if (!confirmed) throw new Error("AI request canceled before any provider charge was made.");
  }

  const headers = new Headers(init?.headers);
  headers.set("x-ai-cost-confirmed", "true");
  if (details.dataType) headers.set("x-ai-data-confirmed", "true");
  return fetchImpl(input, { ...init, headers });
}

export async function fetchWithAiCostConfirmation(
  input: RequestInfo | URL,
  init?: RequestInit,
  dependencies: ApprovedAiCostDependencies = {}
) {
  const fetchImpl = dependencies.fetchImpl ?? ((request, options) => fetch(request, options));
  const confirm = dependencies.confirm ?? ((message: string) => window.confirm(message));
  const response = await fetchImpl(input, init);
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
  const confirmed = await confirm(
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
  return fetchImpl(input, { ...init, headers });
}
