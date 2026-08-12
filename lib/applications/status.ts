import type { ApplicationStatus } from "@prisma/client";

import { defaultFollowUpDueAt, suggestApplicationNextAction } from "@/lib/applications/pipeline";

type ApplicationStatusUpdate = {
  status?: ApplicationStatus;
  dateApplied?: Date;
  followUpDueAt?: Date | null;
  nextAction?: string | null;
};

type ExistingApplicationStatus = {
  status: ApplicationStatus;
  dateApplied: Date | null;
};

const passiveApplicationStatuses = new Set<ApplicationStatus>(["SAVED", "INTERESTED"]);

export function resolveApplicationPostStatus(
  inputStatus: ApplicationStatus,
  existing?: Pick<ExistingApplicationStatus, "status"> | null
) {
  if (!existing) {
    return inputStatus;
  }

  if (passiveApplicationStatuses.has(inputStatus) && !passiveApplicationStatuses.has(existing.status)) {
    return existing.status;
  }

  return inputStatus;
}

export function normalizeApplicationPatch<TInput extends ApplicationStatusUpdate>(
  input: TInput,
  existing: ExistingApplicationStatus,
  now = new Date()
) {
  const nextStatus = input.status ? resolveApplicationPostStatus(input.status, existing) : existing.status;
  const data: TInput & { dateApplied?: Date; followUpDueAt?: Date | null; nextAction?: string | null } = {
    ...input,
    status: nextStatus
  };
  const statusChanged = nextStatus !== existing.status;

  if (nextStatus === "APPLIED") {
    data.dateApplied = input.dateApplied ?? existing.dateApplied ?? now;
  }

  if (statusChanged && input.nextAction === undefined) {
    data.nextAction = suggestApplicationNextAction(nextStatus);
  }

  if (statusChanged && input.followUpDueAt === undefined) {
    data.followUpDueAt = defaultFollowUpDueAt(nextStatus, now);
  }

  return { nextStatus, data };
}
