import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

import { ApplicationBrowserControl } from "@/components/application-browser-control";
import {
  applyAuthoritativeBrowserStatus,
  bindingRejectionPlan,
  browserCommandAvailability,
  derivePacketFreshness,
  dispositionMessage,
  inspectionPresentation,
  parseAnswerPacketResponse,
  presentProposal,
  readinessMessage,
  shouldOfferRetryConnection,
  type AnswerPacket,
  type PacketFreshness
} from "@/lib/application-browser/control-presentation";
import { APPLICATION_BROWSER_BINDING_NAME } from "@/lib/application-browser/types";
import type {
  B1Command,
  B1Status,
  B1WorkflowState,
  B2InspectionCommandStatus,
  BrowserInspectionRecoverableCode
} from "@/lib/application-browser/types";

const RUN_ID = "cm12345678901234567890123";
const OTHER_RUN_ID = "cm98765432109876543210987";
const SAFE_PROPOSAL_CONTEXT = {
  disposition: "PROPOSABLE" as const,
  sensitive: false,
  valueRedacted: false
};

type FetchHandler = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

type MountedControl = {
  container: HTMLElement;
  fetchCalls: Array<{ input: RequestInfo | URL; init?: RequestInit }>;
  setBinding: (binding: ((command: B1Command) => Promise<B1Status>) | undefined) => void;
  setFetchHandler: (handler: FetchHandler) => void;
  unmount: () => Promise<void>;
  cleanup: () => Promise<void>;
};

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function packetResponse(current: AnswerPacket | null, runId = RUN_ID): Response {
  return new Response(JSON.stringify({ runId, current }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

async function flushComponentWork(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function mountControl(
  initialFetchHandler: FetchHandler = async () => packetResponse(null)
): Promise<MountedControl> {
  const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", {
    url: "http://localhost/application-runs/test/browser"
  });
  const container = dom.window.document.getElementById("root");
  assert.ok(container);

  const installedGlobals = [
    ["window", dom.window],
    ["document", dom.window.document],
    ["navigator", dom.window.navigator],
    ["HTMLElement", dom.window.HTMLElement],
    ["Node", dom.window.Node],
    ["Event", dom.window.Event],
    ["MouseEvent", dom.window.MouseEvent],
    ["MutationObserver", dom.window.MutationObserver],
    ["IS_REACT_ACT_ENVIRONMENT", true]
  ] as const;
  const originalDescriptors = new Map<PropertyKey, PropertyDescriptor | undefined>();
  for (const [key, value] of installedGlobals) {
    originalDescriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }

  let fetchHandler = initialFetchHandler;
  const fetchCalls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  const originalFetchDescriptor = Object.getOwnPropertyDescriptor(globalThis, "fetch");
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    writable: true,
    value: async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls.push({ input, init });
      return fetchHandler(input, init);
    }
  });

  const root: Root = createRoot(container);
  let mounted = true;
  await act(async () => {
    root.render(createElement(ApplicationBrowserControl, { runId: RUN_ID }));
  });
  await flushComponentWork();

  const unmount = async () => {
    if (!mounted) return;
    mounted = false;
    await act(async () => {
      root.unmount();
    });
  };

  return {
    container,
    fetchCalls,
    setBinding(binding) {
      if (binding === undefined) {
        Reflect.deleteProperty(dom.window, APPLICATION_BROWSER_BINDING_NAME);
        return;
      }
      Object.defineProperty(dom.window, APPLICATION_BROWSER_BINDING_NAME, {
        configurable: true,
        writable: true,
        value: binding
      });
    },
    setFetchHandler(handler) {
      fetchHandler = handler;
    },
    unmount,
    async cleanup() {
      await unmount();
      Reflect.deleteProperty(dom.window, APPLICATION_BROWSER_BINDING_NAME);
      dom.window.close();
      if (originalFetchDescriptor === undefined) {
        Reflect.deleteProperty(globalThis, "fetch");
      } else {
        Object.defineProperty(globalThis, "fetch", originalFetchDescriptor);
      }
      for (const [key] of [...installedGlobals].reverse()) {
        const descriptor = originalDescriptors.get(key);
        if (descriptor === undefined) {
          Reflect.deleteProperty(globalThis, key);
        } else {
          Object.defineProperty(globalThis, key, descriptor);
        }
      }
    }
  };
}

function buttonNamed(container: HTMLElement, name: string): HTMLButtonElement {
  const button = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === name
  );
  assert.ok(button, `Expected button named ${name}.`);
  return button;
}

async function clickButton(control: MountedControl, name: string): Promise<void> {
  await act(async () => {
    buttonNamed(control.container, name).click();
  });
  await flushComponentWork();
}

const workflowStates: B1WorkflowState[] = [
  "STARTING",
  "APPLY_PILOT_AUTH_REQUIRED",
  "CONTROL_READY",
  "OPENING_TARGET",
  "TARGET_OPEN",
  "ERROR",
  "CLOSED"
];

const commands: B1Command["type"][] = [
  "GET_STATUS",
  "OPEN_TARGET",
  "INSPECT_FORM",
  "CLOSE_WORKFLOW"
];

