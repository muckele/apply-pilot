import type { ApplicationDocumentPayload } from "@/lib/ai/application-document-claims";
import { buildApplicationDocumentFactCatalog, normalizeApplicationDocumentSourceLine } from "@/lib/ai/application-document-facts";

// A transparent lexical ordering proxy, not a semantic match score. No stemming,
// synonym inference, or qualification inference is permitted here.
const generic = new Set("a an the and or of to in for on at by with from across through as is are be have has current demonstrated experience experienced working knowledge ability strong excellent proven years year more progressive preferred required skills using use work teams team".split(" "));
function tokens(value: string) {
  return new Set((value.toLocaleLowerCase().match(/[\p{L}\p{N}]+(?:\+\+|#)?/gu) ?? [])
    .filter(token => !generic.has(token) && !/^\d+$/u.test(token)));
}
function headerKey(value: string) {
  return normalizeApplicationDocumentSourceLine(value).replace(/\s+/gu, " ").toLocaleLowerCase();
}

// How closely a fact matches the job: the most words it shares with any one requirement, preferred
// qualification or listed technology.
export function applicationDocumentPriorityScorer(payload: ApplicationDocumentPayload) {
  const job = payload.job ?? {};
  const criteria = [job.requirements, job.preferredQualifications, job.detectedTechStack]
    .flatMap(value => Array.isArray(value) ? value : [])
    .filter((value): value is string => typeof value === "string")
    .map(tokens);
  return (excerpt: string) => {
    const words = tokens(excerpt);
    return Math.max(0, ...criteria.map(criterion => [...criterion].filter(token => words.has(token)).length));
  };
}

export function applicationDocumentPriorityOpportunities(payload: ApplicationDocumentPayload) {
  const scoreOf = applicationDocumentPriorityScorer(payload);
  const catalog = buildApplicationDocumentFactCatalog(payload);
  const headers = [payload.resume?.workHistory, payload.resume?.projects].flatMap(values => Array.isArray(values) ? values : [])
    .flatMap(value => value && typeof value === "object" && !Array.isArray(value) &&
      typeof (value as Record<string, unknown>).sourceText === "string"
      ? [headerKey(((value as Record<string, unknown>).sourceText as string).split(/\r?\n/u)[0])] : []);
  return (["workHistory", "projects"] as const).flatMap(field => {
    const records = payload.resume?.[field];
    if (!Array.isArray(records)) return [];
    return records.flatMap((value, index) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return [];
      const record = value as Record<string, unknown>;
      const ref = `resume.${field}[${index}]`;
      if (!Array.isArray(record.bullets) || typeof record.sourceText !== "string") return [];
      const header = record.sourceText.split(/\r?\n/u)[0].trim();
      if (!header || headers.filter(value => value === headerKey(header)).length !== 1) return [];
      const bullets = record.bullets.filter((bullet): bullet is string => typeof bullet === "string");
      if (bullets.length < 2 || new Set(bullets).size !== bullets.length) return [];
      const ranked = bullets.map(excerpt => {
        const fact = catalog.find(fact => fact.ref === ref && fact.excerpt === excerpt);
        return { excerpt, factId: fact?.factId, score: scoreOf(excerpt) };
      });
      // Split/duplicate/ambiguous source facts cannot safely acquire this ordering rule.
      if (ranked.some(fact => !fact.factId)) return [];
      const maximum = Math.max(...ranked.map(fact => fact.score));
      if (maximum < 2 || ranked[0].score === maximum) return [];
      return [{ ref, header, bullets: ranked,
        leadingFactIds: ranked.filter(fact => fact.score === maximum).map(fact => fact.factId!) }];
    });
  });
}
