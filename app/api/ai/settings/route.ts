import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { getAiFinancialPolicy, getAllowedAiModels } from "@/lib/ai/config";
import { getMonthlyAiUsage, getOrCreateAiSettings } from "@/lib/ai/usage";
import { PublicApiError } from "@/lib/api-errors";
import { prisma } from "@/lib/prisma";
import { checkRateLimit } from "@/lib/security/rate-limit";
import { apiErrorResponse, requireUserId } from "@/lib/user-context";

const settingsSchema = z.object({
  monthlyBudgetCents: z.coerce.number().int().min(100).max(500).optional(),
  automationBudgetCents: z.coerce.number().int().min(0).max(150).optional(),
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
          provider: true,
          feature: true,
          model: true,
          promptName: true,
          promptVersion: true,
          inputTokens: true,
          outputTokens: true,
          cachedInputTokens: true,
          estimatedCostMicros: true,
          status: true,
          automation: true,
          createdAt: true
        },
        orderBy: { createdAt: "desc" },
        take: 30
      })
    ]);

    return NextResponse.json({ settings, usage, recent, allowedModels: getAllowedAiModels() });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const userId = await requireUserId();
    await checkRateLimit(`ai-settings:update:${userId}`, 20, 60_000);
    const input = settingsSchema.parse(await request.json());
    const current = await getOrCreateAiSettings(userId);
    const financialPolicy = getAiFinancialPolicy();
    const monthlyBudgetCents = input.monthlyBudgetCents ?? current.monthlyBudgetCents;
    const automationBudgetCents = input.automationBudgetCents ?? current.automationBudgetCents;
    if (monthlyBudgetCents > financialPolicy.hardCapCents) {
      throw new PublicApiError("The monthly AI budget cannot exceed the server's $5 hard cap.");
    }
    if (automationBudgetCents > financialPolicy.automationCapCents || automationBudgetCents > monthlyBudgetCents) {
      throw new PublicApiError("The automation allowance must fit within the $1.50 automation and monthly caps.");
    }
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
          automationBudgetCents: input.automationBudgetCents,
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
            automationBudgetCents: updated.automationBudgetCents,
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
