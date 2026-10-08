import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import test from "node:test";

import { JOB_MATCH_QUALIFICATION_CASES } from "@/evaluation/job-match-qualification-corpus";
import { SYNTHETIC_QUALIFICATION_SNAPSHOT } from "@/evaluation/job-match-qualification-synthetic-preview";
import { buildSyntheticQualificationReviewGuides } from "@/evaluation/job-match-qualification-synthetic-review-guides";
import {
  buildQualificationPreparation,
  QUALIFICATION_REVIEW_ARTIFACT_VERSION,
  type QualificationCase,
  type QualificationExpectedCheckpoint,
  type QualificationSafeManifest,
  type QualificationTransport
} from "@/lib/ai/job-match-qualification";
import {
  JOB_MATCH_MODEL,
  JOB_MATCH_PROMPT_VERSION,
  type JobMatchModelOutput
} from "@/lib/ai/job-match";
import { hashAiInput } from "@/lib/ai/input-hash";
import { GeminiProviderError } from "@/lib/ai/gemini";
import {
  buildConservativeQualificationReviewGuides,
  buildQualificationOwnerReviewView,
  createQualificationReviewGuide,
  createQualificationReviewArtifact,
  qualificationSourceOriginLabel,
  startJobMatchQualificationOwnerReview
} from "@/lib/ai/job-match-qualification-owner-review";
import { fixedSyntheticProviderRecommendation } from "@/tests/fixtures/job-match-qualification-provider-results";

const now = new Date("2026-10-05T17:00:00.000Z");

test("provider evidence labels name every supported source section without machine paths or indexes", () => {
  const expected = new Map<string, string>([
    ["resume.summary", "Your résumé: summary"],
    ["resume.rawText", "Your résumé: submitted text"],
    ["resume.skills[3]", "Your résumé: skills"],
    ["resume.achievements[8]", "Your résumé: achievements"],
    ["resume.workHistory[2]", "Your résumé: work experience"],
    ["resume.projects[6]", "Your résumé: projects"],
    ["resume.education[4]", "Your résumé: education"],
    ["resume.certifications[5]", "Your résumé: certifications"],
    ["job.title", "Job listing: title"],
    ["job.company", "Job listing: company"],
    ["job.location", "Job listing: location"],
    ["job.remoteStatus", "Job listing: work arrangement"],
    ["job.salaryMin", "Job listing: compensation"],
    ["job.salaryMax", "Job listing: compensation"],
    ["job.description", "Job listing: description"],
    ["job.requirements[9]", "Job listing: requirements"],
    ["job.preferredQualifications[7]", "Job listing: preferred qualifications"],
    ["job.detectedTechStack[3]", "Job listing: technologies"],
    ["resume.unrecognized[1]", "Your résumé: cited source"],
    ["job.unrecognized[1]", "Job listing: cited source"],
    ["job.skills[0]", "Job listing: cited source"],
    ["job.education[0]", "Job listing: cited source"],
    ["resume.requirements[0]", "Your résumé: cited source"],
    ["resume.detectedTechStack[0]", "Your résumé: cited source"],
    ["profile.unrecognized[1]", "Submitted applicant source"],
    ["unexpected", "Submitted source"]
  ]);

  for (const [ref, label] of expected) {
    assert.equal(qualificationSourceOriginLabel(ref), label, ref);
    assert.doesNotMatch(label, /\[|\]|\d|schema|field|path|index|wrapper/i, ref);
  }
});

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

function decisionForGuides(
  preparation: ReturnType<typeof draftPreparation>,
  caseIndex: number,
  guides: ReturnType<typeof buildSyntheticQualificationReviewGuides>
) {
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

function completeDecision(preparation = draftPreparation(), caseIndex = 0) {
  return decisionForGuides(preparation, caseIndex, buildSyntheticQualificationReviewGuides(preparation));
}

function completeLocalDecision(preparation = draftPreparation(), caseIndex = 0) {
  return decisionForGuides(preparation, caseIndex, buildConservativeQualificationReviewGuides(preparation));
}

function reviewGuideDraft(preparation = draftPreparation(), caseIndex = 0) {
  const guide = buildSyntheticQualificationReviewGuides(preparation)[caseIndex];
  return {
    caseId: guide.caseId,
    requirements: guide.requirements,
    clarifications: guide.clarifications
  };
}

function executionConsent(manifest: QualificationSafeManifest) {
  return {
    recipient: "google-gemini-developer-api" as const,
    model: JOB_MATCH_MODEL,
    promptVersion: JOB_MATCH_PROMPT_VERSION,
    approvedManifestHash: manifest.manifestHash,
    approvedCallCount: 4,
    approvedMaximumCostMicros: manifest.maximumCostMicros,
    privateApplicantDataSharingApproved: true as const,
    existingCredentialUseApproved: true as const,
    noRetry: true as const,
    noDatabaseWrites: true as const,
    noRoutingWrites: true as const,
    noEmployerInteraction: true as const
  };
}

test("synthetic preview cannot be combined with an executable provider transport", async () => {
  await assert.rejects(() => startJobMatchQualificationOwnerReview({
    expectedCheckpoint: checkpoint(),
    cases: JOB_MATCH_QUALIFICATION_CASES,
    reviewGuides: buildSyntheticQualificationReviewGuides(draftPreparation()),
    syntheticSnapshot: SYNTHETIC_QUALIFICATION_SNAPSHOT,
    execution: { activateTransport: async () => { throw new Error("must not activate"); } }
  }), /synthetic preview.*execution|execution.*synthetic preview/i);
});

function validModelOutput(recommendation: "apply now" | "consider" | "skip"): JobMatchModelOutput {
  return {
    contractVersion: "3",
    recommendation,
    overallFitScore: recommendation === "apply now" ? 82 : recommendation === "consider" ? 61 : 24,
    resumeKeywordScore: 60,
    skillsMatchScore: 60,
    experienceMatchScore: 60,
    careerGoalScore: 60,
    locationWorkStyleScore: 50,
    compensationScore: 50,
    confidenceScore: 70,
    confidenceBasis: "Synthetic transport result for local continuation testing.",
    factualMatches: [],
    requirementGaps: [],
    advice: {
      resumeAngle: "TRANSIENT PRIVATE MODEL OUTPUT",
      coverLetterAngle: "TRANSIENT PRIVATE MODEL OUTPUT",
      keywordsToEmphasize: []
    }
  };
}

async function finishOwnerReviews(workflow: Awaited<ReturnType<typeof startJobMatchQualificationOwnerReview>>) {
  const preparation = draftPreparation();
  for (let index = 0; index < JOB_MATCH_QUALIFICATION_CASES.length; index += 1) {
    const response = await fetch(workflow.reviewSubmissionUrl, {
      method: "POST",
      headers: { "content-type": "application/json", origin: workflow.origin },
      body: JSON.stringify(completeLocalDecision(preparation, index))
    });
    assert.equal(response.status, 200);
  }
  return workflow.readyForConsent;
}

async function admitRealSnapshot(
  workflow: Awaited<ReturnType<typeof startJobMatchQualificationOwnerReview>>
) {
  assert.ok(workflow.captureUrl);
  const capture = await fetch(workflow.captureUrl, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://apply.example.test" },
    body: JSON.stringify(capturePayload())
  });
  assert.equal(capture.status, 200);
  assert.equal((await capture.json() as { status: string }).status, "checkpoint_matched_review_ready");
}

