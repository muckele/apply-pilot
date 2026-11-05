import { z } from "zod";

import { PublicApiError } from "@/lib/api-errors";
import {
  validateRestoredResumeClaimEvidence,
  type ApplicationDocumentClaimEvidence,
  type ApplicationDocumentPayload
} from "@/lib/ai/application-document-claims";
import {
  applicationDocumentAtomicStrings,
  buildApplicationDocumentFactCatalog,
  normalizeApplicationDocumentSourceLine,
  type ApplicationDocumentFact
} from "@/lib/ai/application-document-facts";
import { applicationDocumentPriorityOpportunities } from "@/lib/ai/application-document-priorities";
import { protectedResumeCitations } from "@/lib/ai/resume-tailoring-payload";

// Owner-approved tailoring rule (2026-11-05): a tailored résumé may trim extras but always keeps
// every job. Always kept: identity/contact header lines, the summary, every work-history record
// header (title, company, dates), every education record and every certification/licence record.
// Skills, achievements, projects and individual bullets may be trimmed down to these floors.
// Anything Gemini omits that the rule requires, or that the job match cited as applicant evidence,
// is restored here verbatim from the master résumé instead of discarding a paid result.
export const TAILORED_RESUME_FLOORS = Object.freeze({ jobBullets: 2, skills: 10, achievements: 2 });

export type TailoredResumeItemKind =
  | "skill"
  | "achievement"
  | "bullet"
  | "record"
  | "line"
  | "owner_attested_fact"
  | "profile_skill";

// One trimmed (left-out) or server-restored item, with paste-ready verbatim source text.
export type TailoredResumeItem = Readonly<{
  ref: string;
  kind: TailoredResumeItemKind;
  context: string | null;
  text: string;
}>;

type ResumeOutput = { resumeText: string; claimEvidence: ApplicationDocumentClaimEvidence[] };

type Section =
  | "SUMMARY" | "SKILLS" | "EXPERIENCE" | "PROJECTS" | "EDUCATION" | "CERTIFICATIONS" | "ACHIEVEMENTS"
  | "ADDITIONAL INFORMATION";
type Placement = Section | "HEADER";
type RecordField = "workHistory" | "projects" | "education" | "certifications";
type UnitKind =
  | "header" | "summary" | "skill" | "achievement" | "record_header" | "bullet" | "other"
  | "owner_attested_fact" | "profile_skill";

type SourceLine = Readonly<{ text: string; key: string; facts: readonly ApplicationDocumentFact[] }>;
type Unit = {
  id: number;
  ref: string;
  kind: UnitKind;
  placement: Placement | null;
  record: SourceRecord | null;
  order: number;
  lines: SourceLine[];
  facts: ApplicationDocumentFact[];
};
type SourceRecord = {
  ref: string;
  field: RecordField;
  order: number;
  headers: Unit[];
  bullets: Unit[];
  leading: Unit[];
};
type SourceModel = {
  factByKey: ReadonlyMap<string, ApplicationDocumentFact>;
  factByCitation: ReadonlyMap<string, ApplicationDocumentFact>;
  units: Unit[];
  records: SourceRecord[];
  sectionOrder: Section[];
  requiredSections: Section[];
  sourceLineKeys: ReadonlySet<string>;
  bulletedSourceLines: ReadonlySet<string>;
};

const RECORD_FIELDS: readonly RecordField[] = ["workHistory", "projects", "education", "certifications"];
const RECORD_SECTION: Record<RecordField, Section> = {
  workHistory: "EXPERIENCE",
  projects: "PROJECTS",
  education: "EDUCATION",
  certifications: "CERTIFICATIONS"
};
const DEFAULT_SECTION_ORDER: readonly Section[] = [
  "SUMMARY", "SKILLS", "EXPERIENCE", "PROJECTS", "EDUCATION", "CERTIFICATIONS", "ACHIEVEMENTS", "ADDITIONAL INFORMATION"
];
const headingPattern =
  /^(?:SUMMARY|PROFILE|SKILLS|EXPERIENCE|WORK EXPERIENCE|PROJECTS|EDUCATION|CERTIFICATIONS|ACHIEVEMENTS|ADDITIONAL(?: INFORMATION)?)$/iu;
const markerPattern = /^([-*•▪◦–—])\s+/u;

function sectionOf(line: string): Section | null {
  const value = line.trim().toLocaleUpperCase();
  if (!headingPattern.test(value)) return null;
  if (value === "PROFILE") return "SUMMARY";
  if (value === "WORK EXPERIENCE") return "EXPERIENCE";
  if (value === "ADDITIONAL") return "ADDITIONAL INFORMATION";
  return value as Section;
}

// The catalog's own de-duplication key, and the same key for a rendered (possibly bulleted) line.
function factKey(value: string) {
  return value.trim().replace(/\s+/gu, " ").toLocaleLowerCase();
}
function lineKey(value: string) {
  return factKey(normalizeApplicationDocumentSourceLine(value));
}

