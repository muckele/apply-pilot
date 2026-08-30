import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { chromium, type Browser, type Page } from "playwright";

import {
  ApplicationFormInspectionControllerError,
  createApplicationFormInspectionController,
  type ApplicationFormInspectionController
} from "@/lib/application-browser/form-inspection-controller";
import {
  createSyntheticFixturePage,
  privacyFixture,
  readFormInspectionTraps
} from "@/tests/browser/form-inspection-fixtures";
import {
  APPLICANT_STATE_FORM_HTML,
  CSSOM_FORM_HTML,
  OPEN_SHADOW_FORM_HTML,
  SEMANTIC_SURFACE_FORM_HTML,
  SHADOW_ROOT_LIFETIME_FORM_HTML,
  STABLE_FORM_HTML,
  startFormInspectionStabilityServer
} from "@/tests/browser/form-inspection-stability-fixtures";

let browser: Browser;
let fixtureServer: Awaited<ReturnType<typeof startFormInspectionStabilityServer>>;

before(async () => {
  browser = await chromium.launch({ headless: true });
  fixtureServer = await startFormInspectionStabilityServer();
});

after(async () => {
  await fixtureServer.close();
  await browser.close();
});

function controllerFor(page: Page, onInvalidated?: (code: string) => void) {
  return createApplicationFormInspectionController({
    page,
    authoritativeApplyHost: "employer.example.test",
    onInvalidated
  });
}

async function pageWith(html: string): Promise<Page> {
  const page = await browser.newPage();
  await page.setContent(html);
  return page;
}

function hasControllerCode(code: string) {
  return (error: unknown): boolean =>
    error instanceof ApplicationFormInspectionControllerError && error.code === code;
}

async function waitForNoCurrent(controller: ApplicationFormInspectionController): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (controller.current() !== null && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(controller.current() === null, true);
}

test("stable double extraction accepts canonical live handles and repeated disposal", async () => {
  const page = await pageWith(STABLE_FORM_HTML);
  const controller = controllerFor(page);
  try {
    const generation = await controller.inspect();
    assert.equal(controller.current(), generation);
    assert.equal(generation.fields.size, 1);
    const [{ handle }] = [...generation.fields.values()];
    assert.equal(await handle.evaluate((element) => (element as HTMLElement).id), "full-name");
    const firstDisposal = generation.dispose();
    assert.equal(controller.current(), null);
    await Promise.all([firstDisposal, generation.dispose(), generation.dispose()]);
  } finally {
    await controller.close();
    await page.close();
  }
});

test("semantic mutation during the quiet window delays acceptance until stable", async () => {
  const page = await pageWith(STABLE_FORM_HTML);
  const controller = controllerFor(page);
  try {
    await page.evaluate(() => {
      setTimeout([() => {
        const label = document.querySelector("label[for='full-name']");
        if (label) label.textContent = "Legal name";
      }][0], 150);
    });
    const started = Date.now();
    const generation = await controller.inspect();
    assert.ok(Date.now() - started >= 850);
    assert.equal(generation.inspectionReport.forms[0].sections[0].fields[0].question, "Legal name");
  } finally {
    await controller.close();
    await page.close();
  }
});

test("semantic mutation between extraction A and B retries", async () => {
  const page = await pageWith(STABLE_FORM_HTML);
  const controller = controllerFor(page);
  try {
    await page.evaluate(() => {
      setTimeout([() => {
        const label = document.querySelector("label[for='full-name']");
        if (label) label.textContent = "Preferred full name";
      }][0], 620);
    });
    const generation = await controller.inspect();
    assert.equal(
      generation.inspectionReport.forms[0].sections[0].fields[0].question,
      "Preferred full name"
    );
  } finally {
    await controller.close();
    await page.close();
  }
});

