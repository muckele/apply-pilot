import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { PublicApiError } from "@/lib/api-errors";
import { prisma } from "@/lib/prisma";
import { checkRateLimit } from "@/lib/security/rate-limit";
import { apiErrorResponse, requireUserId } from "@/lib/user-context";

const emptyStringToUndefined = (value: unknown) => (value === "" ? undefined : value);

const contactCreateSchema = z
  .object({
    jobPostingId: z.string().optional(),
    applicationId: z.string().optional(),
    name: z.string().trim().min(1).max(160),
    email: z.preprocess(emptyStringToUndefined, z.string().trim().email().optional()),
    role: z.preprocess(emptyStringToUndefined, z.string().trim().max(160).optional()),
    profileUrl: z.preprocess(emptyStringToUndefined, z.string().trim().url().optional()),
    notes: z.preprocess(emptyStringToUndefined, z.string().trim().max(2000).optional())
  })
  .refine((input) => input.jobPostingId || input.applicationId, {
    message: "Link the contact to a job or application."
  });

export async function POST(request: NextRequest) {
  try {
    const userId = await requireUserId();
    await checkRateLimit(`contacts:create:${userId}`, 50, 60_000);
    const input = contactCreateSchema.parse(await request.json());
    const [job, application] = await Promise.all([
      input.jobPostingId ? prisma.jobPosting.findFirstOrThrow({ where: { id: input.jobPostingId, userId } }) : null,
      input.applicationId
        ? prisma.application.findFirstOrThrow({
            where: { id: input.applicationId, userId },
            include: { jobPosting: true }
          })
        : null
    ]);

    const linkedJobPostingId = job?.id ?? application?.jobPostingId;
    if (job && application && job.id !== application.jobPostingId) {
      throw new PublicApiError("The selected application does not belong to the selected job.", 400);
    }

    const contact = await prisma.$transaction(async (tx) => {
      const savedContact = await tx.contact.create({
        data: {
          userId,
          jobPostingId: linkedJobPostingId,
          applicationId: application?.id,
          name: input.name,
          email: input.email,
          company: job?.company ?? application?.jobPosting.company,
          role: input.role,
          profileUrl: input.profileUrl,
          notes: input.notes
        }
      });

      await tx.auditLog.create({
        data: {
          userId,
          action: "contact.create",
          resource: "Contact",
          resourceId: savedContact.id,
          metadata: { jobPostingId: linkedJobPostingId, applicationId: application?.id ?? null }
        }
      });

      return savedContact;
    });

    return NextResponse.json({ contact });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
