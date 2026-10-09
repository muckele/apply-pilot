import assert from "node:assert/strict";
import test from "node:test";

import { PrismaClient } from "@prisma/client";

import {
  SYNTHETIC_CORRECTION_FLOW_DUMMY_CREDENTIALS,
  createSyntheticCorrectionFlowProviderFetches
} from "@/evaluation/correction-flow-provider-stub";
import { SYNTHETIC_CORRECTION_FLOW_FIXTURE } from "@/evaluation/correction-flow-qualification-fixture";
import { runDurableCorrectionFlowQualification } from "@/lib/ai/correction-flow-durable-driver";
import {
  buildCorrectionFlowQualificationManifest,
  correctionFlowQualificationConsent
} from "@/lib/ai/correction-flow-qualification";
import {
  assertPostgresTestMajorVersion,
  validatePostgresTestEnvironment,
  verifyLivePostgresTestDatabase
} from "@/tests/postgres/postgres-test-harness";

const exactHead = "68a05e6c24b3be7efdd3471fc4b1ae9222363b8b";

test("offline qualification runner composes correction, reassessment, both documents, exports, and cleanup", async () => {
  const config = validatePostgresTestEnvironment(process.env);
  const live = await verifyLivePostgresTestDatabase(config);
  assertPostgresTestMajorVersion(live);
  const client = new PrismaClient({ datasources: { db: { url: config.url } } });
  const manifest = buildCorrectionFlowQualificationManifest({
    exactHead,
    providerMode: "offline_stubbed",
    generatedAt: new Date("2026-10-09T02:00:00.000Z"),
    fixture: SYNTHETIC_CORRECTION_FLOW_FIXTURE
  });
  const consent = correctionFlowQualificationConsent.parse({
    manifestHash: manifest.manifestHash,
    exactHead,
    providerMode: "offline_stubbed",
    approvedCallCount: 4,
    approvedConservativeReservationMicros: manifest.conservativeReservationMicros,
    approvedStepTimeoutMs: manifest.stepTimeoutMs,
    syntheticApplicantDataSharingApproved: true,
    existingCredentialUseApproved: false,
    noRetry: true,
    noOwnerData: true,
    noProductionWrites: true,
    noEmployerInteraction: true,
    cleanupRequired: true,
    approvedAt: "2026-10-09T02:05:00.000Z"
  });

  try {
    assert.equal(await syntheticUserCount(client), 0);
    const receipt = await runDurableCorrectionFlowQualification({
      databaseUrl: config.url,
      manifest,
      consent,
      credentials: SYNTHETIC_CORRECTION_FLOW_DUMMY_CREDENTIALS,
      fetches: createSyntheticCorrectionFlowProviderFetches()
    });

    assert.equal(receipt.status, "passed", JSON.stringify(receipt));
    assert.equal(receipt.providerCallsStarted, 4);
    assert.equal(receipt.providerCallsCompleted, 4);
    assert.equal(receipt.knownEstimatedCostMicros, 1_052);
    assert.equal(receipt.cleanupStatus, "completed");
    assert.equal(await syntheticUserCount(client), 0);
    assert.doesNotMatch(JSON.stringify(receipt), /Taylor Boundary|Quenby|Business Administration/u);
  } finally {
    await client.user.deleteMany({ where: { name: "Synthetic Correction Qualification" } });
    await client.$disconnect();
  }
});

function syntheticUserCount(client: PrismaClient) {
  return client.user.count({ where: { name: "Synthetic Correction Qualification" } });
}
