import type { UserProfile } from "@prisma/client";

import { isRemotePosting, jobLocationFit, preferredLocationsFromProfile } from "@/lib/job-sources/location-match";
import type { NormalizedJob } from "@/lib/job-sources/types";
import { normalizeText } from "@/lib/normalize";

export type JobRelevanceDecision = "strong" | "review" | "skip";

export type JobRelevanceResult = {
  score: number;
  decision: JobRelevanceDecision;
  recommendation: string;
  reasons: string[];
  concerns: string[];
  supportedKeywords: string[];
  keywordsToStrengthen: string[];
  resumeAngle: string;
  hardExcluded: boolean;
  breakdown: {
    roleTitleScore: number;
    targetRoleScore: number;
    locationScore: number;
    remoteScore: number;
    seniorityScore: number;
    salaryScore: number;
    techStackScore: number;
    customerFacingScore: number;
    operationsSaasScore: number;
    freshnessScore: number;
    bodyEvidenceScore: number;
    negativeKeywordPenalty: number;
  };
};

const customerFacingTerms = [
  "customer",
  "client",
  "stakeholder",
  "demo",
  "discovery",
  "implementation",
  "customer onboarding",
  "client onboarding",
  "user onboarding",
  "customer support",
  "client support",
  "post launch support",
  "customer training",
  "client training",
  "user training",
  "technical account",
  "pre sales",
  "presales",
  "post sales",
  "customer success"
];

const operationsSaasTerms = [
  "saas",
  "api",
  "integration",
  "workflow",
  "operations",
  "crm",
  "salesforce",
  "hubspot",
  "billing",
  "healthcare",
  "compliance",
  "scheduling",
  "payer"
];

const technicalSearchTerms = [
  "javascript",
  "react",
  "node",
  "node.js",
  "express",
  "python",
  "sql",
  "postgresql",
  "mongodb",
  "django",
  "rest api",
  "rest apis",
  "aws",
  "html",
  "css"
];

/** Pay or work models that rule a posting out wherever they appear in it. */
const hardExcludeFullTextTerms = ["commission only", "door to door"];

/**
 * Occupations outside office/tech work. They exclude a title unless the user's own roles name
 * them. Seniority (staff, principal, director, VP, head of) is handled by the user's target
 * level instead, so it is not listed here.
 */
const hardExcludeTitleTerms = [
  "nurse",
  "physician",
  "pharmacist",
  "mechanical engineer",
  "civil engineer",
  "electrical engineer",
  "automotive engineer",
  "manufacturing engineer",
  "construction engineer",
  "project engineer",
  "driver",
  "warehouse",
  "retail associate",
  "cashier",
  "real estate agent",
  "insurance agent",
  "financial advisor",
  "wealth advisor"
];

const softNegativeTerms = [
  "senior manager",
  "manager, software engineering",
  "10+ years",
  "12+ years",
  "15+ years",
  "active security clearance",
  "secret clearance",
  "top secret",
  "phd required",
  "medical license",
  "professional engineer license",
  "pe license"
];

function clampScore(score: number) {
  return Math.max(0, Math.min(100, Math.round(score)));
}

function textIncludesAny(text: string, terms: string[]) {
  return terms.some((term) => text.includes(term));
}

function countMatches(text: string, terms: string[]) {
  return terms.filter((term) => text.includes(term)).length;
}

function jobText(job: NormalizedJob) {
  return normalizeText(
    [
      job.title,
      job.company,
      job.location,
      job.remoteStatus,
      job.seniorityLevel,
      job.description,
      ...job.requirements,
      ...job.preferredQualifications,
      ...job.benefits,
      ...job.detectedTechStack
    ].join(" ")
  );
}

function bodyText(job: NormalizedJob) {
  return normalizeText(
    [
      job.description,
      ...job.requirements,
      ...job.preferredQualifications,
      ...job.benefits,
      ...job.detectedTechStack
    ].join(" ")
  );
}

function exactTitleText(job: NormalizedJob) {
  return normalizeText([job.title, job.seniorityLevel].filter(Boolean).join(" "));
}

type SeniorityLevel = "junior" | "mid" | "senior" | "staff" | "executive";

const levelRank: Record<SeniorityLevel, number> = { junior: 0, mid: 1, senior: 2, staff: 3, executive: 4 };

