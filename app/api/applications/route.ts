import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import {
  defaultFollowUpDueAt,
  formatApplicationStatus,
  resolvePostingStatusForApplicationStatus,
  suggestApplicationNextAction
} from "@/lib/applications/pipeline";
import {
  SELF_REPORTED_EFFORT_METADATA_KEY,
  buildSelfReportedEffort,
  effortMinutesSchema
} from "@/lib/applications/self-reported-effort";
import { resolveApplicationPostStatus } from "@/lib/applications/status";
import {
  SENT_DOCUMENTS_METADATA_KEY,
  captureSentDocumentsInTransaction
} from "@/lib/apply-kit/sent-documents";
import {
  applicationDocumentsRequiringCurrentEvidence,
  assertApplicationDocumentEvidenceCurrent,
  resolveEffectiveApplicationDocumentIds
} from "@/lib/applications/document-currentness";
import { PublicApiError } from "@/lib/api-errors";
import {
  CURRENT_EVIDENCE_SNAPSHOT_SELECT,
  resolveCurrentReviewedEvidence
} from "@/lib/jobs/evidence-snapshot-contracts";
import { prisma } from "@/lib/prisma";
import { checkRateLimit } from "@/lib/security/rate-limit";
import { apiErrorResponse, requireUserId } from "@/lib/user-context";

const contentHashSchema = z.string().regex(/^[0-9a-f]{64}$/u);

const createApplicationSchema = z.object({
  jobPostingId: z.string(),
  status: z
    .enum([
      "SAVED",
      "INTERESTED",
      "APPLIED",
      "RECRUITER_SCREEN",
      "HIRING_MANAGER_SCREEN",
      "TECHNICAL_INTERVIEW",
      "FINAL_INTERVIEW",
      "OFFER",
      "REJECTED",
      "GHOSTED",
      "ARCHIVED"
    ])
    .default("SAVED"),
  dateApplied: z.coerce.date().optional(),
  resumeVersionId: z.string().optional(),
  coverLetterVersionId: z.string().nullable().optional(),
  followUpDueAt: z.coerce.date().optional(),
  nextAction: z.string().optional(),
  notes: z.string().optional(),
  // Apply Kit: hashes of the documents the user saw when attesting "I applied" (D031 content hash).
  expectedResumeContentHash: contentHashSchema.optional(),
  expectedCoverLetterContentHash: contentHashSchema.optional(),
  // Apply Kit: the user's own estimate of the minutes this application took (Insights only).
  effortMinutes: effortMinutesSchema.optional()
});

