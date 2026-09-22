import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test, type TestContext } from "node:test";
import type { BrowserContext, CDPSession, Page } from "playwright";

import {
  PROTECTED_BROWSER_CAPABILITY_METHODS,
  ProtectedBrowserSessionError,
  createProtectedApplicationBrowserSession,
  type ProtectedApplicationBrowserSession
} from "@/lib/application-browser/protected-browser-session";

type SentCommand = Readonly<{ method: string; params: Record<string, unknown> | undefined }>;

class FakeCdpSession extends EventEmitter {
  readonly commands: SentCommand[] = [];
  detached = false;
  detachResponder: () => Promise<void> = async () => undefined;
  responder: (method: string, params: Record<string, unknown> | undefined) => unknown = () => ({});

  async send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    this.commands.push({ method, params });
    return this.responder(method, params);
  }

  async detach(): Promise<void> {
    this.detached = true;
    await this.detachResponder();
  }
}

function fakePage(cdp: FakeCdpSession): Page {
  const events = new EventEmitter();
  const context = {
    newCDPSession: async (page: Page) => {
      assert.equal(page, result);
      return cdp as unknown as CDPSession;
    }
  } as BrowserContext;
  const result = Object.assign(events, {
    context: () => context,
    isClosed: () => false
  }) as unknown as Page;
  return result;
}

function strictHandshakeResponse() {
  return {
    result: {
      type: "object",
      value: {
        version: 2,
        state: "READY",
        methods: [...PROTECTED_BROWSER_CAPABILITY_METHODS]
      }
    }
  };
}

const MINIMAL_REPORT = {
  schemaVersion: 1,
  forms: [{
    title: "Application",
    sections: [{
      heading: null,
      fields: [{
        question: "Name",
        helpText: null,
        fieldType: "TEXT",
        unsupportedReason: null,
        required: false,
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
        choices: []
      }]
    }]
  }]
} as const;

function byValue(value: unknown, type = "object") {
  return { result: { type, value } };
}

function sessionCode(code: ProtectedBrowserSessionError["code"]): (error: unknown) => boolean {
  return (error) => {
    assert.ok(error instanceof ProtectedBrowserSessionError);
    assert.equal(error.code, code);
    assert.equal(error.message, `Protected browser session failed: ${code}`);
    return true;
  };
}

async function readyFakeSession(
  cdp: FakeCdpSession,
  protectedResponder?: (declaration: string, params: Record<string, unknown>) => unknown,
  page = fakePage(cdp)
): Promise<ProtectedApplicationBrowserSession> {
  cdp.responder = (method, params) => {
    if (method === "Page.addScriptToEvaluateOnNewDocument") return { identifier: "bootstrap-ready" };
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main-frame" } } };
    if (method === "Runtime.evaluate") return { result: { type: "object", objectId: "capability-main" } };
    if (method === "Runtime.callFunctionOn") {
      const declaration = String(params?.functionDeclaration);
      if (declaration.includes("handshake")) return strictHandshakeResponse();
      return protectedResponder?.(declaration, params ?? {}) ?? byValue("DISPOSED", "string");
    }
    return {};
  };
  const session = await createProtectedApplicationBrowserSession({ page });
  const worldName = String(
    cdp.commands.find((command) => command.method === "Page.addScriptToEvaluateOnNewDocument")?.params?.worldName
  );
  cdp.emit("Runtime.executionContextCreated", {
    context: {
      id: 41,
      name: worldName,
      auxData: { frameId: "main-frame", isDefault: false, type: "isolated" }
    }
  });
  await session.waitUntilReady();
  return session;
}

test("registers a fresh isolated bootstrap without experimental options before selecting the exact main-frame context", async () => {
  const cdp = new FakeCdpSession();
  cdp.responder = (method, params) => {
    if (method === "Page.addScriptToEvaluateOnNewDocument") return { identifier: "bootstrap-1" };
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main-frame" } } };
    if (method === "Runtime.evaluate") {
      assert.equal(params?.contextId, 23);
      return { result: { type: "object", objectId: "capability-23" } };
    }
    if (method === "Runtime.callFunctionOn") return strictHandshakeResponse();
    return {};
  };

  const session = await createProtectedApplicationBrowserSession({ page: fakePage(cdp) });
  const registration = cdp.commands.find((command) => command.method === "Page.addScriptToEvaluateOnNewDocument");
  assert.ok(registration);
  assert.deepEqual(Object.keys(registration.params ?? {}).sort(), ["source", "worldName"]);
  assert.equal(typeof registration.params?.source, "string");
  assert.match(String(registration.params?.worldName), /^apply-pilot-protected-[0-9a-f]{64}$/);
  assert.equal(cdp.commands.some((command) => command.method === "Runtime.evaluate"), false);

  const worldName = String(registration.params?.worldName);
  cdp.emit("Runtime.executionContextCreated", {
    context: {
      id: 17,
      name: worldName,
      auxData: { frameId: "child-frame", isDefault: false, type: "isolated" }
    }
  });
  cdp.emit("Runtime.executionContextCreated", {
    context: {
      id: 23,
      name: worldName,
      auxData: { frameId: "main-frame", isDefault: false, type: "isolated" }
    }
  });

  await session.waitUntilReady();

  const evaluate = cdp.commands.find((command) => command.method === "Runtime.evaluate");
  assert.ok(evaluate);
  assert.deepEqual(Object.keys(evaluate.params ?? {}).sort(), [
    "contextId",
    "expression",
    "objectGroup",
    "returnByValue",
    "silent"
  ]);
  assert.equal(evaluate.params?.contextId, 23);

  const call = cdp.commands.find((command) => command.method === "Runtime.callFunctionOn");
  assert.ok(call);
  assert.equal(call.params?.objectId, "capability-23");
  assert.deepEqual(Object.keys(call.params ?? {}).sort(), [
    "awaitPromise",
    "functionDeclaration",
    "objectGroup",
    "objectId",
    "returnByValue",
    "silent"
  ]);

  await session.close();
  assert.equal(cdp.detached, true);
});

test("one extraction seals plain semantic writer targets exactly once", async () => {
  const cdp = new FakeCdpSession();
  const session = await readyFakeSession(cdp, (declaration) => {
    if (declaration.includes("this.extract")) {
      return byValue({ kind: "OK", candidateId: 17, report: MINIMAL_REPORT });
    }
    if (declaration.includes("this.sealCandidateWriterTargets")) {
      return byValue("SEALED", "string");
    }
    return byValue("DISPOSED", "string");
  });
  const extraction = await session.extractApplicationForm();
  const binding = {
    normalizedFieldKey: "1".repeat(64),
    fieldFingerprint: "2".repeat(64),
    fieldType: "TEXT" as const,
    sourceOrdinal: { form: 0, section: 0, field: 0 },
    choices: []
  };

  await extraction.sealWriterTargets([binding]);

  const calls = cdp.commands.filter((command) =>
    String(command.params?.functionDeclaration).includes("this.sealCandidateWriterTargets")
  );
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]?.params?.arguments, [{
    value: { candidateId: 17, bindings: [binding] }
  }]);
  assert.deepEqual(Object.keys(extraction).sort(), [
    "candidate",
    "dispose",
    "fields",
    "report",
    "sealWriterTargets"
  ]);
  await assert.rejects(
    extraction.sealWriterTargets([binding]),
    sessionCode("PROTECTED_CANDIDATE_INVALID")
  );
  assert.equal(cdp.commands.filter((command) =>
    String(command.params?.functionDeclaration).includes("this.sealCandidateWriterTargets")
  ).length, 1, "a duplicate seal must not dispatch another browser operation");
  await session.close();
});

test("malformed writer target bindings fail before seal dispatch and revoke the candidate", async (context) => {
  const base = {
    normalizedFieldKey: "1".repeat(64),
    fieldFingerprint: "2".repeat(64),
    fieldType: "TEXT" as const,
    sourceOrdinal: { form: 0, section: 0, field: 0 },
    choices: []
  };
  const cases: ReadonlyArray<readonly [string, unknown]> = [
    ["extra key", [{ ...base, selector: "#private" }]],
    ["malformed fingerprint", [{ ...base, fieldFingerprint: "NOT-A-HASH" }]],
    ["wrong family", [{ ...base, fieldType: "NUMBER" }]],
    ["bad ordinal", [{ ...base, sourceOrdinal: { form: 0, section: 0, field: -1 } }]],
    ["duplicate semantic key", [base, { ...base, sourceOrdinal: { form: 0, section: 0, field: 1 } }]],
    ["select without exact choices", [{ ...base, fieldType: "SELECT_ONE", choices: [] }]]
  ];

  for (const [name, bindings] of cases) {
    await context.test(name, async () => {
      const cdp = new FakeCdpSession();
      const session = await readyFakeSession(cdp, (declaration) => {
        if (declaration.includes("this.extract")) {
          return byValue({ kind: "OK", candidateId: 23, report: MINIMAL_REPORT });
        }
        return byValue("DISPOSED", "string");
      });
      const extraction = await session.extractApplicationForm();
      await assert.rejects(
        extraction.sealWriterTargets(bindings as never),
        sessionCode("PROTECTED_SESSION_INVALID_RESPONSE")
      );
      assert.equal(cdp.commands.some((command) =>
        String(command.params?.functionDeclaration).includes("this.sealCandidateWriterTargets")
      ), false);
      assert.deepEqual(await session.verifyCandidate(extraction.candidate), { status: "INVALID" });
      await session.close();
    });
  }
});

