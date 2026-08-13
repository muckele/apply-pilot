import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { INTERVIEW_AUDIO_MIME_TYPES, INTERVIEW_CONSENT_STATEMENT } from "@/lib/interviews/audio-policy";
import {
  directAudioMaxBytes,
  saveCompletedInterviewBlob,
  validateInterviewBlobLocation,
  verifyPrivateInterviewBlob
} from "@/lib/interviews/audio-storage";
import { prisma } from "@/lib/prisma";
import { checkRateLimit } from "@/lib/security/rate-limit";
import { apiErrorResponse, requireUserId } from "@/lib/user-context";
import { interviewAudioSchema } from "@/lib/validators";

export const runtime = "nodejs";

type Params = {
  params: Promise<{ id: string }>;
};

const tokenPayloadSchema = z.object({
  userId: z.string().min(1),
  interviewId: z.string().min(1),
  consentStatement: z.string().min(1).max(1000)
});

export async function POST(request: NextRequest, { params }: Params) {
  try {
    const { id } = await params;
    const body = (await request.json()) as HandleUploadBody;
    const result = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async (pathname, clientPayload) => {
        const userId = await requireUserId();
        await checkRateLimit(`interview-audio-token:${userId}`, 10, 60_000);
        const consent = interviewAudioSchema.parse(JSON.parse(clientPayload ?? "{}"));

        if (!consent.consentConfirmed) {
          throw new Error("Recording or transcription requires explicit participant consent confirmation.");
        }

        await prisma.interview.findFirstOrThrow({
          where: { id, userId },
          select: { id: true }
        });
        validateInterviewBlobLocation({
          interviewId: id,
          pathname,
          url: `https://pending.private.blob.vercel-storage.com/${pathname}`
        });

        return {
          allowedContentTypes: [...INTERVIEW_AUDIO_MIME_TYPES],
          maximumSizeInBytes: directAudioMaxBytes(),
          addRandomSuffix: true,
          tokenPayload: JSON.stringify({
            userId,
            interviewId: id,
            consentStatement: INTERVIEW_CONSENT_STATEMENT
          })
        };
      },
      onUploadCompleted: async ({ blob, tokenPayload }) => {
        const trusted = tokenPayloadSchema.parse(JSON.parse(tokenPayload ?? "{}"));
        const metadata = await verifyPrivateInterviewBlob(trusted.interviewId, blob.url);

        await saveCompletedInterviewBlob({
          userId: trusted.userId,
          interviewId: trusted.interviewId,
          blob: metadata,
          consentStatement: trusted.consentStatement
        });
      }
    });

    return NextResponse.json(result);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
