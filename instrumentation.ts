import type { Instrumentation } from "next";

import { captureException, logger } from "@/lib/monitoring/logger";

export function register() {
  logger.info("monitoring.registered", {
    runtime: process.env.NEXT_RUNTIME ?? "nodejs"
  });
}

export const onRequestError: Instrumentation.onRequestError = async (error, request, context) => {
  captureException(error, {
    source: "next.onRequestError",
    method: request.method,
    path: request.path,
    routePath: context.routePath,
    routeType: context.routeType,
    routerKind: context.routerKind
  });
};
