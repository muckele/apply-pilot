import "@/tests/fixtures/dom-globals";
import assert from "node:assert/strict";
import test from "node:test";
import React from "react";

import { TailorFlow, type TailorFlowProps } from "@/components/job-workspace/tailor-flow";
import { buildEvidenceCorrectionReview } from "@/lib/jobs/evidence-correction-review";
import type { DocumentCreationQuote } from "@/lib/jobs/document-creation-plan";
import { createDomHarness } from "@/tests/fixtures/dom-harness";

const resume = {
  rawText: ["SUMMARY", "Service operations leader with twelve years of experience.", "CERTIFICATIONS", "Operations Certificate | 480 hours"].join("\n"),
  summary: "Service operations leader with twelve years of experience.",
  skills: ["Operations: Incident governance"],
  achievements: [],
  workHistory: [],
  projects: [],
  education: [],
  certifications: [{ sourceText: "Operations Certificate | 480 hours", name: "Operations Certificate" }]
};

const analysisOutput = {
  contractVersion: "3",
  promptVersion: "3.4",
  requirementGaps: [
    { requirement: "Current Quenby certification", jobRequirement: { ref: "job.requirements[0]", excerpt: "Current Quenby certification" }, missingKeywords: ["Quenby"] },
    { requirement: "Working knowledge of SQL", jobRequirement: { ref: "job.requirements[5]", excerpt: "Working knowledge of SQL" }, missingKeywords: ["SQL"] }
  ]
};

function review(analysisId: string | null = "analysis-1") {
  return buildEvidenceCorrectionReview({
    jobId: "job-1",
    resumeId: "resume-1",
    resumeUpdatedAt: "2026-11-01T10:00:00.000Z",
    resume,
    analysisId,
    analysisInputHash: analysisId ? "a".repeat(64) : null,
    analysisModel: analysisId ? "gemini-3.8-flash" : null,
    analysisPromptVersion: analysisId ? "3.4" : null,
    analysisOutput: analysisId ? analysisOutput : null
  });
}

const quote: DocumentCreationQuote = {
  provider: "gemini", model: "gemini-3.8-flash", promptVersion: "12",
  jobMatchMicros: 72_720, resumeMicros: 64_500, coverMicros: 47_250
};

function props(overrides: Partial<TailorFlowProps> = {}): TailorFlowProps {
  return {
    jobId: "job-1",
    review: review(),
    hasValidCurrentSnapshot: false,
    readOnlyGaps: [],
    quote,
    generationAvailable: true,
    hasDocuments: false,
    // Most tests here exercise the cover-letter path; the product default is checked on its own below.
    coverLetterByDefault: true,
    ...overrides
  };
}

type Call = { url: string; confirmed: string | null; data: string | null; body: unknown };

function apiStub(calls: Call[], options: { failResume?: boolean } = {}) {
  const maxima: Record<string, number> = { match: 72_720, "tailored-resume": 64_500, "cover-letter": 47_250 };
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    const call = { url, confirmed: headers.get("x-ai-cost-confirmed"), data: headers.get("x-ai-data-confirmed"), body: init?.body ? JSON.parse(String(init.body)) : null };
    calls.push(call);
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.endsWith("/evidence-snapshots")) {
      return json(201, {
        schema: "apply-pilot/evidence-snapshot-save-response/v1",
        snapshot: { id: "snapshot-1", hash: "b".repeat(64), createdAt: "2026-11-05T12:00:00.000Z", isCurrent: true },
        replayed: false,
        invalidations: { assessmentIds: ["analysis-1"], resumeDocumentIds: [], coverLetterDocumentIds: [], totalCount: 1, reason: "EVIDENCE_SNAPSHOT_CHANGED" }
      });
    }
    const kind = url.split("/").at(-1)!;
    if (!call.confirmed) {
      return json(428, { code: "AI_COST_CONFIRMATION_REQUIRED", maximumCostMicros: maxima[kind], ...(kind === "match" ? {} : { dataType: "application_packet" }) });
    }
    if (kind === "tailored-resume" && options.failResume) return json(503, { error: "Gemini is busy. Nothing was charged.", billingStatus: "not_charged" });
    return json(200, { ok: true });
  }) as typeof fetch;
}

function gapFieldset(harness: ReturnType<typeof createDomHarness>, requirement: string) {
  const fieldset = [...harness.container.querySelectorAll("fieldset[data-gap]")].find((node) =>
    node.querySelector("legend")?.textContent?.includes(requirement));
  assert.ok(fieldset, `gap ${requirement}`);
  return fieldset;
}

