import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";

import { hashAiInput } from "@/lib/ai/input-hash";
import { getJobMatchEvidenceReferences, type MatchInput } from "@/lib/ai/job-match";
import {
  buildApplicantQualificationSnapshot,
  buildQualificationPreparation,
  type ApplicantQualificationSnapshot,
  type QualificationCase,
  type QualificationExpectedCheckpoint,
  type QualificationHumanReviewAttestation,
  type QualificationPreparation,
  QUALIFICATION_REVIEW_ARTIFACT_VERSION
} from "@/lib/ai/job-match-qualification";
import {
  buildConservativeQualificationReviewGuides,
  createQualificationReviewGuide,
  getQualificationEvidenceCandidates,
  type QualificationReviewGuide,
  validatedQualificationReviewGuide
} from "@/lib/ai/job-match-qualification-review-guide";
import {
  createQualificationExecutionSession,
  type QualificationExecutionActivation
} from "@/lib/ai/job-match-qualification-execution-session";
import {
  assertQualificationOwnerReviewCheckpoint as assertCheckpoint,
  deepFreeze,
  parseQualificationOwnerReviewDecision,
  type QualificationJobContext,
  type QualificationReviewArtifact,
  type ReviewEvidenceItem
} from "@/lib/ai/job-match-qualification-owner-review-contract";
import {
  createRepeatableSubmissionAdmission,
  ownerReviewSecurityHeaders as securityHeaders,
  readBoundedOwnerReviewBody as readBoundedBody,
  sendOwnerReviewJson as sendJson,
  serveOwnerReviewAsset
} from "@/lib/ai/job-match-qualification-owner-review-http";

export {
  buildConservativeQualificationReviewGuides,
  createQualificationReviewGuide
} from "@/lib/ai/job-match-qualification-review-guide";
export type { QualificationReviewGuide } from "@/lib/ai/job-match-qualification-review-guide";
export type { QualificationOwnerReviewDecision } from "@/lib/ai/job-match-qualification-owner-review-contract";
export type { QualificationReviewArtifact } from "@/lib/ai/job-match-qualification-owner-review-contract";

const DEFAULT_CAPTURE_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_SESSION_TIMEOUT_MS = 30 * 60_000;
const MAX_SESSION_TIMEOUT_MS = 60 * 60_000;

type QualificationSourceResume = Readonly<{
  title: string;
  originalText: readonly ReviewEvidenceItem[];
  summary: readonly ReviewEvidenceItem[];
  workHistory: readonly ReviewEvidenceItem[];
  projects: readonly ReviewEvidenceItem[];
  education: readonly ReviewEvidenceItem[];
  certifications: readonly ReviewEvidenceItem[];
  achievements: readonly ReviewEvidenceItem[];
  skills: readonly ReviewEvidenceItem[];
}>;

export type QualificationOwnerReviewView = Readonly<{
  phase: "authoring_evidence_guides" | "reviewing" | "awaiting_separate_google_consent";
  memoryNotice: string;
  reviewedCaseCount: number;
  caseCount: number;
  syntheticPreview: boolean;
  finalManifest?: QualificationPreparation["safeManifest"];
  cases: readonly Readonly<{
    id: string;
    safeLabel: string;
    proposedRecommendation: "apply now" | "consider" | "skip";
    expectedBand: string;
    jobContext: QualificationJobContext;
    sourceResume: QualificationSourceResume;
    applicantEvidence: readonly ReviewEvidenceItem[];
    applicantCautions: readonly ReviewEvidenceItem[];
    preferenceContext: readonly ReviewEvidenceItem[];
    fitSummary: Readonly<{
      supportedCount: number;
      confirmedGapCount: number;
      unresolvedCount: number;
      questionGroupCount: number;
      totalCount: number;
    }>;
    supportedRequirements: readonly Readonly<{
      requirement: ReviewEvidenceItem;
      evidence: readonly ReviewEvidenceItem[];
      rationale: string;
    }>[];
    confirmedGaps: readonly Readonly<{
      requirement: ReviewEvidenceItem;
      rationale: string;
    }>[];
    clarificationGroups: readonly Readonly<{
      id: string;
      title: string;
      question: string;
      whyItMatters: string;
      requirements: readonly ReviewEvidenceItem[];
    }>[];
    allRequirements: readonly Readonly<{
      requirement: ReviewEvidenceItem;
      disposition: "supported" | "confirmed_gap" | "unknown" | "not_material";
      materiality: "must_have" | "important" | "preferred";
      evidence: readonly ReviewEvidenceItem[];
      candidateEvidence: readonly ReviewEvidenceItem[];
      candidateCategory: string;
      rationale: string;
    }>[];
  }>[];
}>;

function recordValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function textValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function textValues(value: unknown) {
  return Array.isArray(value)
    ? value.map(textValue).filter((entry): entry is string => entry !== null)
    : [];
}

function unique(values: readonly (string | null | undefined)[]) {
  return [...new Set(values.filter((entry): entry is string => Boolean(entry)))];
}

function readableLeaves(value: unknown): string[] {
  if (typeof value === "string" && value.trim()) return [value.trim()];
  if (typeof value === "number" || typeof value === "boolean") return [String(value)];
  if (Array.isArray(value)) return unique(value.flatMap(readableLeaves));
  const record = recordValue(value);
  return record ? unique(Object.values(record).flatMap(readableLeaves)) : [];
}