const recoverableMessages: Record<BrowserInspectionRecoverableCode, string> = {
  FORM_INSPECTION_IN_PROGRESS:
    "An inspection is already running. Wait for it to finish, then refresh status.",
  FORM_STABILITY_TIMEOUT:
    "The form did not settle in time. Wait for the page to finish changing, then inspect again.",
  FORM_GENERATION_INVALIDATED: "The employer form changed during inspection. Inspect it again.",
  FORM_CORRELATION_INVALID:
    "The form could not be matched safely. Check that the intended form is visible, then inspect again.",
  AMBIGUOUS_DUPLICATE_FIELD:
    "Similar duplicate fields could not be distinguished safely. Review the employer form, then retry; handle those fields manually if it persists.",
  FORM_INSPECTION_CANCELLED:
    "Inspection stopped before publication. Check that the target is still open, then retry.",
  FORM_INSPECTION_REQUEST_TOO_LARGE:
    "The visible form is too large to inspect safely in one pass. Navigate to a smaller form step if available and retry; otherwise complete it manually.",
  RUN_LIFECYCLE_STALE: "The application run changed. Refresh browser status, then inspect again.",
  RUN_DOCUMENT_STALE: "The application documents changed. Refresh browser status, then inspect again.",
  SAME_ORIGIN_RATE_LIMITED: "Too many inspection requests were made. Wait a moment, then retry.",
  SAME_ORIGIN_REQUEST_FAILED:
    "Apply Pilot could not publish the inspection. Check the control workflow and connection, then retry."
};

function validPacket(): AnswerPacket {
  return {
    inspectionVersion: 2,
    answerPacketVersion: 3,
    packetHash: "a".repeat(64),
    reviewedAt: "2026-08-29T20:30:00.000Z",
    createdAt: "2026-08-29T20:00:00.000Z",
    summary: {
      fieldCount: 4,
      proposableCount: 3,
      pendingReviewCount: 1,
      approvedCount: 1,
      rejectedCount: 1,
      manualOnlyCount: 1,
      excludedCount: 0,
      unsupportedCount: 0,
      manualRequiredCount: 1,
      readyForRunResolution: false
    },
    answers: [
      {
        id: "answer-scalar",
        normalizedFieldKey: "b".repeat(64),
        question: "Portfolio URL",
        fieldType: "URL",
        classification: "PROFESSIONAL_LINK",
        disposition: "PROPOSABLE",
        dispositionReason: null,
        choices: [],
        proposal: { kind: "SCALAR", value: "https://example.com" },
        required: true,
        requiresReview: true,
        sensitive: false,
        valueRedacted: false,
        status: "PENDING",
        reviewedByUser: false,
        reviewedAt: null
      },
      {
        id: "answer-boolean",
        normalizedFieldKey: "c".repeat(64),
        question: "Available immediately?",
        fieldType: "CHECKBOX_BOOLEAN",
        classification: "AVAILABILITY",
        disposition: "PROPOSABLE",
        dispositionReason: null,
        choices: [],
        proposal: { kind: "BOOLEAN", value: true },
        required: false,
        requiresReview: true,
        sensitive: false,
        valueRedacted: false,
        status: "APPROVED",
        reviewedByUser: true,
        reviewedAt: "2026-08-29T20:30:00.000Z"
      },
      {
        id: "answer-options",
        normalizedFieldKey: "d".repeat(64),
        question: "Preferred office",
        fieldType: "SELECT_ONE",
        classification: "RELOCATION",
        disposition: "PROPOSABLE",
        dispositionReason: null,
        choices: [
          { key: "remote", label: "Remote", disabled: false },
          { key: "onsite", label: "On site", disabled: true }
        ],
        proposal: { kind: "OPTIONS", optionKeys: ["remote"] },
        required: true,
        requiresReview: true,
        sensitive: false,
        valueRedacted: false,
        status: "REJECTED",
        reviewedByUser: true,
        reviewedAt: "2026-08-29T20:30:00.000Z"
      },
      {
        id: "answer-document",
        normalizedFieldKey: "e".repeat(64),
        question: "Résumé",
        fieldType: "FILE_UPLOAD",
        classification: "DOCUMENT",
        disposition: "MANUAL_ONLY",
        dispositionReason: "V1_MANUAL_POLICY",
        choices: [],
        proposal: null,
        required: true,
        requiresReview: false,
        sensitive: false,
        valueRedacted: false,
        status: "PENDING",
        reviewedByUser: false,
        reviewedAt: null
      }
    ]
  };
}

function currentFreshnessInput(overrides: Record<string, unknown> = {}) {
  return {
    packet: validPacket(),
    latestPacketResponseWasNull: false,
    packetLoadUnverified: false,
    connection: "CONNECTED" as const,
    workflowState: "TARGET_OPEN" as const,
    lastAcceptedInspection: {
      outcome: "SUCCEEDED" as const,
      replayed: false,
      inspectionVersion: 2,
      answerPacketVersion: 3,
      reinspectionRequired: false
    },
    formInvalidatedSinceVerifiedSuccess: false,
    ...overrides
  };
}

test("command authorization covers every workflow state and uses the exact frozen command names", () => {
  for (const state of workflowStates) {
    const availability = browserCommandAvailability({
      status: { state, runId: RUN_ID },
      connection: "CONNECTED",
      pendingCommand: null
    });
    assert.deepEqual(Object.keys(availability), commands);
    assert.equal(availability.GET_STATUS, state !== "CLOSED", `${state} GET_STATUS`);
    assert.equal(availability.OPEN_TARGET, state === "CONTROL_READY", `${state} OPEN_TARGET`);
    assert.equal(availability.INSPECT_FORM, state === "TARGET_OPEN", `${state} INSPECT_FORM`);
    assert.equal(availability.CLOSE_WORKFLOW, state !== "CLOSED", `${state} CLOSE_WORKFLOW`);
    assert.equal("CLOSE" in availability, false);
  }
});

