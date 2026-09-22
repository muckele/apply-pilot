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