function choice(fieldset: Element, label: RegExp) {
  const option = [...fieldset.querySelectorAll("label")].find((node) => label.test(node.textContent ?? ""));
  return option?.querySelector("input");
}

test("skipping every gap saves the review, never re-scores, and asks for one confirmation for both documents", async () => {
  const calls: Call[] = [];
  const prompts: string[] = [];
  const harness = createDomHarness({ fetch: apiStub(calls), confirm: (message) => { prompts.push(message); return true; } });
  try {
    await harness.render(React.createElement(TailorFlow, props()));
    assert.ok(choice(gapFieldset(harness, "Current Quenby certification"), /^Skip$/u)?.checked);
    await harness.click(harness.button("Create my résumé and cover letter"));
    await harness.waitForText(/ready to review/u);
    assert.equal(prompts.length, 1);
    assert.match(prompts[0]!, /up to \$0\.11175/u);
    assert.deepEqual(calls.map((call) => [call.url, call.confirmed]), [
      ["/api/jobs/job-1/evidence-snapshots", null],
      ["/api/jobs/job-1/tailored-resume", null],
      ["/api/jobs/job-1/tailored-resume", "true"],
      ["/api/jobs/job-1/cover-letter", null],
      ["/api/jobs/job-1/cover-letter", "true"]
    ]);
    const save = calls[0]!.body as { decisions: Array<{ kind: string }>; acceptedFactActions: unknown[]; schema: string; reviewedAnalysis: { id: string } };
    assert.equal(save.schema, "apply-pilot/evidence-snapshot-save/v2");
    assert.deepEqual(save.decisions.map((decision) => decision.kind), ["UNRESOLVED", "UNRESOLVED"]);
    assert.equal(save.reviewedAnalysis.id, "analysis-1");
    assert.equal(calls[2]!.data, "true");
    assert.ok(harness.refreshes >= 1);
  } finally {
    await harness.close();
  }
});

test("adding a line needs the attestation, then saves it, re-scores once and generates", async () => {
  const calls: Call[] = [];
  const prompts: string[] = [];
  const harness = createDomHarness({ fetch: apiStub(calls), confirm: (message) => { prompts.push(message); return true; } });
  try {
    await harness.render(React.createElement(TailorFlow, props()));
    const gap = gapFieldset(harness, "Current Quenby certification");
    await harness.click(choice(gap, /I have this/u));
    const create = harness.button("Create my résumé and cover letter");
    assert.equal(create.disabled, true);
    await harness.type(gap.querySelector("textarea"), "Earned the Quenby certification in 2024.");
    assert.equal(create.disabled, true, "attestation is required");
    await harness.check(gap.querySelector("input[type=checkbox]"));
    assert.equal(create.disabled, false);
    await harness.click(create);
    await harness.waitForText(/ready to review/u);
    assert.equal(prompts.length, 1);
    assert.match(prompts[0]!, /update your fit estimate/u);
    assert.match(prompts[0]!, /up to \$0\.18447/u);
    assert.deepEqual(calls.filter((call) => call.confirmed !== null || call.url.endsWith("snapshots")).map((call) => call.url.split("/").at(-1)), [
      "evidence-snapshots", "match", "tailored-resume", "cover-letter"
    ]);
    const decision = (calls[0]!.body as { decisions: Array<Record<string, unknown>> }).decisions[0]!;
    assert.deepEqual(decision, {
      gapId: "gap:0", kind: "OWNER_ATTESTATION", attestedFact: "Earned the Quenby certification in 2024.",
      ownerAttested: true, reuseScope: "JOB_ONLY", masterProfileOptIn: false
    });
  } finally {
    await harness.close();
  }
});

test("a gap already on the résumé cites the exact résumé line", async () => {
  const calls: Call[] = [];
  const harness = createDomHarness({ fetch: apiStub(calls), confirm: () => true });
  try {
    await harness.render(React.createElement(TailorFlow, props({ hasValidCurrentSnapshot: false })));
    const gap = gapFieldset(harness, "Working knowledge of SQL");
    await harness.click(choice(gap, /already on my résumé/u));
    await harness.type(gap.querySelector("select"), "Service operations leader with twelve years of experience.");
    await harness.click(harness.button("Create my résumé and cover letter"));
    await harness.waitForText(/ready to review/u);
    const decision = (calls[0]!.body as { decisions: Array<Record<string, unknown>> }).decisions[1]!;
    assert.deepEqual(decision, {
      gapId: "gap:1", kind: "SOURCE_CORRECTION", sourceFactId: "fact:resume.rawText",
      sourceExcerpt: "Service operations leader with twelve years of experience.",
      correctedFact: "Service operations leader with twelve years of experience.",
      reuseScope: "JOB_ONLY", masterProfileOptIn: false
    });
  } finally {
    await harness.close();
  }
});