test("CLOSED, pending commands, unavailable connections, and in-progress inspection suppress commands", () => {
  assert.deepEqual(
    browserCommandAvailability({
      status: { state: "CLOSED", runId: RUN_ID },
      connection: "CONNECTED",
      pendingCommand: null
    }),
    { GET_STATUS: false, OPEN_TARGET: false, INSPECT_FORM: false, CLOSE_WORKFLOW: false }
  );

  for (const pendingCommand of commands) {
    assert.deepEqual(
      browserCommandAvailability({
        status: { state: "TARGET_OPEN", runId: RUN_ID },
        connection: "CONNECTED",
        pendingCommand
      }),
      { GET_STATUS: false, OPEN_TARGET: false, INSPECT_FORM: false, CLOSE_WORKFLOW: false }
    );
  }

  assert.deepEqual(
    browserCommandAvailability({
      status: { state: "TARGET_OPEN", runId: RUN_ID },
      connection: "UNKNOWN",
      pendingCommand: null
    }),
    { GET_STATUS: true, OPEN_TARGET: false, INSPECT_FORM: false, CLOSE_WORKFLOW: false }
  );
  assert.deepEqual(
    browserCommandAvailability({
      status: { state: "TARGET_OPEN", runId: RUN_ID },
      connection: "UNAVAILABLE",
      pendingCommand: null
    }),
    { GET_STATUS: false, OPEN_TARGET: false, INSPECT_FORM: false, CLOSE_WORKFLOW: false }
  );

  assert.equal(
    browserCommandAvailability({
      status: { state: "TARGET_OPEN", runId: RUN_ID, inspection: { outcome: "IN_PROGRESS" } },
      connection: "CONNECTED",
      pendingCommand: null
    }).INSPECT_FORM,
    false
  );
});

test("retry connection is offered only for an idle unavailable non-closed workflow", () => {
  assert.equal(shouldOfferRetryConnection("UNAVAILABLE", { state: "TARGET_OPEN", runId: RUN_ID }, null), true);
  assert.equal(shouldOfferRetryConnection("UNKNOWN", { state: "TARGET_OPEN", runId: RUN_ID }, null), false);
  assert.equal(shouldOfferRetryConnection("CONNECTED", { state: "TARGET_OPEN", runId: RUN_ID }, null), false);
  assert.equal(shouldOfferRetryConnection("UNAVAILABLE", { state: "CLOSED", runId: RUN_ID }, null), false);
  assert.equal(
    shouldOfferRetryConnection("UNAVAILABLE", { state: "TARGET_OPEN", runId: RUN_ID }, "GET_STATUS"),
    false
  );
});

test("binding rejection plans preserve authoritative status and permit at most one guarded recovery", () => {
  const status: B1Status = { state: "TARGET_OPEN", runId: RUN_ID, targetHost: "jobs.example.com" };
  const expected = {
    GET_STATUS: { recoverWithGetStatus: false, packetTrust: "UNCHANGED" },
    OPEN_TARGET: { recoverWithGetStatus: true, packetTrust: "UNCHANGED" },
    INSPECT_FORM: { recoverWithGetStatus: true, packetTrust: "UNVERIFIED" },
    CLOSE_WORKFLOW: { recoverWithGetStatus: true, packetTrust: "UNCHANGED" }
  } as const;

  for (const command of commands) {
    const plan = bindingRejectionPlan(command, status, "current");
    assert.equal(plan.connection, "UNAVAILABLE");
    assert.equal(plan.preservedStatus, status);
    assert.equal(plan.recoverWithGetStatus, expected[command].recoverWithGetStatus);
    assert.equal(plan.packetTrust, expected[command].packetTrust);
    assert.notEqual(plan.preservedStatus.state, "ERROR");
  }

  assert.equal(
    bindingRejectionPlan("CLOSE_WORKFLOW", { state: "CLOSED", runId: RUN_ID }, "current")
      .recoverWithGetStatus,
    false
  );
  assert.equal(
    bindingRejectionPlan("INSPECT_FORM", status, "stale").packetTrust,
    "STALE"
  );
});

test("inspection presentation covers progress, material success, replay, reinspection, and retryAllowed", () => {
  assert.deepEqual(inspectionPresentation({ outcome: "IN_PROGRESS" }), {
    tone: "INFO",
    text: "Inspection is in progress. No employer fields are being filled or submitted.",
    retryAllowed: false,
    invalidatesPacket: false,
    automaticPacketRefreshKey: null
  });

  assert.deepEqual(
    inspectionPresentation({
      outcome: "SUCCEEDED",
      replayed: false,
      inspectionVersion: 2,
      answerPacketVersion: 3,
      reinspectionRequired: false
    }),
    {
      tone: "SUCCESS",
      text: "Inspection was published and the current answer packet was updated. Review the proposed answers below. No employer fields were filled or submitted.",
      retryAllowed: false,
      invalidatesPacket: false,
      automaticPacketRefreshKey: "2:3"
    }
  );

  assert.deepEqual(
    inspectionPresentation({
      outcome: "SUCCEEDED",
      replayed: true,
      inspectionVersion: 2,
      answerPacketVersion: 3,
      reinspectionRequired: false
    }),
    {
      tone: "SUCCESS",
      text: "Existing current packet matched the verified inspection; no new packet version was created.",
      retryAllowed: false,
      invalidatesPacket: false,
      automaticPacketRefreshKey: "2:3"
    }
  );

  const succeededStale = inspectionPresentation({
    outcome: "SUCCEEDED",
    replayed: false,
    inspectionVersion: 2,
    answerPacketVersion: 3,
    reinspectionRequired: true
  });
  assert.equal(succeededStale.invalidatesPacket, true);
  assert.equal(succeededStale.automaticPacketRefreshKey, null);
  assert.match(succeededStale.text, /changed.*inspect/i);

  const reinspection = inspectionPresentation({
    outcome: "REINSPECTION_REQUIRED",
    errorCode: "FORM_GENERATION_INVALIDATED",
    retryAllowed: true
  });
  assert.equal(reinspection.retryAllowed, true);
  assert.equal(reinspection.invalidatesPacket, true);
  assert.equal("retry" in reinspection, false);
});

