import { NextRequest, NextResponse } from "next/server";

import { getMonthlyAiUsage, getOrCreateAiSettings } from "@/lib/ai/application-plan-budget";
import { getAiAvailability, getAiFinancialPolicy, getAllowedAiModels } from "@/lib/ai/config";
import { getAiPricingStatus } from "@/lib/ai/pricing";
import { aiSettingsUpdateSchema, effectiveMonthlyBudgetCents } from "@/lib/ai/settings";
import { PublicApiError } from "@/lib/api-errors";
import { prisma } from "@/lib/prisma";
import { checkRateLimit } from "@/lib/security/rate-limit";
import { apiErrorResponse, requireUserId } from "@/lib/user-context";

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

    return NextResponse.json({
      settings,
      usage,
      recent,
      allowedModels: getAllowedAiModels(),
      availability: getAiAvailability(),
      effectiveMonthlyBudgetCents: effectiveMonthlyBudgetCents(settings.monthlyBudgetCents),
      hardCapCents: getAiFinancialPolicy().hardCapCents,
      pricing: getAiPricingStatus()
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const userId = await requireUserId();
    await checkRateLimit(`ai-settings:update:${userId}`, 20, 60_000);
    // The monthly budget can never exceed the hard ledger cap.
    const input = aiSettingsUpdateSchema().parse(await request.json());
    if (input.modelOverride && !getAllowedAiModels().includes(input.modelOverride)) {
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
