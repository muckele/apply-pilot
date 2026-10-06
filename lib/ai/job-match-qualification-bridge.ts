import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import {
  buildApplicantQualificationSnapshot,
  buildQualificationPreparation,
  QualificationRunStoppedError,
  runJobMatchQualification,
  type ApplicantQualificationSnapshot,
  type QualificationCase,
  type QualificationExecutionConsent,
  type QualificationHumanReviewAttestation,
  type QualificationPreparation,
  type QualificationReviewCase,
  type QualificationSafeManifest,
  type QualificationTransport
} from "@/lib/ai/job-match-qualification";

export const QUALIFICATION_BRIDGE_MAX_BODY_BYTES = 2_000_000;
export const QUALIFICATION_BRIDGE_DEFAULT_TIMEOUT_MS = 5 * 60_000;

function normalizedOrigin(value: string) {
  const parsed = new URL(value);
  if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== "/"
    || parsed.search || parsed.hash) {
    throw new Error("The qualification bridge requires an exact HTTP(S) application origin.");
  }
  return parsed.origin;
}

function corsHeaders(origin: string) {
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-allow-private-network": "true",
    "cache-control": "private, no-store",
    vary: "Origin"
  };
}

function sendJson(response: ServerResponse, status: number, body: unknown, origin?: string) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "private, no-store",
    ...(origin ? corsHeaders(origin) : {})
  });
  response.end(JSON.stringify(body));
}

