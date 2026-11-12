import type { ApplyProgress } from "@/lib/apply-page/apply-progress";
import { loadApplyProgress } from "@/lib/apply-page/load-apply-progress";
import { loadJobDetail, type JobDetail } from "@/lib/jobs/job-detail";
import { captureException } from "@/lib/monitoring/logger";

type Dependencies = {
  loadJobDetail: (userId: string, jobId: string) => Promise<JobDetail | null>;
  loadApplyProgress: (userId: string, detail: JobDetail) => Promise<ApplyProgress>;
  captureException: (error: unknown, context?: Record<string, unknown>) => void;
};

const DEFAULT_DEPENDENCIES: Dependencies = { loadJobDetail, loadApplyProgress, captureException };

/**
 * The application page's Apply summary card: the same progress the Apply page shows. The card is
 * optional, so a failure while loading it is logged and hides the card instead of breaking the
 * whole application page. Null also when the job isn't found.
 */
export async function loadApplicationSummaryProgress(
  userId: string,
  jobId: string,
  dependencies: Dependencies = DEFAULT_DEPENDENCIES
): Promise<ApplyProgress | null> {
  try {
    const detail = await dependencies.loadJobDetail(userId, jobId);
    return detail ? await dependencies.loadApplyProgress(userId, detail) : null;
  } catch (error) {
    dependencies.captureException(error, { source: "application-page.apply-summary", userId, resourceId: jobId });
    return null;
  }
}
