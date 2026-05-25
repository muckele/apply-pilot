import type { ApplicationStatus } from "@prisma/client";

type ApplicationStatusUpdate = {
  status?: ApplicationStatus;
  dateApplied?: Date;
};

type ExistingApplicationStatus = {
  status: ApplicationStatus;
  dateApplied: Date | null;
};

export function normalizeApplicationPatch<TInput extends ApplicationStatusUpdate>(
  input: TInput,
  existing: ExistingApplicationStatus,
  now = new Date()
) {
  const nextStatus = input.status ?? existing.status;
  const data: TInput & { dateApplied?: Date } = { ...input };

  if (nextStatus === "APPLIED") {
    data.dateApplied = input.dateApplied ?? existing.dateApplied ?? now;
  }

  return { nextStatus, data };
}
