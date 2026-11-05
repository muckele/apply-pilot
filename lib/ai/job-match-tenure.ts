import type { MatchInput } from "@/lib/ai/job-match";

// Local, deterministic years-of-experience check for JOB_MATCH.
//
// The model's keyword-gap rules cannot express "5+ years in a <kind of> role":
// "years" and the kind words usually appear somewhere in a résumé, and the
// example role titles after "such as" are illustrative. This module reads the
// posting's own minimum and role anchors, counts the submitted work-history
// roles whose own title (or an "as <role>" bullet) shows that kind of work, and
// does the date arithmetic itself. Every uncertainty resolves toward counting
// more experience, so the check can miss a shortfall but never overstates one.

export type TenureRequirement = {
  minimumMonths: number;
  requiredLabel: string;
  kindLabel: string;
  roleAnchors: string[];
};

export type JobMatchTenureCitation = { ref: string; excerpt: string };

export type JobMatchTenureCountedRole = JobMatchTenureCitation & {
  title: string;
  company: string | null;
  startDate: string | null;
  endDate: string | null;
};

export type JobMatchTenureFinding = {
  method: "work_history_titles_and_dates";
  summary: string;
  requiredLabel: string;
  kindLabel: string;
  minimumMonths: number;
  evidencedMonths: number;
  countedRoles: JobMatchTenureCountedRole[];
  uncountedRoleCount: number;
  statedDurations: JobMatchTenureCitation[];
};

export type JobMatchTenureGap = {
  requirement: string;
  jobRequirement: JobMatchTenureCitation;
  tenure: JobMatchTenureFinding;
};

type DetailedTenureRequirement = TenureRequirement & {
  kindTerms: string[];
};

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, twenty: 20
};
const NUMBER = `(?<![\\p{L}\\p{N}.])(\\d{1,2}(?:\\.\\d+)?|${Object.keys(NUMBER_WORDS).join("|")})`;
const YEARS = "(?:years?|yrs?\\.?)(?![a-z])";
const DURATION_PATTERNS = [
  new RegExp(`(?:~\\s*|approx(?:imately|\\.)?\\s+|about\\s+)?${NUMBER}\\s*(?:-|–|—|to)\\s*${NUMBER}\\s*\\+?\\s*${YEARS}`, "giu"),
  new RegExp(`(?:at\\s+least|a\\s+minimum\\s+of|minimum\\s+of|minimum|min\\.?|no\\s+less\\s+than|more\\s+than|over)\\s+${NUMBER}\\s*\\+?\\s*${YEARS}`, "giu"),
  new RegExp(`${NUMBER}\\s+(?:or\\s+more|or\\s+greater)\\s+${YEARS}`, "giu"),
  new RegExp(`${NUMBER}\\s*(?:\\+|plus)\\s*${YEARS}`, "giu"),
  new RegExp(`${NUMBER}\\s+${YEARS}\\s*\\+`, "giu"),
  new RegExp(`${NUMBER}\\s+${YEARS}(?=\\s*['’]?\\s*(?:of|in|as|working|experience|professional|relevant|hands-on|related)\\b)`, "giu")
];
const LOOSE_DURATION = new RegExp(`${NUMBER}(?:\\s*(?:-|–|—|to)\\s*${NUMBER})?\\s*\\+?\\s*${YEARS}`, "giu");

const ROLE_NOUNS = new Set([
  "engineer", "architect", "consultant", "developer", "manager", "analyst", "scientist", "designer",
  "specialist", "representative", "rep", "executive", "director", "lead", "leader", "administrator",
  "strategist", "advisor", "adviser", "coordinator", "officer", "technician", "programmer", "researcher",
  "owner", "associate", "recruiter", "accountant", "writer", "editor", "producer", "marketer", "agent",
  "assistant", "tester", "operator", "head", "president", "vp", "partner", "founder", "principal",
  "generalist", "expert", "trainer", "instructor", "teacher", "counsel", "attorney", "nurse",
  "controller", "planner", "buyer", "auditor"
]);

const TOKEN_FAMILIES: Record<string, string> = {
  engineering: "engineer",
  consulting: "consultant",
  consultancy: "consultant",
  consult: "consultant",
  architecture: "architect",
  development: "developer",
  management: "manager",
  managing: "manager",
  administration: "administrator",
  analysis: "analyst",
  deployed: "deploy",
  deployment: "deploy",
  ops: "operation",
  tech: "technical"
};