async function readBoundedRequestBody(request: IncomingMessage) {
  const declaredLength = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > QUALIFICATION_BRIDGE_MAX_BODY_BYTES) {
    request.resume();
    throw new RangeError("body_limit");
  }
  const chunks: Buffer[] = [];
  let received = 0;
  for await (const chunkValue of request) {
    const chunk = Buffer.isBuffer(chunkValue) ? chunkValue : Buffer.from(chunkValue);
    received += chunk.byteLength;
    if (received > QUALIFICATION_BRIDGE_MAX_BODY_BYTES) throw new RangeError("body_limit");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function buildOwnerBrowserHandoffSnippet({
  bridgeUrl,
  expectedAppOrigin
}: {
  bridgeUrl: string;
  expectedAppOrigin: string;
}) {
  const origin = normalizedOrigin(expectedAppOrigin);
  const bridge = new URL(bridgeUrl);
  if (bridge.protocol !== "http:" || bridge.hostname !== "127.0.0.1") {
    throw new Error("The qualification handoff target must be an HTTP 127.0.0.1 loopback URL.");
  }
  return `(async () => {
  if (location.origin !== ${JSON.stringify(origin)}) throw new Error("Open the authenticated Apply Pilot origin first.");
  const [masterResponse, profileResponse] = await Promise.all([
    fetch("/api/resumes/master", { credentials: "same-origin", cache: "no-store" }),
    fetch("/api/profile", { credentials: "same-origin", cache: "no-store" })
  ]);
  if (!masterResponse.ok || !profileResponse.ok) throw new Error("Authenticated read-only input fetch failed.");
  const masterBody = await masterResponse.json();
  const profileBody = await profileResponse.json();
  const resume = masterBody.resume;
  const profile = profileBody.profile;
  if (!resume || !profile) throw new Error("A saved master resume and profile are required.");
  const payload = {
    master: { resume: {
      id: resume.id,
      parsedAt: resume.parsedAt,
      summary: resume.summary,
      rawText: resume.rawText,
      skills: resume.skills,
      achievements: resume.achievements,
      workHistory: resume.workHistory,
      projects: resume.projects,
      education: resume.education,
      certifications: resume.certifications
    } },
    profile: { profile: {
      careerGoals: profile.careerGoals,
      preferredRoles: profile.preferredRoles,
      preferredLocations: profile.preferredLocations,
      remotePreference: profile.remotePreference,
      salaryTargetMin: profile.salaryTargetMin,
      salaryTargetMax: profile.salaryTargetMax,
      skillsToEmphasize: profile.skillsToEmphasize,
      skillsNotToExaggerate: profile.skillsNotToExaggerate
    } }
  };
  const handoff = await fetch(${JSON.stringify(bridge.toString())}, {
    method: "POST",
    mode: "cors",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!handoff.ok) throw new Error("The local one-shot handoff was rejected.");
  console.log(await handoff.json());
})();`;
}

async function startQualificationBridge<Result>({
  allowedOrigin: allowedOriginValue,
  cases,
  consume,
  now = new Date(),
  timeoutMs = QUALIFICATION_BRIDGE_DEFAULT_TIMEOUT_MS
}: {
  allowedOrigin: string;
  cases: readonly QualificationCase[];
  consume: (
    preparation: QualificationPreparation,
    snapshot: ApplicantQualificationSnapshot
  ) => Promise<Result>;
  now?: Date;
  timeoutMs?: number;
}) {
  const allowedOrigin = normalizedOrigin(allowedOriginValue);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > QUALIFICATION_BRIDGE_DEFAULT_TIMEOUT_MS) {
    throw new Error("The qualification bridge timeout must be between 1 ms and 5 minutes.");
  }
  const token = randomBytes(32).toString("base64url");
  const path = `/qualification-input/${token}`;
  let accepted = false;
  let consuming = false;
  let resolveDone!: (result: Result) => void;
  let rejectDone!: (error: Error) => void;
  const done = new Promise<Result>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });

  const server = createServer(async (request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    if (requestUrl.pathname !== path) {
      sendJson(response, 404, { error: "Not found" });
      return;
    }
    const origin = request.headers.origin;
    if (origin !== allowedOrigin) {
      sendJson(response, 403, { error: "Origin rejected" });
      return;
    }
    if (request.method === "OPTIONS") {
      response.writeHead(204, corsHeaders(allowedOrigin));
      response.end();
      return;
    }
    if (request.method !== "POST") {
      response.writeHead(405, { allow: "POST, OPTIONS", ...corsHeaders(allowedOrigin) });
      response.end();
      return;
    }
    if (accepted || consuming) {
      sendJson(response, 409, { error: "Handoff already consumed" }, allowedOrigin);
      return;
    }
    if (!(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
      sendJson(response, 415, { error: "JSON required" }, allowedOrigin);
      return;
    }

    try {
      consuming = true;
      const raw = await readBoundedRequestBody(request);
      const payload = JSON.parse(raw) as { master?: unknown; profile?: unknown };
      const snapshot = buildApplicantQualificationSnapshot(payload.master, payload.profile);
      const preparation = buildQualificationPreparation(snapshot, cases, now);
      accepted = true;
      server.close();
      const result = await consume(preparation, snapshot);
      sendJson(response, 200, result, allowedOrigin);
      resolveDone(result);
    } catch (error) {
      if (accepted) {
        sendJson(response, 400, { error: "Qualification execution rejected" }, allowedOrigin);
        rejectDone(new Error("Qualification execution rejected without retaining private input or raw output."));
        return;
      }
      consuming = false;
      if (error instanceof RangeError) {
        sendJson(response, 413, { error: "Handoff body too large" }, allowedOrigin);
      } else {
        sendJson(response, 400, { error: "Invalid qualification input" }, allowedOrigin);
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("The qualification bridge did not obtain a loopback TCP address.");
  }
  const url = `http://127.0.0.1:${address.port}${path}`;
  const timeout = setTimeout(() => {
    if (accepted) return;
    server.close();
    rejectDone(new Error("The one-shot qualification bridge expired without retaining input."));
  }, timeoutMs);
  timeout.unref();

  return {
    url,
    token,
    done: done.finally(() => clearTimeout(timeout)),
    close() {
      clearTimeout(timeout);
      server.close();
    }
  };
}

export async function startJobMatchQualificationBridge({
  allowedOrigin,
  cases,
  now = new Date(),
  timeoutMs = QUALIFICATION_BRIDGE_DEFAULT_TIMEOUT_MS
}: {
  allowedOrigin: string;
  cases: readonly QualificationCase[];
  now?: Date;
  timeoutMs?: number;
}) {
  return startQualificationBridge<QualificationSafeManifest>({
    allowedOrigin,
    cases,
    now,
    timeoutMs,
    consume: async (preparation) => preparation.safeManifest
  });
}

export async function startJobMatchQualificationExecutionBridge({
  allowedOrigin,
  cases,
  attestHumanInputs,
  authorizeExecution,
  transport,
  reviewCase,
  now = new Date(),
  timeoutMs = QUALIFICATION_BRIDGE_DEFAULT_TIMEOUT_MS
}: {
  allowedOrigin: string;
  cases: readonly QualificationCase[];
  attestHumanInputs: (
    draftPreparation: QualificationPreparation
  ) => Promise<readonly QualificationHumanReviewAttestation[]>;
  authorizeExecution: (
    reviewedManifest: QualificationSafeManifest
  ) => Promise<QualificationExecutionConsent>;
  transport: QualificationTransport;
  reviewCase: QualificationReviewCase;
  now?: Date;
  timeoutMs?: number;
}) {
  return startQualificationBridge<unknown>({
    allowedOrigin,
    cases,
    now,
    timeoutMs,
    consume: async (draftPreparation, snapshot) => {
      const humanReviews = await attestHumanInputs(draftPreparation);
      const reviewedPreparation = buildQualificationPreparation(snapshot, cases, now, humanReviews);
      const consent = await authorizeExecution(reviewedPreparation.safeManifest);
      try {
        return await runJobMatchQualification({
          preparation: reviewedPreparation,
          consent,
          transport,
          reviewCase,
          now
        });
      } catch (error) {
        if (error instanceof QualificationRunStoppedError) return error.safeReport;
        throw error;
      }
    }
  });
}