test("a rejected browser seal revokes both candidate and one-use sealing authority", async () => {
  const cdp = new FakeCdpSession();
  const session = await readyFakeSession(cdp, (declaration) => {
    if (declaration.includes("this.extract")) {
      return byValue({ kind: "OK", candidateId: 29, report: MINIMAL_REPORT });
    }
    if (declaration.includes("this.sealCandidateWriterTargets")) return byValue("INVALID", "string");
    return byValue("DISPOSED", "string");
  });
  const extraction = await session.extractApplicationForm();
  const binding = {
    normalizedFieldKey: "1".repeat(64),
    fieldFingerprint: "2".repeat(64),
    fieldType: "TEXT" as const,
    sourceOrdinal: { form: 0, section: 0, field: 0 },
    choices: []
  };

  await assert.rejects(
    extraction.sealWriterTargets([binding]),
    sessionCode("PROTECTED_CANDIDATE_INVALID")
  );
  assert.deepEqual(await session.verifyCandidate(extraction.candidate), { status: "INVALID" });
  await assert.rejects(
    extraction.sealWriterTargets([binding]),
    sessionCode("PROTECTED_CANDIDATE_INVALID")
  );
  assert.equal(cdp.commands.filter((command) =>
    String(command.params?.functionDeclaration).includes("this.sealCandidateWriterTargets")
  ).length, 1);
  await session.close();
});

test("one candidate write dispatches only sealed semantic identity and one canonical proposal", async () => {
  const cdp = new FakeCdpSession();
  const session = await readyFakeSession(cdp, (declaration) => {
    if (declaration.includes("this.extract")) {
      return byValue({ kind: "OK", candidateId: 31, report: MINIMAL_REPORT });
    }
    if (declaration.includes("this.sealCandidateWriterTargets")) return byValue("SEALED", "string");
    if (declaration.includes("this.writeCandidateField")) return byValue({ status: "FILLED" });
    return byValue("DISPOSED", "string");
  });
  const extraction = await session.extractApplicationForm();
  const binding = {
    normalizedFieldKey: "1".repeat(64),
    fieldFingerprint: "2".repeat(64),
    fieldType: "TEXT" as const,
    sourceOrdinal: { form: 0, section: 0, field: 0 },
    choices: []
  };
  await extraction.sealWriterTargets([binding]);
  const request = {
    normalizedFieldKey: binding.normalizedFieldKey,
    fieldFingerprint: binding.fieldFingerprint,
    fieldType: binding.fieldType,
    proposal: { kind: "SCALAR" as const, value: "Exact proposal" }
  };

  assert.deepEqual(await session.writeCandidateField(extraction.candidate, request), { status: "FILLED" });
  const calls = cdp.commands.filter((command) =>
    String(command.params?.functionDeclaration).includes("this.writeCandidateField")
  );
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]?.params?.arguments, [{ value: { candidateId: 31, request } }]);
  const serialized = JSON.stringify(calls[0]?.params?.arguments);
  for (const prohibited of ["sourceOrdinal", "selector", "xpath", "elementId", "currentValue"]) {
    assert.equal(serialized.includes(prohibited), false);
  }
  await session.close();
});

test("malformed candidate write requests are rejected before browser dispatch with fixed errors", async (context) => {
  const baseRequest = {
    normalizedFieldKey: "1".repeat(64),
    fieldFingerprint: "2".repeat(64),
    fieldType: "TEXT",
    proposal: { kind: "SCALAR", value: "valid" }
  };
  const cases: ReadonlyArray<readonly [string, unknown]> = [
    ["extra request key", { ...baseRequest, selector: "#SECRET-SELECTOR" }],
    ["malformed field key", { ...baseRequest, normalizedFieldKey: "bad" }],
    ["malformed fingerprint", { ...baseRequest, fieldFingerprint: "bad" }],
    ["blank scalar", { ...baseRequest, proposal: { kind: "SCALAR", value: "   " } }],
    ["malformed Unicode", { ...baseRequest, proposal: { kind: "SCALAR", value: "\ud800" } }],
    ["oversized scalar", { ...baseRequest, proposal: { kind: "SCALAR", value: "x".repeat(2_049) } }],
    ["unsupported family", { ...baseRequest, fieldType: "NUMBER" }],
    ["wrong proposal kind", { ...baseRequest, proposal: { kind: "OPTIONS", optionKeys: ["3".repeat(64)] } }],
    ["zero select choices", { ...baseRequest, fieldType: "SELECT_ONE", proposal: { kind: "OPTIONS", optionKeys: [] } }],
    ["multiple select choices", {
      ...baseRequest,
      fieldType: "SELECT_ONE",
      proposal: { kind: "OPTIONS", optionKeys: ["3".repeat(64), "4".repeat(64)] }
    }]
  ];

  for (const [name, request] of cases) {
    await context.test(name, async () => {
      const cdp = new FakeCdpSession();
      const session = await readyFakeSession(cdp, (declaration) => {
        if (declaration.includes("this.extract")) {
          return byValue({ kind: "OK", candidateId: 37, report: MINIMAL_REPORT });
        }
        if (declaration.includes("this.sealCandidateWriterTargets")) return byValue("SEALED", "string");
        return byValue("DISPOSED", "string");
      });
      const extraction = await session.extractApplicationForm();
      await extraction.sealWriterTargets([{
        normalizedFieldKey: "1".repeat(64),
        fieldFingerprint: "2".repeat(64),
        fieldType: "TEXT",
        sourceOrdinal: { form: 0, section: 0, field: 0 },
        choices: []
      }]);
      await assert.rejects(
        session.writeCandidateField(extraction.candidate, request as never),
        (error: unknown) => {
          assert.equal(sessionCode("PROTECTED_SESSION_INVALID_RESPONSE")(error), true);
          assert.equal((error as Error).message.includes("SECRET-SELECTOR"), false);
          return true;
        }
      );
      assert.equal(cdp.commands.some((command) =>
        String(command.params?.functionDeclaration).includes("this.writeCandidateField")
      ), false);
      await session.close();
    });
  }
});

