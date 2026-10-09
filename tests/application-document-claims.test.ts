import assert from "node:assert/strict";
import { test } from "node:test";

import { PublicApiError } from "@/lib/api-errors";

const payload = {
  job: {
    title: "Platform Engineer",
    company: "Example Co",
    description: "Build reliable TypeScript services.",
    requirements: ["TypeScript"],
    preferredQualifications: ["Kubernetes"],
    detectedTechStack: ["TypeScript", "Kubernetes"]
  },
  resume: {
    rawText: [
      "Synthetic Applicant",
      "Platform Engineer",
      "TypeScript",
      "Example Co | Platform Engineer",
      "Built reliable TypeScript services."
    ].join("\n"),
    summary: "Platform engineer who built reliable TypeScript services.",
    skills: ["TypeScript"],
    achievements: [],
    workHistory: [{
      sourceText: "Example Co | Platform Engineer\nBuilt reliable TypeScript services.",
      company: "Example Co",
      title: "Platform Engineer",
      bullets: ["Built reliable TypeScript services."]
    }],
    projects: [],
    education: [],
    certifications: []
  },
  profile: {
    careerGoals: "Continue building reliable systems.",
    preferredRoles: ["Platform Engineer"],
    skillsToEmphasize: [] as string[],
    skillsNotToExaggerate: ["Kubernetes"]
  }
};

const resumeOutput = {
  professionalSummary: "Built reliable TypeScript services.",
  skillsSection: ["TypeScript"],
  bulletRewrites: [{
    original: "Built reliable TypeScript services.",
    rewrite: "Built reliable TypeScript services.",
    reason: "Keeps the supported result concise."
  }],
  rolesOrProjectsToEmphasize: ["Platform Engineer"],
  unsupportedKeywords: ["Kubernetes"],
  formattingWarnings: [],
  resumeText: [
    "Synthetic Applicant",
    "Platform Engineer",
    "",
    "SUMMARY",
    "Built reliable TypeScript services.",
    "",
    "SKILLS",
    "TypeScript",
    "",
    "EXPERIENCE",
    "Example Co | Platform Engineer",
    "• Built reliable TypeScript services."
  ].join("\n"),
  claimEvidence: [
    {
      claim: "Built reliable TypeScript services.",
      citations: [{ ref: "resume.workHistory[0]", excerpt: "Built reliable TypeScript services." }]
    },
    {
      claim: "TypeScript",
      citations: [{ ref: "resume.skills[0]", excerpt: "TypeScript" }]
    },
    {
      claim: "Platform Engineer",
      citations: [{ ref: "resume.workHistory[0]", excerpt: "Platform Engineer" }]
    }
  ]
};

async function claimsModule() {
  return import("@/lib/ai/application-document-claims").catch(() => null);
}

test("application-document claim validators are available", async () => {
  const claims = await claimsModule();
  assert.ok(claims);
  assert.equal(typeof claims.validateTailoredResumeClaims, "function");
  assert.equal(typeof claims.validateCoverLetterClaims, "function");
});

test("supported resume claims resolve exact submitted references and excerpts", async () => {
  const claims = await claimsModule();
  assert.ok(claims);
  assert.deepEqual(claims.validateTailoredResumeClaims(payload, resumeOutput), resumeOutput);
});

test("supported resume rewrites may strengthen only the action verb", async () => {
  const claims = await claimsModule();
  assert.ok(claims);
  const strengthened = structuredClone(resumeOutput);
  strengthened.professionalSummary = "Engineered reliable TypeScript services.";
  strengthened.bulletRewrites[0].rewrite = "Engineered reliable TypeScript services.";
  strengthened.resumeText = strengthened.resumeText.replaceAll(
    "Built reliable TypeScript services.",
    "Engineered reliable TypeScript services."
  );
  strengthened.claimEvidence[0].claim = "Engineered reliable TypeScript services.";
  assert.deepEqual(claims.validateTailoredResumeClaims(payload, strengthened), strengthened);
});

