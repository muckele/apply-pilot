import { PublicApiError } from "@/lib/api-errors";

export type DeferredAiFeature = "EMAIL_REPLY" | "INTERVIEW_PREP" | "INTERVIEW_FEEDBACK";

const deferredFeatureLabels: Record<DeferredAiFeature, string> = {
  EMAIL_REPLY: "AI email drafting",
  INTERVIEW_PREP: "AI interview preparation",
  INTERVIEW_FEEDBACK: "AI interview feedback"
};

export function deferredAiFeatureError(feature: DeferredAiFeature) {
  return new PublicApiError(`${deferredFeatureLabels[feature]} is deferred for this MVP.`, 503, {
    code: "AI_FEATURE_DEFERRED",
    feature,
    retryable: false
  });
}
