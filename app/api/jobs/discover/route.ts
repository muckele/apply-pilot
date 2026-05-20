import { NextRequest, NextResponse } from "next/server";

import { runAutomatedJobDiscovery } from "@/lib/job-sources/discovery";
import { prisma } from "@/lib/prisma";
import { writeAuditLog } from "@/lib/security/audit-log";
import { checkRateLimit } from "@/lib/security/rate-limit";
import { apiErrorResponse, requireUserId } from "@/lib/user-context";
import { automatedJobDiscoverySchema } from "@/lib/validators";

export async function POST(request: NextRequest) {
  try {
    const userId = await requireUserId();
    checkRateLimit(`job-discovery:${userId}`, 4, 60_000);

    const input = automatedJobDiscoverySchema.parse(await request.json());
    const result = await runAutomatedJobDiscovery({ userId, ...input });

    if (result.imported) {
      await prisma.task.create({
        data: {
          userId,
          title: `Review ${result.imported} newly discovered jobs`,
          description: "Open the Jobs page, review fit, and decide whether to save or apply.",
          priority: "HIGH"
        }
      });
    }

    await writeAuditLog({
      userId,
      action: "job.discovery.run",
      resource: "JobPosting",
      metadata: {
        imported: result.imported,
        queries: result.queries,
        scoreImported: input.scoreImported
      }
    });

    return NextResponse.json(result);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
