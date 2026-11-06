// Faithful rewording for tailored résumé lines (owner-approved 2026-11-05).
//
// A résumé line may reorder, re-inflect, condense or combine the facts it cites, and may lead
// with words the job also uses, but only words that are already in those facts. The checks:
//   1. Sourced words: every word in the line comes from the cited facts. Word forms may change
//      (closed/closing, rewrote/rewriting); names, acronyms, tools and titles must match exactly;
//      only "a", "an", "the", "and" and "I" may be added. A metric, number, date, employer, tool,
//      job term, scope or seniority that is not in the cited facts therefore fails.
//   2. One fact per clause: each comma/semicolon/conjunction segment of the line must come from a
//      single cited clause, so quantities and names cannot be recombined across facts.
//   3. Anchors stay bound: a number keeps its unit and its leading relation word ("from 5 days to
//      2" cannot become "from 2 days to 5"), and a name keeps its leading relation word.
//   4. Qualifiers stay: if the line keeps words next to a qualifier, ownership or status word in
//      the fact (assisted, former, pursuing, basic, expired, about, under...), it keeps that word.
//   5. Negation stays: a negated fact stays negated, and an affirmative fact is never negated.
//   6. Same item only: facts may be combined only within one record (one job, project, summary,
//      achievement or owner-attested fact). Lines that list skills may combine several skill
//      facts, but only as verbatim list items under the source's own category label.
//   7. Every cited fact is expressed, so citing a fact cannot make a half-kept item look whole.
// The checks are deliberately lexical. They cannot judge meaning, so a line built only from a
// fact's own words can still shift emphasis; the owner reviews every document before use.

export type FaithfulRewordingFailure =
  | "not_rewordable"
  | "cross_record"
  | "unsupported_word"
  | "anchor_moved"
  | "qualifier_dropped"
  | "negation_changed"
  | "fact_not_expressed"
  | "list_item_unsupported";

// narrative: a bullet/detail of one record, the summary, an achievement or an owner-attested fact.
// list: a skill, a profile skill or a raw source line (such as "Sales tools: a, b, c").
// null: anything else (record headers, titles, employers, dates, IDs) keeps the exact grammar.
export type RewordingSourceKind = "narrative" | "list" | null;
type Citation = Readonly<{ ref: string; excerpt: string; kind: RewordingSourceKind }>;
type Token = Readonly<{ raw: string; norm: string; stem: string; proper: boolean; number: boolean }>;

