import { deferredAiFeatureError } from "@/lib/ai/deferred-features";
import { checkRateLimit } from "@/lib/security/rate-limit";
import { apiErrorResponse, requireUserId } from "@/lib/user-context";

export async function POST() {
  try {
    const userId = await requireUserId();
    await checkRateLimit(`interview-feedback:${userId}`, 12, 60_000);
    throw deferredAiFeatureError("INTERVIEW_FEEDBACK");
  } catch (error) {
    return apiErrorResponse(error);
  }
}
