import { NextResponse } from "next/server";

import { prisma } from "@/lib/prisma";
import { writeAuditLog } from "@/lib/security/audit-log";
import { checkRateLimit } from "@/lib/security/rate-limit";
import { apiErrorResponse, requireUserId } from "@/lib/user-context";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const userId = await requireUserId();
    await checkRateLimit(`account:export:${userId}`, 3, 60_000);

    const [
      user,
      resumes,
      resumeVersions,
      jobSources,
      jobPostings,
      applications,
      applicationEvents,
      contacts,
      emailMessages,
      interviews,
      generatedDocuments,
      aiAnalyses,
      tasks,
      followUpReminders,
      storedFiles,
      gmailIntegration,
      browserCaptureTokens,
      applicationAnswers,
      interviewQuestions,
      starStories,
      aiSettings,
      aiUsageEvents,
      auditLogs
    ] = await Promise.all([
      prisma.user.findUniqueOrThrow({
        where: { id: userId },
        select: {
          id: true,
          name: true,
          email: true,
          image: true,
          createdAt: true,
          updatedAt: true,
          profile: true
        }
      }),
      prisma.resume.findMany({ where: { userId }, orderBy: { createdAt: "asc" } }),
      prisma.resumeVersion.findMany({ where: { userId }, orderBy: { createdAt: "asc" } }),
      prisma.jobSource.findMany({ where: { userId }, orderBy: { createdAt: "asc" } }),
      prisma.jobPosting.findMany({ where: { userId }, orderBy: { createdAt: "asc" } }),
      prisma.application.findMany({ where: { userId }, orderBy: { createdAt: "asc" } }),
      prisma.applicationEvent.findMany({ where: { userId }, orderBy: { occurredAt: "asc" } }),
      prisma.contact.findMany({ where: { userId }, orderBy: { createdAt: "asc" } }),
      prisma.emailMessage.findMany({ where: { userId }, orderBy: { createdAt: "asc" } }),
      prisma.interview.findMany({
        where: { userId },
        orderBy: { createdAt: "asc" },
        include: {
          notesList: { orderBy: { createdAt: "asc" } },
          recordings: { orderBy: { createdAt: "asc" } }
        }
      }),
      prisma.generatedDocument.findMany({ where: { userId }, orderBy: { createdAt: "asc" } }),
      prisma.aIAnalysis.findMany({ where: { userId }, orderBy: { createdAt: "asc" } }),
      prisma.task.findMany({ where: { userId }, orderBy: { createdAt: "asc" } }),
      prisma.followUpReminder.findMany({ where: { userId }, orderBy: { createdAt: "asc" } }),
      prisma.storedFile.findMany({
        where: { userId },
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          category: true,
          filename: true,
          contentType: true,
          size: true,
          createdAt: true
        }
      }),
      prisma.gmailIntegration.findUnique({
        where: { userId },
        select: {
          id: true,
          googleAccountEmail: true,
          scope: true,
          tokenExpiresAt: true,
          connectedAt: true,
          disconnectedAt: true,
          createdAt: true,
          updatedAt: true
        }
      }),
      prisma.browserCaptureToken.findMany({
        where: { userId },
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          name: true,
          tokenPrefix: true,
          scopes: true,
          lastUsedAt: true,
          expiresAt: true,
          revokedAt: true,
          createdAt: true
        }
      }),
      prisma.applicationAnswer.findMany({ where: { userId }, orderBy: { createdAt: "asc" } }),
      prisma.interviewQuestion.findMany({ where: { userId }, orderBy: { createdAt: "asc" } }),
      prisma.starStory.findMany({ where: { userId }, orderBy: { createdAt: "asc" } }),
      prisma.aISettings.findUnique({ where: { userId } }),
      prisma.aIUsageEvent.findMany({ where: { userId }, orderBy: { createdAt: "asc" } }),
      prisma.auditLog.findMany({
        where: { userId },
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          action: true,
          resource: true,
          resourceId: true,
          metadata: true,
          createdAt: true
        }
      })
    ]);

    const exportedAt = new Date().toISOString();
    const body = {
      exportedAt,
      app: "Apply Pilot",
      privacyNote:
        "This export excludes encrypted OAuth tokens, Auth.js sessions/accounts, and raw stored file bytes.",
      user,
      resumes,
      resumeVersions,
      jobSources,
      jobPostings,
      applications,
      applicationEvents,
      contacts,
      emailMessages,
      interviews,
      generatedDocuments,
      aiAnalyses,
      tasks,
      followUpReminders,
      storedFiles,
      gmailIntegration,
      browserCaptureTokens,
      applicationAnswers,
      interviewQuestions,
      starStories,
      aiSettings,
      aiUsageEvents,
      auditLogs
    };

    await writeAuditLog({
      userId,
      action: "account.export",
      resource: "User",
      resourceId: userId
    });

    return NextResponse.json(body, {
      headers: {
        "Content-Disposition": `attachment; filename="apply-pilot-export-${exportedAt.slice(0, 10)}.json"`
      }
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
