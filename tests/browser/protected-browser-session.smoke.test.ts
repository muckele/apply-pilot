import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

import { MISSING_CHROMIUM_MESSAGE } from "@/lib/application-browser/browser-runtime";
import {
  ProtectedBrowserSessionError,
  createProtectedApplicationBrowserSession,
  type OpaqueExtractionCandidate,
  type ProtectedApplicationBrowserSession,
  type ProtectedApplicationFormExtraction
} from "@/lib/application-browser/protected-browser-session";
import {
  PROTECTED_BROWSER_CAPABILITY_METHODS,
  PROTECTED_BROWSER_CAPABILITY_PROPERTY
} from "@/lib/application-browser/protected-browser-world";

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

type Fixture = Readonly<{
  context: BrowserContext;
  page: Page;
  session: ProtectedApplicationBrowserSession;
}>;

async function fixture(html: string, path = "first"): Promise<Fixture> {
  const context = await browser.newContext();
  const page = await context.newPage();
  const session = await createProtectedApplicationBrowserSession({ page });
  await page.route("https://identity.example.test/**", async (route) => {
    await route.fulfill({ status: 200, contentType: "text/html", body: html });
  });
  await page.goto(`https://identity.example.test/${path}`, { waitUntil: "domcontentloaded" });
  await session.waitUntilReady();
  return { context, page, session };
}

async function cleanup(value: Fixture): Promise<void> {
  await value.session.close();
  await value.context.close();
}

const SIMPLE_FORM = `<!doctype html><html><body>
  <form aria-label="Application"><label for="name">Full name</label><input id="name"></form>
</body></html>`;

function assertSessionCode(code: ProtectedBrowserSessionError["code"]): (error: unknown) => boolean {
  return (error) => {
    assert.ok(error instanceof ProtectedBrowserSessionError);
    assert.equal(error.code, code);
    assert.equal(error.message, `Protected browser session failed: ${code}`);
    return true;
  };
}

test("the closed session surface exposes only fixed read-only operations", async () => {
  const value = await fixture(SIMPLE_FORM);
  try {
    assert.deepEqual(Object.keys(value.session).sort(), [
      "close",
      "extractApplicationForm",
      "snapshot",
      "subscribe",
      "verifyCandidate",
      "waitForChange",
      "waitUntilReady"
    ]);
    assert.equal("evaluate" in value.session, false);
    assert.equal("navigate" in value.session, false);
    assert.equal("write" in value.session, false);
    assert.equal("click" in value.session, false);
  } finally {
    await cleanup(value);
  }
});

test("forged, cloned, and cross-session candidate identities are rejected before authority can transfer", async () => {
  const first = await fixture(SIMPLE_FORM, "first");
  const second = await fixture(SIMPLE_FORM, "second");
  try {
    const extraction = await first.session.extractApplicationForm();
    const forged = Object.freeze(Object.create(null)) as OpaqueExtractionCandidate;
    const cloned = structuredClone(extraction.candidate) as OpaqueExtractionCandidate;
    await assert.rejects(first.session.verifyCandidate(forged), assertSessionCode("PROTECTED_CANDIDATE_INVALID"));
    await assert.rejects(first.session.verifyCandidate(cloned), assertSessionCode("PROTECTED_CANDIDATE_INVALID"));
    await assert.rejects(second.session.verifyCandidate(extraction.candidate), assertSessionCode("PROTECTED_CANDIDATE_INVALID"));
    assert.equal((await first.session.verifyCandidate(extraction.candidate)).status, "CURRENT");
    await extraction.dispose();
  } finally {
    await cleanup(first);
    await cleanup(second);
  }
});

async function expectInvalidAfter(
  mutate: (page: Page) => Promise<void>
): Promise<void> {
  const value = await fixture(SIMPLE_FORM);
  try {
    const extraction = await value.session.extractApplicationForm();
    assert.equal((await value.session.verifyCandidate(extraction.candidate)).status, "CURRENT");
    await mutate(value.page);
    assert.equal((await value.session.verifyCandidate(extraction.candidate)).status, "INVALID");
    await extraction.dispose();
  } finally {
    await cleanup(value);
  }
}

test("same-looking field replacement never acquires retained candidate authority", async () => {
  await expectInvalidAfter((page) => page.evaluate(() => {
    const old = document.getElementById("name") as HTMLInputElement;
    const replacement = old.cloneNode(true);
    old.replaceWith(replacement);
  }));
});

