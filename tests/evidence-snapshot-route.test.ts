import assert from "node:assert/strict";
import test from "node:test";

import { NextRequest } from "next/server";

import { createEvidenceSnapshotRouteHandlers } from "@/lib/jobs/evidence-snapshot-route";
import { UnauthorizedError } from "@/lib/user-context";

const requestBody = {
  schema: "apply-pilot/evidence-snapshot-save/v1",
  requestId: "evidence-request-123",
  resumeId: "resume-1",
  resumeUpdatedAt: "2026-10-08T12:00:00.000Z",
  reviewedAnalysis: {
    id: "analysis-1",
    inputHash: "a".repeat(64),
    model: "gemini-3.8-flash",
    promptVersion: "3.4"
  },
  decisions: [{
    gapId: "gap:0",
    kind: "UNRESOLVED",
    reuseScope: "JOB_ONLY",
    masterProfileOptIn: false
  }]
};

function request(body: unknown) {
  return new NextRequest("http://localhost/api/jobs/job-1/evidence-snapshots", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

function result(replayed: boolean) {
  return {
    schema: "apply-pilot/evidence-snapshot-save-response/v1" as const,
    snapshot: {
      id: "snapshot-1",
      hash: "b".repeat(64),
      createdAt: "2026-10-08T12:30:00.000Z",
      isCurrent: true
    },
    replayed,
    invalidations: {
      assessmentIds: ["analysis-1"],
      resumeDocumentIds: [],
      coverLetterDocumentIds: [],
      totalCount: 1,
      reason: "EVIDENCE_SNAPSHOT_CHANGED" as const
    }
  };
}

test("snapshot POST authenticates, strictly validates, rate limits, and returns no-store creation", async () => {
  const calls: string[] = [];
  const handlers = createEvidenceSnapshotRouteHandlers({
    requireUserId: async () => {
      calls.push("auth");
      return "user-1";
    },
    checkRateLimit: async () => {
      calls.push("rate");
    },
    saveEvidenceSnapshot: async (userId, jobId, input) => {
      calls.push(`save:${userId}:${jobId}`);
      assert.deepEqual(input, requestBody);
      return result(false);
    }
  });

  const invalid = await handlers.POST(request({ ...requestBody, snapshotHash: "attacker" }), {
    params: Promise.resolve({ id: "job-1" })
  });
  assert.equal(invalid.status, 422);
  assert.equal(invalid.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(calls, ["auth"]);

  calls.length = 0;
  const created = await handlers.POST(request(requestBody), {
    params: Promise.resolve({ id: "job-1" })
  });
  assert.equal(created.status, 201);
  assert.equal(created.headers.get("Cache-Control"), "no-store");
  assert.equal((await created.json()).replayed, false);
  assert.deepEqual(calls, ["auth", "rate", "save:user-1:job-1"]);
});

test("snapshot POST returns 200 for replay and rejects unauthenticated input before dispatch", async () => {
  let saves = 0;
  const replay = createEvidenceSnapshotRouteHandlers({
    requireUserId: async () => "user-1",
    checkRateLimit: async () => undefined,
    saveEvidenceSnapshot: async () => {
      saves += 1;
      return result(true);
    }
  });
  const replayed = await replay.POST(request(requestBody), {
    params: Promise.resolve({ id: "job-1" })
  });
  assert.equal(replayed.status, 200);
  assert.equal(replayed.headers.get("Cache-Control"), "no-store");

  const denied = createEvidenceSnapshotRouteHandlers({
    requireUserId: async () => { throw new UnauthorizedError(); },
    checkRateLimit: async () => { throw new Error("unexpected rate limit"); },
    saveEvidenceSnapshot: async () => {
      saves += 1;
      return result(false);
    }
  });
  const response = await denied.POST(request(requestBody), {
    params: Promise.resolve({ id: "job-1" })
  });
  assert.equal(response.status, 401);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(saves, 1);
});
