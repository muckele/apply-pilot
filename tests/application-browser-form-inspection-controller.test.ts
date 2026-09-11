import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ApplicationFormInspectionControllerError,
  createApplicationFormInspectionControllerWithRuntime,
  MAX_STABILIZATION_MS,
  RELEVANT_MUTATION_QUIET_MS,
  SEMANTIC_EXTRACTION_GAP_MS,
  type ApplicationFormInspectionControllerRuntime,
  type ApplicationFormInspectionInvalidationCode,
  type ProtectedFormInspectionAuthority,
  type ProtectedFormInspectionTarget
} from "@/lib/application-browser/form-inspection-controller";
import type {
  BrowserDocumentFence,
  OpaqueExtractionCandidate,
  OpaqueProtectedChoiceReference,
  OpaqueProtectedFieldReference,
  ProtectedApplicationFormExtraction,
  ProtectedCandidateVerification,
  ProtectedSessionLifecycleCode
} from "@/lib/application-browser/protected-browser-session";
import {
  ProtectedApplicationFormExtractionError,
  ProtectedBrowserSessionError
} from "@/lib/application-browser/protected-browser-session";
import {
  applicationFormInspectionReportSchema,
  FORM_INSPECTION_SCHEMA_VERSION,
  type ApplicationFormInspectionReport
} from "@/lib/application-runs/form-inspection";

const AUTHORITATIVE_APPLY_HOST = "jobs.example.com";
const TARGET_URL = "https://jobs.example.com/apply";

function report(
  question = "Legal name",
  input: Readonly<{ required?: boolean }> = {}
): ApplicationFormInspectionReport {
  return applicationFormInspectionReportSchema.parse({
    schemaVersion: FORM_INSPECTION_SCHEMA_VERSION,
    forms: [{
      title: "Application",
      sections: [{
        heading: "Candidate",
        fields: [{
          question,
          helpText: "Use your legal name",
          fieldType: "TEXT",
          unsupportedReason: null,
          required: input.required ?? true,
          autocomplete: "name",
          constraints: {
            minLength: null,
            maxLength: 100,
            min: null,
            max: null,
            step: null,
            acceptedFileTypes: [],
            multiple: false
          },
          choices: []
        }]
      }]
    }]
  });
}

function opaque<T extends object>(): T {
  return Object.freeze(Object.create(null)) as T;
}

type ControlledExtraction = Readonly<{
  value: ProtectedApplicationFormExtraction;
  candidate: OpaqueExtractionCandidate;
  fieldReference: OpaqueProtectedFieldReference;
  choiceReference: OpaqueProtectedChoiceReference;
  disposeCalls(): number;
}>;

function controlledExtraction(
  inspectionReport = report(),
  disposeImpl: () => Promise<void> = () => Promise.resolve()
): ControlledExtraction {
  const candidate = opaque<OpaqueExtractionCandidate>();
  const fieldReference = opaque<OpaqueProtectedFieldReference>();
  const choiceReference = opaque<OpaqueProtectedChoiceReference>();
  let disposals = 0;
  let disposal: Promise<void> | null = null;
  return {
    candidate,
    fieldReference,
    choiceReference,
    value: {
      candidate,
      report: inspectionReport,
      fields: [{
        sourceOrdinal: { form: 0, section: 0, field: 0 },
        reference: fieldReference,
        choices: []
      }],
      sealWriterTargets() {
        return Promise.resolve();
      },
      dispose() {
        disposal ??= Promise.resolve().then(() => {
          disposals += 1;
          return disposeImpl();
        });
        return disposal;
      }
    },
    disposeCalls: () => disposals
  };
}

type Deferred<T> = Readonly<{
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}>;

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

type Queued<T> = T | Error | Promise<T> | (() => T | Promise<T>);

async function settleQueued<T>(queued: Queued<T>): Promise<T> {
  if (queued instanceof Error) throw queued;
  return typeof queued === "function"
    ? (queued as () => T | Promise<T>)()
    : queued;
}

class FakeProtectedTarget {
  readonly calls: string[] = [];
  readonly readiness: Queued<void>[] = [];
  readonly extractions: Queued<ProtectedApplicationFormExtraction>[] = [];
  readonly verifications: Queued<ProtectedCandidateVerification>[] = [];
  readonly snapshots: Queued<BrowserDocumentFence>[] = [];
  readonly waits: Queued<BrowserDocumentFence>[] = [];
  readonly reportsByCandidate = new Map<OpaqueExtractionCandidate, ApplicationFormInspectionReport>();
  readonly lifecycleListeners = new Set<(code: ProtectedSessionLifecycleCode) => void | Promise<void>>();
  readonly navigationListeners = new Set<() => void>();
  fence: BrowserDocumentFence = {
    documentEpoch: 0,
    semanticRevision: 0,
    applicantStateEpoch: 0
  };
  url: string | null = TARGET_URL;

