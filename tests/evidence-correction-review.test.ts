import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

import { EvidenceCorrectionReview } from "@/components/evidence-correction-review";
import {
  buildEvidenceCorrectionReview,
  createReviewedEvidenceSnapshot,
  hashEvidenceSnapshot,
  type EvidenceCorrectionDecision
} from "@/lib/jobs/evidence-correction-review";

async function waitForRenderedText(container: Element, pattern: RegExp): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (pattern.test(container.textContent ?? "")) return;
    await act(async () => {
      await new Promise<void>((resolve) => setImmediate(resolve));
    });
  }
  assert.match(container.textContent ?? "", pattern);
}

const resume = {
  rawText: [
    "SUMMARY",
    "Customer-facing technical operator.",
    "EDUCATION",
    "Bachelor of Arts in Business Administration",
    "CERTIFICATIONS",
    "Operations Certificate | 480 hours"
  ].join("\n"),
  summary: "Customer-facing technical operator.",
  skills: ["Languages: TypeScript, SQL", "Methods: Discovery, Workshops"],
  achievements: ["Improved a source-backed workflow."],
  workHistory: [{ sourceText: "Example Co | Operations Lead\nOwned customer workflows." }],
  projects: [{ sourceText: "Evidence Console | 2026\nBuilt an auditable review surface." }],
  education: [{
    sourceText: "Bachelor of Arts in Business Administration",
    institution: "Example University",
    credential: "Bachelor of Arts",
    fieldOfStudy: "Business Administration"
  }],
  certifications: [{
    sourceText: "Operations Certificate | 480 hours",
    name: "Operations Certificate",
    details: ["480 hours"]
  }]
};

const analysis = {
  contractVersion: "3",
  promptVersion: "3.4",
  requirementGaps: [{
    requirement: "Bachelor's degree in business or equivalent experience",
    jobRequirement: {
      ref: "job.requirements[0]",
      excerpt: "Bachelor's degree in business or equivalent experience"
    },
    missingKeywords: ["business"]
  }]
};

test("review model shows every extracted fact section and focuses current disputed gaps", () => {
  const review = buildEvidenceCorrectionReview({
    jobId: "job-1",
    resumeId: "resume-1",
    resumeUpdatedAt: "2026-10-08T12:00:00.000Z",
    resume,
    analysisId: "analysis-1",
    analysisOutput: analysis,
    selectedResumeDocumentId: "resume-version-1",
    selectedCoverLetterDocumentId: "cover-1"
  });

  assert.deepEqual(
    [...new Set(review.facts.map((fact) => fact.section))],
    ["raw_source", "summary", "skills", "achievements", "work_history", "projects", "education", "certifications"]
  );
  assert.equal(review.gaps.length, 1);
  assert.equal(review.gaps[0].requirement, "Bachelor's degree in business or equivalent experience");
  assert.ok(review.facts.some((fact) =>
    fact.ref === "resume.education[0].sourceText" && fact.value.includes("Business Administration")));
  assert.ok(review.facts.some((fact) =>
    fact.ref === "resume.education[0].credential" && fact.value === "Bachelor of Arts"));
  assert.ok(review.facts.some((fact) =>
    fact.ref === "resume.education[0].fieldOfStudy" && fact.value === "Business Administration"));
  assert.ok(review.facts.some((fact) =>
    fact.ref === "resume.certifications[0].details[0]" && fact.value === "480 hours"));
  assert.equal(review.facts.find((fact) => fact.ref === "resume.rawText")?.sourceAuthoritative, true);
  assert.equal(review.facts.find((fact) => fact.ref === "resume.education[0].fieldOfStudy")?.sourceAuthoritative, false);
  assert.equal(review.persistence, "durable_job_only");
});

