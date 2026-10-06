import type { IncomingMessage, ServerResponse } from "node:http";

import { qualificationOwnerReviewHtml } from "@/lib/ai/job-match-qualification-owner-review-page";

const MAX_BODY_BYTES = 2_000_000;

export async function readBoundedOwnerReviewBody(request: IncomingMessage) {
  const declared = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    request.resume();
    throw new RangeError("body_limit");
  }
  const chunks: Buffer[] = [];
  let received = 0;
  for await (const chunkValue of request) {
    const chunk = Buffer.isBuffer(chunkValue) ? chunkValue : Buffer.from(chunkValue);
    received += chunk.byteLength;
    if (received > MAX_BODY_BYTES) throw new RangeError("body_limit");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function ownerReviewSecurityHeaders(contentType: string) {
  return {
    "content-type": contentType,
    "cache-control": "private, no-store",
    "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'none'; font-src 'none'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()"
  };
}

export function sendOwnerReviewJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  extra: Record<string, string> = {}
) {
  response.writeHead(status, { ...ownerReviewSecurityHeaders("application/json; charset=utf-8"), ...extra });
  response.end(JSON.stringify(body));
}

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

type RepeatableSubmission = "guide" | "owner_review" | "provider_review";

export function createRepeatableSubmissionAdmission() {
  const active = new Set<RepeatableSubmission>();
  return Object.freeze({
    acquire(kind: RepeatableSubmission) {
      if (active.has(kind)) return null;
      active.add(kind);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        active.delete(kind);
      };
    }
  });
}
