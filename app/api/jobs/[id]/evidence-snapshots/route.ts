import { createEvidenceSnapshotRouteHandlers } from "@/lib/jobs/evidence-snapshot-route";
import { saveEvidenceSnapshot } from "@/lib/jobs/evidence-snapshots";
import { checkRateLimit } from "@/lib/security/rate-limit";
import { requireUserId } from "@/lib/user-context";

const handlers = createEvidenceSnapshotRouteHandlers({
  requireUserId,
  checkRateLimit,
  saveEvidenceSnapshot
});

export const POST = handlers.POST;