async function waitForPhase(
  workflow: Awaited<ReturnType<typeof startJobMatchQualificationOwnerReview>>,
  expected: string
) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (workflow.phase() === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(workflow.phase(), expected);
}

test("private review guides are server-bound to the exact input and job while unsupported facts remain unknown", () => {
  const preparation = draftPreparation();
  const guide = createQualificationReviewGuide({
    preparation,
    draft: reviewGuideDraft(preparation)
  });

  assert.equal(guide.version, "2");
  assert.equal(guide.inputHash, preparation.privateInputs[0].inputHash);
  assert.equal(guide.jobProjectionHash, preparation.privateInputs[0].jobProjectionHash);
  assert.equal(
    guide.requirements
      .filter((entry) => entry.disposition === "unknown")
      .every((entry) => entry.applicantRefs.length === 0),
    true
  );
  assert.equal(guide.clarifications.every((entry) => entry.decisionChanging === true), true);
  assert.equal(Object.isFrozen(guide), true);
});

test("private review guides reject non-material, already-resolved, and duplicate clarification targets", () => {
  const preparation = draftPreparation();
  const draft = reviewGuideDraft(preparation);
  const supportedRef = draft.requirements.find((entry) => entry.disposition === "supported")?.jobRef;
  const nonMaterialRef = draft.requirements.find((entry) => entry.disposition === "unknown")?.jobRef;
  assert.ok(supportedRef);
  assert.ok(nonMaterialRef);

  for (const [label, jobRef] of [["resolved", supportedRef], ["non-material", nonMaterialRef]] as const) {
    assert.throws(() => createQualificationReviewGuide({
      preparation,
      draft: {
        ...draft,
        requirements: label === "non-material"
          ? draft.requirements.map((entry) => entry.jobRef === jobRef
            ? { ...entry, disposition: "not_material" as const }
            : entry)
          : draft.requirements,
        clarifications: [{
          id: `${label}-question`,
          title: "Should not be admitted",
          question: "Should this be asked?",
          whyItMatters: "This deliberately violates the material-question boundary.",
          decisionChanging: true,
          jobRefs: [jobRef]
        }]
      }
    }), /decision-changing|unresolved material/i);
  }

  const unknownMaterialRef = draft.requirements.find((entry) =>
    entry.disposition === "unknown" && entry.materiality !== "preferred")?.jobRef;
  assert.ok(unknownMaterialRef);
  assert.throws(() => createQualificationReviewGuide({
    preparation,
    draft: {
      ...draft,
      clarifications: [
        {
          id: "duplicate-one",
          title: "First duplicate",
          question: "First question?",
          whyItMatters: "It could change the recommendation.",
          decisionChanging: true,
          jobRefs: [unknownMaterialRef]
        },
        {
          id: "duplicate-two",
          title: "Second duplicate",
          question: "Second question?",
          whyItMatters: "It could change the recommendation.",
          decisionChanging: true,
          jobRefs: [unknownMaterialRef]
        }
      ]
    }
  }), /exactly once|duplicate/i);
});

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

