import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

import { MISSING_CHROMIUM_MESSAGE } from "@/lib/application-browser/browser-runtime";
import {
  ApplicationFormDomExtractionError,
  extractSafeApplicationForm
} from "@/lib/application-browser/form-inspection-dom";
import {
  ProtectedApplicationFormExtractionError,
  createProtectedApplicationBrowserSession,
  type ProtectedApplicationBrowserSession
} from "@/lib/application-browser/protected-browser-session";
import {
  PROTECTED_BROWSER_CAPABILITY_PROPERTY,
  protectedBrowserWorldBootstrapSource
} from "@/lib/application-browser/protected-browser-world";
import {
  MAX_FIELDS_TOTAL,
  MAX_FORMS,
  applicationFormInspectionReportSchema,
  buildNormalizedApplicationFormInspection,
  type ApplicationFormInspectionReport
} from "@/lib/application-runs/form-inspection";
import {
  PROMPT_LIKE_EMPLOYER_TEXT,
  SECRET_HIDDEN_VALUE,
  SECRET_OPTION_VALUE,
  SECRET_PASSWORD_VALUE,
  closedShadowComboboxFixture,
  externalGroupIframeFixture,
  fileAndUnsupportedFixture,
  iframeFixture,
  interactiveAriaFixture,
  nativeApplicationFixture,
  nestedCustomInteractionFixture,
  nonHyphenShadowComboboxFixture,
  obviousAriaRoleFixture,
  ownerlessFixture,
  ownershipAndVisibilityFixture,
  repeatedFieldsFixture,
  repeatedFormsFixture,
  shadowInteractionFixture,
  shadowFixture,
  unrelatedIframeFixture,
  unknownMultipleFileFixture,
  privacyFixture
} from "@/tests/browser/form-inspection-fixtures";

let browser: Browser;