// Words that, right before a singular role phrase in a bullet, show the
// applicant worked with someone in that role rather than in it. Kept narrow:
// "promoted to", "and" (dual titles) and "for" must still count the role.
const COLLABORATOR_CUES = new Set([
  "with", "alongside", "among", "between", "other", "supporting", "supported",
  "partnering", "partnered", "managing", "managed", "hiring", "hired", "training", "trained"
]);

const KIND_STOPWORDS = new Set(["a", "an", "the", "role", "roles", "position", "positions", "capacity", "or", "and"]);

type Token = { raw: string; canonical: string };

function tokenize(value: string): Token[] {
  return value.toLocaleLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map((raw) => ({ raw, canonical: canonicalToken(raw) }));
}

function singular(token: string) {
  if (token.length > 4 && token.endsWith("ies")) return token.slice(0, -3) + "y";
  if (token.length > 3 && token.endsWith("s") && !/(?:ss|us|is)$/u.test(token)) return token.slice(0, -1);
  return token;
}

function canonicalToken(raw: string) {
  const familied = TOKEN_FAMILIES[raw] ?? raw;
  const stripped = singular(familied);
  return TOKEN_FAMILIES[stripped] ?? stripped;
}

function isPluralToken(token: Token) {
  return singular(TOKEN_FAMILIES[token.raw] ?? token.raw) !== (TOKEN_FAMILIES[token.raw] ?? token.raw);
}

function phraseOffsets(text: Token[], phrase: Token[]) {
  const offsets: number[] = [];
  if (!phrase.length) return offsets;
  for (let start = 0; start + phrase.length <= text.length; start += 1) {
    if (phrase.every((token, index) => text[start + index].canonical === token.canonical)) offsets.push(start);
  }
  return offsets;
}

function numberValue(value: string) {
  const lower = value.toLocaleLowerCase();
  return NUMBER_WORDS[lower] ?? Number(lower);
}

type DurationMatch = { start: number; end: number; text: string; minimum: number; maximum: number };

function excludedDurationContext(text: string, start: number, end: number) {
  const before = text.slice(Math.max(0, start - 24), start).toLocaleLowerCase();
  const after = text.slice(end, end + 12).toLocaleLowerCase();
  return /\b(?:within|last|past|first|every|after|next)\s*(?:the\s+)?$/u.test(before) || /^\s*(?:ago|old)\b/u.test(after);
}

function findRequirementDurations(text: string): DurationMatch[] {
  const matches: DurationMatch[] = [];
  for (const pattern of DURATION_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const start = match.index ?? 0;
      const end = start + match[0].length;
      if (excludedDurationContext(text, start, end)) continue;
      const numbers = match.slice(1).filter((value): value is string => typeof value === "string").map(numberValue);
      if (!numbers.length || numbers.some((value) => !Number.isFinite(value))) continue;
      matches.push({
        start,
        end,
        text: match[0],
        minimum: Math.min(...numbers),
        maximum: Math.max(...numbers)
      });
    }
  }
  matches.sort((left, right) => left.start - right.start || right.end - left.end);
  const merged: DurationMatch[] = [];
  for (const match of matches) {
    const previous = merged.at(-1);
    if (previous && match.start < previous.end) continue;
    merged.push(match);
  }
  return merged;
}

function requiredLabel(text: string) {
  const label = text.trim().replace(/\s+/gu, " ");
  return /^[A-Z][a-z]/u.test(label) ? label[0].toLocaleLowerCase() + label.slice(1) : label;
}

const LIST_TERMINATOR = /[.;:]|\b(?:with|who|that|where|for|at|in|on|within|across|working|focused|supporting|including|plus|to)\b/iu;

function listItems(text: string, start: number) {
  const rest = text.slice(start).replace(/\([^)]*\)/gu, " ");
  const terminator = rest.search(LIST_TERMINATOR);
  const region = terminator === -1 ? rest : rest.slice(0, terminator);
  return region.split(/\s*,\s*|\s+(?:and\/or|or|and)\s+|\s*\/\s*|\s*&\s*/iu)
    .map((item) => {
      let cleaned = item.trim();
      let previous = "";
      while (cleaned !== previous) {
        previous = cleaned;
        cleaned = cleaned.replace(/^(?:or|and|a|an|the)\s+/iu, "").replace(/\s+(?:roles?|positions?|titles?)$/iu, "").trim();
      }
      return cleaned;
    })
    .filter((item) => {
      const tokens = tokenize(item);
      return tokens.length > 0 && tokens.length <= 6 && ROLE_NOUNS.has(tokens.at(-1)!.canonical);
    });
}