test("review guides cannot cross applicant projections and the local fallback remains source-bound", () => {
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
  assert.equal(conservative.cases.some((entry) => entry.fitSummary.supportedCount > 0), true);
  assert.equal(
    conservative.cases.every((entry) => entry.allRequirements.every((requirement) =>
      requirement.evidence.every((evidence) => evidence.ref.startsWith("resume."))
    )),
    true
  );

  const conservativeGuides = buildConservativeQualificationReviewGuides(
    differentPreparation
  );
  const firstGuide = conservativeGuides[0];
  assert.equal(firstGuide.clarifications.every((entry) => entry.decisionChanging), true);
  const result = createQualificationReviewArtifact({
    preparation: differentPreparation,
    reviewGuides: conservativeGuides,
    reviewedAt: "2026-10-05T17:05:00.000Z",
    decision: {
      caseId: firstGuide.caseId,
      factsCurrent: true,
      clarifications: completeLocalDecision(differentPreparation).clarifications,
      preferences: { location: "unknown", workStyle: "unknown", compensation: "unknown" },
      recommendation: "apply now",
      rationale: "Conservative flow records context without inventing mapped requirement support."
    }
  });
  assert.equal(result.artifact.userAttestations.length, 0);
  assert.equal(result.artifact.requirements.some((entry) => entry.disposition === "supported"), true);
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

test("the local pre-provider guide maps obvious source facts without treating preferences as qualification evidence", () => {
  const preparation = draftPreparation();
  const guides = buildConservativeQualificationReviewGuides(preparation);
  const laserfiche = guides[0];
  const degree = laserfiche.requirements.find((entry) => entry.jobRef === "job.requirements[0]");
  const authorization = laserfiche.requirements.find((entry) => entry.jobRef === "job.requirements[5]");
  const sentryFrameworks = guides[1].requirements.find((entry) => entry.jobRef === "job.requirements[1]");

  assert.deepEqual(degree, {
    jobRef: "job.requirements[0]",
    disposition: "supported",
    materiality: "important",
    applicantRefs: ["resume.education[0]"],
    rationale: "Direct source evidence contains the stated degree credential."
  });
  assert.equal(authorization?.disposition, "unknown");
  assert.deepEqual(laserfiche.clarifications.map((entry) => entry.jobRefs), [["job.requirements[5]"]]);
  assert.equal(sentryFrameworks?.disposition, "unknown");
  assert.equal(
    guides.every((guide) => guide.requirements.every((entry) =>
      entry.applicantRefs.every((ref) => ref.startsWith("resume."))
    )),
    true
  );
  const view = buildQualificationOwnerReviewView(preparation, JOB_MATCH_QUALIFICATION_CASES, {
    reviewGuides: guides
  });
  assert.deepEqual(
    view.cases[0].allRequirements[0].candidateEvidence.map((entry) => entry.ref),
    ["resume.education[0]"]
  );
  assert.equal(
    view.cases.flatMap((entry) => entry.allRequirements)
      .flatMap((entry) => entry.candidateEvidence)
      .some((entry) => entry.ref.startsWith("profile.")),
    false
  );
});

test("the local source matcher does not promote substring-only or preference-only skill evidence", () => {
  const job = {
    ...structuredClone(JOB_MATCH_QUALIFICATION_CASES[0].job),
    requirements: ["Hands-on NoSQL database expertise"],
    preferredQualifications: []
  };
  const qualificationCase: QualificationCase = {
    ...JOB_MATCH_QUALIFICATION_CASES[0],
    id: "synthetic-substring-guard",
    job,
    jobProjectionHash: hashAiInput("jobMatchQualificationJobProjection", "1", job)
  };
  const preparation = buildQualificationPreparation(
    SYNTHETIC_QUALIFICATION_SNAPSHOT,
    [qualificationCase, ...JOB_MATCH_QUALIFICATION_CASES.slice(1)],
    now
  );
  const guide = buildConservativeQualificationReviewGuides(preparation)[0];

  assert.equal(guide.requirements[0].disposition, "unknown");
  assert.deepEqual(guide.requirements[0].applicantRefs, []);
});

test("the local source matcher keeps partial composite qualification evidence unresolved", () => {
  for (const [requirement, expectedQuestionRefs] of [
    ["Bachelor’s degree in Computer Science required", [["job.requirements[0]"]]],
    ["Master’s degree required", [["job.requirements[0]"]]],
    ["5+ years of SQL required", [["job.requirements[0]"]]],
    ["SQL and analytics skills", []]
  ] as const) {
    const job = {
      ...structuredClone(JOB_MATCH_QUALIFICATION_CASES[0].job),
      requirements: [requirement],
      preferredQualifications: []
    };
    const qualificationCase: QualificationCase = {
      ...JOB_MATCH_QUALIFICATION_CASES[0],
      id: `synthetic-partial-${requirement.length}`,
      job,
      jobProjectionHash: hashAiInput("jobMatchQualificationJobProjection", "1", job)
    };
    const preparation = buildQualificationPreparation(
      SYNTHETIC_QUALIFICATION_SNAPSHOT,
      [qualificationCase, ...JOB_MATCH_QUALIFICATION_CASES.slice(1)],
      now
    );
    const guide = buildConservativeQualificationReviewGuides(preparation)[0];

    assert.equal(guide.requirements[0].disposition, "unknown", requirement);
    assert.deepEqual(guide.requirements[0].applicantRefs, [], requirement);
    assert.deepEqual(guide.clarifications.map((entry) => entry.jobRefs), expectedQuestionRefs, requirement);
  }
});

test("the local source matcher accepts a generic degree gate without weakening named degree levels", () => {
  const sourceEducation = SYNTHETIC_QUALIFICATION_SNAPSHOT.resume.education;
  assert.ok(Array.isArray(sourceEducation));
  const bachelorDegreeSnapshot = {
    ...structuredClone(SYNTHETIC_QUALIFICATION_SNAPSHOT),
    resume: {
      ...structuredClone(SYNTHETIC_QUALIFICATION_SNAPSHOT.resume),
      skills: ["Support"],
      education: [{
        ...structuredClone(sourceEducation[0]),
        credential: "Bachelor degree",
        fieldOfStudy: "Business Communication"
      }]
    }
  };
  for (const [requirement, expectedDisposition, expectedMateriality] of [
    ["Master degree required", "unknown", "must_have"],
    ["Bachelor degree in Technical Communication required", "unknown", "must_have"],
    ["Technical support skills", "unknown", "important"],
    ["Degree required", "supported", "must_have"]
  ] as const) {
    const job = {
      ...structuredClone(JOB_MATCH_QUALIFICATION_CASES[0].job),
      requirements: [requirement],
      preferredQualifications: []
    };
    const qualificationCase: QualificationCase = {
      ...JOB_MATCH_QUALIFICATION_CASES[0],
      id: `synthetic-degree-level-${requirement.length}`,
      job,
      jobProjectionHash: hashAiInput("jobMatchQualificationJobProjection", "1", job)
    };
    const preparation = buildQualificationPreparation(
      bachelorDegreeSnapshot,
      [qualificationCase, ...JOB_MATCH_QUALIFICATION_CASES.slice(1)],
      now
    );
    const guide = buildConservativeQualificationReviewGuides(preparation)[0];

    assert.equal(guide.requirements[0].disposition, expectedDisposition, requirement);
    assert.equal(guide.requirements[0].materiality, expectedMateriality, requirement);
    assert.equal(
      guide.requirements[0].applicantRefs.some((ref) => ref.startsWith("resume.education[")),
      expectedDisposition === "supported",
      requirement
    );
  }
});

test("the local source matcher preserves meaningful words inside named skill phrases", () => {
  for (const [requirement, submittedSkill] of [
    ["Knowledge management skills", "Management"],
    ["Working capital management skills", "Capital management"],
    ["C and C++ skills", "C++"],
    ["R and Python skills", "Python"]
  ] as const) {
    const snapshot = {
      ...structuredClone(SYNTHETIC_QUALIFICATION_SNAPSHOT),
      resume: {
        ...structuredClone(SYNTHETIC_QUALIFICATION_SNAPSHOT.resume),
        skills: [submittedSkill]
      }
    };
    const job = {
      ...structuredClone(JOB_MATCH_QUALIFICATION_CASES[0].job),
      requirements: [requirement],
      preferredQualifications: []
    };
    const qualificationCase: QualificationCase = {
      ...JOB_MATCH_QUALIFICATION_CASES[0],
      id: `synthetic-named-skill-${requirement.length}`,
      job,
      jobProjectionHash: hashAiInput("jobMatchQualificationJobProjection", "1", job)
    };
    const preparation = buildQualificationPreparation(
      snapshot,
      [qualificationCase, ...JOB_MATCH_QUALIFICATION_CASES.slice(1)],
      now
    );
    const guide = buildConservativeQualificationReviewGuides(preparation)[0];

    assert.equal(guide.requirements[0].disposition, "unknown", requirement);
    assert.deepEqual(guide.requirements[0].applicantRefs, [], requirement);
  }
});

test("a diploma does not satisfy a generic degree requirement", () => {
  const sourceEducation = SYNTHETIC_QUALIFICATION_SNAPSHOT.resume.education;
  assert.ok(Array.isArray(sourceEducation));
  const snapshot = {
    ...structuredClone(SYNTHETIC_QUALIFICATION_SNAPSHOT),
    resume: {
      ...structuredClone(SYNTHETIC_QUALIFICATION_SNAPSHOT.resume),
      education: [{
        ...structuredClone(sourceEducation[0]),
        credential: "Professional Diploma",
        fieldOfStudy: "Business Administration"
      }]
    }
  };
  const job = {
    ...structuredClone(JOB_MATCH_QUALIFICATION_CASES[0].job),
    requirements: ["Degree required"],
    preferredQualifications: []
  };
  const qualificationCase: QualificationCase = {
    ...JOB_MATCH_QUALIFICATION_CASES[0],
    id: "synthetic-diploma-degree-guard",
    job,
    jobProjectionHash: hashAiInput("jobMatchQualificationJobProjection", "1", job)
  };
  const preparation = buildQualificationPreparation(
    snapshot,
    [qualificationCase, ...JOB_MATCH_QUALIFICATION_CASES.slice(1)],
    now
  );
  const guide = buildConservativeQualificationReviewGuides(preparation)[0];

  assert.equal(guide.requirements[0].disposition, "unknown");
  assert.deepEqual(guide.requirements[0].applicantRefs, []);
});

test("the local source matcher does not turn explicit non-gates into owner questions", () => {
  for (const requirement of [
    "No prior Kubernetes experience is required",
    "Visa sponsorship is available for this role"
  ]) {
    const job = {
      ...structuredClone(JOB_MATCH_QUALIFICATION_CASES[0].job),
      requirements: [requirement],
      preferredQualifications: []
    };
    const qualificationCase: QualificationCase = {
      ...JOB_MATCH_QUALIFICATION_CASES[0],
      id: `synthetic-non-gate-${requirement.length}`,
      job,
      jobProjectionHash: hashAiInput("jobMatchQualificationJobProjection", "1", job)
    };
    const preparation = buildQualificationPreparation(
      SYNTHETIC_QUALIFICATION_SNAPSHOT,
      [qualificationCase, ...JOB_MATCH_QUALIFICATION_CASES.slice(1)],
      now
    );
    const guide = buildConservativeQualificationReviewGuides(preparation)[0];

    assert.equal(guide.requirements[0].disposition, "unknown", requirement);
    assert.deepEqual(guide.clarifications, [], requirement);
  }
});

test("the local source matcher keeps unavailable sponsorship as an explicit decision gate", () => {
  for (const requirement of [
    "Visa sponsorship is not available for this role",
    "No visa sponsorship is available for this role"
  ]) {
    const job = {
      ...structuredClone(JOB_MATCH_QUALIFICATION_CASES[0].job),
      requirements: [requirement],
      preferredQualifications: []
    };
    const qualificationCase: QualificationCase = {
      ...JOB_MATCH_QUALIFICATION_CASES[0],
      id: `synthetic-sponsorship-gate-${requirement.length}`,
      job,
      jobProjectionHash: hashAiInput("jobMatchQualificationJobProjection", "1", job)
    };
    const preparation = buildQualificationPreparation(
      SYNTHETIC_QUALIFICATION_SNAPSHOT,
      [qualificationCase, ...JOB_MATCH_QUALIFICATION_CASES.slice(1)],
      now
    );
    const guide = buildConservativeQualificationReviewGuides(preparation)[0];

    assert.equal(guide.requirements[0].disposition, "unknown", requirement);
    assert.deepEqual(guide.clarifications.map((entry) => entry.jobRefs), [["job.requirements[0]"]], requirement);
  }
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

  assert.throws(() => createQualificationReviewGuide({
    preparation,
    draft: {
      ...reviewGuideDraft(preparation),
      requirements: reviewGuideDraft(preparation).requirements.map((entry, index) => index === 0
        ? { ...entry, applicantRefs: ["profile.skillsToEmphasize[0]"] }
        : entry)
    }
  }), /resume fact|qualification evidence/i);

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

test("canonical review artifacts reject injected profile preferences as qualification support", () => {
  const preparation = draftPreparation();
  const created = createQualificationReviewArtifact({
    preparation,
    reviewGuides: buildSyntheticQualificationReviewGuides(preparation),
    decision: completeDecision(preparation),
    reviewedAt: "2026-10-05T17:05:00.000Z"
  });
  const artifact = structuredClone(created.artifact);
  artifact.requirements[0].disposition = "supported";
  artifact.requirements[0].applicantRefs = ["profile.skillsToEmphasize[0]"];
  artifact.requirements[0].userAttestationIds = [];
  const injected = {
    ...created.attestation,
    reviewArtifact: artifact,
    reviewArtifactHash: hashAiInput(
      "jobMatchQualificationHumanReviewArtifact",
      QUALIFICATION_REVIEW_ARTIFACT_VERSION,
      artifact
    )
  };

  assert.throws(() => buildQualificationPreparation(
    SYNTHETIC_QUALIFICATION_SNAPSHOT,
    JOB_MATCH_QUALIFICATION_CASES,
    now,
    [injected]
  ), /attestation mismatch/i);
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
    allowedOrigin: "https://apply.example.test",
    now,
    sessionTimeoutMs: 5_000
  });
  t.after(() => workflow.close("test_cleanup"));

  await admitRealSnapshot(workflow);

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
      body: JSON.stringify(completeLocalDecision(preparation, index))
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
  assert.equal(ready.safeManifest.readiness, "ready_for_separate_execution_consent");
  assert.equal(ready.safeManifest.manifestHash, finalManifestHash);
  assert.equal(ready.reviewArtifactCount, 4);
  assert.equal(workflow.phase(), "awaiting_separate_google_consent");
  assert.equal(workflow.providerCallCount(), 0);
});

test("the real capture route admits only a recapture matching all three checkpoint hashes", async (t) => {
  const allowedOrigin = "https://apply.example.test";
  const workflow = await startJobMatchQualificationOwnerReview({
    expectedCheckpoint: checkpoint(),
    cases: JOB_MATCH_QUALIFICATION_CASES,
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

test("real capture cannot inject externally supplied evidence guides", async () => {
  await assert.rejects(startJobMatchQualificationOwnerReview({
    expectedCheckpoint: checkpoint(),
    cases: JOB_MATCH_QUALIFICATION_CASES,
    reviewGuides: buildSyntheticQualificationReviewGuides(draftPreparation()),
    allowedOrigin: "https://apply.example.test",
    now
  }), /synthetic preview/i);
});

test("real capture builds an exact local evidence reference and stops at separate consent", async (t) => {
  const allowedOrigin = "https://apply.example.test";
  const workflow = await startJobMatchQualificationOwnerReview({
    expectedCheckpoint: checkpoint(),
    cases: JOB_MATCH_QUALIFICATION_CASES,
    allowedOrigin,
    now,
    captureTimeoutMs: 5_000,
    sessionTimeoutMs: 10_000
  });
  t.after(() => workflow.close("test_cleanup"));
  assert.ok(workflow.captureUrl);

  const capture = await fetch(workflow.captureUrl, {
    method: "POST",
    headers: { "content-type": "application/json", origin: allowedOrigin },
    body: JSON.stringify(capturePayload())
  });
  assert.equal(capture.status, 200);
  assert.equal((await capture.json() as { status: string }).status, "checkpoint_matched_review_ready");
  assert.equal(workflow.phase(), "reviewing");
  assert.equal(workflow.providerCallCount(), 0);

  const preparation = draftPreparation();
  const guideInjection = await fetch(workflow.guideSubmissionUrl, {
    method: "POST",
    headers: { "content-type": "application/json", origin: workflow.origin },
    body: JSON.stringify(reviewGuideDraft(preparation))
  });
  assert.equal(guideInjection.status, 409);
  assert.equal(workflow.phase(), "reviewing");

  for (let index = 0; index < JOB_MATCH_QUALIFICATION_CASES.length; index += 1) {
    const response = await fetch(workflow.reviewSubmissionUrl, {
      method: "POST",
      headers: { "content-type": "application/json", origin: workflow.origin },
      body: JSON.stringify(completeLocalDecision(preparation, index))
    });
    assert.equal(response.status, 200);
  }

  const ready = await workflow.readyForConsent;
  assert.equal(ready.safeManifest.readiness, "ready_for_separate_execution_consent");
  assert.equal(ready.reviewArtifactCount, 4);
  assert.equal(workflow.providerCallCount(), 0);
  assert.equal(workflow.phase(), "awaiting_separate_google_consent");
});

test("same-process execution validates exact consent before credential activation and pauses after every sequential call", async (t) => {
  let activations = 0;
  let calls = 0;
  let active = 0;
  let maximumActive = 0;
  const seen: string[] = [];
  const transport: QualificationTransport = async (request) => {
    calls += 1;
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    seen.push(request.caseId);
    await Promise.resolve();
    active -= 1;
    return {
      value: validModelOutput(fixedSyntheticProviderRecommendation(request.caseId)),
      finishReason: "STOP",
      responseBytes: 500,
      elapsedMs: 10,
      requestId: `same-process-${calls}`,
      usage: {
        inputTokens: 100,
        outputTokens: 100,
        cachedInputTokens: 0,
        visibleOutputTokens: 100,
        thinkingTokens: 0
      }
    };
  };
  const workflow = await startJobMatchQualificationOwnerReview({
    expectedCheckpoint: checkpoint(),
    cases: JOB_MATCH_QUALIFICATION_CASES,
    allowedOrigin: "https://apply.example.test",
    now,
    sessionTimeoutMs: 10_000,
    execution: {
      clock: () => now,
      activateTransport: async () => {
        activations += 1;
        return transport;
      }
    }
  });
  t.after(() => workflow.close("test_cleanup"));

  await admitRealSnapshot(workflow);

  const ready = await finishOwnerReviews(workflow);
  assert.equal(ready.safeManifest.readiness, "ready_for_separate_execution_consent");
  assert.equal(activations, 0);
  assert.equal(calls, 0);

  const wrongOrigin = await fetch(workflow.consentSubmissionUrl, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://evil.example.test" },
    body: JSON.stringify(executionConsent(ready.safeManifest))
  });
  assert.equal(wrongOrigin.status, 403);

  const missingCredentialApproval: Record<string, unknown> = { ...executionConsent(ready.safeManifest) };
  delete missingCredentialApproval.existingCredentialUseApproved;
  const missingCredential = await fetch(workflow.consentSubmissionUrl, {
    method: "POST",
    headers: { "content-type": "application/json", origin: workflow.origin },
    body: JSON.stringify(missingCredentialApproval)
  });
  assert.equal(missingCredential.status, 400);
  assert.equal(activations, 0);

  const wrongManifest = await fetch(workflow.consentSubmissionUrl, {
    method: "POST",
    headers: { "content-type": "application/json", origin: workflow.origin },
    body: JSON.stringify({
      ...executionConsent(ready.safeManifest),
      approvedManifestHash: "0".repeat(64)
    })
  });
  assert.equal(wrongManifest.status, 400);

  const wrongBudget = await fetch(workflow.consentSubmissionUrl, {
    method: "POST",
    headers: { "content-type": "application/json", origin: workflow.origin },
    body: JSON.stringify({
      ...executionConsent(ready.safeManifest),
      approvedMaximumCostMicros: 1
    })
  });
  assert.equal(wrongBudget.status, 400);
  assert.equal(activations, 0);
  assert.equal(calls, 0);

  const approved = await fetch(workflow.consentSubmissionUrl, {
    method: "POST",
    headers: { "content-type": "application/json", origin: workflow.origin },
    body: JSON.stringify(executionConsent(ready.safeManifest))
  });
  assert.equal(approved.status, 202);
  await waitForPhase(workflow, "reviewing_provider_result");
  assert.equal(activations, 1);
  assert.equal(calls, 1);
  assert.equal(workflow.providerCallCount(), 1);

  const duplicateConsent = await fetch(workflow.consentSubmissionUrl, {
    method: "POST",
    headers: { "content-type": "application/json", origin: workflow.origin },
    body: JSON.stringify(executionConsent(ready.safeManifest))
  });
  assert.equal(duplicateConsent.status, 409);
  assert.equal(activations, 1);
  assert.equal(calls, 1);

  for (let index = 0; index < JOB_MATCH_QUALIFICATION_CASES.length; index += 1) {
    const state = await (await fetch(workflow.stateUrl)).json() as {
      phase: string;
      providerResultReview: { caseId: string; normalizedOutput: { advice: { resumeAngle: string } } };
    };
    assert.equal(state.phase, "reviewing_provider_result");
    assert.equal(state.providerResultReview.caseId, JOB_MATCH_QUALIFICATION_CASES[index].id);
    assert.equal(state.providerResultReview.normalizedOutput.advice.resumeAngle, "TRANSIENT PRIVATE MODEL OUTPUT");

    const wrongOrder = await fetch(workflow.executionReviewSubmissionUrl, {
      method: "POST",
      headers: { "content-type": "application/json", origin: workflow.origin },
      body: JSON.stringify({ caseId: "wrong-case", disagreementCategories: [] })
    });
    assert.equal(wrongOrder.status, 400);
    assert.equal(calls, index + 1);

    const badReview = await fetch(workflow.executionReviewSubmissionUrl, {
      method: "POST",
      headers: { "content-type": "application/json", origin: workflow.origin },
      body: JSON.stringify({
        caseId: JOB_MATCH_QUALIFICATION_CASES[index].id,
        disagreementCategories: ["not-a-category"]
      })
    });
    assert.equal(badReview.status, 400);
    assert.equal(calls, index + 1);

    const accepted = await fetch(workflow.executionReviewSubmissionUrl, {
      method: "POST",
      headers: { "content-type": "application/json", origin: workflow.origin },
      body: JSON.stringify({
        caseId: JOB_MATCH_QUALIFICATION_CASES[index].id,
        disagreementCategories: index === 1 ? ["advice_claim"] : []
      })
    });
    assert.equal(accepted.status, 200);
    if (index < 3) await waitForPhase(workflow, "reviewing_provider_result");
  }

  const report = await workflow.executionFinished;
  assert.equal(workflow.phase(), "execution_complete");
  assert.equal(maximumActive, 1);
  assert.equal(calls, 4);
  assert.deepEqual(seen, JOB_MATCH_QUALIFICATION_CASES.map((entry) => entry.id));
  assert.equal((report as { status: string }).status, "completed");
  assert.doesNotMatch(JSON.stringify(report), /TRANSIENT PRIVATE MODEL OUTPUT|SYNTHETIC OWNER REVIEW PREVIEW/);
  const finalState = await (await fetch(workflow.stateUrl)).json() as Record<string, unknown>;
  assert.equal(finalState.phase, "execution_complete");
  assert.doesNotMatch(JSON.stringify(finalState), /TRANSIENT PRIVATE MODEL OUTPUT|SYNTHETIC OWNER REVIEW PREVIEW/);
});

test("repeatable owner-review and provider-review submissions are serialized against delayed future-case bodies", async (t) => {
  let calls = 0;
  const workflow = await startJobMatchQualificationOwnerReview({
    expectedCheckpoint: checkpoint(),
    cases: JOB_MATCH_QUALIFICATION_CASES,
    allowedOrigin: "https://apply.example.test",
    now,
    sessionTimeoutMs: 10_000,
    execution: {
      clock: () => now,
      activateTransport: async () => async (request) => {
        calls += 1;
        return {
          value: validModelOutput(fixedSyntheticProviderRecommendation(request.caseId)),
          finishReason: "STOP",
          responseBytes: 500,
          elapsedMs: 10,
          requestId: `serialized-${calls}`,
          usage: {
            inputTokens: 100,
            outputTokens: 100,
            cachedInputTokens: 0,
            visibleOutputTokens: 100,
            thinkingTokens: 0
          }
        };
      }
    }
  });
  t.after(() => workflow.close("test_cleanup"));
  assert.ok(workflow.captureUrl);
  assert.equal((await fetch(workflow.captureUrl, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://apply.example.test" },
    body: JSON.stringify(capturePayload())
  })).status, 200);

  const futureOwnerReviewBody = JSON.stringify(completeLocalDecision(draftPreparation(), 1));
  const delayedOwnerReview = startStreamingCapture(workflow.reviewSubmissionUrl, workflow.origin, futureOwnerReviewBody);
  delayedOwnerReview.request.write(futureOwnerReviewBody.slice(0, -1));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal((await fetch(workflow.reviewSubmissionUrl, {
    method: "POST",
    headers: { "content-type": "application/json", origin: workflow.origin },
    body: JSON.stringify(completeLocalDecision(draftPreparation(), 0))
  })).status, 409);
  delayedOwnerReview.request.end(futureOwnerReviewBody.slice(-1));
  assert.equal((await delayedOwnerReview.response).status, 400);
  for (let index = 0; index < 4; index += 1) {
    assert.equal((await fetch(workflow.reviewSubmissionUrl, {
      method: "POST",
      headers: { "content-type": "application/json", origin: workflow.origin },
      body: JSON.stringify(completeLocalDecision(draftPreparation(), index))
    })).status, 200);
  }
  const ready = await workflow.readyForConsent;
  assert.equal((await fetch(workflow.consentSubmissionUrl, {
    method: "POST",
    headers: { "content-type": "application/json", origin: workflow.origin },
    body: JSON.stringify(executionConsent(ready.safeManifest))
  })).status, 202);
  await waitForPhase(workflow, "reviewing_provider_result");

  const futureProviderBody = JSON.stringify({
    caseId: JOB_MATCH_QUALIFICATION_CASES[1].id,
    disagreementCategories: []
  });
  const delayedProviderReview = startStreamingCapture(
    workflow.executionReviewSubmissionUrl,
    workflow.origin,
    futureProviderBody
  );
  delayedProviderReview.request.write(futureProviderBody.slice(0, -1));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal((await fetch(workflow.executionReviewSubmissionUrl, {
    method: "POST",
    headers: { "content-type": "application/json", origin: workflow.origin },
    body: JSON.stringify({ caseId: JOB_MATCH_QUALIFICATION_CASES[0].id, disagreementCategories: [] })
  })).status, 409);
  delayedProviderReview.request.end(futureProviderBody.slice(-1));
  assert.equal((await delayedProviderReview.response).status, 400);
  assert.equal((await fetch(workflow.executionReviewSubmissionUrl, {
    method: "POST",
    headers: { "content-type": "application/json", origin: workflow.origin },
    body: JSON.stringify({ caseId: JOB_MATCH_QUALIFICATION_CASES[0].id, disagreementCategories: [] })
  })).status, 200);
  await waitForPhase(workflow, "reviewing_provider_result");
  assert.equal(calls, 2);
});

test("execution activation failures and uncertain provider failures stop safely without retries or private output", async (t) => {
  for (const scenario of ["activation", "provider"] as const) {
    let activations = 0;
    let calls = 0;
    const workflow = await startJobMatchQualificationOwnerReview({
      expectedCheckpoint: checkpoint(),
      cases: JOB_MATCH_QUALIFICATION_CASES,
      allowedOrigin: "https://apply.example.test",
      now,
      sessionTimeoutMs: 10_000,
      execution: {
        clock: () => now,
        activateTransport: async () => {
          activations += 1;
          if (scenario === "activation") throw new Error("PRIVATE CREDENTIAL DETAIL");
          return async () => {
            calls += 1;
            throw new Error("PRIVATE UNCERTAIN PROVIDER DETAIL");
          };
        }
      }
    });
    t.after(() => workflow.close("test_cleanup"));
    await admitRealSnapshot(workflow);
    const ready = await finishOwnerReviews(workflow);
    const consent = await fetch(workflow.consentSubmissionUrl, {
      method: "POST",
      headers: { "content-type": "application/json", origin: workflow.origin },
      body: JSON.stringify(executionConsent(ready.safeManifest))
    });
    assert.equal(consent.status, 202);
    const report = await workflow.executionFinished;
    assert.equal(workflow.phase(), "execution_stopped");
    assert.equal(activations, 1);
    assert.equal(calls, scenario === "activation" ? 0 : 1);
    assert.equal(workflow.providerCallCount(), calls);
    assert.doesNotMatch(JSON.stringify(report), /PRIVATE CREDENTIAL DETAIL|PRIVATE UNCERTAIN PROVIDER DETAIL/);
    if (scenario === "activation") {
      assert.equal((report as { failureCode: string }).failureCode, "CREDENTIAL_ACTIVATION_FAILED");
    } else {
      assert.ok(report && typeof report === "object");
      assert.equal((report as { failedCall: { billingDisposition: string } }).failedCall.billingDisposition, "uncertain");
    }
  }
});

test("expired pricing rejects exact consent before credential activation", async (t) => {
  let activations = 0;
  const workflow = await startJobMatchQualificationOwnerReview({
    expectedCheckpoint: checkpoint(),
    cases: JOB_MATCH_QUALIFICATION_CASES,
    allowedOrigin: "https://apply.example.test",
    now,
    sessionTimeoutMs: 10_000,
    execution: {
      clock: () => new Date("2027-01-01T00:00:00.000Z"),
      activateTransport: async () => {
        activations += 1;
        throw new Error("must not activate after pricing expiry");
      }
    }
  });
  t.after(() => workflow.close("test_cleanup"));
  await admitRealSnapshot(workflow);
  const ready = await finishOwnerReviews(workflow);
  const response = await fetch(workflow.consentSubmissionUrl, {
    method: "POST",
    headers: { "content-type": "application/json", origin: workflow.origin },
    body: JSON.stringify(executionConsent(ready.safeManifest))
  });
  assert.equal(response.status, 400);
  assert.equal(activations, 0);
  assert.equal(workflow.providerCallCount(), 0);
  assert.equal(workflow.phase(), "awaiting_separate_google_consent");
});

test("timeout or owner cancellation before and during execution clears state and never starts a duplicate call", async (t) => {
  let expiredActivations = 0;
  const expired = await startJobMatchQualificationOwnerReview({
    expectedCheckpoint: checkpoint(),
    cases: JOB_MATCH_QUALIFICATION_CASES,
    allowedOrigin: "https://apply.example.test",
    now,
    captureTimeoutMs: 20,
    sessionTimeoutMs: 20,
    execution: {
      clock: () => now,
      activateTransport: async () => {
        expiredActivations += 1;
        throw new Error("must not activate");
      }
    }
  });
  assert.deepEqual(await expired.closed, {
    reason: "session_timeout",
    trigger: "session_timeout",
    providerCallsStarted: 0,
    providerCallsCompleted: 0,
    knownInputTokens: 0,
    knownOutputTokens: 0,
    knownCachedInputTokens: 0,
    knownEstimatedCostMicros: 0,
    unknownBillingCallCount: 0,
    billingStatus: "no_provider_calls_started"
  });
  assert.equal(expiredActivations, 0);
  assert.equal(expired.hasPrivateInput(), false);

  let calls = 0;
  let releaseTransport!: () => void;
  const transportStarted = new Promise<void>((resolve) => { releaseTransport = resolve; });
  let unblock!: () => void;
  const blocked = new Promise<void>((resolve) => { unblock = resolve; });
  const cancelled = await startJobMatchQualificationOwnerReview({
    expectedCheckpoint: checkpoint(),
    cases: JOB_MATCH_QUALIFICATION_CASES,
    allowedOrigin: "https://apply.example.test",
    now,
    sessionTimeoutMs: 10_000,
    execution: {
      clock: () => now,
      activateTransport: async () => async (request) => {
        calls += 1;
        releaseTransport();
        await blocked;
        return {
          value: validModelOutput(fixedSyntheticProviderRecommendation(request.caseId)),
          finishReason: "STOP",
          responseBytes: 500,
          elapsedMs: 10,
          requestId: null,
          usage: {
            inputTokens: 100,
            outputTokens: 100,
            cachedInputTokens: 0,
            visibleOutputTokens: 100,
            thinkingTokens: 0
          }
        };
      }
    }
  });
  t.after(() => {
    unblock();
    cancelled.close("test_cleanup");
  });
  await admitRealSnapshot(cancelled);
  const ready = await finishOwnerReviews(cancelled);
  const consent = await fetch(cancelled.consentSubmissionUrl, {
    method: "POST",
    headers: { "content-type": "application/json", origin: cancelled.origin },
    body: JSON.stringify(executionConsent(ready.safeManifest))
  });
  assert.equal(consent.status, 202);
  await transportStarted;
  const cancel = await fetch(`${cancelled.cancelUrl}?trigger=owner_cancel`, {
    method: "POST",
    headers: { origin: cancelled.origin }
  });
  assert.equal(cancel.status, 204);
  assert.deepEqual(await cancelled.closed, {
    reason: "navigation_or_owner_cancel",
    trigger: "owner_cancel",
    providerCallsStarted: 1,
    providerCallsCompleted: 0,
    knownInputTokens: 0,
    knownOutputTokens: 0,
    knownCachedInputTokens: 0,
    knownEstimatedCostMicros: 0,
    unknownBillingCallCount: 1,
    billingStatus: "unknown_for_started_calls"
  });
  unblock();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls, 1);
  assert.equal(cancelled.hasPrivateInput(), false);
});

test("cancellation receipt retains only known completed-call cost metadata", async (t) => {
  let calls = 0;
  const workflow = await startJobMatchQualificationOwnerReview({
    expectedCheckpoint: checkpoint(),
    cases: JOB_MATCH_QUALIFICATION_CASES,
    allowedOrigin: "https://apply.example.test",
    now,
    sessionTimeoutMs: 10_000,
    execution: {
      clock: () => now,
      activateTransport: async () => async (request) => {
        calls += 1;
        return {
          value: validModelOutput(fixedSyntheticProviderRecommendation(request.caseId)),
          finishReason: "STOP",
          responseBytes: 500,
          elapsedMs: 10,
          requestId: `receipt-${calls}`,
          usage: {
            inputTokens: 100,
            outputTokens: 100,
            cachedInputTokens: 0,
            visibleOutputTokens: 100,
            thinkingTokens: 0
          }
        };
      }
    }
  });
  t.after(() => workflow.close("test_cleanup"));
  await admitRealSnapshot(workflow);
  const ready = await finishOwnerReviews(workflow);
  assert.equal((await fetch(workflow.consentSubmissionUrl, {
    method: "POST",
    headers: { "content-type": "application/json", origin: workflow.origin },
    body: JSON.stringify(executionConsent(ready.safeManifest))
  })).status, 202);
  await waitForPhase(workflow, "reviewing_provider_result");
  assert.equal(calls, 1);

  assert.equal((await fetch(`${workflow.cancelUrl}?trigger=status_poll_failure`, {
    method: "POST",
    headers: { origin: workflow.origin }
  })).status, 204);
  const receipt = await workflow.closed;
  assert.deepEqual(receipt, {
    reason: "navigation_or_owner_cancel",
    trigger: "status_poll_failure",
    providerCallsStarted: 1,
    providerCallsCompleted: 1,
    knownInputTokens: 100,
    knownOutputTokens: 100,
    knownCachedInputTokens: 0,
    knownEstimatedCostMicros: 450,
    unknownBillingCallCount: 0,
    billingStatus: "known_for_all_started_calls"
  });
  assert.doesNotMatch(JSON.stringify(receipt), /SYNTHETIC|Laserfiche|resume|profile/i);
});

test("cancellation receipt retains known billing for a completed invalid provider response", async (t) => {
  const workflow = await startJobMatchQualificationOwnerReview({
    expectedCheckpoint: checkpoint(),
    cases: JOB_MATCH_QUALIFICATION_CASES,
    allowedOrigin: "https://apply.example.test",
    now,
    sessionTimeoutMs: 10_000,
    execution: {
      clock: () => now,
      activateTransport: async () => async () => ({
        value: { rawPrivateModelText: "PRIVATE INVALID MODEL OUTPUT" },
        finishReason: "STOP",
        responseBytes: 321,
        elapsedMs: 45,
        requestId: "invalid-receipt",
        usage: {
          inputTokens: 1_000,
          outputTokens: 500,
          cachedInputTokens: 0,
          visibleOutputTokens: 300,
          thinkingTokens: 200
        }
      })
    }
  });
  t.after(() => workflow.close("test_cleanup"));
  await admitRealSnapshot(workflow);
  const ready = await finishOwnerReviews(workflow);
  assert.equal((await fetch(workflow.consentSubmissionUrl, {
    method: "POST",
    headers: { "content-type": "application/json", origin: workflow.origin },
    body: JSON.stringify(executionConsent(ready.safeManifest))
  })).status, 202);
  await waitForPhase(workflow, "execution_stopped");

  assert.equal((await fetch(`${workflow.cancelUrl}?trigger=owner_cancel`, {
    method: "POST",
    headers: { origin: workflow.origin }
  })).status, 204);
  const receipt = await workflow.closed;
  assert.equal(receipt.providerCallsStarted, 1);
  assert.equal(receipt.providerCallsCompleted, 1);
  assert.equal(receipt.knownInputTokens, 1_000);
  assert.equal(receipt.knownOutputTokens, 500);
  assert.equal(receipt.knownCachedInputTokens, 0);
  assert.ok(receipt.knownEstimatedCostMicros > 0);
  assert.equal(receipt.unknownBillingCallCount, 0);
  assert.equal(receipt.billingStatus, "known_for_all_started_calls");
  assert.doesNotMatch(JSON.stringify(receipt), /PRIVATE INVALID MODEL OUTPUT|rawPrivateModelText/);
});

test("cancellation receipt retains a definite zero-cost provider rejection", async (t) => {
  const workflow = await startJobMatchQualificationOwnerReview({
    expectedCheckpoint: checkpoint(),
    cases: JOB_MATCH_QUALIFICATION_CASES,
    allowedOrigin: "https://apply.example.test",
    now,
    sessionTimeoutMs: 10_000,
    execution: {
      clock: () => now,
      activateTransport: async () => async () => {
        throw new GeminiProviderError("PRIVATE PROVIDER DETAIL", {
          providerResponded: false,
          billingDisposition: "not_charged",
          httpStatus: null,
          providerCode: null,
          requestId: null
        });
      }
    }
  });
  t.after(() => workflow.close("test_cleanup"));
  await admitRealSnapshot(workflow);
  const ready = await finishOwnerReviews(workflow);
  assert.equal((await fetch(workflow.consentSubmissionUrl, {
    method: "POST",
    headers: { "content-type": "application/json", origin: workflow.origin },
    body: JSON.stringify(executionConsent(ready.safeManifest))
  })).status, 202);
  await waitForPhase(workflow, "execution_stopped");

  assert.equal((await fetch(`${workflow.cancelUrl}?trigger=owner_cancel`, {
    method: "POST",
    headers: { origin: workflow.origin }
  })).status, 204);
  const receipt = await workflow.closed;
  assert.equal(receipt.providerCallsStarted, 1);
  assert.equal(receipt.providerCallsCompleted, 0);
  assert.equal(receipt.knownEstimatedCostMicros, 0);
  assert.equal(receipt.unknownBillingCallCount, 0);
  assert.equal(receipt.billingStatus, "known_for_all_started_calls");
  assert.doesNotMatch(JSON.stringify(receipt), /PRIVATE PROVIDER DETAIL/);
});

test("cancellation receipt preserves a known subtotal while a later call remains uncertain", async (t) => {
  let calls = 0;
  let releaseSecond!: () => void;
  const secondBlocked = new Promise<void>((resolve) => { releaseSecond = resolve; });
  let markSecondStarted!: () => void;
  const secondStarted = new Promise<void>((resolve) => { markSecondStarted = resolve; });
  const workflow = await startJobMatchQualificationOwnerReview({
    expectedCheckpoint: checkpoint(),
    cases: JOB_MATCH_QUALIFICATION_CASES,
    allowedOrigin: "https://apply.example.test",
    now,
    sessionTimeoutMs: 10_000,
    execution: {
      clock: () => now,
      activateTransport: async () => async (request) => {
        calls += 1;
        if (calls === 2) {
          markSecondStarted();
          await secondBlocked;
        }
        return {
          value: validModelOutput(fixedSyntheticProviderRecommendation(request.caseId)),
          finishReason: "STOP",
          responseBytes: 500,
          elapsedMs: 10,
          requestId: `partial-receipt-${calls}`,
          usage: {
            inputTokens: 100,
            outputTokens: 100,
            cachedInputTokens: 0,
            visibleOutputTokens: 100,
            thinkingTokens: 0
          }
        };
      }
    }
  });
  t.after(() => {
    releaseSecond();
    workflow.close("test_cleanup");
  });
  await admitRealSnapshot(workflow);
  const ready = await finishOwnerReviews(workflow);
  assert.equal((await fetch(workflow.consentSubmissionUrl, {
    method: "POST",
    headers: { "content-type": "application/json", origin: workflow.origin },
    body: JSON.stringify(executionConsent(ready.safeManifest))
  })).status, 202);
  await waitForPhase(workflow, "reviewing_provider_result");
  assert.equal((await fetch(workflow.executionReviewSubmissionUrl, {
    method: "POST",
    headers: { "content-type": "application/json", origin: workflow.origin },
    body: JSON.stringify({
      caseId: JOB_MATCH_QUALIFICATION_CASES[0].id,
      disagreementCategories: []
    })
  })).status, 200);
  await secondStarted;

  assert.equal((await fetch(`${workflow.cancelUrl}?trigger=status_poll_failure`, {
    method: "POST",
    headers: { origin: workflow.origin }
  })).status, 204);
  assert.deepEqual(await workflow.closed, {
    reason: "navigation_or_owner_cancel",
    trigger: "status_poll_failure",
    providerCallsStarted: 2,
    providerCallsCompleted: 1,
    knownInputTokens: 100,
    knownOutputTokens: 100,
    knownCachedInputTokens: 0,
    knownEstimatedCostMicros: 450,
    unknownBillingCallCount: 1,
    billingStatus: "unknown_for_started_calls"
  });
});

test("capture admission is one-shot and a timed-out partial body cannot repopulate private state", async (t) => {
  const allowedOrigin = "https://apply.example.test";
  const body = JSON.stringify(capturePayload());
  const oneShot = await startJobMatchQualificationOwnerReview({
    expectedCheckpoint: checkpoint(),
    cases: JOB_MATCH_QUALIFICATION_CASES,
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
