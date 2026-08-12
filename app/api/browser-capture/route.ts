import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { PublicApiError } from "@/lib/api-errors";
import { ManualJobImportProvider } from "@/lib/job-sources/manual";
import { upsertNormalizedJob, runJobMatch } from "@/lib/jobs";
import { prisma } from "@/lib/prisma";
import {
  browserCaptureCorsHeaders,
  requireBrowserCaptureToken
} from "@/lib/security/browser-capture-token";
import { apiErrorResponse } from "@/lib/user-context";

const webUrl = z.string().trim().url().max(2048).refine((value) => {
  const protocol = new URL(value).protocol;
  return protocol === "https:" || protocol === "http:";
}, "Only HTTP and HTTPS job URLs are supported.");

const captureSchema = z.object({
  title: z.string().trim().min(2).max(200),
  company: z.string().trim().min(2).max(160),
  location: z.string().trim().max(200).optional().default(""),
  remoteStatus: z.string().trim().max(80).optional(),
  salaryMin: z.coerce.number().int().nonnegative().optional(),
  salaryMax: z.coerce.number().int().nonnegative().optional(),
  datePosted: z.coerce.date().optional(),
  sourceUrl: webUrl,
  applyUrl: webUrl.optional(),
  description: z.string().trim().min(80).max(50_000),
  runMatch: z.boolean().optional().default(false)
});

function withCors(response: NextResponse, request: Request) {
  browserCaptureCorsHeaders(request).forEach((value, key) => response.headers.set(key, value));
  response.headers.set("cache-control", "no-store");
  return response;
}

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: browserCaptureCorsHeaders(request) });
}

export async function POST(request: NextRequest) {
  try {
    const token = await requireBrowserCaptureToken(request, "JOB_CAPTURE");
    const input = captureSchema.parse(await request.json());

    if (input.salaryMin && input.salaryMax && input.salaryMin > input.salaryMax) {
      throw new PublicApiError("Salary minimum cannot be greater than salary maximum.");
    }

    const provider = new ManualJobImportProvider();
    const normalizedJob = provider.normalizeJob(input);
    const job = await upsertNormalizedJob({ userId: token.userId, job: normalizedJob });
    const application = await prisma.application.upsert({
      where: { userId_jobPostingId: { userId: token.userId, jobPostingId: job.id } },
      create: {
        userId: token.userId,
        jobPostingId: job.id,
        status: "SAVED",
        nextAction: "Review the captured posting and fit analysis before applying."
      },
      update: {}
    });
    const match = input.runMatch ? await runJobMatch(token.userId, job.id) : null;

    await prisma.auditLog.create({
      data: {
        userId: token.userId,
        action: "job.capture.browser",
        resource: "JobPosting",
        resourceId: job.id,
        metadata: { tokenId: token.id, sourceUrl: input.sourceUrl }
      }
    });

    return withCors(
      NextResponse.json({
        job: { id: job.id, title: job.title, company: job.company },
        application: { id: application.id, status: application.status },
        match,
        path: `/jobs/${job.id}`,
        submittedApplication: false
      }),
      request
    );
  } catch (error) {
    return withCors(apiErrorResponse(error), request);
  }
}
