import { APPLICATION_DOCUMENT_MODEL, APPLICATION_DOCUMENT_PROMPT_VERSION } from "@/lib/ai/application-document-version";
import { JOB_MATCH_MODEL } from "@/lib/ai/job-match-version";
import { AI_FEATURE_POLICIES, type AiFeature } from "@/lib/ai/policy";
import { estimateAiCostMicros } from "@/lib/ai/pricing";
import type { DocumentCreationQuote } from "@/lib/jobs/document-creation-plan";

// Server-side quote for the one combined confirmation. Same formula as the guarded requests'
// own maxima (policy token bounds at the registered price); the requests still compute and
// enforce their own maximum, and fetchWithApprovedAiCost asks again if theirs is higher.
function maximum(feature: AiFeature, model: string, now: Date | undefined) {
  const policy = AI_FEATURE_POLICIES[feature];
  return estimateAiCostMicros({ model, inputTokens: policy.maxInputTokens, outputTokens: policy.maxOutputTokens, now });
}

export function buildDocumentCreationQuote(now?: Date): DocumentCreationQuote | null {
  try {
    return {
      provider: "gemini",
      model: APPLICATION_DOCUMENT_MODEL,
      promptVersion: APPLICATION_DOCUMENT_PROMPT_VERSION,
      jobMatchMicros: maximum("JOB_MATCH", JOB_MATCH_MODEL, now),
      resumeMicros: maximum("RESUME_TAILOR", APPLICATION_DOCUMENT_MODEL, now),
      coverMicros: maximum("COVER_LETTER", APPLICATION_DOCUMENT_MODEL, now)
    };
  } catch {
    return null;
  }
}