test("supported resume rewrites accept narrow non-leadership action paraphrases", async () => {
  const claims = await claimsModule();
  assert.ok(claims);
  for (const [source, rewrite] of [
    [
      "Improved incident workflows using TypeScript and PostgreSQL.",
      "Enhanced incident workflows using TypeScript and PostgreSQL."
    ],
    [
      "Reduced incident review time by 20%.",
      "Decreased incident review time by 20%."
    ],
    [
      "Improved incident handoffs.",
      "I enhanced incident handoffs."
    ],
    [
      "Built a certificate management system.",
      "Engineered a certificate management system."
    ],
    [
      "Improved credential verification workflows.",
      "Enhanced credential verification workflows."
    ]
  ]) {
    const paraphrasePayload = structuredClone(payload);
    paraphrasePayload.resume.rawText = `Synthetic Applicant\n${source}`;
    const changed = structuredClone(resumeOutput);
    changed.professionalSummary = rewrite;
    changed.bulletRewrites = [];
    changed.rolesOrProjectsToEmphasize = [];
    changed.skillsSection = [];
    changed.resumeText = `SUMMARY\n${rewrite}`;
    changed.claimEvidence = [{
      claim: rewrite,
      citations: [{ ref: "resume.rawText", excerpt: source }]
    }];
    assert.deepEqual(claims.validateTailoredResumeClaims(paraphrasePayload, changed), changed);
  }
});

test("action paraphrase groups cannot rewrite credential names or non-leading terms", async () => {
  const claims = await claimsModule();
  assert.ok(claims);
  const credentialPayload = structuredClone(payload);
  credentialPayload.resume.rawText = "Synthetic Applicant\nEarned an Enhanced Driver License.";
  const changed = structuredClone(resumeOutput);
  const claim = "Earned an Improved Driver License.";
  changed.professionalSummary = claim;
  changed.bulletRewrites = [];
  changed.rolesOrProjectsToEmphasize = [];
  changed.skillsSection = [];
  changed.resumeText = `SUMMARY\n${claim}`;
  changed.claimEvidence = [{
    claim,
    citations: [{
      ref: "resume.rawText",
      excerpt: "Earned an Enhanced Driver License."
    }]
  }];
  assert.throws(
    () => claims.validateTailoredResumeClaims(credentialPayload, changed),
    (error: unknown) => error instanceof PublicApiError &&
      error.details?.code === "APPLICATION_DOCUMENT_UNSUPPORTED_CLAIM" &&
      error.details?.failureClass === "source_relation_mismatch"
  );
});

test("unsupported-term and source-relation failures expose distinct privacy-safe classes", async () => {
  const claims = await claimsModule();
  assert.ok(claims);

  const unsupportedTerm = structuredClone(resumeOutput);
  unsupportedTerm.skillsSection.push("Kubernetes");
  unsupportedTerm.resumeText += "\nKubernetes";
  unsupportedTerm.claimEvidence.push({
    claim: "Kubernetes",
    citations: [{ ref: "resume.skills[0]", excerpt: "TypeScript" }]
  });
  assert.throws(
    () => claims.validateTailoredResumeClaims(payload, unsupportedTerm),
    (error: unknown) => error instanceof PublicApiError &&
      error.details?.code === "APPLICATION_DOCUMENT_UNSUPPORTED_CLAIM" &&
      error.details?.failureClass === "unsupported_applicant_term"
  );

  const relationMismatch = structuredClone(resumeOutput);
  relationMismatch.professionalSummary = "Scaled reliable TypeScript services.";
  relationMismatch.bulletRewrites[0].rewrite = "Scaled reliable TypeScript services.";
  relationMismatch.resumeText = relationMismatch.resumeText.replaceAll(
    "Built reliable TypeScript services.",
    "Scaled reliable TypeScript services."
  );
  relationMismatch.claimEvidence[0].claim = "Scaled reliable TypeScript services.";
  assert.throws(
    () => claims.validateTailoredResumeClaims(payload, relationMismatch),
    (error: unknown) => error instanceof PublicApiError &&
      error.details?.code === "APPLICATION_DOCUMENT_UNSUPPORTED_CLAIM" &&
      error.details?.failureClass === "source_relation_mismatch"
  );
});

