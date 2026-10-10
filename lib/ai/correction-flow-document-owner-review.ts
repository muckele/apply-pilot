import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";

import {
  createCorrectionFlowDocumentReviewAttestation,
  type CorrectionFlowDocumentReviewAttestation,
  type CorrectionFlowDocumentReviewEnvelope
} from "@/lib/ai/correction-flow-document-review-contract";
import {
  buildCorrectionFlowDocumentReviewView,
  correctionFlowDocumentReviewHtml
} from "@/lib/ai/correction-flow-document-review-page";
import {
  createRepeatableSubmissionAdmission,
  ownerReviewSecurityHeaders,
  readBoundedOwnerReviewBody,
  sendOwnerReviewJson
} from "@/lib/ai/local-owner-review-http";

export const CORRECTION_FLOW_DOCUMENT_REVIEW_SESSION_TIMEOUT_MS = 15 * 60_000;

type ReviewDocument = Readonly<{
  kind: "resume" | "cover_letter";
  title: string;
  text: string;
  evidence: readonly Readonly<{
    claim: string;
    citations: readonly Readonly<{ ref: string; excerpt: string }>[];
  }>[];
}>;

type RenderedPdf = Readonly<{
  kind: "resume" | "cover_letter";
  bytes: Buffer;
}>;

type CloseReason = "completed" | "owner_cancel" | "session_timeout" | "owner_close" | "signal" | "error" | "test_cleanup" | "repeat_close";

function pdfHeaders() {
  return {
    ...ownerReviewSecurityHeaders("application/pdf"),
    "content-disposition": "inline",
    "content-security-policy": "default-src 'none'; base-uri 'none'; frame-ancestors 'self'",
    "x-frame-options": "SAMEORIGIN"
  };
}

