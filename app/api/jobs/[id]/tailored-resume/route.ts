import { tailorResume } from "@/lib/ai/resume";
import { readApplicationDocumentEvidence } from "@/lib/jobs/application-document-evidence";
import { createTailoredResumeRouteHandler } from "@/lib/jobs/application-document-generation-routes";
import { prisma } from "@/lib/prisma";
import { writeAuditLog } from "@/lib/security/audit-log";
import { checkRateLimit } from "@/lib/security/rate-limit";
import { requireUserId } from "@/lib/user-context";

export const POST = createTailoredResumeRouteHandler({
  prismaClient: prisma,
  requireUserId,
  checkRateLimit,
  readApplicationDocumentEvidence,
  tailorResume,
  writeAuditLog
});