test("an uncertain candidate write transport is attempted once, revokes authority, and is never retried", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const cdp = new FakeCdpSession();
  const writeReply = deferred<unknown>();
  const session = await readyFakeSession(cdp, (declaration) => {
    if (declaration.includes("this.extract")) {
      return byValue({ kind: "OK", candidateId: 41, report: MINIMAL_REPORT });
    }
    if (declaration.includes("this.sealCandidateWriterTargets")) return byValue("SEALED", "string");
    if (declaration.includes("this.writeCandidateField")) return writeReply.promise;
    return byValue("DISPOSED", "string");
  });
  t.after(() => {
    writeReply.resolve(byValue({ status: "FILLED" }));
    return session.close();
  });
  const extraction = await session.extractApplicationForm();
  await extraction.sealWriterTargets([{
    normalizedFieldKey: "1".repeat(64),
    fieldFingerprint: "2".repeat(64),
    fieldType: "TEXT",
    sourceOrdinal: { form: 0, section: 0, field: 0 },
    choices: []
  }]);
  const pending = observed(session.writeCandidateField(extraction.candidate, {
    normalizedFieldKey: "1".repeat(64),
    fieldFingerprint: "2".repeat(64),
    fieldType: "TEXT",
    proposal: { kind: "SCALAR", value: "PRIVATE-PROPOSAL" }
  }));
  await flushHost();
  assert.equal(cdp.commands.filter((command) =>
    String(command.params?.functionDeclaration).includes("this.writeCandidateField")
  ).length, 1);

  await advanceHost(t, 5_000);

  assert.equal(pending.status, "rejected");
  assert.equal(sessionCode("PROTECTED_SESSION_STALE_RESPONSE")(pending.error), true);
  assert.equal((pending.error as Error).message.includes("PRIVATE-PROPOSAL"), false);
  assert.equal(cdp.commands.filter((command) =>
    String(command.params?.functionDeclaration).includes("this.writeCandidateField")
  ).length, 1);
  await assert.rejects(session.snapshot(), sessionCode("PROTECTED_SESSION_NOT_READY"));
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function observed(promise: Promise<unknown>) {
  const state: { status: "pending" | "fulfilled" | "rejected"; value?: unknown; error?: unknown } = {
    status: "pending"
  };
  void promise.then(
    (value) => { state.status = "fulfilled"; state.value = value; },
    (error: unknown) => { state.status = "rejected"; state.error = error; }
  );
  return state;
}

const flushHost = () => new Promise<void>((resolve) => setImmediate(resolve));

async function advanceHost(t: TestContext, ms: number) {
  t.mock.timers.tick(ms);
  await flushHost();
}

function replaceDocument(cdp: FakeCdpSession, id = 52) {
  const worldName = String(cdp.commands.find(
    (command) => command.method === "Page.addScriptToEvaluateOnNewDocument"
  )?.params?.worldName);
  cdp.emit("Page.frameNavigated", { frame: { id: "main-frame" } });
  cdp.emit("Runtime.executionContextCreated", {
    context: { id, name: worldName, auxData: { frameId: "main-frame", isDefault: false, type: "isolated" } }
  });
}

async function unreadyFakeSession(cdp: FakeCdpSession) {
  const session = await createProtectedApplicationBrowserSession({ page: fakePage(cdp) });
  const worldName = String(cdp.commands.find(
    (command) => command.method === "Page.addScriptToEvaluateOnNewDocument"
  )?.params?.worldName);
  const createContext = (frameId = "main-frame") => cdp.emit("Runtime.executionContextCreated", {
    context: { id: 41, name: worldName, auxData: { frameId, isDefault: false, type: "isolated" } }
  });
  createContext();
  return { session, createContext };
}

test("concurrent readiness callers share one frame-tree acquisition, evaluation, handshake, and authority", async (t) => {
  const cdp = new FakeCdpSession();
  const frameTree = deferred<unknown>();
  const evaluated = deferred<unknown>();
  const handshake = deferred<unknown>();
  cdp.responder = (method, params) => {
    if (method === "Page.addScriptToEvaluateOnNewDocument") return { identifier: "bootstrap-single-flight" };
    if (method === "Page.getFrameTree") return frameTree.promise;
    if (method === "Runtime.evaluate") return evaluated.promise;
    if (String(params?.functionDeclaration).includes("handshake")) return handshake.promise;
    if (String(params?.functionDeclaration).includes("snapshot")) return byValue({ semanticRevision: 0, applicantStateEpoch: 0 });
    return {};
  };
  const { session } = await unreadyFakeSession(cdp);
  t.after(() => {
    frameTree.resolve({ frameTree: { frame: { id: "main-frame" } } });
    evaluated.resolve({ result: { type: "object", objectId: "capability-shared" } });
    handshake.resolve(strictHandshakeResponse());
    return session.close();
  });
  const first = session.waitUntilReady();
  const second = session.waitUntilReady();
  observed(first);
  observed(second);
  await flushHost();
  assert.equal(cdp.commands.filter((command) => command.method === "Page.getFrameTree").length, 1);
  assert.equal(first, second, "callers must share the exact readiness operation");
  frameTree.resolve({ frameTree: { frame: { id: "main-frame" } } });
  await flushHost();
  assert.equal(cdp.commands.filter((command) => command.method === "Runtime.evaluate").length, 1);
  evaluated.resolve({ result: { type: "object", objectId: "capability-shared" } });
  await flushHost();
  assert.equal(cdp.commands.filter((command) => String(command.params?.functionDeclaration).includes("handshake")).length, 1);
  handshake.resolve(strictHandshakeResponse());
  await Promise.all([first, second]);
  assert.equal((await session.snapshot()).documentEpoch, 0);
  await session.waitUntilReady();
  assert.equal(cdp.commands.filter((command) => command.method === "Runtime.evaluate").length, 1);
});

for (const outcome of ["failure", "close"] as const) {
  test(`shared readiness ${outcome} settles all callers with one failure and no hidden retry`, async (t) => {
    const cdp = new FakeCdpSession();
    const handshake = deferred<unknown>();
    cdp.responder = (method, params) => {
      if (method === "Page.addScriptToEvaluateOnNewDocument") return { identifier: "bootstrap-shared-failure" };
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main-frame" } } };
      if (method === "Runtime.evaluate") return { result: { type: "object", objectId: "capability-shared" } };
      if (String(params?.functionDeclaration).includes("handshake")) return handshake.promise;
      return {};
    };
    const { session } = await unreadyFakeSession(cdp);
    t.after(() => { handshake.resolve(strictHandshakeResponse()); return session.close(); });
    const first = observed(session.waitUntilReady());
    const second = observed(session.waitUntilReady());
    await flushHost();
    if (outcome === "close") await session.close();
    if (outcome === "failure") handshake.reject(new Error("PRIVATE RENDERER FAILURE"));
    else handshake.resolve(strictHandshakeResponse());
    await flushHost();
    assert.equal(first.status, "rejected");
    assert.equal(second.status, "rejected");
    sessionCode(outcome === "close" ? "PROTECTED_SESSION_CLOSED" : "PROTECTED_SESSION_INVALID_RESPONSE")(first.error);
    assert.equal(first.error, second.error, "shared callers must receive the same sanitized failure");
    assert.equal(cdp.commands.filter((command) => command.method === "Page.getFrameTree").length, 1);
    assert.equal(cdp.commands.filter((command) => command.method === "Runtime.evaluate").length, 1);
    assert.equal(cdp.commands.filter((command) => String(command.params?.functionDeclaration).includes("handshake")).length, 1);
    await assert.rejects(session.snapshot(), sessionCode(outcome === "close" ? "PROTECTED_SESSION_CLOSED" : "PROTECTED_SESSION_NOT_READY"));
  });
}

for (const stage of ["frameTree", "evaluate", "handshake"] as const) {
  for (const replacement of ["navigation", "contextsCleared", "contextDestroyed", "reusedContextId"] as const) {
    for (const lateOrder of ["beforeB", "afterB"] as const) {
      test(`readiness A pending ${stage}: ${replacement} permits B and ignores A ${lateOrder}`, async (t) => {
        const cdp = new FakeCdpSession();
        const lateA = deferred<unknown>();
        const handshakeB = deferred<unknown>();
        let phase: "A" | "B" = "A";
        const newFrameId = replacement === "navigation" ? "new-main-frame" : "main-frame";
        cdp.responder = (method, params) => {
          if (method === "Page.addScriptToEvaluateOnNewDocument") return { identifier: "bootstrap-replacement" };
          if (method === "Page.getFrameTree") {
            if (phase === "A" && stage === "frameTree") return lateA.promise;
            return { frameTree: { frame: { id: phase === "A" ? "main-frame" : newFrameId } } };
          }
          if (method === "Runtime.evaluate") {
            if (phase === "A" && stage === "evaluate") return lateA.promise;
            return { result: { type: "object", objectId: `capability-${phase}` } };
          }
          if (String(params?.functionDeclaration).includes("handshake")) {
            return params?.objectId === "capability-A" ? lateA.promise : handshakeB.promise;
          }
          if (String(params?.functionDeclaration).includes("snapshot")) {
            assert.equal(params?.objectId, "capability-B", "only B may supply current authority");
            return byValue({ semanticRevision: 0, applicantStateEpoch: 0 });
          }
          return {};
        };
        const { session, createContext } = await unreadyFakeSession(cdp);
        const lateResponse = stage === "frameTree" ? { frameTree: { frame: { id: "main-frame" } } }
          : stage === "evaluate" ? { result: { type: "object", objectId: "capability-A" } }
          : strictHandshakeResponse();
        t.after(() => { lateA.resolve(lateResponse); handshakeB.resolve(strictHandshakeResponse()); return session.close(); });
        const first = observed(session.waitUntilReady());
        await flushHost();
        if (replacement === "navigation") cdp.emit("Page.frameNavigated", { frame: { id: newFrameId } });
        if (replacement === "contextsCleared") cdp.emit("Runtime.executionContextsCleared", {});
        if (replacement === "contextDestroyed") cdp.emit("Runtime.executionContextDestroyed", { executionContextId: 41 });
        // Deliberately reuse the numeric ID without uniqueId: object identity is authoritative.
        createContext(newFrameId);
        phase = "B";
        const secondPromise = session.waitUntilReady();
        const second = observed(secondPromise);
        await flushHost();
        assert.equal(first.status, "pending", "B must start without waiting for the old transport");
        assert.equal(second.status, "pending");
        assert.equal(cdp.commands.filter((command) => String(command.params?.functionDeclaration).includes("handshake") && command.params?.objectId === "capability-B").length, 1);
        if (lateOrder === "afterB") {
          handshakeB.resolve(strictHandshakeResponse());
          await secondPromise;
          await session.snapshot();
        }
        lateA.resolve(lateResponse);
        await flushHost();
        assert.equal(first.status, "rejected", "late A must fail before touching current main-frame or authority state");
        sessionCode("PROTECTED_SESSION_STALE_RESPONSE")(first.error);
        if (lateOrder === "beforeB") {
          const thirdPromise = session.waitUntilReady();
          observed(thirdPromise);
          assert.equal(thirdPromise, secondPromise, "A's finally must not clear B's in-flight record");
          handshakeB.resolve(strictHandshakeResponse());
          await secondPromise;
        }
        await session.snapshot();
        await session.waitUntilReady();
        assert.equal(cdp.commands.filter((command) => command.method === "Page.getFrameTree").length, 2);
        assert.equal(cdp.commands.filter((command) => command.method === "Runtime.evaluate").length, stage === "frameTree" ? 1 : 2);
        assert.equal(cdp.commands.filter((command) => String(command.params?.functionDeclaration).includes("handshake") && command.params?.objectId === "capability-A").length, stage === "handshake" ? 1 : 0);
      });
    }
  }
}

for (const replacement of ["default", "other-world"] as const) {
  for (const stage of ["frameTree", "evaluate", "handshake"] as const) {
    test(`${replacement} context reusing a protected ID invalidates readiness pending ${stage} before filtering`, async (t) => {
      const cdp = new FakeCdpSession();
      const lateA = deferred<unknown>();
      const handshakeB = deferred<unknown>();
      let phase: "A" | "B" = "A";
      cdp.responder = (method, params) => {
        if (method === "Page.addScriptToEvaluateOnNewDocument") return { identifier: "bootstrap-filtered-collision" };
        if (method === "Page.getFrameTree") {
          return phase === "A" && stage === "frameTree" ? lateA.promise
            : { frameTree: { frame: { id: "main-frame" } } };
        }
        if (method === "Runtime.evaluate") {
          assert.equal(params?.contextId, phase === "A" ? 41 : 52, "only the exact protected main-frame context may be evaluated");
          return phase === "A" && stage === "evaluate" ? lateA.promise
            : { result: { type: "object", objectId: `capability-${phase}` } };
        }
        if (String(params?.functionDeclaration).includes("handshake")) {
          return params?.objectId === "capability-A" ? lateA.promise : handshakeB.promise;
        }
        if (String(params?.functionDeclaration).includes("snapshot")) {
          assert.equal(params?.objectId, "capability-B");
          return byValue({ semanticRevision: 0, applicantStateEpoch: 0 });
        }
        return {};
      };
      const { session } = await unreadyFakeSession(cdp);
      const worldName = String(cdp.commands.find((command) => command.method === "Page.addScriptToEvaluateOnNewDocument")?.params?.worldName);
      const lateResponse = stage === "frameTree" ? { frameTree: { frame: { id: "main-frame" } } }
        : stage === "evaluate" ? { result: { type: "object", objectId: "capability-A" } }
        : strictHandshakeResponse();
      t.after(() => { lateA.resolve(lateResponse); handshakeB.resolve(strictHandshakeResponse()); return session.close(); });
      const firstPromise = session.waitUntilReady();
      const first = observed(firstPromise);
      await flushHost();
      const filteredContext = (id: number) => ({
        context: { id, name: replacement === "default" ? "" : "unrelated-world",
          auxData: { frameId: "main-frame", isDefault: replacement === "default", type: replacement === "default" ? "default" : "isolated" } }
      });
      cdp.emit("Runtime.executionContextCreated", filteredContext(73));
      cdp.emit("Runtime.executionContextCreated", {
        context: { id: 74, name: worldName, auxData: { frameId: "child-frame", isDefault: false, type: "isolated" } }
      });
      const unchangedPromise = session.waitUntilReady();
      observed(unchangedPromise);
      assert.equal(unchangedPromise, firstPromise, "unrelated new IDs and child-frame creation must not supersede A");
      cdp.emit("Runtime.executionContextCreated", filteredContext(41));
      phase = "B";
      const secondPromise = session.waitUntilReady();
      const second = observed(secondPromise);
      assert.notEqual(secondPromise, firstPromise, "filtered numeric-ID collision must supersede A before a new protected context arrives");
      await flushHost();
      assert.equal(cdp.commands.filter((command) => command.method === "Runtime.evaluate").length, stage === "frameTree" ? 0 : 1,
        "B must wait for an eligible main-frame context; the collided entry and child context cannot be selected");
      cdp.emit("Runtime.executionContextCreated", {
        context: { id: 52, name: worldName, auxData: { frameId: "main-frame", isDefault: false, type: "isolated" } }
      });
      await flushHost();
      assert.equal(first.status, "pending");
      assert.equal(second.status, "pending");
      assert.equal(cdp.commands.filter((command) => String(command.params?.functionDeclaration).includes("handshake") && command.params?.objectId === "capability-B").length, 1);
      lateA.resolve(lateResponse);
      await flushHost();
      assert.equal(first.status, "rejected");
      sessionCode("PROTECTED_SESSION_STALE_RESPONSE")(first.error);
      assert.equal(cdp.commands.filter((command) => String(command.params?.functionDeclaration).includes("handshake") && command.params?.objectId === "capability-A").length, stage === "handshake" ? 1 : 0);
      const thirdPromise = session.waitUntilReady();
      observed(thirdPromise);
      assert.equal(thirdPromise, secondPromise, "A's finally cannot clear B");
      handshakeB.resolve(strictHandshakeResponse());
      await secondPromise;
      await session.snapshot();
      assert.equal(cdp.commands.filter((command) => command.method === "Page.getFrameTree").length, 2);
    });
  }
}

test("candidate disposal settles at the host bound when renderer cleanup never replies", async (t) => {
  const cdp = new FakeCdpSession();
  const cleanup = deferred<unknown>();
  const session = await readyFakeSession(cdp, (declaration) => declaration.includes("this.extract")
    ? byValue({ kind: "OK", candidateId: 1, report: MINIMAL_REPORT })
    : cleanup.promise);
  t.after(() => { cleanup.resolve(byValue("DISPOSED", "string")); return session.close(); });
  const extraction = await session.extractApplicationForm();
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const disposalPromise = extraction.dispose();
  assert.equal(extraction.dispose(), disposalPromise);
  const disposal = observed(disposalPromise);
  assert.deepEqual(await session.verifyCandidate(extraction.candidate), { status: "INVALID" });
  await advanceHost(t, 5_000);
  assert.equal(disposal.status, "fulfilled", "candidate cleanup must settle without a renderer reply");
  assert.equal(cdp.commands.filter((command) => String(command.params?.functionDeclaration).includes("disposeCandidate")).length, 1);
});

test("candidate disposal has its own host bound while a ten-second change wait is active", async (t) => {
  const cdp = new FakeCdpSession();
  const stalled = deferred<unknown>();
  const session = await readyFakeSession(cdp, (declaration) => declaration.includes("this.extract")
    ? byValue({ kind: "OK", candidateId: 1, report: MINIMAL_REPORT })
    : stalled.promise);
  t.after(() => { stalled.resolve(byValue("DISPOSED", "string")); return session.close(); });
  const extraction = await session.extractApplicationForm();
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  observed(session.waitForChange({ documentEpoch: 0, semanticRevision: 0, applicantStateEpoch: 0 }, 10_000));
  const disposal = observed(extraction.dispose());
  await advanceHost(t, 5_000);
  assert.equal(disposal.status, "fulfilled", "active renderer work must not extend disposal's host budget");
  assert.ok(cdp.commands.some((command) => String(command.params?.functionDeclaration).includes("disposeCandidate")));
});

for (const operation of ["snapshot", "extract", "verifyCandidate", "waitForChange"] as const) {
  test(`${operation} transport settles at its host bound and invalidates captured authority`, async (t) => {
    const cdp = new FakeCdpSession();
    const stalled = deferred<unknown>();
    const session = await readyFakeSession(cdp, (declaration) => {
      if (declaration.includes(`this.${operation}`)) return stalled.promise;
      if (declaration.includes("this.extract")) return byValue({ kind: "OK", candidateId: 1, report: MINIMAL_REPORT });
      return byValue("DISPOSED", "string");
    });
    t.after(() => { stalled.resolve(byValue({ semanticRevision: 99, applicantStateEpoch: 99 })); return session.close(); });
    const extraction = operation === "verifyCandidate" ? await session.extractApplicationForm() : null;
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    const pending = observed(operation === "snapshot" ? session.snapshot()
      : operation === "extract" ? session.extractApplicationForm()
      : operation === "verifyCandidate" ? session.verifyCandidate(extraction!.candidate)
      : session.waitForChange({ documentEpoch: 0, semanticRevision: 0, applicantStateEpoch: 0 }, 2));
    await advanceHost(t, operation === "waitForChange" ? 5_002 : 5_000);
    assert.equal(pending.status, "rejected", "public operation must reject without a CDP reply");
    sessionCode("PROTECTED_SESSION_STALE_RESPONSE")(pending.error);
    await assert.rejects(session.snapshot(), sessionCode("PROTECTED_SESSION_NOT_READY"));
    if (extraction) assert.deepEqual(await session.verifyCandidate(extraction.candidate), { status: "INVALID" });
    assert.equal(cdp.commands.filter((command) => String(command.params?.functionDeclaration).includes(`this.${operation}`)).length, 1);
  });
}

test("ten-second waitForChange receives the requested wait plus transport budget", async (t) => {
  const cdp = new FakeCdpSession();
  const reply = deferred<unknown>();
  const session = await readyFakeSession(cdp, () => reply.promise);
  t.after(() => { reply.resolve(byValue("DISPOSED", "string")); return session.close(); });
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const pending = observed(session.waitForChange({ documentEpoch: 0, semanticRevision: 0, applicantStateEpoch: 0 }, 10_000));
  await advanceHost(t, 10_000);
  assert.equal(pending.status, "pending");
  reply.resolve(byValue({ semanticRevision: 0, applicantStateEpoch: 0 }));
  await flushHost();
  assert.equal(pending.status, "fulfilled");
});

for (const cleanupPath of ["malformed extraction", "verification mismatch"] as const) {
  test(`${cleanupPath} settles even when candidate cleanup never replies`, async (t) => {
    const cdp = new FakeCdpSession();
    const initial = deferred<unknown>();
    const cleanup = deferred<unknown>();
    const session = await readyFakeSession(cdp, (declaration) => {
      if (declaration.includes("this.extract")) return cleanupPath === "malformed extraction" ? initial.promise
        : byValue({ kind: "OK", candidateId: 1, report: MINIMAL_REPORT });
      if (declaration.includes("this.verifyCandidate")) return initial.promise;
      return cleanup.promise;
    });
    t.after(() => { initial.resolve({}); cleanup.resolve(byValue("DISPOSED", "string")); return session.close(); });
    const extraction = cleanupPath === "verification mismatch" ? await session.extractApplicationForm() : null;
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    const pending = observed(extraction ? session.verifyCandidate(extraction.candidate) : session.extractApplicationForm());
    await advanceHost(t, 4_000);
    initial.resolve(extraction ? byValue({ status: "CURRENT", report: {},
      fence: { semanticRevision: 0, applicantStateEpoch: 0 } })
      : byValue({ kind: "OK", candidateId: 1, report: {} }));
    await flushHost();
    assert.ok(cdp.commands.some((command) => String(command.params?.functionDeclaration).includes("disposeCandidate")));
    await advanceHost(t, 1_000);
    assert.equal(pending.status, extraction ? "fulfilled" : "rejected", "cleanup must not hold the public result pending");
    if (extraction) assert.deepEqual(pending.value, { status: "INVALID" });
    else sessionCode("PROTECTED_SESSION_INVALID_RESPONSE")(pending.error);
  });
}

for (const stalledMethod of ["Page.enable", "Runtime.enable", "Page.addScriptToEvaluateOnNewDocument"]) {
  test(`setup bounds stalled ${stalledMethod} and attempts detach`, async (t) => {
    const cdp = new FakeCdpSession();
    const stalled = deferred<unknown>();
    cdp.responder = (method) => method === stalledMethod ? stalled.promise : {};
    t.after(() => { stalled.resolve({ identifier: "late-bootstrap" }); });
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    const pending = observed(createProtectedApplicationBrowserSession({ page: fakePage(cdp) }));
    await flushHost();
    await advanceHost(t, 5_000);
    assert.equal(pending.status, "rejected", "setup transport must be host bounded");
    sessionCode("PROTECTED_SESSION_SETUP_FAILED")(pending.error);
    assert.equal(cdp.detached, true);
  });
}

for (const cleanupPath of ["malformed extraction", "verification mismatch"] as const) {
  test(`${cleanupPath} dispatches cleanup once when validation exhausts the host budget`, async (t) => {
    const cdp = new FakeCdpSession();
    const cleanup = deferred<unknown>();
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown) => { unhandled.push(error); };
    process.on("unhandledRejection", onUnhandled);
    let validationConsumedBudget = false;
    // The getter models synchronous schema work consuming the remaining host
    // budget after the initial transport has already settled and cleared its timer.
    const invalidReport = {
      get schemaVersion() {
        if (!validationConsumedBudget) t.mock.timers.tick(5_000);
        validationConsumedBudget = true;
        return 2;
      },
      forms: []
    };
    const session = await readyFakeSession(cdp, (declaration) => {
      if (declaration.includes("this.extract")) return byValue({ kind: "OK", candidateId: 1,
        report: cleanupPath === "malformed extraction" ? invalidReport : MINIMAL_REPORT });
      if (declaration.includes("this.verifyCandidate")) return byValue({ status: "CURRENT", report: invalidReport,
        fence: { semanticRevision: 0, applicantStateEpoch: 0 } });
      if (declaration.includes("this.disposeCandidate")) return cleanup.promise;
      return byValue("DISPOSED", "string");
    });
    t.after(() => { process.off("unhandledRejection", onUnhandled); cleanup.resolve({}); return session.close(); });
    const extraction = cleanupPath === "verification mismatch" ? await session.extractApplicationForm() : null;
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    const pending = observed(extraction ? session.verifyCandidate(extraction.candidate) : session.extractApplicationForm());
    await flushHost();
    assert.equal(validationConsumedBudget, true);
    assert.equal(cdp.commands.filter((command) => String(command.params?.functionDeclaration).includes("this.disposeCandidate")).length,
      1, "expired validation cleanup must still be dispatched exactly once");
    assert.equal(pending.status, extraction ? "fulfilled" : "rejected", "cleanup must not gain a fresh wait budget");
    if (extraction) assert.deepEqual(pending.value, { status: "INVALID" });
    else sessionCode("PROTECTED_SESSION_INVALID_RESPONSE")(pending.error);
    await assert.rejects(session.snapshot(), sessionCode("PROTECTED_SESSION_NOT_READY"));
    cleanup.reject(new Error("SECRET LATE EXPIRED CLEANUP FAILURE"));
    await flushHost();
    assert.deepEqual(unhandled, []);
    assert.equal(cdp.commands.filter((command) => String(command.params?.functionDeclaration).includes("this.disposeCandidate")).length, 1);
  });
}

