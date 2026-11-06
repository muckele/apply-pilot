import {
  getCoverLetterUncitedLines,
  type ApplicationDocumentClaimEvidence,
  type ApplicationDocumentPayload
} from "@/lib/ai/application-document-claims";

// Owner's live test 2026-11-06: a repaired cover letter was truthful but its paragraphs mixed
// employers, so a résumé bullet read as if it belonged to whichever employer the sentence before it
// named. This step only reorders: every sentence keeps its exact words and its citation, no
// sentence is added or removed, and the caller keeps Gemini's order whenever the grouped letter
// would fail any check (finalizeCoverLetter).
//
// The evidence between the letter's opening and closing lines is regrouped by the source record
// each sentence cites:
//   - the opening paragraph keeps its introduction lines and any evidence that names no employer;
//   - evidence that names no employer and comes before the first employer or project fact leads;
//   - each employer gets one paragraph, in résumé order (records that share a company name share
//     a paragraph), opened by that employer's sentence that names it ("At <Org>, I …") when the
//     letter has one;
//   - project facts and the remaining evidence that names no employer follow in one paragraph.
// A sentence counts toward an employer when it cites that work-history record or begins with the
// employer's name ("At <Org>, …", "<Org> playbooks …"). A job-requirement lead-in moves with the
// sentence after it; closing courtesy lines stay at the end.

type CoverLetterOutput = { coverLetter: string; claimsUsed: ApplicationDocumentClaimEvidence[] };

type Employer = Readonly<{ key: string; rank: number; company: string }>;

type Item = Readonly<{ text: string; paragraph: number; claim?: ApplicationDocumentClaimEvidence }>;

type Unit = {
  sentences: string[];
  position: number;
  paragraph: number;
  group: Readonly<{ kind: "employer" | "project" | "other"; key: string; rank: number }>;
  naming: 0 | 1 | 2;
};

const sentenceSegmenter = new Intl.Segmenter("en", { granularity: "sentence" });
const leadIn = /^(?:your posting highlights|the role calls for|my experience most relevant to this role includes the following)\b/iu;

function comparable(value: string) {
  return value.trim().replace(/\s+/gu, " ").toLocaleLowerCase();
}

