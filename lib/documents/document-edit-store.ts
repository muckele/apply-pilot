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
    writeAudit: audit(tx, "GeneratedDocument")
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
    writeAudit: audit(tx, "ResumeVersion")
  }));
