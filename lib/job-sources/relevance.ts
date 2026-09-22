import type { UserProfile } from "@prisma/client";

import { isRemoteLikeText } from "@/lib/job-sources/remote";
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

const preferredRoleTerms = [
  "sales engineer",
  "solutions engineer",
  "solution engineer",
  "solutions consultant",
  "solution consultant",
  "technical account manager",
  "tam",
  "customer success engineer",
  "support engineer",
  "implementation specialist",
  "implementation consultant",
  "implementation engineer",
  "technical onboarding",
  "onboarding specialist",
  "full stack developer",
  "full stack engineer",
  "junior software engineer",
  "software engineer i",
  "associate software engineer",
  "saas operations",
  "business operations",
  "revops"
];

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

const hardExcludeFullTextTerms = [
  "commission only",
  "door to door",
  "real estate agent",
  "insurance agent",
  "financial advisor",
  "wealth advisor",
  "driver",
  "warehouse",
  "retail associate",
  "cashier"
];

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
  "principal engineer",
  "staff engineer",
  "engineering manager",
  "software engineering manager",
  "director",
  "vp",
  "vice president"
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

function scoreRoleTitle(title: string) {
  if (textIncludesAny(title, preferredRoleTerms)) {
    return 100;
  }

  if (title.includes("engineer") && textIncludesAny(title, ["sales", "solution", "customer", "support", "implementation"])) {
    return 80;
  }

  if (title.includes("developer") || title.includes("software engineer")) {
    return title.includes("junior") || title.includes("associate") || title.includes(" i ") ? 72 : 58;
  }

  if (title.includes("operations") || title.includes("implementation") || title.includes("customer success")) {
    return 70;
  }

  return title.includes("engineer") ? 30 : 15;
}

function scoreTargetRole(text: string, profile: UserProfile | null) {
  const configuredRoles = profile?.preferredRoles ?? [];
  const roleTerms = [...preferredRoleTerms, ...configuredRoles.map(normalizeText)].filter(Boolean);
  const matches = countMatches(text, roleTerms);

  if (matches >= 2) {
    return 100;
  }
  if (matches === 1) {
    return 82;
  }

  return 30;
}

function scoreLocation(job: NormalizedJob, profile: UserProfile | null) {
  const location = normalizeText(job.location);
  const remoteStatus = normalizeText(job.remoteStatus);

  if (isRemoteLikeText(remoteStatus) || isRemoteLikeText(location)) {
    return 100;
  }

  const preferredLocations = profile?.preferredLocations?.map(normalizeText) ?? [];
  if (preferredLocations.some((preferred) => preferred && location.includes(preferred))) {
    return 100;
  }

  if (location.includes("los angeles") || location.includes("fontana") || location.includes("pasadena") || location.includes("orange county")) {
    return 92;
  }

  if (location.includes("california") || location.includes(" ca") || location.endsWith("ca")) {
    return 70;
  }

  return location ? 35 : 55;
}

function scoreRemote(job: NormalizedJob, profile: UserProfile | null) {
  const remotePreference = profile?.remotePreference ?? "FLEXIBLE";
  const remoteStatus = normalizeText(job.remoteStatus);
  const location = normalizeText(job.location);

  if (remotePreference === "FLEXIBLE") {
    return 80;
  }

  const isRemote = isRemoteLikeText(remoteStatus) || isRemoteLikeText(location);
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

function scoreSeniority(title: string) {
  if (textIncludesAny(title, ["principal", "staff", "director", "vp", "vice president", "head of"])) {
    return 0;
  }

  if (textIncludesAny(title, ["junior", "associate", "specialist", "coordinator", " i ", "entry level"])) {
    return 100;
  }

  if (textIncludesAny(title, ["senior", "sr", "lead"])) {
    return 50;
  }

  return 82;
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

function negativePenalty(text: string, profile: UserProfile | null) {
  const dealBreakers = profile?.dealBreakers?.map(normalizeText).filter(Boolean) ?? [];
  const softNegatives = [...softNegativeTerms, ...dealBreakers];
  return Math.min(35, countMatches(text, softNegatives) * 8);
}

function scoreBodyEvidence(breakdown: Omit<JobRelevanceResult["breakdown"], "bodyEvidenceScore" | "negativeKeywordPenalty">) {
  const evidenceSignals = [
    breakdown.targetRoleScore >= 70,
    breakdown.customerFacingScore >= 60,
    breakdown.techStackScore >= 50,
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
  profile
}: {
  job: NormalizedJob;
  profile: UserProfile | null;
  query?: string;
}): JobRelevanceResult {
  const text = jobText(job);
  const body = bodyText(job);
  const title = exactTitleText(job);
  const reasons: string[] = [];
  const concerns: string[] = [];
  const hardExcluded = textIncludesAny(text, hardExcludeFullTextTerms) || textIncludesAny(title, hardExcludeTitleTerms);
  const preliminaryBreakdown = {
    roleTitleScore: scoreRoleTitle(title),
    targetRoleScore: scoreTargetRole(body, profile),
    locationScore: scoreLocation(job, profile),
    remoteScore: scoreRemote(job, profile),
    seniorityScore: scoreSeniority(title),
    salaryScore: scoreSalary(job, profile),
    techStackScore: scoreTechStack(body, profile),
    customerFacingScore: clampScore((countMatches(body, customerFacingTerms) / 5) * 100),
    operationsSaasScore: clampScore((countMatches(body, operationsSaasTerms) / 4) * 100),
    freshnessScore: scoreFreshness(job)
  };
  const breakdown = {
    ...preliminaryBreakdown,
    bodyEvidenceScore: scoreBodyEvidence(preliminaryBreakdown),
    negativeKeywordPenalty: negativePenalty(text, profile)
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
    concerns.push("Seniority may be high for the current target profile.");
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
