import type { Prisma } from "@prisma/client";

import {
  APPLICATION_DETAIL_FIELDS,
  buildApplicationDetailsView,
  planApplicationDetailsSave,
  type ApplicationDetailRow,
  type ApplicationDetailsInput,
  type ApplicationDetailsView
} from "@/lib/application-details";
import { normalizeText } from "@/lib/normalize";
import { prisma } from "@/lib/prisma";

type Db = Prisma.TransactionClient | typeof prisma;

const CANONICAL_QUESTIONS = APPLICATION_DETAIL_FIELDS.map((field) => normalizeText(field.question));

async function detailRows(db: Db, userId: string): Promise<ApplicationDetailRow[]> {
  return db.applicationAnswer.findMany({
    where: {
      userId,
      OR: [{ category: { in: ["CONTACT", "LINKS"] } }, { normalizedQuestion: { in: CANONICAL_QUESTIONS } }]
    },
    select: {
      id: true,
      category: true,
      question: true,
      normalizedQuestion: true,
      answer: true,
      sensitive: true,
      isActive: true,
      updatedAt: true
    },
    orderBy: { id: "asc" }
  });
}

// The master résumé's parsed contact block, else the most recently parsed one.
async function resumeContactInfo(db: Db, userId: string): Promise<unknown> {
  const resumes = await db.resume.findMany({
    where: { userId },
    select: { contactInfo: true },
    orderBy: [{ isMaster: "desc" }, { updatedAt: "desc" }],
    take: 5
  });
  return resumes.find((resume) => resume.contactInfo && typeof resume.contactInfo === "object")?.contactInfo ?? null;
}

export async function loadApplicationDetails(userId: string): Promise<ApplicationDetailsView> {
  const [rows, contactInfo] = await Promise.all([detailRows(prisma, userId), resumeContactInfo(prisma, userId)]);
  return buildApplicationDetailsView({ contactInfo, rows });
}

export async function saveApplicationDetails(
  userId: string,
  input: ApplicationDetailsInput
): Promise<ApplicationDetailsView> {
  await prisma.$transaction(async (tx) => {
    const plan = planApplicationDetailsSave(input, await detailRows(tx, userId));
    for (const create of plan.creates) {
      await tx.applicationAnswer.create({ data: { userId, ...create } });
    }
    for (const { id, ...data } of plan.updates) {
      await tx.applicationAnswer.update({ where: { id, userId }, data });
    }
    if (plan.deactivateIds.length > 0) {
      await tx.applicationAnswer.updateMany({
        where: { userId, id: { in: plan.deactivateIds } },
        data: { isActive: false }
      });
    }
    // Which details were confirmed and how many rows changed; never the values themselves.
    await tx.auditLog.create({
      data: {
        userId,
        action: "application-details.confirm",
        resource: "ApplicationAnswer",
        metadata: {
          confirmed: APPLICATION_DETAIL_FIELDS.filter((field) => input[field.key]).map((field) => field.key),
          created: plan.creates.length,
          updated: plan.updates.length,
          turnedOff: plan.deactivateIds.length
        }
      }
    });
  });
  return loadApplicationDetails(userId);
}
