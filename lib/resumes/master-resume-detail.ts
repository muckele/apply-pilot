import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";

export const MASTER_RESUME_DETAIL_SELECT = {
  id: true,
  title: true,
  parsedAt: true,
  rawText: true,
  summary: true,
  skills: true,
  achievements: true,
  workHistory: true,
  projects: true,
  education: true,
  certifications: true
} as const satisfies Prisma.ResumeSelect;

type MasterResumeDetailRecord = Prisma.ResumeGetPayload<{
  select: typeof MASTER_RESUME_DETAIL_SELECT;
}>;

export type MasterResumeDetailDto = {
  id: string;
  title: string;
  parsedAt: Date | null;
  rawText: string | null;
  summary: string | null;
  skills: string[];
  achievements: string[];
  workHistory: unknown;
  projects: unknown;
  education: unknown;
  certifications: unknown;
};

function toMasterResumeDetail(record: MasterResumeDetailRecord): MasterResumeDetailDto {
  return {
    id: record.id,
    title: record.title,
    parsedAt: record.parsedAt,
    rawText: record.rawText,
    summary: record.summary,
    skills: [...record.skills],
    achievements: [...record.achievements],
    workHistory: record.workHistory,
    projects: record.projects,
    education: record.education,
    certifications: record.certifications
  };
}

export async function getMasterResumeDetail(userId: string): Promise<MasterResumeDetailDto | null> {
  const record = await prisma.resume.findFirst({
    where: { userId, isMaster: true },
    select: MASTER_RESUME_DETAIL_SELECT,
    orderBy: { updatedAt: "desc" }
  });

  return record ? toMasterResumeDetail(record) : null;
}