test("all eleven recoverable failures use closed safe messages and exact retryAllowed", () => {
  for (const [errorCode, text] of Object.entries(recoverableMessages) as Array<
    [BrowserInspectionRecoverableCode, string]
  >) {
    const input: B2InspectionCommandStatus = { outcome: "FAILED", errorCode, retryAllowed: true };
    const presentation = inspectionPresentation(input);
    assert.equal(presentation.text, text, errorCode);
    assert.equal(presentation.retryAllowed, true, errorCode);
    assert.equal(presentation.invalidatesPacket, errorCode === "FORM_GENERATION_INVALIDATED", errorCode);
    assert.equal(presentation.automaticPacketRefreshKey, null, errorCode);
    assert.equal("retry" in presentation, false, errorCode);
  }
});

test("authoritative status handling accepts matching statuses through one path and clears invalidation on clean success", () => {
  const status: B1Status = {
    state: "TARGET_OPEN",
    runId: RUN_ID,
    inspection: {
      outcome: "SUCCEEDED",
      replayed: true,
      inspectionVersion: 2,
      answerPacketVersion: 3,
      reinspectionRequired: false
    }
  };
  const result = applyAuthoritativeBrowserStatus({
    value: status,
    expectedRunId: RUN_ID,
    formInvalidatedSinceVerifiedSuccess: true
  });
  assert.equal(result.accepted, true);
  if (!result.accepted) return;
  assert.deepEqual(result.status, status);
  assert.equal(result.connection, "CONNECTED");
  assert.deepEqual(result.lastAcceptedInspection, status.inspection);
  assert.equal(result.formInvalidatedSinceVerifiedSuccess, false);
  assert.equal(result.automaticPacketRefreshKey, "2:3");
  assert.equal(
    result.notice?.text,
    "Existing current packet matched the verified inspection; no new packet version was created."
  );
});

test("authoritative status handling rejects wrong-run and malformed values without fabricating status", () => {
  for (const value of [
    { state: "TARGET_OPEN", runId: OTHER_RUN_ID },
    { state: "NOT_A_STATE", runId: RUN_ID },
    { state: "TARGET_OPEN", runId: RUN_ID, unexpected: true },
    null,
    []
  ]) {
    const result = applyAuthoritativeBrowserStatus({
      value,
      expectedRunId: RUN_ID,
      formInvalidatedSinceVerifiedSuccess: false
    });
    assert.deepEqual(result, { accepted: false, connection: "UNAVAILABLE" });
    assert.equal("status" in result, false);
  }
});

test("authoritative invalidation history survives failures and clears only after a clean success", () => {
  const invalidated = applyAuthoritativeBrowserStatus({
    value: {
      state: "TARGET_OPEN",
      runId: RUN_ID,
      inspection: {
        outcome: "REINSPECTION_REQUIRED",
        errorCode: "FORM_GENERATION_INVALIDATED",
        retryAllowed: true
      }
    },
    expectedRunId: RUN_ID,
    formInvalidatedSinceVerifiedSuccess: false
  });
  assert.equal(invalidated.accepted && invalidated.formInvalidatedSinceVerifiedSuccess, true);

  const failed = applyAuthoritativeBrowserStatus({
    value: {
      state: "TARGET_OPEN",
      runId: RUN_ID,
      inspection: { outcome: "FAILED", errorCode: "FORM_STABILITY_TIMEOUT", retryAllowed: true }
    },
    expectedRunId: RUN_ID,
    formInvalidatedSinceVerifiedSuccess: true
  });
  assert.equal(failed.accepted && failed.formInvalidatedSinceVerifiedSuccess, true);
});

test("packet parser accepts a valid null packet and a complete strict packet", () => {
  assert.deepEqual(parseAnswerPacketResponse({ runId: RUN_ID, current: null }, RUN_ID), {
    runId: RUN_ID,
    current: null
  });
  const packet = validPacket();
  assert.deepEqual(parseAnswerPacketResponse({ runId: RUN_ID, current: packet }, RUN_ID), {
    runId: RUN_ID,
    current: packet
  });
});

test("packet parser rejects invalid top-level boundaries, wrong run IDs, missing current, and extra keys", () => {
  for (const value of [
    null,
    [],
    "packet",
    1,
    { runId: RUN_ID },
    { runId: OTHER_RUN_ID, current: null },
    { runId: RUN_ID, current: null, extra: true }
  ]) {
    assert.throws(() => parseAnswerPacketResponse(value, RUN_ID));
  }
});

