import type { ApplicationDocumentClaimEvidence, ApplicationDocumentPayload } from "@/lib/ai/application-document-claims";

// Owner decision 2026-11-06 (D033): an employer paragraph names its employer through one published
// line per work record, built only from that record's own fields:
//   "From <start> to <end>, I was <title> at <employer>."   (a past role)
//   "Since <start>, I have been <title> at <employer>."     (the current role)
// The line may stand only as the first sentence of a paragraph whose every evidence sentence cites
// that record (other published lines stay allowed anywhere). The finalizer places it; the claim
// check rejects it anywhere else.

export type CoverLetterLeadLine = Readonly<{ ref: string; line: string }>;

type Evidence = Pick<ApplicationDocumentClaimEvidence, "claim" | "citations">;

const sentenceSegmenter = new Intl.Segmenter("en", { granularity: "sentence" });
const field = (value: unknown) => typeof value === "string" ? value.trim().replace(/\s+/gu, " ") : "";
const comparable = (value: string) => value.trim().replace(/\s+/gu, " ").toLocaleLowerCase();
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

// A work record the résumé marks as the applicant's current role: its end date says Present,
// Current or Now (or the record carries current: true). A record with no end date at all is not
// treated as current, since a missing date proves nothing.
export function isCurrentWorkRecord(record: unknown) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return false;
  const value = record as Record<string, unknown>;
  if (value.current === true || value.isCurrent === true) return true;
  return typeof value.endDate === "string" && /^\s*(?:present|current|now)\s*$/iu.test(value.endDate);
}

export function getCoverLetterLeadLines(payload: ApplicationDocumentPayload): readonly CoverLetterLeadLine[] {
  const records: unknown = payload.resume?.workHistory;
  if (!Array.isArray(records)) return [];
  return Object.freeze(records.flatMap((record, index): CoverLetterLeadLine[] => {
    if (!record || typeof record !== "object" || Array.isArray(record)) return [];
    const value = record as Record<string, unknown>;
    const [title, company, start, end] = [value.title, value.company, value.startDate, value.endDate].map(field);
    if (!title || !company || !start) return [];
    const employer = /[.!?]$/u.test(company) ? company : `${company}.`;
    const ref = `resume.workHistory[${index}]`;
    if (isCurrentWorkRecord(value)) return [Object.freeze({ ref, line: `Since ${start}, I have been ${title} at ${employer}` })];
    return end ? [Object.freeze({ ref, line: `From ${start} to ${end}, I was ${title} at ${employer}` })] : [];
  }));
}

const linePattern = (line: string, flags: string) =>
  new RegExp(`${flags.includes("g") ? "" : "^\\s*"}${line.trim().split(/\s+/u).map(escapeRegExp).join("\\s+")}(?=\\s|$)`, flags);

// The work record whose lead line may open a paragraph with this text: every claim the text holds
// cites only that one record (job references aside), and there is at least one. Null otherwise.
function leadRecordOf(text: string, claims: readonly Evidence[]) {
  const body = comparable(text);
  const refs = new Set(claims.filter((entry) => entry.claim.trim() && body.includes(comparable(entry.claim)))
    .flatMap((entry) => entry.citations.filter((citation) => !citation.ref.startsWith("job.")).map((citation) => citation.ref)));
  const [ref] = refs;
  return refs.size === 1 && /^resume\.workHistory\[\d+\]$/u.test(ref!) ? ref! : null;
}

// A line that would segment into several sentences (an abbreviation such as "Sr." in the title)
// stands on its own line, which the letter checks read as one sentence.
const separatorAfter = (line: string) => [...sentenceSegmenter.segment(line)].length > 1 ? "\n" : " ";

function tidy(paragraph: string) {
  return paragraph.split(/\r?\n/u).map((line) => line.replace(/\s{2,}/gu, " ").trim()).filter(Boolean).join("\n");
}

// The letter without the lead lines that stand where they are allowed, for the check that every
// other sentence is a published line or cited evidence.
export function withoutPlacedLeadLines(payload: ApplicationDocumentPayload, coverLetter: string, claims: readonly Evidence[]) {
  const leads = getCoverLetterLeadLines(payload);
  if (!leads.length) return coverLetter;
  return coverLetter.split(/\n\s*\n/u).map((paragraph) => {
    for (const lead of leads) {
      const match = linePattern(lead.line, "iu").exec(paragraph);
      if (match && leadRecordOf(paragraph.slice(match[0].length), claims) === lead.ref) return paragraph.slice(match[0].length).trim();
    }
    return paragraph;
  }).join("\n\n");
}

// Every lead line taken out of the letter, for a step that reorders sentences; placeLeadLines puts
// them back where they are allowed.
export function withoutLeadLines(payload: ApplicationDocumentPayload, coverLetter: string) {
  let text = coverLetter;
  for (const lead of getCoverLetterLeadLines(payload)) text = text.replace(linePattern(lead.line, "giu"), "");
  return text === coverLetter ? coverLetter : text.split(/\n\s*\n/u).map(tidy).filter(Boolean).join("\n\n");
}

// Each lead line the letter holds, once per occurrence.
export function leadLineOccurrences(payload: ApplicationDocumentPayload, coverLetter: string) {
  return getCoverLetterLeadLines(payload).flatMap((lead) => [...coverLetter.matchAll(linePattern(lead.line, "giu"))].map(() => lead.line));
}

// The letter with each paragraph whose evidence all cites one work record opened by that record's
// lead line, and every lead line anywhere else taken out. Returns the same text when nothing
// changes; a paragraph whose line is already in place keeps its exact wording.
export function placeLeadLines(payload: ApplicationDocumentPayload, coverLetter: string, claims: readonly Evidence[]) {
  const leads = getCoverLetterLeadLines(payload);
  if (!leads.length) return coverLetter;
  const paragraphs = coverLetter.split(/\n\s*\n/u).map((paragraph) => {
    const here: string[] = [];
    let body = paragraph;
    for (const lead of leads) {
      body = body.replace(linePattern(lead.line, "giu"), () => {
        here.push(lead.line);
        return "";
      });
    }
    if (here.length) body = tidy(body);
    const ref = body ? leadRecordOf(body, claims) : null;
    const lead = ref ? leads.find((value) => value.ref === ref) : undefined;
    if (!lead) return body;
    if (here.length === 1 && here[0] === lead.line && linePattern(lead.line, "iu").test(paragraph)) return paragraph;
    return `${lead.line}${separatorAfter(lead.line)}${body}`;
  });
  const next = paragraphs.filter(Boolean).join("\n\n");
  return next === coverLetter.split(/\n\s*\n/u).join("\n\n") ? coverLetter : next;
}
