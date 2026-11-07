// A work record the résumé marks as the applicant's current role: its end date says Present,
// Current or Now (or the record carries current: true). A record with no end date at all is not
// treated as current, since a missing date proves nothing.
export function isCurrentWorkRecord(record: unknown) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return false;
  const value = record as Record<string, unknown>;
  if (value.current === true || value.isCurrent === true) return true;
  return typeof value.endDate === "string" && /^\s*(?:present|current|now)\s*$/iu.test(value.endDate);
}
