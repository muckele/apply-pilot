import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { NextRequest, NextResponse } from "next/server";

import { prisma } from "@/lib/prisma";
import { writeAuditLog } from "@/lib/security/audit-log";
import { apiErrorResponse, requireUserId } from "@/lib/user-context";
import { interviewAudioSchema } from "@/lib/validators";

export const runtime = "nodejs";

type Params = {
  params: Promise<{ id: string }>;
};

export async function POST(request: NextRequest, { params }: Params) {
  try {
    const userId = await requireUserId();
    const { id } = await params;
    const interview = await prisma.interview.findFirstOrThrow({ where: { id, userId } });
    const formData = await request.formData();
    const input = interviewAudioSchema.parse({
      consentConfirmed: formData.get("consentConfirmed") === "true",
      consentStatement: formData.get("consentStatement") ?? undefined
    });

    if (!input.consentConfirmed) {
      throw new Error("Recording or transcription requires explicit participant consent confirmation.");
    }

    const file = formData.get("file");
    const pastedTranscript = String(formData.get("transcript") ?? "");
    let filePath: string | undefined;

    if (file instanceof File && file.size > 0) {
      const uploadDir = path.resolve(process.env.UPLOAD_DIR ?? "uploads", userId, "interviews");
      await mkdir(uploadDir, { recursive: true });
      filePath = path.join(uploadDir, `${randomUUID()}-${file.name.replace(/[^a-zA-Z0-9._-]/g, "_")}`);
      await writeFile(filePath, Buffer.from(await file.arrayBuffer()));
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