test("action verbs cannot fabricate leadership or change supported scope", async () => {
  const claims = await claimsModule();
  assert.ok(claims);
  const scopedPayload = structuredClone(payload);
  scopedPayload.resume.rawText = "Synthetic Applicant\nSupported 10 engineers.";
  for (const verb of ["led", "managed", "architected"]) {
    const changed = structuredClone(resumeOutput);
    const claim = `${verb[0].toUpperCase()}${verb.slice(1)} 10 engineers.`;
    changed.professionalSummary = claim;
    changed.bulletRewrites[0].rewrite = claim;
    changed.resumeText = `SUMMARY\n${claim}\nEXPERIENCE\n${claim}`;
    changed.claimEvidence = [{
      claim,
      citations: [{ ref: "resume.rawText", excerpt: "Supported 10 engineers." }]
    }];
    changed.rolesOrProjectsToEmphasize = [];
    changed.skillsSection = [];
    assert.throws(
      () => claims.validateTailoredResumeClaims(scopedPayload, changed),
      (error: unknown) => error instanceof PublicApiError &&
        error.details?.code === "APPLICATION_DOCUMENT_UNSUPPORTED_CLAIM"
    );
  }
});

test("relationship words cannot reverse chronology, bounds, or employment scope", async () => {
  const claims = await claimsModule();
  assert.ok(claims);
  for (const [source, claim] of [
    ["Started after 2022.", "I started before 2022."],
    ["Worked within 10 months.", "I worked over 10 months."],
    ["Worked with Google.", "I worked for Google."]
  ]) {
    const relationPayload = structuredClone(payload);
    relationPayload.resume.rawText = `Synthetic Applicant\n${source}`;
    const changed = {
      title: "Example Co cover letter",
      coverLetter: `Dear Example Co Hiring Team,\n\n${claim}\n\nSincerely,\nSynthetic Applicant`,
      angle: "Synthetic relation reversal.",
      claimsUsed: [{
        claim,
        citations: [{ ref: "resume.rawText", excerpt: source }]
      }]
    };
    assert.throws(
      () => claims.validateCoverLetterClaims(relationPayload, changed),
      (error: unknown) => error instanceof PublicApiError &&
        error.details?.code === "APPLICATION_DOCUMENT_UNSUPPORTED_CLAIM"
    );
  }
});

test("status auxiliaries and possessives cannot fabricate current or owned qualifications", async () => {
  const claims = await claimsModule();
  assert.ok(claims);
  for (const [source, claim] of [
    ["I was a licensed CPA.", "I am a licensed CPA."],
    ["I had a valid security clearance.", "I have a valid security clearance."],
    ["Their patent won an award.", "My patent won an award."]
  ]) {
    const relationPayload = structuredClone(payload);
    relationPayload.resume.rawText = `Synthetic Applicant\n${source}`;
    const changed = {
      title: "Example Co cover letter",
      coverLetter: `Dear Example Co Hiring Team,\n\n${claim}\n\nSincerely,\nSynthetic Applicant`,
      angle: "Synthetic status or ownership swap.",
      claimsUsed: [{
        claim,
        citations: [{ ref: "resume.rawText", excerpt: source }]
      }]
    };
    assert.throws(
      () => claims.validateCoverLetterClaims(relationPayload, changed),
      (error: unknown) => error instanceof PublicApiError &&
        error.details?.code === "APPLICATION_DOCUMENT_UNSUPPORTED_CLAIM"
    );
  }
});

test("resume validation rejects an invented unsupported skill even when the model cites unrelated evidence", async () => {
  const claims = await claimsModule();
  assert.ok(claims);
  const invented = structuredClone(resumeOutput);
  invented.skillsSection.push("Kubernetes");
  invented.resumeText += "\nKubernetes";
  invented.claimEvidence.push({
    claim: "Kubernetes",
    citations: [{ ref: "resume.skills[0]", excerpt: "TypeScript" }]
  });
  assert.throws(
    () => claims.validateTailoredResumeClaims(payload, invented),
    (error: unknown) => error instanceof PublicApiError &&
      error.details?.code === "APPLICATION_DOCUMENT_UNSUPPORTED_CLAIM" &&
      error.details?.fieldPath === "claimEvidence[3].claim"
  );
});

