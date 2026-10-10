import { JOB_MATCH_PROMPT_VERSION } from "@/lib/ai/job-match-version";
import { hasEvidenceNegationCue } from "@/lib/evidence-negation";
import type { AcceptedEvidenceFact } from "@/lib/jobs/evidence-snapshot-contracts";

export type EvidenceFactSection =
  | "raw_source"
  | "summary"
  | "skills"
  | "achievements"
  | "work_history"
  | "projects"
  | "education"
  | "certifications";

export type ExtractedEvidenceFact = Readonly<{
  id: string;
  ref: string;
  section: EvidenceFactSection;
  label: string;
  value: string;
  sourceAuthoritative: boolean;
}>;

export type EvidenceReviewGap = Readonly<{
  id: string;
  requirement: string;
  jobRef: string | null;
  missingKeywords: string[];
}>;

export type EvidenceCorrectionReview = Readonly<{
  schema: "apply-pilot/evidence-correction-review/v1";
  persistence: "durable_job_only";
  jobId: string;
  resumeId: string;
  resumeUpdatedAt: string;
  analysisId: string | null;
  analysisInputHash: string | null;
  analysisModel: string | null;
  analysisPromptVersion: string | null;
  selectedResumeDocumentId: string | null;
  selectedCoverLetterDocumentId: string | null;
  facts: ExtractedEvidenceFact[];
  acceptedFacts: AcceptedEvidenceFact[];
  gaps: EvidenceReviewGap[];
}>;

type ReuseFields = {
  reuseScope: "JOB_ONLY" | "MASTER_PROFILE";
  masterProfileOptIn: boolean;
};

export type EvidenceCorrectionDecision =
  | ({
      gapId: string;
      kind: "SOURCE_CORRECTION";
      sourceFactId: string;
      sourceExcerpt: string;
      correctedFact: string;
    } & ReuseFields)
  | ({
      gapId: string;
      kind: "OWNER_ATTESTATION";
      attestedFact: string;
      ownerAttested: boolean;
    } & ReuseFields)
  | ({ gapId: string; kind: "UNRESOLVED" } & ReuseFields);

export type ReviewedDecision = Readonly<{
  gapId: string;
  status: "RESOLVED" | "UNRESOLVED";
  fact: string | null;
  provenance:
    | { kind: "EXISTING_SOURCE"; sourceFactId: string; sourceRef: string; sourceExcerpt: string }
    | { kind: "OWNER_ATTESTED"; ownerAttested: true }
    | { kind: "NONE" };
  reuseScope: "JOB_ONLY" | "MASTER_PROFILE";
  masterProfileOptIn: boolean;
}>;

export type ReviewedEvidenceSnapshot = Readonly<{
  schema: "apply-pilot/reviewed-evidence-snapshot/v1";
  snapshotHash: string;
  jobId: string;
  resumeId: string;
  resumeUpdatedAt: string;
  reviewedAt: string;
  facts: ExtractedEvidenceFact[];
  gaps: EvidenceReviewGap[];
  decisions: ReviewedDecision[];
  invalidations: {
    assessmentIds: string[];
    resumeDocumentIds: string[];
    coverLetterDocumentIds: string[];
    totalCount: number;
    reason: "EVIDENCE_SNAPSHOT_CHANGED";
  };
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clean(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function addFact(
  facts: ExtractedEvidenceFact[],
  ref: string,
  section: EvidenceFactSection,
  label: string,
  value: unknown,
  sourceAuthoritative = false
) {
  const text = clean(value);
  if (!text) return;
  facts.push(Object.freeze({ id: `fact:${ref}`, ref, section, label, value: text, sourceAuthoritative }));
}

function fieldLabel(value: string) {
  return value.replace(/([a-z])([A-Z])/gu, "$1 $2").replace(/^./u, (letter) => letter.toUpperCase());
}

function addTypedFacts(
  facts: ExtractedEvidenceFact[],
  value: unknown,
  ref: string,
  section: EvidenceFactSection,
  label: string
) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => addTypedFacts(facts, item, `${ref}[${index}]`, section, `${label} ${index + 1}`));
    return;
  }
  if (isRecord(value)) {
    Object.entries(value).forEach(([key, item]) =>
      addTypedFacts(facts, item, `${ref}.${key}`, section, `${label} · ${fieldLabel(key)}`));
    return;
  }
  addFact(facts, ref, section, label, value, ref === "resume.rawText" || ref.endsWith(".sourceText"));
}

function addIndexedFacts(
  facts: ExtractedEvidenceFact[],
  values: unknown,
  ref: string,
  section: EvidenceFactSection,
  label: string
) {
  if (!Array.isArray(values)) return;
  values.forEach((value, index) => addTypedFacts(facts, value, `${ref}[${index}]`, section, `${label} ${index + 1}`));
}

