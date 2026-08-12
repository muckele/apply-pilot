import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { getAllowedOpenAIModels } from "@/lib/ai/client";
import { getMonthlyAiUsage, getOrCreateAiSettings } from "@/lib/ai/usage";
import { PublicApiError } from "@/lib/api-errors";
import { prisma } from "@/lib/prisma";
import { checkRateLimit } from "@/lib/security/rate-limit";
import { apiErrorResponse, requireUserId } from "@/lib/user-context";

const settingsSchema = z.object({
  monthlyBudgetCents: z.coerce.number().int().min(100).max(100_000).optional(),
  maxAnalysesPerSync: z.coerce.number().int().min(0).max(25).optional(),
  aiDiscoveryEnabled: z.boolean().optional(),
  modelOverride: z.string().trim().max(100).nullable().optional()
});

export async function GET() {
  try {
    const userId = await requireUserId();
    const [settings, usage, recent] = await Promise.all([
      getOrCreateAiSettings(userId),
      getMonthlyAiUsage(userId),
      prisma.aIUsageEvent.findMany({
        where: { userId },
        select: {
          id: true,
          feature: true,
          model: true,
          promptName: true,
          promptVersion: true,
          inputTokens: true,
          outputTokens: true,
          cachedInputTokens: true,
          estimatedCostMicros: true,
          status: true,
          createdAt: true
        },
        orderBy: { createdAt: "desc" },
        take: 30
      })
    ]);

    return NextResponse.json({ settings, usage, recent, allowedModels: getAllowedOpenAIModels() });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const userId = await requireUserId();
    await checkRateLimit(`ai-settings:update:${userId}`, 20, 60_000);
    const input = settingsSchema.parse(await request.json());
    if (input.modelOverride && !getAllowedOpenAIModels().includes(input.modelOverride)) {
      throw new PublicApiError("Choose a model allowed by the server configuration.");
    }
    const modelOverrideUpdate = input.modelOverride !== undefined
      ? { modelOverride: input.modelOverride || null }
      : {};
    const settings = await prisma.$transaction(async (tx) => {
      const updated = await tx.aISettings.upsert({
        where: { userId },
        create: {
          userId,
          monthlyBudgetCents: input.monthlyBudgetCents,
          maxAnalysesPerSync: input.maxAnalysesPerSync,
          aiDiscoveryEnabled: input.aiDiscoveryEnabled,
          modelOverride: input.modelOverride || null
        },
        update: {
          ...input,
          ...modelOverrideUpdate
        }
      });
      await tx.auditLog.create({
        data: {
          userId,
          action: "ai-settings.update",
          resource: "AISettings",
          resourceId: updated.id,
          metadata: {
            monthlyBudgetCents: updated.monthlyBudgetCents,
            maxAnalysesPerSync: updated.maxAnalysesPerSync,
            aiDiscoveryEnabled: updated.aiDiscoveryEnabled,
            modelOverride: updated.modelOverride
          }
        }
      });
      return updated;
    });

    return NextResponse.json({ settings });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