test("job-description evidence cannot establish an applicant resume fact", async () => {
  const claims = await claimsModule();
  assert.ok(claims);
  const jobBacked = structuredClone(resumeOutput);
  jobBacked.professionalSummary = "Build reliable TypeScript services.";
  jobBacked.bulletRewrites[0].rewrite = "Build reliable TypeScript services.";
  jobBacked.resumeText = jobBacked.resumeText.replaceAll(
    "Built reliable TypeScript services.",
    "Build reliable TypeScript services."
  );
  jobBacked.claimEvidence[0] = {
    claim: "Build reliable TypeScript services.",
    citations: [{ ref: "job.description", excerpt: "Build reliable TypeScript services." }]
  };
  assert.throws(
    () => claims.validateTailoredResumeClaims(payload, jobBacked),
    (error: unknown) => error instanceof PublicApiError &&
      error.details?.code === "APPLICATION_DOCUMENT_APPLICANT_EVIDENCE_REQUIRED" &&
      error.details?.fieldPath === "claimEvidence[0].citations"
  );
});

test("profile goals and preferred roles cannot become current applicant qualifications", async () => {
  const claims = await claimsModule();
  assert.ok(claims);
  for (const [ref, excerpt, claim] of [
    ["profile.careerGoals", "Become a licensed CPA.", "Licensed CPA."],
    ["profile.careerGoals", "Licensed CPA", "I am a licensed CPA."],
    ["profile.careerGoals", "Security clearance", "I have security clearance."],
    ["profile.preferredRoles[0]", "Chief Financial Officer", "Chief Financial Officer."]
  ]) {
    const preferencePayload = structuredClone(payload);
    preferencePayload.profile.careerGoals = excerpt;
    preferencePayload.profile.preferredRoles = ["Chief Financial Officer"];
    const changed = structuredClone(resumeOutput);
    changed.professionalSummary = claim;
    changed.skillsSection = [];
    changed.bulletRewrites = [];
    changed.rolesOrProjectsToEmphasize = [];
    changed.resumeText = `SUMMARY\n${claim}`;
    changed.claimEvidence = [{
      claim,
      citations: [{ ref, excerpt }]
    }];
    assert.throws(
      () => claims.validateTailoredResumeClaims(preferencePayload, changed),
      (error: unknown) => error instanceof PublicApiError &&
        error.details?.code === "APPLICATION_DOCUMENT_UNSUPPORTED_CLAIM"
    );
  }
});

test("explicit profile skills remain valid evidence whether or not the job also names the skill", async () => {
  const claims = await claimsModule();
  assert.ok(claims);
  for (const detectedTechStack of [[], ["Kubernetes"]]) {
    const skillPayload = structuredClone(payload);
    skillPayload.resume.rawText = "Synthetic Applicant\nTypeScript";
    skillPayload.resume.skills = ["TypeScript"];
    skillPayload.profile.skillsToEmphasize = ["Kubernetes"];
    skillPayload.job.detectedTechStack = detectedTechStack;
    skillPayload.job.requirements = [];
    skillPayload.job.preferredQualifications = [];
    const changed = structuredClone(resumeOutput);
    changed.professionalSummary = "Kubernetes";
    changed.skillsSection = ["Kubernetes"];
    changed.bulletRewrites = [];
    changed.rolesOrProjectsToEmphasize = [];
    changed.resumeText = "SUMMARY\nKubernetes\nSKILLS\nKubernetes";
    changed.claimEvidence = [{
      claim: "Kubernetes",
      citations: [{ ref: "profile.skillsToEmphasize[0]", excerpt: "Kubernetes" }]
    }];
    assert.deepEqual(claims.validateTailoredResumeClaims(skillPayload, changed), changed);
  }
});

