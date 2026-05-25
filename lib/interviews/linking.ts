import { PublicApiError } from "@/lib/api-errors";

type InterviewJobLinkInput = {
  requestedJobPostingId?: string | null;
  applicationJobPostingId?: string | null;
};

export function resolveInterviewJobPostingId({
  requestedJobPostingId,
  applicationJobPostingId
}: InterviewJobLinkInput) {
  if (requestedJobPostingId && applicationJobPostingId && applicationJobPostingId !== requestedJobPostingId) {
    throw new PublicApiError("The selected application does not belong to the selected job.");
  }

  return requestedJobPostingId ?? applicationJobPostingId ?? undefined;
}