test("packet parser rejects bad versions, hashes, timestamps, summaries, and answer containers", () => {
  const mutations: Array<(packet: AnswerPacket) => unknown> = [
    (packet) => ({ ...packet, inspectionVersion: 0 }),
    (packet) => ({ ...packet, inspectionVersion: 1.5 }),
    (packet) => ({ ...packet, answerPacketVersion: Number.MAX_SAFE_INTEGER + 1 }),
    (packet) => ({ ...packet, packetHash: "" }),
    (packet) => ({ ...packet, packetHash: "x".repeat(513) }),
    (packet) => ({ ...packet, createdAt: "yesterday" }),
    (packet) => ({ ...packet, reviewedAt: "2026-13-90" }),
    (packet) => ({ ...packet, summary: { ...packet.summary, fieldCount: -1 } }),
    (packet) => ({ ...packet, summary: { ...packet.summary, readyForRunResolution: "yes" } }),
    (packet) => ({ ...packet, summary: { ...packet.summary, extra: 1 } }),
    (packet) => ({ ...packet, answers: "not-an-array" }),
    (packet) => ({ ...packet, extra: true })
  ];
  for (const mutate of mutations) {
    assert.throws(() => parseAnswerPacketResponse({ runId: RUN_ID, current: mutate(validPacket()) }, RUN_ID));
  }
});

test("packet parser accepts only exact lowercase SHA-256 packet hashes", () => {
  const accepted = validPacket();
  accepted.packetHash = "0123456789abcdef".repeat(4);
  assert.deepEqual(parseAnswerPacketResponse({ runId: RUN_ID, current: accepted }, RUN_ID).current, accepted);

  for (const packetHash of [
    "a".repeat(63),
    "a".repeat(65),
    "A".repeat(64),
    `${"a".repeat(63)}g`,
    "not-a-sha256",
    ""
  ]) {
    const packet = validPacket();
    packet.packetHash = packetHash;
    assert.throws(
      () => parseAnswerPacketResponse({ runId: RUN_ID, current: packet }, RUN_ID),
      `packetHash=${packetHash}`
    );
  }
});

test("packet parser rejects sensitive or redacted answers carrying every proposal variant", () => {
  const variants = [
    {
      proposal: { kind: "SCALAR" as const, value: "privacy-sentinel-scalar" },
      fieldType: "URL" as const,
      classification: "PROFESSIONAL_LINK" as const,
      choices: []
    },
    {
      proposal: { kind: "BOOLEAN" as const, value: true },
      fieldType: "CHECKBOX_BOOLEAN" as const,
      classification: "AVAILABILITY" as const,
      choices: []
    },
    {
      proposal: { kind: "OPTIONS" as const, optionKeys: ["privacy-sentinel-option-key"] },
      fieldType: "SELECT_ONE" as const,
      classification: "RELOCATION" as const,
      choices: [{ key: "privacy-sentinel-option-key", label: "privacy-sentinel-option-label", disabled: false }]
    },
    {
      proposal: {
        kind: "DOCUMENT_REFERENCE" as const,
        artifactType: "RESUME" as const,
        documentId: "privacy-sentinel-document"
      },
      fieldType: "FILE_UPLOAD" as const,
      classification: "DOCUMENT" as const,
      choices: []
    }
  ];

  for (const variant of variants) {
    for (const privacy of [
      { sensitive: true, valueRedacted: false },
      { sensitive: false, valueRedacted: true }
    ]) {
      const packet = validPacket();
      packet.answers[0] = {
        ...packet.answers[0],
        fieldType: variant.fieldType,
        classification: variant.classification,
        choices: variant.choices,
        proposal: variant.proposal,
        ...privacy
      };
      assert.throws(() => parseAnswerPacketResponse({ runId: RUN_ID, current: packet }, RUN_ID));
      assert.equal(
        presentProposal(variant.proposal, variant.choices, {
          disposition: "PROPOSABLE",
          ...privacy
        }),
        null
      );
    }
  }
});

test("packet parser rejects proposal authority on every non-proposable disposition", () => {
  const cases = [
    {
      disposition: "MANUAL_ONLY" as const,
      dispositionReason: "V1_MANUAL_POLICY" as const,
      sensitive: false,
      valueRedacted: false
    },
    {
      disposition: "EXCLUDED" as const,
      dispositionReason: "POLICY_EXCLUDED" as const,
      sensitive: true,
      valueRedacted: true
    },
    {
      disposition: "UNSUPPORTED" as const,
      dispositionReason: "UNSUPPORTED_CONTROL" as const,
      sensitive: false,
      valueRedacted: false
    }
  ];
  for (const invalid of cases) {
    const packet = validPacket();
    packet.answers[0] = {
      ...packet.answers[0],
      ...invalid,
      proposal: { kind: "SCALAR", value: "non-proposable-sentinel" },
      requiresReview: false
    };
    assert.throws(() => parseAnswerPacketResponse({ runId: RUN_ID, current: packet }, RUN_ID));
    assert.equal(
      presentProposal(packet.answers[0].proposal!, packet.answers[0].choices, packet.answers[0]),
      null
    );
  }
});

test("packet parser closes all answer enums and rejects unexpected answer keys", () => {
  const keys = ["fieldType", "classification", "disposition", "dispositionReason", "status"] as const;
  for (const key of keys) {
    const packet = validPacket();
    packet.answers[0] = { ...packet.answers[0], [key]: "UNKNOWN_ENUM" } as never;
    assert.throws(() => parseAnswerPacketResponse({ runId: RUN_ID, current: packet }, RUN_ID), key);
  }
  const packet = validPacket();
  packet.answers[0] = { ...packet.answers[0], extra: true } as never;
  assert.throws(() => parseAnswerPacketResponse({ runId: RUN_ID, current: packet }, RUN_ID));
});

