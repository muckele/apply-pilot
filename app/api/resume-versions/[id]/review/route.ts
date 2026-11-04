import { createDocumentReviewHandler } from "@/lib/documents/document-edit-routes";
import { resumeVersionEditTransaction } from "@/lib/documents/document-edit-store";
import { checkRateLimit } from "@/lib/security/rate-limit";
import { requireUserId } from "@/lib/user-context";

// The owner confirms a flagged edit ("I confirm this is accurate") or a legacy document as a whole.
export const POST = createDocumentReviewHandler({
  requireUserId,
  checkRateLimit,
  transaction: resumeVersionEditTransaction
}, "RESUME");