const levelPatterns: Array<[SeniorityLevel, RegExp]> = [
  ["executive", /\b(director|head of|vp|svp|evp|vice president|chief)\b/],
  ["staff", /\b(staff|principal|distinguished|fellow)\b/],
  ["senior", /\b(senior|sr|lead|iii|iv)\b/],
  ["junior", /\b(junior|jr|associate|entry level|i)\b/]
];

/** Words that state a level, not a role; they are set aside when comparing role names. */
const seniorityWords = new Set([
  "senior", "sr", "junior", "jr", "lead", "principal", "staff", "associate", "entry", "level", "head", "director",
  "vp", "svp", "evp", "vice", "president", "chief", "distinguished", "fellow", "i", "ii", "iii", "iv"
]);
const stopWords = new Set(["of", "and", "the", "for", "a", "an", "to", "in", "on", "at", "with"]);
/** Role words too generic to identify a role on their own ("manager", "engineer"). */
const genericRoleWords = new Set([
  "manager", "engineer", "developer", "specialist", "analyst", "representative", "consultant", "coordinator",
  "administrator", "officer", "partner", "executive", "assistant", "member", "professional"
]);
const roleWordSynonyms: string[][] = [
  ["engineer", "developer", "programmer", "engineering"],
  ["manager", "lead", "owner"]
];
/** Role nouns that name a craft, so a shared one means similar work. */
const craftWords = new Set(["engineer", "developer", "programmer", "designer", "scientist", "architect", "researcher"]);
/**
 * Words that name a different function. A title that shares a role's words but adds one of
 * these ("Product Marketing Manager" against "Product Manager") is a different job.
 */
const functionWords = new Set([
  "marketing", "marketer", "sales", "customer", "design", "designer", "recruiting", "recruiter", "finance", "legal", "support", "success",
  "security", "data", "research", "operations", "engineering", "product", "program", "project", "account",
  "partner", "partnerships", "people", "talent", "solutions", "solution", "compliance", "accounting", "growth", "content",
  "communications", "brand", "analytics", "infrastructure", "quality", "manufacturing", "supply", "procurement"
]);

function seniorityLevel(text: string): SeniorityLevel {
  // "Associate Director" is a director-level title, so the highest level wins.
  return levelPatterns.find(([, pattern]) => pattern.test(text))?.[0] ?? "mid";
}

function wordsMatch(left: string, right: string) {
  return left === right || roleWordSynonyms.some((group) => group.includes(left) && group.includes(right));
}

type RoleTarget = { phrase: string; core: string[]; level: SeniorityLevel; statesLevel: boolean };

/** The user's own preferred roles and target searches are the only role vocabulary. */
function roleTargets(profile: UserProfile | null, queries: readonly string[]): RoleTarget[] {
  const seen = new Set<string>();
  const targets: RoleTarget[] = [];

  for (const value of [...(profile?.preferredRoles ?? []), ...queries]) {
    const phrase = normalizeText(value);
    if (!phrase || seen.has(phrase)) {
      continue;
    }
    seen.add(phrase);
    const words = phrase.split(" ");
    const core = words.filter((word) => !seniorityWords.has(word) && !stopWords.has(word));
    const level = seniorityLevel(phrase);
    targets.push({ phrase, core, level, statesLevel: core.length < words.length });
  }

  return targets;
}

function containsWords(haystack: string, needle: string) {
  return Boolean(needle) && ` ${haystack} `.includes(` ${needle} `);
}

