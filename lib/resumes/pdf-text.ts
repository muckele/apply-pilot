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

// pdf-parse ends a line it soft-wrapped with a space ("budgets, P&L \nmanagement").
// Rejoin those so a skill or bullet is one exact run of source text, except before a
// bullet, a blank line or the end of the text.
const softWrap = /(?<=\S) \n(?=[^\s•▪◦])/gu;
// A compound word broken after its hyphen ("re-\nentry") is rejoined as "re-entry".
const hyphenWrap = /(?<=\p{Ll}-)\n(?=\p{Ll})/gu;

export function normalizePdfResumeText(text: string) {
  return repairPdfGluedDateRanges(text).replace(softWrap, " ").replace(hyphenWrap, "");
}

type PdfTextItem = { str: string; transform: number[]; width: number };

// pdf-parse's default page renderer, except that two pieces of text on the same
// line separated by at least one font size (right-aligned dates, a status note
// beside a project name) are joined with one space instead of running together.
// Ordinary joins, such as a bullet touching its text, are unchanged.
export function joinPdfPageItems(items: PdfTextItem[]) {
  let text = "";
  let last: PdfTextItem | null = null;
  for (const item of items) {
    const y = item.transform[5];
    if (!last || !last.transform[5] || last.transform[5] === y) {
      const fontSize = Math.abs(item.transform[3] ?? 0) || 1;
      const gap = last ? item.transform[4]! - (last.transform[4]! + last.width) : 0;
      const separated = last !== null && gap >= fontSize && !/\s$/u.test(text) && !/^\s/u.test(item.str);
      text += (separated ? " " : "") + item.str;
    } else {
      text += `\n${item.str}`;
    }
    last = item;
  }
  return text;
}

export async function renderPdfPageText(pageData: {
  getTextContent: (options: { normalizeWhitespace: boolean; disableCombineTextItems: boolean }) => Promise<{ items: PdfTextItem[] }>;
}) {
  const content = await pageData.getTextContent({ normalizeWhitespace: false, disableCombineTextItems: false });
  return joinPdfPageItems(content.items);
}
