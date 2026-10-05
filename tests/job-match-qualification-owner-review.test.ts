import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import test from "node:test";

import { JOB_MATCH_QUALIFICATION_CASES } from "@/evaluation/job-match-qualification-corpus";
import { SYNTHETIC_QUALIFICATION_SNAPSHOT } from "@/evaluation/job-match-qualification-synthetic-preview";
import { buildSyntheticQualificationReviewGuides } from "@/evaluation/job-match-qualification-synthetic-review-guides";
import {
  buildQualificationPreparation,
  type QualificationCase,
  type QualificationExpectedCheckpoint
} from "@/lib/ai/job-match-qualification";
import { hashAiInput } from "@/lib/ai/input-hash";
import {
  buildConservativeQualificationReviewGuides,
  buildQualificationOwnerReviewView,
  createQualificationReviewArtifact,
  startJobMatchQualificationOwnerReview
} from "@/lib/ai/job-match-qualification-owner-review";

const now = new Date("2026-10-05T17:00:00.000Z");

function draftPreparation() {
  return buildQualificationPreparation(
    SYNTHETIC_QUALIFICATION_SNAPSHOT,
    JOB_MATCH_QUALIFICATION_CASES,
    now
  );
}

function checkpoint(): QualificationExpectedCheckpoint {
  const manifest = draftPreparation().safeManifest;
  return {
    manifestHash: manifest.manifestHash,
    resumeProjectionHash: manifest.resumeProjectionHash,
    profileProjectionHash: manifest.profileProjectionHash
  };
}

function capturePayload() {
  return {
    master: {
      resume: {
        id: SYNTHETIC_QUALIFICATION_SNAPSHOT.masterResumeId,
        parsedAt: SYNTHETIC_QUALIFICATION_SNAPSHOT.parsedAt,
        ...SYNTHETIC_QUALIFICATION_SNAPSHOT.resume
      }
    },
    profile: { profile: SYNTHETIC_QUALIFICATION_SNAPSHOT.profile }
  };
}

function startStreamingCapture(
  url: string,
  origin: string,
  body: string,
  contentLength = Buffer.byteLength(body),
  host?: string
) {
  let request!: ReturnType<typeof httpRequest>;
  const response = new Promise<{ status: number; body: string }>((resolve, reject) => {
    request = httpRequest(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": contentLength,
        origin,
        ...(host ? { host } : {})
      }
    }, (incoming) => {
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      incoming.on("end", () => resolve({
        status: incoming.statusCode ?? 0,
        body: Buffer.concat(chunks).toString("utf8")
      }));
    });
    request.on("error", reject);
  });
  return { request, response };
}

function completeDecision(preparation = draftPreparation(), caseIndex = 0) {
  const guides = buildSyntheticQualificationReviewGuides(preparation);
  const review = buildQualificationOwnerReviewView(
    preparation,
    JOB_MATCH_QUALIFICATION_CASES,
    { reviewGuides: guides }
  ).cases[caseIndex];
  return {
    caseId: review.id,
    factsCurrent: true as const,
    clarifications: review.clarificationGroups.map((question) => ({
      questionId: question.id,
      answer: "not_sure" as const,
      context: ""
    })),
    preferences: {
      location: "unknown" as const,
      workStyle: "unknown" as const,
      compensation: "unknown" as const
    },
    recommendation: review.proposedRecommendation,
    rationale: "Synthetic owner review keeps every unsupported point explicitly unknown."
  };
}