test("an already-expired readiness budget does not dispatch an ordinary public CDP call", async () => {
  const cdp = new FakeCdpSession();
  cdp.responder = (method) => method === "Page.addScriptToEvaluateOnNewDocument" ? { identifier: "bootstrap" } : {};
  const session = await createProtectedApplicationBrowserSession({ page: fakePage(cdp), readinessTimeoutMs: 0 });
  await assert.rejects(session.waitUntilReady(), sessionCode("PROTECTED_SESSION_READINESS_TIMEOUT"));
  assert.equal(cdp.commands.some((command) => command.method === "Page.getFrameTree"), false);
  await session.close();
});

test("setup failure settles after attempting a detach that never resolves", async (t) => {
  const cdp = new FakeCdpSession();
  const detached = deferred<void>();
  cdp.detachResponder = () => detached.promise;
  cdp.responder = () => { throw new Error("SECRET SETUP ERROR"); };
  t.after(() => { detached.resolve(); });
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const pending = observed(createProtectedApplicationBrowserSession({ page: fakePage(cdp) }));
  await flushHost();
  assert.equal(cdp.detached, true);
  await advanceHost(t, 5_000);
  assert.equal(pending.status, "rejected", "rollback detach must not block setup rejection");
  sessionCode("PROTECTED_SESSION_SETUP_FAILED")(pending.error);
});

