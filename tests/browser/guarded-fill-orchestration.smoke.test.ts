import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { chromium, type Browser } from "playwright";

import { MISSING_CHROMIUM_MESSAGE } from "@/lib/application-browser/browser-runtime";
import { createPlaywrightTargetController } from "@/lib/application-browser/coordinator";
import { createGuardedFillOrchestrationService } from "@/lib/application-browser/fill-orchestration";
import { createApplicationFormInspectionController } from "@/lib/application-browser/form-inspection-controller";
import {
  createProtectedApplicationBrowserSession,
  type ProtectedCandidateFieldWriteRequest
} from "@/lib/application-browser/protected-browser-session";
import type {
  BrowserFillAcquisition,
  BrowserFillAttemptStatus,
  BrowserFillFinalizeInput,
  SameOriginClientWithFill
} from "@/lib/application-browser/same-origin-client";
import { buildNormalizedApplicationFormInspection } from "@/lib/application-runs/form-inspection";
import { parseExecutionTargetUrl } from "@/lib/application-runs/host-policy";

import {
  assertNoSubmission,
  boundedWriterFixture,
  type FormFillTrapSnapshot
} from "./form-fill-fixtures";

const TARGET_URL = "https://fixture.invalid/apply";
const TARGET_HOST = "fixture.invalid";
const RUN_ID = "clz8w7m9a0002qwer1234tyui";
const ATTEMPT_ID = "550e8400-e29b-41d4-a716-446655440000";
const LEASE_EXPIRES_AT = "2026-09-10T20:10:00.000Z";
const PACKET_HASH = "e".repeat(64);

let browser: Browser;

