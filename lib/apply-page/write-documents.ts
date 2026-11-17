import { fetchWithAiConsent } from "@/lib/ai/browser-request";
import { aiErrorText, type AiErrorPayload } from "@/lib/apply-page/ai-error-text";

// One tailored document for the Apply page, in one consented request (D037): step 3's Write buttons
// and the result window's "Create my résumé and cover letter" both use it.
export type WriteStep = "resume" | "cover";

const ENDPOINTS: Record<WriteStep, string> = { resume: "tailored-resume", cover: "cover-letter" };
const FAILED: Record<WriteStep, string> = { resume: "Writing your tailored résumé failed.", cover: "Writing your cover letter failed." };

export async function writeDocument(jobId: string, step: WriteStep): Promise<void> {
  const response = await fetchWithAiConsent(`/api/jobs/${jobId}/${ENDPOINTS[step]}`, { method: "POST" });
  if (!response.ok) {
    const json = (await response.json().catch(() => null)) as AiErrorPayload;
    throw new Error(aiErrorText(json, FAILED[step]));
  }
}