type Anchor = { text: string; position: number };

function anchorsFromLists(text: string): Anchor[] {
  const anchors: Anchor[] = [];
  const cues = [
    /\b(?:such\s+as|including|e\.\s*g\.\s*,?|eg\s*,?|for\s+example\s*,?)\s+/giu,
    /(?<=\b(?:roles?|positions?|titles?)\s)like\s+/giu,
    /(?<!\bsuch\s)\bas\s+(?:a|an)\s+/giu
  ];
  for (const cue of cues) {
    for (const match of text.matchAll(cue)) {
      const start = (match.index ?? 0) + match[0].length;
      listItems(text, start).forEach((item, index) => anchors.push({ text: item, position: start + index }));
    }
  }
  return anchors;
}

function kindRolePhrase(text: string) {
  const withArticle = text.match(/\bin\s+((?:a|an)\s+([^.;:,()]{1,80}?)\s+(?:role|position|capacity))\b/iu);
  if (withArticle?.index !== undefined) {
    return { label: withArticle[1], kind: withArticle[2], position: withArticle.index };
  }
  const plural = text.match(/\bin\s+(((?:[\p{L}\p{N}'’-]+\s+){1,5}?)(?:roles|positions))\b/iu);
  if (plural?.index !== undefined) {
    return { label: plural[1], kind: plural[2].trim(), position: plural.index };
  }
  return null;
}

function joinOr(values: string[]) {
  if (values.length <= 1) return values.join("");
  if (values.length === 2) return `${values[0]} or ${values[1]}`;
  return `${values.slice(0, -1).join(", ")}, or ${values.at(-1)}`;
}

function article(value: string) {
  return /^[aeiou]/iu.test(value) ? "an" : "a";
}

function parseDetailed(requirement: string): DetailedTenureRequirement | null {
  const durations = findRequirementDurations(requirement);
  if (durations.length !== 1) return null;
  const [duration] = durations;
  // "Degree or N years" and "N years, or a degree" describe alternative paths,
  // not a hard minimum, so a shortfall would overstate the gap.
  if (/\bor\b/iu.test(requirement.slice(0, duration.start))) return null;
  if (/\bor\b[^.;]*\b(?:degree|bachelor|master|ph\.?\s*d|diploma|certification)\b/iu.test(requirement)) return null;

  const anchors = anchorsFromLists(requirement);
  const phrase = kindRolePhrase(requirement);
  const kindTerms: string[] = [];
  if (phrase) {
    const tokens = tokenize(phrase.kind);
    if (tokens.length && ROLE_NOUNS.has(tokens.at(-1)!.canonical)) {
      anchors.push({ text: phrase.kind.trim(), position: phrase.position });
    } else {
      kindTerms.push(...tokens.map((token) => token.canonical).filter((token) => !KIND_STOPWORDS.has(token)));
    }
  }
  anchors.sort((left, right) => left.position - right.position);
  const seen = new Set<string>();
  const roleAnchors = anchors.flatMap((anchor) => {
    const key = tokenize(anchor.text).map((token) => token.canonical).join(" ");
    if (seen.has(key)) return [];
    seen.add(key);
    return [anchor.text];
  });
  if (!roleAnchors.length) return null;

  return {
    minimumMonths: Math.round(duration.minimum * 12),
    requiredLabel: requiredLabel(duration.text),
    kindLabel: phrase
      ? phrase.label.replace(/\s+/gu, " ").trim()
      : `${article(roleAnchors[0])} ${joinOr(roleAnchors)} role`,
    roleAnchors,
    kindTerms
  };
}

export function parseTenureRequirement(requirement: string): TenureRequirement | null {
  const parsed = parseDetailed(requirement);
  if (!parsed) return null;
  return {
    minimumMonths: parsed.minimumMonths,
    requiredLabel: parsed.requiredLabel,
    kindLabel: parsed.kindLabel,
    roleAnchors: parsed.roleAnchors
  };
}

export function describeEvidencedDuration(months: number) {
  if (!(months >= 1)) return "less than a month";
  const total = Math.floor(months + 1e-9);
  const years = Math.floor(total / 12);
  const remainder = total % 12;
  const parts = [
    years ? `${years} year${years === 1 ? "" : "s"}` : "",
    remainder ? `${remainder} month${remainder === 1 ? "" : "s"}` : ""
  ].filter(Boolean);
  return `about ${parts.join(" and ")}`;
}

// ---- Work history ----------------------------------------------------------

type DatePoint = { kind: "present" } | { kind: "month"; year: number; month: number } | { kind: "year"; year: number };

const MONTH_NAMES: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5,
  jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9,
  oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12
};

function fullYear(value: string, asOf: Date) {
  const number = Number(value);
  if (value.length === 4) return number;
  const century = Math.floor(asOf.getUTCFullYear() / 100) * 100;
  return century + number > asOf.getUTCFullYear() ? century - 100 + number : century + number;
}

function validPoint(point: DatePoint): DatePoint | null {
  if (point.kind === "present") return point;
  if (point.year < 1950 || point.year > 2100) return null;
  if (point.kind === "month" && (point.month < 1 || point.month > 12)) return null;
  return point;
}

function parseDatePoint(value: string, asOf: Date): DatePoint | null {
  const text = value.trim().toLocaleLowerCase().replace(/\.$/u, "").replace(/\s+/gu, " ");
  if (!text) return null;
  if (/^(?:present|current|currently|now|today|ongoing|to date|till date)$/u.test(text)) return { kind: "present" };
  const named = text.match(/^([a-z]{3,9})\.?,? ?(?:'|’)?(\d{4}|\d{2})$/u);
  if (named) {
    const month = MONTH_NAMES[named[1]];
    return month ? validPoint({ kind: "month", year: fullYear(named[2], asOf), month }) : null;
  }
  const monthYear = text.match(/^(\d{1,2}) ?[/.-] ?(\d{4})$/u);
  if (monthYear) return validPoint({ kind: "month", year: Number(monthYear[2]), month: Number(monthYear[1]) });
  const yearMonth = text.match(/^(\d{4}) ?[/.-] ?(\d{1,2})$/u);
  if (yearMonth) return validPoint({ kind: "month", year: Number(yearMonth[1]), month: Number(yearMonth[2]) });
  const usDate = text.match(/^(\d{1,2})\/\d{1,2}\/(\d{4})$/u);
  if (usDate) return validPoint({ kind: "month", year: Number(usDate[2]), month: Number(usDate[1]) });
  const year = text.match(/^(\d{4})$/u);
  if (year) return validPoint({ kind: "year", year: Number(year[1]) });
  return null;
}

const RANGE_SEPARATORS = [
  /\s*[–—]\s*/u,
  /\s+-\s+/u,
  /\s+(?:to|until|through)\s+/iu,
  /(?<=\d{4})\s*-\s*(?=[a-z]|\d{4}\b)/iu,
  /(?<=[a-z.])\s*-\s*(?=[a-z]|\d{4}\b)/iu
];

function splitRange(value: string, asOf: Date): [DatePoint, DatePoint] | null {
  for (const separator of RANGE_SEPARATORS) {
    const parts = value.split(separator);
    if (parts.length !== 2) continue;
    const start = parseDatePoint(parts[0], asOf);
    const end = parseDatePoint(parts[1], asOf);
    if (start && end) return [start, end];
  }
  return null;
}

function monthIndexAsOf(asOf: Date) {
  const year = asOf.getUTCFullYear();
  const month = asOf.getUTCMonth();
  const days = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return year * 12 + month + Math.min(asOf.getUTCDate(), days) / days;
}

type Interval = { start: number; end: number };

// Earliest plausible start, latest plausible end, capped at asOf. A missing end
// date is read as ongoing. Returns null when the start cannot be read.
function roleInterval(startDate: string | null, endDate: string | null, asOf: Date): Interval | null {
  let start = startDate ? parseDatePoint(startDate, asOf) : null;
  let end = endDate ? parseDatePoint(endDate, asOf) : null;
  if (!start && startDate && !endDate?.trim()) {
    const range = splitRange(startDate, asOf);
    if (range) [start, end] = range;
  }
  if (!start || start.kind === "present") return null;
  if (endDate?.trim() && !end) return null;
  const now = monthIndexAsOf(asOf);
  const startIndex = start.year * 12 + (start.kind === "month" ? start.month - 1 : 0);
  const rawEnd = !end || end.kind === "present"
    ? now
    : end.year * 12 + (end.kind === "month" ? end.month : 12);
  if (rawEnd < startIndex) return null;
  const endIndex = Math.min(rawEnd, now);
  return { start: startIndex, end: Math.max(startIndex, endIndex) };
}

function unionMonths(intervals: Interval[]) {
  const sorted = [...intervals].sort((left, right) => left.start - right.start);
  let total = 0;
  let current: Interval | null = null;
  for (const interval of sorted) {
    if (!current || interval.start > current.end) {
      if (current) total += current.end - current.start;
      current = { ...interval };
    } else {
      current.end = Math.max(current.end, interval.end);
    }
  }
  if (current) total += current.end - current.start;
  return total;
}

function readText(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const key of ["text", "value", "content", "sourceText"]) {
      const candidate = (value as Record<string, unknown>)[key];
      if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
    }
  }
  return null;
}

type WorkRole = {
  ref: string;
  title: string;
  company: string | null;
  startDate: string | null;
  endDate: string | null;
  bullets: string[];
};

function readWorkRoles(input: MatchInput): WorkRole[] | null {
  const history = input.resume?.workHistory;
  if (!Array.isArray(history) || !history.length) return null;
  const roles: WorkRole[] = [];
  for (const [index, entry] of history.entries()) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    const record = entry as Record<string, unknown>;
    const title = readText(record.title) ?? readText(record.role) ?? readText(record.position);
    if (!title) return null;
    roles.push({
      ref: `resume.workHistory[${index}]`,
      title,
      company: readText(record.company),
      startDate: readText(record.startDate),
      endDate: readText(record.endDate),
      bullets: Array.isArray(record.bullets)
        ? record.bullets.map(readText).filter((bullet): bullet is string => Boolean(bullet))
        : []
    });
  }
  return roles;
}

function headNoun(anchor: Token[]) {
  return anchor.at(-1)?.canonical ?? "";
}

function roleEvidence(role: WorkRole, anchors: Token[][]): string | null {
  const titleTokens = tokenize(role.title);
  if (anchors.some((anchor) => phraseOffsets(titleTokens, anchor).length > 0)) return role.title;
  // The posting's examples are illustrative ("such as", "or similar"), so a
  // title sharing an example's role noun (Sales Engineer ~ Solutions Engineer)
  // is counted too. Counting more can only hide a shortfall, never invent one.
  const heads = new Set(anchors.map(headNoun));
  if (titleTokens.some((token) => ROLE_NOUNS.has(token.canonical) && heads.has(token.canonical))) return role.title;
  for (const bullet of role.bullets) {
    const tokens = tokenize(bullet);
    const served = anchors.some((anchor) => phraseOffsets(tokens, anchor).some((offset) => {
      const last = tokens[offset + anchor.length - 1];
      const previous = tokens[offset - 1]?.raw;
      return !isPluralToken(last) && !(previous && COLLABORATOR_CUES.has(previous));
    }));
    if (served) return bullet;
  }
  return null;
}

// ---- Durations the applicant's own evidence states -----------------------

type EvidenceSource = { ref: string; text: string };

function applicantStatements(input: MatchInput): EvidenceSource[] {
  const sources: EvidenceSource[] = [];
  const push = (ref: string, value: unknown) => {
    const text = readText(value);
    if (text) sources.push({ ref, text });
  };
  push("resume.summary", input.resume?.summary);
  push("resume.rawText", input.resume?.rawText);
  (input.resume?.achievements ?? []).forEach((value, index) => push(`resume.achievements[${index}]`, value));
  if (Array.isArray(input.resume?.workHistory)) {
    input.resume.workHistory.forEach((entry, index) => {
      const bullets = entry && typeof entry === "object" ? (entry as Record<string, unknown>).bullets : null;
      if (Array.isArray(bullets)) bullets.forEach((bullet) => push(`resume.workHistory[${index}]`, bullet));
    });
  }
  (input.reviewedEvidence?.facts ?? []).forEach((fact, index) => push(`reviewedEvidence.facts[${index}]`, fact.fact));
  return sources;
}

function statementSegments(text: string) {
  return text.split(/(?<!\d)\.(?!\d)|[;!?\n•,]|\b(?:but|however|although|though|yet)\b/iu)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function statedDurations(input: MatchInput, requirement: DetailedTenureRequirement, anchors: Token[][]) {
  const statements: Array<JobMatchTenureCitation & { months: number }> = [];
  for (const source of applicantStatements(input)) {
    // No negation filter: reading a stated duration as evidence can only hide
    // a shortfall, and owner facts often say what is "not listed" on a résumé.
    for (const segment of statementSegments(source.text)) {
      const tokens = tokenize(segment);
      const namesKind = anchors.some((anchor) => phraseOffsets(tokens, anchor).length > 0) || (
        requirement.kindTerms.length > 0 &&
        requirement.kindTerms.every((term) => tokens.some((token) => token.canonical === term))
      );
      if (!namesKind) continue;
      const numbers = [...segment.matchAll(LOOSE_DURATION)].flatMap((match) =>
        match.slice(1).filter((value): value is string => typeof value === "string").map(numberValue));
      const years = Math.max(...numbers.filter(Number.isFinite), Number.NEGATIVE_INFINITY);
      if (Number.isFinite(years)) statements.push({ ref: source.ref, excerpt: segment, months: years * 12 });
    }
  }
  return statements;
}

// ---- Assessment ------------------------------------------------------------

function assess(
  input: MatchInput,
  requirement: DetailedTenureRequirement,
  roles: WorkRole[],
  asOf: Date
): JobMatchTenureFinding | null {
  const anchors = requirement.roleAnchors.map(tokenize).filter((anchor) => anchor.length > 0);
  const counted: Array<{ role: WorkRole; excerpt: string; interval: Interval }> = [];
  for (const role of roles) {
    const excerpt = roleEvidence(role, anchors);
    if (!excerpt) continue;
    const interval = roleInterval(role.startDate, role.endDate, asOf);
    // A matching role without a readable start could close any shortfall.
    if (!interval) return null;
    counted.push({ role, excerpt, interval });
  }

  const workHistoryMonths = unionMonths(counted.map((entry) => entry.interval));
  const stated = statedDurations(input, requirement, anchors);
  const evidenced = Math.max(workHistoryMonths, ...stated.map((statement) => statement.months));
  if (evidenced >= requirement.minimumMonths) return null;

  const summary = counted.length === 0 && stated.length === 0
    ? `Your résumé doesn't show time in ${requirement.kindLabel}; this job asks for ${requirement.requiredLabel}.`
    : `Your résumé shows ${describeEvidencedDuration(evidenced)} in ${requirement.kindLabel}; this job asks for ${requirement.requiredLabel}.`;

  return {
    method: "work_history_titles_and_dates",
    summary,
    requiredLabel: requirement.requiredLabel,
    kindLabel: requirement.kindLabel,
    minimumMonths: requirement.minimumMonths,
    evidencedMonths: Math.floor(evidenced + 1e-9),
    countedRoles: counted.map(({ role, excerpt }) => ({
      ref: role.ref,
      excerpt,
      title: role.title,
      company: role.company,
      startDate: role.startDate,
      endDate: role.endDate
    })),
    uncountedRoleCount: roles.length - counted.length,
    statedDurations: stated.map(({ ref, excerpt }) => ({ ref, excerpt }))
  };
}

// Returns only the requirements whose stated minimum the submitted work history
// does not reach. Requirements that cannot be assessed are left to the model's
// evidence-scoped gap rules unchanged.
export function findTenureGaps(input: MatchInput, options: { asOf: Date }): JobMatchTenureGap[] {
  const roles = readWorkRoles(input);
  if (!roles) return [];
  const gaps: JobMatchTenureGap[] = [];
  for (const [prefix, values] of [
    ["job.requirements", input.job.requirements],
    ["job.preferredQualifications", input.job.preferredQualifications]
  ] as const) {
    (values ?? []).forEach((requirement, index) => {
      if (typeof requirement !== "string" || !requirement.trim()) return;
      const parsed = parseDetailed(requirement);
      if (!parsed) return;
      const tenure = assess(input, parsed, roles, options.asOf);
      if (!tenure) return;
      gaps.push({ requirement, jobRequirement: { ref: `${prefix}[${index}]`, excerpt: requirement }, tenure });
    });
  }
  return gaps;
}
