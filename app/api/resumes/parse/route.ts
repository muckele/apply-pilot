import type { Prisma } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";

import { parseResumeText } from "@/lib/ai/resume";
import { PublicApiError } from "@/lib/api-errors";
import { writeAuditLog } from "@/lib/security/audit-log";
import { checkRateLimit } from "@/lib/security/rate-limit";
import { savePrivateFile } from "@/lib/storage/private-files";
import { apiErrorResponse, requireUserId } from "@/lib/user-context";
import { resumeParseSchema } from "@/lib/validators";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

async function extractTextFromFile(file: File) {
  const buffer = Buffer.from(await file.arrayBuffer());
  const lowerName = file.name.toLowerCase();

  if (file.size > Number(process.env.MAX_UPLOAD_MB ?? 8) * 1024 * 1024) {
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
    checkRateLimit(`resume-parse:${userId}`, 10, 60_000);

    const contentType = request.headers.get("content-type") ?? "";
    let title = "Master Resume";
    let isMaster = true;
    let rawText = "";
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
        originalName = file.name;
        mimeType = file.type;
        filePath = await savePrivateFile({
          userId,
          category: "resumes",
          filename: file.name,
          contentType: file.type,
          buffer: extracted.buffer
        });
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

    const parsed = await parseResumeText(rawText);

    if (isMaster) {
      await prisma.resume.updateMany({
        where: { userId, isMaster: true },
        data: { isMaster: false }
      });
    }

    const resume = await prisma.resume.create({
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
        workHistory: parsed.workHistory as Prisma.InputJsonValue,
        projects: parsed.projects as Prisma.InputJsonValue,
        education: parsed.education as Prisma.InputJsonValue,
        certifications: parsed.certifications as Prisma.InputJsonValue,
        achievements: parsed.achievements,
        parsedAt: new Date()
      }
    });

    await prisma.aIAnalysis.create({
      data: {
        userId,
        type: "RESUME_PARSE",
        model: process.env.OPENAI_MOCK_MODE === "true" ? "heuristic-local" : process.env.OPENAI_MODEL ?? "gpt-4o-mini",
        promptName: "resumeParse",
        input: { resumeId: resume.id },
        output: parsed as unknown as Prisma.InputJsonValue,
        confidence: rawText ? 70 : 30
      }
    });

    await writeAuditLog({
      userId,
      action: "resume.parse",
      resource: "Resume",
      resourceId: resume.id
    });

    return NextResponse.json({ resume, parsed });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
