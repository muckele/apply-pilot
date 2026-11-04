import { createGeneratedDocumentPatchHandler } from "@/lib/documents/document-edit-routes";
import { generatedDocumentEditTransaction } from "@/lib/documents/document-edit-store";
import { checkRateLimit } from "@/lib/security/rate-limit";
import { requireUserId } from "@/lib/user-context";

// Content edits clear the exact generated-evidence binding and record per-line provenance (D031).
export const PATCH = createGeneratedDocumentPatchHandler({
  requireUserId,
  checkRateLimit,
  transaction: generatedDocumentEditTransaction
});
