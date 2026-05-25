import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

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

function storageDriver() {
  const configured = process.env.FILE_STORAGE_DRIVER?.toLowerCase();

  if (configured === "local" || configured === "database") {
    return configured;
  }

  return process.env.NODE_ENV === "production" ? "database" : "local";
}

function userUploadDirectory(userId: string) {
  return path.resolve(process.env.UPLOAD_DIR ?? "uploads", sanitizePathSegment(userId));
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
  const uploadRoot = path.resolve(process.env.UPLOAD_DIR ?? "uploads");
  const userDir = userUploadDirectory(userId);
  const relative = path.relative(uploadRoot, userDir);

  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Refusing to delete an upload directory outside UPLOAD_DIR.");
  }

  await rm(userDir, { recursive: true, force: true });
}
