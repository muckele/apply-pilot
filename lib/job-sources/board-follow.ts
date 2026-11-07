import { z } from "zod";

import { PublicApiError } from "@/lib/api-errors";
import { findDirectoryEntry } from "@/lib/job-sources/board-directory";
import { boardPageUrl, resolveBoardUrl, type BoardAts } from "@/lib/job-sources/board-url";
import { prisma } from "@/lib/prisma";

const emptyToUndefined = (value: unknown) => (typeof value === "string" && !value.trim() ? undefined : value);

export const followBoardSchema = z.object({
  url: z.string().trim().min(1, "Paste a job board or job URL.").max(2048),
  name: z.preprocess(emptyToUndefined, z.string().trim().min(2).max(120).optional())
});

const atsLabels: Record<BoardAts, string> = { GREENHOUSE: "Greenhouse", LEVER: "Lever", ASHBY: "Ashby" };

/** "example-startup" -> "Example Startup", used when the board is not in the directory. */
export function humanizeBoardToken(token: string) {
  return token
    .replace(/\.(com|io|ai|co)$/i, "")
    .split(/[-_.]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

/**
 * Follows a company's public Greenhouse, Lever or Ashby board for one user by creating (or
 * re-enabling) that user's JobSource row. Every lookup and write is scoped to `userId`.
 */
export async function followBoard({ userId, url, name }: { userId: string; url: string; name?: string }) {
  const resolution = resolveBoardUrl(url);
  if (!resolution.ok) {
    throw new PublicApiError(resolution.reason, 422);
  }

  const { ats, token, region } = resolution;
  const existing = await prisma.jobSource.findFirst({
    where: { userId, type: ats, boardToken: { equals: token, mode: "insensitive" } }
  });

  if (existing) {
    if (existing.syncEnabled) {
      return { source: existing, created: false, reenabled: false };
    }

    const source = await prisma.jobSource.update({
      where: { id: existing.id },
      data: { syncEnabled: true, lastSyncStatus: "NEEDS_TEST", lastSyncError: null }
    });
    return { source, created: false, reenabled: true };
  }

  const source = await prisma.jobSource.create({
    data: {
      userId,
      name: name ?? findDirectoryEntry(ats, token)?.company ?? humanizeBoardToken(token),
      type: ats,
      boardToken: token,
      baseUrl: boardPageUrl({ ats, token, region }),
      syncEnabled: true,
      allowlisted: true,
      robotsChecked: true,
      lastSyncStatus: "NEVER_SYNCED",
      notes: `Followed from a pasted ${atsLabels[ats]} link. Read from the public job board API only.`
    }
  });

  return { source, created: true, reenabled: false };
}
