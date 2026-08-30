import assert from "node:assert/strict";
import test from "node:test";

import type { ElementHandle, Page } from "playwright";

import {
  ApplicationFormInspectionControllerError,
  createApplicationFormInspectionControllerWithRuntime,
  type ApplicationFormInspectionControllerRuntime,
  type OwnedFormSemanticObserver
} from "@/lib/application-browser/form-inspection-controller";
import type {
  CorrelatedSafeApplicationFormExtraction
} from "@/lib/application-browser/form-inspection-correlation";
import type {
  SafeApplicationFormExtraction
} from "@/lib/application-browser/form-inspection-dom";
import type {
  ApplicationFormInspectionReport,
  NormalizedApplicationFormSnapshot
} from "@/lib/application-runs/form-inspection";

const REPORT: ApplicationFormInspectionReport = {
  schemaVersion: 1,
  forms: [{
    title: null,
    sections: [{
      heading: null,
      fields: [{
        question: "Full name",
        helpText: null,
        fieldType: "TEXT",
        required: true,
        autocomplete: "name",
        constraints: {
          minLength: null,
          maxLength: null,
          min: null,
          max: null,
          step: null,
          acceptedFileTypes: [],
          multiple: false
        },
        choices: [],
        unsupportedReason: null
      }]
    }]
  }]
};

const SNAPSHOT = {
  schemaVersion: 1,
  normalizerVersion: 1,
  classifierVersion: 1,
  fingerprintVersion: 1,
  forms: []
} as unknown as NormalizedApplicationFormSnapshot;

const CHOICE_REPORT: ApplicationFormInspectionReport = {
  schemaVersion: 1,
  forms: [{
    title: null,
    sections: [{
      heading: null,
      fields: [{
        question: "Work authorization",
        helpText: null,
        fieldType: "RADIO_GROUP",
        required: true,
        autocomplete: null,
        constraints: {
          minLength: null,
          maxLength: null,
          min: null,
          max: null,
          step: null,
          acceptedFileTypes: [],
          multiple: false
        },
        choices: [{ label: "Yes", disabled: false }],
        unsupportedReason: null
      }]
    }]
  }]
};

class FakePage {
  private readonly listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  private readonly frame = {};
  private closed = false;

  on(event: string, listener: (...args: unknown[]) => void): this {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
    return this;
  }