test("late bootstrap registration is removed after setup timeout and its cleanup rejection is observed", async (t) => {
  const cdp = new FakeCdpSession();
  const registration = deferred<unknown>();
  const cleanup = deferred<unknown>();
  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown) => { unhandled.push(error); };
  process.on("unhandledRejection", onUnhandled);
  cdp.responder = (method) => method === "Page.addScriptToEvaluateOnNewDocument" ? registration.promise
    : method === "Page.removeScriptToEvaluateOnNewDocument" ? cleanup.promise : {};
  t.after(() => { process.off("unhandledRejection", onUnhandled); registration.resolve({}); cleanup.resolve({}); });
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const pending = observed(createProtectedApplicationBrowserSession({ page: fakePage(cdp) }));
  await flushHost();
  await advanceHost(t, 5_000);
  assert.equal(pending.status, "rejected");
  assert.equal(cdp.detached, true);
  registration.resolve({ identifier: "late-bootstrap" });
  await flushHost();
  assert.deepEqual(cdp.commands.filter((command) => command.method === "Page.removeScriptToEvaluateOnNewDocument"), [
    { method: "Page.removeScriptToEvaluateOnNewDocument", params: { identifier: "late-bootstrap" } }
  ]);
  cleanup.reject(new Error("SECRET LATE CLEANUP FAILURE"));
  await flushHost();
  assert.equal(pending.status, "rejected");
  assert.deepEqual(unhandled, []);
});

