import type { ServerResponse } from "node:http";

import { qualificationOwnerReviewHtml } from "@/lib/ai/job-match-qualification-owner-review-page";
import { ownerReviewSecurityHeaders } from "@/lib/ai/local-owner-review-http";

export {
  createRepeatableSubmissionAdmission,
  ownerReviewSecurityHeaders,
  readBoundedOwnerReviewBody,
  sendOwnerReviewJson
} from "@/lib/ai/local-owner-review-http";

type OwnerReviewAssetPaths = Readonly<{
  reviewPath: string;
  statePath: string;
  guideSubmissionPath: string;
  submissionPath: string;
  consentPath: string;
  executionReviewPath: string;
  cancelPath: string;
}>;

export function serveOwnerReviewAsset(
  pathname: string,
  method: string | undefined,
  response: ServerResponse,
  paths: OwnerReviewAssetPaths
) {
  if (method !== "GET") return false;
  if (pathname === paths.reviewPath) {
    response.writeHead(200, ownerReviewSecurityHeaders("text/html; charset=utf-8"));
    response.end(qualificationOwnerReviewHtml(paths));
    return true;
  }
  if (pathname === "/review.css") {
    response.writeHead(200, ownerReviewSecurityHeaders("text/css; charset=utf-8"));
    response.end(qualificationOwnerReviewHtml.css);
    return true;
  }
  if (pathname === "/review.js") {
    response.writeHead(200, ownerReviewSecurityHeaders("text/javascript; charset=utf-8"));
    response.end(qualificationOwnerReviewHtml.javascript);
    return true;
  }
  return false;
}