function money(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0
  }).format(value);
}

function salaryRange(minimum: number | null | undefined, maximum: number | null | undefined) {
  if (minimum != null && maximum != null) return `${money(minimum)}–${money(maximum)}`;
  if (minimum != null) return `From ${money(minimum)}`;
  if (maximum != null) return `Up to ${money(maximum)}`;
  return "Not listed";
}

function displayDate(value: string | undefined) {
  if (!value || !Number.isFinite(Date.parse(value))) return "Unavailable";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC"
  }).format(new Date(value));
}

function item(ref: string, label: string, title: string, details: readonly string[] = []): ReviewEvidenceItem {
  return deepFreeze({
    ref,
    label,
    title,
    details: unique(details),
    selectionLabel: `${label} — ${title}`
  });
}

function indexedValue(ref: string, prefix: string, value: unknown) {
  const match = ref.match(new RegExp(`^${prefix.replaceAll(".", "\\.")}\\[(\\d+)\\]$`, "u"));
  if (!match || !Array.isArray(value)) return undefined;
  return value[Number(match[1])];
}

function resolveEvidence(input: MatchInput, ref: string) {
  const exact: Record<string, unknown> = {
    "resume.summary": input.resume?.summary,
    "resume.rawText": input.resume?.rawText,
    "profile.careerGoals": input.profile?.careerGoals,
    "profile.remotePreference": input.profile?.remotePreference,
    "profile.salaryTargetMin": input.profile?.salaryTargetMin,
    "profile.salaryTargetMax": input.profile?.salaryTargetMax,
    "job.title": input.job.title,
    "job.company": input.job.company,
    "job.location": input.job.location,
    "job.remoteStatus": input.job.remoteStatus,
    "job.salaryMin": input.job.salaryMin,
    "job.salaryMax": input.job.salaryMax,
    "job.description": input.job.description
  };
  if (Object.prototype.hasOwnProperty.call(exact, ref)) return exact[ref];
  const indexed = [
    indexedValue(ref, "resume.skills", input.resume?.skills),
    indexedValue(ref, "resume.achievements", input.resume?.achievements),
    indexedValue(ref, "resume.workHistory", input.resume?.workHistory),
    indexedValue(ref, "resume.projects", input.resume?.projects),
    indexedValue(ref, "resume.education", input.resume?.education),
    indexedValue(ref, "resume.certifications", input.resume?.certifications),
    indexedValue(ref, "profile.preferredRoles", input.profile?.preferredRoles),
    indexedValue(ref, "profile.preferredLocations", input.profile?.preferredLocations),
    indexedValue(ref, "profile.skillsToEmphasize", input.profile?.skillsToEmphasize),
    indexedValue(ref, "profile.skillsNotToExaggerate", input.profile?.skillsNotToExaggerate),
    indexedValue(ref, "job.requirements", input.job.requirements),
    indexedValue(ref, "job.preferredQualifications", input.job.preferredQualifications),
    indexedValue(ref, "job.detectedTechStack", input.job.detectedTechStack)
  ].find((value) => value !== undefined);
  return indexed;
}