test("setup transport timeout plus stalled rollback has a finite combined host budget", async (t) => {
  const cdp = new FakeCdpSession();
  const transport = deferred<unknown>();
  const detach = deferred<void>();
  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown) => { unhandled.push(error); };
  process.on("unhandledRejection", onUnhandled);
  cdp.responder = () => transport.promise;
  cdp.detachResponder = () => detach.promise;
  t.after(() => { process.off("unhandledRejection", onUnhandled); transport.resolve({}); detach.resolve(); });
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const pending = observed(createProtectedApplicationBrowserSession({ page: fakePage(cdp) }));
  await flushHost();
  await advanceHost(t, 5_000);
  assert.equal(cdp.detached, true);
  await advanceHost(t, 5_000);
  assert.equal(pending.status, "rejected");
  sessionCode("PROTECTED_SESSION_SETUP_FAILED")(pending.error);
  transport.reject(new Error("SECRET LATE SETUP FAILURE"));
  detach.reject(new Error("SECRET LATE DETACH FAILURE"));
  await flushHost();
  assert.deepEqual(unhandled, []);
});

test("late CDP attachment after setup timeout is detached without continuing setup", async (t) => {
  const cdp = new FakeCdpSession();
  const attached = deferred<CDPSession>();
  const page = fakePage(cdp);
  page.context().newCDPSession = () => attached.promise;
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const pending = observed(createProtectedApplicationBrowserSession({ page }));
  await advanceHost(t, 5_000);
  assert.equal(pending.status, "rejected", "attachment must be host bounded");
  sessionCode("PROTECTED_SESSION_SETUP_FAILED")(pending.error);
  attached.resolve(cdp as unknown as CDPSession);
  await flushHost();
  assert.equal(cdp.detached, true);
  assert.deepEqual(cdp.commands, []);
});

for (const lateOutcome of ["success", "rejection"] as const) {
  test(`timed-out extraction ignores late ${lateOutcome} after a new document becomes ready`, async (t) => {
    const cdp = new FakeCdpSession();
    const late = deferred<unknown>();
    let calls = 0;
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown) => { unhandled.push(error); };
    process.on("unhandledRejection", onUnhandled);
    const session = await readyFakeSession(cdp, (declaration) => {
      if (declaration.includes("this.extract")) return ++calls === 1 ? late.promise
        : byValue({ kind: "OK", candidateId: 2, report: MINIMAL_REPORT });
      if (declaration.includes("this.snapshot")) return byValue({ semanticRevision: 7, applicantStateEpoch: 3 });
      if (declaration.includes("this.verifyCandidate")) return byValue({ status: "CURRENT", report: MINIMAL_REPORT,
        fence: { semanticRevision: 7, applicantStateEpoch: 3 } });
      return byValue("DISPOSED", "string");
    });
    t.after(() => { process.off("unhandledRejection", onUnhandled); late.resolve({}); return session.close(); });
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    const pending = observed(session.extractApplicationForm());
    await advanceHost(t, 5_000);
    assert.equal(pending.status, "rejected", "old extraction must settle at the host deadline");
    replaceDocument(cdp);
    await session.waitUntilReady();
    const current = await session.extractApplicationForm();
    const before = await session.snapshot();
    if (lateOutcome === "success") late.resolve(byValue({ kind: "OK", candidateId: 1, report: MINIMAL_REPORT }));
    else late.reject(new Error("SECRET LATE RENDERER FAILURE"));
    await flushHost();
    assert.equal(pending.status, "rejected");
    assert.deepEqual(await session.snapshot(), before);
    assert.equal((await session.verifyCandidate(current.candidate)).status, "CURRENT");
    assert.deepEqual(unhandled, []);
    assert.equal(calls, 2);
  });
}

test("an old operation timeout cannot invalidate authority already installed for a newer document", async (t) => {
  const cdp = new FakeCdpSession();
  const late = deferred<unknown>();
  let snapshots = 0;
  const session = await readyFakeSession(cdp, (declaration) => declaration.includes("this.snapshot")
    ? ++snapshots === 1 ? late.promise : byValue({ semanticRevision: 8, applicantStateEpoch: 4 })
    : byValue("DISPOSED", "string"));
  t.after(() => { late.resolve({}); return session.close(); });
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const old = observed(session.snapshot());
  replaceDocument(cdp);
  await session.waitUntilReady();
  await advanceHost(t, 5_000);
  assert.equal(old.status, "rejected");
  sessionCode("PROTECTED_SESSION_STALE_RESPONSE")(old.error);
  assert.deepEqual(await session.snapshot(), { documentEpoch: 1, semanticRevision: 8, applicantStateEpoch: 4 });
});

test("uses a different high-entropy world name for every protected page session", async () => {
  const firstCdp = new FakeCdpSession();
  const secondCdp = new FakeCdpSession();
  const respond = (method: string) => method === "Page.addScriptToEvaluateOnNewDocument"
    ? { identifier: "bootstrap" }
    : {};
  firstCdp.responder = respond;
  secondCdp.responder = respond;

  const first = await createProtectedApplicationBrowserSession({ page: fakePage(firstCdp) });
  const second = await createProtectedApplicationBrowserSession({ page: fakePage(secondCdp) });
  const worldName = (cdp: FakeCdpSession) => String(
    cdp.commands.find((command) => command.method === "Page.addScriptToEvaluateOnNewDocument")?.params?.worldName
  );
  assert.notEqual(worldName(firstCdp), worldName(secondCdp));

  await first.close();
  await second.close();
});

test("bootstrap registration failure is bounded and detaches the partially created page session", async () => {
  const cdp = new FakeCdpSession();
  cdp.responder = (method) => {
    if (method === "Page.addScriptToEvaluateOnNewDocument") {
      throw new Error("SECRET EMPLOYER SETUP FAILURE");
    }
    return {};
  };
  await assert.rejects(
    createProtectedApplicationBrowserSession({ page: fakePage(cdp) }),
    sessionCode("PROTECTED_SESSION_SETUP_FAILED")
  );
  assert.equal(cdp.detached, true);
});

test("exception-bearing protocol results become fixed invalid-response errors without employer details", async () => {
  const cdp = new FakeCdpSession();
  const session = await readyFakeSession(cdp, (declaration) => {
    if (declaration.includes("snapshot")) {
      return {
        ...byValue({ semanticRevision: 0, applicantStateEpoch: 0 }),
        exceptionDetails: { text: "SECRET EMPLOYER EXCEPTION", stackTrace: { callFrames: [] } }
      };
    }
    return byValue("DISPOSED", "string");
  });
  await assert.rejects(session.snapshot(), sessionCode("PROTECTED_SESSION_INVALID_RESPONSE"));
  await session.close();
});

