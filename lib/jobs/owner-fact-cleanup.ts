import { PublicApiError } from "@/lib/api-errors";
import type { JobMatchReviewedEvidence } from "@/lib/jobs/evidence-snapshot-contracts";

// An owner-attested fact goes onto the tailored résumé exactly as typed. Live case 2026-11-06:
// suggested wording was pasted together with its closing quote mark and the coaching note after
// it ("Your resume already names…", "Adjust it to what actually happened."), and both became
// résumé bullets. These checks find only clear paste artifacts; a first-person fact, a quoted
// award name or an apostrophe is fine. Nothing is changed silently: the owner fixes the text.

export type OwnerFactProblemKind = "stray_quote" | "wrapped_in_quotes" | "note_to_you" | "instruction" | "placeholder";
export type OwnerFactProblem = Readonly<{ kind: OwnerFactProblemKind; excerpt: string; at: number }>;

const LABELS: Record<OwnerFactProblemKind, string> = {
  stray_quote: "a quotation mark with no match",
  wrapped_in_quotes: "quotation marks around the whole fact",
  note_to_you: "a note addressed to you",
  instruction: "an instruction, not a fact",
  placeholder: "a placeholder to fill in"
};

const OPENING_QUOTES = new Set(["“", "„"]);
const CLOSING_QUOTES = new Set(["”"]);
const EITHER_QUOTE = "\"";
const QUOTE_CHARACTERS = /["“”„]/gu;
const SECOND_PERSON = /\b(?:you|your|yours|yourself|yourselves)\b|\byou['’](?:re|ve|ll|d)\b/iu;
const INSTRUCTION_START = /^["'“”‘’(\s]*(?:adjust|only mention|mention|make sure|remember to|feel free|consider|tweak|fill in|replace (?:this|it|with|the)|edit (?:this|it)|change (?:this|it)|note:|tip:|reminder:|todo:?)(?=[\s:,.]|$)/iu;
const PLACEHOLDERS = [
  /\[[A-Z#]{1,3}\]/u,
  /\[[^\]\n]*\b(?:insert|add|number|metric|amount|company|name|date|role|title|percent|placeholder|tbd|x)\b[^\]\n]*\]/iu,
  /\bX{2,}\b/u,
  /\$X+\b/u,
  /\b(?:TBD|TODO|TKTK)\b/u,
  /\{[^}\n]{1,40}\}/u,
  /<[^>\n]{1,40}>/u
];

const sentenceSegmenter = new Intl.Segmenter("en", { granularity: "sentence" });

function excerptBefore(text: string, at: number) {
  let start = Math.max(0, at - 39);
  // Start on a whole word, not partway through one.
  const space = start > 0 ? text.slice(start, at).search(/\s/u) : -1;
  if (space >= 0) start += space + 1;
  return `${start > 0 ? "…" : ""}${text.slice(start, at + 1).trimStart()}`;
}

function clip(value: string) {
  const trimmed = value.trim();
  return trimmed.length > 80 ? `${trimmed.slice(0, 79)}…` : trimmed;
}

function strayQuoteAt(text: string): number | null {
  let open: number | null = null;
  for (const match of text.matchAll(QUOTE_CHARACTERS)) {
    const character = match[0];
    const index = match.index!;
    if (OPENING_QUOTES.has(character) || (character === EITHER_QUOTE && open === null)) {
      if (open !== null) return open;
      open = index;
    } else if (CLOSING_QUOTES.has(character) || character === EITHER_QUOTE) {
      if (open === null) return index;
      open = null;
    }
  }
  return open;
}

function wrappedInQuotes(text: string) {
  const quotes = text.match(QUOTE_CHARACTERS) ?? [];
  return quotes.length === 2 && /^\s*["“„]/u.test(text) && /["”][.!?]?\s*$/u.test(text);
}

export function ownerFactProblems(fact: string): OwnerFactProblem[] {
  const text = fact.trim();
  const found = new Map<OwnerFactProblemKind, OwnerFactProblem>();
  const add = (kind: OwnerFactProblemKind, excerpt: string, at: number) => {
    if (!found.has(kind)) found.set(kind, Object.freeze({ kind, excerpt: clip(excerpt), at }));
  };

  const stray = strayQuoteAt(text);
  if (stray !== null) add("stray_quote", excerptBefore(text, stray), stray);
  else if (wrappedInQuotes(text)) add("wrapped_in_quotes", text, 0);

  for (const { segment, index } of sentenceSegmenter.segment(text)) {
    const sentence = segment.trim();
    if (!sentence) continue;
    // A sentence that opens with the stray closing quote belongs to the sentence before it.
    const clean = sentence.replace(/^["”]\s*/u, "");
    if (INSTRUCTION_START.test(clean)) add("instruction", clean, index);
    else if (SECOND_PERSON.test(clean)) add("note_to_you", clean, index);
  }

  for (const pattern of PLACEHOLDERS) {
    const match = pattern.exec(text);
    if (match) add("placeholder", match[0], match.index);
  }
  return [...found.values()].sort((left, right) => left.at - right.at);
}

// New or changed owner lines have one limit: 200 characters, with any number of sentences (owner
// decision 2026-11-11). The one-sentence rule this replaces stood in for JOB_MATCH's whole-fact
// quote check, which now completes a partial quote locally (lib/ai/job-match.ts). Kept (RETAIN)
// lines saved earlier are not re-checked. Client-safe: no server imports.
export const OWNER_FACT_MAX_CHARACTERS = 200;
export type OwnerFactShapeProblem = Readonly<{ kind: "too_long"; detail: string }>;

export function ownerFactShapeProblems(fact: string): OwnerFactShapeProblem[] {
  const length = fact.trim().length;
  if (length <= OWNER_FACT_MAX_CHARACTERS) return [];
  return [{ kind: "too_long", detail: `${length} characters; the limit is ${OWNER_FACT_MAX_CHARACTERS}.` }];
}

// Saving a new or changed owner line: the cleanup check runs first, then the length check.
export function assertNewOwnerFactShape(fact: string) {
  const problems = ownerFactShapeProblems(fact);
  if (!problems.length) return;
  throw new PublicApiError(`Keep each line to ${OWNER_FACT_MAX_CHARACTERS} characters or fewer.`, 422, {
    code: "OWNER_FACT_TOO_LONG",
    problems: problems.map((problem) => problem.kind)
  });
}

function describe(problems: readonly OwnerFactProblem[]) {
  return problems.map((problem) => `${LABELS[problem.kind]} (“${problem.excerpt}”)`).join("; ");
}

// Saving a new or changed owner-attested fact.
export function assertOwnerFactClean(fact: string) {
  const problems = ownerFactProblems(fact);
  if (!problems.length) return;
  throw new PublicApiError(
    `This fact has text that shouldn't go on your résumé: ${describe(problems)}. Remove it, then save again.`,
    422,
    { code: "OWNER_FACT_NEEDS_CLEANUP", problems: problems.map((problem) => problem.kind) }
  );
}

function factStart(fact: string) {
  const text = fact.trim();
  if (text.length <= 40) return text;
  const space = text.lastIndexOf(" ", 40);
  return `${text.slice(0, space > 20 ? space : 40)}…`;
}

function factsMessage(dirty: ReadonlyArray<{ fact: string; problems: readonly OwnerFactProblem[] }>, verb: string, next: string) {
  if (dirty.length === 1) {
    return `A fact you ${verb} for this job has text that shouldn't go on your résumé: ${describe(dirty[0]!.problems)}. ${next}`;
  }
  const each = dirty.map((item) => `In the fact starting “${factStart(item.fact)}”: ${describe(item.problems)}.`).join(" ");
  return `${dirty.length} facts you ${verb} for this job have text that shouldn't go on your résumé. ${each} ${next}`;
}

function dirtyFacts<T extends { fact: string }>(facts: readonly T[]) {
  return facts.flatMap((item) => {
    const problems = ownerFactProblems(item.fact);
    return problems.length ? [{ ...item, problems }] : [];
  });
}

// Saving the job's facts while keeping owner facts saved before this check existed.
export function assertKeptOwnerFactsClean(facts: readonly string[]) {
  const dirty = dirtyFacts(facts.map((fact) => ({ fact })));
  if (!dirty.length) return;
  throw new PublicApiError(
    factsMessage(dirty, "kept", "Use Change or Remove next to each one, then save again."),
    422,
    { code: "OWNER_FACT_NEEDS_CLEANUP", problems: [...new Set(dirty.flatMap((item) => item.problems.map((problem) => problem.kind)))] }
  );
}

// Before a paid résumé or cover letter: owner facts saved before this check existed.
export function assertReviewedOwnerFactsClean(evidence: JobMatchReviewedEvidence | null | undefined) {
  const dirty = dirtyFacts((evidence?.facts ?? []).filter((fact) => fact.provenance === "OWNER_ATTESTED"));
  if (!dirty.length) return;
  throw new PublicApiError(
    factsMessage(dirty, "added", "Use Change next to each one on the job page to fix it, then create your documents again."),
    422,
    {
      code: "OWNER_FACT_NEEDS_CLEANUP",
      gapIds: dirty.map((item) => item.gapId),
      problems: [...new Set(dirty.flatMap((item) => item.problems.map((problem) => problem.kind)))]
    }
  );
}