function formatEvidence(ref: string, value: unknown): ReviewEvidenceItem {
  const record = recordValue(value);
  const scalar = textValue(value) ?? (typeof value === "number" || typeof value === "boolean" ? String(value) : null);
  if (ref === "resume.summary") return item(ref, "Professional summary", scalar ?? "Not provided");
  if (ref === "resume.rawText") {
    return item(ref, "Original résumé text", "Complete submitted résumé", scalar?.split(/\r?\n/u) ?? []);
  }
  if (ref.startsWith("resume.skills[")) return item(ref, "Skill", scalar ?? "Not provided");
  if (ref.startsWith("resume.achievements[")) return item(ref, "Achievement", scalar ?? "Not provided");
  if (ref.startsWith("resume.workHistory[")) {
    const title = textValue(record?.title) ?? "Work experience";
    const company = textValue(record?.company);
    const period = unique([textValue(record?.startDate), textValue(record?.endDate)]).join(" – ");
    return item(ref, "Work experience", company ? `${title} at ${company}` : title, [
      textValue(record?.location),
      period || null,
      ...textValues(record?.bullets)
    ].filter((entry): entry is string => Boolean(entry)));
  }
  if (ref.startsWith("resume.projects[")) {
    const name = textValue(record?.name) ?? "Project";
    const technologies = textValues(record?.technologies);
    return item(ref, "Project", name, [
      textValue(record?.description),
      textValue(record?.date),
      technologies.length ? `Technologies: ${technologies.join(", ")}` : null,
      ...textValues(record?.bullets)
    ].filter((entry): entry is string => Boolean(entry)));
  }
  if (ref.startsWith("resume.education[")) {
    const credential = textValue(record?.credential);
    const field = textValue(record?.fieldOfStudy);
    const institution = textValue(record?.institution);
    const title = credential && field ? `${credential} in ${field}` : credential ?? field ?? institution ?? "Education";
    const period = unique([textValue(record?.startDate), textValue(record?.endDate)]).join(" – ");
    return item(ref, "Education", title, [
      institution && institution !== title ? institution : null,
      period || null,
      ...textValues(record?.details)
    ].filter((entry): entry is string => Boolean(entry)));
  }
  if (ref.startsWith("resume.certifications[")) {
    const title = textValue(record?.name) ?? "Certification";
    return item(ref, "Certification", title, [
      textValue(record?.issuer),
      textValue(record?.date),
      textValue(record?.expirationDate) ? `Expires ${textValue(record?.expirationDate)}` : null,
      ...textValues(record?.details)
    ].filter((entry): entry is string => Boolean(entry)));
  }
  if (ref === "profile.careerGoals") return item(ref, "Career goal", scalar ?? "Not provided");
  if (ref.startsWith("profile.preferredRoles[")) return item(ref, "Preferred role", scalar ?? "Not provided");
  if (ref.startsWith("profile.preferredLocations[")) return item(ref, "Preferred location", scalar ?? "Not provided");
  if (ref === "profile.remotePreference") return item(ref, "Preferred work arrangement", scalar ?? "Not provided");
  if (ref === "profile.salaryTargetMin") return item(ref, "Minimum target compensation", typeof value === "number" ? money(value) : "Not provided");
  if (ref === "profile.salaryTargetMax") return item(ref, "Maximum target compensation", typeof value === "number" ? money(value) : "Not provided");
  if (ref.startsWith("profile.skillsToEmphasize[")) return item(ref, "Skill to emphasize", scalar ?? "Not provided");
  if (ref.startsWith("profile.skillsNotToExaggerate[")) return item(ref, "Do not exaggerate", scalar ?? "Not provided");
  if (ref === "job.location") return item(ref, "Job location", scalar ?? "Not listed");
  if (ref === "job.remoteStatus") return item(ref, "Work arrangement", scalar ?? "Not listed");
  if (ref === "job.salaryMin") return item(ref, "Listed compensation minimum", typeof value === "number" ? money(value) : "Not listed");
  if (ref === "job.salaryMax") return item(ref, "Listed compensation maximum", typeof value === "number" ? money(value) : "Not listed");
  if (ref.startsWith("job.requirements[")) return item(ref, "Required qualification", scalar ?? "Not listed");
  if (ref.startsWith("job.preferredQualifications[")) return item(ref, "Preferred qualification", scalar ?? "Not listed");
  if (ref.startsWith("job.detectedTechStack[")) return item(ref, "Technology mentioned", scalar ?? "Not listed");
  const leaves = readableLeaves(value);
  return item(ref, "Submitted detail", leaves[0] ?? "Not provided", leaves.slice(1));
}

function evidenceItems(input: MatchInput, refs: readonly string[]) {
  return refs.map((ref) => formatEvidence(ref, resolveEvidence(input, ref)));
}

function sourceResumePreview(items: readonly ReviewEvidenceItem[], syntheticPreview: boolean): QualificationSourceResume {
  const section = (prefixes: readonly string[]) => items.filter((entry) =>
    prefixes.some((prefix) => entry.ref === prefix || entry.ref.startsWith(`${prefix}[`)));
  return deepFreeze({
    title: syntheticPreview ? "Synthetic source résumé" : "Source résumé",
    originalText: section(["resume.rawText"]),
    summary: section(["resume.summary"]),
    workHistory: section(["resume.workHistory"]),
    projects: section(["resume.projects"]),
    education: section(["resume.education"]),
    certifications: section(["resume.certifications"]),
    achievements: section(["resume.achievements"]),
    skills: section(["resume.skills"])
  });
}