test("resume validation rejects a rewritten factual line omitted from claim evidence", async () => {
  const claims = await claimsModule();
  assert.ok(claims);
  const omitted = structuredClone(resumeOutput);
  omitted.professionalSummary = "Led a team of 14 engineers.";
  omitted.resumeText = omitted.resumeText.replace(
    "Built reliable TypeScript services.",
    "Led a team of 14 engineers."
  );
  assert.throws(
    () => claims.validateTailoredResumeClaims(payload, omitted),
    (error: unknown) => error instanceof PublicApiError &&
      error.details?.code === "APPLICATION_DOCUMENT_EVIDENCE_REQUIRED" &&
      error.details?.fieldPath === "professionalSummary"
  );
});

test("cover validation accepts cited applicant facts and rejects uncited invented facts", async () => {
  const claims = await claimsModule();
  assert.ok(claims);
  const supported = {
    title: "Example Co Platform Engineer cover letter",
    coverLetter: [
      "Dear Example Co Hiring Team,",
      "",
      "I built reliable TypeScript services.",
      "I am interested in the Platform Engineer role.",
      "",
      "Sincerely,",
      "Synthetic Applicant"
    ].join("\n"),
    angle: "Use the submitted TypeScript evidence without overstating Kubernetes.",
    claimsUsed: [{
      claim: "I built reliable TypeScript services.",
      citations: [{ ref: "resume.workHistory[0]", excerpt: "Built reliable TypeScript services." }]
    }]
  };
  assert.deepEqual(claims.validateCoverLetterClaims(payload, supported), supported);

  const invented = structuredClone(supported);
  invented.coverLetter = invented.coverLetter.replace(
    "I built reliable TypeScript services.",
    "I led a Kubernetes migration for 14 engineers."
  );
  invented.claimsUsed = [];
  assert.throws(
    () => claims.validateCoverLetterClaims(payload, invented),
    (error: unknown) => error instanceof PublicApiError &&
      error.details?.code === "APPLICATION_DOCUMENT_EVIDENCE_REQUIRED" &&
      error.details?.fieldPath === "coverLetter"
  );
});

test("cover validation rejects an uncited first-person status claim without an action verb or number", async () => {
  const claims = await claimsModule();
  assert.ok(claims);
  const invented = {
    title: "Example Co cover letter",
    coverLetter: "Dear Example Co Hiring Team,\n\nI am a Kubernetes architect.\n\nSincerely,\nSynthetic Applicant",
    angle: "Synthetic unsupported status claim.",
    claimsUsed: []
  };
  assert.throws(
    () => claims.validateCoverLetterClaims(payload, invented),
    (error: unknown) => error instanceof PublicApiError &&
      error.details?.code === "APPLICATION_DOCUMENT_EVIDENCE_REQUIRED" &&
      error.details?.fieldPath === "coverLetter"
  );
});

test("cover intent wording cannot hide an uncited quantified applicant claim", async () => {
  const claims = await claimsModule();
  assert.ok(claims);
  const invented = {
    title: "Example Co cover letter",
    coverLetter: "Dear Example Co Hiring Team,\n\nI would bring 10 years of Kubernetes leadership.\n\nSincerely,\nSynthetic Applicant",
    angle: "Synthetic unsupported quantified claim.",
    claimsUsed: []
  };
  assert.throws(
    () => claims.validateCoverLetterClaims(payload, invented),
    (error: unknown) => error instanceof PublicApiError &&
      error.details?.code === "APPLICATION_DOCUMENT_EVIDENCE_REQUIRED" &&
      error.details?.fieldPath === "coverLetter"
  );
});

test("cover application boilerplate must match the projected job title exactly", async () => {
  const claims = await claimsModule();
  assert.ok(claims);
  const invented = {
    title: "Example Co cover letter",
    coverLetter: "Dear Example Co Hiring Team,\n\nI am writing about my 10 years of Kubernetes experience for the position.\n\nSincerely,\nSynthetic Applicant",
    angle: "Synthetic boilerplate bypass.",
    claimsUsed: []
  };
  assert.throws(
    () => claims.validateCoverLetterClaims(payload, invented),
    (error: unknown) => error instanceof PublicApiError &&
      error.details?.code === "APPLICATION_DOCUMENT_EVIDENCE_REQUIRED"
  );
});