test("source corrections require exact source support and remain distinct from owner attestations", async () => {
  const review = buildEvidenceCorrectionReview({
    jobId: "job-1",
    resumeId: "resume-1",
    resumeUpdatedAt: "2026-10-08T12:00:00.000Z",
    resume,
    analysisId: "analysis-1",
    analysisOutput: analysis
  });
  const sourceDecision: EvidenceCorrectionDecision = {
    gapId: review.gaps[0].id,
    kind: "SOURCE_CORRECTION",
    sourceFactId: review.facts.find((fact) => fact.ref === "resume.rawText")!.id,
    sourceExcerpt: "Bachelor of Arts in Business Administration",
    correctedFact: "Bachelor of Arts in Business Administration",
    reuseScope: "JOB_ONLY",
    masterProfileOptIn: false
  };
  const attestationDecision: EvidenceCorrectionDecision = {
    gapId: review.gaps[0].id,
    kind: "OWNER_ATTESTATION",
    attestedFact: "Completed customer discovery for a private synthetic account.",
    ownerAttested: true,
    reuseScope: "JOB_ONLY",
    masterProfileOptIn: false
  };

  const sourceSnapshot = await createReviewedEvidenceSnapshot(review, [sourceDecision], {
    reviewedAt: "2026-10-08T12:30:00.000Z"
  });
  const attestedSnapshot = await createReviewedEvidenceSnapshot(review, [attestationDecision], {
    reviewedAt: "2026-10-08T12:30:00.000Z"
  });

  assert.equal(sourceSnapshot.decisions[0].provenance.kind, "EXISTING_SOURCE");
  assert.equal(attestedSnapshot.decisions[0].provenance.kind, "OWNER_ATTESTED");
  assert.notEqual(sourceSnapshot.snapshotHash, attestedSnapshot.snapshotHash);
  await assert.rejects(
    createReviewedEvidenceSnapshot(review, [{
      ...sourceDecision,
      sourceExcerpt: "Invented Kubernetes leadership",
      correctedFact: "Invented Kubernetes leadership"
    }], { reviewedAt: "2026-10-08T12:30:00.000Z" }),
    /complete contiguous source lines/i
  );
  const negatedReview = buildEvidenceCorrectionReview({
    jobId: "job-1",
    resumeId: "resume-1",
    resumeUpdatedAt: "2026-10-08T12:00:00.000Z",
    resume: { ...resume, rawText: "No Kubernetes experience" },
    analysisId: "analysis-1",
    analysisOutput: analysis
  });
  await assert.rejects(
    createReviewedEvidenceSnapshot(negatedReview, [{
      ...sourceDecision,
      sourceFactId: negatedReview.facts.find((fact) => fact.ref === "resume.rawText")!.id,
      sourceExcerpt: "No Kubernetes experience",
      correctedFact: "Kubernetes experience"
    }], { reviewedAt: "2026-10-08T12:30:00.000Z" }),
    /must match the complete cited source excerpt/i
  );
  await assert.rejects(
    createReviewedEvidenceSnapshot(negatedReview, [{
      ...sourceDecision,
      sourceFactId: negatedReview.facts.find((fact) => fact.ref === "resume.rawText")!.id,
      sourceExcerpt: "Kubernetes experience",
      correctedFact: "Kubernetes experience"
    }], { reviewedAt: "2026-10-08T12:30:00.000Z" }),
    /complete contiguous source lines/i
  );
  const multilineNegatedReview = buildEvidenceCorrectionReview({
    jobId: "job-1",
    resumeId: "resume-1",
    resumeUpdatedAt: "2026-10-08T12:00:00.000Z",
    resume: { ...resume, rawText: "No experience with:\nKubernetes" },
    analysisId: "analysis-1",
    analysisOutput: analysis
  });
  await assert.rejects(
    createReviewedEvidenceSnapshot(multilineNegatedReview, [{
      ...sourceDecision,
      sourceFactId: multilineNegatedReview.facts.find((fact) => fact.ref === "resume.rawText")!.id,
      sourceExcerpt: "Kubernetes",
      correctedFact: "Kubernetes"
    }], { reviewedAt: "2026-10-08T12:30:00.000Z" }),
    /complete contiguous source lines/i
  );
  const numericZeroReview = buildEvidenceCorrectionReview({
    jobId: "job-1",
    resumeId: "resume-1",
    resumeUpdatedAt: "2026-10-08T12:00:00.000Z",
    resume: { ...resume, rawText: "0 years experience with:\nKubernetes" },
    analysisId: "analysis-1",
    analysisOutput: analysis
  });
  await assert.rejects(
    createReviewedEvidenceSnapshot(numericZeroReview, [{
      ...sourceDecision,
      sourceFactId: numericZeroReview.facts.find((fact) => fact.ref === "resume.rawText")!.id,
      sourceExcerpt: "Kubernetes",
      correctedFact: "Kubernetes"
    }], { reviewedAt: "2026-10-08T12:30:00.000Z" }),
    /complete contiguous source lines/i
  );
  const priorSentenceReview = buildEvidenceCorrectionReview({
    jobId: "job-1",
    resumeId: "resume-1",
    resumeUpdatedAt: "2026-10-08T12:00:00.000Z",
    resume: { ...resume, rawText: "No Java experience.\nKubernetes" },
    analysisId: "analysis-1",
    analysisOutput: analysis
  });
  const priorSentenceSnapshot = await createReviewedEvidenceSnapshot(priorSentenceReview, [{
    ...sourceDecision,
    sourceFactId: priorSentenceReview.facts.find((fact) => fact.ref === "resume.rawText")!.id,
    sourceExcerpt: "Kubernetes",
    correctedFact: "Kubernetes"
  }], { reviewedAt: "2026-10-08T12:30:00.000Z" });
  assert.equal(priorSentenceSnapshot.decisions[0].fact, "Kubernetes");
  await assert.rejects(
    createReviewedEvidenceSnapshot(review, [{
      ...sourceDecision,
      sourceExcerpt: " ",
      correctedFact: " "
    }], { reviewedAt: "2026-10-08T12:30:00.000Z" }),
    /non-empty source excerpt and corrected fact/i
  );
  await assert.rejects(
    createReviewedEvidenceSnapshot(review, [{
      ...sourceDecision,
      sourceExcerpt: "bachelor of arts in business administration",
      correctedFact: "bachelor of arts in business administration"
    }], { reviewedAt: "2026-10-08T12:30:00.000Z" }),
    /complete contiguous source lines/i
  );
  await assert.rejects(
    createReviewedEvidenceSnapshot(review, [{
      ...sourceDecision,
      sourceFactId: review.facts.find((fact) => fact.ref === "resume.education[0].fieldOfStudy")!.id,
      sourceExcerpt: "Business Administration",
      correctedFact: "Business Administration"
    }], { reviewedAt: "2026-10-08T12:30:00.000Z" }),
    /not source-authoritative/i
  );
});