export function buildQualificationOwnerReviewView(
  preparation: QualificationPreparation,
  cases: readonly QualificationCase[] = [],
  options: Readonly<{
    syntheticPreview?: boolean;
    reviewGuides?: readonly QualificationReviewGuide[];
  }> = {}
): QualificationOwnerReviewView {
  const syntheticPreview = options.syntheticPreview === true;
  const caseById = new Map(cases.map((entry) => [entry.id, entry]));
  const reviewGuides = options.reviewGuides
    ?? buildConservativeQualificationReviewGuides(preparation);
  const guideById = new Map(reviewGuides.map((guide) => [
    guide.caseId,
    validatedQualificationReviewGuide(preparation, guide)
  ]));
  const reviewedCaseCount = preparation.privateInputs.filter((entry) => entry.humanReviewAttestation).length;
  return deepFreeze({
    phase: preparation.safeManifest.readiness === "ready_for_separate_execution_consent"
      ? "awaiting_separate_google_consent" as const
      : "reviewing" as const,
    memoryNotice: preparation.safeManifest.readiness === "ready_for_separate_execution_consent"
      ? "The loopback process retains the reviewed private preparation for a separately approved next step; this final screen no longer contains applicant evidence. Process exit ends that in-memory handoff. JavaScript cannot guarantee physical memory zeroization or control browser/runtime internals."
      : "Private applicant evidence exists in this loopback server's memory and the current case is rendered in this browser tab; the workflow does not persist it. An acknowledged cancel releases server references. Navigation clears this tab and sends best-effort cancellation; timeout or process exit is the fallback. JavaScript cannot guarantee physical memory zeroization or control browser/runtime internals.",
    reviewedCaseCount,
    caseCount: preparation.privateInputs.length,
    syntheticPreview,
    ...(preparation.safeManifest.readiness === "ready_for_separate_execution_consent"
      ? { finalManifest: preparation.safeManifest }
      : {}),
    cases: preparation.privateInputs.map((prepared) => {
      const refs = getJobMatchEvidenceReferences(prepared.input);
      const sourceCase = caseById.get(prepared.caseId);
      const safeCase = preparation.safeManifest.cases.find((entry) => entry.id === prepared.caseId);
      const applicantEvidence = evidenceItems(prepared.input, [...refs.applicant, ...refs.preference]);
      const applicantEvidenceByRef = new Map(applicantEvidence.map((entry) => [entry.ref, entry]));
      const requirementEvidenceByRef = new Map(
        evidenceItems(prepared.input, refs.gap).map((entry) => [entry.ref, entry])
      );
      const guide = guideById.get(prepared.caseId);
      if (!guide) throw new Error("Qualification review guide is missing a frozen case.");
      const allRequirements = guide.requirements.map((entry) => ({
        requirement: requirementEvidenceByRef.get(entry.jobRef) as ReviewEvidenceItem,
        disposition: entry.disposition,
        materiality: entry.materiality,
        evidence: entry.applicantRefs.map((ref) => applicantEvidenceByRef.get(ref) as ReviewEvidenceItem),
        candidateEvidence: getQualificationEvidenceCandidates(prepared.input, entry.jobRef).applicantRefs
          .map((ref) => applicantEvidenceByRef.get(ref) as ReviewEvidenceItem),
        candidateCategory: getQualificationEvidenceCandidates(prepared.input, entry.jobRef).category,
        rationale: entry.rationale
      }));
      const sourceUrl = safeCase?.sourceUrl ?? sourceCase?.provenance.sourceUrl ?? "";
      const capturedAt = sourceCase?.provenance.capturedAt ?? "";
      return {
        id: prepared.caseId,
        safeLabel: prepared.safeLabel,
        proposedRecommendation: prepared.expectedRecommendation,
        expectedBand: prepared.expectedBand,
        jobContext: {
          title: prepared.input.job.title,
          company: prepared.input.job.company,
          location: prepared.input.job.location?.trim() || "Not listed",
          workArrangement: prepared.input.job.remoteStatus?.trim() || "Not listed",
          compensation: salaryRange(prepared.input.job.salaryMin, prepared.input.job.salaryMax),
          responsibilities: prepared.input.job.description.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean),
          technologies: [...(prepared.input.job.detectedTechStack ?? [])],
          sourceUrl,
          capturedAt,
          capturedAtLabel: displayDate(capturedAt)
        },
        sourceResume: sourceResumePreview(applicantEvidence, syntheticPreview),
        applicantEvidence,
        applicantCautions: evidenceItems(
          prepared.input,
          (prepared.input.profile?.skillsNotToExaggerate ?? []).map((_, index) =>
            `profile.skillsNotToExaggerate[${index}]`)
        ),
        preferenceContext: evidenceItems(prepared.input, [
          "job.location",
          "job.remoteStatus",
          "job.salaryMin",
          "job.salaryMax"
        ].filter((ref) => refs.job.includes(ref))),
        fitSummary: {
          supportedCount: allRequirements.filter((entry) => entry.disposition === "supported").length,
          confirmedGapCount: allRequirements.filter((entry) => entry.disposition === "confirmed_gap").length,
          unresolvedCount: allRequirements.filter((entry) => entry.disposition === "unknown").length,
          questionGroupCount: guide.clarifications.length,
          totalCount: allRequirements.length
        },
        supportedRequirements: allRequirements
          .filter((entry) => entry.disposition === "supported")
          .map((entry) => ({
            requirement: entry.requirement,
            evidence: entry.evidence,
            rationale: entry.rationale
          })),
        confirmedGaps: allRequirements
          .filter((entry) => entry.disposition === "confirmed_gap")
          .map((entry) => ({ requirement: entry.requirement, rationale: entry.rationale })),
        clarificationGroups: guide.clarifications.map((question) => ({
          id: question.id,
          title: question.title,
          question: question.question,
          whyItMatters: question.whyItMatters,
          requirements: question.jobRefs.map((ref) => requirementEvidenceByRef.get(ref) as ReviewEvidenceItem)
        })),
        allRequirements
      };
    })
  });
}

