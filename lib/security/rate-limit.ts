import { PublicApiError } from "@/lib/api-errors";
import { prisma } from "@/lib/prisma";

const cleanupSampleRate = 0.01;

export async function checkRateLimit(key: string, limit = 30, windowMs = 60_000) {
  const now = Date.now();
  const resetAt = new Date(now + windowMs);
  const existing = await prisma.rateLimitBucket.findUnique({ where: { key } });

  if (!existing || existing.resetAt.getTime() < now) {
    await prisma.rateLimitBucket.upsert({
      where: { key },
      create: { key, count: 1, resetAt },
      update: { count: 1, resetAt }
    });
    await maybeCleanupExpiredBuckets(now);
    return;
  }

  const updated = await prisma.rateLimitBucket.update({
    where: { key },
    data: { count: { increment: 1 } }
  });

  if (updated.count > limit) {
    throw new PublicApiError("Rate limit exceeded. Try again shortly.", 429);
  }
}

async function maybeCleanupExpiredBuckets(now: number) {
  if (Math.random() > cleanupSampleRate) {
    return;
  }

  await prisma.rateLimitBucket.deleteMany({
    where: { resetAt: { lt: new Date(now) } }
  });
}
