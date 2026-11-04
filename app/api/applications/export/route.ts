import { createApplicationsExportRouteHandlers, readApplicationExportRows } from "@/lib/applications/export-route";
import { checkRateLimit } from "@/lib/security/rate-limit";
import { requireUserId } from "@/lib/user-context";

export const dynamic = "force-dynamic";

const handlers = createApplicationsExportRouteHandlers({
  requireUserId,
  checkRateLimit,
  readApplicationExportRows
});

export const GET = handlers.GET;