test("owner review artifacts cover every exact requirement and generate their own canonical hash", () => {
  const preparation = draftPreparation();
  const reviewGuides = buildSyntheticQualificationReviewGuides(preparation);
  const result = createQualificationReviewArtifact({
    preparation,
    reviewGuides,
    decision: completeDecision(preparation),
    reviewedAt: "2026-10-05T17:05:00.000Z"
  });

  assert.equal(result.attestation.caseId, JOB_MATCH_QUALIFICATION_CASES[0].id);
  assert.equal(result.attestation.inputHash, preparation.privateInputs[0].inputHash);
  assert.equal(result.attestation.openGapsHash, preparation.privateInputs[0].openGapsHash);
  assert.equal(result.attestation.expectedRecommendation, "apply now");
  assert.equal(result.attestation.reviewedRecommendation, "apply now");
  assert.match(result.attestation.reviewArtifactHash, /^[a-f0-9]{64}$/);
  assert.equal(result.artifact.requirements.length, preparation.privateInputs[0].input.job.requirements?.length);
  assert.equal(result.artifact.documentApproval, "not_available");
  assert.equal(result.artifact.userAttestations.length, 0);
  assert.equal(Object.isFrozen(result.artifact), true);
});

test("owner review evidence is presented as ordinary resume details while retaining canonical refs", () => {
  const view = buildQualificationOwnerReviewView(
    draftPreparation(),
    JOB_MATCH_QUALIFICATION_CASES,
    {
      syntheticPreview: true,
      reviewGuides: buildSyntheticQualificationReviewGuides(draftPreparation())
    }
  );
  const evidence = view.cases[0].applicantEvidence;
  const work = evidence.find((entry) => entry.ref === "resume.workHistory[0]");
  const project = evidence.find((entry) => entry.ref === "resume.projects[0]");
  const education = evidence.find((entry) => entry.ref === "resume.education[0]");
  const skill = evidence.find((entry) => entry.ref === "resume.skills[0]");

  assert.deepEqual(work, {
    ref: "resume.workHistory[0]",
    label: "Work experience",
    title: "Solutions Operations Lead at Example Systems",
    details: [
      "Led synthetic customer discovery and technical demonstrations.",
      "Built source-backed workflows with TypeScript and SQL."
    ],
    selectionLabel: "Work experience — Solutions Operations Lead at Example Systems"
  });
  assert.equal(project?.label, "Project");
  assert.equal(project?.title, "Synthetic evidence workspace");
  assert.equal(education?.label, "Education");
  assert.equal(education?.title, "Bachelor of Arts in Business Administration");
  assert.deepEqual(skill, {
    ref: "resume.skills[0]",
    label: "Skill",
    title: "TypeScript",
    details: [],
    selectionLabel: "Skill — TypeScript"
  });
  assert.equal(view.cases[0].allRequirements[0].requirement.label, "Required qualification");
  assert.ok(view.cases[0].supportedRequirements.length > 0);
  assert.equal(view.cases[0].clarificationGroups.length, 2);
  assert.equal(view.cases[0].fitSummary.supportedCount, 4);
  assert.equal(view.cases[0].fitSummary.supportedCount, view.cases[0].supportedRequirements.length);
  assert.equal(view.cases[0].fitSummary.unresolvedCount, 2);
  assert.equal(view.cases[0].fitSummary.questionGroupCount, 2);
  assert.equal(view.cases[0].allRequirements[5].materiality, "must_have");
  assert.equal(view.cases[3].fitSummary.unresolvedCount, 12);
  assert.equal(view.cases[3].fitSummary.questionGroupCount, 3);
  assert.equal(view.cases[0].preferenceContext[0].label, "Job location");
  assert.equal(view.syntheticPreview, true);
  assert.deepEqual(view.cases[0].jobContext, {
    title: "Presales Engineer I",
    company: "Laserfiche",
    location: "Long Beach, United States & Remote States, United States",
    workArrangement: "Hybrid: Tuesday through Thursday in Long Beach; remote Monday and Friday",
    compensation: "$75,000–$85,000",
    responsibilities: JOB_MATCH_QUALIFICATION_CASES[0].job.description.split("\n"),
    technologies: JOB_MATCH_QUALIFICATION_CASES[0].job.detectedTechStack,
    sourceUrl: JOB_MATCH_QUALIFICATION_CASES[0].provenance.sourceUrl,
    capturedAt: JOB_MATCH_QUALIFICATION_CASES[0].provenance.capturedAt,
    capturedAtLabel: "Oct 5, 2026"
  });
  assert.equal(view.cases[0].sourceResume.title, "Synthetic source résumé");
  assert.equal(view.cases[0].sourceResume.workHistory[0]?.title, "Solutions Operations Lead at Example Systems");
  assert.equal(view.cases[0].sourceResume.projects[0]?.title, "Synthetic evidence workspace");
  assert.equal(view.cases[0].sourceResume.education[0]?.title, "Bachelor of Arts in Business Administration");
  assert.equal(view.cases[0].sourceResume.skills[0]?.title, "TypeScript");
  assert.equal(view.cases[0].sourceResume.originalText[0]?.details[0], "SYNTHETIC OWNER REVIEW PREVIEW");
  assert.doesNotMatch(
    evidence.map((entry) => `${entry.label} ${entry.title} ${entry.details.join(" ")} ${entry.selectionLabel}`).join(" "),
    /resume\.|profile\.|job\.|\{\s*"/u
  );
});

test("review guides cannot cross applicant projections and the no-guide fallback invents no support", () => {
  const differentPreparation = buildQualificationPreparation(
    {
      ...SYNTHETIC_QUALIFICATION_SNAPSHOT,
      resume: {
        ...SYNTHETIC_QUALIFICATION_SNAPSHOT.resume,
        summary: "A different synthetic applicant projection."
      }
    },
    JOB_MATCH_QUALIFICATION_CASES,
    now
  );
  assert.throws(
    () => buildSyntheticQualificationReviewGuides(differentPreparation),
    /different applicant projection/i
  );

  const conservative = buildQualificationOwnerReviewView(
    differentPreparation,
    JOB_MATCH_QUALIFICATION_CASES
  );
  assert.equal(conservative.cases.every((entry) => entry.fitSummary.supportedCount === 0), true);
  assert.equal(
    conservative.cases.every((entry) => entry.allRequirements.every((requirement) => requirement.disposition === "unknown")),
    true
  );

  const conservativeGuides = buildConservativeQualificationReviewGuides(
    differentPreparation,
    JOB_MATCH_QUALIFICATION_CASES
  );
  const firstGuide = conservativeGuides[0];
  const result = createQualificationReviewArtifact({
    preparation: differentPreparation,
    reviewGuides: conservativeGuides,
    reviewedAt: "2026-10-05T17:05:00.000Z",
    decision: {
      caseId: firstGuide.caseId,
      factsCurrent: true,
      clarifications: firstGuide.clarifications.map((question, index) => ({
        questionId: question.id,
        answer: index === 0 ? "yes" as const : "not_sure" as const,
        context: index === 0 ? "Truthful context that remains scoped to this review." : ""
      })),
      preferences: { location: "unknown", workStyle: "unknown", compensation: "unknown" },
      recommendation: "apply now",
      rationale: "Conservative flow records context without inventing mapped requirement support."
    }
  });
  assert.equal(result.artifact.userAttestations[0]?.jobRefs.length, 0);
  assert.doesNotThrow(() => buildQualificationPreparation(
    {
      ...SYNTHETIC_QUALIFICATION_SNAPSHOT,
      resume: {
        ...SYNTHETIC_QUALIFICATION_SNAPSHOT.resume,
        summary: "A different synthetic applicant projection."
      }
    },
    JOB_MATCH_QUALIFICATION_CASES,
    now,
    [result.attestation]
  ));
});

test("synthetic review guides fail closed when a frozen job changes", () => {
  const changedJob = structuredClone(JOB_MATCH_QUALIFICATION_CASES[0].job);
  if (!changedJob.requirements) throw new Error("Expected synthetic Laserfiche requirements.");
  changedJob.requirements[1] = "Operate a particle accelerator without supervision.";
  const changedCase: QualificationCase = {
    ...JOB_MATCH_QUALIFICATION_CASES[0],
    job: changedJob,
    jobProjectionHash: hashAiInput("jobMatchQualificationJobProjection", "1", changedJob)
  };
  const changedPreparation = buildQualificationPreparation(
    SYNTHETIC_QUALIFICATION_SNAPSHOT,
    [changedCase, ...JOB_MATCH_QUALIFICATION_CASES.slice(1)],
    now
  );

  assert.throws(
    () => buildSyntheticQualificationReviewGuides(changedPreparation),
    /does not match the exact frozen job and input/i
  );
});

test("independently confirmed material gaps are surfaced without treating unanswered prompts as gaps", () => {
  const preparation = draftPreparation();
  const guides = buildSyntheticQualificationReviewGuides(preparation);
  const first = guides[0];
  const withConfirmedGap = [
    {
      ...first,
      requirements: first.requirements.map((entry, index) => index === 0
        ? {
            ...entry,
            disposition: "confirmed_gap" as const,
            applicantRefs: [],
            rationale: "An independent synthetic reviewer explicitly confirmed this evaluation-fixture gap."
          }
        : entry),
      clarifications: first.clarifications.map((entry) => ({
        ...entry,
        jobRefs: entry.jobRefs.filter((ref) => ref !== first.requirements[0].jobRef)
      }))
    },
    ...guides.slice(1)
  ];
  const view = buildQualificationOwnerReviewView(
    preparation,
    JOB_MATCH_QUALIFICATION_CASES,
    { reviewGuides: withConfirmedGap }
  );

  assert.equal(view.cases[0].fitSummary.confirmedGapCount, 1);
  assert.equal(view.cases[0].confirmedGaps[0]?.requirement.ref, "job.requirements[0]");
  assert.equal(
    view.cases[0].allRequirements.filter((entry) => entry.disposition === "unknown").length > 0,
    true
  );
});

test("owner review rejects invented guide refs and a yes answer without source context", () => {
  const preparation = draftPreparation();
  const reviewGuides = buildSyntheticQualificationReviewGuides(preparation);
  const complete = completeDecision(preparation);

  assert.throws(() => createQualificationReviewArtifact({
    preparation,
    reviewGuides: reviewGuides.map((guide, index) => index === 0
      ? {
          ...guide,
          requirements: guide.requirements.map((entry, requirementIndex) => requirementIndex === 0
            ? { ...entry, applicantRefs: ["resume.skills[999]"] }
            : entry)
        }
      : guide),
    decision: complete,
    reviewedAt: "2026-10-05T17:05:00.000Z"
  }), /review guide.*evidence/i);

  assert.throws(() => createQualificationReviewArtifact({
    preparation,
    reviewGuides,
    decision: {
      ...complete,
      clarifications: complete.clarifications.map((entry, index) => index === 0
        ? { ...entry, answer: "yes" as const }
        : entry)
    },
    reviewedAt: "2026-10-05T17:05:00.000Z"
  }), /context/i);

  const withAttestation = createQualificationReviewArtifact({
    preparation,
    reviewGuides,
    decision: {
      ...complete,
      clarifications: complete.clarifications.map((entry, index) => index === 0
        ? { ...entry, answer: "yes" as const, context: "I completed equivalent customer-facing work in a separate volunteer engagement." }
        : entry)
    },
    reviewedAt: "2026-10-05T17:05:00.000Z"
  });
  assert.equal(withAttestation.artifact.userAttestations[0]?.sourceType, "USER_ATTESTATION");
  assert.equal(withAttestation.artifact.userAttestations[0]?.caseId, JOB_MATCH_QUALIFICATION_CASES[0].id);
  assert.equal(withAttestation.artifact.documentApproval, "not_available");

  const withNegativeAnswer = createQualificationReviewArtifact({
    preparation,
    reviewGuides,
    decision: {
      ...complete,
      clarifications: complete.clarifications.map((entry, index) => index === 0
        ? { ...entry, answer: "no" as const }
        : entry)
    },
    reviewedAt: "2026-10-05T17:05:00.000Z"
  });
  assert.equal(
    withNegativeAnswer.artifact.requirements.find((entry) => entry.jobRef === "job.requirements[4]")?.disposition,
    "unknown"
  );
  assert.equal(withNegativeAnswer.artifact.userAttestations.length, 0);
  assert.ok(withNegativeAnswer.artifact.requirements.every((entry) => entry.disposition !== "gap"));
});

test("readiness rejects an unattested or hash-only review artifact", () => {
  const draft = draftPreparation();
  const attestations = draft.privateInputs.map((_, index) => createQualificationReviewArtifact({
    preparation: draft,
    reviewGuides: buildSyntheticQualificationReviewGuides(draft),
    decision: completeDecision(draft, index),
    reviewedAt: "2026-10-05T17:05:00.000Z"
  }).attestation);
  assert.throws(() => buildQualificationPreparation(
    SYNTHETIC_QUALIFICATION_SNAPSHOT,
    JOB_MATCH_QUALIFICATION_CASES,
    now,
    attestations.map((attestation, index) => index === 0
      ? { ...attestation, reviewArtifactHash: "0".repeat(64) }
      : attestation)
  ), /attestation mismatch/i);
});

test("the owner review server verifies the prior checkpoint and reaches only the separate-consent gate", async (t) => {
  const workflow = await startJobMatchQualificationOwnerReview({
    expectedCheckpoint: checkpoint(),
    cases: JOB_MATCH_QUALIFICATION_CASES,
    reviewGuides: buildSyntheticQualificationReviewGuides(draftPreparation()),
    syntheticSnapshot: SYNTHETIC_QUALIFICATION_SNAPSHOT,
    now,
    sessionTimeoutMs: 5_000
  });
  t.after(() => workflow.close("test_cleanup"));

  const initial = await fetch(workflow.reviewUrl, { redirect: "manual" });
  assert.equal(initial.status, 200);
  assert.match(initial.headers.get("content-security-policy") ?? "", /default-src 'none'/);
  assert.equal(initial.headers.get("cache-control"), "private, no-store");
  const html = await initial.text();
  assert.doesNotMatch(html, /Synthetic owner evidence|localStorage|sessionStorage/);

  const stateResponse = await fetch(workflow.stateUrl);
  assert.equal(stateResponse.status, 200);
  const state = await stateResponse.json() as {
    phase: string;
    cases: Array<{ applicantEvidence: Array<{ ref: string; text: string }> }>;
  };
  assert.equal(state.phase, "reviewing");
  assert.ok(state.cases[0].applicantEvidence.some((entry) => entry.ref === "resume.rawText"));
  assert.match(JSON.stringify(state), /Synthetic owner evidence/);

  let finalManifestHash = "";
  for (let index = 0; index < 4; index += 1) {
    const preparation = draftPreparation();
    const response = await fetch(workflow.reviewSubmissionUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: workflow.origin
      },
      body: JSON.stringify(completeDecision(preparation, index))
    });
    assert.equal(response.status, 200);
    const body = await response.json() as { phase: string; finalManifestHash?: string };
    if (index < 3) assert.equal(body.phase, "reviewing");
    else {
      assert.equal(body.phase, "awaiting_separate_google_consent");
      finalManifestHash = body.finalManifestHash ?? "";
    }
  }

  const ready = await workflow.readyForConsent;
  assert.equal(ready.preparation.safeManifest.readiness, "ready_for_separate_execution_consent");
  assert.equal(ready.preparation.safeManifest.manifestHash, finalManifestHash);
  assert.equal(ready.reviewArtifacts.length, 4);
  assert.equal(workflow.phase(), "awaiting_separate_google_consent");
  assert.equal(workflow.providerCallCount(), 0);
});

