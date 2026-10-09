import { deferredAiFeatureError } from "@/lib/ai/deferred-features";
import { checkRateLimit } from "@/lib/security/rate-limit";
import { apiErrorResponse, requireUserId } from "@/lib/user-context";

export async function POST() {
  try {
    const userId = await requireUserId();
    await checkRateLimit(`email-draft:${userId}`, 20, 60_000);
    throw deferredAiFeatureError("EMAIL_REPLY");
  } catch (error) {
    return apiErrorResponse(error);
  }
}