test("same-looking choice replacement never acquires retained candidate authority", async () => {
  const value = await fixture(`<!doctype html><html><body>
    <form aria-label="Application"><label for="office">Office</label>
      <select id="office"><option>London</option><option>Paris</option></select>
    </form>
  </body></html>`);
  try {
    const extraction = await value.session.extractApplicationForm();
    assert.equal((await value.session.verifyCandidate(extraction.candidate)).status, "CURRENT");
    await value.page.evaluate(() => {
      const oldChoice = document.querySelector("option");
      oldChoice?.replaceWith(oldChoice.cloneNode(true));
    });
    assert.equal((await value.session.verifyCandidate(extraction.candidate)).status, "INVALID");
    await extraction.dispose();
  } finally {
    await cleanup(value);
  }
});

test("detach followed by same-turn reinsertion remains sticky-invalid", async () => {
  await expectInvalidAfter((page) => page.evaluate(() => {
    const field = document.getElementById("name") as HTMLInputElement;
    const parent = field.parentNode as Node;
    parent.removeChild(field);
    parent.appendChild(field);
  }));
});

test("adoption into a child document cannot remain current", async () => {
  await expectInvalidAfter((page) => page.evaluate(() => {
    const frame = document.createElement("iframe");
    document.body.appendChild(frame);
    frame.contentDocument?.body.appendChild(document.getElementById("name") as HTMLInputElement);
  }));
});

test("same-looking form-owner replacement invalidates an externally associated exact field", async () => {
  const value = await fixture(`<!doctype html><html><body>
    <form id="application" aria-label="Application"></form>
    <label for="name">Full name</label><input id="name" form="application">
  </body></html>`);
  try {
    const extraction = await value.session.extractApplicationForm();
    assert.equal((await value.session.verifyCandidate(extraction.candidate)).status, "CURRENT");
    await value.page.evaluate(() => {
      const form = document.getElementById("application") as HTMLFormElement;
      form.replaceWith(form.cloneNode(true));
    });
    assert.equal((await value.session.verifyCandidate(extraction.candidate)).status, "INVALID");
    await extraction.dispose();
  } finally {
    await cleanup(value);
  }
});

test("fragment/history navigation preserves the exact document while a new document invalidates it", async () => {
  const value = await fixture(SIMPLE_FORM);
  try {
    const extraction = await value.session.extractApplicationForm();
    await value.page.evaluate(() => history.pushState({}, "", "#review"));
    assert.equal((await value.session.verifyCandidate(extraction.candidate)).status, "CURRENT");

    await value.page.goto("https://identity.example.test/reloaded", { waitUntil: "domcontentloaded" });
    assert.equal((await value.session.verifyCandidate(extraction.candidate)).status, "INVALID");
    await extraction.dispose();
  } finally {
    await cleanup(value);
  }
});