export async function POST(request: NextRequest) {
  try {
    const userId = await requireUserId();
    await checkRateLimit(`applications:create:${userId}`, 40, 60_000);
    const input = createApplicationSchema.parse(await request.json());
    const application = await prisma.$transaction(async (tx) => {
      const lockedJobs = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "JobPosting"
        WHERE "id" = ${input.jobPostingId} AND "userId" = ${userId}
        FOR UPDATE
      `;
      if (lockedJobs.length !== 1) throw new PublicApiError("Job posting not found.", 404);
      const [job, existing, masterResume] = await Promise.all([
        tx.jobPosting.findUniqueOrThrow({
          where: { id: input.jobPostingId },
          include: { currentEvidenceSnapshot: { select: CURRENT_EVIDENCE_SNAPSHOT_SELECT } }
        }),
        tx.application.findUnique({
          where: { userId_jobPostingId: { userId, jobPostingId: input.jobPostingId } }
        }),
        tx.resume.findFirst({
          where: { userId, isMaster: true },
          orderBy: { updatedAt: "desc" },
          select: { id: true, updatedAt: true }
        })
      ]);
      const effective = resolveEffectiveApplicationDocumentIds(input, existing);
      const [resumeVersion, coverLetterVersion] = await Promise.all([
        effective.resumeVersionId
          ? tx.resumeVersion.findFirstOrThrow({
              where: { id: effective.resumeVersionId, userId, jobPostingId: input.jobPostingId }
            })
          : null,
        effective.coverLetterVersionId
          ? tx.generatedDocument.findFirstOrThrow({
              where: {
                id: effective.coverLetterVersionId,
                userId,
                jobPostingId: input.jobPostingId,
                type: "COVER_LETTER"
              }
            })
          : null
      ]);
      const nextStatus = resolveApplicationPostStatus(input.status, existing);
      const evidence = resolveCurrentReviewedEvidence(job, masterResume);
      const requiresCurrent = applicationDocumentsRequiringCurrentEvidence({
        patch: input,
        existingStatus: existing?.status ?? null,
        nextStatus
      });
      assertApplicationDocumentEvidenceCurrent({
        currentEvidenceSnapshotId: job.currentEvidenceSnapshotId,
        currentEvidenceSourceValid: evidence.currentEvidenceSourceValid,
        resumeVersion: requiresCurrent.resumeVersion ? resumeVersion : null,
        coverLetterVersion: requiresCurrent.coverLetterVersion ? coverLetterVersion : null
      });
      // "What I sent": entering APPLIED freezes the exact selected documents into the event.
      const entersApplied = nextStatus === "APPLIED" && existing?.status !== "APPLIED";
      const sentDocuments = entersApplied
        ? await captureSentDocumentsInTransaction(tx, {
            userId,
            jobPostingId: input.jobPostingId,
            currentEvidenceSnapshotId: job.currentEvidenceSnapshotId,
            currentEvidenceSourceValid: evidence.currentEvidenceSourceValid,
            recordedAt: new Date(),
            resumeVersion,
            coverLetterVersion,
            expectedResumeContentHash: input.expectedResumeContentHash,
            expectedCoverLetterContentHash: input.expectedCoverLetterContentHash
          })
        : null;
      const selfReportedEffort = entersApplied && input.effortMinutes !== undefined
        ? buildSelfReportedEffort({ minutes: input.effortMinutes, recordedAt: new Date() })
        : null;

      const statusChanged = !existing || existing.status !== nextStatus;
      const passiveStatusGuarded = Boolean(existing && input.status !== nextStatus);
      const dateApplied =
        nextStatus === "APPLIED" ? (existing?.dateApplied ?? input.dateApplied ?? new Date()) : undefined;
      const requestedNextAction = passiveStatusGuarded ? undefined : input.nextAction;
      const requestedFollowUpDueAt = passiveStatusGuarded ? undefined : input.followUpDueAt;
      const nextAction =
        requestedNextAction ?? (statusChanged ? suggestApplicationNextAction(nextStatus) : existing?.nextAction);
      const followUpDueAt =
        requestedFollowUpDueAt ??
        (statusChanged ? defaultFollowUpDueAt(nextStatus) : existing?.followUpDueAt);
      const postingStatus = resolvePostingStatusForApplicationStatus(nextStatus);
      const eventType =
        !existing ? "CREATED" : existing.status !== nextStatus ? "STATUS_CHANGED" : "NOTE_ADDED";
      const eventTitle =
        !existing
          ? nextStatus === "SAVED"
            ? "Saved to CRM"
            : `Created as ${formatApplicationStatus(nextStatus)}`
          : existing.status !== nextStatus
            ? `Status changed to ${formatApplicationStatus(nextStatus)}`
            : "Application record updated";
      const savedApplication = await tx.application.upsert({
        where: { userId_jobPostingId: { userId, jobPostingId: input.jobPostingId } },
        create: {
          userId,
          jobPostingId: input.jobPostingId,
          status: nextStatus,
          dateApplied,
          resumeVersionId: effective.resumeVersionId,
          coverLetterVersionId: effective.coverLetterVersionId,
          followUpDueAt,
          nextAction,
          notes: input.notes
        },
        update: {
          status: nextStatus,
          dateApplied,
          resumeVersionId: effective.resumeVersionId,
          coverLetterVersionId: effective.coverLetterVersionId,
          followUpDueAt,
          nextAction,
          notes: input.notes
        }
      });

      if (postingStatus) {
        await tx.jobPosting.update({
          where: { id: input.jobPostingId },
          data: { status: postingStatus }
        });
      }

      await tx.applicationEvent.create({
        data: {
          userId,
          applicationId: savedApplication.id,
          type: eventType,
          title: eventTitle,
          body: input.notes,
          metadata: {
            resumeVersionId: effective.resumeVersionId,
            coverLetterVersionId: effective.coverLetterVersionId,
            ...(sentDocuments ? { [SENT_DOCUMENTS_METADATA_KEY]: sentDocuments } : {}),
            ...(selfReportedEffort ? { [SELF_REPORTED_EFFORT_METADATA_KEY]: selfReportedEffort } : {})
          }
        }
      });

      await tx.auditLog.create({
        data: {
          userId,
          action: nextStatus === "APPLIED" ? "application.mark_applied" : "application.save",
          resource: "Application",
          resourceId: savedApplication.id,
          metadata: {}
        }
      });

      return savedApplication;
    });

    return NextResponse.json({ application });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