test("a late extraction reply is discarded after context destruction even when the numeric ID is reused", async () => {
  const cdp = new FakeCdpSession();
  let resolveExtraction!: (value: unknown) => void;
  const lateExtraction = new Promise<unknown>((resolve) => {
    resolveExtraction = resolve;
  });
  const session = await readyFakeSession(cdp, (declaration) => {
    if (declaration.includes("this.extract")) return lateExtraction;
    return byValue("DISPOSED", "string");
  });
  const worldName = String(
    cdp.commands.find((command) => command.method === "Page.addScriptToEvaluateOnNewDocument")?.params?.worldName
  );
  const pending = session.extractApplicationForm();
  cdp.emit("Runtime.executionContextDestroyed", { executionContextId: 41 });
  cdp.emit("Runtime.executionContextCreated", {
    context: {
      id: 41,
      name: worldName,
      uniqueId: "optional-defense-in-depth-only",
      auxData: { frameId: "main-frame", isDefault: false, type: "isolated" }
    }
  });
  resolveExtraction(byValue({ kind: "OK", candidateId: 1, report: MINIMAL_REPORT }));
  await assert.rejects(pending, sessionCode("PROTECTED_SESSION_STALE_RESPONSE"));
  await session.waitUntilReady();
  await session.close();
});

test("main-frame navigation cannot handshake a retained old-context map entry before the new context arrives", async () => {
  const cdp = new FakeCdpSession();
  const session = await readyFakeSession(cdp);
  const worldName = String(
    cdp.commands.find((command) => command.method === "Page.addScriptToEvaluateOnNewDocument")?.params?.worldName
  );
  cdp.emit("Page.frameNavigated", { frame: { id: "main-frame", url: "https://new.example.test/" } });

  let settled = false;
  const readyForNewDocument = session.waitUntilReady().then(() => {
    settled = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false);

  cdp.emit("Runtime.executionContextCreated", {
    context: {
      id: 52,
      name: worldName,
      auxData: { frameId: "main-frame", isDefault: false, type: "isolated" }
    }
  });
  await readyForNewDocument;
  const evaluations = cdp.commands.filter((command) => command.method === "Runtime.evaluate");
  assert.equal(evaluations.at(-1)?.params?.contextId, 52);
  await session.close();
});

test("context loss invalidates old candidates synchronously and never rebinds them to a reused context ID", async () => {
  const cdp = new FakeCdpSession();
  const session = await readyFakeSession(cdp, (declaration) => {
    if (declaration.includes("this.extract")) {
      return byValue({ kind: "OK", candidateId: 7, report: MINIMAL_REPORT });
    }
    return byValue("DISPOSED", "string");
  });
  const extraction = await session.extractApplicationForm();
  cdp.emit("Runtime.executionContextsCleared", {});
  assert.deepEqual(await session.verifyCandidate(extraction.candidate), { status: "INVALID" });
  await extraction.dispose();
  await session.close();
});

test("candidate disposal wins over an in-flight verification response", async () => {
  const cdp = new FakeCdpSession();
  let resolveVerification!: (value: unknown) => void;
  const verificationResponse = new Promise<unknown>((resolve) => {
    resolveVerification = resolve;
  });
  const session = await readyFakeSession(cdp, (declaration) => {
    if (declaration.includes("this.extract")) {
      return byValue({ kind: "OK", candidateId: 9, report: MINIMAL_REPORT });
    }
    if (declaration.includes("this.verifyCandidate")) return verificationResponse;
    return byValue("DISPOSED", "string");
  });
  const extraction = await session.extractApplicationForm();
  const verification = session.verifyCandidate(extraction.candidate);
  const disposal = extraction.dispose();
  resolveVerification(byValue({
    status: "CURRENT",
    report: MINIMAL_REPORT,
    fence: { semanticRevision: 0, applicantStateEpoch: 0 }
  }));

  assert.deepEqual(await verification, { status: "INVALID" });
  await disposal;
  await session.close();
});

test("the readiness deadline also bounds capability acquisition and handshake", async () => {
  const cdp = new FakeCdpSession();
  cdp.responder = (method, params) => {
    if (method === "Page.addScriptToEvaluateOnNewDocument") return { identifier: "bootstrap-timeout" };
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main-frame" } } };
    if (method === "Runtime.evaluate") return { result: { type: "object", objectId: "capability-main" } };
    if (method === "Runtime.callFunctionOn" && String(params?.functionDeclaration).includes("handshake")) {
      return new Promise((resolve) => setTimeout(() => resolve(strictHandshakeResponse()), 50));
    }
    return {};
  };
  const session = await createProtectedApplicationBrowserSession({
    page: fakePage(cdp),
    readinessTimeoutMs: 5
  });
  const worldName = String(
    cdp.commands.find((command) => command.method === "Page.addScriptToEvaluateOnNewDocument")?.params?.worldName
  );
  cdp.emit("Runtime.executionContextCreated", {
    context: {
      id: 61,
      name: worldName,
      auxData: { frameId: "main-frame", isDefault: false, type: "isolated" }
    }
  });

  await assert.rejects(
    session.waitUntilReady(),
    sessionCode("PROTECTED_SESSION_READINESS_TIMEOUT")
  );
  await session.close();
});

test("readiness configuration is bounded before a CDP session is attached", async () => {
  const cdp = new FakeCdpSession();
  await assert.rejects(
    createProtectedApplicationBrowserSession({
      page: fakePage(cdp),
      readinessTimeoutMs: Number.POSITIVE_INFINITY
    }),
    sessionCode("PROTECTED_SESSION_SETUP_FAILED")
  );
  assert.deepEqual(cdp.commands, []);
  assert.equal(cdp.detached, false);
});

for (const code of ["DOCUMENT_CHANGED", "SESSION_DISCONNECTED", "PAGE_CLOSED", "CLOSED"] as const) {
  test(`${code} observes async subscriber rejection without delaying invalidation or close`, async (t) => {
    const cdp = new FakeCdpSession();
    const page = fakePage(cdp);
    const session = await readyFakeSession(cdp, undefined, page);
    const subscriber = deferred<void>();
    const received: string[] = [];
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown) => { unhandled.push(error); };
    process.on("unhandledRejection", onUnhandled);
    t.after(async () => {
      subscriber.resolve();
      await session.close();
      await flushHost();
      process.off("unhandledRejection", onUnhandled);
    });
    session.subscribe(async (event) => {
      if (event !== code) return;
      received.push(event);
      await subscriber.promise;
    });

    if (code === "DOCUMENT_CHANGED") replaceDocument(cdp);
    else if (code === "SESSION_DISCONNECTED") cdp.emit("close");
    else if (code === "PAGE_CLOSED") (page as unknown as EventEmitter).emit("close", page);
    else session.close();
    assert.deepEqual(received, [code], "advisory notification remains synchronous");
    await assert.rejects(session.snapshot(), sessionCode(code === "DOCUMENT_CHANGED"
      ? "PROTECTED_SESSION_NOT_READY" : "PROTECTED_SESSION_CLOSED"));
    const closing = observed(session.close());
    await flushHost();
    assert.equal(closing.status, "fulfilled", "a pending subscriber cannot hold close open");
    assert.equal(cdp.detached, true);

    subscriber.reject(new Error(`SECRET ${code} SUBSCRIBER FAILURE`));
    await flushHost();
    assert.deepEqual(unhandled, [], "late subscriber rejection must have an observer");
    assert.equal(closing.status, "fulfilled");
  });
}

for (const failure of ["thenable rejection", "then getter throw", "then call throw"] as const) {
  test(`lifecycle notifications contain ${failure}`, async (t) => {
    const cdp = new FakeCdpSession();
    const session = await readyFakeSession(cdp);
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown) => { unhandled.push(error); };
    process.on("unhandledRejection", onUnhandled);
    t.after(async () => {
      await session.close();
      await flushHost();
      process.off("unhandledRejection", onUnhandled);
    });
    let thenAccesses = 0;
    let thenCalls = 0;
    let followingSubscriberCalled = false;
    const thenable = {
      get then() {
        thenAccesses += 1;
        if (failure === "then getter throw") throw new Error("SECRET THEN GETTER FAILURE");
        return (_resolve: (value: void) => void, reject: (reason: unknown) => void) => {
          thenCalls += 1;
          if (failure === "then call throw") throw new Error("SECRET THEN CALL FAILURE");
          reject(new Error("SECRET THENABLE FAILURE"));
        };
      }
    };
    // Exercise runtime assimilation even when a JS subscriber supplies a
    // thenable instead of the Promise<void> promised by the TypeScript contract.
    session.subscribe(() => thenable as unknown as Promise<void>);
    session.subscribe(() => { followingSubscriberCalled = true; });
    const closing = observed(session.close());
    assert.equal(followingSubscriberCalled, true);
    await flushHost();
    assert.equal(thenAccesses, 1, "returned thenables must be observed");
    assert.equal(thenCalls, failure === "then getter throw" ? 0 : 1);
    assert.deepEqual(unhandled, []);
    assert.equal(closing.status, "fulfilled");
    assert.equal(cdp.detached, true);
  });
}