  readonly authority: ProtectedFormInspectionAuthority = Object.freeze({
    waitUntilReady: async () => {
      this.calls.push("ready");
      const queued = this.readiness.shift();
      if (queued !== undefined) await settleQueued(queued);
    },
    extractApplicationForm: async () => {
      this.calls.push("extract");
      const queued = this.extractions.shift();
      if (!queued) throw new Error("unexpected protected extraction");
      const extraction = await settleQueued(queued);
      this.reportsByCandidate.set(extraction.candidate, extraction.report);
      return extraction;
    },
    verifyCandidate: async (candidate) => {
      this.calls.push(`verify:${this.candidateLabel(candidate)}`);
      const queued = this.verifications.shift();
      if (queued) return settleQueued(queued);
      const candidateReport = this.reportsByCandidate.get(candidate);
      return candidateReport
        ? { status: "CURRENT", report: structuredClone(candidateReport), fence: this.fence }
        : { status: "INVALID" };
    },
    snapshot: async () => {
      this.calls.push("snapshot");
      const queued = this.snapshots.shift();
      if (!queued) return this.fence;
      const value = await settleQueued(queued);
      this.fence = value;
      return value;
    },
    waitForChange: async (_since, timeoutMs) => {
      this.calls.push(`wait:${timeoutMs}`);
      const queued = this.waits.shift();
      if (!queued) return this.fence;
      const value = await settleQueued(queued);
      this.fence = value;
      return value;
    },
    subscribe: (listener) => {
      this.lifecycleListeners.add(listener);
      return () => this.lifecycleListeners.delete(listener);
    }
  });

  readonly target: ProtectedFormInspectionTarget = Object.freeze({
    authority: this.authority,
    currentTargetUrl: () => this.url,
    subscribeMainFrameNavigation: (listener) => {
      this.navigationListeners.add(listener);
      return () => this.navigationListeners.delete(listener);
    }
  });

  enqueueExtraction(value: Queued<ProtectedApplicationFormExtraction>): void {
    this.extractions.push(value);
  }

  enqueueReadiness(value: Queued<void>): void {
    this.readiness.push(value);
  }

  enqueueVerification(value: Queued<ProtectedCandidateVerification>): void {
    this.verifications.push(value);
  }

  enqueueWait(value: Queued<BrowserDocumentFence>): void {
    this.waits.push(value);
  }

  emitLifecycle(code: ProtectedSessionLifecycleCode): void {
    for (const listener of this.lifecycleListeners) void listener(code);
  }

  emitNavigation(): void {
    for (const listener of this.navigationListeners) listener();
  }

  private candidateLabel(candidate: OpaqueExtractionCandidate): string {
    const index = [...this.reportsByCandidate.keys()].indexOf(candidate);
    return index < 0 ? "unknown" : String(index + 1);
  }
}

class ManualRuntime implements ApplicationFormInspectionControllerRuntime {
  private nextTimer = 1;
  private readonly timers = new Map<number, () => void>();
  private nowAfterNextRead: number | null = null;
  private scheduledAdvances = 0;
  nowMs = 0;

  now(): number {
    const observed = this.nowMs;
    if (this.nowAfterNextRead !== null) {
      this.nowMs = this.nowAfterNextRead;
      this.nowAfterNextRead = null;
      this.scheduledAdvances += 1;
    }
    return observed;
  }

  setTimer(callback: () => void): unknown {
    const id = this.nextTimer;
    this.nextTimer += 1;
    this.timers.set(id, callback);
    return id;
  }

  clearTimer(timer: unknown): void {
    this.timers.delete(timer as number);
  }

  expire(): void {
    this.nowMs += MAX_STABILIZATION_MS;
    const pending = [...this.timers.values()];
    this.timers.clear();
    for (const callback of pending) callback();
  }

  advanceAfterNextNowRead(nowMs: number): void {
    this.nowAfterNextRead = nowMs;
  }

  advanceCalls(): number {
    return this.scheduledAdvances;
  }
}

function controllerError(code: string) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof ApplicationFormInspectionControllerError);
    assert.equal(error.code, code);
    return true;
  };
}

function errorCode(code: string) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof Error);
    assert.equal("code" in error ? error.code : undefined, code);
    return true;
  };
}

function createController(
  fake: FakeProtectedTarget,
  runtime = new ManualRuntime(),
  onInvalidated?: (code: ApplicationFormInspectionInvalidationCode) => void
) {
  return createApplicationFormInspectionControllerWithRuntime({
    target: fake.target,
    authoritativeApplyHost: AUTHORITATIVE_APPLY_HOST,
    onInvalidated
  }, runtime);
}

test("stable protected inspection accepts only a fresh CURRENT candidate and exposes no opaque authority", async () => {
  const fake = new FakeProtectedTarget();
  const extraction = controlledExtraction();
  fake.enqueueExtraction(extraction.value);
  const controller = createController(fake);

  const generation = await controller.inspect();

  assert.equal(controller.current(), generation);
  assert.equal(Object.isFrozen(generation), true);
  assert.deepEqual(Object.keys(generation).sort(), ["dispose", "generationId", "inspectionReport"]);
  assert.equal(JSON.stringify(generation).includes("candidate"), false);
  assert.equal(JSON.stringify(generation).includes("reference"), false);
  assert.deepEqual(fake.calls, [
    "ready",
    "snapshot",
    `wait:${RELEVANT_MUTATION_QUIET_MS}`,
    "extract",
    `wait:${SEMANTIC_EXTRACTION_GAP_MS}`,
    "verify:1"
  ]);
  assert.equal(extraction.disposeCalls(), 0);

  generation.inspectionReport.forms[0].sections[0].fields[0].question = "caller mutation";
  assert.equal(generation.inspectionReport.forms[0].sections[0].fields[0].question, "Legal name");

  await Promise.all([generation.dispose(), generation.dispose(), generation.dispose()]);
  assert.equal(controller.current(), null);
  assert.equal(extraction.disposeCalls(), 1);
  await controller.close();
});

