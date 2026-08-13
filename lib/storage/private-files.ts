import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { del } from "@vercel/blob";

import { prisma } from "@/lib/prisma";

type PrivateFileInput = {
  userId: string;
  category: "resumes" | "interviews" | "documents";
  filename: string;
  contentType?: string | null;
  buffer: Buffer;
};

function sanitizeFilename(filename: string) {
  return filename.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 160) || "upload.bin";
}

function sanitizePathSegment(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "user";
}

const localUploadRoot = path.join(process.cwd(), "uploads");

function storageDriver() {
  const configured = process.env.FILE_STORAGE_DRIVER?.toLowerCase();

  if (configured === "local" || configured === "database") {
    return configured;
  }

  return process.env.NODE_ENV === "production" ? "database" : "local";
}

function userUploadDirectory(userId: string) {
  return path.join(process.cwd(), "uploads", sanitizePathSegment(userId));
}

export async function savePrivateFile({
  userId,
  category,
  filename,
  contentType,
  buffer
}: PrivateFileInput) {
  const safeName = sanitizeFilename(filename);

  if (storageDriver() === "database") {
    const storedFile = await prisma.storedFile.create({
      data: {
        userId,
        category,
        filename: safeName,
        contentType,
        size: buffer.byteLength,
        data: buffer
      },
      select: { id: true }
    });

    return `db://${storedFile.id}`;
  }

  const uploadDir = path.join(userUploadDirectory(userId), category);
  await mkdir(uploadDir, { recursive: true });
  const filePath = path.join(uploadDir, `${randomUUID()}-${safeName}`);
  await writeFile(filePath, buffer);

  return filePath;
}

export async function deletePrivateLocalFilesForUser(userId: string) {
  const userDir = userUploadDirectory(userId);
  const relative = path.relative(localUploadRoot, userDir);

  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Refusing to delete an upload directory outside the local upload root.");
  }

  await rm(userDir, { recursive: true, force: true });
}

function isPrivateBlobUrl(value: string | null | undefined): value is string {
  if (!value) {
    return false;
  }

  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname.endsWith(".private.blob.vercel-storage.com");
  } catch {
    return false;
  }
}

export async function deletePrivateObjectFilesForUser(userId: string) {
  const [resumes, resumeVersions, documents, recordings] = await Promise.all([
    prisma.resume.findMany({ where: { userId }, select: { filePath: true } }),
    prisma.resumeVersion.findMany({
      where: { userId },
      select: { filePathDocx: true, filePathPdf: true }
    }),
    prisma.generatedDocument.findMany({ where: { userId }, select: { filePath: true } }),
    prisma.interviewRecording.findMany({
      where: { interview: { userId } },
      select: { filePath: true }
    })
  ]);
  const urls = new Set<string>();

  for (const value of [
    ...resumes.map((item) => item.filePath),
    ...resumeVersions.flatMap((item) => [item.filePathDocx, item.filePathPdf]),
    ...documents.map((item) => item.filePath),
    ...recordings.map((item) => item.filePath)
  ]) {
    if (isPrivateBlobUrl(value)) {
      urls.add(value);
    }
  }

  if (urls.size) {
    await del([...urls]);
  }
}
