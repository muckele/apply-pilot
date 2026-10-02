import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";

import { hashAiInput } from "@/lib/ai/application-plan-budget";
import { aiInvocationFromRequest } from "@/lib/ai/http";
import {
  parseResumeTextWithMeta,
  RESUME_PARSE_PROMPT_VERSION,
  validateParsedResumeOutput
} from "@/lib/ai/resume";
import { PublicApiError } from "@/lib/api-errors";
import { checkRateLimit } from "@/lib/security/rate-limit";
import { deletePrivateFile, savePrivateFile } from "@/lib/storage/private-files";
import { apiErrorResponse, requireUserId } from "@/lib/user-context";
import { resumeParseSchema } from "@/lib/validators";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

type ResumeParseClient = typeof prisma | Prisma.TransactionClient;
const RESUME_PARSE_REPLAY_WINDOW_MS = 15 * 60_000;

async function findResumeParseReplay(
  client: ResumeParseClient,
  userId: string,
  submissionHash: string,
  rawText: string,
  isMaster: boolean,
  requireRequestedState = true
) {
  const analysis = await client.aIAnalysis.findFirst({
    where: {
      userId,
      type: "RESUME_PARSE",
      promptName: "resumeParsePrompt",
      promptVersion: RESUME_PARSE_PROMPT_VERSION,
      input: { path: ["submissionHash"], equals: submissionHash },
      createdAt: { gt: new Date(Date.now() - RESUME_PARSE_REPLAY_WINDOW_MS) }
    },
    orderBy: { createdAt: "desc" }
  });
  if (!analysis || !analysis.input || typeof analysis.input !== "object" || Array.isArray(analysis.input)) {
    return null;
  }
  const resumeId = (analysis.input as Record<string, unknown>).resumeId;
  if (typeof resumeId !== "string") return null;
  const resume = await client.resume.findFirst({ where: { id: resumeId, userId } });
  if (!resume || (requireRequestedState && resume.isMaster !== isMaster)) return null;
  return {
    resume,
    parsed: validateParsedResumeOutput(rawText, analysis.output),
    replayed: true as const
  };
}

async function extractTextFromFile(file: File) {
  const buffer = Buffer.from(await file.arrayBuffer());
  const lowerName = file.name.toLowerCase();
  const configuredMaxMb = Number(process.env.MAX_UPLOAD_MB ?? 4);
  const maxMb = Number.isFinite(configuredMaxMb) && configuredMaxMb > 0 ? configuredMaxMb : 4;

  if (file.size > maxMb * 1024 * 1024) {
    throw new PublicApiError("Resume file is too large.");
  }

  if (file.type === "application/pdf" || lowerName.endsWith(".pdf")) {
    const pdfParse = (await import("pdf-parse")).default;
    const parsed = await pdfParse(buffer);
    return { text: parsed.text, buffer };
  }

  if (
    file.type ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    lowerName.endsWith(".docx")
  ) {
    const mammoth = await import("mammoth");
    const parsed = await mammoth.extractRawText({ buffer });
    return { text: parsed.value, buffer };
  }

  if (file.type.startsWith("text/") || lowerName.endsWith(".txt")) {
    return { text: buffer.toString("utf8"), buffer };
  }

  throw new PublicApiError("Unsupported resume format. Upload PDF, DOCX, or paste text.");
}