test("packet parser rejects bad choices and malformed or unknown proposal variants", () => {
  const proposals: unknown[] = [
    { kind: "UNKNOWN", value: "x" },
    { kind: "SCALAR", value: true },
    { kind: "SCALAR", value: "x", extra: true },
    { kind: "BOOLEAN", value: "true" },
    { kind: "OPTIONS", optionKeys: "remote" },
    { kind: "OPTIONS", optionKeys: [1] },
    { kind: "DOCUMENT_REFERENCE", artifactType: "PORTFOLIO", documentId: "doc-1" },
    { kind: "DOCUMENT_REFERENCE", artifactType: "RESUME" }
  ];
  for (const proposal of proposals) {
    const packet = validPacket();
    packet.answers[0] = { ...packet.answers[0], proposal } as never;
    assert.throws(() => parseAnswerPacketResponse({ runId: RUN_ID, current: packet }, RUN_ID));
  }

  for (const choices of [
    "not-an-array",
    [{ key: "remote", label: "Remote" }],
    [{ key: "remote", label: "Remote", disabled: false, extra: true }]
  ]) {
    const packet = validPacket();
    packet.answers[0] = { ...packet.answers[0], choices } as never;
    assert.throws(() => parseAnswerPacketResponse({ runId: RUN_ID, current: packet }, RUN_ID));
  }
});

test("freshness derives absent, current, stale, and unverified without a mutable current flag", () => {
  const cases: Array<[string, Record<string, unknown>, PacketFreshness]> = [
    ["absent", { packet: null, latestPacketResponseWasNull: true }, "absent"],
    ["current", {}, "current"],
    [
      "reinspection required",
      {
        lastAcceptedInspection: {
          outcome: "REINSPECTION_REQUIRED",
          errorCode: "FORM_GENERATION_INVALIDATED",
          retryAllowed: true
        }
      },
      "stale"
    ],
    ["remembered invalidation", { formInvalidatedSinceVerifiedSuccess: true }, "stale"],
    ["packet load failure", { packetLoadUnverified: true }, "unverified"],
    ["connection loss", { connection: "UNAVAILABLE" }, "unverified"],
    ["unknown connection", { connection: "UNKNOWN" }, "unverified"],
    ["terminal workflow", { workflowState: "CLOSED" }, "unverified"],
    ["non-target workflow", { workflowState: "CONTROL_READY" }, "unverified"],
    ["inspection mismatch", { packet: { ...validPacket(), inspectionVersion: 9 } }, "unverified"],
    ["packet mismatch", { packet: { ...validPacket(), answerPacketVersion: 9 } }, "unverified"]
  ];
  for (const [name, overrides, expected] of cases) {
    assert.equal(derivePacketFreshness(currentFreshnessInput(overrides)), expected, name);
  }
});

test("recoverable failure makes a prior current packet unverified unless invalidation makes it stale", () => {
  const failure = {
    outcome: "FAILED" as const,
    errorCode: "FORM_STABILITY_TIMEOUT" as const,
    retryAllowed: true as const
  };
  assert.equal(derivePacketFreshness(currentFreshnessInput({ lastAcceptedInspection: failure })), "unverified");
  assert.equal(
    derivePacketFreshness(
      currentFreshnessInput({ lastAcceptedInspection: failure, formInvalidatedSinceVerifiedSuccess: true })
    ),
    "stale"
  );
});

test("a clean replay can restore matching stale packet while a manual packet refresh cannot", () => {
  const stale = currentFreshnessInput({ formInvalidatedSinceVerifiedSuccess: true });
  assert.equal(derivePacketFreshness(stale), "stale");
  assert.equal(
    derivePacketFreshness({ ...stale, packet: validPacket(), packetLoadUnverified: false }),
    "stale",
    "manual refresh alone"
  );
  assert.equal(
    derivePacketFreshness(
      currentFreshnessInput({
        lastAcceptedInspection: {
          outcome: "SUCCEEDED",
          replayed: true,
          inspectionVersion: 2,
          answerPacketVersion: 3,
          reinspectionRequired: false
        },
        formInvalidatedSinceVerifiedSuccess: false
      })
    ),
    "current"
  );
});

test("proposal presentation handles scalar, boolean, and document references without employer-action claims", () => {
  assert.deepEqual(presentProposal({ kind: "SCALAR", value: "Ada" }, [], SAFE_PROPOSAL_CONTEXT), {
    label: "Proposed answer — review before use",
    values: [{ text: "Ada", annotation: null }]
  });
  assert.deepEqual(presentProposal({ kind: "BOOLEAN", value: true }, [], SAFE_PROPOSAL_CONTEXT), {
    label: "Proposed answer — review before use",
    values: [{ text: "Yes", annotation: null }]
  });
  assert.deepEqual(presentProposal({ kind: "BOOLEAN", value: false }, [], SAFE_PROPOSAL_CONTEXT), {
    label: "Proposed answer — review before use",
    values: [{ text: "No", annotation: null }]
  });
  assert.deepEqual(
    presentProposal(
      { kind: "DOCUMENT_REFERENCE", artifactType: "RESUME", documentId: "resume-version-1" },
      [],
      SAFE_PROPOSAL_CONTEXT
    ),
    {
      label: "Proposed résumé document reference",
      values: [{ text: "resume-version-1", annotation: null }]
    }
  );
  assert.deepEqual(
    presentProposal(
      { kind: "DOCUMENT_REFERENCE", artifactType: "COVER_LETTER", documentId: "letter-version-1" },
      [],
      SAFE_PROPOSAL_CONTEXT
    ),
    {
      label: "Proposed cover-letter document reference",
      values: [{ text: "letter-version-1", annotation: null }]
    }
  );
});