test("a known extraction-gap advisory change disposes and retries before verification", async () => {
  const fake = new FakeProtectedTarget();
  const first = controlledExtraction(report("First"));
  const second = controlledExtraction(report("Second"));
  fake.enqueueExtraction(first.value);
  fake.enqueueExtraction(second.value);
  fake.enqueueWait({ documentEpoch: 0, semanticRevision: 0, applicantStateEpoch: 0 });
  fake.enqueueWait({ documentEpoch: 0, semanticRevision: 1, applicantStateEpoch: 0 });
  fake.enqueueWait({ documentEpoch: 0, semanticRevision: 1, applicantStateEpoch: 0 });
  fake.enqueueWait({ documentEpoch: 0, semanticRevision: 1, applicantStateEpoch: 0 });
  const controller = createController(fake);

  const generation = await controller.inspect();

  assert.equal(first.disposeCalls(), 1);
  assert.equal(second.disposeCalls(), 0);
  assert.equal(generation.inspectionReport.forms[0].sections[0].fields[0].question, "Second");
  assert.equal(fake.calls.filter((call) => call === "extract").length, 2);
  assert.deepEqual(fake.calls.filter((call) => call.startsWith("verify:")), ["verify:2"]);
  await controller.close();
});

test("an unchanged advisory timeout never authorizes an INVALID candidate", async () => {
  const fake = new FakeProtectedTarget();
  const runtime = new ManualRuntime();
  const first = controlledExtraction();
  const late = controlledExtraction(report("Late"));
  const pendingExtraction = deferred<ProtectedApplicationFormExtraction>();
  fake.enqueueExtraction(first.value);
  fake.enqueueExtraction(pendingExtraction.promise);
  fake.enqueueVerification({ status: "INVALID" });
  const controller = createController(fake, runtime);

  const inspection = controller.inspect();
  await new Promise<void>((resolve) => setImmediate(resolve));
  runtime.expire();
  await assert.rejects(inspection, controllerError("FORM_STABILITY_TIMEOUT"));
  assert.equal(first.disposeCalls(), 1);
  await assert.rejects(controller.inspect(), controllerError("FORM_INSPECTION_IN_PROGRESS"));

  pendingExtraction.resolve(late.value);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(late.disposeCalls(), 1);
  await controller.close();
});