test("affirmative applicant claims cannot reverse negated resume evidence", async () => {
  const claims = await claimsModule();
  assert.ok(claims);
  const negatedPayload = structuredClone(payload);
  negatedPayload.resume.rawText = "Synthetic Applicant\nNo Kubernetes experience.";
  negatedPayload.resume.summary = "No Kubernetes experience.";
  negatedPayload.resume.skills = [];
  negatedPayload.resume.workHistory = [];
  const reversed = {
    title: "Example Co cover letter",
    coverLetter: "Dear Example Co Hiring Team,\n\nI have Kubernetes experience.\n\nSincerely,\nSynthetic Applicant",
    angle: "Synthetic negation reversal.",
    claimsUsed: [{
      claim: "I have Kubernetes experience.",
      citations: [{ ref: "resume.rawText", excerpt: "Kubernetes experience." }]
    }]
  };
  assert.throws(
    () => claims.validateCoverLetterClaims(negatedPayload, reversed),
    (error: unknown) => error instanceof PublicApiError &&
      error.details?.code === "APPLICATION_DOCUMENT_NEGATION_REVERSAL" &&
      error.details?.fieldPath === "claimsUsed[0].claim"
  );

  const preserved = structuredClone(reversed);
  preserved.coverLetter = preserved.coverLetter.replace(
    "I have Kubernetes experience.",
    "I do not have Kubernetes experience."
  );
  preserved.claimsUsed[0].claim = "I do not have Kubernetes experience.";
  preserved.claimsUsed[0].citations[0].excerpt = "No Kubernetes experience.";
  assert.deepEqual(claims.validateCoverLetterClaims(negatedPayload, preserved), preserved);
});

test("negation in a contrasting clause does not reject an affirmative standalone fact", async () => {
  const claims = await claimsModule();
  assert.ok(claims);
  for (const [source, excerpt, claim] of [
    [
      "No Java experience, but extensive Kubernetes experience.",
      "extensive Kubernetes experience.",
      "I have extensive Kubernetes experience."
    ],
    [
      "Kubernetes experience, but no Java experience.",
      "Kubernetes experience",
      "I have Kubernetes experience."
    ]
  ]) {
    const contrastPayload = structuredClone(payload);
    contrastPayload.resume.rawText = `Synthetic Applicant\n${source}`;
    const supported = {
      title: "Example Co cover letter",
      coverLetter: `Dear Example Co Hiring Team,\n\n${claim}\n\nSincerely,\nSynthetic Applicant`,
      angle: "Use only the affirmative standalone clause.",
      claimsUsed: [{
        claim,
        citations: [{ ref: "resume.rawText", excerpt }]
      }]
    };
    assert.deepEqual(claims.validateCoverLetterClaims(contrastPayload, supported), supported);
  }
});

test("claims cannot omit material qualification, ownership, or status context", async () => {
  const claims = await claimsModule();
  assert.ok(claims);
  for (const [source, excerpt, claim] of [
    ["AWS experience: none.", "AWS experience", "AWS experience."],
    ["Security clearance expired.", "Security clearance", "Security clearance."],
    ["CPA license is inactive.", "CPA license", "CPA license."],
    ["Kubernetes experience: 0 years.", "Kubernetes experience", "Kubernetes experience."],
    ["Aspiring Kubernetes architect.", "Kubernetes architect", "Kubernetes architect."],
    ["Studying for CPA certification.", "CPA certification", "CPA certification."],
    ["Worked under a licensed CPA.", "licensed CPA", "Licensed CPA."],
    ["Seeking security clearance.", "security clearance", "Security clearance."],
    ["Eligible to apply for RN licensure.", "RN licensure", "RN licensure."],
    ["Former security-cleared engineer.", "security-cleared engineer", "Security-cleared engineer."]
  ]) {
    const qualifiedPayload = structuredClone(payload);
    qualifiedPayload.resume.rawText = `Synthetic Applicant\n${source}`;
    const changed = {
      title: "Example Co cover letter",
      coverLetter: `Dear Example Co Hiring Team,\n\n${claim}\n\nSincerely,\nSynthetic Applicant`,
      angle: "Synthetic omitted qualifier.",
      claimsUsed: [{
        claim,
        citations: [{ ref: "resume.rawText", excerpt }]
      }]
    };
    assert.throws(
      () => claims.validateCoverLetterClaims(qualifiedPayload, changed),
      (error: unknown) => error instanceof PublicApiError &&
        ["APPLICATION_DOCUMENT_UNSUPPORTED_CLAIM", "APPLICATION_DOCUMENT_NEGATION_REVERSAL"]
          .includes(String(error.details?.code))
    );
  }
});