test("the real capture route admits only a recapture matching all three checkpoint hashes", async (t) => {
  const allowedOrigin = "https://apply.example.test";
  const workflow = await startJobMatchQualificationOwnerReview({
    expectedCheckpoint: checkpoint(),
    cases: JOB_MATCH_QUALIFICATION_CASES,
    reviewGuides: buildSyntheticQualificationReviewGuides(draftPreparation()),
    allowedOrigin,
    now,
    captureTimeoutMs: 5_000,
    sessionTimeoutMs: 5_000
  });
  t.after(() => workflow.close("test_cleanup"));
  assert.ok(workflow.captureUrl);
  assert.equal(workflow.phase(), "awaiting_capture");
  assert.equal(workflow.hasPrivateInput(), false);

  const preflight = await fetch(workflow.captureUrl, {
    method: "OPTIONS",
    headers: {
      origin: allowedOrigin,
      "access-control-request-private-network": "true"
    }
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-private-network"), "true");
  assert.equal(preflight.headers.get("vary"), "Origin");

  const wrongOrigin = await fetch(workflow.captureUrl, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://evil.example.test" },
    body: JSON.stringify(capturePayload())
  });
  assert.equal(wrongOrigin.status, 403);

  const wrongHost = startStreamingCapture(
    workflow.captureUrl,
    allowedOrigin,
    JSON.stringify(capturePayload()),
    undefined,
    "evil.example.test"
  );
  wrongHost.request.end(JSON.stringify(capturePayload()));
  assert.equal((await wrongHost.response).status, 400);

  const malformed = await fetch(workflow.captureUrl, {
    method: "POST",
    headers: { "content-type": "application/json", origin: allowedOrigin },
    body: "{"
  });
  assert.equal(malformed.status, 400);
  assert.equal(workflow.phase(), "awaiting_capture");

  const oversized = startStreamingCapture(workflow.captureUrl, allowedOrigin, "{}", 2_000_001);
  oversized.request.end("{}");
  assert.equal((await oversized.response).status, 413);
  assert.equal(workflow.phase(), "awaiting_capture");

  const response = await fetch(workflow.captureUrl, {
    method: "POST",
    headers: { "content-type": "application/json", origin: allowedOrigin },
    body: JSON.stringify(capturePayload())
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), allowedOrigin);
  const body = await response.json() as { status: string; manifestHash: string };
  assert.equal(body.status, "checkpoint_matched_review_ready");
  assert.equal(body.manifestHash, checkpoint().manifestHash);
  assert.equal(workflow.phase(), "reviewing");
  assert.equal(workflow.hasPrivateInput(), true);

  const secondCapture = await fetch(workflow.captureUrl, {
    method: "POST",
    headers: { "content-type": "application/json", origin: allowedOrigin },
    body: JSON.stringify(capturePayload())
  });
  assert.equal(secondCapture.status, 409);
});

test("capture admission is one-shot and a timed-out partial body cannot repopulate private state", async (t) => {
  const allowedOrigin = "https://apply.example.test";
  const body = JSON.stringify(capturePayload());
  const oneShot = await startJobMatchQualificationOwnerReview({
    expectedCheckpoint: checkpoint(),
    cases: JOB_MATCH_QUALIFICATION_CASES,
    reviewGuides: buildSyntheticQualificationReviewGuides(draftPreparation()),
    allowedOrigin,
    now,
    captureTimeoutMs: 5_000,
    sessionTimeoutMs: 5_000
  });
  t.after(() => oneShot.close("test_cleanup"));
  assert.ok(oneShot.captureUrl);
  const slow = startStreamingCapture(oneShot.captureUrl, allowedOrigin, body);
  slow.request.write(body.slice(0, 1));
  await new Promise((resolve) => setTimeout(resolve, 10));
  const competing = await fetch(oneShot.captureUrl, {
    method: "POST",
    headers: { "content-type": "application/json", origin: allowedOrigin },
    body
  });
  assert.equal(competing.status, 409);
  slow.request.end(body.slice(1));
  assert.equal((await slow.response).status, 200);
  assert.equal(oneShot.phase(), "reviewing");

  const expiring = await startJobMatchQualificationOwnerReview({
    expectedCheckpoint: checkpoint(),
    cases: JOB_MATCH_QUALIFICATION_CASES,
    reviewGuides: buildSyntheticQualificationReviewGuides(draftPreparation()),
    allowedOrigin,
    now,
    captureTimeoutMs: 20,
    sessionTimeoutMs: 5_000
  });
  assert.ok(expiring.captureUrl);
  const late = startStreamingCapture(expiring.captureUrl, allowedOrigin, body);
  late.request.write(body.slice(0, 1));
  assert.equal((await expiring.closed).reason, "session_timeout");
  await assert.rejects(late.response);
  assert.equal(expiring.phase(), "closed");
  assert.equal(expiring.hasPrivateInput(), false);

  const reviewExpiring = await startJobMatchQualificationOwnerReview({
    expectedCheckpoint: checkpoint(),
    cases: JOB_MATCH_QUALIFICATION_CASES,
    reviewGuides: buildSyntheticQualificationReviewGuides(draftPreparation()),
    syntheticSnapshot: SYNTHETIC_QUALIFICATION_SNAPSHOT,
    now,
    sessionTimeoutMs: 20
  });
  const reviewBody = JSON.stringify(completeDecision());
  const lateReview = startStreamingCapture(
    reviewExpiring.reviewSubmissionUrl,
    reviewExpiring.origin,
    reviewBody
  );
  lateReview.request.write(reviewBody.slice(0, 1));
  assert.equal((await reviewExpiring.closed).reason, "session_timeout");
  await assert.rejects(lateReview.response);
  assert.equal(reviewExpiring.phase(), "closed");
  assert.equal(reviewExpiring.hasPrivateInput(), false);
});

test("checkpoint mismatch, cancellation, and timeout fail closed without a provider path", async (t) => {
  for (const key of ["manifestHash", "resumeProjectionHash", "profileProjectionHash"] as const) {
    await assert.rejects(startJobMatchQualificationOwnerReview({
      expectedCheckpoint: { ...checkpoint(), [key]: "0".repeat(64) },
      cases: JOB_MATCH_QUALIFICATION_CASES,
      reviewGuides: buildSyntheticQualificationReviewGuides(draftPreparation()),
      syntheticSnapshot: SYNTHETIC_QUALIFICATION_SNAPSHOT,
      now,
      sessionTimeoutMs: 5_000
    }), /checkpoint/i);
  }

  const cancelled = await startJobMatchQualificationOwnerReview({
    expectedCheckpoint: checkpoint(),
    cases: JOB_MATCH_QUALIFICATION_CASES,
    reviewGuides: buildSyntheticQualificationReviewGuides(draftPreparation()),
    syntheticSnapshot: SYNTHETIC_QUALIFICATION_SNAPSHOT,
    now,
    sessionTimeoutMs: 5_000
  });
  t.after(() => cancelled.close("test_cleanup"));
  const cancelResponse = await fetch(cancelled.cancelUrl, {
    method: "POST",
    headers: { origin: cancelled.origin }
  });
  assert.equal(cancelResponse.status, 204);
  assert.equal((await cancelled.closed).reason, "navigation_or_owner_cancel");
  assert.equal(cancelled.hasPrivateInput(), false);

  const expired = await startJobMatchQualificationOwnerReview({
    expectedCheckpoint: checkpoint(),
    cases: JOB_MATCH_QUALIFICATION_CASES,
    reviewGuides: buildSyntheticQualificationReviewGuides(draftPreparation()),
    syntheticSnapshot: SYNTHETIC_QUALIFICATION_SNAPSHOT,
    now,
    sessionTimeoutMs: 20
  });
  assert.equal((await expired.closed).reason, "session_timeout");
  assert.equal(expired.hasPrivateInput(), false);
});