test("unrelated live-clock churn does not reset targeted semantic quiet", async () => {
  const page = await pageWith(SEMANTIC_SURFACE_FORM_HTML);
  const controller = controllerFor(page);
  let interval: unknown;
  try {
    interval = await page.evaluate(() => window.setInterval([() => {
      const clock = document.getElementById("unrelated-clock");
      if (clock) clock.textContent = String(Date.now());
      document.querySelector("[data-unrelated-toast]")?.remove();
      const toast = document.createElement("span");
      toast.setAttribute("data-unrelated-toast", "");
      toast.textContent = "Unrelated notification";
      document.body.append(toast);
    }][0], 25));
    const generation = await controller.inspect();
    assert.equal(controller.current(), generation);
  } finally {
    if (typeof interval === "number") {
      await page.evaluate((timer) => window.clearInterval(timer), interval);
    }
    await controller.close();
    await page.close();
  }
});

test("continual unrelated button text churn does not prevent targeted quiet", { timeout: 15_000 }, async () => {
  const page = await pageWith(STABLE_FORM_HTML.replace(
    "</body>",
    "<aside><button id='unrelated-button' type='button'>Unrelated A</button></aside></body>"
  ));
  const controller = controllerFor(page);
  const interval = await page.evaluate(() => window.setInterval([() => {
    const button = document.getElementById("unrelated-button");
    if (button) button.textContent = button.textContent === "Unrelated A" ? "Unrelated B" : "Unrelated A";
  }][0], 25));
  try {
    const generation = await controller.inspect();
    assert.equal(controller.current(), generation);
  } finally {
    await page.evaluate((timer) => window.clearInterval(timer), interval);
    await controller.close();
    await page.close();
  }
});

test("continual unrelated role animation signals do not prevent targeted quiet", { timeout: 15_000 }, async () => {
  const page = await pageWith(STABLE_FORM_HTML.replace(
    "</body>",
    "<aside id='unrelated-widget' role='button' tabindex='0'>Unrelated widget</aside></body>"
  ));
  const controller = controllerFor(page);
  const interval = await page.evaluate(() => window.setInterval([() => {
    const widget = document.getElementById("unrelated-widget");
    widget?.dispatchEvent(new AnimationEvent("animationiteration", { bubbles: true }));
    widget?.dispatchEvent(new TransitionEvent("transitionrun", { bubbles: true }));
  }][0], 25));
  try {
    const generation = await controller.inspect();
    assert.equal(controller.current(), generation);
  } finally {
    await page.evaluate((timer) => window.clearInterval(timer), interval);
    await controller.close();
    await page.close();
  }
});

test("relevant form role control mutation still invalidates", async () => {
  const page = await pageWith(STABLE_FORM_HTML.replace(
    "</form>",
    "<div id='relevant-role-control' role='combobox' tabindex='0' aria-label='Office'></div></form>"
  ));
  const invalidations: string[] = [];
  const controller = controllerFor(page, (code) => invalidations.push(code));
  try {
    await controller.inspect();
    await page.evaluate(() => {
      document.getElementById("relevant-role-control")?.setAttribute("aria-label", "Preferred office");
    });
    await waitForNoCurrent(controller);
    assert.deepEqual(invalidations, ["REINSPECTION_REQUIRED"]);
  } finally {
    await controller.close();
    await page.close();
  }
});

test("new relevant form subtree is detected", async () => {
  const page = await pageWith(STABLE_FORM_HTML);
  const invalidations: string[] = [];
  const controller = controllerFor(page, (code) => invalidations.push(code));
  try {
    await controller.inspect();
    await page.evaluate(() => {
      const form = document.createElement("form");
      form.innerHTML = "<label for='late-relevant-field'>Portfolio</label><input id='late-relevant-field' name='portfolio'>";
      document.body.append(form);
    });
    await waitForNoCurrent(controller);
    assert.deepEqual(invalidations, ["REINSPECTION_REQUIRED"]);
  } finally {
    await controller.close();
    await page.close();
  }
});