test("declining the confirmation sends nothing", async () => {
  const calls: Call[] = [];
  const harness = createDomHarness({ fetch: apiStub(calls), confirm: () => false });
  try {
    await harness.render(React.createElement(TailorFlow, props()));
    await harness.click(harness.button("Create my résumé and cover letter"));
    await harness.waitForText(/Nothing was sent/u);
    assert.equal(calls.length, 0);
  } finally {
    await harness.close();
  }
});

test("a failed step stops the run and says what was already saved", async () => {
  const calls: Call[] = [];
  const harness = createDomHarness({ fetch: apiStub(calls, { failResume: true }), confirm: () => true });
  try {
    await harness.render(React.createElement(TailorFlow, props()));
    await harness.click(harness.button("Create my résumé and cover letter"));
    await harness.waitForText(/Gemini is busy/u);
    assert.match(harness.text(), /Your answers were saved/u);
    assert.equal(calls.some((call) => call.url.endsWith("/cover-letter")), false);
    assert.ok(harness.refreshes >= 1, "the saved review is shown after a partial run");
  } finally {
    await harness.close();
  }
});

test("an existing saved review with no changes generates directly", async () => {
  const calls: Call[] = [];
  const harness = createDomHarness({ fetch: apiStub(calls), confirm: () => true });
  try {
    await harness.render(React.createElement(TailorFlow, props({ hasValidCurrentSnapshot: true, hasDocuments: true })));
    await harness.click(harness.button("Create new versions"));
    await harness.waitForText(/ready to review/u);
    assert.deepEqual([...new Set(calls.map((call) => call.url.split("/").at(-1)))], ["tailored-resume", "cover-letter"]);
  } finally {
    await harness.close();
  }
});

test("an unscored job explains that scoring comes first and leaves the score action to the match card", async () => {
  const harness = createDomHarness({ fetch: apiStub([]) });
  try {
    await harness.render(React.createElement(TailorFlow, props({ review: review(null) })));
    assert.equal(Boolean(harness.maybeButton("Score this job")), false);
    assert.equal(harness.button("Create my résumé and cover letter").disabled, true);
    assert.match(harness.text(), /Score this job first/u);
  } finally {
    await harness.close();
  }
});

test("a carried estimate lists its gaps read-only and offers one way to check again", async () => {
  const harness = createDomHarness({ fetch: apiStub([]) });
  try {
    await harness.render(React.createElement(TailorFlow, props({
      review: review(null), hasValidCurrentSnapshot: true, readOnlyGaps: ["Current Quenby certification"]
    })));
    assert.match(harness.text(), /Current Quenby certification/u);
    assert.ok(harness.button("Check this job again"));
    assert.equal(harness.container.querySelectorAll("fieldset[data-gap]").length, 0);
    assert.equal(harness.button("Create my résumé and cover letter").disabled, false);
  } finally {
    await harness.close();
  }
});

test("the résumé-only choice drops the cover letter from the plan and the quote", async () => {
  const calls: Call[] = [];
  const prompts: string[] = [];
  const harness = createDomHarness({ fetch: apiStub(calls), confirm: (message) => { prompts.push(message); return true; } });
  try {
    await harness.render(React.createElement(TailorFlow, props()));
    const coverToggle = [...harness.container.querySelectorAll("label")].find((node) => /Include a cover letter/u.test(node.textContent ?? ""))?.querySelector("input");
    await harness.check(coverToggle, false);
    await harness.click(harness.button("Create my résumé"));
    await harness.waitForText(/ready to review/u);
    assert.match(prompts[0]!, /up to \$0\.0645/u);
    assert.equal(calls.some((call) => call.url.endsWith("/cover-letter")), false);
  } finally {
    await harness.close();
  }
});

