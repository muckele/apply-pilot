import { NextRequest, NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";

import { PublicApiError } from "@/lib/api-errors";
import { prisma } from "@/lib/prisma";
import { writeAuditLog } from "@/lib/security/audit-log";
import { checkRateLimit } from "@/lib/security/rate-limit";
import { apiErrorResponse, requireUserId } from "@/lib/user-context";
import { profileUpdateSchema } from "@/lib/validators";

const DEFAULT_RESUME_TONE = "clear, honest, concise, role-specific";

function buildProfileCreateData(
  userId: string,
  input: ReturnType<typeof profileUpdateSchema.parse>
): Prisma.UserProfileUncheckedCreateInput {
  return {
    userId,
    location: input.location ?? "",
    careerGoals: input.careerGoals ?? null,
    preferredRoles: input.preferredRoles ?? [],
    preferredLocations: input.preferredLocations ?? [],
    remotePreference: input.remotePreference ?? "FLEXIBLE",
    salaryTargetMin: input.salaryTargetMin ?? null,
    salaryTargetMax: input.salaryTargetMax ?? null,
    industriesOfInterest: input.industriesOfInterest ?? [],
    dealBreakers: input.dealBreakers ?? [],
    skillsToEmphasize: input.skillsToEmphasize ?? [],
    skillsNotToExaggerate: input.skillsNotToExaggerate ?? [],
    workAuthorizationNotes: input.workAuthorizationNotes ?? null,
    availabilityNotes: input.availabilityNotes ?? null,
    preferredResumeTone: input.preferredResumeTone ?? DEFAULT_RESUME_TONE
  };
}

function buildProfileUpdateData(input: ReturnType<typeof profileUpdateSchema.parse>) {
  const data: Prisma.UserProfileUncheckedUpdateInput = {};

  if (input.location !== undefined) data.location = input.location;
  if (input.careerGoals !== undefined) data.careerGoals = input.careerGoals;
  if (input.preferredRoles !== undefined) data.preferredRoles = input.preferredRoles;
  if (input.preferredLocations !== undefined) data.preferredLocations = input.preferredLocations;
  if (input.remotePreference !== undefined) data.remotePreference = input.remotePreference;
  if (input.salaryTargetMin !== undefined) data.salaryTargetMin = input.salaryTargetMin;
  if (input.salaryTargetMax !== undefined) data.salaryTargetMax = input.salaryTargetMax;
  if (input.industriesOfInterest !== undefined) data.industriesOfInterest = input.industriesOfInterest;
  if (input.dealBreakers !== undefined) data.dealBreakers = input.dealBreakers;
  if (input.skillsToEmphasize !== undefined) data.skillsToEmphasize = input.skillsToEmphasize;
  if (input.skillsNotToExaggerate !== undefined) data.skillsNotToExaggerate = input.skillsNotToExaggerate;
  if (input.workAuthorizationNotes !== undefined) data.workAuthorizationNotes = input.workAuthorizationNotes;
  if (input.availabilityNotes !== undefined) data.availabilityNotes = input.availabilityNotes;
  if (input.preferredResumeTone !== undefined) data.preferredResumeTone = input.preferredResumeTone;

  return data;
}

export async function GET() {
  try {
    const userId = await requireUserId();
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        email: true,
        image: true,
        profile: true
      }
    });

    return NextResponse.json({ user, profile: user.profile });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const userId = await requireUserId();
    checkRateLimit(`profile:update:${userId}`, 20, 60_000);

    const input = profileUpdateSchema.parse(await request.json());

    if (
      input.salaryTargetMin !== null &&
      input.salaryTargetMin !== undefined &&
      input.salaryTargetMax !== null &&
      input.salaryTargetMax !== undefined &&
      input.salaryTargetMin > input.salaryTargetMax
    ) {
      throw new PublicApiError("Salary target minimum cannot be greater than maximum.");
    }

    const updateData = buildProfileUpdateData(input);
    const [user, profile] = await prisma.$transaction([
      input.name !== undefined
        ? prisma.user.update({
            where: { id: userId },
            data: { name: input.name },
            select: { id: true, name: true, email: true, image: true }
          })
        : prisma.user.findUniqueOrThrow({
            where: { id: userId },
            select: { id: true, name: true, email: true, image: true }
          }),
      prisma.userProfile.upsert({
        where: { userId },
        create: buildProfileCreateData(userId, input),
        update: updateData
      })
    ]);

    await writeAuditLog({
      userId,
      action: "profile.update",
      resource: "UserProfile",
      resourceId: profile.id
    });

    return NextResponse.json({ user, profile });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