function readGaps(value: unknown): EvidenceReviewGap[] {
  if (!isRecord(value) || value.contractVersion !== "3" || value.promptVersion !== JOB_MATCH_PROMPT_VERSION) return [];
  if (!Array.isArray(value.requirementGaps)) return [];
  return value.requirementGaps.flatMap((candidate, index) => {
    if (!isRecord(candidate) || typeof candidate.requirement !== "string" || !candidate.requirement.trim()) return [];
    const citation = isRecord(candidate.jobRequirement) ? candidate.jobRequirement : null;
    return [Object.freeze({
      id: `gap:${index}`,
      requirement: candidate.requirement.trim(),
      jobRef: typeof citation?.ref === "string" ? citation.ref : null,
      missingKeywords: Array.isArray(candidate.missingKeywords)
        ? candidate.missingKeywords.filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
        : []
    })];
  });
}

export function buildEvidenceCorrectionReview(input: {
  jobId: string;
  resumeId: string;
  resumeUpdatedAt: string;
  resume: unknown;
  analysisId: string | null;
  analysisInputHash?: string | null;
  analysisModel?: string | null;
  analysisPromptVersion?: string | null;
  analysisOutput: unknown;
  selectedResumeDocumentId?: string | null;
  selectedCoverLetterDocumentId?: string | null;
  acceptedFacts?: AcceptedEvidenceFact[];
}): EvidenceCorrectionReview {
  const resume = isRecord(input.resume) ? input.resume : {};
  const facts: ExtractedEvidenceFact[] = [];
  addFact(facts, "resume.rawText", "raw_source", "Original resume text", resume.rawText, true);
  addFact(facts, "resume.summary", "summary", "Summary", resume.summary);
  addIndexedFacts(facts, resume.skills, "resume.skills", "skills", "Skill group");
  addIndexedFacts(facts, resume.achievements, "resume.achievements", "achievements", "Achievement");
  addIndexedFacts(facts, resume.workHistory, "resume.workHistory", "work_history", "Work record");
  addIndexedFacts(facts, resume.projects, "resume.projects", "projects", "Project");
  addIndexedFacts(facts, resume.education, "resume.education", "education", "Education record");
  addIndexedFacts(facts, resume.certifications, "resume.certifications", "certifications", "Certification");
  return Object.freeze({
    schema: "apply-pilot/evidence-correction-review/v1",
    persistence: "durable_job_only",
    jobId: input.jobId,
    resumeId: input.resumeId,
    resumeUpdatedAt: input.resumeUpdatedAt,
    analysisId: input.analysisId,
    analysisInputHash: input.analysisInputHash ?? null,
    analysisModel: input.analysisModel ?? null,
    analysisPromptVersion: input.analysisPromptVersion ?? null,
    selectedResumeDocumentId: input.selectedResumeDocumentId ?? null,
    selectedCoverLetterDocumentId: input.selectedCoverLetterDocumentId ?? null,
    facts,
    acceptedFacts: input.acceptedFacts ?? [],
    gaps: readGaps(input.analysisOutput)
  });
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== "snapshotHash")
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stableValue(item)]));
  }
  return value;
}

export async function hashEvidenceSnapshot(value: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify(stableValue(value)));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function validateReuse(decision: EvidenceCorrectionDecision) {
  if (decision.reuseScope === "MASTER_PROFILE" && decision.masterProfileOptIn !== true) {
    throw new Error("Reusable evidence requires explicit master-profile opt-in.");
  }
}

