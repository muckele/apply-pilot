import { NextRequest, NextResponse } from "next/server";

import { PublicApiError } from "@/lib/api-errors";
import { prisma } from "@/lib/prisma";
import { writeAuditLog } from "@/lib/security/audit-log";
import { checkRateLimit } from "@/lib/security/rate-limit";
import { savePrivateFile } from "@/lib/storage/private-files";
import { apiErrorResponse, requireUserId } from "@/lib/user-context";
import { interviewAudioSchema } from "@/lib/validators";

export const runtime = "nodejs";

type Params = {
  params: Promise<{ id: string }>;
};

const allowedAudioMimeTypes = new Set([
  "audio/aac",
  "audio/m4a",
  "audio/mp4",
  "audio/mpeg",
  "audio/ogg",
  "audio/wav",
  "audio/webm",
  "video/mp4",
  "video/webm"
]);

const allowedAudioExtensions = [".aac", ".m4a", ".mp3", ".mp4", ".ogg", ".wav", ".webm"];

function validateInterviewUpload(file: File) {
  const configuredMaxMb = Number(process.env.MAX_AUDIO_UPLOAD_MB ?? 25);
  const maxBytes = (Number.isFinite(configuredMaxMb) && configuredMaxMb > 0 ? configuredMaxMb : 25) * 1024 * 1024;
  const lowerName = file.name.toLowerCase();
  const hasAllowedExtension = allowedAudioExtensions.some((extension) => lowerName.endsWith(extension));

  if (file.size > maxBytes) {
    throw new PublicApiError("Interview audio file is too large.");
  }

  if (!allowedAudioMimeTypes.has(file.type) && !hasAllowedExtension) {
    throw new PublicApiError("Unsupported interview audio format. Upload MP3, M4A, WAV, OGG, WebM, or MP4.");
  }
}

export async function POST(request: NextRequest, { params }: Params) {
  try {
    const userId = await requireUserId();
    checkRateLimit(`interview-audio:${userId}`, 5, 60_000);

    const { id } = await params;
    const interview = await prisma.interview.findFirstOrThrow({ where: { id, userId } });
    const formData = await request.formData();
    const input = interviewAudioSchema.parse({
      consentConfirmed: formData.get("consentConfirmed") === "true",
      consentStatement: formData.get("consentStatement") ?? undefined
    });

    if (!input.consentConfirmed) {
      throw new PublicApiError("Recording or transcription requires explicit participant consent confirmation.");
    }

    const file = formData.get("file");
    const pastedTranscript = String(formData.get("transcript") ?? "").trim();
    let filePath: string | undefined;

    if (file instanceof File && file.size > 0) {
      validateInterviewUpload(file);
      filePath = await savePrivateFile({
        userId,
        category: "interviews",
        filename: file.name,
        contentType: file.type,
        buffer: Buffer.from(await file.arrayBuffer())
      });
    }

    if (!filePath && !pastedTranscript) {
      throw new PublicApiError("Upload an audio file or paste a transcript before saving an interview recording.");
    }

    const recording = await prisma.interviewRecording.create({
      data: {
        interviewId: interview.id,
        filePath,
        transcript: pastedTranscript || null,
        consentConfirmedAt: new Date(),
        consentStatement: input.consentStatement,
        consentStatus: "CONSENT_CONFIRMED"
      }
    });

    await prisma.interview.update({
      where: { id: interview.id },
      data: { consentStatus: "CONSENT_CONFIRMED" }
    });

    await writeAuditLog({
      userId,
      action: "interview.audio.upload",
      resource: "InterviewRecording",
      resourceId: recording.id,
      metadata: { consentConfirmed: true }
    });

    return NextResponse.json({
      recording,
      transcriptionQueued: false,
      note: "Audio was saved only after consent confirmation. Add OpenAI audio transcription in this route when ready."
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