function scoreTitleAgainstRole(title: string, role: RoleTarget) {
  if (containsWords(title, role.phrase)) {
    return 100;
  }
  if (!role.core.length) {
    return 0;
  }

  const titleWords = title.split(" ");
  const has = (word: string) => titleWords.some((titleWord) => wordsMatch(titleWord, word));
  // "Head of Product" names a level plus a one-word area, so the level has to match as well.
  const levelOk = !role.statesLevel || role.core.length > 1 || seniorityLevel(title) === role.level;

  if (levelOk && containsWords(title, role.core.join(" "))) {
    return 100;
  }

  const matched = role.core.filter(has).length;
  const otherFunction = titleWords.some(
    (word) => functionWords.has(word) && !role.core.some((roleWord) => wordsMatch(roleWord, word))
  );
  if (levelOk && matched === role.core.length && !otherFunction) {
    return 90;
  }

  const head = role.core[role.core.length - 1];
  const qualifiers = role.core.slice(0, -1);
  const distinctiveMatched = role.core.filter((word) => !genericRoleWords.has(word) && has(word)).length;
  // The head alone is not enough: "AI Enablement" is not "Revenue Enablement".
  const qualifierMatched = qualifiers.some((word) => !genericRoleWords.has(word) && has(word));
  if (has(head) && qualifierMatched && !otherFunction) {
    return Math.round(50 + (40 * matched) / role.core.length);
  }
  // A qualifier that names a function ("sales" in "Sales Engineer") is what defines the role.
  const qualifiedByFunction = qualifiers.some((word) => functionWords.has(word));
  if (has(head) && craftWords.has(head) && !qualifiedByFunction && !otherFunction) {
    // Same craft, another specialty: "Platform Engineer" for a "Software Engineer". Org words
    // such as "manager" or "lead" say nothing about the work, so they never get this credit.
    return 50;
  }
  if (distinctiveMatched > 0) {
    return 30;
  }

  return 15;
}

const neutralRoleScore = 60;

const managerWords = new Set(["manager", "management", "managing"]);

function scoreRoleTitle(title: string, roles: readonly RoleTarget[]) {
  if (!roles.length) {
    return neutralRoleScore;
  }

  const best = Math.max(...roles.map((role) => scoreTitleAgainstRole(title, role)));
  // "Manager, Software Engineering" manages engineers; it does not fit a user whose roles are all
  // individual-contributor crafts ("Software Engineer", "Product Designer").
  const managesPeople = title.split(" ").some((word) => managerWords.has(word));
  const onlyCraftRoles = roles.every((role) => craftWords.has(role.core[role.core.length - 1] ?? ""));

  return managesPeople && onlyCraftRoles ? Math.min(best, 30) : best;
}

function scoreTargetRole(text: string, roles: readonly RoleTarget[]) {
  if (!roles.length) {
    return 50;
  }

  const matches = roles.filter(
    (role) => containsWords(text, role.phrase) || (role.core.length > 1 && containsWords(text, role.core.join(" ")))
  ).length;

  if (matches >= 2) {
    return 100;
  }
  if (matches === 1) {
    return 82;
  }

  return 30;
}

function scoreLocation(job: NormalizedJob, profile: UserProfile | null) {
  // Driven by this user's own preferred and home locations; no locale is built in.
  const preferredLocations = preferredLocationsFromProfile(profile);
  const fit = jobLocationFit({ location: job.location, remoteStatus: job.remoteStatus, title: job.title, preferredLocations });

  if (fit === "exact" || fit === "remote") {
    return 100;
  }
  if (fit === "state" || fit === "country") {
    return 70;
  }
  if (fit === "unspecified") {
    return preferredLocations.length ? 55 : 80;
  }

  return 35;
}

function scoreRemote(job: NormalizedJob, profile: UserProfile | null) {
  const remotePreference = profile?.remotePreference ?? "FLEXIBLE";
  const remoteStatus = normalizeText(job.remoteStatus);
  const location = normalizeText(job.location);

  if (remotePreference === "FLEXIBLE") {
    return 80;
  }

  const isRemote = isRemotePosting(job);
  const isHybrid = remoteStatus === "hybrid" || location.includes("hybrid");
  const isOnsite = remoteStatus === "onsite" || remoteStatus === "on site" || remoteStatus === "on-site";

  if (remotePreference === "REMOTE") {
    return isRemote ? 100 : isHybrid ? 55 : 20;
  }
  if (remotePreference === "HYBRID") {
    return isHybrid ? 100 : isRemote ? 85 : 55;
  }
  if (remotePreference === "ONSITE") {
    return isOnsite ? 100 : isHybrid ? 75 : 60;
  }

  return 80;
}

/**
 * Fit between the title's level and the level the user's roles ask for. Roles that state no
 * level target mid-level work. Staff/principal and director/VP/head-of titles score 0 (and are
 * excluded) unless the user's roles reach that level.
 */
