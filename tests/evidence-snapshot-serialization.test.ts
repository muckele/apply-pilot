import assert from "node:assert/strict";
import test from "node:test";

import { Prisma } from "@prisma/client";

import { isEvidenceSnapshotSerializationConflict } from "@/lib/jobs/evidence-snapshots";

function prismaError(code: string, meta?: Record<string, unknown>) {
  return new Prisma.PrismaClientKnownRequestError("synthetic", {
    code,
    clientVersion: Prisma.prismaVersion.client,
    meta
  });
}

test("evidence snapshot serialization conflicts recognize direct and wrapped PostgreSQL forms", () => {
  assert.equal(isEvidenceSnapshotSerializationConflict(prismaError("P2034")), true);
  assert.equal(isEvidenceSnapshotSerializationConflict(prismaError("P2010", { code: "40001" })), true);
  assert.equal(isEvidenceSnapshotSerializationConflict(prismaError("P2010", { code: "40P01" })), false);
  assert.equal(isEvidenceSnapshotSerializationConflict(prismaError("P2002")), false);
  assert.equal(isEvidenceSnapshotSerializationConflict(new Error("40001")), false);
});