function sentenceKey(value: string) {
  return comparable(value).replace(/[.!?]+$/u, "");
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function employersOf(payload: ApplicationDocumentPayload): Employer[] {
  const records: unknown = payload.resume?.workHistory;
  if (!Array.isArray(records)) return [];
  const rankByKey = new Map<string, number>();
  return records.map((record, index) => {
    const value = record && typeof record === "object" && !Array.isArray(record)
      ? (record as Record<string, unknown>).company : null;
    const company = typeof value === "string" ? value.trim().replace(/\s+/gu, " ") : "";
    const key = company ? `employer:${company.toLocaleLowerCase()}` : `employer:#${index}`;
    if (!rankByKey.has(key)) rankByKey.set(key, index);
    return { key, rank: rankByKey.get(key)!, company };
  });
}

// The employer a sentence names at its start: 0 for "At <Org>, …", 1 for "<Org> …". A bare
// one-word name counts only when a capitalized word continues it ("<Org> Sales playbooks …"), since
// the name could be an ordinary word ("Target accounts grew …") and placement would then imply
// where the fact happened.
function namedEmployer(sentence: string, employers: readonly Employer[]) {
  const named = employers.filter((employer) => employer.company.length >= 2)
    .sort((left, right) => right.company.length - left.company.length);
  for (const employer of named) {
    const match = new RegExp(`^(at\\s+)?${escapeRegExp(employer.company)}(?![\\p{L}\\p{N}])`, "iu").exec(sentence.trim());
    if (!match) continue;
    if (match[1]) return { employer, naming: 0 as const };
    const continuesName = /^\s+\p{Lu}/u.test(sentence.trim().slice(match[0].length));
    if (/\s/u.test(employer.company) || continuesName) return { employer, naming: 1 as const };
  }
  return null;
}

function groupOf(entry: ApplicationDocumentClaimEvidence, employers: readonly Employer[]) {
  const ref = entry.citations.find((citation) => !citation.ref.startsWith("job."))?.ref ?? "";
  const named = namedEmployer(entry.claim, employers);
  const work = /^resume\.workHistory\[(\d+)\]$/u.exec(ref);
  const employer = work ? employers[Number(work[1])] : undefined;
  if (employer) {
    return {
      group: { kind: "employer" as const, key: employer.key, rank: employer.rank },
      naming: named?.employer.key === employer.key ? named.naming : 2 as const
    };
  }
  const project = /^resume\.projects\[(\d+)\]$/u.exec(ref);
  if (project) return { group: { kind: "project" as const, key: "project", rank: Number(project[1]) }, naming: 2 as const };
  if (named) {
    return { group: { kind: "employer" as const, key: named.employer.key, rank: named.employer.rank }, naming: named.naming };
  }
  return { group: { kind: "other" as const, key: "other", rank: 0 }, naming: 2 as const };
}

const byPosition = (left: Unit, right: Unit) => left.position - right.position;

// A sentence with no closing punctuation would run into the sentence after it, so it may only end
// a paragraph: it moves to the end of its paragraph, and a paragraph with two of them is left alone.
const endsSentence = (sentence: string) => /[.!?…]["'”’)\]]*$/u.test(sentence.trim());
const terminated = (unit: Unit) => endsSentence(unit.sentences.at(-1)!);
function settle(units: Unit[]): Unit[] | null {
  const open = units.filter((unit) => !terminated(unit));
  if (open.length > 1) return null;
  return [...units.filter(terminated), ...open];
}

function sameSentences(paragraph: string, sentences: readonly string[]) {
  const segments = [...sentenceSegmenter.segment(paragraph)].map(({ segment }) => segment.trim()).filter(Boolean);
  return segments.length === sentences.length && segments.every((segment, index) => segment === sentences[index]);
}

// The letter with its evidence grouped by source record, or the same output when there is nothing
// to regroup or the letter holds a sentence this step does not recognize (the unchanged checks
// that run next decide such a letter).
export function arrangeCoverLetterByRecord<T extends CoverLetterOutput>(payload: ApplicationDocumentPayload, output: T): T {
  const exempt = new Set(getCoverLetterUncitedLines(payload).map(sentenceKey));
  const claimByText = new Map<string, ApplicationDocumentClaimEvidence>();
  for (const entry of output.claimsUsed) {
    if (!claimByText.has(comparable(entry.claim))) claimByText.set(comparable(entry.claim), entry);
  }
  const paragraphs = output.coverLetter.split(/\n\s*\n/u).map((paragraph) => paragraph.trim()).filter(Boolean);
  const items: Item[][] = [];
  for (const [paragraph, text] of paragraphs.entries()) {
    const sentences = text.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean).flatMap((line) =>
      exempt.has(sentenceKey(line)) ? [line] : [...sentenceSegmenter.segment(line)].map(({ segment }) => segment.trim()).filter(Boolean));
    items.push(sentences.map((sentence) => ({ text: sentence, paragraph, claim: claimByText.get(comparable(sentence)) })));
  }
  const evidenceParagraphs = items.flatMap((paragraph, index) => paragraph.some((item) => item.claim) ? [index] : []);
  if (!evidenceParagraphs.length) return output;
  const first = evidenceParagraphs[0]!;
  const last = evidenceParagraphs.at(-1)!;
  const run = items.slice(first, last + 1).flat();
  // Only evidence, published lines and (between evidence paragraphs) job-requirement lead-ins.
  if (run.some((item) => !item.claim && !exempt.has(sentenceKey(item.text)))) return output;
  if (items.slice(first, last + 1).some((paragraph) =>
    !paragraph.some((item) => item.claim) && !paragraph.every((item) => leadIn.test(item.text)))) return output;

  const employers = employersOf(payload);
  const claimPositions = run.flatMap((item, position) => item.claim ? [position] : []);
  const firstClaim = claimPositions[0]!;
  const lastClaim = claimPositions.at(-1)!;
  const opening: string[] = [];
  const closing: string[] = [];
  const units: Unit[] = [];
  let pending: string[] = [];
  for (const [position, item] of run.entries()) {
    if (item.claim) {
      const { group, naming } = groupOf(item.claim, employers);
      units.push({ sentences: [...pending, item.text], position, paragraph: item.paragraph, group, naming });
      pending = [];
    } else if (position < firstClaim && !leadIn.test(item.text)) {
      opening.push(item.text);
    } else if (position > lastClaim) {
      if (leadIn.test(item.text)) units.at(-1)!.sentences.push(item.text);
      else closing.push(item.text);
    } else {
      pending.push(item.text);
    }
  }
  if (!units.some((unit) => unit.group.kind === "employer")) return output;

  const openingUnits = opening.length
    ? units.filter((unit) => unit.paragraph === first && unit.group.kind === "other") : [];
  const remaining = units.filter((unit) => !openingUnits.includes(unit));
  const firstKeyed = Math.min(...remaining.filter((unit) => unit.group.kind !== "other").map((unit) => unit.position));
  const leading = remaining.filter((unit) => unit.group.kind === "other" && unit.position < firstKeyed);
  const groups = new Map<string, Unit[]>();
  for (const unit of remaining.filter((value) => value.group.kind === "employer").sort(byPosition)) {
    groups.set(unit.group.key, [...groups.get(unit.group.key) ?? [], unit]);
  }
  const employerParagraphs = [...groups.values()]
    .sort((left, right) => left[0]!.group.rank - right[0]!.group.rank)
    .map((group) => {
      const opener = [0, 1].map((naming) => group.find((unit) => unit.naming === naming && terminated(unit))).find(Boolean);
      return opener ? [opener, ...group.filter((unit) => unit !== opener)] : group;
    });
  const rest = [
    ...remaining.filter((unit) => unit.group.kind === "project")
      .sort((left, right) => left.group.rank - right.group.rank || left.position - right.position),
    ...remaining.filter((unit) => unit.group.kind === "other" && unit.position > firstKeyed).sort(byPosition)
  ];

  const settled = [openingUnits, leading, ...employerParagraphs, rest].map(settle);
  if (settled.some((units) => units === null)) return output;
  const [openingSettled, ...bodySettled] = settled as Unit[][];
  const arranged = [
    opening.length ? [...opening, ...openingSettled!.flatMap((unit) => unit.sentences)] : [],
    ...bodySettled.map((units) => units.flatMap((unit) => unit.sentences))
  ].filter((sentences) => sentences.length);
  if (closing.length) {
    const lastParagraph = arranged.at(-1)!;
    if (endsSentence(lastParagraph.at(-1)!)) lastParagraph.push(...closing);
    else arranged.push(closing);
  }

  // A paragraph whose sentences are unchanged keeps its original text (and its line breaks); a
  // rebuilt paragraph must read back as exactly its sentences, or the letter is left as written.
  const originalBySentences = new Map(items.map((paragraph, index) => [paragraph.map((item) => item.text).join("\n"), paragraphs[index]!]));
  const body = arranged.map((sentences) => originalBySentences.get(sentences.join("\n")) ?? sentences.join(" "));
  if (body.some((paragraph, index) => !originalBySentences.has(arranged[index]!.join("\n")) &&
    !sameSentences(paragraph, arranged[index]!))) return output;
  const next = [...paragraphs.slice(0, first), ...body, ...paragraphs.slice(last + 1)];
  if (next.length === paragraphs.length && next.every((paragraph, index) => paragraph === paragraphs[index])) return output;
  return { ...output, coverLetter: next.join("\n\n") };
}