test("the cover letter starts unticked: one click makes the résumé only, and ticking it adds the letter back", async () => {
  const calls: Call[] = [];
  const prompts: string[] = [];
  const harness = createDomHarness({ fetch: apiStub(calls), confirm: (message) => { prompts.push(message); return true; } });
  try {
    // What the job page renders: no coverLetterByDefault prop.
    await harness.render(React.createElement(TailorFlow, props({ coverLetterByDefault: undefined })));
    const coverToggle = () => [...harness.container.querySelectorAll("label")]
      .find((node) => /Include a cover letter/u.test(node.textContent ?? ""))?.querySelector("input");
    assert.equal(coverToggle()?.checked, false);
    assert.equal(harness.container.textContent?.includes("Apply Pilot writes a résumé for this job"), true);
    await harness.check(coverToggle(), true);
    assert.ok(harness.button("Create my résumé and cover letter"));
    await harness.check(coverToggle(), false);
    await harness.click(harness.button("Create my résumé"));
    await harness.waitForText(/ready to review/u);
    assert.match(prompts[0]!, /up to \$0\.0645/u);
    assert.equal(calls.some((call) => call.url.endsWith("/cover-letter")), false);
  } finally {
    await harness.close();
  }
});

// A job that already has a ready tailored résumé, with the saved review in force.
const readyResume: Partial<TailorFlowProps> = {
  hasValidCurrentSnapshot: true, hasDocuments: true, hasCurrentResume: true, coverLetterByDefault: undefined
};

function coverOnlyReason(harness: ReturnType<typeof createDomHarness>) {
  return harness.container.querySelector("[data-cover-only-reason]")?.textContent ?? null;
}

test("with a ready résumé and nothing changed, the cover letter alone takes one confirmation of its own maximum and calls only the cover-letter writer", async () => {
  const calls: Call[] = [];
  const prompts: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const stub = apiStub(calls);
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => { await gate; return stub(input, init); }) as typeof fetch;
  const harness = createDomHarness({ fetch: fetchImpl, confirm: (message) => { prompts.push(message); return true; } });
  try {
    await harness.render(React.createElement(TailorFlow, props(readyResume)));
    assert.equal(harness.button("Create new versions").disabled, false, "the main action is still there");
    const coverOnly = harness.button("Create cover letter only");
    assert.equal(coverOnly.disabled, false);
    assert.equal(coverOnlyReason(harness), null);
    assert.match(harness.container.querySelector("[data-cover-only]")?.textContent ?? "", /at most \$0\.05 in AI costs/u);
    await harness.click(coverOnly);
    assert.equal(harness.button("Create cover letter only").disabled, true, "disabled while it runs");
    assert.equal(harness.button("Create new versions").disabled, true, "nothing else starts while it runs");
    release();
    await harness.waitForText(/Your cover letter is ready to review below/u);
    assert.equal(prompts.length, 1);
    assert.match(prompts[0]!, /to write your cover letter\./u);
    assert.match(prompts[0]!, /1 AI request could cost up to \$0\.04725/u);
    assert.doesNotMatch(prompts[0]!, /tailored résumé|fit estimate/u);
    assert.deepEqual(calls.map((call) => [call.url, call.confirmed]), [
      ["/api/jobs/job-1/cover-letter", null],
      ["/api/jobs/job-1/cover-letter", "true"]
    ]);
    assert.equal(calls[1]!.data, "true");
    const progress = harness.container.querySelector("[aria-label=Progress]")?.textContent ?? "";
    assert.match(progress, /Writing your cover letter/u);
    assert.doesNotMatch(progress, /résumé|answers|fit estimate/u);
    assert.ok(harness.window.sessionStorage.getItem("apply-pilot:documents-created:job-1"), "the page scrolls to the new letter after the refresh");
    assert.ok(harness.refreshes >= 1);
  } finally {
    await harness.close();
  }
});

test("declining the cover-letter-only confirmation sends nothing", async () => {
  const calls: Call[] = [];
  const harness = createDomHarness({ fetch: apiStub(calls), confirm: () => false });
  try {
    await harness.render(React.createElement(TailorFlow, props(readyResume)));
    await harness.click(harness.button("Create cover letter only"));
    await harness.waitForText(/Nothing was sent/u);
    assert.equal(calls.length, 0);
  } finally {
    await harness.close();
  }
});

test("the cover letter alone is not offered until the job has a ready tailored résumé", async () => {
  for (const overrides of [{}, { hasValidCurrentSnapshot: true, hasDocuments: true }, { ...readyResume, hasCurrentResume: false }]) {
    const harness = createDomHarness({ fetch: apiStub([]) });
    try {
      await harness.render(React.createElement(TailorFlow, props(overrides)));
      assert.equal(harness.maybeButton("Create cover letter only"), undefined);
    } finally {
      await harness.close();
    }
  }
});