test("snapshot drains pending semantic records and waitForChange observes semantic and applicant epochs", async () => {
  const value = await fixture(SIMPLE_FORM);
  try {
    const beforeSemantic = await value.session.snapshot();
    await value.page.evaluate(() => {
      document.querySelector("label")?.setAttribute("aria-label", "Changed label");
    });
    const afterSemantic = await value.session.snapshot();
    assert.equal(afterSemantic.documentEpoch, beforeSemantic.documentEpoch);
    assert.ok(afterSemantic.semanticRevision > beforeSemantic.semanticRevision);

    const pendingApplicant = value.session.waitForChange(afterSemantic, 1_000);
    await value.page.evaluate(() => {
      document.getElementById("name")?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const afterApplicant = await pendingApplicant;
    assert.ok(afterApplicant.applicantStateEpoch > afterSemantic.applicantStateEpoch);
  } finally {
    await cleanup(value);
  }
});

test("later hostile window capture cannot suppress protected applicant-state evidence", async () => {
  const value = await fixture(SIMPLE_FORM);
  try {
    const before = await value.session.snapshot();
    await value.page.evaluate(() => {
      window.addEventListener("input", (event) => {
        event.stopPropagation();
        event.stopImmediatePropagation();
      }, true);
      document.getElementById("name")?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const after = await value.session.snapshot();
    assert.ok(after.applicantStateEpoch > before.applicantStateEpoch);
  } finally {
    await cleanup(value);
  }
});

test("protected semantic fences cover relevant style lifecycle signals without unrelated animation churn", async () => {
  const value = await fixture(`<!doctype html><html><head>
    <link id="employer-styles" rel="stylesheet">
  </head><body>
    <form aria-label="Application"><label for="name">Full name</label><input id="name"></form>
    <aside id="unrelated-widget" role="button" tabindex="0">Unrelated widget</aside>
  </body></html>`);
  try {
    const baseline = await value.session.snapshot();
    await value.page.evaluate(() => {
      document.getElementById("unrelated-widget")?.dispatchEvent(
        new AnimationEvent("animationiteration", { bubbles: true })
      );
    });
    const afterUnrelatedAnimation = await value.session.snapshot();
    assert.deepEqual(afterUnrelatedAnimation, baseline);

    await value.page.evaluate(() => {
      document.getElementById("employer-styles")?.dispatchEvent(new Event("load"));
    });
    const afterStylesheetLoad = await value.session.snapshot();
    assert.ok(afterStylesheetLoad.semanticRevision > afterUnrelatedAnimation.semanticRevision);

    await value.page.evaluate(() => {
      window.dispatchEvent(new Event("resize"));
    });
    const afterResize = await value.session.snapshot();
    assert.ok(afterResize.semanticRevision > afterStylesheetLoad.semanticRevision);
  } finally {
    await cleanup(value);
  }
});

test("current textarea and represented contenteditable text do not advance the semantic fence", async () => {
  const value = await fixture(`<!doctype html><html><body><form aria-label="Application">
    <label for="summary">Summary</label><textarea id="summary"></textarea>
    <div id="notes" role="textbox" contenteditable="true" aria-label="Notes">Initial</div>
  </form></body></html>`);
  try {
    const extraction = await value.session.extractApplicationForm();
    const baseline = await value.session.snapshot();
    await value.page.evaluate(() => {
      const textarea = document.getElementById("summary");
      if (textarea) textarea.textContent = "Applicant text";
      const notes = document.getElementById("notes");
      if (notes) notes.textContent = "Applicant rich text";
    });
    assert.deepEqual(await value.session.snapshot(), baseline);
    assert.equal((await value.session.verifyCandidate(extraction.candidate)).status, "CURRENT");
    await extraction.dispose();
  } finally {
    await cleanup(value);
  }
});

test("semantic observation follows relevant open shadow roots but ignores unrelated roots", async () => {
  const value = await fixture(`<!doctype html><html><body>
    <form aria-label="Application">
      <label for="name">Full name</label><input id="name">
      <application-passive id="relevant-host"></application-passive>
    </form>
    <aside><unrelated-passive id="unrelated-host"></unrelated-passive></aside>
    <script>
      document.getElementById("relevant-host").attachShadow({ mode: "open" }).innerHTML = "<span>Passive</span>";
      document.getElementById("unrelated-host").attachShadow({ mode: "open" }).innerHTML = "<span>Passive</span>";
    </script>
  </body></html>`);
  try {
    const extraction = await value.session.extractApplicationForm();
    const baseline = await value.session.snapshot();
    await value.page.evaluate(() => {
      const root = document.getElementById("unrelated-host")?.shadowRoot;
      if (root) root.innerHTML = "<span>Unrelated change</span>";
    });
    assert.deepEqual(await value.session.snapshot(), baseline);

    await value.page.evaluate(() => {
      const button = document.createElement("button");
      button.textContent = "New interaction";
      document.getElementById("relevant-host")?.shadowRoot?.append(button);
    });
    const afterRelevantShadowChange = await value.session.snapshot();
    assert.ok(afterRelevantShadowChange.semanticRevision > baseline.semanticRevision);
    assert.equal((await value.session.verifyCandidate(extraction.candidate)).status, "INVALID");
    await extraction.dispose();
  } finally {
    await cleanup(value);
  }
});

test("a waiting protected call owns the single flight and is never queued behind", async () => {
  const value = await fixture(SIMPLE_FORM);
  try {
    const fence = await value.session.snapshot();
    const waiting = value.session.waitForChange(fence, 100);
    await assert.rejects(
      value.session.extractApplicationForm(),
      assertSessionCode("PROTECTED_SESSION_BUSY")
    );
    await waiting;
  } finally {
    await cleanup(value);
  }
});

test("candidate disposal is idempotent and permanently invalidates its opaque identity", async () => {
  const value = await fixture(SIMPLE_FORM);
  try {
    const extraction: ProtectedApplicationFormExtraction = await value.session.extractApplicationForm();
    await extraction.dispose();
    await extraction.dispose();
    assert.equal((await value.session.verifyCandidate(extraction.candidate)).status, "INVALID");
  } finally {
    await cleanup(value);
  }
});

test("session close synchronously invalidates candidate identity before cleanup completes", async () => {
  const value = await fixture(SIMPLE_FORM);
  try {
    const extraction = await value.session.extractApplicationForm();
    const closing = value.session.close();
    assert.deepEqual(await value.session.verifyCandidate(extraction.candidate), { status: "INVALID" });
    await closing;
    await extraction.dispose();
  } finally {
    await value.context.close();
  }
});

test("caller-visible report mutation cannot alter private candidate integrity", async () => {
  const value = await fixture(SIMPLE_FORM);
  try {
    const extraction = await value.session.extractApplicationForm();
    (extraction.report.forms[0] as { title: string | null }).title = "Caller rewrite";
    const verification = await value.session.verifyCandidate(extraction.candidate);
    assert.equal(verification.status, "CURRENT");
    if (verification.status === "CURRENT") {
      assert.equal(verification.report.forms[0].title, "Application");
    }
    await extraction.dispose();
  } finally {
    await cleanup(value);
  }
});

test("main-frame extraction never mints child-frame candidate slots", async () => {
  const value = await fixture(`<!doctype html><html><body>
    <form aria-label="Main"><label>Main<input></label></form>
    <iframe srcdoc='<!doctype html><form aria-label="Child"><label>Child<input></label></form>'></iframe>
  </body></html>`);
  try {
    const extraction = await value.session.extractApplicationForm();
    assert.equal(extraction.report.forms.length, 1);
    assert.equal(extraction.report.forms[0].title, "Main");
    assert.equal(extraction.fields.length, 1);
    await extraction.dispose();
  } finally {
    await cleanup(value);
  }
});

test("the per-session world is main-frame authoritative and child-frame inert with a frozen private retrieval point", async () => {
  const value = await fixture(`<!doctype html><html><body>
    <form aria-label="Main"><label>Main<input></label></form>
    <iframe srcdoc='<!doctype html><form aria-label="Child"><label>Child<input></label></form>'></iframe>
  </body></html>`);
  const cdp = await value.context.newCDPSession(value.page);
  try {
    const contexts: Array<{
      id: number;
      name: string;
      auxData?: { frameId?: string };
    }> = [];
    cdp.on("Runtime.executionContextCreated", ({ context }) => {
      contexts.push(context as typeof contexts[number]);
    });
    await cdp.send("Runtime.enable");
    const frameTree = await cdp.send("Page.getFrameTree");
    const mainFrameId = frameTree.frameTree.frame.id;
    const childFrameId = frameTree.frameTree.childFrames?.[0]?.frame.id;
    assert.ok(childFrameId);
    const protectedContexts = contexts.filter((context) =>
      context.name.startsWith("apply-pilot-protected-")
    );
    const main = protectedContexts.find((context) => context.auxData?.frameId === mainFrameId);
    const child = protectedContexts.find((context) => context.auxData?.frameId === childFrameId);
    assert.ok(main);
    assert.ok(child);
    assert.equal(main.name, child.name);

    const inspect = (contextId: number) => cdp.send("Runtime.evaluate", {
      contextId,
      returnByValue: true,
      expression: `(() => {
        const descriptor = Object.getOwnPropertyDescriptor(globalThis, ${JSON.stringify(PROTECTED_BROWSER_CAPABILITY_PROPERTY)});
        const capability = globalThis[${JSON.stringify(PROTECTED_BROWSER_CAPABILITY_PROPERTY)}];
        return {
          hasCapability: typeof capability === "object" && capability !== null,
          descriptor: descriptor ? {
            configurable: descriptor.configurable,
            enumerable: descriptor.enumerable,
            writable: descriptor.writable
          } : null,
          frozen: capability ? Object.isFrozen(capability) : false,
          version: capability?.version ?? null,
          enumerableMethods: capability ? Object.keys(capability) : [],
          ownNames: capability ? Object.getOwnPropertyNames(capability).sort() : []
        };
      })()`
    });
    const mainProbe = (await inspect(main.id)).result.value as Record<string, unknown>;
    const childProbe = (await inspect(child.id)).result.value as Record<string, unknown>;
    assert.deepEqual(mainProbe, {
      hasCapability: true,
      descriptor: { configurable: false, enumerable: false, writable: false },
      frozen: true,
      version: 1,
      enumerableMethods: [],
      ownNames: ["version", ...PROTECTED_BROWSER_CAPABILITY_METHODS].sort()
    });
    assert.deepEqual(childProbe, {
      hasCapability: false,
      descriptor: null,
      frozen: false,
      version: null,
      enumerableMethods: [],
      ownNames: []
    });
  } finally {
    await cdp.detach();
    await cleanup(value);
  }
});