const FREE_WORDS = new Set(["a", "an", "the", "and", "i"]);
const RELATION_WORDS = new Set([
  "to", "for", "with", "from", "at", "by", "via", "under", "over", "after", "before", "within", "of",
  "in", "on", "into", "across", "through", "between", "since", "until", "per"
]);
const NEGATIONS = new Set(["no", "not", "never", "none", "without", "lack", "lacks", "lacking", "zero", "0", "cannot", "can't", "don't", "doesn't", "didn't", "haven't", "hasn't", "hadn't", "isn't", "wasn't", "won't", "neither", "nor"]);
// Qualifier, ownership and status words that a rewrite may not silently drop.
const ADJACENT_QUALIFIERS = new Set([
  "former", "formerly", "previously", "prior", "past", "was", "were", "had", "expired", "lapsed", "inactive",
  "pending", "expected", "anticipated", "planned", "candidate", "trainee", "apprentice", "intern", "interim",
  "acting", "deputy", "assistant", "associate", "junior", "basic", "beginner", "conversational", "familiar",
  "familiarity", "exposure", "limited", "intermediate", "introductory", "novice", "elementary", "partial",
  "partially", "some", "about", "approximately", "approx", "nearly", "almost", "around", "roughly", "estimated",
  "projected", "target", "targeted", "goal", "co", "team", "jointly", "shared", "nominated", "finalist", "shortlisted"
]);
// Verb-like qualifiers govern the rest of their clause ("Assisted the director in onboarding 30 owners").
const GOVERNING_QUALIFIERS = new Set([
  "assisted", "assisting", "assist", "supported", "supporting", "helped", "helping", "help", "contributed",
  "contributing", "participated", "participating", "shadowed", "shadowing", "studying", "seeking", "pursuing",
  "aspiring", "eligible", "learning", "under", "reported", "reporting", "enrolled", "completing"
]);
// The only verb substitutions the existing résumé grammar already allowed.
const SYNONYM_GROUPS = [["built", "created", "developed", "engineered"], ["improved", "enhanced"], ["reduced", "decreased"]];
const NUMBER_WORDS: Record<string, string> = {
  zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9",
  ten: "10", eleven: "11", twelve: "12", thirteen: "13", fourteen: "14", fifteen: "15", sixteen: "16",
  seventeen: "17", eighteen: "18", nineteen: "19", twenty: "20", thirty: "30", forty: "40", fifty: "50",
  sixty: "60", seventy: "70", eighty: "80", ninety: "90", hundred: "100"
};
const IRREGULAR: Record<string, string> = {
  wrote: "write", written: "write", rewrote: "rewrite", rewritten: "rewrite", built: "build", rebuilt: "rebuild",
  led: "lead", ran: "run", grew: "grow", grown: "grow", won: "win", sold: "sell", made: "make", took: "take",
  taken: "take", began: "begin", begun: "begin", brought: "bring", taught: "teach", bought: "buy", drove: "drive",
  driven: "drive", spoke: "speak", spoken: "speak", chose: "choose", chosen: "choose", found: "find", held: "hold",
  kept: "keep", met: "meet", sent: "send", spent: "spend", stood: "stand", thought: "think", told: "tell",
  oversaw: "oversee", overseen: "oversee", undertook: "undertake", gave: "give", given: "give", got: "get",
  went: "go", did: "do", done: "do", saw: "see", seen: "see", knew: "know", known: "know", paid: "pay",
  laid: "lay", left: "leave", lost: "lose", sought: "seek", understood: "understand"
};

function stemOf(word: string) {
  let value = IRREGULAR[word] ?? word;
  for (const suffix of ["ing", "ed", "es", "s", "ly"]) {
    if (value.endsWith(suffix) && value.length - suffix.length >= 3) {
      value = value.slice(0, -suffix.length);
      break;
    }
  }
  if (value.endsWith("e") && value.length > 3) value = value.slice(0, -1);
  if (/([b-df-hj-np-tv-z])\1$/u.test(value)) value = value.slice(0, -1);
  return value;
}