test("a changed line turns the cover letter alone off and says why; setting it back to Skip turns it on again", async () => {
  const harness = createDomHarness({ fetch: apiStub([]), confirm: () => true });
  try {
    await harness.render(React.createElement(TailorFlow, props(readyResume)));
    const coverOnly = () => harness.button("Create cover letter only");
    const gap = gapFieldset(harness, "Current Quenby certification");
    await harness.click(choice(gap, /I have this/u));
    assert.equal(coverOnly().disabled, true);
    await harness.type(gap.querySelector("textarea"), "Earned the Quenby certification in 2024.");
    await harness.check(gap.querySelector("input[type=checkbox]"));
    assert.equal(harness.button("Create new versions").disabled, false, "the main action still takes the new line");
    assert.equal(coverOnly().disabled, true);
    assert.match(coverOnlyReason(harness) ?? "", /changed lines above/u);
    await harness.click(choice(gap, /^Skip$/u));
    assert.equal(coverOnly().disabled, false);
    assert.equal(coverOnlyReason(harness), null);
  } finally {
    await harness.close();
  }
});

test("without a saved review, or with writing switched off, the cover letter alone stays disabled", async () => {
  const unsaved = createDomHarness({ fetch: apiStub([]) });
  try {
    await unsaved.render(React.createElement(TailorFlow, props({ ...readyResume, hasValidCurrentSnapshot: false })));
    assert.equal(unsaved.button("Create cover letter only").disabled, true);
    assert.equal(unsaved.button("Create new versions").disabled, false);
    assert.match(coverOnlyReason(unsaved) ?? "", /create both together/u);
  } finally {
    await unsaved.close();
  }
  const off = createDomHarness({ fetch: apiStub([]) });
  try {
    await off.render(React.createElement(TailorFlow, props({ ...readyResume, generationAvailable: false })));
    assert.equal(off.button("Create cover letter only").disabled, true);
    assert.match(off.text(), /Document writing is switched off/u);
  } finally {
    await off.close();
  }
});

test("the gap list never claims to be everything the résumé is missing", async () => {
  const harness = createDomHarness({ fetch: apiStub([]) });
  try {
    await harness.render(React.createElement(TailorFlow, props()));
    const intro = harness.container.querySelector("[data-gap-intro]")?.textContent ?? "";
    assert.match(intro, /may not flag every requirement/u);
    assert.match(intro, /years of experience/u);
  } finally {
    await harness.close();
  }
  const empty = createDomHarness({ fetch: apiStub([]) });
  try {
    const noGaps = buildEvidenceCorrectionReview({
      jobId: "job-1", resumeId: "resume-1", resumeUpdatedAt: "2026-11-01T10:00:00.000Z", resume, analysisId: "analysis-1",
      analysisInputHash: "a".repeat(64), analysisModel: "gemini-3.8-flash", analysisPromptVersion: "3.4",
      analysisOutput: { ...analysisOutput, requirementGaps: [] }
    });
    await empty.render(React.createElement(TailorFlow, props({ review: noGaps })));
    assert.doesNotMatch(empty.text(), /Every requirement/u);
    assert.match(empty.text(), /didn't flag any listed requirement/u);
  } finally {
    await empty.close();
  }
});

test("plain language: no internal jargon, and extracted facts stay behind a disclosure", async () => {
  const harness = createDomHarness({ fetch: apiStub([]) });
  try {
    await harness.render(React.createElement(TailorFlow, props()));
    assert.doesNotMatch(harness.text(), /immutable|snapshot|Correction-first|reassess|Build packet|provenance/iu);
    for (const overrides of [readyResume, { ...readyResume, hasValidCurrentSnapshot: false }]) {
      await harness.render(React.createElement(TailorFlow, props(overrides)));
      assert.ok(harness.maybeButton("Create cover letter only"));
      assert.doesNotMatch(harness.text(), /immutable|snapshot|Correction-first|reassess|Build packet|provenance/iu);
    }
    await harness.render(React.createElement(TailorFlow, props()));
    const facts = harness.container.querySelector("[data-extracted-facts]");
    assert.ok(facts?.closest("details"), "extracted facts are inside a <details>");
    assert.match(facts!.closest("details")!.querySelector("summary")!.textContent ?? "", /everything Apply Pilot read from your résumé/u);
  } finally {
    await harness.close();
  }
});