export async function POST(request: NextRequest) {
  try {
    const userId = await requireUserId();
    await checkRateLimit(`resume-parse:${userId}`, 10, 60_000);

    const contentType = request.headers.get("content-type") ?? "";
    let title = "Master Resume";
    let isMaster = true;
    let rawText = "";
    let fileBuffer: Buffer | undefined;
    let filePath: string | undefined;
    let originalName: string | undefined;
    let mimeType: string | undefined;

    if (contentType.includes("multipart/form-data")) {
      const formData = await request.formData();
      const input = resumeParseSchema.parse({
        title: formData.get("title") ?? "Master Resume",
        pastedText: formData.get("pastedText") ?? undefined,
        isMaster: formData.get("isMaster") !== "false"
      });
      const file = formData.get("file");
      title = input.title;
      isMaster = input.isMaster;
      rawText = input.pastedText ?? "";

      if (file instanceof File && file.size > 0) {
        const extracted = await extractTextFromFile(file);
        rawText = extracted.text;
        fileBuffer = extracted.buffer;
        originalName = file.name;
        mimeType = file.type;
      }
    } else {
      const input = resumeParseSchema.parse(await request.json());
      title = input.title;
      isMaster = input.isMaster;
      rawText = input.pastedText ?? "";
    }

    if (!rawText.trim()) {
      throw new PublicApiError("Upload a resume file or paste resume text before parsing.");
    }

    const sourceDescriptor = fileBuffer
      ? {
          kind: "file",
          originalName,
          mimeType: mimeType ?? null,
          contentHash: createHash("sha256").update(fileBuffer).digest("hex")
        }
      : { kind: "paste" };
    const submissionHash = hashAiInput("resumeSubmission", "2", {
      title,
      isMaster,
      rawText,
      sourceDescriptor
    });
    const existing = await findResumeParseReplay(prisma, userId, submissionHash, rawText, isMaster);
    if (existing) return NextResponse.json(existing);

    const parsedResult = await parseResumeTextWithMeta(rawText, userId, aiInvocationFromRequest(request));
    const parsed = parsedResult.data;

    try {
      const result = await prisma.$transaction(async (tx) => {
        const raced = await findResumeParseReplay(tx, userId, submissionHash, rawText, isMaster);
        if (raced) return raced;
        if (fileBuffer && originalName) {
          filePath = await savePrivateFile({
            userId,
            category: "resumes",
            filename: originalName,
            contentType: mimeType,
            buffer: fileBuffer
          }, tx);
        }
        if (isMaster) {
          await tx.resume.updateMany({
            where: { userId, isMaster: true },
            data: { isMaster: false }
          });
        }
        const resume = await tx.resume.create({
          data: {
            userId,
            title,
            isMaster,
            originalName,
            filePath,
            mimeType,
            rawText,
            contactInfo: parsed.contactInfo as Prisma.InputJsonValue,
            summary: parsed.summary,
            skills: parsed.skills,
            workHistory: parsed.workHistory as unknown as Prisma.InputJsonValue,
            projects: parsed.projects as unknown as Prisma.InputJsonValue,
            education: parsed.education as unknown as Prisma.InputJsonValue,
            certifications: parsed.certifications as unknown as Prisma.InputJsonValue,
            achievements: parsed.achievements,
            parsedAt: new Date()
          }
        });
        await tx.aIAnalysis.create({
          data: {
            userId,
            type: "RESUME_PARSE",
            model: parsedResult.meta.model,
            promptName: "resumeParsePrompt",
            promptVersion: parsedResult.meta.promptVersion,
            inputHash: parsedResult.meta.requestHash,
            input: {
              resumeId: resume.id,
              submissionHash,
              providerRequestHash: parsedResult.meta.requestHash
            },
            output: parsed as unknown as Prisma.InputJsonValue,
            confidence: null
          }
        });
        await tx.auditLog.create({
          data: {
            userId,
            action: "resume.parse",
            resource: "Resume",
            resourceId: resume.id,
            metadata: {
              provider: parsedResult.meta.provider,
              model: parsedResult.meta.model,
              promptVersion: parsedResult.meta.promptVersion
            }
          }
        });
        return { resume, parsed, replayed: false as const };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      return NextResponse.json(result);
    } catch {
      let replay;
      try {
        replay = await findResumeParseReplay(prisma, userId, submissionHash, rawText, isMaster, false);
      } catch {
        throw new PublicApiError(
          "The resume save outcome could not be confirmed. Check the Master resume profile before retrying; Apply Pilot will not retry automatically.",
          503,
          { code: "RESUME_PARSE_SAVE_OUTCOME_UNCERTAIN", retryable: false }
        );
      }
      if (replay) {
        if (replay.resume.isMaster !== isMaster) {
          throw new PublicApiError(
            "The resume save committed, but its master state changed before confirmation. Check the Master resume profile; do not retry automatically.",
            409,
            { code: "RESUME_PARSE_COMMITTED_STATE_CHANGED", retryable: false }
          );
        }
        return NextResponse.json(replay);
      }
      if (filePath) {
        try {
          await deletePrivateFile({ userId, filePath });
        } catch {
          throw new PublicApiError(
            "The resume was not saved, but private-file cleanup could not be confirmed. Do not retry until storage is reviewed.",
            503,
            { code: "RESUME_PARSE_FILE_CLEANUP_UNCERTAIN", retryable: false }
          );
        }
      }
      throw new PublicApiError(
        "The resume was parsed but could not be saved. No master resume was changed; retrying will reuse the validated parse when available.",
        503,
        { code: "RESUME_PARSE_SAVE_FAILED", retryable: true }
      );
    }
  } catch (error) {
    return apiErrorResponse(error);
  }
}
