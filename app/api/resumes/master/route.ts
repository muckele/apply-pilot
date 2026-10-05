import { getMasterResumeDetail } from "@/lib/resumes/master-resume-detail";
import { createMasterResumeRouteHandlers } from "@/lib/resumes/master-resume-route";
import { requireUserId } from "@/lib/user-context";

const handlers = createMasterResumeRouteHandlers({
  requireUserId,
  getMasterResumeDetail
});

export const GET = handlers.GET;