  off(event: string, listener: (...args: unknown[]) => void): this {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  mainFrame(): object {
    return this.frame;
  }

  isClosed(): boolean {
    return this.closed;
  }

  listenerCount(event: string): number {
    return this.listeners.get(event)?.size ?? 0;
  }

  emit(event: string, ...args: unknown[]): void {
    if (event === "close") this.closed = true;
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
}

class FakeClock {
  nowMs = 0;
  private nextId = 1;
  private readonly timers = new Map<number, { at: number; callback: () => void }>();

  setTimer(callback: () => void, delayMs: number): number {
    const id = this.nextId;
    this.nextId += 1;
    this.timers.set(id, { at: this.nowMs + delayMs, callback });
    return id;
  }

  clearTimer(timer: unknown): void {
    if (typeof timer === "number") this.timers.delete(timer);
  }

  advance(delayMs: number): void {
    this.nowMs += delayMs;
    const due = [...this.timers.entries()]
      .filter(([, timer]) => timer.at <= this.nowMs)
      .sort((left, right) => left[1].at - right[1].at);
    for (const [id, timer] of due) {
      if (!this.timers.delete(id)) continue;
      timer.callback();
    }
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createHarness(input: Readonly<{ withChoice?: boolean }> = {}) {
  const page = new FakePage();
  const clock = new FakeClock();
  const handle = { attached: true, kind: "field" } as unknown as ElementHandle;
  const choiceHandle = { attached: true, kind: "choice" } as unknown as ElementHandle;
  const extractionDisposals: number[] = [];
  const correlatedRecords: Array<{
    disposals: number;
    barrier: ReturnType<typeof deferred<void>> | null;
  }> = [];
  const extractionQueue: Array<
    SafeApplicationFormExtraction |
    Promise<SafeApplicationFormExtraction> |
    Error
  > = [];
  const correlationQueue: Error[] = [];
  const correlationBarriers: Array<ReturnType<typeof deferred<void>>> = [];
  const attachmentBarriers: Array<ReturnType<typeof deferred<void>>> = [];
  const attachmentFailures: Error[] = [];
  const observerWaitBarriers = new Map<number, ReturnType<typeof deferred<void>>>();
  const observerSnapshotBarriers = new Map<number, ReturnType<typeof deferred<void>>>();
  const extractionDisposalBarriers = new Map<number, ReturnType<typeof deferred<void>>>();
  const waitChanges = new Map<number, "semantic" | "applicant">();
  const observerWaiters = new Set<ReturnType<typeof deferred<Readonly<{
    semanticRevision: number;
    applicantStateEpoch: number;
  }>>>>();
  let extractionIndex = 0;
  let observerWaitCount = 0;
  let observerSnapshotCount = 0;
  let observerDisposals = 0;
  let semanticRevision = 0;
  let applicantStateEpoch = 0;

  const currentReport = () => input.withChoice ? CHOICE_REPORT : REPORT;
  const makeExtraction = (
    report: ApplicationFormInspectionReport = currentReport()
  ): SafeApplicationFormExtraction => {
    const index = extractionIndex;
    extractionIndex += 1;
    let disposed = false;
    return {
      report: structuredClone(report),
      fields: [{
        sourceOrdinal: { form: 0, section: 0, field: 0 },
        handle,
        choices: input.withChoice ? [{
          sourceOrdinal: { form: 0, section: 0, field: 0, choice: 0 },
          handle: choiceHandle
        }] : []
      }],
      async dispose() {
        if (disposed) return;
        disposed = true;
        const barrier = extractionDisposalBarriers.get(index);
        if (barrier) await barrier.promise;
        extractionDisposals.push(index);
      }
    };
  };
  const observerSnapshot = () => ({ semanticRevision, applicantStateEpoch });
  const settleObserverWaiters = () => {
    const snapshot = observerSnapshot();
    for (const waiter of observerWaiters) waiter.resolve(snapshot);
    observerWaiters.clear();
  };

  const observer: OwnedFormSemanticObserver = {
    async snapshot() {
      observerSnapshotCount += 1;
      const barrier = observerSnapshotBarriers.get(observerSnapshotCount);
      if (barrier) await barrier.promise;
      return observerSnapshot();
    },
    async waitForChange(waitInput) {
      observerWaitCount += 1;
      const barrier = observerWaitBarriers.get(observerWaitCount);
      if (barrier) await barrier.promise;
      const change = waitChanges.get(observerWaitCount);
      if (change === "semantic") semanticRevision += 1;
      if (change === "applicant") applicantStateEpoch += 1;
      if (
        semanticRevision !== waitInput.semanticRevision ||
        applicantStateEpoch !== waitInput.applicantStateEpoch
      ) {
        return observerSnapshot();
      }
      if (waitInput.timeoutMs <= 500) {
        clock.advance(waitInput.timeoutMs);
        return observerSnapshot();
      }
      const waiter = deferred<Readonly<{
        semanticRevision: number;
        applicantStateEpoch: number;
      }>>();
      observerWaiters.add(waiter);
      return waiter.promise;
    },
    async refresh() {},
    async dispose() {
      observerDisposals += 1;
      settleObserverWaiters();
    }
  };

  const runtime: ApplicationFormInspectionControllerRuntime = {
    extract: async () => {
      const queued = extractionQueue.shift();
      if (queued instanceof Error) throw queued;
      return queued ? await queued : makeExtraction();
    },
    correlate: async ({ extraction }): Promise<CorrelatedSafeApplicationFormExtraction> => {
      const barrier = correlationBarriers.shift();
      if (barrier) await barrier.promise;
      const failure = correlationQueue.shift();
      if (failure) {
        await extraction.dispose();
        throw failure;
      }
      const record: (typeof correlatedRecords)[number] = {
        disposals: 0,
        barrier: null
      };
      correlatedRecords.push(record);
      const fieldKey = "field-key";
      return {
        formFingerprint: "f".repeat(64),
        fieldCount: 1,
        requiredFieldCount: 1,
        inspectionReport: extraction.report,
        normalizedSnapshot: structuredClone(SNAPSHOT),
        fields: new Map([[fieldKey, {
          fieldFingerprint: "a".repeat(64),
          sourceOrdinal: { form: 0, section: 0, field: 0 },
          handle: extraction.fields[0].handle
        }]]),
        choices: input.withChoice ? new Map([[fieldKey, new Map([["choice-key", {
          sourceOrdinal: { form: 0, section: 0, field: 0, choice: 0 },
          handle: extraction.fields[0].choices[0].handle
        }]])]]) : new Map(),
        async dispose() {
          if (record.disposals > 0) return;
          record.disposals += 1;
          if (record.barrier) await record.barrier.promise;
          await extraction.dispose();
        }
      };
    },
    now: () => clock.nowMs,
    setTimer: (callback, delayMs) => clock.setTimer(callback, delayMs),
    clearTimer: (timer) => clock.clearTimer(timer),
    createObserver: async () => observer,
    isHandleAttached: async (candidate) => {
      const barrier = attachmentBarriers.shift();
      if (barrier) await barrier.promise;
      const failure = attachmentFailures.shift();
      if (failure) throw failure;
      return Boolean((candidate as unknown as { attached: boolean }).attached);
    }
  };

  return {
    page,
    clock,
    handle: handle as unknown as { attached: boolean },
    choiceHandle: choiceHandle as unknown as { attached: boolean },
    runtime,
    extractionDisposals,
    correlatedRecords,
    get extractionCount() {
      return extractionIndex;
    },
    get observerDisposals() {
      return observerDisposals;
    },
    makeExtraction,
    queueExtraction(value: SafeApplicationFormExtraction | Promise<SafeApplicationFormExtraction> | Error) {
      extractionQueue.push(value);
    },
    queueCorrelationFailure(error: Error) {
      correlationQueue.push(error);
    },
    blockNextCorrelation() {
      const barrier = deferred<void>();
      correlationBarriers.push(barrier);
      return barrier;
    },
    blockNextAttachmentCheck() {
      const barrier = deferred<void>();
      attachmentBarriers.push(barrier);
      return barrier;
    },
    rejectNextAttachmentCheck(error: Error) {
      attachmentFailures.push(error);
    },
    blockObserverWait(call: number) {
      const barrier = deferred<void>();
      observerWaitBarriers.set(call, barrier);
      return barrier;
    },
    blockObserverSnapshot(call: number) {
      const barrier = deferred<void>();
      observerSnapshotBarriers.set(call, barrier);
      return barrier;
    },
    blockExtractionDisposal(index: number) {
      const barrier = deferred<void>();
      extractionDisposalBarriers.set(index, barrier);
      return barrier;
    },
    changeOnWait(call: number, change: "semantic" | "applicant") {
      waitChanges.set(call, change);
    },
    emitSemantic() {
      semanticRevision += 1;
      settleObserverWaiters();
    },
    emitApplicant() {
      applicantStateEpoch += 1;
      settleObserverWaiters();
    },
    blockCorrelatedDisposal(index: number) {
      const barrier = deferred<void>();
      correlatedRecords[index].barrier = barrier;
      return barrier;
    }
  };
}

function createController(
  harness: ReturnType<typeof createHarness>,
  onInvalidated?: (code: string) => void
) {
  return createApplicationFormInspectionControllerWithRuntime({
    page: harness.page as unknown as Page,
    authoritativeApplyHost: "employer.example.test",
    onInvalidated
  }, harness.runtime);
}

function rejectsWithCode(code: string) {
  return (error: unknown): boolean =>
    error instanceof ApplicationFormInspectionControllerError &&
    error.code === code;
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test("stable inspection accepts one transient generation", async () => {
  const harness = createHarness();
  const controller = createController(harness);

  const generation = await controller.inspect();

  assert.equal(typeof generation.generationId, "symbol");
  assert.equal(generation.formFingerprint, "f".repeat(64));
  assert.equal(controller.current(), generation);
  assert.equal(harness.extractionCount, 3);
  assert.deepEqual(harness.extractionDisposals, [0, 2]);

  await controller.close();
  assert.equal(harness.correlatedRecords[0].disposals, 1);
});

test("a second inspect rejects while extraction is active", async () => {
  const harness = createHarness();
  const pending = deferred<SafeApplicationFormExtraction>();
  harness.queueExtraction(pending.promise);
  const controller = createController(harness);
  const abort = new AbortController();
  const first = controller.inspect({ signal: abort.signal });
  await flush();

  await assert.rejects(controller.inspect(), rejectsWithCode("FORM_INSPECTION_IN_PROGRESS"));

  abort.abort();
  await assert.rejects(first, rejectsWithCode("FORM_INSPECTION_CANCELLED"));
  pending.resolve(harness.makeExtraction());
  await flush();
  await controller.close();
});

test("semantic revision between A and B retries within the original attempt", async () => {
  const harness = createHarness();
  harness.changeOnWait(2, "semantic");
  const controller = createController(harness);

  const generation = await controller.inspect();

  assert.equal(controller.current(), generation);
  assert.equal(harness.extractionCount, 4);
  assert.ok(harness.extractionDisposals.includes(0));
  await controller.close();
});

test("applicant epoch between A and B retries without becoming semantic state", async () => {
  const harness = createHarness();
  harness.changeOnWait(2, "applicant");
  const controller = createController(harness);

  const generation = await controller.inspect();

  assert.equal(controller.current(), generation);
  assert.equal(harness.extractionCount, 4);
  await controller.close();
});

test("caller abort during extraction cancels before acceptance", async () => {
  const harness = createHarness();
  const pending = deferred<SafeApplicationFormExtraction>();
  harness.queueExtraction(pending.promise);
  const controller = createController(harness);
  const abort = new AbortController();
  const inspecting = controller.inspect({ signal: abort.signal });
  await flush();

  abort.abort();

  await assert.rejects(inspecting, rejectsWithCode("FORM_INSPECTION_CANCELLED"));
  assert.equal(controller.current(), null);
  pending.resolve(harness.makeExtraction());
  await flush();
  await controller.close();
});

test("caller abort during the A/B gap disposes owned extraction A exactly once", async () => {
  const harness = createHarness();
  const gap = harness.blockObserverWait(2);
  const controller = createController(harness);
  const abort = new AbortController();
  const inspecting = controller.inspect({ signal: abort.signal });
  await flush();

  abort.abort();

  await assert.rejects(inspecting, rejectsWithCode("FORM_INSPECTION_CANCELLED"));
  assert.deepEqual(harness.extractionDisposals, [0]);
  gap.resolve();
  await controller.close();
});

test("main-frame navigation during the A/B gap disposes owned extraction A exactly once", async () => {
  const harness = createHarness();
  const gap = harness.blockObserverWait(2);
  const controller = createController(harness);
  const inspecting = controller.inspect();
  await flush();

  harness.page.emit("framenavigated", harness.page.mainFrame());

  await assert.rejects(inspecting, rejectsWithCode("FORM_INSPECTION_CANCELLED"));
  assert.deepEqual(harness.extractionDisposals, [0]);
  gap.resolve();
  await controller.close();
});

test("controller close during the A/B gap disposes owned extraction A exactly once", async () => {
  const harness = createHarness();
  const gap = harness.blockObserverWait(2);
  const controller = createController(harness);
  const inspecting = controller.inspect();
  await flush();

  const closing = controller.close();

  await assert.rejects(inspecting, rejectsWithCode("FORM_INSPECTION_CANCELLED"));
  assert.deepEqual(harness.extractionDisposals, [0]);
  gap.resolve();
  await closing;
});

test("caller abort after B resolves disposes A and pre-transfer B exactly once", async () => {
  const harness = createHarness();
  const afterB = harness.blockObserverSnapshot(3);
  const controller = createController(harness);
  const abort = new AbortController();
  const inspecting = controller.inspect({ signal: abort.signal });
  await flush();

  abort.abort();

  await assert.rejects(inspecting, rejectsWithCode("FORM_INSPECTION_CANCELLED"));
  assert.deepEqual(harness.extractionDisposals, [0, 1]);
  afterB.resolve();
  await controller.close();
});

test("top-frame navigation terminally cancels an active inspection", async () => {
  const harness = createHarness();
  const pending = deferred<SafeApplicationFormExtraction>();
  harness.queueExtraction(pending.promise);
  const controller = createController(harness);
  const inspecting = controller.inspect();
  await flush();

  harness.page.emit("framenavigated", harness.page.mainFrame());

  await assert.rejects(inspecting, rejectsWithCode("FORM_INSPECTION_CANCELLED"));
  pending.resolve(harness.makeExtraction());
  await flush();
  await controller.close();
});

test("page close cancels an active inspection and future inspections", async () => {
  const harness = createHarness();
  const pending = deferred<SafeApplicationFormExtraction>();
  harness.queueExtraction(pending.promise);
  const invalidations: string[] = [];
  const controller = createController(harness, (code) => invalidations.push(code));
  const inspecting = controller.inspect();
  await flush();

  harness.page.emit("close");

  await assert.rejects(inspecting, rejectsWithCode("FORM_INSPECTION_CANCELLED"));
  await assert.rejects(controller.inspect(), rejectsWithCode("FORM_INSPECTION_CANCELLED"));
  assert.deepEqual(invalidations, ["PAGE_CLOSED"]);
  pending.resolve(harness.makeExtraction());
  await flush();
  await controller.close();
});

test("timeout returns promptly while retaining the slot through late extraction cleanup", async () => {
  const harness = createHarness();
  const pending = deferred<SafeApplicationFormExtraction>();
  harness.queueExtraction(pending.promise);
  const controller = createController(harness);
  const inspecting = controller.inspect();
  await flush();

  harness.clock.advance(9_500);

  await assert.rejects(inspecting, rejectsWithCode("FORM_STABILITY_TIMEOUT"));
  await assert.rejects(controller.inspect(), rejectsWithCode("FORM_INSPECTION_IN_PROGRESS"));
  const late = harness.makeExtraction();
  pending.resolve(late);
  await flush();
  assert.ok(harness.extractionDisposals.includes(0));
  assert.equal(controller.current(), null);
  const next = await controller.inspect();
  assert.equal(controller.current(), next);
  await controller.close();
});

test("a never-settling extraction leaves the quarantined slot occupied", async () => {
  const harness = createHarness();
  harness.queueExtraction(new Promise<SafeApplicationFormExtraction>(() => undefined));
  const controller = createController(harness);
  const inspecting = controller.inspect();
  await flush();
  harness.clock.advance(9_500);

  await assert.rejects(inspecting, rejectsWithCode("FORM_STABILITY_TIMEOUT"));
  await assert.rejects(controller.inspect(), rejectsWithCode("FORM_INSPECTION_IN_PROGRESS"));
  await controller.close();
});

test("an old generation remains current while a replacement is private", async () => {
  const harness = createHarness();
  const controller = createController(harness);
  const oldGeneration = await controller.inspect();
  const pending = deferred<SafeApplicationFormExtraction>();
  harness.queueExtraction(pending.promise);
  const abort = new AbortController();
  const replacement = controller.inspect({ signal: abort.signal });
  await flush();

  assert.equal(controller.current(), oldGeneration);
  abort.abort();
  await assert.rejects(replacement, rejectsWithCode("FORM_INSPECTION_CANCELLED"));
  assert.equal(controller.current(), oldGeneration);
  pending.resolve(harness.makeExtraction());
  await flush();
  await controller.close();
});

test("replacement failure before commit preserves the old generation", async () => {
  const harness = createHarness();
  const controller = createController(harness);
  const oldGeneration = await controller.inspect();
  harness.queueCorrelationFailure(new Error("private employer data"));

  await assert.rejects(controller.inspect(), rejectsWithCode("FORM_CORRELATION_INVALID"));

  assert.equal(controller.current(), oldGeneration);
  await controller.close();
});

test("replacement clears old synchronously before disposal and verifies again afterward", async () => {
  const harness = createHarness();
  const controller = createController(harness);
  await controller.inspect();
  const disposal = harness.blockCorrelatedDisposal(0);
  const replacement = controller.inspect();
  await flush();

  assert.equal(controller.current(), null);
  assert.equal(harness.extractionCount, 6);
  disposal.resolve();
  const next = await replacement;

  assert.equal(controller.current(), next);
  assert.equal(harness.extractionCount, 7);
  await controller.close();
});

test("candidate semantic invalidation during old disposal leaves current null", async () => {
  const harness = createHarness();
  const controller = createController(harness);
  await controller.inspect();
  const disposal = harness.blockCorrelatedDisposal(0);
  const replacement = controller.inspect();
  await flush();
  harness.emitSemantic();
  disposal.resolve();

  await assert.rejects(replacement, rejectsWithCode("FORM_GENERATION_INVALIDATED"));
  assert.equal(controller.current(), null);
  await controller.close();
});

test("generation dispose clears current synchronously and is idempotent", async () => {
  const harness = createHarness();
  const controller = createController(harness);
  const generation = await controller.inspect();
  const first = generation.dispose();

  assert.equal(controller.current(), null);
  await Promise.all([first, generation.dispose(), generation.dispose()]);
  assert.equal(harness.correlatedRecords[0].disposals, 1);
  await assert.rejects(
    controller.assertCurrent(generation.generationId),
    rejectsWithCode("FORM_GENERATION_INVALIDATED")
  );
  await controller.close();
});

test("controller close is permanent, idempotent, and disposes the accepted generation", async () => {
  const harness = createHarness();
  const controller = createController(harness);
  await controller.inspect();
  const first = controller.close();

  assert.equal(controller.current(), null);
  await Promise.all([first, controller.close(), controller.close()]);
  assert.equal(harness.correlatedRecords[0].disposals, 1);
  assert.equal(harness.observerDisposals, 1);
  await assert.rejects(controller.inspect(), rejectsWithCode("FORM_INSPECTION_CANCELLED"));
});

test("post-accept semantic mutation invalidates once without regeneration", async () => {
  const harness = createHarness();
  const invalidations: string[] = [];
  const controller = createController(harness, (code) => invalidations.push(code));
  await controller.inspect();

  harness.emitSemantic();
  await flush();
  harness.emitSemantic();
  await flush();

  assert.equal(controller.current(), null);
  assert.deepEqual(invalidations, ["REINSPECTION_REQUIRED"]);
  assert.equal(harness.extractionCount, 3);
  await controller.close();
});

test("throwing reinspection callback cannot replace bounded invalidation or prevent cleanup", async () => {
  const harness = createHarness();
  const controller = createController(harness, () => {
    throw new Error("advisory callback failure");
  });
  const generation = await controller.inspect();
  const changed = structuredClone(REPORT);
  changed.forms[0].sections[0].fields[0].required = false;
  harness.queueExtraction(harness.makeExtraction(changed));

  await assert.rejects(
    controller.assertCurrent(generation.generationId),
    rejectsWithCode("FORM_GENERATION_INVALIDATED")
  );

  assert.equal(controller.current(), null);
  assert.equal(harness.correlatedRecords[0].disposals, 1);
  await controller.close();
});

test("throwing navigation callback cannot escape or interrupt accepted cleanup", async () => {
  const harness = createHarness();
  const controller = createController(harness, () => {
    throw new Error("advisory callback failure");
  });
  await controller.inspect();

  assert.doesNotThrow(() => harness.page.emit("framenavigated", harness.page.mainFrame()));
  await flush();

  assert.equal(controller.current(), null);
  assert.equal(harness.correlatedRecords[0].disposals, 1);
  assert.equal(harness.observerDisposals, 1);
  await controller.close();
  assert.equal(harness.page.listenerCount("framenavigated"), 0);
  assert.equal(harness.page.listenerCount("close"), 0);
});

test("throwing page-close callback with an accepted generation cannot interrupt close cleanup", async () => {
  const harness = createHarness();
  const controller = createController(harness, () => {
    throw new Error("advisory callback failure");
  });
  await controller.inspect();

  assert.doesNotThrow(() => harness.page.emit("close"));
  await controller.close();

  assert.equal(controller.current(), null);
  assert.equal(harness.correlatedRecords[0].disposals, 1);
  assert.equal(harness.observerDisposals, 1);
  assert.equal(harness.page.listenerCount("framenavigated"), 0);
  assert.equal(harness.page.listenerCount("close"), 0);
  await assert.rejects(controller.inspect(), rejectsWithCode("FORM_INSPECTION_CANCELLED"));
});

test("throwing page-close callback without a generation cannot escape or interrupt close", async () => {
  const harness = createHarness();
  const controller = createController(harness, () => {
    throw new Error("advisory callback failure");
  });

  assert.doesNotThrow(() => harness.page.emit("close"));
  await controller.close();

  assert.equal(harness.page.listenerCount("framenavigated"), 0);
  assert.equal(harness.page.listenerCount("close"), 0);
  await assert.rejects(controller.inspect(), rejectsWithCode("FORM_INSPECTION_CANCELLED"));
  await assert.rejects(controller.assertCurrent(Symbol()), rejectsWithCode("FORM_INSPECTION_CANCELLED"));
});

test("applicant signal does not immediately invalidate the generation", async () => {
  const harness = createHarness();
  const invalidations: string[] = [];
  const controller = createController(harness, (code) => invalidations.push(code));
  const generation = await controller.inspect();

  harness.emitApplicant();
  await flush();

  assert.equal(controller.current(), generation);
  assert.deepEqual(invalidations, []);
  await controller.close();
});

test("assertCurrent rejects a stale generation ID", async () => {
  const harness = createHarness();
  const controller = createController(harness);
  await controller.inspect();

  await assert.rejects(
    controller.assertCurrent(Symbol()),
    rejectsWithCode("FORM_GENERATION_INVALIDATED")
  );
  await controller.close();
});

test("strong assertCurrent preserves the same generation for an equal report", async () => {
  const harness = createHarness();
  const controller = createController(harness);
  const generation = await controller.inspect();

  const verified = await controller.assertCurrent(generation.generationId);

  assert.equal(verified, generation);
  assert.equal(controller.current(), generation);
  assert.equal(harness.extractionCount, 4);
  assert.ok(harness.extractionDisposals.includes(3));
  await controller.close();
});

test("strong assertCurrent report mismatch invalidates and emits once", async () => {
  const harness = createHarness();
  const invalidations: string[] = [];
  const controller = createController(harness, (code) => invalidations.push(code));
  const generation = await controller.inspect();
  const changed = structuredClone(REPORT);
  changed.forms[0].sections[0].fields[0].required = false;
  harness.queueExtraction(harness.makeExtraction(changed));

  await assert.rejects(
    controller.assertCurrent(generation.generationId),
    rejectsWithCode("FORM_GENERATION_INVALIDATED")
  );

  assert.equal(controller.current(), null);
  assert.deepEqual(invalidations, ["REINSPECTION_REQUIRED"]);
  await controller.close();
});

test("detached private field invalidates the complete generation", async () => {
  const harness = createHarness();
  const controller = createController(harness);
  const generation = await controller.inspect();
  harness.handle.attached = false;

  await assert.rejects(
    controller.assertCurrent(generation.generationId),
    rejectsWithCode("FORM_GENERATION_INVALIDATED")
  );
  assert.equal(controller.current(), null);
  await controller.close();
});

test("detached private choice invalidates the complete generation", async () => {
  const harness = createHarness({ withChoice: true });
  const controller = createController(harness);
  const generation = await controller.inspect();
  harness.choiceHandle.attached = false;

  await assert.rejects(
    controller.assertCurrent(generation.generationId),
    rejectsWithCode("FORM_GENERATION_INVALIDATED")
  );
  assert.equal(controller.current(), null);
  await controller.close();
});

test("attachment runtime rejection is normalized to complete bounded invalidation", async () => {
  const harness = createHarness();
  const invalidations: string[] = [];
  const controller = createController(harness, (code) => invalidations.push(code));
  const generation = await controller.inspect();
  harness.rejectNextAttachmentCheck(new Error("raw Playwright handle failure"));

  await assert.rejects(
    controller.assertCurrent(generation.generationId),
    rejectsWithCode("FORM_GENERATION_INVALIDATED")
  );

  assert.equal(controller.current(), null);
  assert.deepEqual(invalidations, ["REINSPECTION_REQUIRED"]);
  assert.equal(harness.correlatedRecords[0].disposals, 1);
  await controller.close();
});

test("caller-visible report, snapshot, maps, and metadata cannot alter private integrity", async () => {
  const harness = createHarness({ withChoice: true });
  const controller = createController(harness);
  const generation = await controller.inspect();
  generation.inspectionReport.forms[0].sections[0].fields[0].required = false;
  (generation.normalizedSnapshot as unknown as { forms: unknown[] }).forms.length = 0;
  const publicField = generation.fields.get("field-key");
  assert.ok(publicField);
  (publicField.sourceOrdinal as { form: number }).form = 99;
  (generation.fields as Map<string, unknown>).clear();
  const publicChoices = generation.choices.get("field-key");
  assert.ok(publicChoices);
  const publicChoice = publicChoices.get("choice-key");
  assert.ok(publicChoice);
  (publicChoice.sourceOrdinal as { choice: number }).choice = 99;
  (generation.choices as Map<string, unknown>).clear();

  const verified = await controller.assertCurrent(generation.generationId);

  assert.equal(verified, generation);
  assert.equal(controller.current(), generation);
  await controller.close();
});

test("caller cancellation during strong verification cannot return a generation", async () => {
  const harness = createHarness();
  const controller = createController(harness);
  const generation = await controller.inspect();
  const pending = deferred<SafeApplicationFormExtraction>();
  harness.queueExtraction(pending.promise);
  const abort = new AbortController();
  const verifying = controller.assertCurrent(generation.generationId, { signal: abort.signal });
  await flush();

  abort.abort();

  await assert.rejects(verifying, rejectsWithCode("FORM_INSPECTION_CANCELLED"));
  assert.notEqual(await Promise.race([
    verifying.then(() => "returned", () => "rejected"),
    Promise.resolve("pending")
  ]), "returned");
  pending.resolve(harness.makeExtraction());
  await flush();
  await controller.close();
});

test("bounded controller errors never include underlying employer data", async () => {
  const harness = createHarness();
  harness.queueCorrelationFailure(new Error("Secret employer question https://example.test"));
  const controller = createController(harness);

  await assert.rejects(controller.inspect(), (error: unknown) => {
    assert.ok(error instanceof ApplicationFormInspectionControllerError);
    assert.equal(error.code, "FORM_CORRELATION_INVALID");
    assert.equal(error.message, "Application form inspection controller failed: FORM_CORRELATION_INVALID");
    assert.doesNotMatch(error.message, /Secret|https/u);
    return true;
  });
  await controller.close();
});

test("timeout during correlation quarantines the late candidate until disposal", async () => {
  const harness = createHarness();
  const correlation = harness.blockNextCorrelation();
  const controller = createController(harness);
  const inspecting = controller.inspect();
  await flush();

  harness.clock.advance(9_250);

  await assert.rejects(inspecting, rejectsWithCode("FORM_STABILITY_TIMEOUT"));
  await assert.rejects(controller.inspect(), rejectsWithCode("FORM_INSPECTION_IN_PROGRESS"));
  correlation.resolve();
  await flush();
  assert.equal(harness.correlatedRecords[0].disposals, 1);
  assert.equal(controller.current(), null);
  await controller.close();
});

test("applicant change during strong assertCurrent retries inside one verification budget", async () => {
  const harness = createHarness();
  const controller = createController(harness);
  const generation = await controller.inspect();
  const pending = deferred<SafeApplicationFormExtraction>();
  harness.queueExtraction(pending.promise);
  const verifying = controller.assertCurrent(generation.generationId);
  await flush();

  harness.emitApplicant();
  pending.resolve(harness.makeExtraction());
  const verified = await verifying;

  assert.equal(verified, generation);
  assert.equal(controller.current(), generation);
  assert.equal(harness.extractionCount, 5);
  await controller.close();
});

test("semantic change during pre-accept strong verification retries before exposure", async () => {
  const harness = createHarness();
  harness.queueExtraction(harness.makeExtraction());
  harness.queueExtraction(harness.makeExtraction());
  const pending = deferred<SafeApplicationFormExtraction>();
  harness.queueExtraction(pending.promise);
  const controller = createController(harness);
  const inspecting = controller.inspect();
  await flush();

  harness.emitSemantic();
  pending.resolve(harness.makeExtraction());
  const generation = await inspecting;

  assert.equal(controller.current(), generation);
  assert.equal(harness.extractionCount, 4);
  await controller.close();
});

test("semantic change during candidate attachment checking retries verification", async () => {
  const harness = createHarness();
  const attachment = harness.blockNextAttachmentCheck();
  const controller = createController(harness);
  const inspecting = controller.inspect();
  await flush();

  harness.emitSemantic();
  attachment.resolve();
  const generation = await inspecting;

  assert.equal(controller.current(), generation);
  assert.equal(harness.extractionCount, 4);
  await controller.close();
});

test("semantic change during verification disposal retries before acceptance", async () => {
  const harness = createHarness();
  const disposal = harness.blockExtractionDisposal(2);
  const controller = createController(harness);
  const inspecting = controller.inspect();
  await flush();

  harness.emitSemantic();
  disposal.resolve();
  const generation = await inspecting;

  assert.equal(controller.current(), generation);
  assert.equal(harness.extractionCount, 4);
  await controller.close();
});

test("navigation after acceptance invalidates and disposes exactly once", async () => {
  const harness = createHarness();
  const invalidations: string[] = [];
  const controller = createController(harness, (code) => invalidations.push(code));
  const generation = await controller.inspect();

  harness.page.emit("framenavigated", harness.page.mainFrame());
  await flush();
  harness.page.emit("framenavigated", harness.page.mainFrame());
  await flush();

  assert.equal(controller.current(), null);
  assert.deepEqual(invalidations, ["TARGET_NAVIGATED"]);
  assert.equal(harness.correlatedRecords[0].disposals, 1);
  await assert.rejects(
    controller.assertCurrent(generation.generationId),
    rejectsWithCode("FORM_GENERATION_INVALIDATED")
  );
  await controller.close();
});

test("page close after acceptance permanently cancels and disposes", async () => {
  const harness = createHarness();
  const invalidations: string[] = [];
  const controller = createController(harness, (code) => invalidations.push(code));
  await controller.inspect();

  harness.page.emit("close");
  await flush();

  assert.equal(controller.current(), null);
  assert.deepEqual(invalidations, ["PAGE_CLOSED"]);
  assert.equal(harness.correlatedRecords[0].disposals, 1);
  await assert.rejects(controller.inspect(), rejectsWithCode("FORM_INSPECTION_CANCELLED"));
  await controller.close();
});

test("controller close after page close awaits the same accepted-generation cleanup", async () => {
  const harness = createHarness();
  const controller = createController(harness);
  await controller.inspect();
  const disposal = harness.blockCorrelatedDisposal(0);
  harness.page.emit("close");
  let settled = false;
  const closing = controller.close().then(() => {
    settled = true;
  });
  await flush();

  assert.equal(settled, false);
  disposal.resolve();
  await closing;
  assert.equal(settled, true);
});

test("unsafe fresh extraction invalidates instead of exposing its raw failure", async () => {
  const harness = createHarness();
  const invalidations: string[] = [];
  const controller = createController(harness, (code) => invalidations.push(code));
  const generation = await controller.inspect();
  harness.queueExtraction(new Error("unsafe employer structure and private label"));

  await assert.rejects(
    controller.assertCurrent(generation.generationId),
    rejectsWithCode("FORM_GENERATION_INVALIDATED")
  );
  assert.equal(controller.current(), null);
  assert.deepEqual(invalidations, ["REINSPECTION_REQUIRED"]);
  await controller.close();
});

test("abort after replacement commit never resurrects the old generation", async () => {
  const harness = createHarness();
  const controller = createController(harness);
  const oldGeneration = await controller.inspect();
  const disposal = harness.blockCorrelatedDisposal(0);
  const abort = new AbortController();
  const replacement = controller.inspect({ signal: abort.signal });
  await flush();
  assert.equal(controller.current(), null);

  abort.abort();
  disposal.resolve();

  await assert.rejects(replacement, rejectsWithCode("FORM_INSPECTION_CANCELLED"));
  assert.equal(controller.current(), null);
  assert.notEqual(controller.current(), oldGeneration);
  assert.equal(harness.correlatedRecords[1].disposals, 1);
  await controller.close();
});