export function createQualificationReviewArtifact({
  preparation,
  reviewGuides,
  decision: decisionValue,
  reviewedAt
}: {
  preparation: QualificationPreparation;
  reviewGuides: readonly QualificationReviewGuide[];
  decision: unknown;
  reviewedAt: string;
}) {
  const decision = parseQualificationOwnerReviewDecision(decisionValue);
  const prepared = preparation.privateInputs.find((entry) => entry.caseId === decision.caseId);
  if (!prepared) throw new Error("Qualification review referenced an unknown case.");
  if (!Number.isFinite(Date.parse(reviewedAt))) throw new Error("Qualification review time is invalid.");
  const guideValue = reviewGuides.find((entry) => entry.caseId === prepared.caseId);
  if (!guideValue) throw new Error("Qualification review guide is missing a frozen case.");
  const guide = validatedQualificationReviewGuide(preparation, guideValue);
  if (decision.clarifications.length !== guide.clarifications.length
    || decision.clarifications.some((entry, index) => entry.questionId !== guide.clarifications[index].id)) {
    throw new Error("Qualification review must answer every clarification exactly once in source order.");
  }
  const clarifications = decision.clarifications.map((entry) => ({
    ...entry,
    context: entry.context.trim()
  }));
  const clarificationById = new Map(clarifications.map((entry) => [entry.questionId, entry]));
  for (const clarification of clarifications) {
    if (clarification.answer === "yes" && !clarification.context) {
      throw new Error("A yes answer that introduces experience requires source context.");
    }
  }
  const userAttestations = guide.clarifications.flatMap((question) => {
    const clarification = clarificationById.get(question.id);
    if (clarification?.answer !== "yes") return [];
    return [{
      id: `user-attestation-${question.id}`,
      caseId: prepared.caseId,
      questionId: question.id,
      jobRefs: [...question.jobRefs],
      sourceType: "USER_ATTESTATION" as const,
      context: clarification.context,
      recordedAt: reviewedAt,
      resumeMutation: false as const,
      profileMutation: false as const
    }];
  });
  const requirements = guide.requirements.map((entry) => {
    const question = guide.clarifications.find((candidate) => candidate.jobRefs.includes(entry.jobRef));
    const answer = question ? clarificationById.get(question.id)?.answer : undefined;
    const userAttestationIds = answer === "yes" && question
      ? [`user-attestation-${question.id}`]
      : [];
    const disposition = entry.disposition === "confirmed_gap"
      ? "gap" as const
      : entry.disposition === "unknown" && answer === "yes"
        ? "supported" as const
        : entry.disposition;
    return {
      jobRef: entry.jobRef,
      disposition,
      applicantRefs: [...entry.applicantRefs],
      userAttestationIds
    };
  });
  const reviewGuideHash = hashAiInput("jobMatchQualificationReviewGuide", guide.version, guide);
  const artifact: QualificationReviewArtifact = deepFreeze({
    version: QUALIFICATION_REVIEW_ARTIFACT_VERSION,
    caseId: prepared.caseId,
    inputHash: prepared.inputHash,
    jobProjectionHash: prepared.jobProjectionHash,
    openGapsHash: prepared.openGapsHash,
    reviewGuideHash,
    factsCurrent: true,
    requirements,
    clarifications,
    userAttestations,
    preferences: { ...decision.preferences },
    recommendation: decision.recommendation,
    rationale: decision.rationale.trim(),
    documentApproval: "not_available"
  });
  const attestation: QualificationHumanReviewAttestation = deepFreeze({
    caseId: prepared.caseId,
    inputHash: prepared.inputHash,
    openGapsHash: prepared.openGapsHash,
    expectedRecommendation: prepared.expectedRecommendation,
    reviewedRecommendation: artifact.recommendation,
    status: "complete",
    reviewedAt,
    reviewArtifactHash: hashAiInput(
      "jobMatchQualificationHumanReviewArtifact",
      QUALIFICATION_REVIEW_ARTIFACT_VERSION,
      artifact
    ),
    reviewArtifact: artifact
  });
  return deepFreeze({ artifact, attestation });
}

type CloseReason = "navigation_or_owner_cancel" | "session_timeout" | "test_cleanup" | "closed";