test("never-negated applicant evidence cannot support an affirmative claim", async () => {
  const claims = await claimsModule();
  assert.ok(claims);
  const negatedPayload = structuredClone(payload);
  negatedPayload.resume.rawText = "Synthetic Applicant\nNever used Kubernetes.";
  const reversed = {
    title: "Example Co cover letter",
    coverLetter: "Dear Example Co Hiring Team,\n\nI have used Kubernetes.\n\nSincerely,\nSynthetic Applicant",
    angle: "Synthetic never-negation reversal.",
    claimsUsed: [{
      claim: "I have used Kubernetes.",
      citations: [{ ref: "resume.rawText", excerpt: "used Kubernetes." }]
    }]
  };
  assert.throws(
    () => claims.validateCoverLetterClaims(negatedPayload, reversed),
    (error: unknown) => error instanceof PublicApiError &&
      error.details?.code === "APPLICATION_DOCUMENT_NEGATION_REVERSAL"
  );
});

test("quantities cannot be recombined across unrelated facts in one citation", async () => {
  const claims = await claimsModule();
  assert.ok(claims);
  const quantifiedPayload = structuredClone(payload);
  quantifiedPayload.resume.rawText = "Reduced latency 20%. Managed 10 engineers.";
  const swapped = {
    title: "Example Co cover letter",
    coverLetter: "Dear Example Co Hiring Team,\n\nI reduced latency 10%.\n\nSincerely,\nSynthetic Applicant",
    angle: "Synthetic quantity swap.",
    claimsUsed: [{
      claim: "I reduced latency 10%.",
      citations: [{ ref: "resume.rawText", excerpt: "Reduced latency 20%. Managed 10 engineers." }]
    }]
  };
  assert.throws(
    () => claims.validateCoverLetterClaims(quantifiedPayload, swapped),
    (error: unknown) => error instanceof PublicApiError &&
      error.details?.code === "APPLICATION_DOCUMENT_UNSUPPORTED_CLAIM"
  );
});

test("quantities cannot cross action-clause boundaries inside one citation", async () => {
  const claims = await claimsModule();
  assert.ok(claims);
  for (const source of [
    "Increased sales; supported 10 customers.",
    "Increased sales, and supported 10 customers."
  ]) {
    const quantifiedPayload = structuredClone(payload);
    quantifiedPayload.resume.rawText = `Synthetic Applicant\n${source}`;
    const recombined = {
      title: "Example Co cover letter",
      coverLetter: "Dear Example Co Hiring Team,\n\nI increased sales for 10 customers.\n\nSincerely,\nSynthetic Applicant",
      angle: "Synthetic cross-clause quantity swap.",
      claimsUsed: [{
        claim: "I increased sales for 10 customers.",
        citations: [{ ref: "resume.rawText", excerpt: source }]
      }]
    };
    assert.throws(
      () => claims.validateCoverLetterClaims(quantifiedPayload, recombined),
      (error: unknown) => error instanceof PublicApiError &&
        error.details?.code === "APPLICATION_DOCUMENT_UNSUPPORTED_CLAIM"
    );
  }
});

test("cover sentence segmentation preserves dotted technology names", async () => {
  const claims = await claimsModule();
  assert.ok(claims);
  const dottedPayload = structuredClone(payload);
  dottedPayload.resume.rawText += "\nBuilt Node.js services.";
  const supported = {
    title: "Example Co cover letter",
    coverLetter: "Dear Example Co Hiring Team,\n\nI built Node.js services.\n\nSincerely,\nSynthetic Applicant",
    angle: "Use the submitted Node.js evidence.",
    claimsUsed: [{
      claim: "I built Node.js services.",
      citations: [{ ref: "resume.rawText", excerpt: "Built Node.js services." }]
    }]
  };
  assert.deepEqual(claims.validateCoverLetterClaims(dottedPayload, supported), supported);
});

