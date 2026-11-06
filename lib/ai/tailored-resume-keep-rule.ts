import { z } from "zod";

import { PublicApiError } from "@/lib/api-errors";
import {
  unverifiedTailoredResumeClaims,
  validateRestoredResumeClaimEvidence,
  type ApplicationDocumentClaimEvidence,
  type ApplicationDocumentPayload
} from "@/lib/ai/application-document-claims";
import {
  applicationDocumentAtomicStrings,
  applicationDocumentSectionOf,
  buildApplicationDocumentFactCatalog,
  normalizeApplicationDocumentSourceLine,
  type ApplicationDocumentFact,
  type ApplicationDocumentSection
} from "@/lib/ai/application-document-facts";
import { applicationDocumentPriorityOpportunities } from "@/lib/ai/application-document-priorities";
import { protectedResumeCitations } from "@/lib/ai/resume-tailoring-payload";

// Owner-approved tailoring rule (2026-11-05): a tailored résumé may trim extras but always keeps
// every job.
// - Always kept: identity/contact header lines, the summary, every work-history record header
//   (title, company, dates), every education record and every certification/licence record.
// - May be trimmed: skills, achievements, projects and bullets, down to the floors below.
// - Protected: résumé items the job match cited, every owner-attested fact saved for this job,
//   and skills whose words all appear in the job's requirements.
// - Whole items only: a kept bullet, achievement, summary line or skill is its complete source
//   item (reworded faithfully or verbatim), never part of an item split at a semicolon or comma.
//   A partial rendering is replaced in place by the complete source line.
// - Source headings are kept: a renamed heading (CERTIFICATIONS for LICENSES) is put back.
// Anything required, protected or below a floor that Gemini omits is restored verbatim from the
// master résumé instead of discarding a paid result.
// Owner decision 2026-11-06: a line whose wording fails the truth check is reverted the same way:
// the line is removed and the source items it cited return verbatim in their own place.
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