test("a synchronous lifecycle subscriber throw cannot interrupt remaining subscribers or cleanup", async () => {
  const cdp = new FakeCdpSession();
  const session = await readyFakeSession(cdp);
  const received: string[] = [];
  session.subscribe(() => { throw new Error("SECRET SYNCHRONOUS SUBSCRIBER FAILURE"); });
  session.subscribe((code) => { received.push(code); });
  await session.close();
  assert.deepEqual(received, ["CLOSED"]);
  assert.equal(cdp.detached, true);
});

test("lifecycle subscriptions observe invalidation and can be removed without affecting cleanup", async () => {
  const cdp = new FakeCdpSession();
  const session = await readyFakeSession(cdp);
  const retained: string[] = [];
  const removed: string[] = [];
  session.subscribe((code) => { retained.push(code); });
  const unsubscribe = session.subscribe((code) => { removed.push(code); });
  unsubscribe();

  cdp.emit("Page.frameNavigated", { frame: { id: "main-frame", url: "https://new.example.test/" } });
  await session.close();
  assert.deepEqual(retained, ["DOCUMENT_CHANGED", "CLOSED"]);
  assert.deepEqual(removed, []);
});

test("a synchronous CLOSED subscriber shares the exact close promise without repeating cleanup", async () => {
  const cdp = new FakeCdpSession();
  const session = await readyFakeSession(cdp);
  let closedCount = 0;
  let detachCount = 0;
  let reentrantClose: Promise<void> | undefined;
  cdp.detachResponder = async () => { detachCount += 1; };
  session.subscribe((code) => {
    if (code !== "CLOSED") return;
    closedCount += 1;
    // Bound the broken implementation's recursion so RED is an assertion,
    // while still proving whether notification itself reenters close.
    if (closedCount === 1) reentrantClose = session.close();
  });

  const outerClose = session.close();
  const concurrentClose = session.close();
  await Promise.all([outerClose, reentrantClose, concurrentClose]);
  assert.equal(closedCount, 1);
  assert.equal(reentrantClose, outerClose);
  assert.equal(concurrentClose, outerClose);
  assert.equal(session.close(), outerClose);
  assert.equal(cdp.commands.filter((command) =>
    command.params?.functionDeclaration === "function () { return this.dispose(); }").length, 1);
  assert.equal(cdp.commands.filter((command) =>
    command.method === "Page.removeScriptToEvaluateOnNewDocument").length, 1);
  assert.equal(cdp.commands.filter((command) =>
    command.method === "Runtime.releaseObjectGroup").length, 1);
  assert.equal(detachCount, 1);
});

test("close releases the capability object group and bootstrap registration exactly once", async () => {
  const cdp = new FakeCdpSession();
  const session = await readyFakeSession(cdp);
  await session.close();
  await session.close();

  assert.equal(
    cdp.commands.filter((command) => command.method === "Page.removeScriptToEvaluateOnNewDocument").length,
    1
  );
  const releases = cdp.commands.filter((command) => command.method === "Runtime.releaseObjectGroup");
  assert.equal(releases.length, 1);
  assert.match(String(releases[0].params?.objectGroup), /^apply-pilot-protected-[0-9a-f]{64}-objects$/);
  assert.equal(cdp.detached, true);
});

for (const event of ["SESSION_DISCONNECTED", "PAGE_CLOSED"] as const) {
  test(`explicit close after ${event} still shares one cleanup operation`, async () => {
    const cdp = new FakeCdpSession();
    const page = fakePage(cdp);
    const session = await readyFakeSession(cdp, undefined, page);
    const received: string[] = [];
    let reentrantClose: Promise<void> | undefined;
    let detachCount = 0;
    cdp.detachResponder = async () => { detachCount += 1; };
    session.subscribe((code) => {
      received.push(code);
      if (code === "CLOSED") reentrantClose = session.close();
    });
    if (event === "SESSION_DISCONNECTED") cdp.emit("close");
    else (page as unknown as EventEmitter).emit("close", page);

    const closing = session.close();
    assert.equal(reentrantClose, closing);
    assert.equal(session.close(), closing);
    await closing;
    assert.equal(session.close(), closing);
    assert.deepEqual(received, [event, "CLOSED"]);
    assert.equal(cdp.commands.filter((command) =>
      command.params?.functionDeclaration === "function () { return this.dispose(); }").length, 0,
    "lost document authority must not be reused for capability disposal");
    assert.equal(cdp.commands.filter((command) =>
      command.method === "Page.removeScriptToEvaluateOnNewDocument").length, 1);
    assert.equal(cdp.commands.filter((command) =>
      command.method === "Runtime.releaseObjectGroup").length, 1);
    assert.equal(detachCount, 1);
  });
}

for (const failure of ["Runtime.callFunctionOn", "Page.removeScriptToEvaluateOnNewDocument", "Runtime.releaseObjectGroup", "detach"] as const) {
  test(`synchronous ${failure} cleanup failure cannot skip later close dispatches`, async () => {
    const cdp = new FakeCdpSession();
    const session = await readyFakeSession(cdp);
    const send = cdp.send.bind(cdp);
    const reentrantCloses: Promise<void>[] = [];
    let detachCount = 0;
    // Replace the async fake methods so the transport throws synchronously,
    // not merely by returning a rejected Promise.
    cdp.send = (method, params) => {
      reentrantCloses.push(session.close());
      if (method === failure) {
        cdp.commands.push({ method, params });
        throw new Error("SECRET SYNCHRONOUS CLEANUP FAILURE");
      }
      return send(method, params);
    };
    cdp.detach = () => {
      detachCount += 1;
      reentrantCloses.push(session.close());
      if (failure === "detach") throw new Error("SECRET SYNCHRONOUS DETACH FAILURE");
      return Promise.resolve();
    };

    const closing = session.close();
    const state = observed(closing);
    await flushHost();
    assert.equal(state.status, "fulfilled");
    assert.equal(reentrantCloses.length, 4);
    for (const reentrant of reentrantCloses) assert.equal(reentrant, closing);
    assert.equal(session.close(), closing);
    assert.equal(cdp.commands.filter((command) =>
      command.params?.functionDeclaration === "function () { return this.dispose(); }").length, 1);
    assert.equal(cdp.commands.filter((command) =>
      command.method === "Page.removeScriptToEvaluateOnNewDocument").length, 1);
    assert.equal(cdp.commands.filter((command) =>
      command.method === "Runtime.releaseObjectGroup").length, 1);
    assert.equal(detachCount, 1);
  });
}

test("close detaches without waiting for renderer-side capability disposal", async () => {
  const cdp = new FakeCdpSession();
  let resolveDisposal!: (value: unknown) => void;
  const disposalResponse = new Promise<unknown>((resolve) => {
    resolveDisposal = resolve;
  });
  const session = await readyFakeSession(cdp, (declaration) => {
    if (declaration.includes("this.dispose")) return disposalResponse;
    return byValue("DISPOSED", "string");
  });

  let closeSettled = false;
  const closing = session.close().then(() => {
    closeSettled = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const settledBeforeRendererReply = closeSettled;
  const detachedBeforeRendererReply = cdp.detached;

  resolveDisposal(byValue("DISPOSED", "string"));
  await closing;

  assert.equal(closeSettled, true);
  assert.equal(settledBeforeRendererReply, true);
  assert.equal(detachedBeforeRendererReply, true);
});

test("close detaches without waiting for an active protected operation", async () => {
  const cdp = new FakeCdpSession();
  let resolveSnapshot!: (value: unknown) => void;
  const snapshotResponse = new Promise<unknown>((resolve) => {
    resolveSnapshot = resolve;
  });
  const session = await readyFakeSession(cdp, (declaration) => {
    if (declaration.includes("this.snapshot")) return snapshotResponse;
    return byValue("DISPOSED", "string");
  });

  const snapshot = session.snapshot();
  let closeSettled = false;
  const closing = session.close().then(() => {
    closeSettled = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const settledBeforeOperationReply = closeSettled;
  const detachedBeforeOperationReply = cdp.detached;

  resolveSnapshot(byValue({ semanticRevision: 1, applicantStateEpoch: 1 }));
  await closing;
  await assert.rejects(snapshot, sessionCode("PROTECTED_SESSION_STALE_RESPONSE"));

  assert.equal(closeSettled, true);
  assert.equal(settledBeforeOperationReply, true);
  assert.equal(detachedBeforeOperationReply, true);
});