function completeSourceLineRange(source: string, candidate: string): string | null {
  const sourceLines = source.replace(/\r\n?/gu, "\n").split("\n").map((line) => line.trim());
  const candidateLines = candidate.replace(/\r\n?/gu, "\n").split("\n").map((line) => line.trim());
  if (candidateLines.some((line, index) => !line && (index === 0 || index === candidateLines.length - 1))) {
    return null;
  }
  for (let start = 0; start + candidateLines.length <= sourceLines.length; start += 1) {
    if (candidateLines.every((line, offset) => line === sourceLines[start + offset])) {
      for (let contextIndex = start - 1; contextIndex >= 0; contextIndex -= 1) {
        const contextLine = sourceLines[contextIndex];
        if (!contextLine) break;
        if (/[.!?]["')\]]?$/u.test(contextLine)) break;
        if (hasEvidenceNegationCue(contextLine)) {
          return null;
        }
      }
      return sourceLines.slice(start, start + candidateLines.length).join("\n");
    }
  }
  return null;
}

export function validateRetainedAcceptedFact(
  review: EvidenceCorrectionReview,
  fact: AcceptedEvidenceFact
): AcceptedEvidenceFact {
  if (fact.reuseScope !== "JOB_ONLY" || fact.masterProfileOptIn !== false) {
    throw new Error("Reviewed evidence can only be retained for this job.");
  }
  if (fact.provenance.kind === "OWNER_ATTESTED") return fact;
  const provenance = fact.provenance;
  const source = review.facts.find((candidate) =>
    candidate.id === provenance.sourceFactId &&
    candidate.ref === provenance.sourceRef &&
    candidate.sourceAuthoritative
  );
  const currentExcerpt = source
    ? completeSourceLineRange(source.value, provenance.sourceExcerpt)
    : null;
  if (!currentExcerpt || currentExcerpt !== fact.fact) {
    throw new Error("A retained source-backed fact no longer matches the current submitted resume source.");
  }
  return fact;
}

function normalizeDecision(
  review: EvidenceCorrectionReview,
  gap: EvidenceReviewGap,
  decision: EvidenceCorrectionDecision | undefined
): ReviewedDecision {
  if (!decision || decision.kind === "UNRESOLVED") {
    return {
      gapId: gap.id,
      status: "UNRESOLVED",
      fact: null,
      provenance: { kind: "NONE" },
      reuseScope: "JOB_ONLY",
      masterProfileOptIn: false
    };
  }
  validateReuse(decision);
  if (decision.kind === "SOURCE_CORRECTION") {
    if (!decision.sourceExcerpt.trim() || !decision.correctedFact.trim()) {
      throw new Error("Source corrections require a non-empty source excerpt and corrected fact.");
    }
    const fact = review.facts.find((candidate) => candidate.id === decision.sourceFactId);
    const sourceExcerpt = decision.sourceExcerpt.trim();
    const correctedFact = decision.correctedFact.trim();
    if (!fact) {
      throw new Error("The selected extracted source was not found.");
    }
    if (!fact.sourceAuthoritative) {
      throw new Error("The selected extracted projection is not source-authoritative; cite raw text or record source text.");
    }
    if (sourceExcerpt !== correctedFact) {
      throw new Error("A source-backed fact must match the complete cited source excerpt exactly.");
    }
    const authoritativeExcerpt = completeSourceLineRange(fact.value, sourceExcerpt);
    if (!authoritativeExcerpt) {
      throw new Error("The correction must match one or more complete contiguous source lines from the cited extracted source.");
    }
    return {
      gapId: gap.id,
      status: "RESOLVED",
      fact: authoritativeExcerpt,
      provenance: {
        kind: "EXISTING_SOURCE",
        sourceFactId: fact.id,
        sourceRef: fact.ref,
        sourceExcerpt: authoritativeExcerpt
      },
      reuseScope: decision.reuseScope,
      masterProfileOptIn: decision.masterProfileOptIn
    };
  }
  if (!decision.ownerAttested || !decision.attestedFact.trim()) {
    throw new Error("Owner-attested evidence requires an explicit attestation and fact.");
  }
  return {
    gapId: gap.id,
    status: "RESOLVED",
    fact: decision.attestedFact.trim(),
    provenance: { kind: "OWNER_ATTESTED", ownerAttested: true },
    reuseScope: decision.reuseScope,
    masterProfileOptIn: decision.masterProfileOptIn
  };
}

export function normalizeEvidenceCorrectionDecisions(
  review: EvidenceCorrectionReview,
  decisions: EvidenceCorrectionDecision[]
): ReviewedDecision[] {
  const seen = new Set<string>();
  for (const decision of decisions) {
    if (seen.has(decision.gapId)) throw new Error("Each disputed gap can have only one review decision.");
    seen.add(decision.gapId);
    if (!review.gaps.some((gap) => gap.id === decision.gapId)) throw new Error("Unknown disputed gap.");
  }
  if (
    decisions.length !== review.gaps.length ||
    decisions.some((decision, index) => decision.gapId !== review.gaps[index]?.id)
  ) {
    throw new Error("Submit exactly one ordered review decision for every disputed gap.");
  }
  return review.gaps.map((gap) =>
    normalizeDecision(review, gap, decisions.find((decision) => decision.gapId === gap.id)));
}

export async function createReviewedEvidenceSnapshot(
  review: EvidenceCorrectionReview,
  decisions: EvidenceCorrectionDecision[],
  options: { reviewedAt: string }
): Promise<ReviewedEvidenceSnapshot> {
  const normalized = normalizeEvidenceCorrectionDecisions(review, decisions);
  const invalidations = {
    assessmentIds: review.analysisId ? [review.analysisId] : [],
    resumeDocumentIds: review.selectedResumeDocumentId ? [review.selectedResumeDocumentId] : [],
    coverLetterDocumentIds: review.selectedCoverLetterDocumentId ? [review.selectedCoverLetterDocumentId] : [],
    totalCount: Number(Boolean(review.analysisId)) + Number(Boolean(review.selectedResumeDocumentId)) +
      Number(Boolean(review.selectedCoverLetterDocumentId)),
    reason: "EVIDENCE_SNAPSHOT_CHANGED" as const
  };
  const content = {
    schema: "apply-pilot/reviewed-evidence-snapshot/v1" as const,
    jobId: review.jobId,
    resumeId: review.resumeId,
    resumeUpdatedAt: review.resumeUpdatedAt,
    reviewedAt: options.reviewedAt,
    facts: review.facts,
    gaps: review.gaps,
    decisions: normalized,
    invalidations
  };
  return Object.freeze({ ...content, snapshotHash: await hashEvidenceSnapshot(content) });
}
