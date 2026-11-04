import { draftCoverLetter } from "@/lib/ai/documents";
import { readApplicationDocumentEvidence } from "@/lib/jobs/application-document-evidence";
import { createCoverLetterRouteHandler } from "@/lib/jobs/application-document-generation-routes";
import { prisma } from "@/lib/prisma";
import { writeAuditLog } from "@/lib/security/audit-log";
import { checkRateLimit } from "@/lib/security/rate-limit";
import { requireUserId } from "@/lib/user-context";

export const POST = createCoverLetterRouteHandler({
  prismaClient: prisma,
  requireUserId,
  checkRateLimit,
  readApplicationDocumentEvidence,
  draftCoverLetter,
  writeAuditLog
});