test("option proposal resolution preserves order and refuses missing or duplicate keys", () => {
  const choices = [
    { key: "a", label: "Same label", disabled: false },
    { key: "b", label: "Same label", disabled: true },
    { key: "duplicate", label: "First duplicate", disabled: false },
    { key: "duplicate", label: "Second duplicate", disabled: false }
  ];
  assert.deepEqual(presentProposal({ kind: "OPTIONS", optionKeys: ["b", "a"] }, choices, SAFE_PROPOSAL_CONTEXT), {
    label: "Proposed answer — review before use",
    values: [
      { text: "Same label", annotation: "Disabled option" },
      { text: "Same label", annotation: null }
    ]
  });
  assert.deepEqual(presentProposal({ kind: "OPTIONS", optionKeys: ["missing", "duplicate"] }, choices, SAFE_PROPOSAL_CONTEXT), {
    label: "Proposed answer — review before use",
    values: [
      { text: "Option unavailable in packet choices", annotation: null },
      { text: "Option unavailable in packet choices", annotation: null }
    ]
  });
});

test("disposition and readiness copy remain read-only and avoid submission claims", () => {
  assert.equal(
    dispositionMessage("PROPOSABLE"),
    "Apply Pilot produced a proposed answer. Review it before using it."
  );
  assert.equal(dispositionMessage("MANUAL_ONLY"), "You must answer this field manually.");
  assert.equal(dispositionMessage("EXCLUDED"), "Apply Pilot intentionally did not propose an answer.");
  assert.equal(
    dispositionMessage("UNSUPPORTED"),
    "This field or control is unsupported and must be handled manually."
  );

  assert.equal(
    readinessMessage(true),
    "Packet review requirements are satisfied for Apply Pilot's internal run-review workflow."
  );
  assert.equal(
    readinessMessage(false),
    "Packet review requirements are not yet satisfied for Apply Pilot's internal run-review workflow."
  );
  for (const value of [readinessMessage(true), readinessMessage(false)]) {
    assert.doesNotMatch(value, /ready to submit|submission ready|application complete|employer form complete/i);
  }
});

test("mounted control harness renders the real component and completes its initial packet read", async (t) => {
  const control = await mountControl();
  t.after(() => control.cleanup());

  assert.match(control.container.textContent ?? "", /Current answer packet/);
  assert.match(control.container.textContent ?? "", /No current answer packet has been published yet/);
  assert.equal(control.fetchCalls.length, 1);
});

test("mounted control never presents local STARTING as accepted companion authority", async (t) => {
  const control = await mountControl();
  t.after(() => control.cleanup());

  const text = control.container.textContent ?? "";
  assert.doesNotMatch(text, /\bSTARTING\b/);
  assert.match(text, /Awaiting companion status/);
});

test("first missing binding reports that no companion status was received", async (t) => {
  const control = await mountControl();
  t.after(() => control.cleanup());

  await clickButton(control, "Refresh status");
  const text = control.container.textContent ?? "";
  assert.match(text, /No companion status received/);
  assert.doesNotMatch(text, /last accepted browser status is preserved/i);
  assert.doesNotMatch(text, /\bSTARTING\b/);
});

test("initial wrong-run and malformed statuses do not invent prior companion authority", async () => {
  for (const value of [
    { state: "TARGET_OPEN", runId: OTHER_RUN_ID },
    { state: "NOT_A_STATE", runId: RUN_ID }
  ]) {
    const control = await mountControl();
    try {
      control.setBinding(async () => value as B1Status);
      await clickButton(control, "Refresh status");
      const text = control.container.textContent ?? "";
      assert.match(text, /No companion status received/);
      assert.doesNotMatch(text, /last accepted browser status is preserved/i);
      assert.doesNotMatch(text, /\bSTARTING\b/);
    } finally {
      await control.cleanup();
    }
  }
});

test("a real accepted status is preserved accurately after later connection loss", async (t) => {
  const control = await mountControl();
  t.after(() => control.cleanup());
  let callCount = 0;
  control.setBinding(async () => {
    callCount += 1;
    if (callCount === 1) return { state: "TARGET_OPEN", runId: RUN_ID };
    throw new Error("private binding failure");
  });

  await clickButton(control, "Refresh status");
  assert.match(control.container.textContent ?? "", /TARGET_OPEN/);
  await clickButton(control, "Refresh status");

  const text = control.container.textContent ?? "";
  assert.match(text, /TARGET_OPEN/);
  assert.match(text, /last accepted browser status is preserved/i);
});

test("mounted packet boundary rejects a redacted proposal without rendering its sentinel", async (t) => {
  const packet = validPacket();
  packet.answers[0] = {
    ...packet.answers[0],
    proposal: { kind: "SCALAR", value: "render-privacy-sentinel" },
    sensitive: true,
    valueRedacted: true
  };
  const control = await mountControl(async () => packetResponse(packet));
  t.after(() => control.cleanup());

  const text = control.container.textContent ?? "";
  assert.match(text, /could not safely read the answer packet response/i);
  assert.doesNotMatch(text, /render-privacy-sentinel/);
});

