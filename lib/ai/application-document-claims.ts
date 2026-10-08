import { PublicApiError } from "@/lib/api-errors";

export type ApplicationDocumentCitation = {
  ref: string;
  excerpt: string;
};

export type ApplicationDocumentClaimEvidence = {
  claim: string;
  citations: ApplicationDocumentCitation[];
};

export type ApplicationDocumentPayload = {
  job?: Record<string, unknown> | null;
  resume?: Record<string, unknown> | null;
  profile?: Record<string, unknown> | null;
  reviewedEvidence?: Record<string, unknown> | null;
};

type TailoredResumeClaimsOutput = {
  professionalSummary: string;
  skillsSection: string[];
  bulletRewrites: Array<{ original: string; rewrite: string; reason: string }>;
  rolesOrProjectsToEmphasize: string[];
  resumeText: string;
  claimEvidence: ApplicationDocumentClaimEvidence[];
};

type CoverLetterClaimsOutput = {
  coverLetter: string;
  claimsUsed: ApplicationDocumentClaimEvidence[];
};

const exactReferenceFields = {
  job: [
    "title", "company", "location", "remoteStatus", "salaryMin", "salaryMax", "description"
  ],
  resume: ["rawText", "summary"],
  profile: ["careerGoals", "remotePreference", "salaryTargetMin", "salaryTargetMax"]
} as const;

const indexedReferenceFields = {
  job: ["requirements", "preferredQualifications", "detectedTechStack"],
  resume: ["skills", "achievements", "workHistory", "projects", "education", "certifications"],
  profile: ["preferredRoles", "preferredLocations", "skillsToEmphasize", "skillsNotToExaggerate"]
} as const;

function present(value: unknown) {
  return typeof value === "string" ? value.trim().length > 0 : value !== null && value !== undefined;
}

function resolveReference(payload: ApplicationDocumentPayload, ref: string) {
  const reviewedFact = ref.match(/^reviewedEvidence\.facts\[(\d+)\]\.fact$/u);
  if (reviewedFact && Array.isArray(payload.reviewedEvidence?.facts)) {
    const value = payload.reviewedEvidence.facts[Number(reviewedFact[1])];
    if (value && typeof value === "object" && !Array.isArray(value) && present(value.fact)) {
      return value.fact;
    }
  }
  for (const [root, fields] of Object.entries(exactReferenceFields)) {
    const record = payload[root as keyof ApplicationDocumentPayload];
    for (const field of fields) {
      if (ref === `${root}.${field}` && record && present(record[field])) return record[field];
    }
  }
  for (const [root, fields] of Object.entries(indexedReferenceFields)) {
    const record = payload[root as keyof ApplicationDocumentPayload];
    for (const field of fields) {
      const match = ref.match(new RegExp(`^${root}\\.${field}\\[(\\d+)\\]$`));
      const values = record?.[field];
      if (!match || !Array.isArray(values)) continue;
      const index = Number(match[1]);
      if (Number.isSafeInteger(index) && index >= 0 && index < values.length && present(values[index])) {
        return values[index];
      }
    }
  }
  return undefined;
}

function evidenceText(value: unknown) {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? String(value)
    : JSON.stringify(value);
}

