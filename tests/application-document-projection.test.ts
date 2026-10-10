import assert from "node:assert/strict";
import { test } from "node:test";

import * as projection from "@/lib/ai/resume-tailoring-payload";

test("application documents expose one shared projection that excludes ORM metadata", () => {
  const build = (projection as Record<string, unknown>).buildApplicationDocumentPayload;
  assert.equal(typeof build, "function");
  const payload = (build as (job: unknown, resume: unknown, profile: unknown, evidence: unknown) => Record<string, unknown>)(
    {
      id: "job-secret-id",
      userId: "user-secret-id",
      createdAt: "never-send",
      title: "Platform Engineer",
      company: "Example Co",
      description: "Build TypeScript services.",
      requirements: ["TypeScript"]
    },
    {
      id: "resume-secret-id",
      userId: "user-secret-id",
      rawText: "Synthetic Applicant\nTypeScript",
      summary: "Platform engineer",
      skills: ["TypeScript"],
      achievements: [],
      workHistory: [{
        id: "nested-secret-id",
        sourceText: "Example Co | Platform Engineer\nBuilt TypeScript services.",
        company: "Example Co",
        title: "Platform Engineer",
        bullets: ["Built TypeScript services."]
      }]
    },
    {
      id: "profile-secret-id",
      userId: "user-secret-id",
      careerGoals: "Build reliable systems",
      preferredRoles: ["Platform Engineer"]
    },
    {
      schema: "apply-pilot/job-match-reviewed-evidence/v1",
      snapshotId: "snapshot-safe-id",
      snapshotHash: "a".repeat(64),
      facts: [{
        gapId: "gap:0",
        fact: "Owner-attested synthetic customer training experience.",
        provenance: "OWNER_ATTESTED",
        sourceRef: null,
        internalSecret: "never-send"
      }],
      unresolvedGapIds: []
    }
  );

  assert.deepEqual(Object.keys(payload), ["job", "resume", "profile", "reviewedEvidence"]);
  assert.doesNotMatch(JSON.stringify(payload), /job-secret-id|user-secret-id|resume-secret-id|profile-secret-id|nested-secret-id|never-send/);
  assert.deepEqual(Object.keys(payload.job as object), ["title", "company", "description", "requirements"]);
  assert.deepEqual(Object.keys((payload.resume as { workHistory: object[] }).workHistory[0]), [
    "sourceText", "company", "title", "bullets"
  ]);
  assert.deepEqual(
    Object.keys((payload.reviewedEvidence as { facts: object[] }).facts[0]),
    ["gapId", "fact", "provenance", "sourceRef"]
  );
});