test("cover validation requires evidence for applicant claims without first-person pronouns", async () => {
  const claims = await claimsModule();
  assert.ok(claims);
  for (const sentence of [
    "This experience prepared me to lead Kubernetes migrations.",
    "A decade of Kubernetes leadership makes this candidate an ideal fit."
  ]) {
    const invented = {
      title: "Example Co cover letter",
      coverLetter: `Dear Example Co Hiring Team,\n\n${sentence}\n\nSincerely,\nSynthetic Applicant`,
      angle: "Synthetic third-person bypass.",
      claimsUsed: []
    };
    assert.throws(
      () => claims.validateCoverLetterClaims(payload, invented),
      (error: unknown) => error instanceof PublicApiError &&
        error.details?.code === "APPLICATION_DOCUMENT_EVIDENCE_REQUIRED"
    );
  }
});

test("claim validation rejects unknown references and excerpts absent from the submitted value", async () => {
  const claims = await claimsModule();
  assert.ok(claims);
  const unknown = structuredClone(resumeOutput);
  unknown.claimEvidence[0].citations[0].ref = "resume.workHistory[99]";
  assert.throws(
    () => claims.validateTailoredResumeClaims(payload, unknown),
    (error: unknown) => error instanceof PublicApiError &&
      error.details?.code === "APPLICATION_DOCUMENT_UNKNOWN_REFERENCE" &&
      error.details?.fieldPath === "claimEvidence[0].citations[0].ref"
  );

  const absent = structuredClone(resumeOutput);
  absent.claimEvidence[0].citations[0].excerpt = "Kubernetes migration";
  assert.throws(
    () => claims.validateTailoredResumeClaims(payload, absent),
    (error: unknown) => error instanceof PublicApiError &&
      error.details?.code === "APPLICATION_DOCUMENT_UNSUPPORTED_EXCERPT" &&
      error.details?.fieldPath === "claimEvidence[0].citations[0].excerpt"
  );
});

test("claim-validation failures expose a safe code and field path without echoing generated private text", async () => {
  const claims = await claimsModule();
  assert.ok(claims);
  const invented = structuredClone(resumeOutput);
  invented.professionalSummary = "Led a private acquisition worth $987654321.";
  invented.resumeText = invented.resumeText.replace(
    "Built reliable TypeScript services.",
    invented.professionalSummary
  );
  assert.throws(
    () => claims.validateTailoredResumeClaims(payload, invented),
    (error: unknown) => error instanceof PublicApiError &&
      error.status === 422 &&
      error.details?.code === "APPLICATION_DOCUMENT_EVIDENCE_REQUIRED" &&
      error.details?.fieldPath === "professionalSummary" &&
      !error.message.includes("987654321")
  );
});

test("job-only reviewed evidence can support a document claim through an explicit provenance-bearing reference", async () => {
  const claims = await claimsModule();
  assert.ok(claims);
  const reviewedPayload = {
    ...payload,
    reviewedEvidence: {
      schema: "apply-pilot/job-match-reviewed-evidence/v1",
      snapshotId: "snapshot-1",
      snapshotHash: "a".repeat(64),
      facts: [{
        gapId: "gap:0",
        fact: "Completed 480 hours of synthetic customer training.",
        provenance: "OWNER_ATTESTED",
        sourceRef: null
      }],
      unresolvedGapIds: []
    }
  };
  const sentence = "Completed 480 hours of synthetic customer training.";
  assert.doesNotThrow(() => claims.validateCoverLetterClaims(reviewedPayload, {
    title: "Example Co cover letter",
    coverLetter: `Dear Example Co Hiring Team,\n\n${sentence}\n\nSincerely,\nSynthetic Applicant`,
    angle: "Use explicitly reviewed evidence.",
    claimsUsed: [{
      claim: sentence,
      citations: [{ ref: "reviewedEvidence.facts[0].fact", excerpt: sentence }]
    }]
  }));
});