const tokenPattern = /\$?\d[\d,]*(?:\.\d+)?[%kmb]?\+?|[\p{L}][\p{L}\p{N}'’+#&]*(?:\.[\p{L}\p{N}]+)*|%/giu;

function tokens(text: string): Token[] {
  const out: Token[] = [];
  let sentenceStart = true;
  for (const piece of text.split(/(?<=[:;.!?])\s+/u)) {
    // Ordinary hyphenated words may be written with a space (small-business / small business).
    // Identifiers and number ranges (CSOP-24017, ASP-NET, 2020–2021) stay exact tokens.
    const words = piece.split(/\s+/u).flatMap((chunk) => {
      const identifier = /[‐-―-]/u.test(chunk) && (/\d/u.test(chunk) || /\p{Lu}.*\p{Lu}/u.test(chunk));
      if (identifier) return [chunk.replace(/^[^\p{L}\p{N}$]+|[^\p{L}\p{N}%+#]+$/gu, "")];
      return [...chunk.replace(/[‐-―-]/gu, " ").matchAll(tokenPattern)].map((match) => match[0]);
    });
    for (const word of words) {
      const raw = word.replace(/['’]s$/u, "");
      const lower = raw.toLocaleLowerCase().replace(/,/gu, "");
      const number = /\d/u.test(lower) || lower in NUMBER_WORDS || lower === "%";
      const norm = NUMBER_WORDS[lower] ?? (lower === "percent" ? "%" : lower);
      // Names, acronyms, tools and titles: an inner capital (HubSpot, GMV), a symbol (C++, P&L,
      // Node.js) or a capital that does not start a sentence. These must match exactly.
      const proper = !number && (/^.+\p{Lu}/u.test(raw) || /[+#&]|\.\p{L}/u.test(raw) ||
        (!sentenceStart && /^\p{Lu}/u.test(raw)));
      out.push({ raw, norm, stem: number ? norm : stemOf(norm), proper, number });
      sentenceStart = false;
    }
    sentenceStart = true;
  }
  return out;
}

const sentenceSegmenter = new Intl.Segmenter("en", { granularity: "sentence" });
const actionWords = [
  "accelerated", "achieved", "architected", "automated", "built", "collaborated", "consolidated",
  "coordinated", "created", "decreased", "delivered", "designed", "developed", "engineered", "enhanced",
  "established", "executed", "expanded", "generated", "grew", "implemented", "improved", "increased",
  "launched", "led", "maintained", "managed", "mentored", "migrated", "modernized", "optimized",
  "orchestrated", "partnered", "produced", "reduced", "resolved", "scaled", "streamlined", "strengthened",
  "supported", "transformed", "used", "utilized"
];
const clauseBoundary = new RegExp(
  `\\s*;\\s*|\\s*,\\s*(?:but|while|then)\\s+|\\s*,\\s*and\\s+(?=(?:${actionWords.join("|")})\\b)|\\s+(?:and|but|while|then)\\s+(?=(?:${actionWords.join("|")})\\b)`,
  "iu"
);
function clausesOf(text: string) {
  return text.split(/\r?\n/u)
    .flatMap((line) => [...sentenceSegmenter.segment(line.replace(/^[-*•▪◦–—]\s+/u, ""))].flatMap(({ segment }) => segment.split(clauseBoundary)))
    .map((clause) => clause.trim())
    .filter(Boolean);
}
const segmentBoundary = /\s*[;,:]\s*|\s+(?:and|but|while|then)\s+|\s+[–—]\s+/iu;

function synonymous(left: string, right: string) {
  return SYNONYM_GROUPS.some((group) => group.includes(left) && group.includes(right));
}
function supports(claimToken: Token, source: readonly Token[]) {
  return source.some((token) => claimToken.proper || claimToken.number
    ? token.norm === claimToken.norm
    : token.norm === claimToken.norm || token.stem === claimToken.stem || synonymous(token.norm, claimToken.norm));
}
function content(list: readonly Token[]) {
  return list.filter((token) => !FREE_WORDS.has(token.norm));
}

type Clause = Readonly<{ citation: number; tokens: Token[] }>;

// Number and name anchors keep their unit and their leading relation word.
function anchorsBound(segment: readonly Token[], clause: readonly Token[]) {
  const words = content(segment);
  const source = content(clause);
  return words.every((token, index) => {
    if (!token.number && !token.proper) return true;
    const occurrences = source.flatMap((candidate, position) => candidate.norm === token.norm ? [position] : []);
    if (!occurrences.length) return false;
    const previous = words[index - 1];
    const next = words[index + 1];
    return occurrences.some((position) => {
      const before = source.slice(Math.max(0, position - 2), position);
      const after = source.slice(position + 1, position + 4);
      const previousOk = !previous || !RELATION_WORDS.has(previous.norm) || before.some((item) => item.norm === previous.norm);
      const nextOk = !token.number || !next || !after.length || after.some((item) => item.stem === next.stem || item.norm === next.norm);
      return previousOk && nextOk;
    });
  });
}

function segmentFits(segment: readonly Token[], clause: readonly Token[]) {
  return content(segment).every((token) => supports(token, clause)) && anchorsBound(segment, clause);
}

function qualifiersKept(claim: readonly Token[], clauses: readonly Clause[]) {
  const claimStems = new Set(content(claim).map((token) => token.stem));
  return clauses.every(({ tokens: clause }) => {
    const words = content(clause);
    return words.every((token, index) => {
      const governing = GOVERNING_QUALIFIERS.has(token.norm);
      if (!governing && !ADJACENT_QUALIFIERS.has(token.norm)) return true;
      const scope = governing
        ? words.slice(index + 1)
        : [...words.slice(Math.max(0, index - 2), index), ...words.slice(index + 1, index + 3)];
      const scopeKept = scope.some((item) => !RELATION_WORDS.has(item.norm) && claimStems.has(item.stem));
      return !scopeKept || claimStems.has(token.stem);
    });
  });
}

function negated(list: readonly Token[]) {
  return list.some((token) => NEGATIONS.has(token.norm));
}

function listParts(text: string) {
  const trimmed = text.trim().replace(/[.;]+$/u, "");
  const label = trimmed.match(/^([^:,;|]{1,40}):\s*(.+)$/u);
  const items = (label ? label[2]! : trimmed).split(/\s*[,;|·•]\s*/u).map((item) => item.trim().toLocaleLowerCase()).filter(Boolean);
  return { label: label ? label[1]!.trim().toLocaleLowerCase() : null, items };
}

// A line that lists skills: every item and the category label are copied verbatim.
function listFailure(claim: string, citations: readonly Citation[]): FaithfulRewordingFailure | null {
  const sources = citations.map((citation) => listParts(citation.excerpt));
  const parts = listParts(claim);
  const items = new Set(sources.flatMap((source, index) => [...source.items, citations[index]!.excerpt.trim().replace(/[.;]+$/u, "").toLocaleLowerCase()]));
  const labels = new Set(sources.flatMap((source) => source.label ? [source.label] : []));
  if (parts.label !== null && !labels.has(parts.label)) return "list_item_unsupported";
  if (!parts.items.length || !parts.items.every((item) => items.has(item))) return "list_item_unsupported";
  const expressed = sources.every((source, index) =>
    parts.items.includes(citations[index]!.excerpt.trim().replace(/[.;]+$/u, "").toLocaleLowerCase()) ||
    source.items.some((item) => parts.items.includes(item)) ||
    (source.label !== null && source.label === parts.label));
  return expressed ? null : "fact_not_expressed";
}

export function faithfulRewordingFailure(claim: string, citations: readonly Citation[]): FaithfulRewordingFailure | null {
  if (!citations.length) return "fact_not_expressed";
  if (citations.some((citation) => citation.kind === null)) return "not_rewordable";
  if (citations.every((citation) => citation.kind === "list")) return listFailure(claim, citations);
  if (!citations.every((citation) => citation.kind === "narrative") ||
    new Set(citations.map((citation) => citation.ref)).size > 1) return "cross_record";

  const claimTokens = tokens(claim);
  const clauses: Clause[] = citations.flatMap((citation, index) =>
    clausesOf(citation.excerpt).map((clause) => ({ citation: index, tokens: tokens(clause) })));
  const matched = new Set<number>();
  for (const segmentText of claim.split(segmentBoundary)) {
    // A connector that joins two kept clauses (", then", "; and") is structure, not a fact.
    const segment = tokens(segmentText.replace(/^\s*(?:and|but|while|then)\s+/iu, ""));
    if (!content(segment).length) continue;
    const fits = clauses.filter((clause) => segmentFits(segment, clause.tokens));
    if (!fits.length) {
      const sourced = content(segment).every((token) => clauses.some((clause) => supports(token, clause.tokens)));
      return sourced ? "anchor_moved" : "unsupported_word";
    }
    fits.forEach((clause) => matched.add(clause.citation));
  }
  if (!qualifiersKept(claimTokens, clauses)) return "qualifier_dropped";
  if (negated(claimTokens) !== clauses.some((clause) => negated(clause.tokens))) return "negation_changed";
  const claimStems = new Set(content(claimTokens).map((token) => token.stem));
  const expressed = citations.every((citation, index) => {
    const words = content(tokens(citation.excerpt)).filter((token) => !RELATION_WORDS.has(token.norm));
    const kept = words.filter((token) => claimStems.has(token.stem)).length;
    return matched.has(index) && kept >= Math.max(1, Math.ceil(words.length / 3));
  });
  return expressed ? null : "fact_not_expressed";
}
