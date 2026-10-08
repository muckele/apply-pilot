export function summarizeBoundedJobResults({
  evaluatedCandidateCount,
  evaluatedMatchingCount,
  totalCandidateCount,
  visibleCount
}: {
  evaluatedCandidateCount: number;
  evaluatedMatchingCount: number;
  totalCandidateCount: number;
  visibleCount: number;
}) {
  return {
    omittedCandidateCount: Math.max(0, evaluatedMatchingCount - visibleCount),
    unevaluatedCandidateCount: Math.max(0, totalCandidateCount - evaluatedCandidateCount)
  };
}

export function JobMatchOmissionNotice({
  evaluatedCandidateCount,
  omittedCandidateCount,
  unevaluatedCandidateCount = 0,
  omittedCountIsLowerBound = false,
  viewLabel
}: {
  evaluatedCandidateCount: number;
  omittedCandidateCount: number;
  unevaluatedCandidateCount?: number;
  omittedCountIsLowerBound?: boolean;
  viewLabel: string;
}) {
  if (omittedCandidateCount < 1 && unevaluatedCandidateCount < 1) return null;
  const noun = omittedCandidateCount === 1 ? "candidate" : "candidates";
  if (unevaluatedCandidateCount > 0) {
    const unevaluatedNoun = unevaluatedCandidateCount === 1 ? "candidate was" : "candidates were";
    return (
      <p role="status" className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
        {evaluatedCandidateCount} candidates checked; {omittedCandidateCount > 0
          ? <>{omittedCandidateCount} additional evaluated {omittedCandidateCount === 1 ? "match" : "matches"} omitted from this bounded {viewLabel}. </>
          : null}
        {unevaluatedCandidateCount} {unevaluatedNoun} not evaluated and may contain more matches.
      </p>
    );
  }
  return (
    <p role="status" className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
      {evaluatedCandidateCount} candidates checked; {omittedCountIsLowerBound ? "at least " : ""}{omittedCandidateCount} additional {noun} omitted from this bounded {viewLabel}.
    </p>
  );
}