// Whole-word, case- and spacing-insensitive containment: the completeness semantics the
// quality validator has always used, so SQL is never "present" inside PostgreSQL.
function comparable(value: string) {
  return value.trim().replace(/^[-*•▪◦–—]\s+/u, "").replace(/\s+/gu, " ").toLocaleLowerCase();
}
function escapeRegularExpression(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
function containsNormalized(normalizedHaystack: string, value: string) {
  const normalizedValue = comparable(value);
  if (!normalizedValue) return false;
  const left = /^[\p{L}\p{N}]/u.test(normalizedValue) ? "(?:^|[^\\p{L}\\p{N}])" : "";
  const right = /[\p{L}\p{N}]$/u.test(normalizedValue) ? "(?![\\p{L}\\p{N}])" : "";
  return new RegExp(`${left}${escapeRegularExpression(normalizedValue)}${right}`, "u").test(normalizedHaystack);
}
export function containsComparableText(haystack: string, value: string) {
  return containsNormalized(comparable(haystack), value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function nonblankLines(value: string) {
  return value.split(/\r?\n/u).filter((line) => line.trim());
}
function uniqueFacts(facts: readonly ApplicationDocumentFact[]) {
  const seen = new Set<string>();
  return facts.filter((fact) => !seen.has(fact.factId) && Boolean(seen.add(fact.factId)));
}

export function tailoredResumeSourceHeaderLines(payload: ApplicationDocumentPayload) {
  if (typeof payload.resume?.rawText !== "string") return [];
  const lines: string[] = [];
  for (const rawLine of payload.resume.rawText.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (headingPattern.test(line)) break;
    if (line) lines.push(line);
  }
  return lines.slice(0, 3);
}

function buildSourceModel(payload: ApplicationDocumentPayload): SourceModel {
  const facts = buildApplicationDocumentFactCatalog(payload);
  const factByKey = new Map(facts.map((fact) => [factKey(fact.excerpt), fact]));
  const factByCitation = new Map(facts.map((fact) => [`${fact.ref}\u0000${comparable(fact.excerpt)}`, fact]));
  const factsOf = (text: string) => uniqueFacts(applicationDocumentAtomicStrings(text)
    .flatMap((atom) => factByKey.get(factKey(atom)) ?? []));
  const sourceLine = (text: string): SourceLine => {
    const normalized = normalizeApplicationDocumentSourceLine(text);
    return { text: normalized, key: factKey(normalized), facts: factsOf(text) };
  };
  const units: Unit[] = [];
  const add = (input: Omit<Unit, "id" | "facts">) => {
    const lines = input.lines.filter((line) => line.text && line.facts.length);
    const unitFacts = uniqueFacts(lines.flatMap((line) => line.facts));
    if (!unitFacts.length) return null;
    const unit: Unit = { ...input, lines, facts: unitFacts, id: units.length };
    units.push(unit);
    return unit;
  };

  tailoredResumeSourceHeaderLines(payload).forEach((text, order) => add({
    ref: "resume.rawText", kind: "header", placement: "HEADER", record: null, order, lines: [sourceLine(text)]
  }));
  if (typeof payload.resume?.summary === "string") {
    nonblankLines(payload.resume.summary).forEach((text, order) => add({
      ref: "resume.summary", kind: "summary", placement: "SUMMARY", record: null, order, lines: [sourceLine(text)]
    }));
  }
  for (const [field, kind, placement] of [
    ["skills", "skill", "SKILLS"],
    ["achievements", "achievement", "ACHIEVEMENTS"]
  ] as const) {
    const values = payload.resume?.[field];
    const seen = new Set<string>();
    if (!Array.isArray(values)) continue;
    values.forEach((value, index) => {
      if (typeof value !== "string" || !value.trim()) return;
      const lines = nonblankLines(value).map(sourceLine);
      const key = lines.map((line) => line.key).join("\n");
      if (seen.has(key)) return;
      seen.add(key);
      add({ ref: `resume.${field}[${index}]`, kind, placement, record: null, order: index, lines });
    });
  }

  const records: SourceRecord[] = [];
  for (const field of RECORD_FIELDS) {
    const values = payload.resume?.[field];
    if (!Array.isArray(values)) continue;
    values.forEach((value, index) => {
      if (!isRecord(value)) return;
      const ref = `resume.${field}[${index}]`;
      const record: SourceRecord = { ref, field, order: index, headers: [], bullets: [], leading: [] };
      const detailKey = field === "education" || field === "certifications" ? "details" : "bullets";
      const seenBullets = new Set<string>();
      const bulletLines = (Array.isArray(value[detailKey]) ? value[detailKey] as unknown[] : [])
        .filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
        .map((bullet) => nonblankLines(bullet).map(sourceLine))
        .filter((lines) => {
          const key = lines.map((line) => line.key).join("\n");
          return !seenBullets.has(key) && Boolean(seenBullets.add(key));
        });
      const bulletFactIds = new Set(bulletLines.flat().flatMap((line) => line.facts.map((fact) => fact.factId)));
      const ownedByBullets = (text: string) => {
        const lineFacts = factsOf(text);
        return lineFacts.length > 0 && lineFacts.every((fact) => bulletFactIds.has(fact.factId));
      };
      const headerTexts = typeof value.sourceText === "string" && value.sourceText.trim()
        ? nonblankLines(value.sourceText).filter((text) => !ownedByBullets(text))
        : Object.entries(value)
          .filter(([key]) => key !== "sourceText" && key !== detailKey)
          .flatMap(([, item]) => applicationDocumentAtomicStrings(item))
          .filter((text) => !ownedByBullets(text));
      const seenHeaders = new Set<string>();
      headerTexts.forEach((text, order) => {
        const line = sourceLine(text);
        if (seenHeaders.has(line.key)) return;
        seenHeaders.add(line.key);
        const unit = add({ ref, kind: "record_header", placement: RECORD_SECTION[field], record, order, lines: [line] });
        if (unit) record.headers.push(unit);
      });
      bulletLines.forEach((lines, order) => {
        const unit = add({ ref, kind: "bullet", placement: RECORD_SECTION[field], record, order, lines });
        if (unit) record.bullets.push(unit);
      });
      if (record.headers.length || record.bullets.length) records.push(record);
    });
  }
  for (const opportunity of applicationDocumentPriorityOpportunities(payload)) {
    const record = records.find((candidate) => candidate.ref === opportunity.ref);
    if (!record) continue;
    record.leading = record.bullets.filter((unit) =>
      unit.facts.some((fact) => opportunity.leadingFactIds.includes(fact.factId)));
  }

  const resumeCovered = new Set(units.flatMap((unit) => unit.facts.map((fact) => fact.factId)));
  const unitLineKeys = new Set(units.flatMap((unit) => unit.lines.map((line) => line.key)));
  // Raw-only lines that are not résumé content of their own: unrecognized section headings
  // (e.g. PROFESSIONAL EXPERIENCE) and list lines whose every part is already a parsed item
  // (e.g. "Salesforce, HubSpot, Gong" when each skill is its own record).
  const structuralOrDuplicate = (text: string) => {
    if (/^[\p{Lu}][\p{Lu}\s&/+,-]{1,48}$/u.test(text) && !/\p{Ll}/u.test(text)) return true;
    const parts = text.replace(/^[^:,;|]{1,40}:\s*/u, "").split(/\s*[,;|·•]\s*/u)
      .map((part) => factKey(part.replace(/[.;]+$/u, ""))).filter(Boolean);
    return parts.length >= 2 && parts.every((part) => unitLineKeys.has(part));
  };
  const sourceLineKeys = new Set<string>();
  const bulletedSourceLines = new Set<string>();
  const sourceHeadings: Section[] = [];
  if (typeof payload.resume?.rawText === "string") {
    let placement: Placement = "HEADER";
    let order = 0;
    const seen = new Set<string>();
    for (const raw of payload.resume.rawText.split(/\r?\n/u)) {
      const heading = sectionOf(raw);
      if (heading) {
        placement = heading;
        if (!sourceHeadings.includes(heading)) sourceHeadings.push(heading);
        continue;
      }
      if (!raw.trim()) continue;
      const line = sourceLine(raw);
      sourceLineKeys.add(line.key);
      if (markerPattern.test(raw.trim())) bulletedSourceLines.add(line.key);
      if (!line.facts.length || line.facts.every((fact) => resumeCovered.has(fact.factId)) || seen.has(line.key) ||
        structuralOrDuplicate(line.text)) continue;
      seen.add(line.key);
      add({ ref: "resume.rawText", kind: "other", placement, record: null, order: order++, lines: [line] });
    }
  }

  const applicantCovered = new Set(units.flatMap((unit) => unit.facts.map((fact) => fact.factId)));
  const reviewedFacts = payload.reviewedEvidence?.facts;
  if (Array.isArray(reviewedFacts)) {
    reviewedFacts.forEach((value, index) => {
      if (!isRecord(value) || typeof value.fact !== "string") return;
      const lines = nonblankLines(value.fact).map(sourceLine);
      if (lines.flatMap((line) => line.facts).every((fact) => applicantCovered.has(fact.factId))) return;
      const unit = add({
        ref: `reviewedEvidence.facts[${index}].fact`, kind: "owner_attested_fact", placement: null, record: null, order: index, lines
      });
      unit?.facts.forEach((fact) => applicantCovered.add(fact.factId));
    });
  }
  const profileSkills = payload.profile?.skillsToEmphasize;
  if (Array.isArray(profileSkills)) {
    profileSkills.forEach((value, index) => {
      if (typeof value !== "string" || !value.trim()) return;
      const lines = nonblankLines(value).map(sourceLine);
      if (lines.flatMap((line) => line.facts).every((fact) => applicantCovered.has(fact.factId))) return;
      const unit = add({
        ref: `profile.skillsToEmphasize[${index}]`, kind: "profile_skill", placement: null, record: null, order: index, lines
      });
      unit?.facts.forEach((fact) => applicantCovered.add(fact.factId));
    });
  }

  const hasUnits = (kind: UnitKind) => units.some((unit) => unit.kind === kind);
  const hasRecords = (field: RecordField) => records.some((record) => record.field === field);
  const requiredContent: Array<[Section, boolean]> = [
    ["SUMMARY", hasUnits("summary")],
    ["SKILLS", hasUnits("skill")],
    ["EXPERIENCE", hasRecords("workHistory")],
    ["EDUCATION", hasRecords("education")],
    ["CERTIFICATIONS", hasRecords("certifications")],
    ["ACHIEVEMENTS", hasUnits("achievement")]
  ];
  return {
    factByKey,
    factByCitation,
    units,
    records,
    sectionOrder: [...sourceHeadings, ...DEFAULT_SECTION_ORDER.filter((section) => !sourceHeadings.includes(section))],
    requiredSections: requiredContent.flatMap(([section, present]) =>
      present && sourceHeadings.includes(section) ? [section] : []),
    sourceLineKeys,
    bulletedSourceLines
  };
}

type Inclusion = Readonly<{
  included(fact: ApplicationDocumentFact): boolean;
  full(unit: Unit): boolean;
  touched(unit: Unit): boolean;
}>;

// A fact is in the document when its exact excerpt appears (whole words) or when a claim that
// appears in the document cites it. These are the completeness semantics of the previous validator.
function inclusion(output: ResumeOutput): Inclusion {
  const haystack = comparable(output.resumeText);
  const cited = new Set(output.claimEvidence
    .filter((entry) => containsNormalized(haystack, entry.claim))
    .flatMap((entry) => entry.citations.map((citation) => `${citation.ref}\u0000${comparable(citation.excerpt)}`)));
  const cache = new Map<string, boolean>();
  const included = (fact: ApplicationDocumentFact) => {
    let value = cache.get(fact.factId);
    if (value === undefined) {
      value = containsNormalized(haystack, fact.excerpt) || cited.has(`${fact.ref}\u0000${comparable(fact.excerpt)}`);
      cache.set(fact.factId, value);
    }
    return value;
  };
  return {
    included,
    full: (unit) => unit.facts.every(included),
    touched: (unit) => unit.facts.some(included)
  };
}

function protectedUnits(model: SourceModel, payload: ApplicationDocumentPayload) {
  const citations = protectedResumeCitations(isRecord(payload.protectedEvidence) ? payload.protectedEvidence.citations : null);
  const resumeUnits = model.units.filter((unit) => unit.ref.startsWith("resume."));
  const selected = new Set<Unit>();
  for (const { ref, excerpt } of citations) {
    const target = comparable(excerpt);
    const pool = ref === "resume.rawText" ? resumeUnits : resumeUnits.filter((unit) => unit.ref === ref);
    if (!target || !pool.length) continue;
    const exact = pool.filter((unit) => unit.lines.some((line) => comparable(line.text) === target));
    const within = pool.filter((unit) => unit.lines.some((line) => containsComparableText(excerpt, line.text)));
    const containing = pool.filter((unit) => unit.lines.some((line) => containsComparableText(line.text, excerpt)));
    const chosen = exact.length ? exact : within.length ? within
      : ref === "resume.rawText" ? containing.slice(0, 1) : containing;
    for (const unit of chosen) selected.add(unit);
  }
  return selected;
}

// Fact IDs Gemini must keep because the job's current match analysis cited them as applicant evidence.
export function tailoredResumeProtectedFactIds(payload: ApplicationDocumentPayload) {
  const model = buildSourceModel(payload);
  const selected = protectedUnits(model, payload);
  return uniqueFacts(model.units.filter((unit) => selected.has(unit)).flatMap((unit) => unit.facts))
    .map((fact) => fact.factId);
}

function itemKind(unit: Unit): TailoredResumeItemKind {
  switch (unit.kind) {
    case "skill": return "skill";
    case "achievement": return "achievement";
    case "bullet": return "bullet";
    case "owner_attested_fact": return "owner_attested_fact";
    case "profile_skill": return "profile_skill";
    default: return "line";
  }
}
function recordContext(record: SourceRecord | null) {
  return record?.headers[0]?.lines[0]?.text ?? null;
}
// Restored lines keep the master résumé's own formatting: bulleted there, bulleted here.
function sourceBulleted(model: SourceModel, unit: Unit) {
  const key = unit.lines[0]?.key ?? "";
  return model.sourceLineKeys.has(key) ? model.bulletedSourceLines.has(key) : unit.kind === "bullet";
}
function recordText(model: SourceModel, record: SourceRecord, bullets = record.bullets) {
  return [
    ...record.headers.map((unit) => unit.lines.map((line) => line.text).join(" ")),
    ...bullets.map((unit) => `${sourceBulleted(model, unit) ? "• " : ""}${unit.lines.map((line) => line.text).join(" ")}`)
  ].join("\n");
}
function unitItem(unit: Unit, facts: "all" | readonly ApplicationDocumentFact[]): TailoredResumeItem {
  return {
    ref: unit.ref,
    kind: itemKind(unit),
    context: unit.record ? recordContext(unit.record) : null,
    text: facts === "all"
      ? unit.lines.map((line) => line.text).join(" ")
      : facts.map((fact) => fact.excerpt).join(" ")
  };
}

// Mutable rendering of the tailored résumé text plus the claim evidence that backs each line.
class ResumeDraft {
  lines: string[];
  readonly evidence: ApplicationDocumentClaimEvidence[];
  readonly added: ApplicationDocumentClaimEvidence[] = [];
  private readonly claimFacts = new Map<string, Set<string>>();
  private readonly evidenceKeys = new Set<string>();
  private lineIds: Array<Set<string>> | null = null;

  constructor(private readonly model: SourceModel, output: ResumeOutput) {
    this.lines = output.resumeText.split(/\r?\n/u);
    this.evidence = [...output.claimEvidence];
    for (const entry of output.claimEvidence) this.note(entry);
  }

  private note(entry: ApplicationDocumentClaimEvidence) {
    const key = lineKey(entry.claim);
    const ids = this.claimFacts.get(key) ?? new Set<string>();
    for (const citation of entry.citations) {
      this.evidenceKeys.add(`${comparable(entry.claim)}\u0000${citation.ref}\u0000${citation.excerpt}`);
      const fact = this.model.factByCitation.get(`${citation.ref}\u0000${comparable(citation.excerpt)}`);
      if (fact) ids.add(fact.factId);
    }
    this.claimFacts.set(key, ids);
  }

  private factIds(index: number) {
    if (!this.lineIds) {
      this.lineIds = this.lines.map((line) => {
        const key = lineKey(line);
        const ids = new Set(this.claimFacts.get(key) ?? []);
        const direct = this.model.factByKey.get(key);
        if (direct) ids.add(direct.factId);
        return ids;
      });
    }
    return this.lineIds[index] ?? new Set<string>();
  }

  matches(index: number, unit: Unit) {
    const key = lineKey(this.lines[index] ?? "");
    if (!key) return false;
    if (unit.lines.some((line) => line.key === key)) return true;
    const ids = this.factIds(index);
    return unit.facts.some((fact) => ids.has(fact.factId));
  }

  find(unit: Unit, start = 0, end = this.lines.length) {
    for (let index = start; index < end; index += 1) if (this.matches(index, unit)) return index;
    return -1;
  }

  headingIndex(section: Section) {
    return this.lines.findIndex((line) => sectionOf(line) === section);
  }

  sectionRange(section: Placement) {
    if (section === "HEADER") {
      const first = this.lines.findIndex((line) => sectionOf(line) !== null);
      return { start: 0, end: first < 0 ? this.lines.length : first };
    }
    const heading = this.headingIndex(section);
    if (heading < 0) return null;
    let end = heading + 1;
    while (end < this.lines.length && !sectionOf(this.lines[end]!)) end += 1;
    return { start: heading + 1, end };
  }

  contentEnd(start: number, end: number) {
    let index = end;
    while (index > start && !this.lines[index - 1]!.trim()) index -= 1;
    return index;
  }

  marker(start: number, end: number) {
    for (const range of [[start, end], [0, this.lines.length]] as const) {
      for (let index = range[0]; index < range[1]; index += 1) {
        const match = this.lines[index]!.trim().match(markerPattern);
        if (match) return match[1]!;
      }
    }
    return "•";
  }

  insert(index: number, rendered: ReadonlyArray<{ text: string; facts: readonly ApplicationDocumentFact[] } | "">) {
    this.lines.splice(index, 0, ...rendered.map((line) => line === "" ? "" : line.text));
    for (const line of rendered) {
      if (line === "") continue;
      for (const fact of line.facts) {
        const entry = { claim: fact.excerpt, citations: [{ ref: fact.ref, excerpt: fact.excerpt }] };
        const key = `${comparable(entry.claim)}\u0000${fact.ref}\u0000${fact.excerpt}`;
        if (this.evidenceKeys.has(key)) continue;
        this.evidence.push(entry);
        this.added.push(entry);
        this.note(entry);
      }
    }
    this.lineIds = null;
  }

  ensureSection(section: Placement) {
    const existing = this.sectionRange(section);
    if (existing) return existing;
    const target = section as Section;
    const rank = this.model.sectionOrder.indexOf(target);
    const next = this.lines.findIndex((line) => {
      const candidate = sectionOf(line);
      return candidate !== null && this.model.sectionOrder.indexOf(candidate) > rank;
    });
    if (next < 0) {
      const tail = this.contentEnd(0, this.lines.length);
      this.lines.splice(tail, this.lines.length - tail, ...(tail > 0 ? [""] : []), target);
    } else {
      this.lines.splice(next, 0, ...(next > 0 && this.lines[next - 1]!.trim() ? [""] : []), target, "");
    }
    this.lineIds = null;
    return this.sectionRange(target)!;
  }

  otherRecordHeaderAt(index: number, record: SourceRecord) {
    return this.model.records.some((candidate) => candidate !== record &&
      candidate.headers.some((unit) => this.matches(index, unit)));
  }

  recordBlock(record: SourceRecord) {
    let anchor = -1;
    for (let index = 0; index < this.lines.length && anchor < 0; index += 1) {
      if (record.headers.some((unit) => this.matches(index, unit))) anchor = index;
    }
    if (anchor < 0) return null;
    let end = anchor + 1;
    while (end < this.lines.length && !sectionOf(this.lines[end]!) && !this.otherRecordHeaderAt(end, record)) end += 1;
    let headerEnd = anchor + 1;
    while (headerEnd < end && record.headers.some((unit) => this.matches(headerEnd, unit))) headerEnd += 1;
    return { anchor, headerEnd, end };
  }

  firstRecordLine(record: SourceRecord) {
    for (let index = 0; index < this.lines.length; index += 1) {
      if ([...record.headers, ...record.bullets].some((unit) => this.matches(index, unit))) return index;
    }
    return -1;
  }
}

type RestorePlan = Map<Unit, "all" | readonly ApplicationDocumentFact[]>;

function planRestoration(model: SourceModel, payload: ApplicationDocumentPayload, inc: Inclusion) {
  const plan: RestorePlan = new Map();
  const wholeRecords = new Set<SourceRecord>();
  const leadingRestores = new Set<Unit>();
  const protectedSet = protectedUnits(model, payload);
  const restore = (unit: Unit) => {
    if (plan.has(unit) || inc.full(unit)) return;
    plan.set(unit, inc.touched(unit) ? unit.facts.filter((fact) => !inc.included(fact)) : "all");
  };
  const willHave = (unit: Unit) => plan.has(unit) || inc.touched(unit);
  const fillFloor = (units: Unit[], floor: number) => {
    let missing = Math.min(floor, units.length) - units.filter(willHave).length;
    for (const unit of units) {
      if (missing <= 0) break;
      if (!willHave(unit)) {
        restore(unit);
        missing -= 1;
      }
    }
  };

  for (const unit of model.units) if (unit.kind === "header" || unit.kind === "summary") restore(unit);
  for (const record of model.records) {
    const all = [...record.headers, ...record.bullets];
    const required = record.field !== "projects";
    const protectedHere = all.filter((unit) => protectedSet.has(unit));
    if (!all.some(inc.touched)) {
      if (!required && !protectedHere.length) continue;
      wholeRecords.add(record);
      for (const unit of all) plan.set(unit, "all");
      continue;
    }
    if (required) record.headers.forEach(restore);
    else if (record.headers.length && !record.headers.some(inc.touched)) restore(record.headers[0]!);
    protectedHere.forEach(restore);
    if (record.field === "education" || record.field === "certifications") record.bullets.forEach(restore);
    // Within-record job priority: when every leading fact was dropped, the first one returns
    // at the top of that record so the existing ordering rule can still be met.
    const leadingNeeded = record.leading.length > 0 && !record.leading.some(willHave) &&
      (record.field === "workHistory" ? record.bullets.length > 0 : record.bullets.some(willHave));
    if (leadingNeeded) {
      restore(record.leading[0]!);
      leadingRestores.add(record.leading[0]!);
    }
    if (record.field === "workHistory") fillFloor(record.bullets, TAILORED_RESUME_FLOORS.jobBullets);
  }
  for (const unit of model.units) {
    if (protectedSet.has(unit) && !unit.record) restore(unit);
  }
  fillFloor(model.units.filter((unit) => unit.kind === "skill"), TAILORED_RESUME_FLOORS.skills);
  fillFloor(model.units.filter((unit) => unit.kind === "achievement"), TAILORED_RESUME_FLOORS.achievements);
  return { plan, wholeRecords, leadingRestores };
}

function ensureRequiredHeadings(model: SourceModel, draft: ResumeDraft) {
  for (const section of model.requiredSections) {
    if (draft.headingIndex(section) >= 0) continue;
    const owners = model.units.filter((unit) => unit.placement === section && unit.kind !== "other");
    let first = -1;
    for (let index = 0; index < draft.lines.length && first < 0; index += 1) {
      if (owners.some((unit) => draft.matches(index, unit))) first = index;
    }
    if (first < 0) continue;
    draft.insert(first, first > 0 && draft.lines[first - 1]!.trim() ? ["", { text: section, facts: [] }] : [{ text: section, facts: [] }]);
  }
}

function renderUnit(model: SourceModel, draft: ResumeDraft, unit: Unit, facts: "all" | readonly ApplicationDocumentFact[], range: { start: number; end: number }) {
  const prefix = sourceBulleted(model, unit) ? `${draft.marker(range.start, range.end)} ` : "";
  return facts === "all"
    ? unit.lines.map((line) => ({ text: `${prefix}${line.text}`, facts: line.facts }))
    : facts.map((fact) => ({ text: `${prefix}${fact.excerpt}`, facts: [fact] }));
}

function insertWholeRecord(model: SourceModel, draft: ResumeDraft, record: SourceRecord) {
  const range = draft.ensureSection(RECORD_SECTION[record.field]);
  const siblings = model.records.filter((candidate) => candidate.field === record.field && candidate !== record);
  const anchors = siblings.map((candidate) => ({ candidate, at: draft.recordBlock(candidate)?.anchor ?? -1 }))
    .filter(({ at }) => at >= range.start && at < range.end);
  const separated = anchors.some(({ at }) => at > range.start && !draft.lines[at - 1]!.trim());
  const leading = record.leading[0];
  const bullets = leading ? [leading, ...record.bullets.filter((unit) => unit !== leading)] : record.bullets;
  const rendered = [...record.headers, ...bullets].flatMap((unit) => renderUnit(model, draft, unit, "all", range));
  const next = anchors.filter(({ candidate }) => candidate.order > record.order).sort((a, b) => a.candidate.order - b.candidate.order)[0];
  if (next) {
    draft.insert(next.at, separated ? [...rendered, ""] : rendered);
  } else {
    const at = draft.contentEnd(range.start, range.end);
    draft.insert(at, separated && at > range.start ? ["", ...rendered] : rendered);
  }
  return [...record.headers, ...bullets];
}

function insertRecordUnit(model: SourceModel, draft: ResumeDraft, unit: Unit, facts: "all" | readonly ApplicationDocumentFact[], leading: boolean) {
  const record = unit.record!;
  const block = draft.recordBlock(record);
  if (unit.kind === "record_header") {
    if (!block) {
      // Bullets kept without their header: the header returns directly above them.
      const first = draft.firstRecordLine(record);
      const section = first >= 0 ? null : draft.ensureSection(RECORD_SECTION[record.field]);
      const at = section ? draft.contentEnd(section.start, section.end) : first;
      draft.insert(at, renderUnit(model, draft, unit, facts, { start: at, end: at }));
      return;
    }
    const later = record.headers.filter((candidate) => candidate.order > unit.order)
      .map((candidate) => draft.find(candidate, block.anchor, block.end)).filter((at) => at >= 0);
    const at = later.length ? Math.min(...later) : block.headerEnd;
    draft.insert(at, renderUnit(model, draft, unit, facts, { start: block.anchor, end: block.end }));
    return;
  }
  if (!block) {
    // A required header is always restored before its bullets; this is only a defensive fallback.
    const range = draft.ensureSection(RECORD_SECTION[record.field]);
    draft.insert(draft.contentEnd(range.start, range.end), renderUnit(model, draft, unit, facts, range));
    return;
  }
  const range = { start: block.headerEnd, end: block.end };
  let at = draft.contentEnd(range.start, range.end);
  if (leading) {
    at = block.headerEnd;
  } else if (!record.leading.length) {
    const later = record.bullets.filter((candidate) => candidate.order > unit.order)
      .map((candidate) => draft.find(candidate, range.start, range.end)).filter((index) => index >= 0);
    if (later.length) at = Math.min(...later);
  }
  draft.insert(at, renderUnit(model, draft, unit, facts, range));
}

function insertSectionUnit(model: SourceModel, draft: ResumeDraft, unit: Unit, facts: "all" | readonly ApplicationDocumentFact[]) {
  const placement = unit.placement ?? "ADDITIONAL INFORMATION";
  const range = draft.ensureSection(placement);
  const later = model.units.filter((candidate) => candidate.kind === unit.kind && candidate.placement === placement &&
    candidate.order > unit.order).map((candidate) => draft.find(candidate, range.start, range.end)).filter((at) => at >= 0);
  const at = later.length ? Math.min(...later) : draft.contentEnd(range.start, range.end);
  const rendered = renderUnit(model, draft, unit, facts, range);
  const needsGap = placement === "HEADER" && at === range.end && at < draft.lines.length && sectionOf(draft.lines[at]!) !== null &&
    (at === 0 || draft.lines[at - 1]!.trim() !== "");
  draft.insert(at, needsGap ? [...rendered, ""] : rendered);
}

const restorations = new WeakMap<object, readonly TailoredResumeItem[]>();

// Items the server restored verbatim into this exact output (empty when nothing was restored,
// including validated-cache replays of an already completed résumé).
export function tailoredResumeRestorations(output: object): readonly TailoredResumeItem[] {
  return restorations.get(output) ?? [];
}

// Deterministically restores every omitted required, protected or below-floor item, verbatim from
// the master résumé, with exact claim evidence. Returns the same object when nothing is missing.
export function completeTailoredResume<T extends ResumeOutput>(payload: ApplicationDocumentPayload, output: T): T {
  const model = buildSourceModel(payload);
  const inc = inclusion(output);
  const { plan, wholeRecords, leadingRestores } = planRestoration(model, payload, inc);
  const draft = new ResumeDraft(model, output);
  ensureRequiredHeadings(model, draft);
  if (!plan.size && !draft.added.length && draft.lines.join("\n") === output.resumeText) return output;

  const items: Array<{ id: number; item: TailoredResumeItem }> = [];
  const done = new Set<Unit>();
  for (const unit of model.units) {
    const facts = plan.get(unit);
    if (!facts || done.has(unit)) continue;
    if (unit.record && wholeRecords.has(unit.record)) {
      const inserted = insertWholeRecord(model, draft, unit.record);
      inserted.forEach((member) => done.add(member));
      items.push({ id: unit.id, item: { ref: unit.record.ref, kind: "record", context: null, text: recordText(model, unit.record, inserted.filter((member) => member.kind === "bullet")) } });
      continue;
    }
    done.add(unit);
    if (unit.record) insertRecordUnit(model, draft, unit, facts, leadingRestores.has(unit));
    else insertSectionUnit(model, draft, unit, facts);
    items.push({ id: unit.id, item: unitItem(unit, facts) });
  }

  if (draft.added.length) validateRestoredResumeClaimEvidence(payload, draft.added);
  const completed: T = { ...output, resumeText: draft.lines.join("\n"), claimEvidence: draft.evidence };
  const skillsSection = (output as { skillsSection?: unknown }).skillsSection;
  if (Array.isArray(skillsSection)) {
    const restoredSkills = model.units.filter((unit) => unit.kind === "skill" && plan.get(unit) === "all" &&
      unit.lines.length === 1 && unit.facts.length === 1 && unit.lines[0]!.key === factKey(unit.facts[0]!.excerpt))
      .map((unit) => unit.facts[0]!.excerpt)
      .filter((skill) => !skillsSection.some((existing) => typeof existing === "string" && factKey(existing) === factKey(skill)));
    (completed as { skillsSection?: unknown }).skillsSection = [...skillsSection, ...restoredSkills];
  }
  restorations.set(completed, Object.freeze(items.sort((a, b) => a.id - b.id).map(({ item }) => Object.freeze(item))));
  return completed;
}

function incomplete(fieldPath: string, message: string): never {
  throw new PublicApiError(message, 422, {
    code: "APPLICATION_DOCUMENT_INCOMPLETE",
    fieldPath,
    retryable: false
  });
}

// The keep rule as a check. After completeTailoredResume this only fails on an internal defect.
export function assertTailoredResumeKeepRule(payload: ApplicationDocumentPayload, output: ResumeOutput) {
  const model = buildSourceModel(payload);
  const inc = inclusion(output);
  const protectedSet = protectedUnits(model, payload);
  for (const unit of model.units) {
    if (unit.kind === "header" && !inc.full(unit)) {
      incomplete(`resume.rawText.header[${unit.order}]`, "Tailored resume omitted source identity or contact context.");
    }
    if (unit.kind === "summary" && !inc.full(unit)) incomplete("resume.summary", "Tailored resume omitted the source summary.");
  }
  for (const record of model.records) {
    const all = [...record.headers, ...record.bullets];
    if (record.field === "projects") {
      if (all.some(inc.touched) && record.headers.length && !record.headers.some(inc.touched)) {
        incomplete(record.ref, "Tailored resume kept project content without its project header.");
      }
      continue;
    }
    const required = record.field === "workHistory" ? record.headers : all;
    if (!required.every(inc.full)) incomplete(record.ref, "Tailored resume omitted a required source record.");
    if (record.field === "workHistory" &&
      record.bullets.filter(inc.touched).length < Math.min(TAILORED_RESUME_FLOORS.jobBullets, record.bullets.length)) {
      incomplete(record.ref, "Tailored resume trimmed a job below its bullet floor.");
    }
  }
  for (const [kind, floor, fieldPath] of [
    ["skill", TAILORED_RESUME_FLOORS.skills, "resume.skills"],
    ["achievement", TAILORED_RESUME_FLOORS.achievements, "resume.achievements"]
  ] as const) {
    const units = model.units.filter((unit) => unit.kind === kind);
    if (units.filter(inc.touched).length < Math.min(floor, units.length)) {
      incomplete(fieldPath, `Tailored resume trimmed ${kind === "skill" ? "skills" : "achievements"} below the floor.`);
    }
  }
  for (const unit of model.units) {
    if (protectedSet.has(unit) && !inc.full(unit)) {
      incomplete(unit.ref, "Tailored resume omitted a résumé item cited by the job match.");
    }
  }
  const headings = new Set(output.resumeText.split(/\r?\n/u).flatMap((line) => sectionOf(line) ?? []));
  for (const section of model.requiredSections) {
    if (!headings.has(section)) incomplete("resumeText", `Tailored resume omitted the ${section} source section.`);
  }
}

// Catalog items the final tailored résumé does not include, as paste-ready verbatim source text.
export function tailoredResumeLeftOut(payload: ApplicationDocumentPayload, output: ResumeOutput): TailoredResumeItem[] {
  const model = buildSourceModel(payload);
  const inc = inclusion(output);
  const items: TailoredResumeItem[] = [];
  const handled = new Set<SourceRecord>();
  const missing = (unit: Unit) => inc.touched(unit) ? unit.facts.filter((fact) => !inc.included(fact)) : "all" as const;
  for (const unit of model.units) {
    const record = unit.record;
    if (record) {
      if (handled.has(record)) continue;
      handled.add(record);
      const all = [...record.headers, ...record.bullets];
      if (!all.some(inc.touched)) {
        items.push({ ref: record.ref, kind: "record", context: null, text: recordText(model, record) });
        continue;
      }
      for (const member of all) if (!inc.full(member)) items.push(unitItem(member, missing(member)));
      continue;
    }
    if (!inc.full(unit)) items.push(unitItem(unit, missing(unit)));
  }
  return items;
}

const storedItemSchema = z.object({
  ref: z.string().min(1).max(200),
  kind: z.enum(["skill", "achievement", "bullet", "record", "line", "owner_attested_fact", "profile_skill"]),
  context: z.string().max(2_000).nullable().default(null),
  text: z.string().min(1).max(20_000)
});

// Reads the left-out list stored with a ResumeVersion's metadata JSON; malformed entries are skipped.
export function readTailoredResumeLeftOut(metadata: unknown): TailoredResumeItem[] {
  if (!isRecord(metadata) || !Array.isArray(metadata.leftOut)) return [];
  return metadata.leftOut.flatMap((value) => {
    const parsed = storedItemSchema.safeParse(value);
    return parsed.success ? [parsed.data] : [];
  });
}