function scoreSeniority(title: string, roles: readonly RoleTarget[]) {
  const titleLevel = seniorityLevel(title);
  const wanted = new Set<SeniorityLevel>(roles.length ? roles.map((role) => role.level) : ["mid"]);
  if (wanted.has(titleLevel)) {
    return 100;
  }

  const highestWanted = Math.max(...[...wanted].map((level) => levelRank[level]));
  const gap = levelRank[titleLevel] - highestWanted;

  if (gap > 0) {
    if (levelRank[titleLevel] >= levelRank.staff && highestWanted < levelRank.staff) {
      return 0;
    }
    return gap === 1 ? 70 : 40;
  }

  const lowestWanted = Math.min(...[...wanted].map((level) => levelRank[level]));
  const below = lowestWanted - levelRank[titleLevel];
  return below <= 1 ? 85 : 50;
}

function scoreSalary(job: NormalizedJob, profile: UserProfile | null) {
  if (!profile?.salaryTargetMin && !profile?.salaryTargetMax) {
    return 65;
  }
  if (!job.salaryMin && !job.salaryMax) {
    return 60;
  }

  const jobMin = job.salaryMin ?? job.salaryMax ?? 0;
  const jobMax = job.salaryMax ?? job.salaryMin ?? 0;
  const targetMin = profile.salaryTargetMin ?? 0;
  const targetMax = profile.salaryTargetMax ?? Number.MAX_SAFE_INTEGER;

  if (jobMax < targetMin) {
    return 25;
  }
  if (jobMin > targetMax * 1.25) {
    return 70;
  }
  if (jobMin >= targetMin || jobMax >= targetMin) {
    return 100;
  }

  return 60;
}

function scoreTechStack(text: string, profile: UserProfile | null) {
  const skills = profile?.skillsToEmphasize?.map(normalizeText).filter(Boolean) ?? technicalSearchTerms;
  const matches = countMatches(text, skills);

  return clampScore((matches / Math.max(4, Math.min(skills.length, 8))) * 100);
}

function scoreFreshness(job: NormalizedJob) {
  if (!job.datePosted) {
    return 55;
  }

  const ageDays = (Date.now() - job.datePosted.getTime()) / 86_400_000;

  if (ageDays <= 7) {
    return 100;
  }
  if (ageDays <= 14) {
    return 85;
  }
  if (ageDays <= 30) {
    return 65;
  }

  return 30;
}

function namedByRoles(term: string, roles: readonly RoleTarget[]) {
  return roles.some((role) => role.phrase.includes(term));
}

function negativePenalty(text: string, profile: UserProfile | null, roles: readonly RoleTarget[]) {
  const dealBreakers = profile?.dealBreakers?.map(normalizeText).filter(Boolean) ?? [];
  const softNegatives = [...softNegativeTerms.filter((term) => !namedByRoles(term, roles)), ...dealBreakers];
  return Math.min(35, countMatches(text, softNegatives) * 8);
}

function scoreBodyEvidence(breakdown: Omit<JobRelevanceResult["breakdown"], "bodyEvidenceScore" | "negativeKeywordPenalty">) {
  const evidenceSignals = [
    breakdown.targetRoleScore >= 70,
    breakdown.customerFacingScore >= 60,
    // At least two of the user's own skills (one of a short list) named in the posting.
    breakdown.techStackScore >= 25,
    breakdown.operationsSaasScore >= 75
  ].filter(Boolean).length;

  if (evidenceSignals >= 2) {
    return 100;
  }
  if (evidenceSignals === 1) {
    return 70;
  }

  return 20;
}

function buildKeywordsToStrengthen(breakdown: JobRelevanceResult["breakdown"], hardExcluded: boolean) {
  const keywords: string[] = [];

  if (hardExcluded) {
    keywords.push("Role type/deal-breaker");
  }
  if (breakdown.techStackScore < 50) {
    keywords.push("Limited technical stack signals in posting");
  }
  if (breakdown.customerFacingScore < 60) {
    keywords.push("Customer-facing delivery");
  }
  if (breakdown.operationsSaasScore < 50) {
    keywords.push("SaaS operations context");
  }
  if (breakdown.seniorityScore <= 50) {
    keywords.push("Scope and seniority fit");
  }
  if (breakdown.locationScore < 70) {
    keywords.push("Location/work-style fit");
  }

  return keywords.slice(0, 8);
}