export async function startCorrectionFlowDocumentOwnerReview({
  envelope,
  documents: initialDocuments,
  renderedPdfs: initialRenderedPdfs,
  now = () => new Date(),
  sessionTimeoutMs = CORRECTION_FLOW_DOCUMENT_REVIEW_SESSION_TIMEOUT_MS
}: {
  envelope: CorrectionFlowDocumentReviewEnvelope;
  documents: readonly [ReviewDocument & { kind: "resume" }, ReviewDocument & { kind: "cover_letter" }];
  renderedPdfs: readonly [RenderedPdf & { kind: "resume" }, RenderedPdf & { kind: "cover_letter" }];
  now?: () => Date;
  sessionTimeoutMs?: number;
}) {
  if (
    !Number.isSafeInteger(sessionTimeoutMs) ||
    sessionTimeoutMs < 1 ||
    sessionTimeoutMs > CORRECTION_FLOW_DOCUMENT_REVIEW_SESSION_TIMEOUT_MS
  ) {
    throw new Error("Document review timeout must be between 1 ms and 15 minutes.");
  }
  if (initialDocuments[0].kind !== "resume" || initialDocuments[1].kind !== "cover_letter" ||
    initialRenderedPdfs[0].kind !== "resume" || initialRenderedPdfs[1].kind !== "cover_letter") {
    throw new Error("Document review requires resume then cover letter.");
  }

  const token = randomBytes(32).toString("base64url");
  let origin = "";
  let phase: "reviewing" | "closed" = "reviewing";
  let documents: typeof initialDocuments | null = initialDocuments;
  let renderedPdfs: typeof initialRenderedPdfs | null = initialRenderedPdfs;
  let view: ReturnType<typeof buildCorrectionFlowDocumentReviewView> | null = null;
  const delivered = new Map<"resume" | "cover_letter", string>();
  const activePrivateBodyRequests = new Set<IncomingMessage>();
  const admission = createRepeatableSubmissionAdmission<"document_review">();
  let timer: NodeJS.Timeout | undefined;
  let resolveFinished!: (value: CorrectionFlowDocumentReviewAttestation) => void;
  let rejectFinished!: (error: Error) => void;
  const finished = new Promise<CorrectionFlowDocumentReviewAttestation>((resolve, reject) => {
    resolveFinished = resolve;
    rejectFinished = reject;
  });
  void finished.catch(() => undefined);
  let resolveClosed!: (value: { reason: CloseReason }) => void;
  const closed = new Promise<{ reason: CloseReason }>((resolve) => { resolveClosed = resolve; });
  let closeReason: CloseReason | null = null;

  const server = createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
      if (!origin || request.headers.host !== new URL(origin).host || requestUrl.search) {
        sendOwnerReviewJson(response, 400, { error: "Invalid loopback request" });
        return;
      }
      const paths = pathSet();
      if (request.method === "GET" && requestUrl.pathname === paths.reviewPath) {
        response.writeHead(200, ownerReviewSecurityHeaders("text/html; charset=utf-8", {
          allowSameOriginPdfFrames: true
        }));
        response.end(correctionFlowDocumentReviewHtml(paths));
        return;
      }
      if (request.method === "GET" && requestUrl.pathname === "/document-review.css") {
        response.writeHead(200, ownerReviewSecurityHeaders("text/css; charset=utf-8"));
        response.end(correctionFlowDocumentReviewHtml.css);
        return;
      }
      if (request.method === "GET" && requestUrl.pathname === "/document-review.js") {
        response.writeHead(200, ownerReviewSecurityHeaders("text/javascript; charset=utf-8"));
        response.end(correctionFlowDocumentReviewHtml.javascript);
        return;
      }
      if (request.method === "GET" && requestUrl.pathname === paths.statePath && view && phase === "reviewing") {
        sendOwnerReviewJson(response, 200, view);
        return;
      }
      const pdfIndex = paths.pdfPaths.indexOf(requestUrl.pathname);
      if (pdfIndex >= 0 && request.method === "GET" && renderedPdfs && phase === "reviewing") {
        if (request.headers.range) {
          response.writeHead(416, { ...pdfHeaders(), "content-range": "bytes */0" });
          response.end();
          return;
        }
        const pdf = renderedPdfs[pdfIndex];
        const identity = envelope.documents[pdfIndex];
        response.once("finish", () => {
          if (phase === "reviewing") delivered.set(pdf.kind, identity.renderedPdfHash);
        });
        response.writeHead(200, { ...pdfHeaders(), "content-length": String(pdf.bytes.byteLength) });
        response.end(pdf.bytes);
        return;
      }
      if (requestUrl.pathname === paths.submissionPath && request.method === "POST") {
        if (request.headers.origin !== origin) {
          sendOwnerReviewJson(response, 403, { error: "Origin rejected" });
          return;
        }
        if (phase !== "reviewing" || !view) {
          sendOwnerReviewJson(response, 409, { error: "Review unavailable" });
          return;
        }
        const release = admission.acquire("document_review");
        if (!release) {
          sendOwnerReviewJson(response, 409, { error: "Review unavailable" });
          return;
        }
        activePrivateBodyRequests.add(request);
        try {
          const raw = await readBoundedOwnerReviewBody(request);
          if (phase !== "reviewing" || !view) {
            if (!response.destroyed) sendOwnerReviewJson(response, 409, { error: "Review unavailable" });
            return;
          }
          const attestation = createCorrectionFlowDocumentReviewAttestation(
            envelope,
            [
              { kind: "resume", renderedPdfHash: delivered.get("resume"), delivered: true },
              { kind: "cover_letter", renderedPdfHash: delivered.get("cover_letter"), delivered: true }
            ],
            JSON.parse(raw),
            now().toISOString()
          );
          resolveFinished(attestation);
          response.once("finish", () => close("completed"));
          sendOwnerReviewJson(response, 200, { status: "review_recorded", attestation });
        } finally {
          activePrivateBodyRequests.delete(request);
          release();
        }
        return;
      }
      if (requestUrl.pathname === paths.cancelPath && request.method === "POST") {
        if (request.headers.origin !== origin) {
          sendOwnerReviewJson(response, 403, { error: "Origin rejected" });
          return;
        }
        response.once("finish", () => close("owner_cancel"));
        response.writeHead(204, ownerReviewSecurityHeaders("text/plain; charset=utf-8"));
        response.end();
        return;
      }
      sendOwnerReviewJson(response, 404, { error: "Not found" });
    } catch (error) {
      if (!response.destroyed && !response.writableEnded) {
        sendOwnerReviewJson(response, error instanceof RangeError ? 413 : 400, {
          error: "Document review request rejected"
        });
      }
    }
  });

  const pathSet = () => ({
    reviewPath: `/review/${token}`,
    statePath: `/api/state/${token}`,
    submissionPath: `/api/review/${token}`,
    cancelPath: `/api/cancel/${token}`,
    resumePdfPath: `/artifacts/${token}/resume/${envelope.documents[0].renderedPdfHash}.pdf`,
    coverLetterPdfPath: `/artifacts/${token}/cover-letter/${envelope.documents[1].renderedPdfHash}.pdf`,
    pdfPaths: [
      `/artifacts/${token}/resume/${envelope.documents[0].renderedPdfHash}.pdf`,
      `/artifacts/${token}/cover-letter/${envelope.documents[1].renderedPdfHash}.pdf`
    ]
  });

  const dispose = () => {
    if (renderedPdfs) renderedPdfs.forEach((pdf) => pdf.bytes.fill(0));
    renderedPdfs = null;
    documents = null;
    view = null;
    delivered.clear();
  };

  const close = (reason: CloseReason = "owner_close") => {
    if (closeReason) return;
    closeReason = reason;
    phase = "closed";
    if (timer) clearTimeout(timer);
    for (const request of activePrivateBodyRequests) request.destroy();
    activePrivateBodyRequests.clear();
    dispose();
    if (reason !== "completed") rejectFinished(new Error(`Document review closed: ${reason}.`));
    server.close(() => resolveClosed({ reason }));
  };

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Document review did not obtain a loopback address.");
    origin = `http://127.0.0.1:${address.port}`;
    const paths = pathSet();
    view = buildCorrectionFlowDocumentReviewView({ envelope, documents: initialDocuments, paths });
    timer = setTimeout(() => close("session_timeout"), sessionTimeoutMs);
    timer.unref();
    return Object.freeze({
      origin,
      reviewUrl: `${origin}${paths.reviewPath}`,
      stateUrl: `${origin}${paths.statePath}`,
      submissionUrl: `${origin}${paths.submissionPath}`,
      cancelUrl: `${origin}${paths.cancelPath}`,
      pdfUrls: Object.freeze(paths.pdfPaths.map((path) => `${origin}${path}`)) as readonly [string, string],
      finished,
      closed,
      close,
      phase: () => phase,
      hasPrivateInput: () => documents !== null || renderedPdfs !== null || view !== null,
      deliveredPdfCount: () => delivered.size
    });
  } catch (error) {
    phase = "closed";
    dispose();
    server.close();
    rejectFinished(new Error("Document review failed before startup."));
    throw error;
  }
}