test("new ownerless question control is detected as a structural change", async () => {
  const page = await pageWith(STABLE_FORM_HTML);
  const invalidations: string[] = [];
  const controller = controllerFor(page, (code) => invalidations.push(code));
  try {
    await controller.inspect();
    await page.evaluate(() => {
      const field = document.createElement("input");
      field.setAttribute("aria-label", "Unexpected ownerless question");
      document.body.append(field);
    });
    await waitForNoCurrent(controller);
    assert.deepEqual(invalidations, ["REINSPECTION_REQUIRED"]);
  } finally {
    await controller.close();
    await page.close();
  }
});

test("continual relevant churn reaches the single stabilization timeout", { timeout: 15_000 }, async () => {
  const page = await pageWith(STABLE_FORM_HTML);
  const controller = controllerFor(page);
  const interval = await page.evaluate(() => window.setInterval([() => {
    const label = document.querySelector("label[for='full-name']");
    if (label) label.textContent = label.textContent === "Name A" ? "Name B" : "Name A";
  }][0], 50));
  try {
    await assert.rejects(controller.inspect(), hasControllerCode("FORM_STABILITY_TIMEOUT"));
    assert.equal(controller.current(), null);
  } finally {
    await page.evaluate((timer) => window.clearInterval(timer), interval);
    await controller.close();
    await page.close();
  }
});

const semanticMutationCases: ReadonlyArray<Readonly<{
  name: string;
  mutate(page: Page): Promise<unknown>;
}>> = [
  { name: "field addition", mutate: (page) => page.evaluate(() => {
    const field = document.createElement("input");
    field.setAttribute("aria-label", "New field");
    document.getElementById("primary-form")?.append(field);
  }) },
  { name: "field removal", mutate: (page) => page.evaluate(() => document.getElementById("name")?.remove()) },
  { name: "label text", mutate: (page) => page.evaluate(() => {
    const label = document.getElementById("name-label");
    if (label) label.textContent = "Changed label";
  }) },
  { name: "help text", mutate: (page) => page.evaluate(() => {
    const help = document.getElementById("name-help");
    if (help) help.textContent = "Changed help";
  }) },
  { name: "legend text", mutate: (page) => page.evaluate(() => {
    const legend = document.getElementById("identity-legend");
    if (legend) legend.textContent = "Changed legend";
  }) },
  { name: "required attribute", mutate: (page) => page.evaluate(() =>
    document.getElementById("name")?.removeAttribute("required")) },
  { name: "fieldset disabled state", mutate: (page) => page.evaluate(() =>
    document.getElementById("identity-group")?.setAttribute("disabled", "")) },
  { name: "option label", mutate: (page) => page.evaluate(() => {
    const option = document.getElementById("us-option");
    if (option) option.textContent = "USA";
  }) },
  { name: "optgroup disabled state", mutate: (page) => page.evaluate(() =>
    document.getElementById("americas")?.setAttribute("disabled", "")) },
  { name: "external form ownership", mutate: (page) => page.evaluate(() =>
    document.getElementById("external-field")?.setAttribute("form", "missing-form")) },
  { name: "ancestor visibility class", mutate: (page) => page.evaluate(() =>
    document.getElementById("location-group")?.classList.add("hidden-by-test")) }
];

test("targeted semantic surfaces invalidate without automatic regeneration", async (context) => {
  for (const mutationCase of semanticMutationCases) {
    await context.test(mutationCase.name, async () => {
      const page = await pageWith(SEMANTIC_SURFACE_FORM_HTML);
      const invalidations: string[] = [];
      const controller = controllerFor(page, (code) => invalidations.push(code));
      try {
        await controller.inspect();
        await mutationCase.mutate(page);
        await waitForNoCurrent(controller);
        assert.deepEqual(invalidations, ["REINSPECTION_REQUIRED"]);
      } finally {
        await controller.close();
        await page.close();
      }
    });
  }
});

