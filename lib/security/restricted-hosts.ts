export const prohibitedJobBoardHosts = [
  "linkedin.com",
  "www.linkedin.com",
  "indeed.com",
  "www.indeed.com",
  "ziprecruiter.com",
  "www.ziprecruiter.com",
  "careerbuilder.com",
  "www.careerbuilder.com",
  "glassdoor.com",
  "www.glassdoor.com"
] as const;

function normalizeHost(host: string) {
  return host.trim().toLowerCase().replace(/\.$/, "");
}

export function isProhibitedJobBoardHost(host: string): boolean {
  const normalized = normalizeHost(host);
  if (!normalized) return false;

  return prohibitedJobBoardHosts.some(
    (prohibited) => normalized === prohibited || normalized.endsWith(`.${prohibited}`)
  );
}
