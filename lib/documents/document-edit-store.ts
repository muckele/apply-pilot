import type { Prisma } from "@prisma/client";

import type {
  EditableDocumentRouteDependencies,
  EditableDocumentTransaction
} from "@/lib/documents/document-edit-routes";
import { prisma } from "@/lib/prisma";

function audit(tx: Prisma.TransactionClient, resource: "GeneratedDocument" | "ResumeVersion"): EditableDocumentTransaction["writeAudit"] {
  return async ({ userId, action, resourceId, metadata }) => {
    await tx.auditLog.create({
      data: { userId, action, resource, resourceId, metadata: metadata as Prisma.InputJsonValue }
    });
  };
}

// The owner's evidence snapshot and the master résumé it was saved against, both by userId.
function reviewSources(tx: Prisma.TransactionClient): EditableDocumentTransaction["findReviewSources"] {
  return async ({ evidenceSnapshotId, userId }) => {
    const row = await tx.evidenceSnapshot.findFirst({
      where: { id: evidenceSnapshotId, userId },
      select: {
        id: true,
        reviewPayload: true,
        sourceResumeUpdatedAt: true,
        resume: { select: { userId: true, updatedAt: true, workHistory: true, projects: true } }
      }
    });
    if (!row) return null;
    const { resume, ...snapshot } = row;
    return {
      snapshot,
      resume: resume.userId === userId
        ? { updatedAt: resume.updatedAt, workHistory: resume.workHistory, projects: resume.projects }
        : null
    };
  };
}

// Prisma adapter: the row is locked by (id, userId) before it is read, so reads, provenance
// computation and writes for one document are serialized and never cross users.
export const generatedDocumentEditTransaction: EditableDocumentRouteDependencies["transaction"] = (work) =>
  prisma.$transaction(async (tx) => work({
    async findOwnedForUpdate({ id, userId }) {
      const locked = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "GeneratedDocument" WHERE "id" = ${id} AND "userId" = ${userId} FOR UPDATE
      `;
      if (locked.length !== 1) return null;
      const row = await tx.generatedDocument.findFirst({
        where: { id, userId },
        select: { id: true, userId: true, content: true, evidenceSnapshotId: true, metadata: true }
      });
      return row;
    },
    async update({ id, userId, data }) {
      const result = await tx.generatedDocument.updateMany({
        where: { id, userId },
        data: data as Prisma.GeneratedDocumentUncheckedUpdateManyInput
      });
      if (result.count !== 1) throw new Error("Owned generated document update failed.");
      return tx.generatedDocument.findFirstOrThrow({ where: { id, userId } });
    },
    writeAudit: audit(tx, "GeneratedDocument"),
    findReviewSources: reviewSources(tx)
  }));

export const resumeVersionEditTransaction: EditableDocumentRouteDependencies["transaction"] = (work) =>
  prisma.$transaction(async (tx) => work({
    async findOwnedForUpdate({ id, userId }) {
      const locked = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "ResumeVersion" WHERE "id" = ${id} AND "userId" = ${userId} FOR UPDATE
      `;
      if (locked.length !== 1) return null;
      const row = await tx.resumeVersion.findFirst({
        where: { id, userId },
        select: {
          id: true,
          userId: true,
          fullText: true,
          evidenceSnapshotId: true,
          metadata: true,
          summary: true,
          skills: true
        }
      });
      if (!row) return null;
      const { fullText, ...rest } = row;
      return { ...rest, content: fullText };
    },
    async update({ id, userId, data }) {
      const result = await tx.resumeVersion.updateMany({
        where: { id, userId },
        data: data as Prisma.ResumeVersionUncheckedUpdateManyInput
      });
      if (result.count !== 1) throw new Error("Owned resume version update failed.");
      return tx.resumeVersion.findFirstOrThrow({ where: { id, userId } });
    },
    writeAudit: audit(tx, "ResumeVersion"),
    findReviewSources: reviewSources(tx)
  }));
