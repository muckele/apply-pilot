export function validFitScore(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100
    ? value
    : null;
}

export function formatAverageFit(value: unknown) {
  if (value === null || value === undefined) return "No scored jobs";
  const score = validFitScore(value);
  return score === null ? "Score unavailable" : `${Math.round(score)}%`;
}

export function getJobFitPresentation(job: {
  overallFitScore: number | null | undefined;
  suggestedResumeAngle: string | null | undefined;
  suggestedCoverLetterAngle: string | null | undefined;
}) {
  const fitScore = validFitScore(job.overallFitScore);

  return {
    fitScore,
    hasFitAnalysis: fitScore !== null,
    suggestedResumeAngle: job.suggestedResumeAngle?.trim() ||
      "Review your actual experience for evidence relevant to this posting. Avoid unsupported claims.",
    suggestedCoverLetterAngle: job.suggestedCoverLetterAngle?.trim() ||
      "Use verified experience relevant to this role, and address any gaps honestly."
  };
}

type AnalysisJob = {
  overallFitScore: number | null | undefined;
  compensationScore: number | null | undefined;
  confidenceScore: number | null | undefined;
  keyMatchReason: string | null | undefined;
  concerns: string[];
  suggestedResumeAngle: string | null | undefined;
  suggestedCoverLetterAngle: string | null | undefined;
};

type EvidenceCitation = { ref: string; excerpt: string };
type FactualMatchPresentation = {
  claim: string;
  applicantEvidence: EvidenceCitation[];
  jobEvidence: EvidenceCitation[];
};
type RequirementGapPresentation = {
  requirement: string;
  jobRequirement: EvidenceCitation | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readCitation(value: unknown): EvidenceCitation | null {
  if (!isRecord(value) || typeof value.ref !== "string" || typeof value.excerpt !== "string") return null;
  return { ref: value.ref, excerpt: value.excerpt };
}

function readCitations(value: unknown) {
  return Array.isArray(value)
    ? value.map(readCitation).filter((citation): citation is EvidenceCitation => citation !== null)
    : [];
}

function readV3FactualMatches(output: Record<string, unknown>): FactualMatchPresentation[] {
  if (!Array.isArray(output.factualMatches)) return [];
  return output.factualMatches.flatMap((value) => {
    if (!isRecord(value) || typeof value.claim !== "string") return [];
    return [{
      claim: value.claim,
      applicantEvidence: readCitations(value.applicantEvidence),
      jobEvidence: readCitations(value.jobEvidence)
    }];
  });
}

function readV3RequirementGaps(output: Record<string, unknown>): RequirementGapPresentation[] {
  if (!Array.isArray(output.requirementGaps)) return [];
  return output.requirementGaps.flatMap((value) => {
    if (!isRecord(value) || typeof value.requirement !== "string") return [];
    return [{ requirement: value.requirement, jobRequirement: readCitation(value.jobRequirement) }];
  });
}

function compensationExplanation(reason: unknown) {
  switch (reason) {
    case "missing_applicant_salary_target":
      return "Unknown because the applicant salary target is missing.";
    case "missing_job_salary":
      return "Unknown because both job salary bounds are missing.";
    case "missing_both":
      return "Unknown because the applicant salary target and both job salary bounds are missing.";
    case "model_did_not_assess":
      return "Unknown because the model did not assess compensation from the available inputs.";
    case "assessed":
      return "Assessed from the submitted applicant target and job salary information.";
    default:
      return "Legacy analysis did not record compensation input availability or a reason.";
  }
}

export function getJobMatchAnalysisPresentation(job: AnalysisJob, analysisOutput: unknown) {
  const base = getJobFitPresentation(job);
  const output = isRecord(analysisOutput) ? analysisOutput : null;
  const isV3 = output?.contractVersion === "3";
  const confidenceAssessment = isV3 && isRecord(output.confidenceAssessment)
    ? output.confidenceAssessment
    : null;
  const compensation = isV3 && isRecord(output.compensationAssessment)
    ? output.compensationAssessment
    : null;
  const v3ConfidenceScore = validFitScore(confidenceAssessment?.score);
  const legacyConfidenceScore = validFitScore(job.confidenceScore);
  const compensationScore = validFitScore(isV3 ? compensation?.score : job.compensationScore);
  const legacyReason = job.keyMatchReason?.trim();

  return {
    ...base,
    compensation: {
      score: compensationScore,
      explanation: compensationExplanation(isV3 ? compensation?.reason : undefined)
    },
    confidence: (isV3 ? v3ConfidenceScore : legacyConfidenceScore) === null
      ? null
      : {
          score: (isV3 ? v3ConfidenceScore : legacyConfidenceScore) as number,
          label: "Uncalibrated model self-assessment" as const,
          basis: isV3 && typeof confidenceAssessment?.basis === "string" && confidenceAssessment.basis.trim()
            ? confidenceAssessment.basis
            : "Legacy analysis did not record a confidence basis."
        },
    factualMatches: isV3
      ? readV3FactualMatches(output)
      : legacyReason
        ? [{ claim: legacyReason, applicantEvidence: [], jobEvidence: [] }]
        : [],
    requirementGaps: isV3
      ? readV3RequirementGaps(output)
      : job.concerns.map((requirement) => ({ requirement, jobRequirement: null })),
    isLegacyAnalysis: !isV3
  };
}