test("matching browser status cannot make a retained packet-read error current", async (t) => {
  const packet = validPacket();
  const successfulStatus: B1Status = {
    state: "TARGET_OPEN",
    runId: RUN_ID,
    inspection: {
      outcome: "SUCCEEDED",
      replayed: false,
      inspectionVersion: packet.inspectionVersion,
      answerPacketVersion: packet.answerPacketVersion,
      reinspectionRequired: false
    }
  };
  const control = await mountControl(async () => packetResponse(packet));
  t.after(() => control.cleanup());
  control.setBinding(async () => successfulStatus);

  await clickButton(control, "Refresh status");
  assert.match(control.container.textContent ?? "", /Current packet —/);

  control.setFetchHandler(async () => new Response("{}", { status: 503 }));
  await clickButton(control, "Refresh packet");
  let text = control.container.textContent ?? "";
  assert.match(text, /temporarily unavailable/i);
  assert.match(text, /Unverified packet —/);
  assert.match(text, /Portfolio URL/);

  await clickButton(control, "Refresh status");
  text = control.container.textContent ?? "";
  assert.match(text, /temporarily unavailable/i);
  assert.match(text, /Unverified packet —/);
  assert.doesNotMatch(text, /Current packet —/);
});

test("successful INSPECT_FORM settlement after unmount is inert", async (t) => {
  const control = await mountControl();
  t.after(() => control.cleanup());
  const inspection = deferred<B1Status>();
  const calls: B1Command["type"][] = [];
  control.setBinding(async (command) => {
    calls.push(command.type);
    if (command.type === "GET_STATUS") return { state: "TARGET_OPEN", runId: RUN_ID };
    if (command.type === "INSPECT_FORM") return inspection.promise;
    throw new Error("unexpected command");
  });

  await clickButton(control, "Refresh status");
  await clickButton(control, "Inspect form");
  const fetchCountBeforeUnmount = control.fetchCalls.length;
  await control.unmount();

  inspection.resolve({
    state: "TARGET_OPEN",
    runId: RUN_ID,
    inspection: {
      outcome: "SUCCEEDED",
      replayed: false,
      inspectionVersion: 2,
      answerPacketVersion: 3,
      reinspectionRequired: false
    }
  });
  await flushComponentWork();

  assert.equal(control.fetchCalls.length, fetchCountBeforeUnmount);
  assert.deepEqual(calls, ["GET_STATUS", "INSPECT_FORM"]);
});

test("rejected INSPECT_FORM settlement after unmount starts no recovery", async (t) => {
  const control = await mountControl();
  t.after(() => control.cleanup());
  const inspection = deferred<B1Status>();
  const calls: B1Command["type"][] = [];
  control.setBinding(async (command) => {
    calls.push(command.type);
    if (command.type === "GET_STATUS") return { state: "TARGET_OPEN", runId: RUN_ID };
    if (command.type === "INSPECT_FORM") return inspection.promise;
    throw new Error("unexpected command");
  });

  await clickButton(control, "Refresh status");
  await clickButton(control, "Inspect form");
  const fetchCountBeforeUnmount = control.fetchCalls.length;
  await control.unmount();

  inspection.reject(new Error("private late rejection"));
  await flushComponentWork();

  assert.equal(control.fetchCalls.length, fetchCountBeforeUnmount);
  assert.deepEqual(calls, ["GET_STATUS", "INSPECT_FORM"]);
});

test("recovery status settlement after unmount is inert", async (t) => {
  const control = await mountControl();
  t.after(() => control.cleanup());
  const inspection = deferred<B1Status>();
  const recovery = deferred<B1Status>();
  const calls: B1Command["type"][] = [];
  let statusCalls = 0;
  control.setBinding(async (command) => {
    calls.push(command.type);
    if (command.type === "GET_STATUS") {
      statusCalls += 1;
      return statusCalls === 1 ? { state: "TARGET_OPEN", runId: RUN_ID } : recovery.promise;
    }
    if (command.type === "INSPECT_FORM") return inspection.promise;
    throw new Error("unexpected command");
  });

  await clickButton(control, "Refresh status");
  await clickButton(control, "Inspect form");
  inspection.reject(new Error("private command rejection"));
  await flushComponentWork();
  assert.deepEqual(calls, ["GET_STATUS", "INSPECT_FORM", "GET_STATUS"]);

  const fetchCountBeforeUnmount = control.fetchCalls.length;
  await control.unmount();
  recovery.resolve({
    state: "TARGET_OPEN",
    runId: RUN_ID,
    inspection: {
      outcome: "SUCCEEDED",
      replayed: false,
      inspectionVersion: 2,
      answerPacketVersion: 3,
      reinspectionRequired: false
    }
  });
  await flushComponentWork();

  assert.equal(control.fetchCalls.length, fetchCountBeforeUnmount);
  assert.deepEqual(calls, ["GET_STATUS", "INSPECT_FORM", "GET_STATUS"]);
});

test("control component consumes the canonical binding constant without a duplicate literal", () => {
  const source = readFileSync(
    `${process.cwd()}/components/application-browser-control.tsx`,
    "utf8"
  );
  assert.match(source, /APPLICATION_BROWSER_BINDING_NAME/);
  assert.doesNotMatch(source, /["']__applyPilotB1Command["']/);
});