export async function startJobMatchQualificationOwnerReview({
  expectedCheckpoint,
  cases,
  reviewGuides,
  allowedOrigin,
  syntheticSnapshot,
  execution,
  now = new Date(),
  captureTimeoutMs = DEFAULT_CAPTURE_TIMEOUT_MS,
  sessionTimeoutMs = DEFAULT_SESSION_TIMEOUT_MS
}: {
  expectedCheckpoint: QualificationExpectedCheckpoint;
  cases: readonly QualificationCase[];
  reviewGuides?: readonly QualificationReviewGuide[];
  allowedOrigin?: string;
  syntheticSnapshot?: ApplicantQualificationSnapshot;
  execution?: QualificationExecutionActivation;
  now?: Date;
  captureTimeoutMs?: number;
  sessionTimeoutMs?: number;
}) {
  if (!Number.isSafeInteger(captureTimeoutMs) || captureTimeoutMs < 1 || captureTimeoutMs > DEFAULT_CAPTURE_TIMEOUT_MS) {
    throw new Error("Qualification capture timeout must be between 1 ms and 5 minutes.");
  }
  if (!Number.isSafeInteger(sessionTimeoutMs) || sessionTimeoutMs < 1 || sessionTimeoutMs > MAX_SESSION_TIMEOUT_MS) {
    throw new Error("Qualification review timeout must be between 1 ms and 60 minutes.");
  }
  if ((allowedOrigin ? 1 : 0) + (syntheticSnapshot ? 1 : 0) !== 1) {
    throw new Error("Qualification owner review requires exactly one real-capture or synthetic-preview source.");
  }
  if (allowedOrigin && reviewGuides) {
    throw new Error("Pre-authored qualification review guides are allowed only for synthetic preview.");
  }
  if (syntheticSnapshot && execution) {
    throw new Error("Synthetic preview cannot activate qualification execution.");
  }
  const isSyntheticPreview = Boolean(syntheticSnapshot);

  const reviewToken = randomBytes(32).toString("base64url");
  const captureToken = randomBytes(32).toString("base64url");
  let origin = "";
  let preparation: QualificationPreparation | null = null;
  let snapshot: ApplicantQualificationSnapshot | null = null;
  let activeReviewGuides: readonly QualificationReviewGuide[] = [];
  let reviewArtifacts: QualificationReviewArtifact[] = [];
  let attestations: QualificationHumanReviewAttestation[] = [];
  let finalSafeManifest: QualificationPreparation["safeManifest"] | null = null;
  let finalReviewArtifactCount = 0;
  let executionSession: ReturnType<typeof createQualificationExecutionSession> | null = null;
  const repeatableSubmissionAdmission = createRepeatableSubmissionAdmission();
  let currentCaseIndex = 0;
  let phase: "awaiting_capture" | "capturing" | "authoring_evidence_guides" | "reviewing" | "awaiting_separate_google_consent" | "closed" = "awaiting_capture";
  let closed = false;
  const activePrivateBodyRequests = new Set<IncomingMessage>();
  let resolveReady!: (value: { safeManifest: QualificationPreparation["safeManifest"]; reviewArtifactCount: number }) => void;
  let rejectReady!: (error: Error) => void;
  let resolveExecutionFinished!: (report: unknown) => void;
  let rejectExecutionFinished!: (error: Error) => void;
  let resolveClosed!: (value: { reason: CloseReason }) => void;
  const readyForConsent = new Promise<{
    safeManifest: QualificationPreparation["safeManifest"];
    reviewArtifactCount: number;
  }>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  // A caller may legitimately wait only for closure after cancellation.
  void readyForConsent.catch(() => undefined);
  const executionFinished = new Promise<unknown>((resolve, reject) => {
    resolveExecutionFinished = resolve;
    rejectExecutionFinished = reject;
  });
  void executionFinished.catch(() => undefined);
  const closedPromise = new Promise<{ reason: CloseReason }>((resolve) => { resolveClosed = resolve; });
  let captureTimer: NodeJS.Timeout | undefined;
  let sessionTimer: NodeJS.Timeout | undefined;

  const close = (reason: CloseReason = "closed") => {
    if (closed) return;
    closed = true;
    phase = "closed";
    if (captureTimer) clearTimeout(captureTimer);
    if (sessionTimer) clearTimeout(sessionTimer);
    executionSession?.close();
    executionSession = null;
    preparation = null;
    snapshot = null;
    activeReviewGuides = [];
    reviewArtifacts = [];
    attestations = [];
    for (const request of activePrivateBodyRequests) request.destroy();
    activePrivateBodyRequests.clear();
    rejectReady(new Error(`Qualification owner review closed: ${reason}.`));
    rejectExecutionFinished(new Error(`Qualification execution closed: ${reason}.`));
    server.close();
    resolveClosed({ reason });
  };

  const effectivePhase = () => executionSession?.phase() ?? phase;

  const admitSnapshot = (candidate: ApplicantQualificationSnapshot) => {
    const draft = buildQualificationPreparation(candidate, cases, now);
    assertCheckpoint(expectedCheckpoint, draft);
    if (reviewGuides) {
      if (reviewGuides.length !== draft.privateInputs.length) {
        throw new Error("Qualification review guides must cover every frozen case.");
      }
      reviewGuides.forEach((guide) => validatedQualificationReviewGuide(draft, guide));
      activeReviewGuides = deepFreeze([...reviewGuides]);
      phase = "reviewing";
    } else {
      activeReviewGuides = buildConservativeQualificationReviewGuides(draft);
      phase = "reviewing";
    }
    snapshot = candidate;
    preparation = draft;
    currentCaseIndex = 0;
    if (captureTimer) clearTimeout(captureTimer);
    sessionTimer = setTimeout(() => close("session_timeout"), sessionTimeoutMs);
    sessionTimer.unref();
  };

  const server = createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
      if (origin && request.headers.host !== new URL(origin).host) {
        sendJson(response, 400, { error: "Invalid loopback host" });
        return;
      }

      if (requestUrl.pathname === `/capture/${captureToken}`) {
        if (!allowedOrigin || request.headers.origin !== new URL(allowedOrigin).origin) {
          sendJson(response, 403, { error: "Origin rejected" });
          return;
        }
        const cors = {
          "access-control-allow-origin": new URL(allowedOrigin).origin,
          "access-control-allow-methods": "POST, OPTIONS",
          "access-control-allow-headers": "content-type",
          "access-control-allow-private-network": "true",
          vary: "Origin"
        };
        if (request.method === "OPTIONS") {
          response.writeHead(204, { ...securityHeaders("text/plain; charset=utf-8"), ...cors });
          response.end();
          return;
        }
        if (request.method !== "POST" || phase !== "awaiting_capture") {
          sendJson(response, 409, { error: "Capture unavailable" }, cors);
          return;
        }
        phase = "capturing";
        activePrivateBodyRequests.add(request);
        try {
          const raw = await readBoundedBody(request);
          if (closed || phase !== "capturing") {
            if (!response.destroyed) sendJson(response, 409, { error: "Capture unavailable" }, cors);
            return;
          }
          const payload = JSON.parse(raw) as { master?: unknown; profile?: unknown };
          admitSnapshot(buildApplicantQualificationSnapshot(payload.master, payload.profile));
          sendJson(response, 200, {
            status: "checkpoint_matched_review_ready",
            reviewUrl: `${origin}/review/${reviewToken}`,
            manifestHash: preparation?.safeManifest.manifestHash
          }, cors);
        } catch (error) {
          if (!closed && phase === "capturing") phase = "awaiting_capture";
          throw error;
        } finally {
          activePrivateBodyRequests.delete(request);
        }
        return;
      }

      const reviewPath = `/review/${reviewToken}`;
      const statePath = `/api/state/${reviewToken}`;
      const guideSubmissionPath = `/api/guides/${reviewToken}`;
      const submissionPath = `/api/reviews/${reviewToken}`;
      const consentPath = `/api/execution-consent/${reviewToken}`;
      const executionReviewPath = `/api/execution-reviews/${reviewToken}`;
      const cancelPath = `/api/cancel/${reviewToken}`;
      if (serveOwnerReviewAsset(requestUrl.pathname, request.method, response, {
        reviewPath,
        statePath,
        guideSubmissionPath,
        submissionPath,
        consentPath,
        executionReviewPath,
        cancelPath
      })) {
        return;
      }
      if (requestUrl.pathname === statePath && request.method === "GET") {
        const currentPhase = effectivePhase();
        if (finalSafeManifest && (
          currentPhase === "awaiting_separate_google_consent"
          || currentPhase === "execution_starting"
          || currentPhase === "executing"
          || currentPhase === "reviewing_provider_result"
          || currentPhase === "execution_complete"
          || currentPhase === "execution_stopped"
        )) {
          const executionView = executionSession?.view();
          sendJson(response, 200, {
            phase: currentPhase,
            memoryNotice: executionSession?.hasPrivateInput()
              ? "The exact reviewed preparation remains only in this loopback process for the separately consented run. The current provider result is rendered only while its review is pending."
              : "Private execution input has been released from the local workflow; only the safe manifest and safe report remain.",
            reviewedCaseCount: finalSafeManifest.caseCount,
            caseCount: finalSafeManifest.caseCount,
            syntheticPreview: isSyntheticPreview,
            finalManifest: finalSafeManifest,
            cases: [],
            executionAvailable: Boolean(executionSession),
            providerCallCount: executionSession?.providerCallCount() ?? 0,
            currentCaseIndex: executionView?.providerResultReview
              ? executionView.providerResultReview.index - 1
              : finalSafeManifest.caseCount,
            providerResultReview: executionView?.providerResultReview ?? null,
            safeReport: executionView?.safeReport ?? null
          });
          return;
        }
        if (!preparation || phase === "awaiting_capture") {
          sendJson(response, 200, { phase: "awaiting_capture" });
          return;
        }
        const viewGuides = phase === "authoring_evidence_guides"
          ? buildConservativeQualificationReviewGuides(preparation)
          : activeReviewGuides;
        const view = buildQualificationOwnerReviewView(preparation, cases, {
          syntheticPreview: isSyntheticPreview,
          reviewGuides: viewGuides
        });
        sendJson(response, 200, {
          ...view,
          phase,
          currentCaseIndex,
          cases: phase === "reviewing" || phase === "authoring_evidence_guides"
            ? [view.cases[currentCaseIndex]]
            : []
        });
        return;
      }
      if (requestUrl.pathname === consentPath && request.method === "POST") {
        if (request.headers.origin !== origin) {
          sendJson(response, 403, { error: "Origin rejected" });
          return;
        }
        if (!executionSession || effectivePhase() !== "awaiting_separate_google_consent") {
          sendJson(response, 409, { error: "Qualification execution consent unavailable" });
          return;
        }
        activePrivateBodyRequests.add(request);
        try {
          const raw = await readBoundedBody(request);
          if (closed || !executionSession || effectivePhase() !== "awaiting_separate_google_consent") {
            if (!response.destroyed) sendJson(response, 409, { error: "Qualification execution consent unavailable" });
            return;
          }
          executionSession.authorize(JSON.parse(raw));
          sendJson(response, 202, { phase: effectivePhase() });
        } finally {
          activePrivateBodyRequests.delete(request);
        }
        return;
      }
      if (requestUrl.pathname === executionReviewPath && request.method === "POST") {
        if (request.headers.origin !== origin) {
          sendJson(response, 403, { error: "Origin rejected" });
          return;
        }
        if (!executionSession || effectivePhase() !== "reviewing_provider_result") {
          sendJson(response, 409, { error: "Qualification provider-result review unavailable" });
          return;
        }
        const releaseAdmission = repeatableSubmissionAdmission.acquire("provider_review");
        if (!releaseAdmission) {
          sendJson(response, 409, { error: "Qualification provider-result review unavailable" });
          return;
        }
        activePrivateBodyRequests.add(request);
        try {
          const raw = await readBoundedBody(request);
          if (closed || !executionSession || effectivePhase() !== "reviewing_provider_result") {
            if (!response.destroyed) sendJson(response, 409, { error: "Qualification provider-result review unavailable" });
            return;
          }
          executionSession.submitProviderReview(JSON.parse(raw));
          sendJson(response, 200, { phase: effectivePhase() });
        } finally {
          activePrivateBodyRequests.delete(request);
          releaseAdmission();
        }
        return;
      }
      if (requestUrl.pathname === guideSubmissionPath && request.method === "POST") {
        if (request.headers.origin !== origin) {
          sendJson(response, 403, { error: "Origin rejected" });
          return;
        }
        if (phase !== "authoring_evidence_guides" || !preparation) {
          sendJson(response, 409, { error: "Evidence-guide authoring unavailable" });
          return;
        }
        const releaseAdmission = repeatableSubmissionAdmission.acquire("guide");
        if (!releaseAdmission) {
          sendJson(response, 409, { error: "Evidence-guide authoring unavailable" });
          return;
        }
        activePrivateBodyRequests.add(request);
        try {
          const raw = await readBoundedBody(request);
          const activePreparation = preparation;
          if (closed || phase !== "authoring_evidence_guides" || !activePreparation) {
            if (!response.destroyed) sendJson(response, 409, { error: "Evidence-guide authoring unavailable" });
            return;
          }
          const guide = createQualificationReviewGuide({
            preparation: activePreparation,
            draft: JSON.parse(raw)
          });
          const expectedCase = activePreparation.privateInputs[currentCaseIndex];
          if (guide.caseId !== expectedCase.caseId) {
            throw new Error("Qualification evidence guides must follow the frozen case order.");
          }
          activeReviewGuides = deepFreeze([...activeReviewGuides, guide]);
          currentCaseIndex += 1;
          if (currentCaseIndex === activePreparation.privateInputs.length) {
            phase = "reviewing";
            currentCaseIndex = 0;
          }
          sendJson(response, 200, { phase, currentCaseIndex });
        } finally {
          activePrivateBodyRequests.delete(request);
          releaseAdmission();
        }
        return;
      }
      if (requestUrl.pathname === submissionPath && request.method === "POST") {
        if (
          request.headers.origin !== origin
          || phase !== "reviewing"
          || !preparation
          || !snapshot
        ) {
          sendJson(response, 409, { error: "Review unavailable" });
          return;
        }
        const releaseAdmission = repeatableSubmissionAdmission.acquire("owner_review");
        if (!releaseAdmission) {
          sendJson(response, 409, { error: "Review unavailable" });
          return;
        }
        activePrivateBodyRequests.add(request);
        try {
          const raw = await readBoundedBody(request);
          const activePreparation = preparation;
          const activeSnapshot = snapshot;
          if (closed || phase !== "reviewing" || !activePreparation || !activeSnapshot) {
            if (!response.destroyed) sendJson(response, 409, { error: "Review unavailable" });
            return;
          }
          const expectedCase = activePreparation.privateInputs[currentCaseIndex];
          const result = createQualificationReviewArtifact({
            preparation: activePreparation,
            reviewGuides: activeReviewGuides,
            decision: JSON.parse(raw),
            reviewedAt: new Date().toISOString()
          });
          if (result.attestation.caseId !== expectedCase.caseId) {
            throw new Error("Qualification reviews must follow the frozen case order.");
          }
          reviewArtifacts.push(result.artifact);
          attestations.push(result.attestation);
          currentCaseIndex += 1;
          if (currentCaseIndex === activePreparation.privateInputs.length) {
            const reviewedPreparation = buildQualificationPreparation(activeSnapshot, cases, now, attestations);
            finalSafeManifest = reviewedPreparation.safeManifest;
            finalReviewArtifactCount = reviewArtifacts.length;
            phase = "awaiting_separate_google_consent";
            if (execution) {
              executionSession = createQualificationExecutionSession({
                preparation: reviewedPreparation,
                activation: execution
              });
              void executionSession.finished.then(resolveExecutionFinished);
            }
            preparation = null;
            snapshot = null;
            activeReviewGuides = [];
            attestations = [];
            reviewArtifacts = [];
            resolveReady({ safeManifest: finalSafeManifest, reviewArtifactCount: finalReviewArtifactCount });
            sendJson(response, 200, {
              phase,
              finalManifestHash: finalSafeManifest.manifestHash
            });
            return;
          }
          sendJson(response, 200, { phase, currentCaseIndex });
        } finally {
          activePrivateBodyRequests.delete(request);
          releaseAdmission();
        }
        return;
      }
      if (requestUrl.pathname === cancelPath && request.method === "POST") {
        if (request.headers.origin !== origin) {
          sendJson(response, 403, { error: "Origin rejected" });
          return;
        }
        response.writeHead(204, securityHeaders("text/plain; charset=utf-8"));
        response.end();
        close("navigation_or_owner_cancel");
        return;
      }
      sendJson(response, 404, { error: "Not found" });
    } catch (error) {
      if (!response.destroyed && !response.writableEnded) {
        sendJson(response, error instanceof RangeError ? 413 : 400, { error: "Qualification review request rejected" });
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Qualification owner review did not obtain a loopback address.");
  }
  origin = `http://127.0.0.1:${address.port}`;

  if (syntheticSnapshot) {
    try {
      admitSnapshot(syntheticSnapshot);
    } catch (error) {
      server.close();
      throw error;
    }
  } else {
    captureTimer = setTimeout(() => close("session_timeout"), captureTimeoutMs);
    captureTimer.unref();
  }

  return Object.freeze({
    origin,
    reviewUrl: `${origin}/review/${reviewToken}`,
    stateUrl: `${origin}/api/state/${reviewToken}`,
    reviewSubmissionUrl: `${origin}/api/reviews/${reviewToken}`,
    guideSubmissionUrl: `${origin}/api/guides/${reviewToken}`,
    consentSubmissionUrl: `${origin}/api/execution-consent/${reviewToken}`,
    executionReviewSubmissionUrl: `${origin}/api/execution-reviews/${reviewToken}`,
    cancelUrl: `${origin}/api/cancel/${reviewToken}`,
    captureUrl: allowedOrigin ? `${origin}/capture/${captureToken}` : null,
    readyForConsent,
    executionFinished,
    closed: closedPromise,
    close,
    phase: effectivePhase,
    hasPrivateInput: () => preparation !== null || snapshot !== null || executionSession?.hasPrivateInput() === true,
    providerCallCount: () => executionSession?.providerCallCount() ?? 0
  });
}
