import { NextResponse } from "next/server";

import { captureException } from "@/lib/monitoring/logger";
import { apiErrorResponse, UnauthorizedError } from "@/lib/user-context";

const PRIVATE_NO_STORE = { "Cache-Control": "private, no-store" } as const;

type MasterResumeRouteDependencies = {
  requireUserId: () => Promise<string>;
  getMasterResumeDetail: (userId: string) => Promise<unknown>;
};

export function createMasterResumeRouteHandlers(dependencies: MasterResumeRouteDependencies) {
  return {
    async GET() {
      try {
        const userId = await dependencies.requireUserId();
        const resume = await dependencies.getMasterResumeDetail(userId);
        return NextResponse.json({ resume }, { headers: PRIVATE_NO_STORE });
      } catch (error) {
        const response = error instanceof UnauthorizedError
          ? apiErrorResponse(error)
          : unexpectedReadError(error);
        response.headers.set("Cache-Control", PRIVATE_NO_STORE["Cache-Control"]);
        return response;
      }
    }
  };
}

function unexpectedReadError(error: unknown) {
  captureException(error, { source: "masterResumeRead" });
  return NextResponse.json(
    { error: "The saved master resume could not be read." },
    { status: 500 }
  );
}