test("reusable master-profile scope requires separate explicit opt-in", async () => {
  const review = buildEvidenceCorrectionReview({
    jobId: "job-1",
    resumeId: "resume-1",
    resumeUpdatedAt: "2026-10-08T12:00:00.000Z",
    resume,
    analysisId: "analysis-1",
    analysisOutput: analysis
  });
  const decision: EvidenceCorrectionDecision = {
    gapId: review.gaps[0].id,
    kind: "OWNER_ATTESTATION",
    attestedFact: "Synthetic owner-attested evidence.",
    ownerAttested: true,
    reuseScope: "MASTER_PROFILE",
    masterProfileOptIn: false
  };

  await assert.rejects(
    createReviewedEvidenceSnapshot(review, [decision], { reviewedAt: "2026-10-08T12:30:00.000Z" }),
    /explicit master-profile opt-in/i
  );
  const snapshot = await createReviewedEvidenceSnapshot(review, [{
    ...decision,
    masterProfileOptIn: true
  }], { reviewedAt: "2026-10-08T12:30:00.000Z" });
  assert.equal(snapshot.decisions[0].reuseScope, "MASTER_PROFILE");
});

test("a reviewed snapshot has a deterministic hash and explicitly stales assessment and document bindings", async () => {
  const review = buildEvidenceCorrectionReview({
    jobId: "job-1",
    resumeId: "resume-1",
    resumeUpdatedAt: "2026-10-08T12:00:00.000Z",
    resume,
    analysisId: "analysis-1",
    analysisOutput: analysis,
    selectedResumeDocumentId: "resume-version-1",
    selectedCoverLetterDocumentId: "cover-1"
  });
  const decision: EvidenceCorrectionDecision = {
    gapId: review.gaps[0].id,
    kind: "OWNER_ATTESTATION",
    attestedFact: "Synthetic owner-attested evidence.",
    ownerAttested: true,
    reuseScope: "JOB_ONLY",
    masterProfileOptIn: false
  };

  const first = await createReviewedEvidenceSnapshot(review, [decision], {
    reviewedAt: "2026-10-08T12:30:00.000Z"
  });
  const second = await createReviewedEvidenceSnapshot(review, [decision], {
    reviewedAt: "2026-10-08T12:30:00.000Z"
  });

  assert.equal(first.snapshotHash, second.snapshotHash);
  assert.equal(first.snapshotHash, await hashEvidenceSnapshot(first));
  assert.deepEqual(first.invalidations, {
    assessmentIds: ["analysis-1"],
    resumeDocumentIds: ["resume-version-1"],
    coverLetterDocumentIds: ["cover-1"],
    totalCount: 3,
    reason: "EVIDENCE_SNAPSHOT_CHANGED"
  });
});