function comparable(value: string) {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function containsWhole(haystack: string, needle: string) {
  const escaped = needle.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return Boolean(escaped) && new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i").test(haystack);
}

const nonFactualWords = new Set([
  "a", "am", "an", "are", "have", "i", "is", "the"
]);

const negationWords = new Set([
  "no", "not", "never", "without", "lack", "lacks", "lacking", "avoid", "avoids", "zero"
]);

const actionWords = [
  "accelerated", "achieved", "architected", "automated", "built", "collaborated", "consolidated",
  "coordinated", "created", "decreased", "delivered", "designed", "developed", "engineered", "enhanced",
  "established", "executed", "expanded", "generated", "grew", "implemented", "improved", "increased",
  "launched", "led", "maintained", "managed", "mentored", "migrated", "modernized", "optimized",
  "orchestrated", "partnered", "produced", "reduced", "resolved", "scaled", "streamlined", "strengthened",
  "supported", "transformed", "used", "utilized"
] as const;
const actionWordSet = new Set<string>(actionWords);
const creationActionWords = new Set(["built", "created", "developed", "engineered"]);
const sentenceSegmenter = new Intl.Segmenter("en", { granularity: "sentence" });
const actionClauseBoundary = new RegExp(
  `\\s*;\\s*|\\s*,\\s*(?:and|but|while|then)\\s+|\\s+(?:and|but|while|then)\\s+(?=(?:${actionWords.join("|")})\\b)`,
  "i"
);

function distinctiveTokens(value: string) {
  return [...new Set(value.toLocaleLowerCase().match(/[a-z0-9][a-z0-9+#.-]*/g) ?? [])]
    .filter((token) => token.length >= 4 || /\d/.test(token))
    .filter((token) => !nonFactualWords.has(token));
}

function negatesTerm(claim: string, term: string) {
  const termLower = term.toLocaleLowerCase();
  return semanticClauses(claim).some((clause) => {
    const normalized = clause.toLocaleLowerCase().replaceAll("’", "'");
    if (!containsWhole(normalized, termLower)) return false;
    const withoutNotOnly = normalized.replace(/\bnot\s+only\b/g, "");
    return /\b(?:no|none|not|never|without|lack|lacks|lacking|avoid|avoids|cannot|can't|don't|doesn't|didn't|haven't|hasn't|hadn't|zero|0)\b/.test(withoutNotOnly);
  });
}

function evidenceContexts(source: string, excerpt: string) {
  const contexts: string[] = [];
  let index = source.indexOf(excerpt);
  while (index >= 0) {
    contexts.push(source.slice(Math.max(0, index - 64), Math.min(source.length, index + excerpt.length + 32)));
    index = source.indexOf(excerpt, index + Math.max(1, excerpt.length));
  }
  return contexts;
}

function factualTokens(value: string) {
  const normalized = value.toLocaleLowerCase()
    .replaceAll("’", "'")
    // A source fragment such as "No Kubernetes experience" and the explicit
    // first-person rendering "I do not have Kubernetes experience" express the
    // same negative fact. Keep this equivalence narrow so tense/status changes
    // (was/am, had/have) remain material everywhere else.
    .replace(/\b(?:do|does)\s+not\s+have\b/g, " not ");
  return (normalized.match(/[a-z0-9][a-z0-9+#.'-]*%?/g) ?? [])
    .map((token) => token.replace(/^[.'-]+|[.'-]+$/g, ""))
    .map((token) => {
      if (negationWords.has(token) || /^(?:cannot|can't|don't|doesn't|didn't|haven't|hasn't|hadn't)$/.test(token)) {
        return "__negated__";
      }
      return creationActionWords.has(token) ? "__creation_action__" : token;
    })
    .filter((token) =>
      token === "__negated__" ||
      token === "__creation_action__" ||
      actionWordSet.has(token) ||
      !nonFactualWords.has(token));
}

function semanticClauses(value: string) {
  return [...sentenceSegmenter.segment(value)]
    .flatMap(({ segment }) => segment.split(actionClauseBoundary))
    .map((clause) => clause.trim())
    .filter(Boolean);
}

function standaloneKey(value: string) {
  return comparable(value).replace(/^[\s,;:.-]+|[\s,;:.-]+$/g, "");
}

function containsStandaloneEvidence(value: unknown, excerpt: string): boolean {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    const target = standaloneKey(excerpt);
    return String(value).split(/\r?\n/)
      .flatMap((line) => semanticClauses(line))
      .some((clause) => standaloneKey(clause) === target);
  }
  if (Array.isArray(value)) return value.some((item) => containsStandaloneEvidence(item, excerpt));
  if (value && typeof value === "object") {
    return Object.values(value).some((item) => containsStandaloneEvidence(item, excerpt));
  }
  return false;
}

function sameTokens(left: string[], right: string[]) {
  return left.length === right.length && left.every((token, index) => token === right[index]);
}

function referenceCanSupportApplicantClaim(ref: string) {
  return ref.startsWith("resume.") ||
    /^reviewedEvidence\.facts\[\d+\]\.fact$/.test(ref) ||
    /^profile\.skillsToEmphasize\[\d+\]$/.test(ref);
}

function evidenceContainsWhole(value: unknown, term: string): boolean {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return containsWhole(comparable(String(value)), comparable(term));
  }
  if (Array.isArray(value)) return value.some((item) => evidenceContainsWhole(item, term));
  if (value && typeof value === "object") {
    return Object.values(value).some((item) => evidenceContainsWhole(item, term));
  }
  return false;
}

function unsupportedApplicantTerms(payload: ApplicationDocumentPayload) {
  const candidates = [
    ...(Array.isArray(payload.profile?.skillsNotToExaggerate) ? payload.profile.skillsNotToExaggerate : []),
    ...(Array.isArray(payload.job?.detectedTechStack) ? payload.job.detectedTechStack : []),
    ...(Array.isArray(payload.job?.requirements) ? payload.job.requirements : []),
    ...(Array.isArray(payload.job?.preferredQualifications) ? payload.job.preferredQualifications : [])
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);
  const qualificationEvidence = {
    resume: payload.resume ?? {},
    reviewedEvidence: payload.reviewedEvidence ?? {},
    skillsToEmphasize: Array.isArray(payload.profile?.skillsToEmphasize)
      ? payload.profile.skillsToEmphasize
      : []
  };
  return [...new Set(candidates.map((value) => value.trim()))]
    .filter((term) => !evidenceContainsWhole(qualificationEvidence, term));
}

function validateClaimEvidence(
  payload: ApplicationDocumentPayload,
  claims: ApplicationDocumentClaimEvidence[],
  fieldPrefix: "claimEvidence" | "claimsUsed"
) {
  const supportedClaims = new Set<string>();
  const unsupportedTerms = unsupportedApplicantTerms(payload);
  for (const [claimIndex, entry] of claims.entries()) {
    const claim = entry.claim.trim();
    if (!claim || !entry.citations.length) {
      throw new PublicApiError("Application document claim is missing source evidence.", 422, {
        code: "APPLICATION_DOCUMENT_EVIDENCE_REQUIRED",
        fieldPath: `${fieldPrefix}[${claimIndex}]`,
        retryable: false
      });
    }
    const applicantEvidence: Array<{
      excerpt: string;
      contexts: string[];
      standalone: boolean;
      eligible: boolean;
    }> = [];
    for (const [citationIndex, citation] of entry.citations.entries()) {
      const resolved = resolveReference(payload, citation.ref);
      const source = citation.ref.startsWith("job.") ? "job" : "applicant";
      if (resolved === undefined) {
        throw new PublicApiError(`Application document returned an unknown ${source} evidence reference.`, 422, {
          code: "APPLICATION_DOCUMENT_UNKNOWN_REFERENCE",
          fieldPath: `${fieldPrefix}[${claimIndex}].citations[${citationIndex}].ref`,
          retryable: false
        });
      }
      const haystack = comparable(evidenceText(resolved));
      const excerpt = comparable(citation.excerpt);
      if (!excerpt || !haystack.includes(excerpt)) {
        throw new PublicApiError(`Application document returned an unsupported ${source} evidence excerpt.`, 422, {
          code: "APPLICATION_DOCUMENT_UNSUPPORTED_EXCERPT",
          fieldPath: `${fieldPrefix}[${claimIndex}].citations[${citationIndex}].excerpt`,
          retryable: false
        });
      }
      if (!citation.ref.startsWith("job.")) {
        applicantEvidence.push({
          excerpt,
          contexts: evidenceContexts(haystack, excerpt),
          standalone: containsStandaloneEvidence(resolved, citation.excerpt),
          eligible: referenceCanSupportApplicantClaim(citation.ref)
        });
      }
    }
    if (!applicantEvidence.length) {
      throw new PublicApiError("Application document claim is missing applicant evidence.", 422, {
        code: "APPLICATION_DOCUMENT_APPLICANT_EVIDENCE_REQUIRED",
        fieldPath: `${fieldPrefix}[${claimIndex}].citations`,
        retryable: false
      });
    }
    for (const token of distinctiveTokens(claim)) {
      const evidenceNegatesToken = applicantEvidence.some(({ excerpt, contexts, standalone }) =>
        (standalone ? [excerpt] : contexts)
          .some((context) => containsWhole(context, token) && negatesTerm(context, token)));
      if (evidenceNegatesToken && !negatesTerm(claim, token)) {
        throw new PublicApiError("Application document reverses negated applicant evidence.", 422, {
          code: "APPLICATION_DOCUMENT_NEGATION_REVERSAL",
          fieldPath: `${fieldPrefix}[${claimIndex}].claim`,
          retryable: false
        });
      }
    }
    for (const term of unsupportedTerms) {
      if (containsWhole(claim, term) && !negatesTerm(claim, term)) {
        throw new PublicApiError("Application document contains an unsupported applicant claim.", 422, {
          code: "APPLICATION_DOCUMENT_UNSUPPORTED_CLAIM",
          fieldPath: `${fieldPrefix}[${claimIndex}].claim`,
          retryable: false
        });
      }
    }
    const claimFacts = factualTokens(claim);
    const relationPreserved = applicantEvidence.some(({ excerpt, standalone, eligible }) =>
      eligible && standalone && sameTokens(factualTokens(excerpt), claimFacts));
    if (!relationPreserved) {
      throw new PublicApiError("Application document contains an unsupported applicant claim.", 422, {
        code: "APPLICATION_DOCUMENT_UNSUPPORTED_CLAIM",
        fieldPath: `${fieldPrefix}[${claimIndex}].claim`,
        retryable: false
      });
    }
    supportedClaims.add(comparable(claim));
  }
  return supportedClaims;
}

function requireClaims(claims: Set<string>, values: Array<{ value: string; fieldPath: string }>) {
  for (const { value, fieldPath } of values.map((item) => ({
    ...item,
    value: item.value.trim()
  })).filter((item) => item.value)) {
    if (!claims.has(comparable(value))) {
      throw new PublicApiError("Application document is missing source evidence for generated claim.", 422, {
        code: "APPLICATION_DOCUMENT_EVIDENCE_REQUIRED",
        fieldPath,
        retryable: false
      });
    }
  }
}

function isHeading(line: string) {
  return /^(?:SUMMARY|PROFILE|SKILLS|EXPERIENCE|WORK EXPERIENCE|PROJECTS|EDUCATION|CERTIFICATIONS|ACHIEVEMENTS|ADDITIONAL INFORMATION)$/i.test(line);
}

export function validateTailoredResumeClaims<T extends TailoredResumeClaimsOutput>(
  payload: ApplicationDocumentPayload,
  output: T
) {
  const supportedClaims = validateClaimEvidence(payload, output.claimEvidence, "claimEvidence");
  const requiredClaims = [
    { value: output.professionalSummary, fieldPath: "professionalSummary" },
    ...output.skillsSection.map((value, index) => ({ value, fieldPath: `skillsSection[${index}]` })),
    ...output.bulletRewrites.map((rewrite, index) => ({
      value: rewrite.rewrite,
      fieldPath: `bulletRewrites[${index}].rewrite`
    })),
    ...output.rolesOrProjectsToEmphasize.map((value, index) => ({
      value,
      fieldPath: `rolesOrProjectsToEmphasize[${index}]`
    }))
  ];
  requireClaims(supportedClaims, requiredClaims);

  const sourceText = comparable(evidenceText(payload.resume ?? {}));
  for (const [lineIndex, rawLine] of output.resumeText.split(/\r?\n/).entries()) {
    const line = rawLine.trim().replace(/^[-•]\s*/, "");
    if (!line || isHeading(line) || sourceText.includes(comparable(line))) continue;
    if (!supportedClaims.has(comparable(line))) {
      throw new PublicApiError("Application document is missing source evidence for generated claim.", 422, {
        code: "APPLICATION_DOCUMENT_EVIDENCE_REQUIRED",
        fieldPath: `resumeText.line[${lineIndex}]`,
        retryable: false
      });
    }
  }
  return output;
}

function sentenceKey(value: string) {
  return comparable(value).replace(/[.!?]+$/, "");
}

function exactCoverBoilerplate(payload: ApplicationDocumentPayload) {
  const title = typeof payload.job?.title === "string" ? payload.job.title.trim() : "";
  const company = typeof payload.job?.company === "string" ? payload.job.company.trim() : "";
  const values = [
    "I am interested in learning more about the role and how I might contribute to your team.",
    "I would welcome the opportunity to discuss the role further.",
    "I would welcome the opportunity to discuss this position further.",
    "I would welcome the opportunity to discuss how I might contribute.",
    "I hope to discuss the role.",
    "I hope to speak with you.",
    "I look forward to hearing from you.",
    "I look forward to discussing the role.",
    "I look forward to speaking with you.",
    "Thank you for your time and consideration."
  ];
  if (title) {
    values.push(
      `I am writing about the ${title} position.`,
      `I am writing to apply for the ${title} position.`,
      `I am applying for the ${title} position.`,
      `I am interested in the ${title} role.`
    );
  }
  if (company) values.push(`Dear ${company} Hiring Team,`);
  values.push("Dear Hiring Team,", "Sincerely,", "Best,", "Best regards,", "Regards,", "Thank you,");
  return new Set(values.map(sentenceKey));
}

function coverSentencesRequiringEvidence(payload: ApplicationDocumentPayload, text: string) {
  const exempt = exactCoverBoilerplate(payload);
  const firstResumeLine = typeof payload.resume?.rawText === "string"
    ? payload.resume.rawText.split(/\r?\n/).map((line) => line.trim()).find(Boolean)
    : undefined;
  if (firstResumeLine) exempt.add(sentenceKey(firstResumeLine));
  exempt.add(sentenceKey("[Your name]"));
  return text.split(/\r?\n/)
    .flatMap((line) => [...sentenceSegmenter.segment(line)].map(({ segment }) => segment.trim()))
    .filter((sentence) => sentence && !exempt.has(sentenceKey(sentence)));
}

export function validateCoverLetterClaims<T extends CoverLetterClaimsOutput>(
  payload: ApplicationDocumentPayload,
  output: T
) {
  const supportedClaims = validateClaimEvidence(payload, output.claimsUsed, "claimsUsed");
  for (const [claimIndex, entry] of output.claimsUsed.entries()) {
    if (!comparable(output.coverLetter).includes(comparable(entry.claim))) {
      throw new PublicApiError("Cover-letter evidence describes text absent from the generated letter.", 422, {
        code: "APPLICATION_DOCUMENT_CLAIM_NOT_IN_OUTPUT",
        fieldPath: `claimsUsed[${claimIndex}].claim`,
        retryable: false
      });
    }
  }
  requireClaims(supportedClaims, coverSentencesRequiringEvidence(payload, output.coverLetter).map((value) => ({
    value,
    fieldPath: "coverLetter"
  })));
  return output;
}
