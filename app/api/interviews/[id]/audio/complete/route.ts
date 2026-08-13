import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { INTERVIEW_CONSENT_STATEMENT } from "@/lib/interviews/audio-policy";
import { saveCompletedInterviewBlob, verifyPrivateInterviewBlob } from "@/lib/interviews/audio-storage";
import { checkRateLimit } from "@/lib/security/rate-limit";
import { apiErrorResponse, requireUserId } from "@/lib/user-context";
import { interviewAudioSchema } from "@/lib/validators";

export const runtime = "nodejs";

type Params = {
  params: Promise<{ id: string }>;
};

const completeUploadSchema = interviewAudioSchema.extend({
  blobUrl: z.string().url()
});

export async function POST(request: NextRequest, { params }: Params) {
  try {
    const userId = await requireUserId();
    await checkRateLimit(`interview-audio-complete:${userId}`, 10, 60_000);
    const { id } = await params;
    const input = completeUploadSchema.parse(await request.json());

    if (!input.consentConfirmed) {
      return NextResponse.json(
        { error: "Recording or transcription requires explicit participant consent confirmation." },
        { status: 400 }
      );
    }

    const metadata = await verifyPrivateInterviewBlob(id, input.blobUrl);
    const recording = await saveCompletedInterviewBlob({
      userId,
      interviewId: id,
      blob: metadata,
      consentStatement: INTERVIEW_CONSENT_STATEMENT
    });

    return NextResponse.json({ recording });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