test("UI labels extracted evidence, provenance choices, stale effects, and job-only persistence", () => {
  const review = buildEvidenceCorrectionReview({
    jobId: "job-1",
    resumeId: "resume-1",
    resumeUpdatedAt: "2026-10-08T12:00:00.000Z",
    resume,
    analysisId: "analysis-1",
    analysisOutput: analysis,
    selectedResumeDocumentId: "resume-version-1",
    selectedCoverLetterDocumentId: "cover-1"
  });
  const html = renderToStaticMarkup(React.createElement(EvidenceCorrectionReview, { review }));

  assert.match(html, /Review extracted evidence before rewriting/i);
  assert.match(html, /Bachelor of Arts in Business Administration/);
  assert.match(html, /480 hours/);
  assert.match(html, /Existing-source correction/);
  assert.match(html, /Owner-attested addition/);
  assert.match(html, /saved for this job only/i);
  assert.doesNotMatch(html, /Save to reusable master profile/);
  assert.match(html, /prior fit assessment and documents become stale/i);
  assert.match(html, /durable review/i);
  assert.doesNotMatch(html, /Generate resume|Generate cover letter|Run match/i);
});

test("UI interaction blocks incomplete provenance, saves an exact bounded request, and invalidates changed drafts", async () => {
  const review = buildEvidenceCorrectionReview({
    jobId: "job-1",
    resumeId: "resume-1",
    resumeUpdatedAt: "2026-10-08T12:00:00.000Z",
    resume,
    analysisId: "analysis-1",
    analysisInputHash: "a".repeat(64),
    analysisModel: "gemini-3.8-flash",
    analysisPromptVersion: "3.4",
    analysisOutput: analysis,
    selectedResumeDocumentId: "resume-version-1",
    selectedCoverLetterDocumentId: "cover-1"
  });
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", {
    url: "https://app.example.com/jobs/job-1"
  });
  const globals = {
    window: dom.window,
    self: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    HTMLInputElement: dom.window.HTMLInputElement,
    HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
    HTMLSelectElement: dom.window.HTMLSelectElement,
    Node: dom.window.Node,
    Event: dom.window.Event,
    InputEvent: dom.window.InputEvent,
    MouseEvent: dom.window.MouseEvent,
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      assert.equal(String(input), "/api/jobs/job-1/evidence-snapshots");
      const body = JSON.parse(String(init?.body));
      assert.deepEqual(Object.keys(body).sort(), [
        "decisions", "requestId", "resumeId", "resumeUpdatedAt", "reviewedAnalysis", "schema"
      ]);
      assert.match(body.requestId, /^[a-f0-9-]{36}$/);
      assert.equal(body.decisions[0].kind, "UNRESOLVED");
      return new Response(JSON.stringify({
        schema: "apply-pilot/evidence-snapshot-save-response/v1",
        snapshot: {
          id: "snapshot-1",
          hash: "b".repeat(64),
          createdAt: "2026-10-08T12:30:00.000Z",
          isCurrent: true
        },
        replayed: false,
        invalidations: {
          assessmentIds: ["analysis-1"],
          resumeDocumentIds: ["resume-version-1"],
          coverLetterDocumentIds: ["cover-1"],
          totalCount: 3,
          reason: "EVIDENCE_SNAPSHOT_CHANGED"
        }
      }), { status: 201, headers: { "content-type": "application/json" } });
    },
    IS_REACT_ACT_ENVIRONMENT: true
  };
  const prior = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries(globals)) {
    prior.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  const container = dom.window.document.getElementById("root");
  assert.ok(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(React.createElement(EvidenceCorrectionReview, { review })); });
    const outcome = container.querySelector<HTMLSelectElement>("select");
    assert.ok(outcome);
    await act(async () => {
      outcome.value = "SOURCE_CORRECTION";
      outcome.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    });
    const sourceOptions = [...container.querySelectorAll("select")[1].querySelectorAll("option")];
    assert.ok(sourceOptions.some((option) => option.value === "fact:resume.rawText"));
    assert.ok(sourceOptions.some((option) => option.value === "fact:resume.education[0].sourceText"));
    assert.ok(!sourceOptions.some((option) => option.value === "fact:resume.education[0].fieldOfStudy"));
    await act(async () => {
      container.querySelector<HTMLButtonElement>("button")!.click();
      await Promise.resolve();
    });
    assert.match(container.textContent ?? "", /non-empty source excerpt and corrected fact/i);

    await act(async () => {
      outcome.value = "UNRESOLVED";
      outcome.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>("button")!.click();
    });
    await waitForRenderedText(container, /Saved reviewed snapshot [a-f0-9]{64}/);
    assert.match(container.textContent ?? "", /3 prior assessment\/document binding\(s\) are stale/i);
    await act(async () => {
      outcome.value = "OWNER_ATTESTATION";
      outcome.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    });
    assert.doesNotMatch(container.textContent ?? "", /Saved reviewed snapshot [a-f0-9]{64}/);
    assert.match(container.textContent ?? "", /Review changed.*Save a new reviewed snapshot/i);

    await act(async () => {
      outcome.value = "UNRESOLVED";
      outcome.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>("button")!.click();
      outcome.value = "OWNER_ATTESTATION";
      outcome.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
      await Promise.resolve();
    });
    assert.doesNotMatch(container.textContent ?? "", /Saved reviewed snapshot [a-f0-9]{64}/);
    assert.match(container.textContent ?? "", /Review changed.*Save a new reviewed snapshot/i);
  } finally {
    await act(async () => { root.unmount(); });
    for (const [name, descriptor] of prior) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    dom.window.close();
  }
});

