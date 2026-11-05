const month = "(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\\.?";
const year = "(?:19|20)\\d{2}";
const rangeEnd = `(?:(?:${month}\\s+)?${year}|Present|Current|Now)`;

// PDF text extraction drops the gap before right-aligned dates, so "Acme & Co" and
// "Jan 2024 – Present" come out as "Acme & CoJan 2024 – Present". Restore one space,
// only where a full date range follows directly after a lowercase letter or closing
// bracket. Everything else is returned exactly as extracted.
const gluedDateRange = new RegExp(
  `(?<=[\\p{Ll})\\]])(?=${month}\\s+${year}\\s*[–—-]\\s*${rangeEnd}\\b)`,
  "gu"
);

export function repairPdfGluedDateRanges(text: string) {
  return text.replace(gluedDateRange, " ");
}
