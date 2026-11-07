// Plain-language labels for job listings. Nothing here estimates or invents data: salary and
// work style come only from what the posting listed.

const DAY_MS = 86_400_000;

export function postedAgeLabel(posted: Date, now: Date = new Date()): string {
  const days = Math.floor((now.getTime() - posted.getTime()) / DAY_MS);
  if (days < 1) return "Today";
  if (days === 1) return "1 day ago";
  if (days < 14) return `${days} days ago`;
  if (days < 60) return `${Math.floor(days / 7)} weeks ago`;
  if (days < 730) return `${Math.floor(days / 30)} months ago`;
  return `${Math.floor(days / 365)} years ago`;
}

function money(value: number) {
  return value >= 1_000 ? `$${Math.round(value / 1_000)}k` : `$${value}`;
}

export function salaryLabel(min: number | null | undefined, max: number | null | undefined): string | null {
  const low = typeof min === "number" && min > 0 ? min : null;
  const high = typeof max === "number" && max > 0 ? max : null;
  if (low === null && high === null) return null;
  const hourly = (high ?? low ?? 0) < 1_000;
  const suffix = hourly ? " an hour" : "";
  if (low !== null && high !== null) return `${money(low)}–${money(high)}${suffix}`;
  if (low !== null) return `From ${money(low)}${suffix}`;
  return `Up to ${money(high!)}${suffix}`;
}

export type WorkStyle = "Remote" | "Hybrid" | "On-site";

export function normalizeWorkStyle(remoteStatus: string | null | undefined, location: string | null | undefined): WorkStyle | null {
  const read = (value: string | null | undefined): WorkStyle | null => {
    const text = (value ?? "").toLowerCase();
    if (/\bhybrid\b/u.test(text)) return "Hybrid";
    if (/\bon[\s-]?site\b|\bin[\s-]office\b/u.test(text)) return "On-site";
    if (/\bremote\b/u.test(text)) return "Remote";
    return null;
  };
  return read(remoteStatus) ?? read(location);
}

const WORK_STYLE_PATTERN =
  /\b(remote|hybrid|on[\s-]?site|in[\s-]office|in[\s-]person|office|relocat(e|ion)|travel|time\s?zones?|days a week|work from home|wfh|commut\w*)\b/iu;

// Verbatim sentences from the posting that talk about where or how the work happens.
export function extractWorkStyleQuotes(description: string, limit = 3): string[] {
  const sentences = description
    .split(/\n+/u)
    .flatMap((paragraph) => paragraph.match(/[^.!?]+[.!?]+["')\]]?|[^.!?]+$/gu) ?? [])
    .map((sentence) => sentence.trim())
    .filter(Boolean);
  const quotes: string[] = [];
  for (const sentence of sentences) {
    if (WORK_STYLE_PATTERN.test(sentence) && !quotes.includes(sentence)) quotes.push(sentence);
    if (quotes.length >= limit) break;
  }
  return quotes;
}