before(async () => {
  try {
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    if (
      error instanceof Error &&
      /executable.*(doesn'?t exist|missing|not found)|playwright install/i.test(error.message)
    ) {
      throw new Error(MISSING_CHROMIUM_MESSAGE);
    }
    throw error;
  }
});

after(async () => {
  await browser?.close();
});

test("guarded orchestration uses the exact private generation and server order without submit authority", async () => {
  const context = await browser.newContext();
  const unsafeCodes: string[] = [];
  const targetController = createPlaywrightTargetController({
    context,
    onUnsafe(code) {
      unsafeCodes.push(code);
    },
    testOnlyCreateProtectedSession: (page) =>
      createProtectedApplicationBrowserSession({ page }),
    async testOnlyFulfillMainDocument(_request, route) {
      await route.fulfill({
        status: 200,
        contentType: "text/html; charset=utf-8",
        body: boundedWriterFixture()
      });
    }
  });
  const target = parseExecutionTargetUrl(TARGET_URL);
  assert.ok(target);

  let controller: ReturnType<typeof createApplicationFormInspectionController> | null = null;
  try {
    await targetController.open({
      target,
      policy: {
        effectiveEnabled: true,
        allowedHosts: [TARGET_HOST],
        blockedHosts: []
      }
    }, () => undefined);
    const page = targetController.page();
    const protectedTarget = targetController.formInspectionTarget();
    assert.ok(page);
    assert.ok(protectedTarget);

    controller = createApplicationFormInspectionController({
      target: protectedTarget,
      authoritativeApplyHost: TARGET_HOST
    });
    const generation = await controller.inspect();
    const normalized = buildNormalizedApplicationFormInspection({
      authoritativeApplyHost: TARGET_HOST,
      report: generation.inspectionReport
    });
    const allFields = normalized.snapshot.forms.flatMap((form) =>
      form.sections.flatMap((section) => section.fields)
    );
    const field = (question: string) => {
      const matches = allFields.filter((candidate) => candidate.question === question);
      assert.equal(matches.length, 1, `expected one normalized field for ${question}`);
      return matches[0];
    };
    const url = field("Empty URL");
    const occupiedText = field("Occupied text");
    const select = field("Empty select");
    assert.equal(url.fieldType, "URL");
    assert.equal(occupiedText.fieldType, "TEXT");
    assert.equal(select.fieldType, "SELECT_ONE");
    const selectedChoice = select.choices.find((choice) => choice.label === "A");
    assert.ok(selectedChoice);

    const acquiredFields: BrowserFillAcquisition["eligibleFields"] = Object.freeze([
      Object.freeze({
        stepKey: `fill:${ATTEMPT_ID}:${url.normalizedFieldKey}`,
        normalizedFieldKey: url.normalizedFieldKey,
        fieldFingerprint: url.fieldFingerprint,
        fieldType: "URL" as const,
        proposal: Object.freeze({
          kind: "SCALAR" as const,
          value: "https://portfolio.example.test"
        })
      }),
      Object.freeze({
        stepKey: `fill:${ATTEMPT_ID}:${occupiedText.normalizedFieldKey}`,
        normalizedFieldKey: occupiedText.normalizedFieldKey,
        fieldFingerprint: occupiedText.fieldFingerprint,
        fieldType: "TEXT" as const,
        proposal: Object.freeze({ kind: "SCALAR" as const, value: "MUST-NOT-OVERWRITE" })
      }),
      Object.freeze({
        stepKey: `fill:${ATTEMPT_ID}:${select.normalizedFieldKey}`,
        normalizedFieldKey: select.normalizedFieldKey,
        fieldFingerprint: select.fieldFingerprint,
        fieldType: "SELECT_ONE" as const,
        proposal: Object.freeze({
          kind: "OPTIONS" as const,
          optionKeys: Object.freeze([selectedChoice.key]) as readonly [string]
        })
      })
    ]);
    const acquisition: BrowserFillAcquisition = Object.freeze({
      attemptId: ATTEMPT_ID,
      runStateVersion: 8,
      leaseExpiresAt: LEASE_EXPIRES_AT,
      formInspectionVersion: 2,
      answerPacketVersion: 3,
      packetHash: PACKET_HASH,
      formFingerprint: normalized.formFingerprint,
      eligibleFields: acquiredFields
    });
    const liveStatus = (): BrowserFillAttemptStatus => Object.freeze({
      state: "FILLING",
      stateVersion: acquisition.runStateVersion,
      fillAttemptId: acquisition.attemptId,
      fillLeaseExpiresAt: acquisition.leaseExpiresAt,
      leaseLive: true,
      expiredRecoveryRequired: false,
      fieldOperationAllowed: true,
      outcome: null,
      errorCode: null,
      steps: Object.freeze([])
    });
    const calls: string[] = [];
    let finalization: BrowserFillFinalizeInput | null = null;
    const client = {
      async getApplicationRun(runId: string) {
        calls.push("run");
        assert.equal(runId, RUN_ID);
        return {
          id: RUN_ID,
          state: "READY" as const,
          stateVersion: 7,
          applyHost: TARGET_HOST,
          applyUrlSnapshot: TARGET_URL
        };
      },
      async getAutomationPolicy() {
        calls.push("policy");
        return {
          effectiveEnabled: true,
          allowedHosts: [TARGET_HOST],
          blockedHosts: []
        };
      },
      async getCurrentAnswerPacket(runId: string) {
        calls.push("packet");
        assert.equal(runId, RUN_ID);
        return {
          runId: RUN_ID,
          current: { inspectionVersion: 2, answerPacketVersion: 3 }
        };
      },
      async publishFormInspection(): Promise<never> {
        throw new Error("publication is outside the guarded Fill smoke");
      },
      async acquireFillAttempt(input: unknown, assertReadyToDispatch: () => void) {
        calls.push("acquire");
        assert.deepEqual(input, { runId: RUN_ID, expectedStateVersion: 7 });
        assertReadyToDispatch();
        return acquisition;
      },
      async getFillAttemptStatus(runId: string) {
        calls.push("status");
        assert.equal(runId, RUN_ID);
        return liveStatus();
      },
      async finalizeFillAttempt(
        input: BrowserFillFinalizeInput,
        assertReadyToDispatch: () => void
      ) {
        calls.push("finalize");
        assertReadyToDispatch();
        finalization = structuredClone(input);
        return Object.freeze({
          state: "READY_FOR_USER_SUBMISSION" as const,
          stateVersion: input.expectedStateVersion + 1,
          fillAttemptId: input.fillAttemptId,
          fillLeaseExpiresAt: null,
          leaseLive: false,
          expiredRecoveryRequired: false,
          fieldOperationAllowed: false,
          outcome: input.outcome,
          errorCode: input.errorCode,
          steps: input.steps
        });
      },
      async recoverExpiredFillAttempt(): Promise<never> {
        throw new Error("live smoke must not recover");
      }
    } satisfies SameOriginClientWithFill;

    const writeRequests: ProtectedCandidateFieldWriteRequest[] = [];
    let writesInFlight = 0;
    let maximumWritesInFlight = 0;
    const service = createGuardedFillOrchestrationService({
      client,
      controller: {
        currentTargetUrl: () => protectedTarget.currentTargetUrl(),
        assertCurrent: (generationId) => controller!.assertCurrent(generationId),
        assertAcquiredFillAuthority: (generationId, authority) =>
          controller!.assertAcquiredFillAuthority(generationId, authority),
        async writeApprovedField(generationId, request) {
          writeRequests.push(structuredClone(request));
          writesInFlight += 1;
          maximumWritesInFlight = Math.max(maximumWritesInFlight, writesInFlight);
          try {
            return await controller!.writeApprovedField(generationId, request);
          } finally {
            writesInFlight -= 1;
          }
        }
      },
      now: () => Date.parse("2026-09-10T20:00:00.000Z")
    });

    const originalUrl = page.url();
    let navigation = 0;
    let popup = 0;
    let syntheticSubmissionRequest = 0;
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) navigation += 1;
    });
    page.on("popup", () => {
      popup += 1;
    });
    context.on("request", (request) => {
      if (request.url().includes("/__apply_pilot_submit")) {
        syntheticSubmissionRequest += 1;
      }
    });

    const outcome = await service.execute({
      runId: RUN_ID,
      generationId: generation.generationId,
      formInspectionVersion: 2,
      answerPacketVersion: 3,
      frozenTargetUrl: TARGET_URL,
      assertActive: () => undefined
    });

    assert.equal(outcome.disposition, "FINALIZED");
    assert.deepEqual(calls, [
      "run",
      "policy",
      "packet",
      "acquire",
      "status",
      "status",
      "status",
      "status",
      "finalize"
    ]);
    assert.equal(maximumWritesInFlight, 1);
    assert.deepEqual(
      writeRequests.map((request) => request.normalizedFieldKey),
      acquiredFields.map((candidate) => candidate.normalizedFieldKey)
    );
    assert.equal(new Set(writeRequests.map((request) => request.normalizedFieldKey)).size, 3);
    assert.deepEqual(finalization, {
      runId: RUN_ID,
      fillAttemptId: ATTEMPT_ID,
      expectedStateVersion: 8,
      outcome: "COMPLETED",
      errorCode: null,
      steps: [
        { stepKey: acquiredFields[0].stepKey, result: "FILLED", errorCode: null },
        {
          stepKey: acquiredFields[1].stepKey,
          result: "PRESERVED_EXISTING",
          errorCode: null
        },
        { stepKey: acquiredFields[2].stepKey, result: "FILLED", errorCode: null }
      ]
    });
    assert.equal(JSON.stringify(finalization).includes("portfolio.example.test"), false);
    assert.equal(JSON.stringify(outcome).includes("portfolio.example.test"), false);

    assert.equal(await page.locator("#url-empty").inputValue(), "https://portfolio.example.test");
    assert.equal(await page.locator("#text-occupied").inputValue(), "SECRET-OCCUPIED-TEXT");
    assert.equal(await page.locator("#select-empty").inputValue(), "SECRET-A");
    assert.equal(await page.locator("#radio-a").isChecked(), false);
    assert.equal(await page.locator("#radio-b").isChecked(), false);
    assert.equal(await page.locator("#checkbox-unchecked").isChecked(), false);
    assert.equal(await page.locator("#checkbox-checked").isChecked(), true);
    assert.equal(page.url(), originalUrl);

    const localTraps = await page.evaluate(() => window.__formFillTraps!);
    const traps: FormFillTrapSnapshot = {
      ...localTraps,
      navigation,
      popup,
      syntheticSubmissionRequest
    };
    assert.deepEqual(traps.eventLog, [
      "url-empty:input",
      "select-empty:input",
      "select-empty:change"
    ]);
    assert.equal(traps.input, 2);
    assert.equal(traps.change, 1);
    assert.equal(traps.click, 0);
    assert.equal(traps.focus, 0);
    assert.equal(traps.keyboard, 0);
    assert.equal(traps.pointer, 0);
    assert.equal(traps.mouse, 0);
    assertNoSubmission(traps);
    assert.deepEqual(unsafeCodes, []);
  } finally {
    await controller?.close().catch(() => undefined);
    await targetController.close().catch(() => undefined);
    await context.close().catch(() => undefined);
  }
});
