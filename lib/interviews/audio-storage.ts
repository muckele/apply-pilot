import { head, type PutBlobResult } from "@vercel/blob";

import { PublicApiError } from "@/lib/api-errors";
import { INTERVIEW_AUDIO_EXTENSIONS, INTERVIEW_AUDIO_MIME_TYPES } from "@/lib/interviews/audio-policy";
import { prisma } from "@/lib/prisma";

const PRIVATE_BLOB_HOST_SUFFIX = ".private.blob.vercel-storage.com";

type AudioStorageEnv = {
  MAX_AUDIO_UPLOAD_MB?: string;
  MAX_DIRECT_AUDIO_UPLOAD_MB?: string;
  BLOB_READ_WRITE_TOKEN?: string;
};

function configuredSizeInBytes(value: string | undefined, fallbackMb: number) {
  const configuredMb = Number(value ?? fallbackMb);
  const maxMb = Number.isFinite(configuredMb) && configuredMb > 0 ? configuredMb : fallbackMb;
  return Math.floor(maxMb * 1024 * 1024);
}

export function serverAudioMaxBytes(env?: AudioStorageEnv) {
  const configured = env ?? (process.env as unknown as AudioStorageEnv);
  return configuredSizeInBytes(configured.MAX_AUDIO_UPLOAD_MB, 4);
}

export function directAudioMaxBytes(env?: AudioStorageEnv) {
  const configured = env ?? (process.env as unknown as AudioStorageEnv);
  return configuredSizeInBytes(configured.MAX_DIRECT_AUDIO_UPLOAD_MB, 25);
}

export function directAudioUploadsEnabled(env?: AudioStorageEnv) {
  const configured = env ?? (process.env as unknown as AudioStorageEnv);
  return Boolean(configured.BLOB_READ_WRITE_TOKEN);
}

export function interviewAudioPathPrefix(interviewId: string) {
  return `interviews/${interviewId}/`;
}

export function isAllowedInterviewAudio(filename: string, contentType: string) {
  const lowerName = filename.toLowerCase();
  const allowedExtension = INTERVIEW_AUDIO_EXTENSIONS.some((extension) => lowerName.endsWith(extension));
  const allowedContentType = INTERVIEW_AUDIO_MIME_TYPES.includes(
    contentType as (typeof INTERVIEW_AUDIO_MIME_TYPES)[number]
  );

  return allowedExtension && (!contentType || allowedContentType);
}

export function validateInterviewAudioUpload(input: {
  filename: string;
  contentType: string;
  size: number;
  maxBytes: number;
}) {
  if (!Number.isFinite(input.size) || input.size <= 0) {
    throw new PublicApiError("Interview audio file is empty.");
  }

  if (input.size > input.maxBytes) {
    throw new PublicApiError("Interview audio file is too large.");
  }

  if (!isAllowedInterviewAudio(input.filename, input.contentType)) {
    throw new PublicApiError("Unsupported interview audio format. Upload MP3, M4A, WAV, OGG, WebM, or MP4.");
  }
}

export function validateInterviewBlobLocation(input: {
  interviewId: string;
  pathname: string;
  url: string;
}) {
  const prefix = interviewAudioPathPrefix(input.interviewId);
  const relativePath = input.pathname.slice(prefix.length);
  let url: URL;

  try {
    url = new URL(input.url);
  } catch {
    throw new PublicApiError("The uploaded audio location is invalid.");
  }

  if (
    url.protocol !== "https:" ||
    !url.hostname.endsWith(PRIVATE_BLOB_HOST_SUFFIX) ||
    !input.pathname.startsWith(prefix) ||
    !relativePath ||
    relativePath.includes("/") ||
    relativePath.includes("..")
  ) {
    throw new PublicApiError("The uploaded audio is outside the authorized private interview folder.");
  }
}

export async function verifyPrivateInterviewBlob(interviewId: string, blobUrl: string) {
  const metadata = await head(blobUrl);

  validateInterviewBlobLocation({
    interviewId,
    pathname: metadata.pathname,
    url: metadata.url
  });
  validateInterviewAudioUpload({
    filename: metadata.pathname,
    contentType: metadata.contentType,
    size: metadata.size,
    maxBytes: directAudioMaxBytes()
  });

  return metadata;
}

export async function saveCompletedInterviewBlob(input: {
  userId: string;
  interviewId: string;
  blob: Pick<PutBlobResult, "url" | "pathname" | "contentType">;
  consentStatement: string;
}) {
  validateInterviewBlobLocation({
    interviewId: input.interviewId,
    pathname: input.blob.pathname,
    url: input.blob.url
  });

  const interview = await prisma.interview.findFirstOrThrow({
    where: { id: input.interviewId, userId: input.userId },
    select: { id: true }
  });

  return prisma.$transaction(async (tx) => {
    const recording = await tx.interviewRecording.upsert({
      where: { filePath: input.blob.url },
      update: {},
      create: {
        interviewId: interview.id,
        filePath: input.blob.url,
        consentConfirmedAt: new Date(),
        consentStatement: input.consentStatement,
        consentStatus: "CONSENT_CONFIRMED"
      }
    });

    if (recording.interviewId !== interview.id) {
      throw new PublicApiError("The uploaded audio is already assigned to another interview.", 409);
    }

    await tx.interview.update({
      where: { id: interview.id },
      data: { consentStatus: "CONSENT_CONFIRMED" }
    });

    const existingAudit = await tx.auditLog.findFirst({
      where: {
        userId: input.userId,
        action: "interview.audio.upload",
        resource: "InterviewRecording",
        resourceId: recording.id
      },
      select: { id: true }
    });

    if (!existingAudit) {
      await tx.auditLog.create({
        data: {
          userId: input.userId,
          action: "interview.audio.upload",
          resource: "InterviewRecording",
          resourceId: recording.id,
          metadata: {
            consentConfirmed: true,
            storage: "vercel-blob-private",
            contentType: input.blob.contentType
          }
        }
      });
    }

    return recording;
  });
}
