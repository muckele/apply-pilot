// Turns a JOB_MATCH analysis into a per-requirement checklist using only the analysis's own
// citations: a requirement is "shown" when a factual match cites it and no gap does, "not_shown"
// when a gap cites it, and "not_assessed" otherwise. "Not shown" is about the résumé text, not
// proof that the person lacks the skill. A years-of-experience gap also carries the duration and
// roles Apply Pilot counted from work-history titles and dates (lib/ai/job-match-tenure.ts).

import { readTenure, type TenureGapPresentation } from "@/lib/jobs/fit-presentation";

export type ChecklistStatus = "shown" | "not_shown" | "not_assessed";

export type ChecklistItem = {
  requirement: string;
  jobRef: string | null;
  status: ChecklistStatus;
  claim: string | null;
  resumeLines: string[];
  tenure: TenureGapPresentation | null;
};

export type ChecklistCounts = { shown: number; notShown: number; notAssessed: number; total: number };

export type RequirementChecklist = {
  source: "requirements" | "analysis";
  items: ChecklistItem[];
  counts: ChecklistCounts;
  top(limit: number): { items: ChecklistItem[]; more: Omit<ChecklistCounts, "total"> };
};

type Citation = { ref: string; excerpt: string };
type Match = { claim: string; applicantEvidence: Citation[]; jobEvidence: Citation[] };
type Gap = { requirement: string; jobRequirement: Citation | null; tenure: TenureGapPresentation | null };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function citation(value: unknown): Citation | null {
  return isRecord(value) && typeof value.ref === "string" && typeof value.excerpt === "string"
    ? { ref: value.ref, excerpt: value.excerpt }
    : null;
}

function citations(value: unknown): Citation[] {
  return Array.isArray(value) ? value.map(citation).filter((item): item is Citation => item !== null) : [];
}

function readOutput(output: unknown): { matches: Match[]; gaps: Gap[] } {
  if (!isRecord(output)) return { matches: [], gaps: [] };
  const matches = Array.isArray(output.factualMatches)
    ? output.factualMatches.flatMap((value): Match[] => isRecord(value) && typeof value.claim === "string"
      ? [{ claim: value.claim, applicantEvidence: citations(value.applicantEvidence), jobEvidence: citations(value.jobEvidence) }]
      : [])
    : [];
  const gaps = Array.isArray(output.requirementGaps)
    ? output.requirementGaps.flatMap((value): Gap[] => isRecord(value) && typeof value.requirement === "string"
      ? [{ requirement: value.requirement, jobRequirement: citation(value.jobRequirement), tenure: readTenure(value.tenure) }]
      : [])
    : [];
  return { matches, gaps };
}

const STATUS_ORDER: Record<ChecklistStatus, number> = { shown: 0, not_shown: 0, not_assessed: 1 };

// The match card's headline. It divides only by requirements the analysis actually checked
// (shown or not shown); unchecked ones are counted separately, never as "missing".
export function summarizeChecklist(counts: ChecklistCounts): { heading: string; notChecked: string | null } | null {
  if (!counts.total) return null;
  const checked = counts.shown + counts.notShown;
  if (!checked) return { heading: "Apply Pilot didn't check these requirements", notChecked: null };
  const mustHaves = `must-have${checked === 1 ? "" : "s"}`;
  if (!counts.notAssessed) return { heading: `Your résumé shows ${counts.shown} of ${checked} ${mustHaves}`, notChecked: null };
  return {
    heading: `Your résumé shows ${counts.shown} of ${checked} checked ${mustHaves}`,
    notChecked: `${counts.notAssessed} not checked yet`
  };
}

export function topChecklistItems(items: readonly ChecklistItem[], limit: number) {
  const ordered = items
    .map((item, index) => ({ item, index }))
    .sort((left, right) => STATUS_ORDER[left.item.status] - STATUS_ORDER[right.item.status] || left.index - right.index)
    .map(({ item }) => item);
  const rest = ordered.slice(Math.max(0, limit));
  return {
    items: ordered.slice(0, Math.max(0, limit)),
    more: {
      shown: rest.filter((item) => item.status === "shown").length,
      notShown: rest.filter((item) => item.status === "not_shown").length,
      notAssessed: rest.filter((item) => item.status === "not_assessed").length
    }
  };
}

function finish(source: RequirementChecklist["source"], items: ChecklistItem[]): RequirementChecklist {
  const count = (status: ChecklistStatus) => items.filter((item) => item.status === status).length;
  const counts = { shown: count("shown"), notShown: count("not_shown"), notAssessed: count("not_assessed"), total: items.length };
  return {
    source,
    items,
    counts,
    top: (limit) => topChecklistItems(items, limit)
  };
}

export function buildRequirementChecklist(requirements: readonly string[], output: unknown): RequirementChecklist {
  const { matches, gaps } = readOutput(output);
  if (requirements.length) {
    return finish("requirements", requirements.map((requirement, index) => {
      const ref = `job.requirements[${index}]`;
      const gapped = gaps.filter((gap) => gap.jobRequirement?.ref === ref);
      const matched = matches.filter((match) => match.jobEvidence.some((item) => item.ref === ref));
      if (gapped.length) {
        const tenure = gapped.find((gap) => gap.tenure)?.tenure ?? null;
        return { requirement, jobRef: ref, status: "not_shown" as const, claim: null, resumeLines: [], tenure };
      }
      if (matched.length) {
        return {
          requirement,
          jobRef: ref,
          status: "shown" as const,
          claim: matched[0]!.claim,
          resumeLines: [...new Set(matched.flatMap((match) => match.applicantEvidence.map((item) => item.excerpt)))],
          tenure: null
        };
      }
      return { requirement, jobRef: ref, status: "not_assessed" as const, claim: null, resumeLines: [], tenure: null };
    }));
  }
  return finish("analysis", [
    ...matches.map((match) => ({
      requirement: match.jobEvidence[0]?.excerpt ?? match.claim,
      jobRef: match.jobEvidence[0]?.ref ?? null,
      status: "shown" as const,
      claim: match.claim,
      resumeLines: [...new Set(match.applicantEvidence.map((item) => item.excerpt))],
      tenure: null
    })),
    ...gaps.map((gap) => ({
      requirement: gap.requirement,
      jobRef: gap.jobRequirement?.ref ?? null,
      status: "not_shown" as const,
      claim: null,
      resumeLines: [],
      tenure: gap.tenure
    }))
  ]);
}
