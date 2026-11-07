import { prisma } from "@/lib/prisma";
import { CURRENT_EVIDENCE_SNAPSHOT_SELECT } from "@/lib/jobs/evidence-snapshot-contracts";
import { checkRateLimit } from "@/lib/security/rate-limit";
import { requireUserId } from "@/lib/user-context";
import { createDocumentExportRouteHandlers } from "@/lib/documents/document-export-route";

const exportJobEvidenceSelect = {
  currentEvidenceSnapshotId: true,
  evidenceSnapshotGeneration: true,
  currentEvidenceSnapshot: { select: CURRENT_EVIDENCE_SNAPSHOT_SELECT },
  user: {
    select: {
      resumes: {
        where: { isMaster: true },
        orderBy: { updatedAt: "desc" as const },
        take: 1,
        select: { id: true, updatedAt: true }
      }
    }
  }
} as const;

const handlers = createDocumentExportRouteHandlers({
  requireUserId,
  checkRateLimit,
  findGeneratedDocument: async ({ id, userId }) => {
    const initial = await prisma.generatedDocument.findFirst({
      where: { id, userId },
      select: { jobPostingId: true }
    });
    if (!initial) return null;
    return prisma.$transaction(async (tx) => {
      if (initial.jobPostingId) {
        const locked = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM "JobPosting"
          WHERE "id" = ${initial.jobPostingId} AND "userId" = ${userId}
          FOR SHARE
        `;
        if (locked.length !== 1) return null;
      }
      return tx.generatedDocument.findFirst({
        where: { id, userId, jobPostingId: initial.jobPostingId },
        include: { jobPosting: { select: exportJobEvidenceSelect } }
      });
    });
  },
  findResumeVersion: async ({ id, userId }) => {
    const initial = await prisma.resumeVersion.findFirst({
      where: { id, userId },
      select: { jobPostingId: true }
    });
    if (!initial) return null;
    return prisma.$transaction(async (tx) => {
      if (initial.jobPostingId) {
        const locked = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM "JobPosting"
          WHERE "id" = ${initial.jobPostingId} AND "userId" = ${userId}
          FOR SHARE
        `;
        if (locked.length !== 1) return null;
      }
      return tx.resumeVersion.findFirst({
        where: { id, userId, jobPostingId: initial.jobPostingId },
        include: { jobPosting: { select: exportJobEvidenceSelect } }
      });
    });
  }
});

export const POST = handlers.POST;