for (const relation of ["aria-describedby", "aria-labelledby"] as const) {
  test(`external ${relation} character data invalidates immediately`, { timeout: 5_000 }, async () => {
    const accessibleName = relation === "aria-describedby"
      ? "<label for='aria-field'>Full name</label>"
      : "";
    const page = await pageWith(`<!doctype html>
      <form>
        ${accessibleName}
        <input id="aria-field" name="full_name" ${relation}="external-reference">
      </form>
      <div id="external-reference">Original external text</div>`);
    const invalidations: string[] = [];
    const controller = controllerFor(page, (code) => invalidations.push(code));
    let currentAfterMutation: ReturnType<typeof controller.current> = null;
    try {
      await controller.inspect();
      await page.evaluate(() => {
        const reference = document.getElementById("external-reference");
        if (!(reference?.firstChild instanceof Text)) {
          throw new Error("ARIA reference fixture has no text node.");
        }
        reference.firstChild.data = "Changed external text";
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      currentAfterMutation = controller.current();
    } finally {
      await controller.close();
      await page.close();
    }
    assert.equal(currentAfterMutation === null, true);
    assert.deepEqual(invalidations, ["REINSPECTION_REQUIRED"]);
  });
}

test("existing open-shadow semantic mutation invalidates", async () => {
  const page = await pageWith(OPEN_SHADOW_FORM_HTML);
  const invalidations: string[] = [];
  const controller = controllerFor(page, (code) => invalidations.push(code));
  try {
    await controller.inspect();
    await page.evaluate(() => {
      const root = document.getElementById("existing-shadow-host")?.shadowRoot;
      const button = document.createElement("button");
      button.textContent = "Unexpected action";
      root?.append(button);
    });
    await waitForNoCurrent(controller);
    assert.deepEqual(invalidations, ["REINSPECTION_REQUIRED"]);
  } finally {
    await controller.close();
    await page.close();
  }
});

test("large inserted subtree does not materialize observer candidates and retains relevant shadow discovery", { timeout: 20_000 }, async () => {
  const page = await pageWith(STABLE_FORM_HTML);
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const invalidations: string[] = [];
  const controller = controllerFor(page, (code) => invalidations.push(code));
  try {
    await controller.inspect();
    await page.evaluate(() => {
      const inserted = document.createElement("section");
      inserted.id = "large-inserted-subtree";
      const form = document.createElement("form");
      form.innerHTML = "<label for='large-tree-field'>Large-tree field</label><input id='large-tree-field' name='large_tree'><application-large-tree id='large-tree-shadow-host'></application-large-tree>";
      inserted.append(form);
      const padding = document.createElement("div");
      padding.id = "large-tree-padding";
      for (let index = 0; index < 75_000; index += 1) {
        padding.append(document.createElement("span"));
      }
      inserted.append(padding);
      const host = form.querySelector("#large-tree-shadow-host");
      host?.attachShadow({ mode: "open" }).append(document.createElement("span"));
      document.body.append(inserted);
    });
    await waitForNoCurrent(controller);
    assert.deepEqual(pageErrors, []);
    assert.deepEqual(invalidations, ["REINSPECTION_REQUIRED"]);

    await page.evaluate(() => document.getElementById("large-tree-padding")?.remove());
    const generation = await controller.inspect();
    assert.equal(generation.fields.size, 2);
    await page.evaluate(() => {
      const root = document.getElementById("large-tree-shadow-host")?.shadowRoot;
      const button = document.createElement("button");
      button.textContent = "Relevant nested action";
      root?.append(button);
    });
    await waitForNoCurrent(controller);
    assert.deepEqual(invalidations, ["REINSPECTION_REQUIRED", "REINSPECTION_REQUIRED"]);
  } finally {
    await controller.close();
    await page.close();
  }
});

test("deep nested open-shadow discovery is iterative", { timeout: 20_000 }, async () => {
  const page = await pageWith(STABLE_FORM_HTML.replace(
    "</form>",
    "<application-shadow-depth id='shadow-depth-root'></application-shadow-depth></form>"
  ));
  await page.evaluate(() => {
    let host = document.getElementById("shadow-depth-root");
    for (let depth = 0; depth < 2_000; depth += 1) {
      const root = host?.attachShadow({ mode: "open" });
      const next = document.createElement("application-shadow-depth");
      root?.append(next);
      host = next;
    }
    host?.attachShadow({ mode: "open" }).append(document.createElement("span"));
  });
  const invalidations: string[] = [];
  const controller = controllerFor(page, (code) => invalidations.push(code));
  try {
    await controller.inspect();
    await page.evaluate(() => {
      let root = document.getElementById("shadow-depth-root")?.shadowRoot ?? null;
      while (root?.firstElementChild?.shadowRoot) root = root.firstElementChild.shadowRoot;
      const button = document.createElement("button");
      button.textContent = "Deep relevant mutation";
      root?.append(button);
    });
    await waitForNoCurrent(controller);
    assert.deepEqual(invalidations, ["REINSPECTION_REQUIRED"]);
  } finally {
    await controller.close();
    await page.close();
  }
});

test("detached historical shadow root cannot invalidate a later generation", async () => {
  const page = await pageWith(SHADOW_ROOT_LIFETIME_FORM_HTML);
  const invalidations: string[] = [];
  const controller = controllerFor(page, (code) => invalidations.push(code));
  try {
    await controller.inspect();
    await page.evaluate(() => {
      const host = document.getElementById("historical-shadow-host");
      (window as typeof window & { historicalDetachedRoot?: ShadowRoot }).historicalDetachedRoot = host?.shadowRoot ?? undefined;
      host?.remove();
    });
    await waitForNoCurrent(controller);
    const generationB = await controller.inspect();

    await page.evaluate(() => {
      const root = (window as typeof window & { historicalDetachedRoot?: ShadowRoot }).historicalDetachedRoot;
      const button = document.createElement("button");
      button.textContent = "Detached historical action";
      root?.append(button);
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(controller.current() === generationB, true);
    assert.deepEqual(invalidations, ["REINSPECTION_REQUIRED"]);

    await page.evaluate(() => {
      const root = document.getElementById("current-shadow-host")?.shadowRoot;
      const button = document.createElement("button");
      button.textContent = "Current relevant action";
      root?.append(button);
    });
    await waitForNoCurrent(controller);
    assert.deepEqual(invalidations, ["REINSPECTION_REQUIRED", "REINSPECTION_REQUIRED"]);
  } finally {
    await controller.close();
    await page.close();
  }
});

test("repeated shadow add-remove-reinspect cycles do not retain historical roots", async () => {
  const page = await pageWith(STABLE_FORM_HTML);
  const invalidations: string[] = [];
  const controller = controllerFor(page, (code) => invalidations.push(code));
  try {
    let currentGeneration = await controller.inspect();
    for (let cycle = 0; cycle < 3; cycle += 1) {
      await page.evaluate((cycleNumber) => {
        const host = document.createElement("application-cycle-shadow");
        host.id = `cycle-shadow-${cycleNumber}`;
        host.setAttribute("role", "combobox");
        host.setAttribute("tabindex", "0");
        host.setAttribute("aria-label", `Cycle office ${cycleNumber}`);
        host.attachShadow({ mode: "open" }).innerHTML = "<span>Cycle passive note</span>";
        document.querySelector("form")?.append(host);
      }, cycle);
      await waitForNoCurrent(controller);
      currentGeneration = await controller.inspect();
      await page.evaluate((cycleNumber) => {
        const host = document.getElementById(`cycle-shadow-${cycleNumber}`);
        const roots = ((window as typeof window & { cycleDetachedRoots?: ShadowRoot[] }).cycleDetachedRoots ??= []);
        if (host?.shadowRoot) roots.push(host.shadowRoot);
        host?.remove();
      }, cycle);
      await waitForNoCurrent(controller);
      currentGeneration = await controller.inspect();
      await page.evaluate((cycleNumber) => {
        const root = (window as typeof window & { cycleDetachedRoots?: ShadowRoot[] }).cycleDetachedRoots?.[cycleNumber];
        const button = document.createElement("button");
        button.textContent = `Detached cycle ${cycleNumber}`;
        root?.append(button);
      }, cycle);
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(controller.current() === currentGeneration, true);
    }
    assert.deepEqual(invalidations, Array.from({ length: 6 }, () => "REINSPECTION_REQUIRED"));
  } finally {
    await controller.close();
    await page.close();
  }
});

test("stylesheet load is treated as a semantic-risk signal", async () => {
  const page = await pageWith(STABLE_FORM_HTML.replace(
    "</head>",
    "<link id='employer-styles' rel='stylesheet'></head>"
  ));
  const invalidations: string[] = [];
  const controller = controllerFor(page, (code) => invalidations.push(code));
  try {
    await controller.inspect();
    await page.evaluate(() => {
      document.getElementById("employer-styles")?.dispatchEvent(new Event("load"));
    });
    await waitForNoCurrent(controller);
    assert.deepEqual(invalidations, ["REINSPECTION_REQUIRED"]);
  } finally {
    await controller.close();
    await page.close();
  }
});

test("pure textarea and represented contenteditable current text does not invalidate", async () => {
  const page = await pageWith(`<!doctype html>
    <form>
      <label for="summary">Summary</label>
      <textarea id="summary" name="summary"></textarea>
      <div role="textbox" contenteditable="true" aria-label="Notes">Initial</div>
    </form>`);
  const controller = controllerFor(page);
  try {
    const generation = await controller.inspect();
    await page.evaluate(() => {
      const textarea = document.getElementById("summary");
      if (textarea) textarea.textContent = "Applicant text";
      const editable = document.querySelector("[contenteditable]");
      if (editable) editable.textContent = "Applicant rich text";
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(controller.current(), generation);
    assert.equal(await controller.assertCurrent(generation.generationId), generation);
  } finally {
    await controller.close();
    await page.close();
  }
});

test("late attachShadow gap is closed by strong assertCurrent", async () => {
  const page = await pageWith(STABLE_FORM_HTML.replace(
    "</form>",
    "<application-late id='late-host'></application-late></form>"
  ));
  const invalidations: string[] = [];
  const controller = controllerFor(page, (code) => invalidations.push(code));
  try {
    const generation = await controller.inspect();
    await page.evaluate(() => {
      const root = document.getElementById("late-host")?.attachShadow({ mode: "open" });
      const button = document.createElement("button");
      button.textContent = "Late interaction";
      root?.append(button);
    });
    assert.equal(controller.current(), generation);
    await assert.rejects(
      controller.assertCurrent(generation.generationId),
      hasControllerCode("FORM_GENERATION_INVALIDATED")
    );
    assert.deepEqual(invalidations, ["REINSPECTION_REQUIRED"]);
  } finally {
    await controller.close();
    await page.close();
  }
});

test("direct CSSOM stale semantics are closed by strong assertCurrent", async () => {
  const page = await pageWith(CSSOM_FORM_HTML);
  const invalidations: string[] = [];
  const controller = controllerFor(page, (code) => invalidations.push(code));
  try {
    const generation = await controller.inspect();
    await page.evaluate(() => {
      const sheet = document.styleSheets[0] as CSSStyleSheet;
      sheet.insertRule(".cssom-target { display: none !important; }", sheet.cssRules.length);
    });
    assert.equal(controller.current(), generation);
    await assert.rejects(
      controller.assertCurrent(generation.generationId),
      hasControllerCode("FORM_GENERATION_INVALIDATED")
    );
    assert.deepEqual(invalidations, ["REINSPECTION_REQUIRED"]);
  } finally {
    await controller.close();
    await page.close();
  }
});

test("applicant input with no semantic effect preserves the same generation", async () => {
  const page = await pageWith(STABLE_FORM_HTML);
  const controller = controllerFor(page);
  try {
    const generation = await controller.inspect();
    await page.evaluate(() => {
      const field = document.getElementById("full-name") as HTMLInputElement;
      field.value = "Ada Lovelace";
      field.dispatchEvent(new Event("input", { bubbles: true }));
      field.dispatchEvent(new Event("change", { bubbles: true }));
    });
    assert.equal(controller.current(), generation);
    assert.equal(await controller.assertCurrent(generation.generationId), generation);
  } finally {
    await controller.close();
    await page.close();
  }
});

test("applicant checked state with indirect CSS semantics invalidates strongly", async () => {
  const page = await pageWith(APPLICANT_STATE_FORM_HTML);
  const invalidations: string[] = [];
  const controller = controllerFor(page, (code) => invalidations.push(code));
  try {
    const generation = await controller.inspect();
    await page.evaluate(() => {
      const field = document.getElementById("reveal") as HTMLInputElement;
      field.checked = true;
      field.dispatchEvent(new Event("input", { bubbles: true }));
      field.dispatchEvent(new Event("change", { bubbles: true }));
    });
    assert.equal(controller.current(), generation);
    await assert.rejects(
      controller.assertCurrent(generation.generationId),
      hasControllerCode("FORM_GENERATION_INVALIDATED")
    );
    assert.equal(controller.current(), null);
    assert.deepEqual(invalidations, ["REINSPECTION_REQUIRED"]);
  } finally {
    await controller.close();
    await page.close();
  }
});

test("semantically equivalent node replacement cannot rebind the old generation", async () => {
  const page = await pageWith(STABLE_FORM_HTML);
  const controller = controllerFor(page);
  try {
    const oldGeneration = await controller.inspect();
    await page.evaluate(() => {
      const oldField = document.getElementById("full-name");
      oldField?.replaceWith(oldField.cloneNode(true));
    });
    await waitForNoCurrent(controller);
    await assert.rejects(
      controller.assertCurrent(oldGeneration.generationId),
      hasControllerCode("FORM_GENERATION_INVALIDATED")
    );
    const replacement = await controller.inspect();
    assert.notEqual(replacement.generationId, oldGeneration.generationId);
    assert.notEqual(
      [...replacement.fields.values()][0].handle,
      [...oldGeneration.fields.values()][0].handle
    );
  } finally {
    await controller.close();
    await page.close();
  }
});

test("caller-disposed public field handle invalidates with a bounded controller error", async () => {
  const page = await pageWith(STABLE_FORM_HTML);
  const invalidations: string[] = [];
  const controller = controllerFor(page, (code) => invalidations.push(code));
  try {
    const generation = await controller.inspect();
    await [...generation.fields.values()][0].handle.dispose();

    await assert.rejects(
      controller.assertCurrent(generation.generationId),
      hasControllerCode("FORM_GENERATION_INVALIDATED")
    );
    assert.equal(controller.current(), null);
    assert.deepEqual(invalidations, ["REINSPECTION_REQUIRED"]);
  } finally {
    await controller.close();
    await page.close();
  }
});

test("caller-disposed public choice handle invalidates with a bounded controller error", async () => {
  const page = await pageWith(SEMANTIC_SURFACE_FORM_HTML);
  const invalidations: string[] = [];
  const controller = controllerFor(page, (code) => invalidations.push(code));
  try {
    const generation = await controller.inspect();
    const choice = [...generation.choices.values()].flatMap((choices) => [...choices.values()])[0];
    assert.ok(choice);
    await choice.handle.dispose();

    await assert.rejects(
      controller.assertCurrent(generation.generationId),
      hasControllerCode("FORM_GENERATION_INVALIDATED")
    );
    assert.equal(controller.current(), null);
    assert.deepEqual(invalidations, ["REINSPECTION_REQUIRED"]);
  } finally {
    await controller.close();
    await page.close();
  }
});

test("an original field adopted into another document cannot remain current", async () => {
  const page = await pageWith(STABLE_FORM_HTML.replace(
    "</body>",
    "<iframe id='unrelated-frame'></iframe></body>"
  ));
  const invalidations: string[] = [];
  const controller = controllerFor(page, (code) => invalidations.push(code));
  try {
    const generation = await controller.inspect();
    await page.evaluate(() => {
      const original = document.getElementById("full-name");
      const frame = document.getElementById("unrelated-frame") as HTMLIFrameElement;
      if (!original || !frame.contentDocument) throw new Error("Adoption fixture is incomplete.");
      original.replaceWith(original.cloneNode(true));
      frame.contentDocument.body.append(original);
    });

    await assert.rejects(
      controller.assertCurrent(generation.generationId),
      hasControllerCode("FORM_GENERATION_INVALIDATED")
    );
    assert.equal(controller.current(), null);
    assert.deepEqual(invalidations, ["REINSPECTION_REQUIRED"]);
  } finally {
    await controller.close();
    await page.close();
  }
});

const historyCases = ["pushState", "replaceState", "fragment"] as const;

test("History API and fragment lifecycle changes invalidate", async (context) => {
  for (const historyCase of historyCases) {
    await context.test(historyCase, async () => {
      const page = await browser.newPage();
      await page.goto(`${fixtureServer.origin}/stable`);
      const invalidations: string[] = [];
      const controller = controllerFor(page, (code) => invalidations.push(code));
      try {
        await controller.inspect();
        await page.evaluate((operation) => {
          if (operation === "pushState") history.pushState({}, "", "/pushed");
          if (operation === "replaceState") history.replaceState({}, "", "/replaced");
          if (operation === "fragment") location.hash = "changed";
        }, historyCase);
        await waitForNoCurrent(controller);
        assert.deepEqual(invalidations, ["TARGET_NAVIGATED"]);
      } finally {
        await controller.close();
        await page.close();
      }
    });
  }
});

test("top-frame reload and path navigation invalidate", async (context) => {
  for (const operation of ["reload", "path"] as const) {
    await context.test(operation, async () => {
      const page = await browser.newPage();
      await page.goto(`${fixtureServer.origin}/stable`);
      const invalidations: string[] = [];
      const controller = controllerFor(page, (code) => invalidations.push(code));
      try {
        await controller.inspect();
        if (operation === "reload") await page.reload();
        else await page.goto(`${fixtureServer.origin}/other`);
        await waitForNoCurrent(controller);
        assert.deepEqual(invalidations, ["TARGET_NAVIGATED"]);
      } finally {
        await controller.close();
        await page.close();
      }
    });
  }
});

test("page close disposes and permanently cancels the controller", async () => {
  const page = await pageWith(STABLE_FORM_HTML);
  const invalidations: string[] = [];
  const controller = controllerFor(page, (code) => invalidations.push(code));
  await controller.inspect();
  await page.close();
  assert.equal(controller.current(), null);
  assert.deepEqual(invalidations, ["PAGE_CLOSED"]);
  await assert.rejects(controller.inspect(), hasControllerCode("FORM_INSPECTION_CANCELLED"));
  await controller.close();
});

test("controller reads no applicant current values and performs zero employer mutation", async () => {
  const page = await createSyntheticFixturePage(browser, privacyFixture());
  const controller = controllerFor(page);
  try {
    const generation = await controller.inspect();
    assert.equal(await controller.assertCurrent(generation.generationId), generation);
    await generation.dispose();
    const traps = await readFormInspectionTraps(page);
    assert.equal(traps.inputValue, 0);
    assert.equal(traps.textAreaValue, 0);
    assert.equal(traps.selectValue, 0);
    assert.equal(traps.checked, 0);
    assert.equal(traps.optionSelected, 0);
    assert.equal(traps.files, 0);
    assert.equal(traps.hiddenValue, 0);
    assert.equal(traps.passwordValue, 0);
    assert.equal(traps.mutations, 0);
    assert.equal(traps.submissions, 0);
    assert.deepEqual(traps.events, {
      click: 0,
      keydown: 0,
      beforeinput: 0,
      input: 0,
      change: 0,
      submit: 0,
      formdata: 0
    });
  } finally {
    await controller.close();
    await page.close();
  }
});