before(async () => {
  try {
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    if (error instanceof Error && /executable.*(doesn'?t exist|missing|not found)|playwright install/i.test(error.message)) {
      throw new Error(MISSING_CHROMIUM_MESSAGE);
    }
    throw error;
  }
});

after(async () => {
  await browser?.close();
});

type ProtectedFixture = Readonly<{
  context: BrowserContext;
  page: Page;
  session: ProtectedApplicationBrowserSession;
}>;

async function protectedFixture(html: string): Promise<ProtectedFixture> {
  const context = await browser.newContext();
  const page = await context.newPage();
  const session = await createProtectedApplicationBrowserSession({ page });
  await page.route("https://fixture.example.test/apply", async (route) => {
    await route.fulfill({ status: 200, contentType: "text/html", body: html });
  });
  await page.goto("https://fixture.example.test/apply", { waitUntil: "domcontentloaded" });
  if (/data-(?:open-shadow|open-shadow-role|non-hyphen-shadow|closed-shadow)/.test(html)) {
    await page.evaluate(() => {
      for (const host of document.querySelectorAll("[data-open-shadow]")) {
        const root = host.attachShadow({ mode: "open" });
        root.innerHTML = "<label>Shadow question<input></label>";
      }
      for (const host of document.querySelectorAll("[data-open-shadow-role]")) {
        const root = host.attachShadow({ mode: "open" });
        const role = host.getAttribute("data-open-shadow-role");
        root.innerHTML = `<div role="${role}" aria-label="Shadow interaction" style="display:block;width:20px;height:20px"></div>`;
      }
      for (const host of document.querySelectorAll("[data-non-hyphen-shadow]")) {
        const root = host.attachShadow({ mode: "open" });
        root.innerHTML = host.getAttribute("data-non-hyphen-shadow") === "interactive"
          ? "<button>Nested interaction</button>"
          : "<span>Decoration</span>";
      }
      if (document.querySelector("[data-closed-shadow]") && !customElements.get("closed-combobox")) {
        customElements.define("closed-combobox", class extends HTMLElement {
          constructor() {
            super();
            const root = this.attachShadow({ mode: "closed" });
            root.innerHTML = "<input aria-label=\"Uninspectable office search\">";
          }
        });
      }
    });
  }
  await session.waitUntilReady();
  return { context, page, session };
}

async function closeFixture(fixture: ProtectedFixture): Promise<void> {
  await fixture.session.close();
  await fixture.context.close();
}

async function isolatedProtectedWorldEvidence(html: string, body: string): Promise<unknown> {
  const fixture = await protectedFixture(html);
  const cdp = await fixture.context.newCDPSession(fixture.page);
  try {
    const { frameTree } = await cdp.send("Page.getFrameTree");
    const { executionContextId } = await cdp.send("Page.createIsolatedWorld", {
      frameId: frameTree.frame.id,
      worldName: "commit-2a-two-finding-regression"
    });
    await cdp.send("Runtime.evaluate", {
      contextId: executionContextId,
      expression: protectedBrowserWorldBootstrapSource()
    });
    const result = await cdp.send("Runtime.evaluate", {
      contextId: executionContextId,
      returnByValue: true,
      expression: `(() => { ${body} })()`
    });
    assert.equal(result.exceptionDetails, undefined);
    return result.result.value;
  } finally {
    await cdp.detach();
    await closeFixture(fixture);
  }
}

type OpaqueFieldSlot = Readonly<{
  sourceOrdinal: Readonly<{ form: number; section: number; field: number }>;
  reference: object;
  choices: readonly Readonly<{
    sourceOrdinal: Readonly<{ form: number; section: number; field: number; choice: number }>;
    reference: object;
  }>[];
}>;

function assertEmptyOpaqueReference(reference: object): void {
  assert.equal(Object.getPrototypeOf(reference), null);
  assert.deepEqual(Reflect.ownKeys(reference), []);
  assert.equal(Object.isFrozen(reference), true);
}

async function assertProtectedExtractionCode(
  fixture: ProtectedFixture,
  expectedCode: "FORM_STRUCTURE_UNSUPPORTED" | "FORM_INSPECTION_OVERSIZE"
): Promise<void> {
  await assert.rejects(
    fixture.session.extractApplicationForm(),
    (error: unknown) =>
      error instanceof ProtectedApplicationFormExtractionError && error.code === expectedCode
  );
}

const externalSemanticCases = [
  { name: "external label removal", dependency: '<label id="dependency" for="answer">Question</label>', attribute: "", mutation: "dependency.remove();", status: "INVALID" },
  { name: "same-looking label replacement", dependency: '<label id="dependency" for="answer">Question</label>', attribute: "", mutation: "dependency.replaceWith(dependency.cloneNode(true));", status: "CURRENT" },
  { name: "aria-labelledby removal", dependency: '<span id="dependency">Question</span>', attribute: 'aria-labelledby="dependency"', mutation: "dependency.remove();", status: "INVALID" },
  { name: "same-looking aria-labelledby replacement", dependency: '<span id="dependency">Question</span>', attribute: 'aria-labelledby="dependency"', mutation: "dependency.replaceWith(dependency.cloneNode(true));", status: "CURRENT" },
  { name: "nested aria-labelledby character-data change", dependency: '<span id="dependency"><span>Question</span></span>', attribute: 'aria-labelledby="dependency"', mutation: 'dependency.firstElementChild.firstChild.nodeValue = "Changed question";', status: "INVALID" },
  { name: "nested aria-labelledby text replacement", dependency: '<span id="dependency"><span>Question</span></span>', attribute: 'aria-labelledby="dependency"', mutation: 'dependency.firstElementChild.textContent = "Changed question";', status: "INVALID" },
  { name: "aria-describedby removal", dependency: '<span id="dependency">Help</span>', attribute: 'aria-label="Question" aria-describedby="dependency"', mutation: "dependency.remove();", status: "INVALID" },
  { name: "parent subtree removal", dependency: '<span id="dependency">Question</span>', attribute: 'aria-labelledby="dependency"', mutation: "dependency.parentElement.remove();", status: "INVALID" },
  { name: "remove and reinsert dependency", dependency: '<label id="dependency" for="answer">Question</label>', attribute: "", mutation: "const parent = dependency.parentElement; dependency.remove(); parent.append(dependency);", status: "CURRENT" },
  { name: "accepted label replacement then removal", dependency: '<label id="dependency" for="answer">Question</label>', attribute: "", mutation: "dependency.replaceWith(dependency.cloneNode(true));", status: "CURRENT", removeAfterCurrent: true },
  { name: "accepted aria-labelledby replacement then removal", dependency: '<span id="dependency">Question</span>', attribute: 'aria-labelledby="dependency"', mutation: "dependency.replaceWith(dependency.cloneNode(true));", status: "CURRENT", removeAfterCurrent: true }
] as const;

const introducedSemanticCases = [
  {
    name: "new external native label",
    html: '<!doctype html><body><aside id="outside"></aside><form><input id="answer" aria-label="Fallback question"></form></body>',
    mutation: `
      const dependency = document.createElement("label");
      dependency.htmlFor = "answer";
      dependency.textContent = "New native label";
      document.getElementById("outside").append(dependency);
    `,
    subtreeMutation: `
      const wrapper = document.createElement("section");
      wrapper.innerHTML = '<div><label for="answer">New native label</label></div>';
      document.getElementById("outside").append(wrapper);
    `,
    initialQuestion: "Fallback question",
    initialHelpText: null,
    currentQuestion: "New native label",
    currentHelpText: null
  },
  {
    name: "previously unresolved aria-labelledby",
    html: '<!doctype html><body><aside id="outside"></aside><form><input aria-labelledby="future-label" aria-label="Fallback question"></form></body>',
    mutation: `
      const dependency = document.createElement("div");
      dependency.id = "future-label";
      dependency.textContent = "New ARIA label";
      document.getElementById("outside").append(dependency);
    `,
    subtreeMutation: `
      const wrapper = document.createElement("section");
      wrapper.innerHTML = '<div><span id="future-label">New ARIA label</span></div>';
      document.getElementById("outside").append(wrapper);
    `,
    initialQuestion: "Fallback question",
    initialHelpText: null,
    currentQuestion: "New ARIA label",
    currentHelpText: null
  },
  {
    name: "previously unresolved aria-describedby",
    html: '<!doctype html><body><aside id="outside"></aside><form><input aria-label="Static question" aria-describedby="future-help"></form></body>',
    mutation: `
      const dependency = document.createElement("div");
      dependency.id = "future-help";
      dependency.textContent = "New ARIA help";
      document.getElementById("outside").append(dependency);
    `,
    subtreeMutation: null,
    initialQuestion: "Static question",
    initialHelpText: null,
    currentQuestion: "Static question",
    currentHelpText: "New ARIA help"
  }
] as const;

// The root budget counts document + 4 forms + 200 fields + 1,000 choices.
// These fixtures exercise the resulting 1,204-shadow-root boundary independently
// of the production constant, including roots discovered below another shadow.
async function observationRootEvidence(body: string) {
  const fixture = await protectedFixture('<!doctype html><body><form id="root-form"><input aria-label="Question"></form></body>');
  const cdp = await fixture.context.newCDPSession(fixture.page);
  try {
    const { frameTree } = await cdp.send("Page.getFrameTree");
    const { executionContextId } = await cdp.send("Page.createIsolatedWorld", {
      frameId: frameTree.frame.id,
      worldName: "task-6-observation-root-regression"
    });
    const result = await cdp.send("Runtime.evaluate", {
      contextId: executionContextId,
      returnByValue: true,
      expression: `(() => {
        const NativeObserver = MutationObserver;
        const active = new Map();
        let created = 0;
        let observes = 0;
        let disconnects = 0;
        const callbacks = [];
        // Only this test-owned isolated world is instrumented. Every wrapper
        // calls the real browser observer; production captures these methods.
        globalThis.MutationObserver = class extends NativeObserver {
          constructor(callback) { super(callback); callbacks.push(callback); this.testId = ++created; }
          observe(root, options) { super.observe(root, options); observes++; active.set(this, this.testId); }
          disconnect() { super.disconnect(); disconnects++; active.delete(this); }
        };
        ${protectedBrowserWorldBootstrapSource()}
        const capability = globalThis[${JSON.stringify(PROTECTED_BROWSER_CAPABILITY_PROPERTY)}];
        const counts = () => ({ created, observes, disconnects, active: active.size, ids: [...active.values()] });
        const hosts = [];
        const addRoots = (count, surface = document.getElementById("root-form")) => {
          let parent = surface;
          for (let index = 0; index < count; index++) {
            if (index % 2 === 0) parent = surface;
            const host = document.createElement("div");
            parent.append(host);
            hosts.push(host);
            parent = host.attachShadow({ mode: "open" });
          }
        };
        const addComposedAncestorRoots = (nestedCount) => {
          const form = document.getElementById("root-form");
          const input = form.querySelector("input");
          input.removeAttribute("aria-label");
          input.setAttribute("aria-labelledby", "slotted-root-target");
          const outerHost = document.createElement("div");
          const target = document.createElement("span");
          target.id = "slotted-root-target";
          target.slot = "question";
          target.textContent = "Question";
          outerHost.append(target);
          form.prepend(outerHost);
          const outerRoot = outerHost.attachShadow({ mode: "open" });
          const slot = document.createElement("slot");
          slot.name = "question";
          outerRoot.append(slot);
          let deepestRoot = outerRoot;
          for (let index = 0; index < nestedCount; index++) {
            const host = document.createElement("div");
            outerRoot.append(host);
            deepestRoot = host.attachShadow({ mode: "open" });
          }
          return deepestRoot;
        };
        try { ${body} } finally { capability.dispose(); }
      })()`
    });
    assert.equal(result.exceptionDetails, undefined, "protected cleanup must not throw on root overflow");
    return result.result.value;
  } finally {
    await cdp.detach();
    await closeFixture(fixture);
  }
}

test("observation roots accept exactly document plus 1,204 nested passive roots and disconnect every accepted observer", async (context) => {
  for (const disposal of ["candidates", "capability"] as const) {
    await context.test(disposal, async () => {
      const evidence = await observationRootEvidence(`
        addRoots(1204);
        const first = capability.extract();
        const second = capability.extract();
        const accepted = counts();
        const status = capability.verifyCandidate({ candidateId: first.candidateId }).status;
        let remaining = null;
        let removed = null;
        ${disposal === "candidates" ? `
          capability.disposeCandidate({ candidateId: first.candidateId });
          remaining = counts();
          capability.disposeCandidate({ candidateId: second.candidateId });
          removed = counts();
        ` : ""}
        capability.dispose();
        return { kinds: [first.kind, second.kind], status, accepted, remaining, removed, disposed: counts() };
      `);
      assert.deepEqual(evidence.kinds, ["OK", "OK"]);
      assert.equal(evidence.status, "CURRENT");
      assert.equal(evidence.accepted.created, 1205);
      assert.equal(evidence.accepted.observes, 1205);
      assert.equal(evidence.accepted.active, 1205);
      if (disposal === "candidates") {
        assert.deepEqual(evidence.remaining, evidence.accepted, "shared roots keep the same observer identities");
        assert.equal(evidence.removed.active, 1, "only the document observer remains");
        assert.equal(evidence.removed.disconnects, 1204);
      }
      assert.equal(evidence.disposed.active, 0);
      assert.equal(evidence.disposed.disconnects, 1205);
    });
  }
});

test("observation-root overflow rejects before installing any candidate observers", async (context) => {
  for (const shadowRoots of [1205, 2048]) {
    await context.test(`${shadowRoots} shadow roots`, async () => {
      const evidence = await observationRootEvidence(`
        addRoots(${shadowRoots});
        const result = capability.extract();
        const rejected = counts();
        capability.dispose();
        return { result, rejected, disposed: counts() };
      `);
      assert.deepEqual(evidence.result, { kind: "ERROR", code: "FORM_INSPECTION_OVERSIZE" });
      assert.deepEqual(evidence.rejected, { created: 1, observes: 1, disconnects: 0, active: 1, ids: [1] });
      assert.equal(evidence.disposed.active, 0);
      assert.equal(evidence.disposed.disconnects, 1);
    });
  }
});

test("composed ancestor roots include every nested open root in observation and the 1,205-root ceiling", async (context) => {
  await context.test("nested retained root mutation is observed by an immediate drain", async () => {
    const evidence = await observationRootEvidence(`
      const deepestRoot = addComposedAncestorRoots(1);
      const extraction = capability.extract();
      const accepted = counts();
      const before = capability.snapshot();
      const button = document.createElement("button");
      button.textContent = "Late nested action";
      deepestRoot.append(button);
      const after = capability.snapshot();
      const status = capability.verifyCandidate({ candidateId: extraction.candidateId }).status;
      return { kind: extraction.kind, accepted, before, after, status, cleaned: counts() };
    `);
    assert.equal(evidence.kind, "OK");
    assert.ok(evidence.after.semanticRevision > evidence.before.semanticRevision);
    assert.equal(evidence.after.applicantStateEpoch, evidence.before.applicantStateEpoch);
    assert.equal(evidence.status, "INVALID");
    assert.equal(evidence.accepted.active, 3, "document, composed ancestor root, and nested root must be observed");
    assert.equal(evidence.cleaned.active, 1, "invalid verification must remove candidate-only observers");
  });

  for (const scenario of [
    { name: "exact 1,205-root union", nestedRoots: 1_203, kind: "OK", active: 1_205 },
    { name: "1,206-root union", nestedRoots: 1_204, kind: "ERROR", active: 1 }
  ] as const) {
    await context.test(scenario.name, async () => {
      const evidence = await observationRootEvidence(`
        addComposedAncestorRoots(${scenario.nestedRoots});
        const result = capability.extract();
        return { result, observed: counts() };
      `);
      assert.equal(evidence.result.kind, scenario.kind);
      if (scenario.kind === "ERROR") {
        assert.equal(evidence.result.code, "FORM_INSPECTION_OVERSIZE");
      }
      assert.equal(evidence.observed.active, scenario.active);
    });
  }
});

test("rejected root observations roll back candidate slots and semantic dependency identities", async () => {
  const evidence = await observationRootEvidence(`
    const aside = document.createElement("aside");
    aside.innerHTML = '<span id="rejected-dependency">Question</span>';
    document.body.append(aside);
    document.querySelector("input").setAttribute("aria-labelledby", "rejected-dependency");
    addRoots(1205);
    const rejected = Array.from({ length: 17 }, () => capability.extract());
    const afterRejection = counts();
    const before = capability.snapshot();
    aside.firstElementChild.remove();
    const after = capability.snapshot();
    for (const host of hosts) host.remove();
    const accepted = Array.from({ length: 16 }, () => capability.extract());
    const atCap = capability.extract();
    for (const candidate of accepted) capability.disposeCandidate({ candidateId: candidate.candidateId });
    return { rejected, afterRejection, before, after, accepted: accepted.map(item => item.kind), atCap, cleaned: counts() };
  `);
  assert.deepEqual(evidence.rejected, Array.from({ length: 17 }, () => ({ kind: "ERROR", code: "FORM_INSPECTION_OVERSIZE" })));
  assert.equal(evidence.afterRejection.created, 1);
  assert.deepEqual(evidence.after, evidence.before, "failed candidates must not retain external semantic identities");
  assert.deepEqual(evidence.accepted, Array.from({ length: 16 }, () => "OK"), "rejected candidates must not consume any of the 16 slots");
  assert.deepEqual(evidence.atCap, { kind: "ERROR", code: "FORM_INSPECTION_OVERSIZE" });
  assert.equal(evidence.cleaned.active, 1);
});

test("overflow preserves previously accepted observer and semantic identities until candidate disposal", async () => {
  const evidence = await observationRootEvidence(`
    const oldAside = document.createElement("aside");
    oldAside.innerHTML = '<label for="old-answer">Question</label>';
    document.body.append(oldAside);
    document.querySelector("input").id = "old-answer";
    addRoots(2);
    const accepted = capability.extract();
    const initial = counts();
    const newAside = document.createElement("aside");
    newAside.innerHTML = '<label for="new-answer">New question</label>';
    document.body.append(newAside);
    const newForm = document.createElement("form");
    newForm.innerHTML = '<input id="new-answer">';
    document.body.append(newForm);
    addRoots(1203, newForm);
    const rejected = capability.extract();
    const preserved = counts();
    const before = capability.snapshot();
    newAside.firstElementChild.remove();
    const afterRejected = capability.snapshot();
    oldAside.firstElementChild.remove();
    const afterAccepted = capability.snapshot();
    const disposal = capability.disposeCandidate({ candidateId: accepted.candidateId });
    return { kind: accepted.kind, initial, rejected, preserved, before, afterRejected, afterAccepted, disposal, cleaned: counts() };
  `);
  assert.equal(evidence.kind, "OK");
  assert.deepEqual(evidence.rejected, { kind: "ERROR", code: "FORM_INSPECTION_OVERSIZE" });
  assert.equal(evidence.initial.active, 3);
  assert.deepEqual(evidence.preserved, evidence.initial, "overflow must neither install nor disconnect observers");
  assert.deepEqual(evidence.afterRejected, evidence.before);
  assert.ok(evidence.afterAccepted.semanticRevision > evidence.afterRejected.semanticRevision);
  assert.equal(evidence.afterAccepted.applicantStateEpoch, evidence.before.applicantStateEpoch);
  assert.equal(evidence.disposal, "DISPOSED");
  assert.equal(evidence.cleaned.active, 1);
  assert.equal(evidence.cleaned.disconnects, 2);
});

test("verification and disposal fail closed when another retained candidate still exceeds the root budget", async (context) => {
  for (const path of ["CURRENT refresh", "sticky verification", "changed graph verification", "candidate disposal"]) {
    await context.test(path, async () => {
      const evidence = await observationRootEvidence(`
        addRoots(1204);
        const first = capability.extract();
        const second = capability.extract();
        addRoots(1);
        ${path === "sticky verification" ? 'const input = document.querySelector("input"); input.remove(); document.getElementById("root-form").append(input);' : ""}
        ${path === "changed graph verification" ? 'document.querySelector("input").setAttribute("aria-label", "Changed question");' : ""}
        const result = ${path === "candidate disposal"
          ? "capability.disposeCandidate({ candidateId: first.candidateId })"
          : "capability.verifyCandidate({ candidateId: first.candidateId }).status"};
        const cleaned = counts();
        const secondStatus = capability.verifyCandidate({ candidateId: second.candidateId }).status;
        capability.dispose();
        return { kinds: [first.kind, second.kind], result, cleaned, secondStatus, disposed: counts() };
      `);
      assert.deepEqual(evidence.kinds, ["OK", "OK"]);
      assert.equal(evidence.result, path === "candidate disposal" ? "DISPOSED" : "INVALID");
      assert.equal(evidence.secondStatus, "INVALID");
      assert.equal(evidence.cleaned.created, 1205, "overflow refresh must install no new observer");
      assert.equal(evidence.cleaned.active, 1);
      assert.equal(evidence.cleaned.disconnects, 1204);
      assert.equal(evidence.disposed.active, 0);
      assert.equal(evidence.disposed.disconnects, 1205);
    });
  }
});

test("external semantic removals advance the fence through callback and immediate snapshot/verify drains", async (context) => {
  for (const scenario of externalSemanticCases) {
    for (const delivery of ["callback", "snapshot drain", "verify drain"] as const) {
      await context.test(`${scenario.name}: ${delivery}`, async () => {
        const fixture = await protectedFixture(`<!doctype html><body>
          <aside><div>${scenario.dependency}</div></aside>
          <form><input id="answer" ${scenario.attribute}></form>
        </body>`);
        try {
          if (delivery === "callback") {
            const extraction = await fixture.session.extractApplicationForm();
            const before = await fixture.session.snapshot();
            // A later task ensures the real MutationObserver callback has run.
            await fixture.page.evaluate(`(() => {
              const dependency = document.getElementById("dependency");
              ${scenario.mutation}
              return new Promise(resolve => setTimeout(resolve, 0));
            })()`);
            const after = await fixture.session.snapshot();
            const verification = await fixture.session.verifyCandidate(extraction.candidate);
            assert.equal(verification.status, scenario.status);
            assert.ok(after.semanticRevision > before.semanticRevision, "callback must advance semanticRevision");
            assert.equal(after.applicantStateEpoch, before.applicantStateEpoch);
            if ("removeAfterCurrent" in scenario) {
              await fixture.page.evaluate(() => {
                document.getElementById("dependency")!.remove();
                return new Promise<void>((resolve) => setTimeout(resolve, 0));
              });
              const afterRemoval = await fixture.session.snapshot();
              assert.equal((await fixture.session.verifyCandidate(extraction.candidate)).status, "INVALID");
              assert.ok(afterRemoval.semanticRevision > after.semanticRevision, "accepted replacement removal callback must advance semanticRevision");
              assert.equal(afterRemoval.applicantStateEpoch, before.applicantStateEpoch);
            }
            await extraction.dispose();
          } else {
            // Test-owned isolated-world execution keeps mutation and the protected
            // read in one synchronous stack, before any observer callback can run.
            const cdp = await fixture.context.newCDPSession(fixture.page);
            try {
              const { frameTree } = await cdp.send("Page.getFrameTree");
              const { executionContextId } = await cdp.send("Page.createIsolatedWorld", {
                frameId: frameTree.frame.id,
                worldName: "task-5-pending-record-regression"
              });
              await cdp.send("Runtime.evaluate", {
                contextId: executionContextId,
                expression: protectedBrowserWorldBootstrapSource()
              });
              const result = await cdp.send("Runtime.evaluate", {
                contextId: executionContextId,
                returnByValue: true,
                expression: `(() => {
                  const capability = globalThis[${JSON.stringify(PROTECTED_BROWSER_CAPABILITY_PROPERTY)}];
                  const extraction = capability.extract();
                  const before = capability.snapshot();
                  const dependency = document.getElementById("dependency");
                  ${scenario.mutation}
                  ${delivery === "snapshot drain" ? "const after = capability.snapshot();" : ""}
                  const verification = capability.verifyCandidate({ candidateId: extraction.candidateId });
                  ${delivery === "verify drain" ? "const after = capability.snapshot();" : ""}
                  let removal = null;
                  ${"removeAfterCurrent" in scenario ? `
                    document.getElementById("dependency").remove();
                    ${delivery === "snapshot drain" ? "const afterRemoval = capability.snapshot();" : ""}
                    const removalVerification = capability.verifyCandidate({ candidateId: extraction.candidateId });
                    ${delivery === "verify drain" ? "const afterRemoval = capability.snapshot();" : ""}
                    removal = { fence: afterRemoval, status: removalVerification.status };
                  ` : ""}
                  capability.dispose();
                  return { kind: extraction.kind, before, after, status: verification.status, removal };
                })()`
              });
              assert.equal(result.exceptionDetails, undefined);
              const evidence = result.result.value;
              assert.equal(evidence.kind, "OK");
              assert.equal(evidence.status, scenario.status);
              assert.ok(evidence.after.semanticRevision > evidence.before.semanticRevision, `${delivery} must advance semanticRevision`);
              assert.equal(evidence.after.applicantStateEpoch, evidence.before.applicantStateEpoch);
              if ("removeAfterCurrent" in scenario) {
                assert.equal(evidence.removal.status, "INVALID");
                assert.ok(evidence.removal.fence.semanticRevision > evidence.after.semanticRevision, `accepted replacement removal ${delivery} must advance semanticRevision`);
                assert.equal(evidence.removal.fence.applicantStateEpoch, evidence.before.applicantStateEpoch);
              }
            } finally {
              await cdp.detach();
            }
          }
        } finally {
          await closeFixture(fixture);
        }
      });
    }
  }
});

test("new external semantic dependencies advance the fence through callback and an already-waiting waiter", async (context) => {
  for (const scenario of introducedSemanticCases) {
    for (const delivery of ["callback", "already-waiting waiter"] as const) {
      await context.test(`${scenario.name}: ${delivery}`, async () => {
        const fixture = await protectedFixture(scenario.html);
        try {
          const extraction = await fixture.session.extractApplicationForm();
          const initialField = extraction.report.forms[0]?.sections[0]?.fields[0];
          assert.equal(initialField?.question, scenario.initialQuestion);
          assert.equal(initialField?.helpText, scenario.initialHelpText);
          const firstVerification = await fixture.session.verifyCandidate(extraction.candidate);
          assert.equal(firstVerification.status, "CURRENT");
          if (firstVerification.status !== "CURRENT") assert.fail("candidate must begin current");
          const before = firstVerification.fence;

          let after;
          if (delivery === "already-waiting waiter") {
            const waiting = fixture.session.waitForChange(before, 500);
            await fixture.page.evaluate(`(() => { ${scenario.mutation} })()`);
            after = await waiting;
          } else {
            await fixture.page.evaluate(`(() => {
              ${scenario.mutation}
              return new Promise(resolve => setTimeout(resolve, 0));
            })()`);
            after = await fixture.session.snapshot();
          }

          assert.ok(
            after.semanticRevision > before.semanticRevision,
            `${scenario.name} ${delivery} must advance semanticRevision: ${before.semanticRevision} -> ${after.semanticRevision}`
          );
          assert.equal(after.applicantStateEpoch, before.applicantStateEpoch);
          assert.equal((await fixture.session.verifyCandidate(extraction.candidate)).status, "INVALID");

          const fresh = await fixture.session.extractApplicationForm();
          const currentField = fresh.report.forms[0]?.sections[0]?.fields[0];
          assert.equal(currentField?.question, scenario.currentQuestion);
          assert.equal(currentField?.helpText, scenario.currentHelpText);
          await extraction.dispose();
          await fresh.dispose();
        } finally {
          await closeFixture(fixture);
        }
      });
    }
  }
});

test("new external semantic dependencies advance the fence through immediate snapshot and verification drains", async (context) => {
  for (const scenario of introducedSemanticCases) {
    for (const delivery of ["snapshot drain", "verification drain"] as const) {
      await context.test(`${scenario.name}: ${delivery}`, async () => {
        const evidence = await isolatedProtectedWorldEvidence(scenario.html, `
          const capability = globalThis[${JSON.stringify(PROTECTED_BROWSER_CAPABILITY_PROPERTY)}];
          const extraction = capability.extract();
          const firstVerification = capability.verifyCandidate({ candidateId: extraction.candidateId });
          const before = firstVerification.fence;
          ${scenario.mutation}
          ${delivery === "snapshot drain" ? "const after = capability.snapshot();" : ""}
          const verification = capability.verifyCandidate({ candidateId: extraction.candidateId });
          ${delivery === "verification drain" ? "const after = capability.snapshot();" : ""}
          const fresh = capability.extract();
          capability.dispose();
          return {
            extractionKind: extraction.kind,
            initialReport: extraction.report,
            firstStatus: firstVerification.status,
            before,
            after,
            status: verification.status,
            freshKind: fresh.kind,
            freshReport: fresh.report
          };
        `) as {
          extractionKind: string;
          initialReport: ApplicationFormInspectionReport;
          firstStatus: string;
          before: { semanticRevision: number; applicantStateEpoch: number };
          after: { semanticRevision: number; applicantStateEpoch: number };
          status: string;
          freshKind: string;
          freshReport: ApplicationFormInspectionReport;
        };
        assert.equal(evidence.extractionKind, "OK");
        assert.equal(evidence.firstStatus, "CURRENT");
        assert.equal(evidence.initialReport.forms[0]?.sections[0]?.fields[0]?.question, scenario.initialQuestion);
        assert.equal(evidence.initialReport.forms[0]?.sections[0]?.fields[0]?.helpText, scenario.initialHelpText);
        assert.ok(
          evidence.after.semanticRevision > evidence.before.semanticRevision,
          `${scenario.name} ${delivery} must advance semanticRevision: ${evidence.before.semanticRevision} -> ${evidence.after.semanticRevision}`
        );
        assert.equal(evidence.after.applicantStateEpoch, evidence.before.applicantStateEpoch);
        assert.equal(evidence.status, "INVALID");
        assert.equal(evidence.freshKind, "OK");
        assert.equal(evidence.freshReport.forms[0]?.sections[0]?.fields[0]?.question, scenario.currentQuestion);
        assert.equal(evidence.freshReport.forms[0]?.sections[0]?.fields[0]?.helpText, scenario.currentHelpText);
      });
    }
  }
});

test("new semantic dependencies nested inside added subtrees advance the fence", async (context) => {
  for (const scenario of introducedSemanticCases) {
    if (scenario.subtreeMutation === null) continue;
    for (const delivery of ["callback", "snapshot drain"] as const) {
      await context.test(`${scenario.name}: ${delivery}`, async () => {
        if (delivery === "callback") {
          const fixture = await protectedFixture(scenario.html);
          try {
            const extraction = await fixture.session.extractApplicationForm();
            const firstVerification = await fixture.session.verifyCandidate(extraction.candidate);
            assert.equal(firstVerification.status, "CURRENT");
            if (firstVerification.status !== "CURRENT") assert.fail("candidate must begin current");
            await fixture.page.evaluate(`(() => {
              ${scenario.subtreeMutation}
              return new Promise(resolve => setTimeout(resolve, 0));
            })()`);
            const after = await fixture.session.snapshot();
            assert.ok(
              after.semanticRevision > firstVerification.fence.semanticRevision,
              `${scenario.name} subtree callback must advance semanticRevision: ${firstVerification.fence.semanticRevision} -> ${after.semanticRevision}`
            );
            assert.equal((await fixture.session.verifyCandidate(extraction.candidate)).status, "INVALID");
            const fresh = await fixture.session.extractApplicationForm();
            assert.equal(fresh.report.forms[0]?.sections[0]?.fields[0]?.question, scenario.currentQuestion);
            assert.equal(fresh.report.forms[0]?.sections[0]?.fields[0]?.helpText, scenario.currentHelpText);
            await extraction.dispose();
            await fresh.dispose();
          } finally {
            await closeFixture(fixture);
          }
        } else {
          const evidence = await isolatedProtectedWorldEvidence(scenario.html, `
            const capability = globalThis[${JSON.stringify(PROTECTED_BROWSER_CAPABILITY_PROPERTY)}];
            const extraction = capability.extract();
            const firstVerification = capability.verifyCandidate({ candidateId: extraction.candidateId });
            ${scenario.subtreeMutation}
            const after = capability.snapshot();
            const verification = capability.verifyCandidate({ candidateId: extraction.candidateId });
            const fresh = capability.extract();
            capability.dispose();
            return {
              before: firstVerification.fence,
              after,
              status: verification.status,
              freshKind: fresh.kind,
              freshReport: fresh.report
            };
          `) as {
            before: { semanticRevision: number; applicantStateEpoch: number };
            after: { semanticRevision: number; applicantStateEpoch: number };
            status: string;
            freshKind: string;
            freshReport: ApplicationFormInspectionReport;
          };
          assert.ok(
            evidence.after.semanticRevision > evidence.before.semanticRevision,
            `${scenario.name} subtree snapshot drain must advance semanticRevision: ${evidence.before.semanticRevision} -> ${evidence.after.semanticRevision}`
          );
          assert.equal(evidence.status, "INVALID");
          assert.equal(evidence.freshKind, "OK");
          assert.equal(evidence.freshReport.forms[0]?.sections[0]?.fields[0]?.question, scenario.currentQuestion);
          assert.equal(evidence.freshReport.forms[0]?.sections[0]?.fields[0]?.helpText, scenario.currentHelpText);
        }
      });
    }
  }
});

test("equivalent attribute introductions of tracked semantic dependencies advance the fence", async (context) => {
  const cases = [
    {
      name: "unresolved ARIA target gains its tracked ID",
      html: '<!doctype html><body><aside><div id="pending-target">New ARIA label</div></aside><form><input aria-labelledby="future-label" aria-label="Fallback question"></form></body>',
      mutation: 'document.getElementById("pending-target").id = "future-label";',
      question: "New ARIA label"
    },
    {
      name: "native label gains association to retained control",
      html: '<!doctype html><body><aside><label id="pending-label">New native label</label></aside><form><input id="answer" aria-label="Fallback question"></form></body>',
      mutation: 'document.getElementById("pending-label").setAttribute("for", "answer");',
      question: "New native label"
    }
  ] as const;
  for (const scenario of cases) {
    await context.test(scenario.name, async () => {
      const fixture = await protectedFixture(scenario.html);
      try {
        const extraction = await fixture.session.extractApplicationForm();
        const firstVerification = await fixture.session.verifyCandidate(extraction.candidate);
        assert.equal(firstVerification.status, "CURRENT");
        if (firstVerification.status !== "CURRENT") assert.fail("candidate must begin current");
        await fixture.page.evaluate(`(() => {
          ${scenario.mutation}
          return new Promise(resolve => setTimeout(resolve, 0));
        })()`);
        const after = await fixture.session.snapshot();
        assert.ok(
          after.semanticRevision > firstVerification.fence.semanticRevision,
          `${scenario.name} must advance semanticRevision: ${firstVerification.fence.semanticRevision} -> ${after.semanticRevision}`
        );
        assert.equal((await fixture.session.verifyCandidate(extraction.candidate)).status, "INVALID");
        const fresh = await fixture.session.extractApplicationForm();
        assert.equal(fresh.report.forms[0]?.sections[0]?.fields[0]?.question, scenario.question);
        await extraction.dispose();
        await fresh.dispose();
      } finally {
        await closeFixture(fixture);
      }
    });
  }
});

test("oversized implicit native labels exhaust work before the native control lookup", async () => {
  const evidence = await isolatedProtectedWorldEvidence(`<!doctype html><body>
    <aside><label id="hostile-label" for="unrelated-control"></label></aside>
    <form aria-label="Application"><input aria-label="Question"></form>
  </body>`, `
    const capability = globalThis[${JSON.stringify(PROTECTED_BROWSER_CAPABILITY_PROPERTY)}];
    const label = document.getElementById("hostile-label");
    const descriptor = Object.getOwnPropertyDescriptor(HTMLLabelElement.prototype, "control");
    const nativeControl = descriptor.get;
    let hostileLookupCalls = 0;
    Object.defineProperty(HTMLLabelElement.prototype, "control", {
      ...descriptor,
      get() {
        if (this === label) hostileLookupCalls += 1;
        return Reflect.apply(nativeControl, this, []);
      }
    });
    const extraction = capability.extract();
    const before = capability.snapshot();
    const callsBeforeMutation = hostileLookupCalls;
    label.removeAttribute("for");
    const fragment = document.createDocumentFragment();
    for (let index = 0; index < 140_000; index += 1) {
      fragment.append(document.createElement("span"));
    }
    label.append(fragment);
    const after = capability.snapshot();
    const callsAfterDrain = hostileLookupCalls;
    const status = capability.verifyCandidate({ candidateId: extraction.candidateId }).status;
    return {
      kind: extraction.kind,
      before,
      after,
      callsBeforeMutation,
      callsAfterDrain,
      status
    };
  `) as {
    kind: string;
    before: { semanticRevision: number; applicantStateEpoch: number };
    after: { semanticRevision: number; applicantStateEpoch: number };
    callsBeforeMutation: number;
    callsAfterDrain: number;
    status: string;
  };
  assert.equal(evidence.kind, "OK");
  assert.ok(evidence.callsBeforeMutation > 0, "the fixture must exercise the real explicit-label lookup first");
  assert.equal(
    evidence.callsAfterDrain,
    evidence.callsBeforeMutation,
    "the native implicit-label lookup must not run after its metered traversal exhausts the budget"
  );
  assert.ok(evidence.after.semanticRevision > evidence.before.semanticRevision);
  assert.equal(evidence.after.applicantStateEpoch, evidence.before.applicantStateEpoch);
  assert.equal(evidence.status, "INVALID");
});

test("native label inventories are metered without invoking control.labels", async () => {
  const evidence = await isolatedProtectedWorldEvidence(`<!doctype html><body>
    <aside id="hostile-labels"></aside>
    <form aria-label="Application"><input aria-label="Question"></form>
    <script>
      let parent = document.getElementById("hostile-labels");
      for (let index = 0; index < 400; index += 1) {
        const label = document.createElement("label");
        parent.append(label);
        parent = label;
      }
      const leaves = document.createDocumentFragment();
      for (let index = 0; index < 12_000; index += 1) {
        leaves.append(document.createElement("span"));
      }
      parent.append(leaves);
    </script>
  </body>`, `
    const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "labels");
    const nativeLabels = descriptor.get;
    let labelsGetterCalls = 0;
    Object.defineProperty(HTMLInputElement.prototype, "labels", {
      ...descriptor,
      get() {
        labelsGetterCalls += 1;
        return Reflect.apply(nativeLabels, this, []);
      }
    });
    const capability = globalThis[${JSON.stringify(PROTECTED_BROWSER_CAPABILITY_PROPERTY)}];
    const result = capability.extract();
    const status = result.kind === "OK"
      ? capability.verifyCandidate({ candidateId: result.candidateId }).status
      : null;
    return { result, status, labelsGetterCalls };
  `) as {
    result: { kind: string; code?: string };
    status: string | null;
    labelsGetterCalls: number;
  };
  assert.equal(evidence.result.kind, "OK");
  assert.equal(evidence.status, "CURRENT");
  assert.equal(evidence.labelsGetterCalls, 0, "native label inventory must use only explicitly metered discovery");
});

test("unrelated external IDs and labels do not advance the semantic fence", async (context) => {
  const html = '<!doctype html><body><aside id="outside"></aside><form><input id="answer" aria-labelledby="future-label" aria-label="Fallback question"></form></body>';
  const mutation = `
    const wrapper = document.createElement("section");
    wrapper.innerHTML = '<div id="unrelated-id"><label for="other-control">Unrelated label</label></div>';
    document.getElementById("outside").append(wrapper);
  `;
  for (const delivery of ["callback", "snapshot drain"] as const) {
    await context.test(delivery, async () => {
      if (delivery === "callback") {
        const fixture = await protectedFixture(html);
        try {
          const extraction = await fixture.session.extractApplicationForm();
          const firstVerification = await fixture.session.verifyCandidate(extraction.candidate);
          assert.equal(firstVerification.status, "CURRENT");
          if (firstVerification.status !== "CURRENT") assert.fail("candidate must begin current");
          await fixture.page.evaluate(`(() => {
            ${mutation}
            return new Promise(resolve => setTimeout(resolve, 0));
          })()`);
          assert.deepEqual(await fixture.session.snapshot(), firstVerification.fence);
          assert.equal((await fixture.session.verifyCandidate(extraction.candidate)).status, "CURRENT");
          await extraction.dispose();
        } finally {
          await closeFixture(fixture);
        }
      } else {
        const evidence = await isolatedProtectedWorldEvidence(html, `
          const capability = globalThis[${JSON.stringify(PROTECTED_BROWSER_CAPABILITY_PROPERTY)}];
          const extraction = capability.extract();
          const firstVerification = capability.verifyCandidate({ candidateId: extraction.candidateId });
          ${mutation}
          const after = capability.snapshot();
          const verification = capability.verifyCandidate({ candidateId: extraction.candidateId });
          capability.dispose();
          return { before: firstVerification.fence, after, status: verification.status };
        `) as {
          before: { semanticRevision: number; applicantStateEpoch: number };
          after: { semanticRevision: number; applicantStateEpoch: number };
          status: string;
        };
        assert.deepEqual(evidence.after, evidence.before);
        assert.equal(evidence.status, "CURRENT");
      }
    });
  }
});

test("protected extraction matches the existing report and normalized fingerprints while exposing only opaque slot refs", async () => {
  const fixture = await protectedFixture(nativeApplicationFixture());
  try {
    const protectedExtraction = await fixture.session.extractApplicationForm();
    const existingExtraction = await extractSafeApplicationForm(fixture.page);
    const report = applicationFormInspectionReportSchema.parse(
      protectedExtraction.report as ApplicationFormInspectionReport
    );
    assert.deepEqual(report, existingExtraction.report);
    assert.deepEqual(
      buildNormalizedApplicationFormInspection({
        authoritativeApplyHost: "fixture.example.test",
        report
      }),
      buildNormalizedApplicationFormInspection({
        authoritativeApplyHost: "fixture.example.test",
        report: existingExtraction.report
      })
    );

    assertEmptyOpaqueReference(protectedExtraction.candidate);
    const fields = protectedExtraction.fields as readonly OpaqueFieldSlot[];
    assert.equal(fields.length, existingExtraction.fields.length);
    for (const [fieldIndex, field] of fields.entries()) {
      assert.deepEqual(field.sourceOrdinal, existingExtraction.fields[fieldIndex].sourceOrdinal);
      assertEmptyOpaqueReference(field.reference);
      assert.deepEqual(
        field.choices.map((choice) => choice.sourceOrdinal),
        existingExtraction.fields[fieldIndex].choices.map((choice) => choice.sourceOrdinal)
      );
      for (const choice of field.choices) assertEmptyOpaqueReference(choice.reference);
    }
    const serialized = JSON.stringify(protectedExtraction);
    assert.equal(serialized.includes("objectId"), false);
    assert.equal(serialized.includes("backendNodeId"), false);
    assert.equal(serialized.includes("selector"), false);

    await existingExtraction.dispose();
    await protectedExtraction.dispose();
    await protectedExtraction.dispose();
  } finally {
    await closeFixture(fixture);
  }
});

test("hostile main-world globals and poisoned prototypes cannot observe or alter protected extraction", async () => {
  const hostile = `<script>
    (() => {
      const evidence = window.__protectedHostileEvidence = {
        customEvents: 0,
        inheritedWrites: 0,
        evalSawProtected: window.eval('Object.prototype.hasOwnProperty.call(globalThis, ${JSON.stringify(PROTECTED_BROWSER_CAPABILITY_PROPERTY)})'),
        jsonCopy: JSON.parse('{"candidateId":1}')
      };
      Object.defineProperty(globalThis, ${JSON.stringify(PROTECTED_BROWSER_CAPABILITY_PROPERTY)}, {
        configurable: true,
        enumerable: true,
        value: Object.freeze({ handshake: () => ({ version: 999, state: 'HOSTILE', methods: [] }) })
      });
      document.addEventListener('apply-pilot', () => { evidence.customEvents += 1; }, true);
      for (const key of ['candidateId', 'report', 'sourceOrdinal', 'reference']) {
        Object.defineProperty(Object.prototype, key, {
          configurable: true,
          get() { evidence.inheritedWrites += 1; throw new Error('hostile inherited getter'); },
          set() { evidence.inheritedWrites += 1; }
        });
      }
      const fail = () => { throw new Error('hostile main-world prototype'); };
      Array.prototype.map = fail;
      Array.prototype.some = fail;
      Array.prototype.every = fail;
      JSON.parse = fail;
      window.Event = fail;
      EventTarget.prototype.addEventListener = fail;
      EventTarget.prototype.removeEventListener = fail;
      EventTarget.prototype.dispatchEvent = fail;
      MutationObserver.prototype.observe = fail;
      MutationObserver.prototype.takeRecords = fail;
      MutationObserver.prototype.disconnect = fail;
      Element.prototype.matches = fail;
      Element.prototype.closest = fail;
      Node.prototype.contains = fail;
    })();
  </script>`;
  const fixture = await protectedFixture(
    nativeApplicationFixture().replace("<body>", `<body>${hostile}`)
  );
  try {
    const extraction = await fixture.session.extractApplicationForm();
    const report = applicationFormInspectionReportSchema.parse(
      extraction.report as ApplicationFormInspectionReport
    );
    assert.equal(report.forms[0].title, "Candidate application");
    const evidence = await fixture.page.evaluate((property) => {
      Reflect.deleteProperty(globalThis, property);
      let isolatedCapabilityVisible = false;
      for (const key of Reflect.ownKeys(globalThis)) {
        if (key === property) isolatedCapabilityVisible = true;
      }
      return {
      customEvents: (window as unknown as { __protectedHostileEvidence: { customEvents: number } })
        .__protectedHostileEvidence.customEvents,
      inheritedWrites: (window as unknown as { __protectedHostileEvidence: { inheritedWrites: number } })
        .__protectedHostileEvidence.inheritedWrites,
      evalSawProtected: (window as unknown as { __protectedHostileEvidence: { evalSawProtected: boolean } })
        .__protectedHostileEvidence.evalSawProtected,
      jsonCopyCandidateId: (window as unknown as { __protectedHostileEvidence: { jsonCopy: { candidateId: number } } })
        .__protectedHostileEvidence.jsonCopy.candidateId,
      isolatedCapabilityVisible
    };
    }, PROTECTED_BROWSER_CAPABILITY_PROPERTY);
    assert.deepEqual(evidence, {
      customEvents: 0,
      inheritedWrites: 0,
      evalSawProtected: false,
      jsonCopyCandidateId: 1,
      isolatedCapabilityVisible: false
    });
    await extraction.dispose();
  } finally {
    await closeFixture(fixture);
  }
});

test("protected extraction exports no current values and causes no employer-page mutation or event", async () => {
  const trapScript = `<script>
    (() => {
      // Main-world observers cover shared-DOM effects, not isolated-world reads.
      const counts = window.__protectedPrivacy = {
        mutations: 0, events: 0
      };
      for (const type of ['click', 'keydown', 'beforeinput', 'input', 'change', 'submit', 'formdata']) {
        document.addEventListener(type, () => { counts.events += 1; }, true);
      }
      new MutationObserver((records) => { counts.mutations += records.length; })
        .observe(document.documentElement, { attributes: true, childList: true, characterData: true, subtree: true });
    })();
  </script>`;
  const fixture = await protectedFixture(privacyFixture().replace("</body>", `${trapScript}</body>`));
  try {
    const extraction = await fixture.session.extractApplicationForm();
    const serialized = JSON.stringify(extraction.report);
    for (const secret of [
      SECRET_HIDDEN_VALUE,
      SECRET_PASSWORD_VALUE,
      SECRET_OPTION_VALUE,
      "SECRET-TEXT-CURRENT-VALUE",
      "SECRET-TEXTAREA-CURRENT-VALUE"
    ]) assert.equal(serialized.includes(secret), false);
    assert.equal(serialized.includes(PROMPT_LIKE_EMPLOYER_TEXT), true);
    assert.deepEqual(await fixture.page.evaluate(() =>
      (window as unknown as { __protectedPrivacy: Record<string, number> }).__protectedPrivacy
    ), {
      mutations: 0,
      events: 0
    });
    await extraction.dispose();
  } finally {
    await closeFixture(fixture);
  }
});

test("protected semantic metadata excludes role-based applicant current text", async (context) => {
  const applicantText = "SECRET-ROLE-BASED-APPLICANT-CONTENT";
  const cases = [
    {
      name: "standalone searchbox role",
      html: `<!doctype html><html><body>
        <div id="semantic-source" role="searchbox"></div>
        <form aria-label="Application"><input aria-labelledby="semantic-source"></form>
      </body></html>`,
      valueId: "semantic-source",
      eventTargetId: "semantic-source",
      question: null,
      helpText: null
    },
    {
      name: "mixed-case whitespace searchbox role token",
      html: `<!doctype html><html><body>
        <div id="semantic-source" role="  PrEsEnTaTiOn\t SeArChBoX  "></div>
        <form aria-label="Application"><input aria-labelledby="semantic-source"></form>
      </body></html>`,
      valueId: "semantic-source",
      eventTargetId: "semantic-source",
      question: null,
      helpText: null
    },
    {
      name: "direct aria-labelledby role textbox populated after load",
      html: `<!doctype html><html><body>
        <div id="semantic-source" role="textbox"></div>
        <form aria-label="Application"><input aria-labelledby="semantic-source"></form>
      </body></html>`,
      valueId: "semantic-source",
      eventTargetId: null,
      question: null,
      helpText: null
    },
    {
      name: "multi-token aria role containing textbox",
      html: `<!doctype html><html><body>
        <div id="semantic-source" role="textbox searchbox"></div>
        <form aria-label="Application"><input aria-labelledby="semantic-source"></form>
      </body></html>`,
      valueId: "semantic-source",
      eventTargetId: "semantic-source",
      question: null,
      helpText: null
    },
    {
      name: "static semantic text with nested searchbox current content",
      html: `<!doctype html><html><body>
        <div id="semantic-source">Static prompt <span id="applicant-value" role="searchbox"></span></div>
        <form aria-label="Application"><input aria-labelledby="semantic-source"></form>
      </body></html>`,
      valueId: "applicant-value",
      eventTargetId: "applicant-value",
      question: "Static prompt",
      helpText: null
    },
    {
      name: "slotted light-DOM current text under a shadow textbox",
      html: `<!doctype html><html><body>
        <x-semantic-source id="semantic-source"><span id="applicant-value" slot="answer"></span></x-semantic-source>
        <form aria-label="Application"><input aria-labelledby="semantic-source"></form>
        <script>
          const root = document.getElementById("semantic-source").attachShadow({ mode: "open" });
          root.innerHTML = '<div role="textbox"><slot name="answer"></slot></div>';
        </script>
      </body></html>`,
      valueId: "applicant-value",
      eventTargetId: "applicant-value",
      question: null,
      helpText: null
    },
    {
      name: "slotted light-DOM text with an inaccessible closed-shadow composition",
      html: `<!doctype html><html><body>
        <x-closed-semantic id="semantic-source"><span id="applicant-value"></span></x-closed-semantic>
        <form aria-label="Application"><input aria-labelledby="semantic-source"></form>
        <script>
          customElements.define("x-closed-semantic", class extends HTMLElement {
            constructor() {
              super();
              this.attachShadow({ mode: "closed" }).innerHTML = '<div role="textbox"><slot></slot></div>';
            }
          });
        </script>
      </body></html>`,
      valueId: "applicant-value",
      eventTargetId: "semantic-source",
      question: null,
      helpText: null
    },
    {
      name: "shadow host carrying an editable searchbox role",
      html: `<!doctype html><html><body>
        <x-semantic-source id="semantic-source" role="searchbox"><span id="applicant-value"></span></x-semantic-source>
        <form aria-label="Application"><input aria-labelledby="semantic-source"></form>
        <script>document.getElementById("semantic-source").attachShadow({ mode: "open" }).innerHTML = '<slot></slot>';</script>
      </body></html>`,
      valueId: "applicant-value",
      eventTargetId: "semantic-source",
      question: null,
      helpText: null
    },
    {
      name: "nested aria-labelledby role textbox with bubbling input",
      html: `<!doctype html><html><body>
        <div id="semantic-source" role="textbox"><span id="applicant-value"></span></div>
        <form aria-label="Application"><input aria-labelledby="semantic-source"></form>
      </body></html>`,
      valueId: "applicant-value",
      eventTargetId: "semantic-source",
      question: null,
      helpText: null
    },
    {
      name: "aria-describedby role textbox",
      html: `<!doctype html><html><body>
        <div id="semantic-source" role="textbox"><span id="applicant-value"></span></div>
        <form aria-label="Application">
          <input aria-label="Static question" aria-describedby="semantic-source">
        </form>
      </body></html>`,
      valueId: "applicant-value",
      eventTargetId: "semantic-source",
      question: "Static question",
      helpText: null
    },
    {
      name: "external native label with nested role textbox",
      html: `<!doctype html><html><body>
        <label for="answer">Static external label <span id="editor" role="textbox"><span id="applicant-value"></span></span></label>
        <form aria-label="Application"><input id="answer"></form>
      </body></html>`,
      valueId: "applicant-value",
      eventTargetId: "editor",
      question: "Static external label",
      helpText: null
    },
    {
      name: "represented combobox semantic source",
      html: `<!doctype html><html><body>
        <div id="semantic-source" role="combobox"><span id="applicant-value"></span></div>
        <form aria-label="Application"><input aria-labelledby="semantic-source"></form>
      </body></html>`,
      valueId: "applicant-value",
      eventTargetId: "semantic-source",
      question: null,
      helpText: null
    },
    {
      name: "direct contenteditable semantic source",
      html: `<!doctype html><html><body>
        <div id="semantic-source" contenteditable="true"></div>
        <form aria-label="Application"><input aria-labelledby="semantic-source"></form>
      </body></html>`,
      valueId: "semantic-source",
      eventTargetId: "semantic-source",
      question: null,
      helpText: null
    },
    {
      name: "inherited contenteditable semantic source",
      html: `<!doctype html><html><body>
        <div contenteditable="true"><span id="semantic-source"><span id="applicant-value"></span></span></div>
        <form aria-label="Application"><input aria-labelledby="semantic-source"></form>
      </body></html>`,
      valueId: "applicant-value",
      eventTargetId: "semantic-source",
      question: null,
      helpText: null
    }
  ] as const;

  for (const scenario of cases) {
    await context.test(scenario.name, async () => {
      const fixture = await protectedFixture(scenario.html);
      try {
        await fixture.page.evaluate(({ eventTargetId, applicantText, valueId }) => {
          const value = document.getElementById(valueId);
          if (!value) throw new Error("missing applicant value surface");
          value.textContent = applicantText;
          if (eventTargetId) {
            const eventTarget = document.getElementById(eventTargetId);
            if (!eventTarget) throw new Error("missing applicant input event target");
            eventTarget.dispatchEvent(new Event("input", { bubbles: true }));
          }
        }, { eventTargetId: scenario.eventTargetId, applicantText, valueId: scenario.valueId });

        const extraction = await fixture.session.extractApplicationForm();
        const report = applicationFormInspectionReportSchema.parse(extraction.report);
        const field = report.forms[0]?.sections[0]?.fields[0];
        assert.ok(field);
        assert.equal(field.question, scenario.question);
        assert.equal(field.helpText, scenario.helpText);
        assert.equal(JSON.stringify(report).includes(applicantText), false, "report must exclude applicant current text");
        assert.equal(JSON.stringify(buildNormalizedApplicationFormInspection({
          authoritativeApplyHost: "fixture.example.test",
          report
        })).includes(applicantText), false, "normalized metadata must exclude applicant current text");
        await extraction.dispose();
      } finally {
        await closeFixture(fixture);
      }
    });
  }
});

test("protected semantic metadata excludes bare text assigned directly to a shadow textbox slot", async () => {
  const applicantText = "SECRET-BARE-SLOTTED-APPLICANT-CONTENT";
  const fixture = await protectedFixture(`<!doctype html><html><body>
    <x-semantic-source id="semantic-source">${applicantText}</x-semantic-source>
    <form aria-label="Application"><input aria-labelledby="semantic-source"></form>
    <script>
      const root = document.getElementById("semantic-source").attachShadow({ mode: "open" });
      root.innerHTML = '<div role="textbox"><slot></slot></div>';
    </script>
  </body></html>`);
  try {
    const extraction = await fixture.session.extractApplicationForm();
    const report = applicationFormInspectionReportSchema.parse(extraction.report);
    assert.equal(report.forms[0]?.sections[0]?.fields[0]?.question, null);
    assert.equal(JSON.stringify(report).includes(applicantText), false);
    assert.equal((await fixture.session.verifyCandidate(extraction.candidate)).status, "CURRENT");
    await extraction.dispose();
  } finally {
    await closeFixture(fixture);
  }
});

test("protected text filtering preserves native option labels and ordinary static metadata", async () => {
  const fixture = await protectedFixture(`<!doctype html><html><body>
    <h1 id="form-title">Static form title</h1>
    <span id="aria-question">Static ARIA question</span>
    <span id="aria-help">Static ARIA help</span>
    <form aria-labelledby="form-title">
      <fieldset>
        <legend>Static section heading</legend>
        <label for="native-label">Static native label</label><input id="native-label">
        <input aria-labelledby="aria-question">
        <input aria-label="Static described question" aria-describedby="aria-help">
        <label for="choice">Static choice question</label>
        <select id="choice" role="combobox"><option value="private-current-value">Static option display label</option></select>
      </fieldset>
    </form>
  </body></html>`);
  try {
    const extraction = await fixture.session.extractApplicationForm();
    const report = applicationFormInspectionReportSchema.parse(extraction.report);
    assert.equal(report.forms[0]?.title, "Static form title");
    assert.equal(report.forms[0]?.sections[0]?.heading, "Static section heading");
    assert.deepEqual(
      report.forms[0]?.sections[0]?.fields.map((field) => ({
        question: field.question,
        helpText: field.helpText,
        choices: field.choices.map((choice) => choice.label)
      })),
      [
        { question: "Static native label", helpText: null, choices: [] },
        { question: "Static ARIA question", helpText: null, choices: [] },
        { question: "Static described question", helpText: "Static ARIA help", choices: [] },
        { question: "Static choice question", helpText: null, choices: ["Static option display label"] }
      ]
    );
    await extraction.dispose();
  } finally {
    await closeFixture(fixture);
  }
});

test("SVG script and style text remain excluded from protected semantic metadata", async () => {
  const fixture = await protectedFixture(`<!doctype html><body>
    <span id="semantic-source"><svg>
      <style>/*SVG-STYLE-SENTINEL*/</style>
      <script>/*SVG-SCRIPT-SENTINEL*/</script>
      <text>Question</text>
    </svg></span>
    <form aria-label="Application"><input aria-labelledby="semantic-source"></form>
  </body>`);
  try {
    const extraction = await fixture.session.extractApplicationForm();
    assert.equal(extraction.report.forms[0]?.sections[0]?.fields[0]?.question, "Question");
    const serialized = JSON.stringify(extraction.report);
    assert.equal(serialized.includes("SVG-STYLE-SENTINEL"), false);
    assert.equal(serialized.includes("SVG-SCRIPT-SENTINEL"), false);
    await extraction.dispose();
  } finally {
    await closeFixture(fixture);
  }
});

test("protected extraction does not expose editable ancestor text through semantic references", async () => {
  const applicantText = "SECRET-EDITABLE-APPLICANT-CONTENT";
  const fixture = await protectedFixture(`<!doctype html><html><body>
    <div contenteditable="true" aria-label="Applicant notes"><span id="applicant-text">${applicantText}</span></div>
    <form aria-label="Editable privacy fixture"><input aria-labelledby="applicant-text"></form>
  </body></html>`);
  try {
    const extraction = await fixture.session.extractApplicationForm();
    assert.equal(JSON.stringify(extraction.report).includes(applicantText), false);
    await extraction.dispose();
  } finally {
    await closeFixture(fixture);
  }
});

test("multi-token interactive roles and conflicting recognized roles fail closed", async (context) => {
  for (const scenario of [
    {
      name: "recognized interactive role after a fallback token",
      role: "presentation button",
      attributes: ""
    },
    {
      name: "conflicting recognized interaction roles",
      role: "combobox button",
      attributes: ""
    },
    {
      name: "conflicting recognized roles on a rich-text surface",
      role: "textbox slider",
      attributes: 'contenteditable="true"'
    }
  ]) {
    await context.test(scenario.name, async () => {
      const fixture = await protectedFixture(`<!doctype html><body>
        <form aria-label="Application">
          <input aria-label="Native question">
          <div role="${scenario.role}" ${scenario.attributes} aria-label="Custom interaction"></div>
        </form>
      </body>`);
      try {
        await assertProtectedExtractionCode(fixture, "FORM_STRUCTURE_UNSUPPORTED");
      } finally {
        await closeFixture(fixture);
      }
    });
  }

  await context.test("conflicting roles on an ordinary action", async () => {
    const fixture = await protectedFixture(`<!doctype html><body>
      <form aria-label="Application">
        <input aria-label="Native question">
        <button type="button" role="button link">Conflicting action</button>
      </form>
    </body>`);
    try {
      await assertProtectedExtractionCode(fixture, "FORM_STRUCTURE_UNSUPPORTED");
    } finally {
      await closeFixture(fixture);
    }
  });
});

test("external form-associated custom elements fail closed before native-only enrollment", async (context) => {
  for (const scenario of [
    { name: "external FACE with native sibling", native: '<input aria-label="Native question">' },
    { name: "external FACE-only form", native: "" }
  ]) {
    await context.test(scenario.name, async () => {
      const fixture = await protectedFixture(`<!doctype html><body>
        <form id="application" aria-label="Application">${scenario.native}</form>
        <review-face form="application"></review-face>
        <script>
          customElements.define("review-face", class extends HTMLElement {
            static formAssociated = true;
            constructor() { super(); this.attachInternals(); }
          });
        </script>
      </body>`);
      try {
        await assertProtectedExtractionCode(fixture, "FORM_STRUCTURE_UNSUPPORTED");
      } finally {
        await closeFixture(fixture);
      }
    });
  }
});

test("custom-only supported controls produce schema-valid non-empty reports", async (context) => {
  for (const scenario of [
    {
      name: "supported rich-text control",
      control: '<div contenteditable="true" aria-label="Portfolio narrative"><p>PRIVATE-RICH-TEXT-CURRENT</p></div>',
      reason: "RICH_TEXT"
    },
    {
      name: "supported custom combobox",
      control: '<div role="combobox" aria-label="Preferred office"></div>',
      reason: "CUSTOM_COMBOBOX"
    }
  ] as const) {
    await context.test(scenario.name, async () => {
      const fixture = await protectedFixture(`<!doctype html><body>
        <form aria-label="Application">${scenario.control}</form>
      </body>`);
      try {
        const extraction = await fixture.session.extractApplicationForm();
        const report = applicationFormInspectionReportSchema.parse(extraction.report);
        assert.equal(report.forms.length, 1);
        assert.equal(report.forms[0]?.sections.length, 1);
        assert.equal(report.forms[0]?.sections[0]?.fields.length, 1);
        assert.equal(report.forms[0]?.sections[0]?.fields[0]?.fieldType, "UNSUPPORTED");
        assert.equal(report.forms[0]?.sections[0]?.fields[0]?.unsupportedReason, scenario.reason);
        assert.equal(JSON.stringify(report).includes("PRIVATE-RICH-TEXT-CURRENT"), false);
        await extraction.dispose();
      } finally {
        await closeFixture(fixture);
      }
    });
  }
});

test("represented forms enforce the four-form ceiling across native and custom enrollment", async (context) => {
  const customForm = (index: number) => `
    <form aria-label="Application ${index + 1}">
      <div contenteditable="true" aria-label="Narrative ${index + 1}"></div>
    </form>
  `;

  await context.test("exactly four custom-only forms", async () => {
    const fixture = await protectedFixture(`<!doctype html><body>
      ${Array.from({ length: MAX_FORMS }, (_, index) => customForm(index)).join("")}
    </body>`);
    try {
      const extraction = await fixture.session.extractApplicationForm();
      assert.equal(extraction.report.forms.length, MAX_FORMS);
      await extraction.dispose();
    } finally {
      await closeFixture(fixture);
    }
  });

  for (const scenario of [
    {
      name: "fifth custom-only form",
      forms: Array.from({ length: MAX_FORMS + 1 }, (_, index) => customForm(index)).join("")
    },
    {
      name: "fifth represented form after mixed enrollment",
      forms: `${Array.from({ length: 2 }, (_, index) => `
        <form aria-label="Native application ${index + 1}"><input aria-label="Question ${index + 1}"></form>
      `).join("")}${Array.from({ length: 3 }, (_, index) => customForm(index + 2)).join("")}`
    }
  ]) {
    await context.test(scenario.name, async () => {
      const fixture = await protectedFixture(`<!doctype html><body>${scenario.forms}</body>`);
      try {
        await assertProtectedExtractionCode(fixture, "FORM_INSPECTION_OVERSIZE");
      } finally {
        await closeFixture(fixture);
      }
    });
  }
});

test("ordinary defined custom decorations without relevant control semantics remain supported", async () => {
  const fixture = await protectedFixture(`<!doctype html><body>
    <form aria-label="Application">
      <input aria-label="Native question">
      <static-decoration>Ordinary decoration</static-decoration>
    </form>
    <script>customElements.define("static-decoration", class extends HTMLElement {});</script>
  </body>`);
  try {
    const extraction = await fixture.session.extractApplicationForm();
    const report = applicationFormInspectionReportSchema.parse(extraction.report);
    assert.equal(report.forms[0]?.sections[0]?.fields.length, 1);
    await extraction.dispose();
  } finally {
    await closeFixture(fixture);
  }
});

test("unsupported custom-only text-entry roles return a bounded structure error", async (context) => {
  for (const role of ["textbox", "searchbox"] as const) {
    await context.test(role, async () => {
      const fixture = await protectedFixture(`<!doctype html><body>
        <form aria-label="Application"><div role="${role}" aria-label="Custom answer"></div></form>
      </body>`);
      try {
        await assertProtectedExtractionCode(fixture, "FORM_STRUCTURE_UNSUPPORTED");
      } finally {
        await closeFixture(fixture);
      }
    });
  }
});

test("nested open-shadow interactions and inaccessible relevant custom hosts fail closed", async (context) => {
  await context.test("second-level nested open-shadow interaction", async () => {
    const fixture = await protectedFixture(`<!doctype html><body>
      <form aria-label="Application"><input aria-label="Native question"><div id="outer-host"></div></form>
      <script>
        const outer = document.getElementById("outer-host").attachShadow({ mode: "open" });
        const innerHost = document.createElement("div");
        outer.append(innerHost);
        innerHost.attachShadow({ mode: "open" }).innerHTML = "<button>Nested action</button>";
      </script>
    </body>`);
    try {
      await assertProtectedExtractionCode(fixture, "FORM_STRUCTURE_UNSUPPORTED");
    } finally {
      await closeFixture(fixture);
    }
  });

  await context.test("inaccessible relevant custom host", async () => {
    const fixture = await protectedFixture(`<!doctype html><body>
      <form aria-label="Application">
        <input aria-label="Native question">
        <opaque-field role="group" aria-label="Opaque custom field"></opaque-field>
      </form>
    </body>`);
    try {
      await assertProtectedExtractionCode(fixture, "FORM_STRUCTURE_UNSUPPORTED");
    } finally {
      await closeFixture(fixture);
    }
  });

  await context.test("inaccessible relevant custom host nested in an open shadow", async () => {
    const fixture = await protectedFixture(`<!doctype html><body>
      <form aria-label="Application"><input aria-label="Native question"><div id="outer-host"></div></form>
      <script>
        const outer = document.getElementById("outer-host").attachShadow({ mode: "open" });
        outer.innerHTML = '<opaque-field role="group" aria-label="Opaque nested field"></opaque-field>';
        customElements.define("opaque-field", class extends HTMLElement {
          constructor() {
            super();
            this.attachShadow({ mode: "closed" }).innerHTML = '<input aria-label="Hidden nested answer">';
          }
        });
      </script>
    </body>`);
    try {
      await assertProtectedExtractionCode(fixture, "FORM_STRUCTURE_UNSUPPORTED");
    } finally {
      await closeFixture(fixture);
    }
  });
});

test("selected ARIA winner identity changes are advisory signals", async (context) => {
  const scenarios = [
    {
      name: "earlier duplicate becomes winner",
      dependencies: '<span id="aria-winner">Original question</span>',
      mutation: `
        const duplicate = document.createElement("span");
        duplicate.id = "aria-winner";
        duplicate.textContent = "Earlier question";
        document.getElementById("aria-winner").before(duplicate);
      `,
      changed: true,
      status: "INVALID"
    },
    {
      name: "winner removed and fallback duplicate wins",
      dependencies: '<span id="aria-winner">Original question</span><span id="aria-winner">Fallback question</span>',
      mutation: 'document.getElementById("aria-winner").remove();',
      changed: true,
      status: "INVALID"
    },
    {
      name: "relevant duplicate ordering changes",
      dependencies: '<span id="aria-winner">Original question</span><span id="second" data-winning-id="aria-winner">Earlier question</span>',
      mutation: `
        const second = document.getElementById("second");
        second.id = second.dataset.winningId;
        document.getElementById("aria-winner").before(second);
      `,
      changed: true,
      status: "INVALID"
    },
    {
      name: "duplicate inserted after existing winner",
      dependencies: '<span id="aria-winner">Original question</span>',
      mutation: `
        const duplicate = document.createElement("span");
        duplicate.id = "aria-winner";
        duplicate.textContent = "Later duplicate";
        document.getElementById("aria-winner").after(duplicate);
      `,
      changed: false,
      status: "CURRENT"
    }
  ] as const;

  for (const scenario of scenarios) {
    await context.test(scenario.name, async () => {
      const fixture = await protectedFixture(`<!doctype html><body>
        <aside>${scenario.dependencies}</aside>
        <form aria-label="Application"><input aria-labelledby="aria-winner"></form>
      </body>`);
      try {
        const extraction = await fixture.session.extractApplicationForm();
        const before = await fixture.session.snapshot();
        await fixture.page.evaluate(`(() => { ${scenario.mutation} })()`);
        const after = await fixture.session.snapshot();
        assert.equal(after.semanticRevision > before.semanticRevision, scenario.changed);
        assert.equal(after.applicantStateEpoch, before.applicantStateEpoch);
        assert.equal((await fixture.session.verifyCandidate(extraction.candidate)).status, scenario.status);
        await extraction.dispose();
      } finally {
        await closeFixture(fixture);
      }
    });
  }
});

test("privacy-relevant composed ancestor changes advance the advisory fence", async (context) => {
  for (const scenario of [
    { name: "ancestor gains textbox role", mutation: 'ancestor.setAttribute("role", "textbox");' },
    { name: "ancestor gains inherited contenteditable", mutation: 'ancestor.setAttribute("contenteditable", "true");' }
  ]) {
    await context.test(scenario.name, async () => {
      const fixture = await protectedFixture(`<!doctype html><body>
        <aside id="ancestor"><span id="semantic-target">Static question</span></aside>
        <form aria-label="Application"><input aria-labelledby="semantic-target"></form>
      </body>`);
      try {
        const extraction = await fixture.session.extractApplicationForm();
        const before = await fixture.session.snapshot();
        await fixture.page.evaluate(`(() => { const ancestor = document.getElementById("ancestor"); ${scenario.mutation} })()`);
        const after = await fixture.session.snapshot();
        assert.ok(after.semanticRevision > before.semanticRevision);
        assert.equal(after.applicantStateEpoch, before.applicantStateEpoch);
        assert.equal((await fixture.session.verifyCandidate(extraction.candidate)).status, "INVALID");
        await extraction.dispose();
      } finally {
        await closeFixture(fixture);
      }
    });
  }
});

test("semantic container attributes advance the advisory fence", async (context) => {
  for (const scenario of [
    {
      name: "fieldset disabled state",
      html: `<!doctype html><body><form aria-label="Application">
        <fieldset id="semantic-container"><legend>Section</legend><input aria-label="Question"></fieldset>
      </form></body>`,
      mutation: 'document.getElementById("semantic-container").setAttribute("disabled", "");'
    },
    {
      name: "optgroup disabled state",
      html: `<!doctype html><body><form aria-label="Application">
        <select aria-label="Question"><optgroup id="semantic-container" label="Group"><option>Answer</option></optgroup></select>
      </form></body>`,
      mutation: 'document.getElementById("semantic-container").setAttribute("disabled", "");'
    },
    {
      name: "radiogroup accessible label",
      html: `<!doctype html><body>
        <div id="semantic-container" role="radiogroup" aria-label="Before">
          <label>One<input form="application" type="radio" name="choice"></label>
          <label>Two<input form="application" type="radio" name="choice"></label>
        </div>
        <form id="application" aria-label="Application"></form>
      </body>`,
      mutation: 'document.getElementById("semantic-container").setAttribute("aria-label", "After");'
    }
  ] as const) {
    await context.test(scenario.name, async () => {
      const fixture = await protectedFixture(scenario.html);
      try {
        const extraction = await fixture.session.extractApplicationForm();
        const before = await fixture.session.snapshot();
        await fixture.page.evaluate(`(() => {
          ${scenario.mutation}
          return new Promise(resolve => setTimeout(resolve, 0));
        })()`);
        const after = await fixture.session.snapshot();
        assert.ok(after.semanticRevision > before.semanticRevision);
        assert.equal(after.applicantStateEpoch, before.applicantStateEpoch);
        assert.equal((await fixture.session.verifyCandidate(extraction.candidate)).status, "INVALID");
        await extraction.dispose();
      } finally {
        await closeFixture(fixture);
      }
    });
  }
});

test("privacy-relevant ancestors inside an external open shadow root are observed transactionally", async (context) => {
  const html = `<!doctype html><body>
    <x-semantic-host id="semantic-host"><span id="semantic-target" slot="question">Static question</span></x-semantic-host>
    <form aria-label="Application"><input aria-labelledby="semantic-target"></form>
    <script>
      document.getElementById("semantic-host").attachShadow({ mode: "open" }).innerHTML =
        '<div id="privacy-ancestor"><slot name="question"></slot></div>';
    </script>
  </body>`;

  await context.test("observer callback", async () => {
    const fixture = await protectedFixture(html);
    try {
      const extraction = await fixture.session.extractApplicationForm();
      const before = await fixture.session.snapshot();
      await fixture.page.evaluate(() => {
        const host = document.getElementById("semantic-host")!;
        host.shadowRoot!.getElementById("privacy-ancestor")!.setAttribute("role", "textbox");
        return new Promise<void>((resolve) => setTimeout(resolve, 0));
      });
      const after = await fixture.session.snapshot();
      assert.ok(after.semanticRevision > before.semanticRevision);
      assert.equal(after.applicantStateEpoch, before.applicantStateEpoch);
      assert.equal((await fixture.session.verifyCandidate(extraction.candidate)).status, "INVALID");
      await extraction.dispose();
    } finally {
      await closeFixture(fixture);
    }
  });

  await context.test("immediate snapshot drain", async () => {
    const evidence = await isolatedProtectedWorldEvidence(html, `
      const capability = globalThis[${JSON.stringify(PROTECTED_BROWSER_CAPABILITY_PROPERTY)}];
      const extraction = capability.extract();
      const before = capability.snapshot();
      const host = document.getElementById("semantic-host");
      host.shadowRoot.getElementById("privacy-ancestor").setAttribute("role", "textbox");
      const after = capability.snapshot();
      const status = capability.verifyCandidate({ candidateId: extraction.candidateId }).status;
      return { kind: extraction.kind, before, after, status };
    `) as {
      kind: string;
      before: { semanticRevision: number; applicantStateEpoch: number };
      after: { semanticRevision: number; applicantStateEpoch: number };
      status: string;
    };
    assert.equal(evidence.kind, "OK");
    assert.ok(evidence.after.semanticRevision > evidence.before.semanticRevision);
    assert.equal(evidence.after.applicantStateEpoch, evidence.before.applicantStateEpoch);
    assert.equal(evidence.status, "INVALID");
  });

  await context.test("candidate disposal removes the external root observer", async () => {
    const fixture = await protectedFixture(html);
    try {
      const extraction = await fixture.session.extractApplicationForm();
      await extraction.dispose();
      const before = await fixture.session.snapshot();
      await fixture.page.evaluate(() => {
        const host = document.getElementById("semantic-host")!;
        host.shadowRoot!.getElementById("privacy-ancestor")!.setAttribute("role", "textbox");
        return new Promise<void>((resolve) => setTimeout(resolve, 0));
      });
      assert.deepEqual(await fixture.session.snapshot(), before);
    } finally {
      await closeFixture(fixture);
    }
  });
});

test("non-semantic attributes on a retained privacy ancestor do not advance the advisory fence", async () => {
  const fixture = await protectedFixture(`<!doctype html><body>
    <aside id="privacy-ancestor"><span id="semantic-target">Static question</span></aside>
    <form aria-label="Application"><input aria-labelledby="semantic-target"></form>
  </body>`);
  try {
    const extraction = await fixture.session.extractApplicationForm();
    const before = await fixture.session.snapshot();
    await fixture.page.evaluate(() => {
      document.getElementById("privacy-ancestor")!.setAttribute("maxlength", "5");
    });
    assert.deepEqual(await fixture.session.snapshot(), before);
    assert.equal((await fixture.session.verifyCandidate(extraction.candidate)).status, "CURRENT");
    await extraction.dispose();
  } finally {
    await closeFixture(fixture);
  }
});

test("oversized irrelevant attribute names are ignored before semantic-name hashing", async () => {
  const evidence = await isolatedProtectedWorldEvidence(
    '<!doctype html><body><form aria-label="Application"><input id="answer" aria-label="Question"></form></body>',
    `
      const capability = globalThis[${JSON.stringify(PROTECTED_BROWSER_CAPABILITY_PROPERTY)}];
      const nativeSetHas = Set.prototype.has;
      let hostileHashLookups = 0;
      Set.prototype.has = function(value) {
        if (typeof value === "string" && value.length > 131_072) hostileHashLookups += 1;
        return Reflect.apply(nativeSetHas, this, [value]);
      };
      const extraction = capability.extract();
      const before = capability.snapshot();
      document.getElementById("answer").setAttribute("x".repeat(200_000), "irrelevant");
      const after = capability.snapshot();
      const status = capability.verifyCandidate({ candidateId: extraction.candidateId }).status;
      return { kind: extraction.kind, before, after, status, hostileHashLookups };
    `
  ) as {
    kind: string;
    before: { semanticRevision: number; applicantStateEpoch: number };
    after: { semanticRevision: number; applicantStateEpoch: number };
    status: string;
    hostileHashLookups: number;
  };
  assert.equal(evidence.kind, "OK");
  assert.deepEqual(evidence.after, evidence.before);
  assert.equal(evidence.status, "CURRENT");
  assert.equal(evidence.hostileHashLookups, 0, "the hostile name must be bounded before Set.has()");
});

test("hostile link rel values are charged once before structural classification", async () => {
  const evidence = await isolatedProtectedWorldEvidence(`<!doctype html><html><head>
    <link id="hostile-link">
    <script>document.getElementById("hostile-link").setAttribute("rel", "x ".repeat(70_000));</script>
  </head><body><form aria-label="Application"><input aria-label="Question"></form></body></html>`, `
    const capability = globalThis[${JSON.stringify(PROTECTED_BROWSER_CAPABILITY_PROPERTY)}];
    const link = document.getElementById("hostile-link");
    const nativeMatches = Element.prototype.matches;
    let hostileStructuralMatches = 0;
    Element.prototype.matches = function(selector) {
      if (this === link && typeof selector === "string" && selector.includes("link[rel")) {
        hostileStructuralMatches += 1;
      }
      return Reflect.apply(nativeMatches, this, [selector]);
    };
    const extraction = capability.extract();
    const before = capability.snapshot();
    for (let index = 0; index < 1_000; index += 1) link.className = "change-" + index;
    const after = capability.snapshot();
    const status = capability.verifyCandidate({ candidateId: extraction.candidateId }).status;
    return { kind: extraction.kind, before, after, status, hostileStructuralMatches };
  `) as {
    kind: string;
    before: { semanticRevision: number; applicantStateEpoch: number };
    after: { semanticRevision: number; applicantStateEpoch: number };
    status: string;
    hostileStructuralMatches: number;
  };
  assert.equal(evidence.kind, "OK");
  assert.equal(evidence.hostileStructuralMatches, 0, "structural classification must not call selector matching");
  assert.ok(evidence.after.semanticRevision > evidence.before.semanticRevision);
  assert.equal(evidence.after.applicantStateEpoch, evidence.before.applicantStateEpoch);
  assert.equal(evidence.status, "INVALID");
});

test("deep inherited editability checks exhaust work before quadratic native ancestry scans", async () => {
  const evidence = await isolatedProtectedWorldEvidence(`<!doctype html><body>
    <aside><span id="semantic-target">Static question</span></aside>
    <form aria-label="Application"><input aria-labelledby="semantic-target"></form>
  </body>`, `
    const capability = globalThis[${JSON.stringify(PROTECTED_BROWSER_CAPABILITY_PROPERTY)}];
    const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "isContentEditable");
    const nativeIsContentEditable = descriptor.get;
    let nativeGetterCalls = 0;
    Object.defineProperty(HTMLElement.prototype, "isContentEditable", {
      ...descriptor,
      get() {
        nativeGetterCalls += 1;
        return Reflect.apply(nativeIsContentEditable, this, []);
      }
    });
    const extraction = capability.extract();
    const before = capability.snapshot();
    const callsBeforeMutation = nativeGetterCalls;
    const root = document.createElement("span");
    let parent = root;
    for (let index = 0; index < 5_000; index += 1) {
      const child = document.createElement("span");
      parent.append(child);
      parent = child;
    }
    const text = document.createTextNode("Before");
    parent.append(text);
    document.getElementById("semantic-target").replaceChildren(root);
    text.nodeValue = "After";
    const after = capability.snapshot();
    const callsAfterDrain = nativeGetterCalls;
    const disposal = capability.disposeCandidate({ candidateId: extraction.candidateId });
    return {
      kind: extraction.kind,
      before,
      after,
      nativeCallsDuringDrain: callsAfterDrain - callsBeforeMutation,
      disposal
    };
  `) as {
    kind: string;
    before: { semanticRevision: number; applicantStateEpoch: number };
    after: { semanticRevision: number; applicantStateEpoch: number };
    nativeCallsDuringDrain: number;
    disposal: string;
  };
  assert.equal(evidence.kind, "OK");
  assert.ok(evidence.after.semanticRevision > evidence.before.semanticRevision);
  assert.equal(evidence.after.applicantStateEpoch, evidence.before.applicantStateEpoch);
  assert.ok(evidence.nativeCallsDuringDrain < 100, "native ancestry scans must stop at the aggregate work ceiling");
  assert.equal(evidence.disposal, "MISSING", "work exhaustion must revoke retained candidate authority");
});

test("native choice label semantics advance the advisory fence without treating choice state as semantic", async (context) => {
  for (const scenario of [
    {
      name: "option label attribute",
      control: '<select aria-label="Question"><option id="choice" label="Before">Fallback</option></select>',
      mutation: 'document.getElementById("choice").setAttribute("label", "After");'
    },
    {
      name: "optgroup label attribute",
      control: '<select aria-label="Question"><optgroup id="choice" label="Before"><option>Answer</option></optgroup></select>',
      mutation: 'document.getElementById("choice").setAttribute("label", "After");'
    },
    {
      name: "option static text",
      control: '<select aria-label="Question"><option id="choice">Before</option></select>',
      mutation: 'document.getElementById("choice").firstChild.nodeValue = "After";'
    }
  ]) {
    await context.test(scenario.name, async () => {
      const fixture = await protectedFixture(`<!doctype html><body><form>${scenario.control}</form></body>`);
      try {
        const extraction = await fixture.session.extractApplicationForm();
        const before = await fixture.session.snapshot();
        await fixture.page.evaluate(`(() => { ${scenario.mutation} })()`);
        const after = await fixture.session.snapshot();
        assert.ok(after.semanticRevision > before.semanticRevision);
        assert.equal(after.applicantStateEpoch, before.applicantStateEpoch);
        assert.equal((await fixture.session.verifyCandidate(extraction.candidate)).status, "INVALID");
        await extraction.dispose();
      } finally {
        await closeFixture(fixture);
      }
    });
  }

  await context.test("option selected and value state", async () => {
    const fixture = await protectedFixture(`<!doctype html><body><form>
      <select aria-label="Question"><option id="choice">Answer</option></select>
    </form></body>`);
    try {
      const extraction = await fixture.session.extractApplicationForm();
      const before = await fixture.session.snapshot();
      await fixture.page.evaluate(() => {
        const choice = document.getElementById("choice")!;
        choice.setAttribute("value", "private-value");
        choice.setAttribute("selected", "");
      });
      assert.deepEqual(await fixture.session.snapshot(), before);
      assert.equal((await fixture.session.verifyCandidate(extraction.candidate)).status, "CURRENT");
      await extraction.dispose();
    } finally {
      await closeFixture(fixture);
    }
  });
});

test("unrelated attribute changes outside retained semantic surfaces do not advance the advisory fence", async () => {
  const fixture = await protectedFixture(`<!doctype html><body>
    <aside id="unrelated"><span>Unrelated content</span></aside>
    <form aria-label="Application"><input aria-label="Question"></form>
  </body>`);
  try {
    const extraction = await fixture.session.extractApplicationForm();
    const before = await fixture.session.snapshot();
    await fixture.page.evaluate(() => {
      const unrelated = document.getElementById("unrelated")!;
      unrelated.setAttribute("role", "textbox");
      unrelated.setAttribute("class", "unrelated-class");
      unrelated.setAttribute("style", "color: rgb(1, 2, 3)");
      return new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    assert.deepEqual(await fixture.session.snapshot(), before);
    assert.equal((await fixture.session.verifyCandidate(extraction.candidate)).status, "CURRENT");
    await extraction.dispose();
  } finally {
    await closeFixture(fixture);
  }
});

test("fresh verification rejects CSSOM-only visibility changes even when the advisory fence is unchanged", async (context) => {
  for (const scenario of [
    {
      name: "CSSStyleDeclaration mutation",
      head: "<style>#answer { display: block; }</style>",
      mutation: 'document.styleSheets[0].cssRules[0].style.display = "none";'
    },
    {
      name: "constructed adopted stylesheet",
      head: "",
      mutation: `
        const sheet = new CSSStyleSheet();
        sheet.replaceSync("#answer { display: none; }");
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
      `
    }
  ]) {
    await context.test(scenario.name, async () => {
      const fixture = await protectedFixture(`<!doctype html><html><head>${scenario.head}</head><body>
        <form aria-label="Application"><input id="answer" aria-label="Question"></form>
      </body></html>`);
      try {
        const extraction = await fixture.session.extractApplicationForm();
        const before = await fixture.session.snapshot();
        await fixture.page.evaluate(`(() => { ${scenario.mutation} })()`);
        const after = await fixture.session.snapshot();
        assert.deepEqual(after, before, "CSSOM-only changes may leave the advisory fence unchanged");
        assert.equal((await fixture.session.verifyCandidate(extraction.candidate)).status, "INVALID");
        await extraction.dispose();
      } finally {
        await closeFixture(fixture);
      }
    });
  }
});

test("SVG stylesheet text changes remain advisory semantic signals", async () => {
  const fixture = await protectedFixture(`<!doctype html><body>
    <svg><style id="svg-style">#answer { color: red; }</style></svg>
    <form aria-label="Application"><input id="answer" aria-label="Question"></form>
  </body>`);
  try {
    const extraction = await fixture.session.extractApplicationForm();
    const before = await fixture.session.snapshot();
    await fixture.page.evaluate(() => {
      document.getElementById("svg-style")!.firstChild!.nodeValue = "#answer { color: blue; }";
      return new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    const after = await fixture.session.snapshot();
    assert.ok(after.semanticRevision > before.semanticRevision);
    assert.equal(after.applicantStateEpoch, before.applicantStateEpoch);
    assert.equal((await fixture.session.verifyCandidate(extraction.candidate)).status, "CURRENT");
    await extraction.dispose();
  } finally {
    await closeFixture(fixture);
  }
});

test("fresh verification re-inventories late open shadows even when the advisory fence is unchanged", async (context) => {
  for (const scenario of [
    {
      name: "late open shadow root",
      setup: "",
      mutation: 'document.getElementById("late-host").attachShadow({ mode: "open" }).innerHTML = "<button>Late action</button>";'
    },
    {
      name: "nested late open shadow root",
      setup: `
        const outer = document.getElementById("late-host").attachShadow({ mode: "open" });
        const nested = document.createElement("div");
        nested.id = "nested-late-host";
        outer.append(nested);
      `,
      mutation: 'document.getElementById("late-host").shadowRoot.getElementById("nested-late-host").attachShadow({ mode: "open" }).innerHTML = "<button>Nested late action</button>";'
    }
  ]) {
    await context.test(scenario.name, async () => {
      const fixture = await protectedFixture(`<!doctype html><body>
        <form aria-label="Application"><input aria-label="Question"><div id="late-host"></div></form>
        <script>${scenario.setup}</script>
      </body>`);
      try {
        const extraction = await fixture.session.extractApplicationForm();
        const before = await fixture.session.snapshot();
        await fixture.page.evaluate(`(() => { ${scenario.mutation} })()`);
        const after = await fixture.session.snapshot();
        assert.deepEqual(after, before, "attachShadow may leave the advisory fence unchanged");
        assert.equal((await fixture.session.verifyCandidate(extraction.candidate)).status, "INVALID");
        await extraction.dispose();
      } finally {
        await closeFixture(fixture);
      }
    });
  }

  await context.test("late inaccessible custom host inside an existing open shadow", async () => {
    const fixture = await protectedFixture(`<!doctype html><body>
      <form aria-label="Application"><input aria-label="Question"><div id="outer-host"></div></form>
      <script>document.getElementById("outer-host").attachShadow({ mode: "open" }).innerHTML = '<span>Decoration</span>';</script>
    </body>`);
    try {
      const extraction = await fixture.session.extractApplicationForm();
      await fixture.page.evaluate(() => {
        customElements.define("late-opaque-field", class extends HTMLElement {
          constructor() {
            super();
            this.attachShadow({ mode: "closed" }).innerHTML = '<input aria-label="Hidden answer">';
          }
        });
        const field = document.createElement("late-opaque-field");
        field.setAttribute("role", "group");
        field.setAttribute("aria-label", "Opaque late field");
        document.getElementById("outer-host")!.shadowRoot!.append(field);
      });
      assert.equal((await fixture.session.verifyCandidate(extraction.candidate)).status, "INVALID");
      await extraction.dispose();
    } finally {
      await closeFixture(fixture);
    }
  });
});

test("a hostile passive DOM traversal exceeds one aggregate protected-operation ceiling", async (context) => {
  for (const nodeKind of ["element", "comment", "text"] as const) {
    await context.test(`${nodeKind}-only traversal`, async () => {
      const fixture = await protectedFixture(`<!doctype html><body>
        <main id="hostile-surface"></main>
        <form aria-label="Application"><input aria-label="Question"></form>
      </body>`);
      try {
        await fixture.page.evaluate((kind) => {
          const surface = document.getElementById("hostile-surface")!;
          const fragment = document.createDocumentFragment();
          for (let index = 0; index < 140_000; index += 1) {
            fragment.append(
              kind === "element"
                ? document.createElement("span")
                : kind === "comment"
                  ? document.createComment("passive")
                  : document.createTextNode("passive")
            );
          }
          surface.append(fragment);
        }, nodeKind);
        await assertProtectedExtractionCode(fixture, "FORM_INSPECTION_OVERSIZE");
      } finally {
        await closeFixture(fixture);
      }
    });
  }
});

test("the reviewed 131,072-unit operation boundary is accepted and boundary plus one fails closed", async (context) => {
  // One child-list record plus the three composed/DOM ancestor hops from the
  // unrelated mutation surface to the document consume four units. A
  // test-owned observer wrapper invokes the real protected callback directly
  // so detached synthetic nodes do not make the subsequent fresh verification
  // independently exhaust its own operation budget.
  const operationWorkLimit = 131_072;
  const mutationFixedWork = 4;
  for (const scenario of [
    { name: "exact boundary", addedNodes: operationWorkLimit - mutationFixedWork, changed: false, status: "CURRENT" },
    { name: "boundary plus one", addedNodes: operationWorkLimit - mutationFixedWork + 1, changed: true, status: "INVALID" }
  ] as const) {
    await context.test(scenario.name, async () => {
      const evidence = await observationRootEvidence(`
        const mutationSurface = document.createElement("aside");
        document.body.prepend(mutationSurface);
        const extraction = capability.extract();
        const before = capability.snapshot();
        const addedNodes = Array.from(
          { length: ${scenario.addedNodes} },
          () => document.createTextNode("")
        );
        callbacks[0]([{
          type: "childList",
          target: mutationSurface,
          addedNodes,
          removedNodes: []
        }]);
        const after = capability.snapshot();
        const verification = capability.verifyCandidate({ candidateId: extraction.candidateId });
        return { kind: extraction.kind, before, after, status: verification.status };
      `);
      assert.equal(evidence.kind, "OK");
      assert.equal(evidence.after.semanticRevision > evidence.before.semanticRevision, scenario.changed);
      assert.equal(evidence.after.applicantStateEpoch, evidence.before.applicantStateEpoch);
      assert.equal(evidence.status, scenario.status);
    });
  }
});

test("observer work exhaustion revokes retained authority and wakes an existing waiter", async () => {
  const fixture = await protectedFixture(`<!doctype html><body>
    <aside id="unrelated-mutation-surface"></aside>
    <form aria-label="Application"><input aria-label="Question"></form>
  </body>`);
  try {
    const extraction = await fixture.session.extractApplicationForm();
    const before = await fixture.session.snapshot();
    const waiting = fixture.session.waitForChange(before, 1_000);
    await fixture.page.evaluate(() => {
      const fragment = document.createDocumentFragment();
      for (let index = 0; index < 131_069; index += 1) {
        fragment.append(document.createTextNode(""));
      }
      document.getElementById("unrelated-mutation-surface")!.append(fragment);
    });
    const after = await waiting;
    assert.ok(after.semanticRevision > before.semanticRevision);
    assert.equal(after.applicantStateEpoch, before.applicantStateEpoch);
    assert.equal((await fixture.session.verifyCandidate(extraction.candidate)).status, "INVALID");
    await extraction.dispose();
  } finally {
    await closeFixture(fixture);
  }
});

test("observer subtree scans charge non-element descendants", async () => {
  const fixture = await protectedFixture(`<!doctype html><body>
    <aside id="unrelated-mutation-surface"></aside>
    <form aria-label="Application"><input aria-label="Question"></form>
  </body>`);
  try {
    const extraction = await fixture.session.extractApplicationForm();
    const before = await fixture.session.snapshot();
    await fixture.page.evaluate(() => {
      const wrapper = document.createElement("div");
      const fragment = document.createDocumentFragment();
      for (let index = 0; index < 140_000; index += 1) fragment.append(document.createComment("passive"));
      wrapper.append(fragment);
      document.getElementById("unrelated-mutation-surface")!.append(wrapper);
    });
    const after = await fixture.session.snapshot();
    assert.ok(after.semanticRevision > before.semanticRevision);
    assert.equal(after.applicantStateEpoch, before.applicantStateEpoch);
    assert.equal((await fixture.session.verifyCandidate(extraction.candidate)).status, "INVALID");
    await extraction.dispose();
  } finally {
    await closeFixture(fixture);
  }
});

test("fresh verification exhaustion returns INVALID and permanently revokes candidate authority", async () => {
  const fixture = await protectedFixture(`<!doctype html><body>
    <main id="hostile-surface"></main>
    <form aria-label="Application"><input aria-label="Question"></form>
  </body>`);
  try {
    const extraction = await fixture.session.extractApplicationForm();
    await fixture.page.evaluate(() => {
      const fragment = document.createDocumentFragment();
      for (let index = 0; index < 140_000; index += 1) fragment.append(document.createElement("span"));
      document.getElementById("hostile-surface")!.append(fragment);
    });
    assert.equal((await fixture.session.verifyCandidate(extraction.candidate)).status, "INVALID");
    assert.equal((await fixture.session.verifyCandidate(extraction.candidate)).status, "INVALID");
    await extraction.dispose();
  } finally {
    await closeFixture(fixture);
  }
});

test("oversize role text is rejected before hostile tokenization", async () => {
  const role = Array.from({ length: 5_000 }, () => "presentation").join(" ");
  const fixture = await protectedFixture(`<!doctype html><body>
    <form aria-label="Application"><input aria-label="Question"><div role="${role}"></div></form>
  </body>`);
  try {
    await assertProtectedExtractionCode(fixture, "FORM_INSPECTION_OVERSIZE");
  } finally {
    await closeFixture(fixture);
  }
});

test("hostile token-like strings are bounded by local or aggregate operation limits", async (context) => {
  const hostileToken = "x".repeat(140_000);
  for (const scenario of [
    {
      name: "autocomplete normalization",
      controls: `<input aria-label="Question" autocomplete="${hostileToken}">`
    },
    {
      name: "radio grouping-name comparison",
      controls: `<fieldset><legend>Question</legend>
        <label>First<input type="radio" name="${hostileToken}"></label>
        <label>Second<input type="radio" name="${hostileToken}"></label>
      </fieldset>`
    },
    {
      name: "whitespace-only file accept normalization",
      controls: `<input type="file" aria-label="Resume" accept="${" ".repeat(140_000)}">`
    },
    {
      name: "native label explicit association",
      controls: `<label for="${hostileToken}">Unrelated label</label><input aria-label="Question">`
    }
  ]) {
    await context.test(scenario.name, async () => {
      const fixture = await protectedFixture(`<!doctype html><body><form>${scenario.controls}</form></body>`);
      try {
        await assertProtectedExtractionCode(fixture, "FORM_INSPECTION_OVERSIZE");
      } finally {
        await closeFixture(fixture);
      }
    });
  }
});

test("hostile custom tag names exhaust work before hyphen scanning", async () => {
  const evidence = await isolatedProtectedWorldEvidence(
    '<!doctype html><body><form id="application" aria-label="Application"><input aria-label="Question"></form></body>',
    `
      const capability = globalThis[${JSON.stringify(PROTECTED_BROWSER_CAPABILITY_PROPERTY)}];
      const nativeIncludes = String.prototype.includes;
      let hostileHyphenScans = 0;
      String.prototype.includes = function(search, ...rest) {
        const value = String(this);
        if (value.length > 131_072 && search === "-") hostileHyphenScans += 1;
        return Reflect.apply(nativeIncludes, value, [search, ...rest]);
      };
      const hostile = document.createElement("x-" + "x".repeat(140_000));
      hostile.style.cssText = "display:block;width:10px;height:10px";
      hostile.textContent = "Decoration";
      document.getElementById("application").append(hostile);
      const result = capability.extract();
      return { result, hostileHyphenScans };
    `
  ) as { result: { kind: string; code?: string }; hostileHyphenScans: number };
  assert.deepEqual(evidence.result, { kind: "ERROR", code: "FORM_INSPECTION_OVERSIZE" });
  assert.equal(evidence.hostileHyphenScans, 0, "the hostile tag name must be charged before includes()");
});

test("hostile introduced IDs exhaust work before unresolved-ID hashing", async () => {
  const evidence = await isolatedProtectedWorldEvidence(`<!doctype html><body>
    <aside id="outside"></aside>
    <form aria-label="Application"><input aria-labelledby="future-target" aria-label="Question"></form>
  </body>`, `
    const capability = globalThis[${JSON.stringify(PROTECTED_BROWSER_CAPABILITY_PROPERTY)}];
    const nativeSetHas = Set.prototype.has;
    let hostileHashLookups = 0;
    Set.prototype.has = function(value) {
      if (typeof value === "string" && value.length > 131_072) hostileHashLookups += 1;
      return Reflect.apply(nativeSetHas, this, [value]);
    };
    const extraction = capability.extract();
    const before = capability.snapshot();
    const introduced = document.createElement("div");
    introduced.id = "x".repeat(140_000);
    document.getElementById("outside").append(introduced);
    const after = capability.snapshot();
    const status = capability.verifyCandidate({ candidateId: extraction.candidateId }).status;
    return { kind: extraction.kind, before, after, status, hostileHashLookups };
  `) as {
    kind: string;
    before: { semanticRevision: number; applicantStateEpoch: number };
    after: { semanticRevision: number; applicantStateEpoch: number };
    status: string;
    hostileHashLookups: number;
  };
  assert.equal(evidence.kind, "OK");
  assert.equal(evidence.hostileHashLookups, 0, "the hostile ID must be charged before Set.has()");
  assert.ok(evidence.after.semanticRevision > evidence.before.semanticRevision);
  assert.equal(evidence.after.applicantStateEpoch, evidence.before.applicantStateEpoch);
  assert.equal(evidence.status, "INVALID");
});

test("the supported maximum of four forms, 200 fields, and 1,000 choices remains reachable", async () => {
  let fieldIndex = 0;
  let sectionIndex = 0;
  let html = "<!doctype html><body>";
  for (let formIndex = 0; formIndex < MAX_FORMS; formIndex += 1) {
    html += `<form aria-label="Application ${formIndex + 1}">`;
    for (let formSectionIndex = 0; formSectionIndex < 32; formSectionIndex += 1) {
      const fieldsInSection = sectionIndex < 72 ? 2 : 1;
      html += `<fieldset><legend>Section ${sectionIndex + 1}</legend>`;
      for (let localFieldIndex = 0; localFieldIndex < fieldsInSection; localFieldIndex += 1) {
        html += `<select aria-label="Question ${fieldIndex + 1}">`;
        for (let choiceIndex = 0; choiceIndex < 5; choiceIndex += 1) {
          html += `<option>Field ${fieldIndex + 1} choice ${choiceIndex + 1}</option>`;
        }
        html += "</select>";
        fieldIndex += 1;
      }
      html += "</fieldset>";
      sectionIndex += 1;
    }
    html += "</form>";
  }
  html += "</body>";
  assert.equal(fieldIndex, 200);

  const fixture = await protectedFixture(html);
  try {
    const extraction = await fixture.session.extractApplicationForm();
    const report = applicationFormInspectionReportSchema.parse(extraction.report);
    assert.equal(report.forms.length, MAX_FORMS);
    assert.equal(report.forms.flatMap((form) => form.sections).length, 128);
    assert.equal(report.forms.flatMap((form) => form.sections).flatMap((section) => section.fields).length, 200);
    assert.equal(
      report.forms
        .flatMap((form) => form.sections)
        .flatMap((section) => section.fields)
        .reduce((total, field) => total + field.choices.length, 0),
      1_000
    );
    await extraction.dispose();
  } finally {
    await closeFixture(fixture);
  }
});

type ParityOutcome =
  | Readonly<{ kind: "REPORT"; report: ApplicationFormInspectionReport }>
  | Readonly<{ kind: "ERROR"; code: string }>;

test("protected extraction matches the existing fixture oracle for supported and rejected structures", async (context) => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ["ownership and visibility", ownershipAndVisibilityFixture()],
    ["file and unsupported descriptors", fileAndUnsupportedFixture()],
    ["passive open shadow content", nonHyphenShadowComboboxFixture("passive")],
    ["unrelated iframe", unrelatedIframeFixture()],
    ["visible password", privacyFixture({ visiblePassword: true })],
    ["ownerless control", ownerlessFixture()],
    ["included iframe", iframeFixture()],
    ["interactive open shadow", shadowFixture()],
    ["interactive aria", interactiveAriaFixture()],
    ["unknown multiple file", unknownMultipleFileFixture()],
    ["external group iframe", externalGroupIframeFixture()],
    ["nested custom interaction", nestedCustomInteractionFixture()],
    ["shadow interaction", shadowInteractionFixture()],
    ["interactive non-hyphen shadow", nonHyphenShadowComboboxFixture("interactive")],
    ["closed shadow combobox", closedShadowComboboxFixture()],
    ["one field over", repeatedFieldsFixture(MAX_FIELDS_TOTAL + 1, "Question")],
    ["one form over", repeatedFormsFixture(MAX_FORMS + 1)],
    ...(["switch", "slider", "spinbutton", "listbox"] as const).map((role) =>
      [`obvious role ${role}`, obviousAriaRoleFixture(role)] as const
    )
  ];

  for (const [name, html] of cases) {
    await context.test(name, async () => {
      const fixture = await protectedFixture(html);
      try {
        const protectedOutcome: ParityOutcome = await fixture.session.extractApplicationForm()
          .then(async (extraction) => {
            const report = applicationFormInspectionReportSchema.parse(extraction.report);
            await extraction.dispose();
            return { kind: "REPORT" as const, report };
          })
          .catch((error: unknown) => {
            assert.ok(error instanceof ProtectedApplicationFormExtractionError);
            return { kind: "ERROR" as const, code: error.code };
          });
        const existingOutcome: ParityOutcome = await extractSafeApplicationForm(fixture.page)
          .then(async (extraction) => {
            const report = applicationFormInspectionReportSchema.parse(extraction.report);
            await extraction.dispose();
            return { kind: "REPORT" as const, report };
          })
          .catch((error: unknown) => {
            assert.ok(error instanceof ApplicationFormDomExtractionError);
            return { kind: "ERROR" as const, code: error.code };
          });
        assert.deepEqual(protectedOutcome, existingOutcome);
      } finally {
        await closeFixture(fixture);
      }
    });
  }
});