test("an in-flight reassessment cannot report success after the reviewed draft changes", async () => {
  const review = buildEvidenceCorrectionReview({
    jobId: "job-1",
    resumeId: "resume-1",
    resumeUpdatedAt: "2026-10-08T12:00:00.000Z",
    resume,
    analysisId: "analysis-1",
    analysisInputHash: "a".repeat(64),
    analysisModel: "gemini-3.8-flash",
    analysisPromptVersion: "3.4",
    analysisOutput: analysis
  });
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", {
    url: "https://app.example.com/jobs/job-1"
  });
  let releaseReassessment!: (response: Response) => void;
  const reassessmentResponse = new Promise<Response>((resolve) => { releaseReassessment = resolve; });
  const globals = {
    window: dom.window,
    self: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    HTMLInputElement: dom.window.HTMLInputElement,
    HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
    HTMLSelectElement: dom.window.HTMLSelectElement,
    Node: dom.window.Node,
    Event: dom.window.Event,
    MouseEvent: dom.window.MouseEvent,
    fetch: async (input: RequestInfo | URL) => String(input).endsWith("/match")
      ? reassessmentResponse
      : new Response(JSON.stringify({
          schema: "apply-pilot/evidence-snapshot-save-response/v1",
          snapshot: {
            id: "snapshot-1",
            hash: "b".repeat(64),
            createdAt: "2026-10-08T12:30:00.000Z",
            isCurrent: true
          },
          replayed: false,
          invalidations: {
            assessmentIds: ["analysis-1"],
            resumeDocumentIds: [],
            coverLetterDocumentIds: [],
            totalCount: 1,
            reason: "EVIDENCE_SNAPSHOT_CHANGED"
          }
        }), { status: 201, headers: { "content-type": "application/json" } }),
    IS_REACT_ACT_ENVIRONMENT: true
  };
  const prior = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries(globals)) {
    prior.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  const container = dom.window.document.getElementById("root");
  assert.ok(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(React.createElement(EvidenceCorrectionReview, { review })); });
    await act(async () => { container.querySelector<HTMLButtonElement>("button")!.click(); });
    await waitForRenderedText(container, /Saved reviewed snapshot/);
    const reassess = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => /Reassess fit/.test(button.textContent ?? ""));
    assert.ok(reassess);
    await act(async () => { reassess.click(); await Promise.resolve(); });
    const outcome = container.querySelector<HTMLSelectElement>("select");
    assert.ok(outcome);
    await act(async () => {
      outcome.value = "OWNER_ATTESTATION";
      outcome.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
      releaseReassessment(new Response(JSON.stringify({ ok: true }), { status: 200 }));
      await reassessmentResponse;
      await Promise.resolve();
    });
    assert.doesNotMatch(container.textContent ?? "", /Reassessment saved with the reviewed evidence/i);
    assert.match(container.textContent ?? "", /Review changed.*Save a new reviewed snapshot/i);
  } finally {
    await act(async () => { root.unmount(); });
    for (const [name, descriptor] of prior) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    dom.window.close();
  }
});