function recommendationForDecision(decision: JobRelevanceDecision) {
  if (decision === "strong") {
    return "Prioritize for review";
  }
  if (decision === "review") {
    return "Review";
  }

  return "Skip";
}

export function scoreJobRelevance({
  job,
  profile,
  query,
  queries = []
}: {
  job: NormalizedJob;
  profile: UserProfile | null;
  query?: string;
  /** The user's target searches; together with the profile's preferred roles they define the roles. */
  queries?: readonly string[];
}): JobRelevanceResult {
  const text = jobText(job);
  const body = bodyText(job);
  const title = exactTitleText(job);
  const roles = roleTargets(profile, query ? [query, ...queries] : queries);
  const reasons: string[] = [];
  const concerns: string[] = [];
  const seniorityScore = scoreSeniority(title, roles);
  const excludedOccupation = hardExcludeTitleTerms.some((term) => title.includes(term) && !namedByRoles(term, roles));
  const hardExcluded = textIncludesAny(text, hardExcludeFullTextTerms) || excludedOccupation || seniorityScore === 0;
  const preliminaryBreakdown = {
    roleTitleScore: scoreRoleTitle(title, roles),
    targetRoleScore: scoreTargetRole(body, roles),
    locationScore: scoreLocation(job, profile),
    remoteScore: scoreRemote(job, profile),
    seniorityScore,
    salaryScore: scoreSalary(job, profile),
    techStackScore: scoreTechStack(body, profile),
    customerFacingScore: clampScore((countMatches(body, customerFacingTerms) / 5) * 100),
    operationsSaasScore: clampScore((countMatches(body, operationsSaasTerms) / 4) * 100),
    freshnessScore: scoreFreshness(job)
  };
  const breakdown = {
    ...preliminaryBreakdown,
    bodyEvidenceScore: scoreBodyEvidence(preliminaryBreakdown),
    negativeKeywordPenalty: negativePenalty(text, profile, roles)
  };

  if (hardExcluded) {
    concerns.push("Hard-excluded role type or deal-breaker keyword.");
  }
  if (breakdown.roleTitleScore >= 80) {
    reasons.push("Title aligns with a target role.");
  }
  if (breakdown.customerFacingScore >= 60) {
    reasons.push("Posting has customer-facing technical language.");
  }
  if (breakdown.techStackScore >= 50) {
    reasons.push("Posting contains technical stack signals relevant to the search.");
  }
  if (breakdown.locationScore >= 90) {
    reasons.push("Location or work style fits preferences.");
  }
  if (breakdown.seniorityScore <= 50) {
    concerns.push("Seniority differs from the level your target roles ask for.");
  }
  if (breakdown.salaryScore <= 35) {
    concerns.push("Compensation appears below target range.");
  }

  const rawScore =
    breakdown.roleTitleScore * 0.24 +
    breakdown.targetRoleScore * 0.16 +
    breakdown.locationScore * 0.12 +
    breakdown.remoteScore * 0.08 +
    breakdown.seniorityScore * 0.12 +
    breakdown.salaryScore * 0.06 +
    breakdown.techStackScore * 0.1 +
    breakdown.customerFacingScore * 0.06 +
    breakdown.operationsSaasScore * 0.04 +
    breakdown.freshnessScore * 0.02 -
    breakdown.negativeKeywordPenalty;

  const evidenceAdjustedScore = breakdown.bodyEvidenceScore < 70 ? Math.min(58, clampScore(rawScore)) : clampScore(rawScore);
  const score = hardExcluded ? Math.min(35, evidenceAdjustedScore) : evidenceAdjustedScore;
  const decision: JobRelevanceDecision = score >= 80 ? "strong" : score >= 60 ? "review" : "skip";
  const keywordsToStrengthen = buildKeywordsToStrengthen(breakdown, hardExcluded);

  return {
    score,
    decision,
    recommendation: recommendationForDecision(decision),
    reasons: reasons.length ? reasons : ["Posting has limited target-role signals."],
    concerns,
    supportedKeywords: [],
    keywordsToStrengthen,
    resumeAngle: "Review your actual experience for evidence relevant to this posting; avoid unsupported claims.",
    hardExcluded,
    breakdown
  };
}
