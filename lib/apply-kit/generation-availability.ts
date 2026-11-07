import { getAiProviderForFeature, getAiRuntimeMode } from "@/lib/ai/config";

// The Apply Kit offers the existing generation routes only when a real provider would serve both
// document features. This reads configuration only; it never calls a provider.
export function isDocumentGenerationAvailable() {
  try {
    return (["RESUME_TAILOR", "COVER_LETTER"] as const).every(
      (feature) => getAiRuntimeMode(getAiProviderForFeature(feature)) !== "local"
    );
  } catch {
    return false;
  }
}
