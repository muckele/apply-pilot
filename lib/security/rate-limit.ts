import { PublicApiError } from "@/lib/api-errors";
import { prisma } from "@/lib/prisma";

const cleanupSampleRate = 0.01;

export async function checkRateLimit(key: string, limit = 30, windowMs = 60_000) {
  const now = Date.now();
  const nowDate = new Date(now);
  const resetAt = new Date(now + windowMs);
  const [bucket] = await prisma.$queryRaw<Array<{ count: number }>>`
    INSERT INTO "RateLimitBucket" ("key", "count", "resetAt", "updatedAt")
    VALUES (${key}, 1, ${resetAt}, ${nowDate})
    ON CONFLICT ("key") DO UPDATE SET
      "count" = CASE
        WHEN "RateLimitBucket"."resetAt" <= ${nowDate} THEN 1
        ELSE "RateLimitBucket"."count" + 1
      END,
      "resetAt" = CASE
        WHEN "RateLimitBucket"."resetAt" <= ${nowDate} THEN ${resetAt}
        ELSE "RateLimitBucket"."resetAt"
      END,
      "updatedAt" = ${nowDate}
    RETURNING "count"
  `;

  if (bucket.count > limit) {
    throw new PublicApiError("Rate limit exceeded. Try again shortly.", 429);
  }

  await maybeCleanupExpiredBuckets(now);
}

async function maybeCleanupExpiredBuckets(now: number) {
  if (Math.random() > cleanupSampleRate) {
    return;
  }

  await prisma.rateLimitBucket.deleteMany({
    where: { resetAt: { lt: new Date(now) } }
  });
}