test("deadline settles inspection while retry disposal remains quarantined for close", async () => {
  const fake = new FakeProtectedTarget();
  const runtime = new ManualRuntime();
  const cleanup = deferred<void>();
  const invalid = controlledExtraction(report("Invalid retry"), () => cleanup.promise);
  fake.enqueueExtraction(invalid.value);
  fake.enqueueVerification({ status: "INVALID" });
  const controller = createController(fake, runtime);
  let publicCode: string | null = null;
  const inspection = controller.inspect().then(
    () => "FULFILLED",
    (error: unknown) => {
      publicCode = error instanceof ApplicationFormInspectionControllerError
        ? error.code
        : "UNEXPECTED";
      return publicCode;
    }
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(invalid.disposeCalls(), 1);

  runtime.expire();
  await new Promise<void>((resolve) => setImmediate(resolve));
  const codeBeforeCleanupRelease = publicCode;
  await assert.rejects(
    controller.inspect(),
    controllerError("FORM_INSPECTION_IN_PROGRESS")
  );
  let closeSettled = false;
  const closing = controller.close().then(() => {
    closeSettled = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const closeSettledBeforeCleanupRelease = closeSettled;

  cleanup.resolve();
  const finalCode = await inspection;
  await closing;

  assert.equal(codeBeforeCleanupRelease, "FORM_STABILITY_TIMEOUT");
  assert.equal(finalCode, "FORM_STABILITY_TIMEOUT");
  assert.equal(closeSettledBeforeCleanupRelease, false);
  assert.equal(invalid.disposeCalls(), 1);
  assert.equal(controller.current(), null);
});

test("initial acceptance cannot cross the logical deadline during its prospective build", async () => {
  const fake = new FakeProtectedTarget();
  const runtime = new ManualRuntime();
  const extraction = controlledExtraction(report("Initial deadline candidate"));
  const verification = deferred<ProtectedCandidateVerification>();
  fake.enqueueExtraction(extraction.value);
  fake.enqueueVerification(verification.promise);
  const controller = createController(fake, runtime);
  const inspection = controller.inspect();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(fake.calls.at(-1), "verify:1");

  runtime.nowMs = MAX_STABILIZATION_MS - 1;
  runtime.advanceAfterNextNowRead(MAX_STABILIZATION_MS + 1);
  verification.resolve({
    status: "CURRENT",
    report: report("Initial deadline candidate"),
    fence: fake.fence
  });
  const result = await inspection.then(
    () => "FULFILLED",
    (error: unknown) => error instanceof ApplicationFormInspectionControllerError
      ? error.code
      : "UNEXPECTED"
  );
  const currentBeforeClose = controller.current();
  await controller.close();

  assert.equal(runtime.advanceCalls(), 1);
  assert.equal(result, "FORM_STABILITY_TIMEOUT");
  assert.equal(currentBeforeClose, null);
  assert.equal(extraction.disposeCalls(), 1);
});

test("acceptance applies exact logical deadline boundary semantics", async (context) => {
  for (const scenario of [
    { name: "below deadline", finalNowMs: MAX_STABILIZATION_MS - 1, expected: "FULFILLED" },
    { name: "at deadline", finalNowMs: MAX_STABILIZATION_MS, expected: "FORM_STABILITY_TIMEOUT" }
  ] as const) {
    await context.test(scenario.name, async () => {
      const fake = new FakeProtectedTarget();
      const runtime = new ManualRuntime();
      const extraction = controlledExtraction(report(`Boundary ${scenario.name}`));
      const verification = deferred<ProtectedCandidateVerification>();
      fake.enqueueExtraction(extraction.value);
      fake.enqueueVerification(verification.promise);
      const controller = createController(fake, runtime);
      const inspection = controller.inspect();
      await new Promise<void>((resolve) => setImmediate(resolve));

      runtime.nowMs = MAX_STABILIZATION_MS - 2;
      runtime.advanceAfterNextNowRead(scenario.finalNowMs);
      verification.resolve({
        status: "CURRENT",
        report: report(`Boundary ${scenario.name}`),
        fence: fake.fence
      });
      const result = await inspection.then(
        () => "FULFILLED",
        (error: unknown) => error instanceof ApplicationFormInspectionControllerError
          ? error.code
          : "UNEXPECTED"
      );
      const currentBeforeClose = controller.current();
      await controller.close();

      assert.equal(runtime.advanceCalls(), 1);
      assert.equal(result, scenario.expected);
      assert.equal(currentBeforeClose !== null, scenario.expected === "FULFILLED");
      assert.equal(extraction.disposeCalls(), 1);
    });
  }
});

test("replacement keeps the old generation until commitment and re-verifies after old disposal", async () => {
  const fake = new FakeProtectedTarget();
  const oldDisposal = deferred<void>();
  const oldExtraction = controlledExtraction(report("Old"), () => oldDisposal.promise);
  const newExtraction = controlledExtraction(report("New"));
  fake.enqueueExtraction(oldExtraction.value);
  const controller = createController(fake);
  const oldGeneration = await controller.inspect();

  fake.enqueueExtraction(newExtraction.value);
  const replacement = controller.inspect();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(controller.current(), null, "replacement commitment must clear old authority synchronously");
  assert.equal(oldExtraction.disposeCalls(), 1);
  oldDisposal.resolve();
  const newGeneration = await replacement;

  assert.notEqual(newGeneration.generationId, oldGeneration.generationId);
  assert.equal(controller.current(), newGeneration);
  assert.equal(newGeneration.inspectionReport.forms[0].sections[0].fields[0].question, "New");
  assert.deepEqual(fake.calls.filter((call) => call === "verify:2"), ["verify:2", "verify:2"]);
  await controller.close();
});

test("replacement acceptance cannot cross the logical deadline during its prospective build", async () => {
  const fake = new FakeProtectedTarget();
  const runtime = new ManualRuntime();
  const oldExtraction = controlledExtraction(report("Old deadline generation"));
  const replacementExtraction = controlledExtraction(report("Replacement deadline generation"));
  const revalidation = deferred<ProtectedCandidateVerification>();
  fake.enqueueExtraction(oldExtraction.value);
  const controller = createController(fake, runtime);
  await controller.inspect();

  fake.enqueueExtraction(replacementExtraction.value);
  fake.enqueueVerification({
    status: "CURRENT",
    report: report("Replacement deadline generation"),
    fence: fake.fence
  });
  fake.enqueueVerification(revalidation.promise);
  const replacement = controller.inspect();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(fake.calls.filter((call) => call === "verify:2").length, 2);

  runtime.nowMs = MAX_STABILIZATION_MS - 1;
  runtime.advanceAfterNextNowRead(MAX_STABILIZATION_MS + 1);
  revalidation.resolve({
    status: "CURRENT",
    report: report("Replacement deadline generation"),
    fence: fake.fence
  });
  const result = await replacement.then(
    () => "FULFILLED",
    (error: unknown) => error instanceof ApplicationFormInspectionControllerError
      ? error.code
      : "UNEXPECTED"
  );
  const currentBeforeClose = controller.current();
  await controller.close();

  assert.equal(runtime.advanceCalls(), 1);
  assert.equal(result, "FORM_STABILITY_TIMEOUT");
  assert.equal(currentBeforeClose, null);
  assert.equal(oldExtraction.disposeCalls(), 1);
  assert.equal(replacementExtraction.disposeCalls(), 1);
});

test("replacement remembers and re-verifies after a predecessor disposed during first verification", async () => {
  const fake = new FakeProtectedTarget();
  const oldDisposal = deferred<void>();
  const firstNewVerification = deferred<ProtectedCandidateVerification>();
  const oldExtraction = controlledExtraction(report("Old"), () => oldDisposal.promise);
  const newExtraction = controlledExtraction(report("New"));
  fake.enqueueExtraction(oldExtraction.value);
  const controller = createController(fake);
  const oldGeneration = await controller.inspect();

  fake.enqueueExtraction(newExtraction.value);
  fake.enqueueVerification(firstNewVerification.promise);
  let replacementSettled = false;
  const replacement = controller.inspect().then((generation) => {
    replacementSettled = true;
    return generation;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(fake.calls.filter((call) => call === "verify:2"), ["verify:2"]);

  const disposingOld = oldGeneration.dispose();
  firstNewVerification.resolve({
    status: "CURRENT",
    report: report("New"),
    fence: fake.fence
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(replacementSettled, false);
  assert.deepEqual(fake.calls.filter((call) => call === "verify:2"), ["verify:2"]);

  oldDisposal.resolve();
  await disposingOld;
  const newGeneration = await replacement;
  assert.deepEqual(fake.calls.filter((call) => call === "verify:2"), ["verify:2", "verify:2"]);
  assert.equal(controller.current(), newGeneration);
  await controller.close();
});

test("inspection waits for a pre-existing candidate disposal before protected extraction", async () => {
  const fake = new FakeProtectedTarget();
  const oldDisposal = deferred<void>();
  const oldExtraction = controlledExtraction(report("Old"), () => oldDisposal.promise);
  const newExtraction = controlledExtraction(report("New"));
  fake.enqueueExtraction(oldExtraction.value);
  const controller = createController(fake);
  const oldGeneration = await controller.inspect();

  const disposingOld = oldGeneration.dispose();
  fake.enqueueExtraction(newExtraction.value);
  let replacementSettled = false;
  const replacement = controller.inspect().then((generation) => {
    replacementSettled = true;
    return generation;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(replacementSettled, false);
  assert.equal(fake.calls.filter((call) => call === "extract").length, 1);

  oldDisposal.resolve();
  await disposingOld;
  const newGeneration = await replacement;
  assert.equal(fake.calls.filter((call) => call === "extract").length, 2);
  assert.deepEqual(fake.calls.filter((call) => call === "verify:2"), ["verify:2"]);
  assert.equal(controller.current(), newGeneration);
  await controller.close();
});

test("replacement invalidation after old disposal leaves current null and never resurrects old authority", async () => {
  const fake = new FakeProtectedTarget();
  const oldExtraction = controlledExtraction(report("Old"));
  const newExtraction = controlledExtraction(report("New"));
  fake.enqueueExtraction(oldExtraction.value);
  const controller = createController(fake);
  const oldGeneration = await controller.inspect();

  fake.enqueueExtraction(newExtraction.value);
  fake.enqueueVerification({
    status: "CURRENT",
    report: report("New"),
    fence: fake.fence
  });
  fake.enqueueVerification({ status: "INVALID" });
  await assert.rejects(controller.inspect(), controllerError("FORM_GENERATION_INVALIDATED"));

  assert.equal(controller.current(), null);
  assert.notEqual(controller.current(), oldGeneration);
  assert.equal(oldExtraction.disposeCalls(), 1);
  assert.equal(newExtraction.disposeCalls(), 1);
  await controller.close();
});

test("a transient protected failure after replacement commitment leaves null authority but permits reinspection", async () => {
  const fake = new FakeProtectedTarget();
  const oldExtraction = controlledExtraction(report("Old"));
  const replacementExtraction = controlledExtraction(report("Replacement"));
  const recoveredExtraction = controlledExtraction(report("Recovered"));
  const invalidations: ApplicationFormInspectionInvalidationCode[] = [];
  fake.enqueueExtraction(oldExtraction.value);
  const controller = createController(
    fake,
    new ManualRuntime(),
    (code) => invalidations.push(code)
  );
  await controller.inspect();

  fake.enqueueExtraction(replacementExtraction.value);
  fake.enqueueVerification({
    status: "CURRENT",
    report: report("Replacement"),
    fence: fake.fence
  });
  fake.enqueueVerification(new ProtectedBrowserSessionError("PROTECTED_SESSION_STALE_RESPONSE"));
  await assert.rejects(
    controller.inspect(),
    controllerError("FORM_GENERATION_INVALIDATED")
  );
  assert.equal(controller.current(), null);
  assert.deepEqual(invalidations, []);
  assert.equal(oldExtraction.disposeCalls(), 1);
  assert.equal(replacementExtraction.disposeCalls(), 1);

  fake.enqueueExtraction(recoveredExtraction.value);
  const recovered = await controller.inspect();
  assert.equal(recovered.inspectionReport.forms[0].sections[0].fields[0].question, "Recovered");
  await controller.close();
});

test("assertCurrent always fresh-verifies and returns the same generation identity with a cloned fresh report", async () => {
  const fake = new FakeProtectedTarget();
  const extraction = controlledExtraction();
  fake.enqueueExtraction(extraction.value);
  const controller = createController(fake);
  const generation = await controller.inspect();
  const freshReport = report();
  fake.enqueueVerification({ status: "CURRENT", report: freshReport, fence: fake.fence });

  const current = await controller.assertCurrent(generation.generationId);

  assert.equal(current, generation);
  assert.equal(current.generationId, generation.generationId);
  assert.deepEqual(current.inspectionReport, freshReport);
  assert.notEqual(current.inspectionReport, freshReport);
  assert.equal(fake.calls.filter((call) => call.startsWith("verify:")).length, 2);
  assert.equal(fake.calls.filter((call) => call.startsWith("wait:")).length, 2);
  await controller.close();
});

test("assertCurrent cannot publish a refreshed report after synchronous work crosses the deadline", async () => {
  const fake = new FakeProtectedTarget();
  const runtime = new ManualRuntime();
  const extraction = controlledExtraction(report("Accepted deadline report"));
  fake.enqueueExtraction(extraction.value);
  const controller = createController(fake, runtime);
  const generation = await controller.inspect();
  const verification = deferred<ProtectedCandidateVerification>();
  fake.enqueueVerification(verification.promise);
  const assertion = controller.assertCurrent(generation.generationId);
  await new Promise<void>((resolve) => setImmediate(resolve));

  runtime.nowMs = MAX_STABILIZATION_MS - 1;
  runtime.advanceAfterNextNowRead(MAX_STABILIZATION_MS + 1);
  const matchingReport = report("Accepted deadline report");
  const insertionOrderWatermark = {
    forms: matchingReport.forms,
    schemaVersion: matchingReport.schemaVersion
  } as ApplicationFormInspectionReport;
  verification.resolve({
    status: "CURRENT",
    report: insertionOrderWatermark,
    fence: fake.fence
  });
  const result = await assertion.then(
    () => "FULFILLED",
    (error: unknown) => error instanceof ApplicationFormInspectionControllerError
      ? error.code
      : "UNEXPECTED"
  );
  const retainedRootKeyOrder = Object.keys(generation.inspectionReport);
  await controller.close();

  assert.equal(runtime.advanceCalls(), 1);
  assert.equal(result, "FORM_STABILITY_TIMEOUT");
  assert.deepEqual(retainedRootKeyOrder, ["schemaVersion", "forms"]);
  assert.equal(extraction.disposeCalls(), 1);
});

test("a stale generation ID does not invalidate another current protected generation", async () => {
  const fake = new FakeProtectedTarget();
  const extraction = controlledExtraction();
  fake.enqueueExtraction(extraction.value);
  const controller = createController(fake);
  const generation = await controller.inspect();

  await assert.rejects(controller.assertCurrent(Symbol("stale")), controllerError("FORM_GENERATION_INVALIDATED"));

  assert.equal(controller.current(), generation);
  assert.equal(extraction.disposeCalls(), 0);
  await controller.close();
});

test("assertCurrent invalidates once when protected verification returns INVALID", async () => {
  const fake = new FakeProtectedTarget();
  const extraction = controlledExtraction();
  fake.enqueueExtraction(extraction.value);
  const invalidations: ApplicationFormInspectionInvalidationCode[] = [];
  const controller = createController(fake, new ManualRuntime(), (code) => invalidations.push(code));
  const generation = await controller.inspect();
  fake.enqueueVerification({ status: "INVALID" });

  await assert.rejects(controller.assertCurrent(generation.generationId), controllerError("FORM_GENERATION_INVALIDATED"));

  assert.equal(controller.current(), null);
  assert.deepEqual(invalidations, ["REINSPECTION_REQUIRED"]);
  assert.equal(extraction.disposeCalls(), 1);
  await controller.close();
});

test("assertCurrent invalidates when a purported CURRENT report changes the private normalized contract", async () => {
  const fake = new FakeProtectedTarget();
  const extraction = controlledExtraction();
  fake.enqueueExtraction(extraction.value);
  const controller = createController(fake);
  const generation = await controller.inspect();
  fake.enqueueVerification({
    status: "CURRENT",
    report: report("Changed question"),
    fence: fake.fence
  });

  await assert.rejects(controller.assertCurrent(generation.generationId), controllerError("FORM_GENERATION_INVALIDATED"));
  assert.equal(controller.current(), null);
  assert.equal(extraction.disposeCalls(), 1);
  await controller.close();
});

test("abort settles assertCurrent while invalidation cleanup remains quarantined", async (context) => {
  for (const mode of ["INVALID", "PRIVATE_CONTRACT_MISMATCH"] as const) {
    await context.test(mode, async () => {
      const fake = new FakeProtectedTarget();
      const cleanup = deferred<void>();
      const extraction = controlledExtraction(report("Accepted"), () => cleanup.promise);
      fake.enqueueExtraction(extraction.value);
      const controller = createController(fake);
      const generation = await controller.inspect();
      fake.enqueueVerification(mode === "INVALID"
        ? { status: "INVALID" }
        : {
            status: "CURRENT",
            report: report("Changed private contract"),
            fence: fake.fence
          });
      const abort = new AbortController();
      let publicCode: string | null = null;
      const assertion = controller.assertCurrent(generation.generationId, {
        signal: abort.signal
      }).then(
        () => "FULFILLED",
        (error: unknown) => {
          publicCode = error instanceof ApplicationFormInspectionControllerError
            ? error.code
            : "UNEXPECTED";
          return publicCode;
        }
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(controller.current(), null);
      assert.equal(extraction.disposeCalls(), 1);

      abort.abort();
      await new Promise<void>((resolve) => setImmediate(resolve));
      const codeBeforeCleanupRelease = publicCode;
      let closeSettled = false;
      const closing = controller.close().then(() => {
        closeSettled = true;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      const closeSettledBeforeCleanupRelease = closeSettled;

      cleanup.resolve();
      const finalCode = await assertion;
      await closing;

      assert.equal(codeBeforeCleanupRelease, "FORM_INSPECTION_CANCELLED");
      assert.equal(finalCode, "FORM_INSPECTION_CANCELLED");
      assert.equal(closeSettledBeforeCleanupRelease, false);
      assert.equal(extraction.disposeCalls(), 1);
      assert.equal(controller.current(), null);
    });
  }
});

for (const [protectedCode, expectedCode] of [
  ["FORM_STRUCTURE_UNSUPPORTED", "FORM_CORRELATION_INVALID"],
  ["FORM_INSPECTION_OVERSIZE", "FORM_INSPECTION_REQUEST_TOO_LARGE"],
  ["FORM_INSPECTION_INVALID", "FORM_CORRELATION_INVALID"],
  ["EMPLOYER_AUTH_REQUIRED_UNSUPPORTED", "EMPLOYER_AUTH_REQUIRED_UNSUPPORTED"]
] as const) {
  test(`protected extraction ${protectedCode} maps to ${expectedCode}`, async () => {
    const fake = new FakeProtectedTarget();
    fake.enqueueExtraction(new ProtectedApplicationFormExtractionError(protectedCode));
    const controller = createController(fake);

    await assert.rejects(controller.inspect(), errorCode(expectedCode));
    assert.equal(controller.current(), null);
    await controller.close();
  });
}

for (const protectedCode of [
  "PROTECTED_SESSION_NOT_READY",
  "PROTECTED_SESSION_READINESS_TIMEOUT",
  "PROTECTED_SESSION_STALE_RESPONSE"
] as const) {
  test(`${protectedCode} retries only inside the original bounded deadline`, async () => {
    const fake = new FakeProtectedTarget();
    const runtime = new ManualRuntime();
    const pendingExtraction = deferred<ProtectedApplicationFormExtraction>();
    const late = controlledExtraction(report("Late transient result"));
    fake.enqueueReadiness(new ProtectedBrowserSessionError(protectedCode));
    fake.enqueueExtraction(pendingExtraction.promise);
    const controller = createController(fake, runtime);

    const inspection = controller.inspect();
    await new Promise<void>((resolve) => setImmediate(resolve));
    runtime.expire();
    await assert.rejects(inspection, controllerError("FORM_STABILITY_TIMEOUT"));
    assert.equal(fake.calls.filter((call) => call === "ready").length, 2);
    await assert.rejects(controller.inspect(), controllerError("FORM_INSPECTION_IN_PROGRESS"));

    pendingExtraction.resolve(late.value);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(late.disposeCalls(), 1);
    await controller.close();
  });
}

test("PROTECTED_SESSION_BUSY maps to bounded in-progress without leaking its message", async () => {
  const fake = new FakeProtectedTarget();
  fake.enqueueReadiness(new ProtectedBrowserSessionError("PROTECTED_SESSION_BUSY"));
  const controller = createController(fake);

  await assert.rejects(controller.inspect(), (error: unknown) => {
    assert.ok(error instanceof ApplicationFormInspectionControllerError);
    assert.equal(error.code, "FORM_INSPECTION_IN_PROGRESS");
    assert.equal(error.message.includes("PROTECTED_SESSION_BUSY"), false);
    return true;
  });
  await controller.close();
});

for (const protectedCode of [
  "PROTECTED_SESSION_SETUP_FAILED",
  "PROTECTED_SESSION_CLOSED",
  "PROTECTED_SESSION_INVALID_RESPONSE",
  "PROTECTED_CANDIDATE_INVALID"
] as const) {
  test(`${protectedCode} is a fixed terminal protected-authority failure`, async () => {
    const fake = new FakeProtectedTarget();
    const invalidations: ApplicationFormInspectionInvalidationCode[] = [];
    fake.enqueueReadiness(new ProtectedBrowserSessionError(protectedCode));
    const controller = createController(
      fake,
      new ManualRuntime(),
      (code) => invalidations.push(code)
    );

    await assert.rejects(controller.inspect(), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal("code" in error ? error.code : undefined, "BROWSER_WORKFLOW_FAILED");
      assert.equal(error.message.includes(protectedCode), false);
      return true;
    });
    assert.deepEqual(invalidations, ["PROTECTED_SESSION_LOST"]);
    await assert.rejects(controller.inspect(), controllerError("FORM_INSPECTION_CANCELLED"));
    await controller.close();
  });
}

test("an unknown protected-path failure is fixed, terminal, and content-free", async () => {
  const fake = new FakeProtectedTarget();
  const invalidations: ApplicationFormInspectionInvalidationCode[] = [];
  fake.enqueueReadiness(new Error("secret CDP payload from employer"));
  const controller = createController(
    fake,
    new ManualRuntime(),
    (code) => invalidations.push(code)
  );

  await assert.rejects(controller.inspect(), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal("code" in error ? error.code : undefined, "BROWSER_WORKFLOW_FAILED");
    assert.equal(error.message.includes("secret"), false);
    assert.equal(error.message.includes("employer"), false);
    return true;
  });
  assert.deepEqual(invalidations, ["PROTECTED_SESSION_LOST"]);
  await controller.close();
});

test("a thrown protected candidate identity failure terminally revokes an accepted generation", async () => {
  const fake = new FakeProtectedTarget();
  const extraction = controlledExtraction();
  const invalidations: ApplicationFormInspectionInvalidationCode[] = [];
  fake.enqueueExtraction(extraction.value);
  const controller = createController(
    fake,
    new ManualRuntime(),
    (code) => invalidations.push(code)
  );
  const generation = await controller.inspect();
  fake.enqueueVerification(new ProtectedBrowserSessionError("PROTECTED_CANDIDATE_INVALID"));

  await assert.rejects(
    controller.assertCurrent(generation.generationId),
    errorCode("BROWSER_WORKFLOW_FAILED")
  );
  assert.equal(controller.current(), null);
  assert.deepEqual(invalidations, ["PROTECTED_SESSION_LOST"]);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(extraction.disposeCalls(), 1);
  await controller.close();
});

test("generation cleanup is idempotent and contained when protected disposal rejects", async () => {
  const fake = new FakeProtectedTarget();
  const extraction = controlledExtraction(report(), () => Promise.reject(new Error("cleanup detail")));
  fake.enqueueExtraction(extraction.value);
  const controller = createController(fake);
  const generation = await controller.inspect();

  await Promise.all([generation.dispose(), generation.dispose(), controller.close()]);
  assert.equal(controller.current(), null);
  assert.equal(extraction.disposeCalls(), 1);
});

for (const [lifecycle, expected] of [
  ["DOCUMENT_CHANGED", "TARGET_NAVIGATED"],
  ["EXECUTION_CONTEXT_DESTROYED", "REINSPECTION_REQUIRED"],
  ["SESSION_DISCONNECTED", "PROTECTED_SESSION_LOST"],
  ["PAGE_CLOSED", "PAGE_CLOSED"],
  ["CLOSED", "PROTECTED_SESSION_LOST"]
] as const) {
  test(`${lifecycle} synchronously revokes and disposes the accepted generation as ${expected}`, async () => {
    const fake = new FakeProtectedTarget();
    const extraction = controlledExtraction();
    fake.enqueueExtraction(extraction.value);
    const invalidations: ApplicationFormInspectionInvalidationCode[] = [];
    const controller = createController(fake, new ManualRuntime(), (code) => invalidations.push(code));
    await controller.inspect();

    fake.emitLifecycle(lifecycle);

    assert.equal(controller.current(), null);
    assert.deepEqual(invalidations, [expected]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(extraction.disposeCalls(), 1);
    await controller.close();
  });
}

test("main-frame navigation revokes once while controller close removes every lifecycle subscriber", async () => {
  const fake = new FakeProtectedTarget();
  const extraction = controlledExtraction();
  fake.enqueueExtraction(extraction.value);
  const invalidations: ApplicationFormInspectionInvalidationCode[] = [];
  const controller = createController(fake, new ManualRuntime(), (code) => invalidations.push(code));
  await controller.inspect();

  fake.emitNavigation();
  fake.emitNavigation();
  assert.equal(controller.current(), null);
  assert.deepEqual(invalidations, ["TARGET_NAVIGATED"]);
  await controller.close();
  assert.equal(fake.lifecycleListeners.size, 0);
  assert.equal(fake.navigationListeners.size, 0);

  fake.emitLifecycle("CLOSED");
  fake.emitNavigation();
  assert.deepEqual(invalidations, ["TARGET_NAVIGATED"]);
  assert.equal(extraction.disposeCalls(), 1);
});

test("caller abort quarantines and disposes a late protected extraction before another inspection", async () => {
  const fake = new FakeProtectedTarget();
  const pendingExtraction = deferred<ProtectedApplicationFormExtraction>();
  const late = controlledExtraction();
  fake.enqueueExtraction(pendingExtraction.promise);
  const controller = createController(fake);
  const abort = new AbortController();

  const inspection = controller.inspect({ signal: abort.signal });
  await new Promise<void>((resolve) => setImmediate(resolve));
  abort.abort();
  await assert.rejects(inspection, controllerError("FORM_INSPECTION_CANCELLED"));
  await assert.rejects(controller.inspect(), controllerError("FORM_INSPECTION_IN_PROGRESS"));

  pendingExtraction.resolve(late.value);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(late.disposeCalls(), 1);
  await controller.close();
});

test("controller close waits for late extraction quarantine before releasing target ownership", async () => {
  const fake = new FakeProtectedTarget();
  const pendingExtraction = deferred<ProtectedApplicationFormExtraction>();
  const late = controlledExtraction(report("Late close result"));
  fake.enqueueExtraction(pendingExtraction.promise);
  const controller = createController(fake);

  const inspection = controller.inspect();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(fake.calls.includes("extract"), true);

  let closeSettled = false;
  const closing = controller.close().then(() => {
    closeSettled = true;
  });
  await assert.rejects(inspection, controllerError("FORM_INSPECTION_CANCELLED"));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(closeSettled, false);

  pendingExtraction.resolve(late.value);
  await closing;
  assert.equal(late.disposeCalls(), 1);
  assert.equal(closeSettled, true);
});

test("controller close is permanent, idempotent, non-emitting, and disposes its current candidate once", async () => {
  const fake = new FakeProtectedTarget();
  const extraction = controlledExtraction();
  fake.enqueueExtraction(extraction.value);
  const invalidations: ApplicationFormInspectionInvalidationCode[] = [];
  const controller = createController(fake, new ManualRuntime(), (code) => invalidations.push(code));
  await controller.inspect();

  await Promise.all([controller.close(), controller.close(), controller.close()]);

  assert.equal(controller.current(), null);
  assert.equal(extraction.disposeCalls(), 1);
  assert.deepEqual(invalidations, []);
  await assert.rejects(controller.inspect(), controllerError("FORM_INSPECTION_CANCELLED"));
});