type Section = ApplicationDocumentSection;
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
  attachRef: string | null;
};
type SourceRecord = {
  ref: string;
  field: RecordField;
  order: number;
  headers: Unit[];
  bullets: Unit[];
  leading: Unit[];
};
type SkillCategory = Readonly<{ label: string | null; fact: ApplicationDocumentFact | undefined; skills: readonly Unit[] }>;
type SourceModel = {
  factByKey: ReadonlyMap<string, ApplicationDocumentFact>;
  factByCitation: ReadonlyMap<string, ApplicationDocumentFact>;
  units: Unit[];
  records: SourceRecord[];
  sectionOrder: Section[];
  requiredSections: Section[];
  sourceHeadingText: ReadonlyMap<Section, string>;
  sourceLineKeys: ReadonlySet<string>;
  bulletedSourceLines: ReadonlySet<string>;
  ownerKeys: ReadonlyMap<string, readonly Unit[]>;
  skillCategories: readonly SkillCategory[];
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
const markerPattern = /^([-*•▪◦–—])\s+/u;

function sectionOf(line: string): Section | null {
  return applicationDocumentSectionOf(line);
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
// "Label: a, b, c" -> label and lower-cased items (the same parse the rewording list check uses).
function listParts(text: string) {
  const trimmed = normalizeApplicationDocumentSourceLine(text).replace(/[.;]+$/u, "");
  const labelled = trimmed.match(/^([^:,;|]{1,40}):\s*(.+)$/u);
  const items = (labelled ? labelled[2]! : trimmed).split(/\s*[,;|·•]\s*/u).map(factKey).filter(Boolean);
  return { label: labelled ? labelled[1]!.trim() : null, items };
}

export function tailoredResumeSourceHeaderLines(payload: ApplicationDocumentPayload) {
  if (typeof payload.resume?.rawText !== "string") return [];
  const lines: string[] = [];
  for (const rawLine of payload.resume.rawText.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (sectionOf(line)) break;
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
  const add = (input: Omit<Unit, "id" | "facts" | "attachRef"> & { attachRef?: string | null }) => {
    const lines = input.lines.filter((line) => line.text && line.facts.length);
    const unitFacts = uniqueFacts(lines.flatMap((line) => line.facts));
    if (!unitFacts.length) return null;
    const unit: Unit = { ...input, attachRef: input.attachRef ?? null, lines, facts: unitFacts, id: units.length };
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
  const skillsByKey = new Map(units.filter((unit) => unit.kind === "skill" && unit.lines.length === 1)
    .map((unit) => [unit.lines[0]!.key, unit]));
  // Raw-only lines that are not résumé content of their own: unrecognized section headings and
  // list lines whose every part is already a parsed item (e.g. "Sales tools: Salesforce, Gong").
  const structuralOrDuplicate = (text: string) => {
    if (/^[\p{Lu}][\p{Lu}\s&/+,-]{1,48}$/u.test(text) && !/\p{Ll}/u.test(text)) return true;
    const parts = listParts(text).items;
    return parts.length >= 2 && parts.every((part) => unitLineKeys.has(part));
  };
  const sourceLineKeys = new Set<string>();
  const bulletedSourceLines = new Set<string>();
  const sourceHeadings: Section[] = [];
  const headingTexts = new Map<Section, Set<string>>();
  const skillCategories: SkillCategory[] = [];
  if (typeof payload.resume?.rawText === "string") {
    let placement: Placement = "HEADER";
    let order = 0;
    const seen = new Set<string>();
    for (const raw of payload.resume.rawText.split(/\r?\n/u)) {
      const heading = sectionOf(raw);
      if (heading) {
        placement = heading;
        if (!sourceHeadings.includes(heading)) sourceHeadings.push(heading);
        headingTexts.set(heading, (headingTexts.get(heading) ?? new Set()).add(raw.trim()));
        continue;
      }
      if (!raw.trim()) continue;
      const line = sourceLine(raw);
      sourceLineKeys.add(line.key);
      if (markerPattern.test(raw.trim())) bulletedSourceLines.add(line.key);
      if (placement === "SKILLS") {
        const parts = listParts(raw);
        const skills = parts.items.map((item) => skillsByKey.get(item));
        if ((parts.label !== null || skills.length >= 2) && skills.length && skills.every(Boolean)) {
          skillCategories.push({ label: parts.label, fact: factByKey.get(line.key), skills: skills as Unit[] });
        }
      }
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
      const attachRef = typeof value.sourceRef === "string" &&
        records.some((record) => record.ref === value.sourceRef) ? value.sourceRef : null;
      const unit = add({
        ref: `reviewedEvidence.facts[${index}].fact`, kind: "owner_attested_fact", placement: "ADDITIONAL INFORMATION",
        record: null, order: index, lines, attachRef
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

  const ownerKeys = new Map<string, Unit[]>();
  for (const unit of units) {
    for (const line of unit.lines) ownerKeys.set(line.key, [...(ownerKeys.get(line.key) ?? []), unit]);
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
    sourceHeadingText: new Map([...headingTexts].flatMap(([section, texts]) =>
      texts.size === 1 ? [[section, [...texts][0]!] as const] : [])),
    sourceLineKeys,
    bulletedSourceLines,
    ownerKeys,
    skillCategories
  };
}

// A fact is in the document when its exact excerpt appears (whole words) or when a claim that
// appears in the document cites it.
function globallyIncluded(output: ResumeOutput) {
  const haystack = comparable(output.resumeText);
  const cited = new Set(output.claimEvidence
    .filter((entry) => containsNormalized(haystack, entry.claim))
    .flatMap((entry) => entry.citations.map((citation) => `${citation.ref}\u0000${comparable(citation.excerpt)}`)));
  const cache = new Map<string, boolean>();
  return (fact: ApplicationDocumentFact) => {
    let value = cache.get(fact.factId);
    if (value === undefined) {
      value = containsNormalized(haystack, fact.excerpt) || cited.has(`${fact.ref}\u0000${comparable(fact.excerpt)}`);
      cache.set(fact.factId, value);
    }
    return value;
  };
}

const JOB_GENERIC = new Set(
  "a an the and or of to in for on at by with from as is are be experience experienced proven strong skill skills ability knowledge working years year plus preferred required".split(" ")
);
function jobWords(value: string) {
  return value.toLocaleLowerCase().split(/[^\p{L}\p{N}+#]+/u).filter((word) => word && !JOB_GENERIC.has(word))
    .map((word) => word.length > 4 ? word.replace(/(?:ing|ed|es|s)$/u, "") : word);
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
  // Owner-attested facts saved for this job are deliberate additions: always used.
  for (const unit of model.units) if (unit.kind === "owner_attested_fact") selected.add(unit);
  // A skill whose words all appear in the job's requirements is kept.
  const requirements = Array.isArray(payload.job?.requirements)
    ? new Set(payload.job.requirements.flatMap((value) => typeof value === "string" ? jobWords(value) : []))
    : new Set<string>();
  for (const unit of model.units) {
    if (unit.kind !== "skill") continue;
    const words = jobWords(unit.lines.map((line) => line.text).join(" "));
    if (words.length && words.every((word) => requirements.has(word))) selected.add(unit);
  }
  return selected;
}

// Fact IDs Gemini must keep: résumé items the job match cited, owner-attested facts for this job,
// and skills whose words all appear in the job's requirements.
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
function unitText(unit: Unit) {
  return unit.lines.map((line) => line.text).join(" ");
}
function recordText(model: SourceModel, record: SourceRecord, bullets = record.bullets) {
  return [
    ...record.headers.map(unitText),
    ...bullets.map((unit) => `${sourceBulleted(model, unit) ? "• " : ""}${unitText(unit)}`)
  ].join("\n");
}
function unitItem(unit: Unit): TailoredResumeItem {
  return { ref: unit.ref, kind: itemKind(unit), context: unit.record ? recordContext(unit.record) : null, text: unitText(unit) };
}

// Where a unit may be rendered: a skill in SKILLS, an achievement in ACHIEVEMENTS, the summary in
// SUMMARY, contact lines above the first heading, and record content outside those sections.
function inHome(unit: Unit, section: Placement) {
  switch (unit.kind) {
    case "header": return section === "HEADER";
    case "summary": return section === "SUMMARY";
    case "skill": return section === "SKILLS";
    case "achievement": return section === "ACHIEVEMENTS";
    case "record_header":
    case "bullet": return section !== "SUMMARY" && section !== "SKILLS" && section !== "ACHIEVEMENTS";
    default: return true;
  }
}

type RenderedLine = { text: string; facts: readonly ApplicationDocumentFact[]; claim?: ApplicationDocumentClaimEvidence };

// Mutable rendering of the tailored résumé text plus the claim evidence that backs each line.
class ResumeDraft {
  lines: string[];
  readonly evidence: ApplicationDocumentClaimEvidence[];
  readonly added: ApplicationDocumentClaimEvidence[] = [];
  private readonly claimFacts = new Map<string, Set<string>>();
  private readonly evidenceKeys = new Set<string>();
  private cache: { keys: string[]; ids: Array<Set<string>>; sections: Placement[] } | null = null;

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

  private view() {
    if (!this.cache) {
      let section: Placement = "HEADER";
      const keys = this.lines.map(lineKey);
      this.cache = {
        keys,
        ids: keys.map((key) => {
          const ids = new Set(this.claimFacts.get(key) ?? []);
          const direct = this.model.factByKey.get(key);
          if (direct) ids.add(direct.factId);
          return ids;
        }),
        sections: this.lines.map((line) => {
          section = sectionOf(line) ?? section;
          return section;
        })
      };
    }
    return this.cache;
  }

  factIds(index: number) {
    return this.view().ids[index] ?? new Set<string>();
  }

  sectionAt(index: number): Placement {
    return this.view().sections[index] ?? "HEADER";
  }

  // Any line naming this unit (anchor search for records).
  matches(index: number, unit: Unit) {
    const key = this.view().keys[index];
    if (!key) return false;
    if (unit.lines.some((line) => line.key === key)) return true;
    const ids = this.factIds(index);
    return unit.facts.some((fact) => ids.has(fact.factId));
  }

  // A unit's home section; when the document has no heading for that home, anywhere counts.
  private inHomeAt(unit: Unit, index: number) {
    const home = unit.kind === "summary" ? "SUMMARY" : unit.kind === "skill" ? "SKILLS"
      : unit.kind === "achievement" ? "ACHIEVEMENTS" : null;
    if (home && this.headingIndex(home) < 0) return true;
    return inHome(unit, this.sectionAt(index));
  }

  // A line that renders this unit in its home section (verbatim, reworded or as a list item).
  renders(index: number, unit: Unit) {
    const line = this.lines[index] ?? "";
    const key = this.view().keys[index];
    if (!key || sectionOf(line) || !this.inHomeAt(unit, index)) return false;
    if (unit.lines.some((source) => source.key === key)) return true;
    if (this.model.ownerKeys.get(key)?.some((owner) => owner !== unit)) return false;
    const ids = this.factIds(index);
    if (unit.facts.some((fact) => ids.has(fact.factId))) return true;
    return unit.kind === "skill" && unit.lines.length === 1 && listParts(line).items.includes(unit.lines[0]!.key);
  }

  renderedLines(unit: Unit) {
    const out: number[] = [];
    for (let index = 0; index < this.lines.length; index += 1) if (this.renders(index, unit)) out.push(index);
    return out;
  }

  // Every fact of the unit is expressed by the lines that render it there.
  wholeAt(unit: Unit, lines: readonly number[]) {
    return unit.facts.every((fact) => lines.some((index) =>
      this.factIds(index).has(fact.factId) || containsComparableText(this.lines[index] ?? "", fact.excerpt)));
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

  private addEvidence(entry: ApplicationDocumentClaimEvidence) {
    const keys = entry.citations.map((citation) => `${comparable(entry.claim)}\u0000${citation.ref}\u0000${citation.excerpt}`);
    if (keys.every((key) => this.evidenceKeys.has(key))) return;
    this.evidence.push(entry);
    this.added.push(entry);
    this.note(entry);
  }

  insert(index: number, rendered: ReadonlyArray<RenderedLine | "">) {
    this.lines.splice(index, 0, ...rendered.map((line) => line === "" ? "" : line.text));
    for (const line of rendered) {
      if (line === "") continue;
      if (line.claim) this.addEvidence(line.claim);
      for (const fact of line.facts) {
        this.addEvidence({ claim: fact.excerpt, citations: [{ ref: fact.ref, excerpt: fact.excerpt }] });
      }
    }
    this.cache = null;
  }

  remove(indices: readonly number[]) {
    for (const index of [...indices].sort((a, b) => b - a)) this.lines.splice(index, 1);
    this.cache = null;
  }

  replaceText(index: number, text: string) {
    this.lines[index] = text;
    this.cache = null;
  }

  headingText(section: Section) {
    return this.model.sourceHeadingText.get(section) ?? section;
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
      this.lines.splice(tail, this.lines.length - tail, ...(tail > 0 ? [""] : []), this.headingText(target));
    } else {
      this.lines.splice(next, 0, ...(next > 0 && this.lines[next - 1]!.trim() ? [""] : []), this.headingText(target), "");
    }
    this.cache = null;
    return this.sectionRange(target)!;
  }

  otherRecordHeaderAt(index: number, record: SourceRecord) {
    return this.model.records.some((candidate) => candidate !== record &&
      candidate.headers.some((unit) => this.matches(index, unit)));
  }

  recordBlock(record: SourceRecord) {
    let anchor = -1;
    for (let index = 0; index < this.lines.length && anchor < 0; index += 1) {
      if (record.headers.some((unit) => this.renders(index, unit))) anchor = index;
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
      if ([...record.headers, ...record.bullets].some((unit) => this.renders(index, unit))) return index;
    }
    return -1;
  }
}

function renderUnit(model: SourceModel, draft: ResumeDraft, unit: Unit, range: { start: number; end: number }, bulleted = sourceBulleted(model, unit)): RenderedLine[] {
  const prefix = bulleted ? `${draft.marker(range.start, range.end)} ` : "";
  return unit.lines.map((line, index) => ({ text: `${index === 0 ? prefix : ""}${line.text}`, facts: line.facts }));
}

// Puts back the source's own section headings (LICENSES stays LICENSES) and adds a missing
// required heading above its retained content.
function normalizeHeadings(model: SourceModel, draft: ResumeDraft) {
  for (let index = 0; index < draft.lines.length; index += 1) {
    const section = sectionOf(draft.lines[index]!);
    const source = section ? model.sourceHeadingText.get(section) : undefined;
    if (source && draft.lines[index]!.trim() !== source) draft.replaceText(index, source);
  }
  for (const section of model.requiredSections) {
    if (draft.headingIndex(section) >= 0) continue;
    const owners = model.units.filter((unit) => unit.placement === section && unit.kind !== "other" && unit.kind !== "owner_attested_fact");
    let first = -1;
    for (let index = 0; index < draft.lines.length && first < 0; index += 1) {
      if (owners.some((unit) => draft.matches(index, unit))) first = index;
    }
    if (first < 0) continue;
    const text = draft.headingText(section);
    draft.insert(first, first > 0 && draft.lines[first - 1]!.trim() ? ["", { text, facts: [] }] : [{ text, facts: [] }]);
  }
}

type Action = "replace" | "insert";

function planRestoration(
  model: SourceModel,
  payload: ApplicationDocumentPayload,
  draft: ResumeDraft,
  revertedFactIds: ReadonlySet<string>
) {
  const plan = new Map<Unit, Action>();
  const wholeRecords = new Set<SourceRecord>();
  const leadingRestores = new Set<Unit>();
  const protectedSet = protectedUnits(model, payload);
  // Source items behind a reverted line return like protected items: in place, whole and verbatim.
  for (const unit of model.units) {
    if (unit.facts.some((fact) => revertedFactIds.has(fact.factId))) protectedSet.add(unit);
  }
  const rendered = new Map(model.units.map((unit) => [unit, draft.renderedLines(unit)]));
  const isRendered = (unit: Unit) => (rendered.get(unit)?.length ?? 0) > 0;
  const willHave = (unit: Unit) => isRendered(unit) || plan.has(unit);
  const restore = (unit: Unit) => {
    if (plan.has(unit)) return;
    if (!isRendered(unit)) plan.set(unit, "insert");
    else if (!draft.wholeAt(unit, rendered.get(unit)!)) plan.set(unit, "replace");
  };
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

  // Whole items only: anything kept is completed in place.
  for (const unit of model.units) if (isRendered(unit)) restore(unit);
  for (const unit of model.units) if (unit.kind === "header" || unit.kind === "summary") restore(unit);
  for (const record of model.records) {
    const all = [...record.headers, ...record.bullets];
    const required = record.field !== "projects";
    const protectedHere = all.filter((unit) => protectedSet.has(unit));
    if (!all.some(isRendered)) {
      if (!required && !protectedHere.length) continue;
      wholeRecords.add(record);
      for (const unit of all) plan.set(unit, "insert");
      continue;
    }
    if (required) record.headers.forEach(restore);
    else if (record.headers.length && !record.headers.some(isRendered)) restore(record.headers[0]!);
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
  for (const unit of model.units) if (protectedSet.has(unit) && !unit.record) restore(unit);
  fillFloor(model.units.filter((unit) => unit.kind === "skill"), TAILORED_RESUME_FLOORS.skills);
  fillFloor(model.units.filter((unit) => unit.kind === "achievement"), TAILORED_RESUME_FLOORS.achievements);
  return { plan, wholeRecords, leadingRestores };
}

function insertWholeRecord(model: SourceModel, draft: ResumeDraft, record: SourceRecord) {
  const range = draft.ensureSection(RECORD_SECTION[record.field]);
  const siblings = model.records.filter((candidate) => candidate.field === record.field && candidate !== record);
  const anchors = siblings.map((candidate) => ({ candidate, at: draft.recordBlock(candidate)?.anchor ?? -1 }))
    .filter(({ at }) => at >= range.start && at < range.end);
  const separated = anchors.some(({ at }) => at > range.start && !draft.lines[at - 1]!.trim());
  const leading = record.leading[0];
  const bullets = leading ? [leading, ...record.bullets.filter((unit) => unit !== leading)] : record.bullets;
  const rendered = [...record.headers, ...bullets].flatMap((unit) => renderUnit(model, draft, unit, range));
  const next = anchors.filter(({ candidate }) => candidate.order > record.order).sort((a, b) => a.candidate.order - b.candidate.order)[0];
  if (next) {
    draft.insert(next.at, separated ? [...rendered, ""] : rendered);
  } else {
    const at = draft.contentEnd(range.start, range.end);
    draft.insert(at, separated && at > range.start ? ["", ...rendered] : rendered);
  }
  return bullets;
}

// Replaces a partial rendering of a unit with its complete source line, in the same place.
function replaceWhole(model: SourceModel, draft: ResumeDraft, unit: Unit) {
  const lines = draft.renderedLines(unit);
  if (!lines.length) return false;
  const owned = lines.filter((index) => {
    const ids = draft.factIds(index);
    return unit.lines.some((line) => line.key === lineKey(draft.lines[index]!)) ||
      (ids.size > 0 && [...ids].every((id) => unit.facts.some((fact) => fact.factId === id)));
  });
  const first = owned.length ? owned[0]! : lines.at(-1)! + 1;
  const bulleted = owned.length ? markerPattern.test(draft.lines[first]!.trim()) || sourceBulleted(model, unit) : sourceBulleted(model, unit);
  draft.remove(owned);
  draft.insert(first, renderUnit(model, draft, unit, { start: Math.max(0, first - 3), end: first + 3 }, bulleted));
  return true;
}

function insertRecordUnit(model: SourceModel, draft: ResumeDraft, unit: Unit, leading: boolean) {
  const record = unit.record!;
  const block = draft.recordBlock(record);
  if (unit.kind === "record_header") {
    if (!block) {
      // Bullets kept without their header: the header returns directly above them.
      const first = draft.firstRecordLine(record);
      const section = first >= 0 ? null : draft.ensureSection(RECORD_SECTION[record.field]);
      const at = section ? draft.contentEnd(section.start, section.end) : first;
      draft.insert(at, renderUnit(model, draft, unit, { start: at, end: at }));
      return;
    }
    const later = record.headers.filter((candidate) => candidate.order > unit.order)
      .map((candidate) => draft.find(candidate, block.anchor, block.end)).filter((at) => at >= 0);
    const at = later.length ? Math.min(...later) : block.headerEnd;
    draft.insert(at, renderUnit(model, draft, unit, { start: block.anchor, end: block.end }));
    return;
  }
  if (!block) {
    const range = draft.ensureSection(RECORD_SECTION[record.field]);
    draft.insert(draft.contentEnd(range.start, range.end), renderUnit(model, draft, unit, range));
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
  draft.insert(at, renderUnit(model, draft, unit, range));
}

function insertSectionUnit(model: SourceModel, draft: ResumeDraft, unit: Unit) {
  if (unit.attachRef) {
    const record = model.records.find((candidate) => candidate.ref === unit.attachRef);
    const block = record ? draft.recordBlock(record) : null;
    if (block) {
      const at = draft.contentEnd(block.headerEnd, block.end);
      draft.insert(at, renderUnit(model, draft, unit, { start: block.headerEnd, end: block.end }, true));
      return;
    }
  }
  const placement = unit.placement ?? "ADDITIONAL INFORMATION";
  const range = draft.ensureSection(placement);
  const later = model.units.filter((candidate) => candidate.kind === unit.kind && candidate.placement === placement &&
    candidate.order > unit.order).map((candidate) => draft.find(candidate, range.start, range.end)).filter((at) => at >= 0);
  const at = later.length ? Math.min(...later) : draft.contentEnd(range.start, range.end);
  const rendered = renderUnit(model, draft, unit, range);
  const needsGap = placement === "HEADER" && at === range.end && at < draft.lines.length && sectionOf(draft.lines[at]!) !== null &&
    (at === 0 || draft.lines[at - 1]!.trim() !== "");
  draft.insert(at, needsGap ? [...rendered, ""] : rendered);
}

// When the source groups skills ("Sales tools: a, b, c"), the tailored SKILLS section lists the
// kept skills the same way, dropping only trimmed ones. Each line cites its category line and skills.
function regroupSkills(model: SourceModel, draft: ResumeDraft, restoredSkills: ReadonlySet<Unit>) {
  if (!model.skillCategories.length) return;
  const skills = model.units.filter((unit) => unit.kind === "skill");
  const kept = new Set(skills.filter((unit) => restoredSkills.has(unit) || draft.renderedLines(unit).length > 0));
  if (!kept.size) return;
  const grouped = new Set(model.skillCategories.flatMap((category) => category.skills));
  const lines: RenderedLine[] = [];
  for (const category of model.skillCategories) {
    const items = category.skills.filter((unit) => kept.has(unit));
    if (!items.length) continue;
    const label = category.label !== null && category.fact ? category.label : null;
    const text = `${label ? `${label}: ` : ""}${items.map(unitText).join(", ")}`;
    const facts = items.flatMap((unit) => unit.facts);
    const citations = [...(label ? [category.fact!] : []), ...facts].map((fact) => ({ ref: fact.ref, excerpt: fact.excerpt }));
    lines.push({ text, facts, claim: { claim: text, citations } });
  }
  for (const unit of skills) {
    if (kept.has(unit) && !grouped.has(unit)) lines.push({ text: unitText(unit), facts: unit.facts });
  }
  const range = draft.ensureSection("SKILLS");
  const current = [];
  for (let index = range.start; index < range.end; index += 1) {
    if (skills.some((unit) => draft.renders(index, unit))) current.push(index);
  }
  if (current.map((index) => draft.lines[index]!.trim()).join("\n") === lines.map((line) => line.text).join("\n")) return;
  draft.remove(current);
  draft.insert(range.start, lines);
}

const restorations = new WeakMap<object, readonly TailoredResumeItem[]>();

// Items the server restored verbatim into this exact output (empty when nothing was restored,
// including validated-cache replays of an already completed résumé).
export function tailoredResumeRestorations(output: object): readonly TailoredResumeItem[] {
  return restorations.get(output) ?? [];
}

// Deterministically completes the tailored résumé under the keep rule, verbatim from the master
// résumé, with exact claim evidence. Returns the same object when nothing needs changing.
export function completeTailoredResume<T extends ResumeOutput>(
  payload: ApplicationDocumentPayload,
  output: T,
  revertedFactIds: ReadonlySet<string> = new Set()
): T {
  const model = buildSourceModel(payload);
  const draft = new ResumeDraft(model, output);
  normalizeHeadings(model, draft);
  const { plan, wholeRecords, leadingRestores } = planRestoration(model, payload, draft, revertedFactIds);
  if (!plan.size && draft.lines.join("\n") === output.resumeText) {
    regroupSkills(model, draft, new Set());
    if (draft.lines.join("\n") === output.resumeText) return output;
  }

  const regrouping = model.skillCategories.length > 0;
  const restoredSkills = new Set<Unit>();
  const items: Array<{ id: number; item: TailoredResumeItem }> = [];
  const done = new Set<Unit>();
  for (const unit of model.units) {
    const action = plan.get(unit);
    if (!action || done.has(unit)) continue;
    if (unit.record && wholeRecords.has(unit.record)) {
      const bullets = insertWholeRecord(model, draft, unit.record);
      [...unit.record.headers, ...unit.record.bullets].forEach((member) => done.add(member));
      items.push({ id: unit.id, item: { ref: unit.record.ref, kind: "record", context: null, text: recordText(model, unit.record, bullets) } });
      continue;
    }
    done.add(unit);
    if (unit.kind === "skill" && regrouping) {
      if (action === "insert") restoredSkills.add(unit);
      else if (!replaceWhole(model, draft, unit)) restoredSkills.add(unit);
    } else if (action === "replace") {
      if (!replaceWhole(model, draft, unit)) insertSectionUnit(model, draft, unit);
    } else if (unit.record) {
      insertRecordUnit(model, draft, unit, leadingRestores.has(unit));
    } else {
      insertSectionUnit(model, draft, unit);
    }
    items.push({ id: unit.id, item: unitItem(unit) });
  }
  regroupSkills(model, draft, restoredSkills);

  if (draft.added.length) validateRestoredResumeClaimEvidence(payload, draft.added);
  const completed: T = { ...output, resumeText: draft.lines.join("\n"), claimEvidence: draft.evidence };
  const skillsSection = (output as { skillsSection?: unknown }).skillsSection;
  if (Array.isArray(skillsSection)) {
    const restoredSkillTexts = model.units.filter((unit) => unit.kind === "skill" && plan.get(unit) === "insert" &&
      unit.lines.length === 1 && unit.facts.length === 1 && unit.lines[0]!.key === factKey(unit.facts[0]!.excerpt))
      .map((unit) => unit.facts[0]!.excerpt)
      .filter((skill) => !skillsSection.some((existing) => typeof existing === "string" && factKey(existing) === factKey(skill)));
    (completed as { skillsSection?: unknown }).skillsSection = [...skillsSection, ...restoredSkillTexts];
  }
  restorations.set(completed, Object.freeze(items.sort((a, b) => a.id - b.id).map(({ item }) => Object.freeze(item))));
  return completed;
}

// One tailored line whose wording failed the truth check and was replaced by the master résumé's
// own wording: what Gemini wrote, why it failed, and the verbatim source item(s) now in its place.
export type TailoredResumeReversion = Readonly<{
  rejectedText: string;
  reason: string;
  original: readonly TailoredResumeItem[];
}>;

const reversions = new WeakMap<object, readonly TailoredResumeReversion[]>();

// Lines reverted to source wording in this exact output (empty when nothing was reverted,
// including validated-cache replays of an already reverted résumé).
export function tailoredResumeReversions(output: object): readonly TailoredResumeReversion[] {
  return reversions.get(output) ?? [];
}

export function carryTailoredResumeReversions<T extends object>(from: object, to: T): T {
  const items = reversions.get(from);
  if (items && to !== from && !reversions.has(to)) reversions.set(to, items);
  return to;
}

type ProjectedResumeOutput = ResumeOutput & {
  professionalSummary?: unknown;
  skillsSection?: unknown;
  bulletRewrites?: unknown;
  rolesOrProjectsToEmphasize?: unknown;
};

// Removes every rendered line whose wording failed the truth check (a line holding a failed
// semicolon part goes whole), drops the evidence and typed fields that named it, and restores the
// cited source items verbatim through the keep rule. Citation defects are not touched here: the
// unchanged validators that run next still reject them, and still check every remaining line.
export function revertUnverifiedResumeLines<T extends ProjectedResumeOutput>(
  payload: ApplicationDocumentPayload,
  output: T
): T {
  const failures = unverifiedTailoredResumeClaims(payload, output.claimEvidence);
  if (!failures.length) return output;
  const model = buildSourceModel(payload);
  const keysOf = (line: string) => {
    const normalized = normalizeApplicationDocumentSourceLine(line);
    return [normalized, ...normalized.split(/;\s+/u)].map(lineKey).filter(Boolean);
  };
  const failedKeys = new Set(failures.map(({ index }) => lineKey(output.claimEvidence[index]!.claim)));
  const lines = output.resumeText.split(/\r?\n/u);
  const droppedLines = lines.flatMap((line, index) =>
    !sectionOf(line) && keysOf(line).some((key) => failedKeys.has(key)) ? [index] : []);
  const onPage = new Set(droppedLines.flatMap((index) => keysOf(lines[index]!)));
  const dropped = (value: string) => failedKeys.has(lineKey(value)) || onPage.has(lineKey(value));
  const factIdsOf = (entries: readonly ApplicationDocumentClaimEvidence[]) => new Set(entries.flatMap((entry) =>
    entry.citations.flatMap((citation) => {
      const fact = model.factByCitation.get(`${citation.ref}\u0000${comparable(citation.excerpt)}`) ??
        model.factByKey.get(factKey(citation.excerpt));
      return fact ? [fact.factId] : [];
    })));
  const revertedFactIds = factIdsOf(output.claimEvidence.filter((entry) => onPage.has(lineKey(entry.claim))));

  const stripped: T = {
    ...output,
    resumeText: lines.filter((_, index) => !droppedLines.includes(index)).join("\n"),
    claimEvidence: output.claimEvidence.filter((entry) => !dropped(entry.claim))
  };
  const keep = (value: unknown) => typeof value !== "string" || !dropped(value);
  if (typeof output.professionalSummary === "string" && !keep(output.professionalSummary)) stripped.professionalSummary = "";
  if (Array.isArray(output.skillsSection)) stripped.skillsSection = output.skillsSection.filter(keep);
  if (Array.isArray(output.rolesOrProjectsToEmphasize)) stripped.rolesOrProjectsToEmphasize = output.rolesOrProjectsToEmphasize.filter(keep);
  if (Array.isArray(output.bulletRewrites)) {
    stripped.bulletRewrites = output.bulletRewrites.filter((item) => !isRecord(item) || keep(item.rewrite));
  }

  const byLine = new Map<number, { rejectedText: string; reason: string; factIds: Set<string> }>();
  for (const { index, reason } of failures) {
    const entry = output.claimEvidence[index]!;
    const at = droppedLines.find((lineIndex) => keysOf(lines[lineIndex]!).includes(lineKey(entry.claim)));
    if (at === undefined) continue;
    const current = byLine.get(at) ?? { rejectedText: normalizeApplicationDocumentSourceLine(lines[at]!), reason, factIds: new Set<string>() };
    for (const id of factIdsOf([entry])) current.factIds.add(id);
    byLine.set(at, current);
  }
  const completed = completeTailoredResume(payload, stripped, revertedFactIds);
  reversions.set(completed, Object.freeze([...byLine.entries()].sort(([a], [b]) => a - b).map(([, line]) => Object.freeze({
    rejectedText: line.rejectedText,
    reason: line.reason,
    original: Object.freeze(model.units.filter((unit) => unit.facts.some((fact) => line.factIds.has(fact.factId)))
      .map((unit) => Object.freeze(unitItem(unit))))
  }))));
  return completed;
}

const storedReversionSchema = z.object({
  rejectedText: z.string().min(1).max(20_000),
  reason: z.string().min(1).max(200),
  original: z.array(z.object({
    ref: z.string().min(1).max(200),
    kind: z.enum(["skill", "achievement", "bullet", "record", "line", "owner_attested_fact", "profile_skill"]),
    context: z.string().max(2_000).nullable().default(null),
    text: z.string().min(1).max(20_000)
  })).max(50)
});

// Reads the reverted-line list stored with a ResumeVersion's metadata JSON; malformed entries are skipped.
export function readTailoredResumeReversions(metadata: unknown): TailoredResumeReversion[] {
  if (!isRecord(metadata) || !Array.isArray(metadata.reverted)) return [];
  return metadata.reverted.flatMap((value) => {
    const parsed = storedReversionSchema.safeParse(value);
    return parsed.success ? [parsed.data] : [];
  });
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
  const draft = new ResumeDraft(model, output);
  const protectedSet = protectedUnits(model, payload);
  const rendered = new Map(model.units.map((unit) => [unit, draft.renderedLines(unit)]));
  const kept = (unit: Unit) => (rendered.get(unit)?.length ?? 0) > 0;
  for (const unit of model.units) {
    if (kept(unit) && !draft.wholeAt(unit, rendered.get(unit)!)) {
      incomplete(unit.ref, "Tailored resume kept only part of a source item.");
    }
    if (unit.kind === "header" && !kept(unit)) {
      incomplete(`resume.rawText.header[${unit.order}]`, "Tailored resume omitted source identity or contact context.");
    }
    if (unit.kind === "summary" && !kept(unit)) incomplete("resume.summary", "Tailored resume omitted the source summary.");
    if (protectedSet.has(unit) && !kept(unit)) {
      incomplete(unit.ref, "Tailored resume omitted a protected résumé item.");
    }
  }
  for (const record of model.records) {
    const all = [...record.headers, ...record.bullets];
    if (record.field === "projects") {
      if (all.some(kept) && record.headers.length && !record.headers.some(kept)) {
        incomplete(record.ref, "Tailored resume kept project content without its project header.");
      }
      continue;
    }
    const required = record.field === "workHistory" ? record.headers : all;
    if (!required.every(kept)) incomplete(record.ref, "Tailored resume omitted a required source record.");
    if (record.field === "workHistory" &&
      record.bullets.filter(kept).length < Math.min(TAILORED_RESUME_FLOORS.jobBullets, record.bullets.length)) {
      incomplete(record.ref, "Tailored resume trimmed a job below its bullet floor.");
    }
  }
  for (const [kind, floor, fieldPath] of [
    ["skill", TAILORED_RESUME_FLOORS.skills, "resume.skills"],
    ["achievement", TAILORED_RESUME_FLOORS.achievements, "resume.achievements"]
  ] as const) {
    const units = model.units.filter((unit) => unit.kind === kind);
    if (units.filter(kept).length < Math.min(floor, units.length)) {
      incomplete(fieldPath, `Tailored resume trimmed ${kind === "skill" ? "skills" : "achievements"} below the floor.`);
    }
  }
  const headings = output.resumeText.split(/\r?\n/u).flatMap((line) => {
    const section = sectionOf(line);
    return section ? [{ section, text: line.trim() }] : [];
  });
  for (const section of model.requiredSections) {
    if (!headings.some((heading) => heading.section === section)) {
      incomplete("resumeText", `Tailored resume omitted the ${section} source section.`);
    }
  }
  for (const heading of headings) {
    const source = model.sourceHeadingText.get(heading.section);
    if (source && source !== heading.text) incomplete("resumeText", "Tailored resume renamed a source section heading.");
  }
}

// Catalog items the final tailored résumé does not include, as whole paste-ready source items.
export function tailoredResumeLeftOut(payload: ApplicationDocumentPayload, output: ResumeOutput): TailoredResumeItem[] {
  const model = buildSourceModel(payload);
  const draft = new ResumeDraft(model, output);
  const included = globallyIncluded(output);
  const kept = (unit: Unit) => draft.renderedLines(unit).length > 0;
  const mentioned = (unit: Unit) => unit.facts.every(included);
  const items: TailoredResumeItem[] = [];
  const handled = new Set<SourceRecord>();
  for (const unit of model.units) {
    const record = unit.record;
    if (record) {
      if (handled.has(record)) continue;
      handled.add(record);
      const all = [...record.headers, ...record.bullets];
      if (!all.some(kept)) {
        if (!all.every(mentioned)) items.push({ ref: record.ref, kind: "record", context: null, text: recordText(model, record) });
        continue;
      }
      for (const member of all) if (!kept(member) && !mentioned(member)) items.push(unitItem(member));
      continue;
    }
    if (!kept(unit) && !mentioned(unit)) items.push(unitItem(unit));
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
