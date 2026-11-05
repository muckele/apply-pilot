import type { Prisma } from "@prisma/client";

// URL state for the /jobs feed: search, filter chips, sort and the selected job. Existing
// parameter names (q, source, status, workStyle, datePosted, company, roleType, minFitScore)
// keep working; location, salary, seniority, sort and job are new.

export type FeedSort = "relevant" | "newest" | "salary";

export type FeedFilters = {
  q: string;
  location: string;
  workStyle: "" | "Remote" | "Hybrid" | "On-site";
  salary: boolean;
  seniority: string;
  postedWithin: number;
  sort: FeedSort;
  source: string;
  status: string;
  company: string;
  roleType: string;
  minFitScore: number;
  job: string;
};

type SearchParams = Record<string, string | string[] | undefined>;

export const FEED_SOURCE_TYPES = [
  "GREENHOUSE", "LEVER", "ASHBY", "WORKABLE", "USAJOBS", "REMOTIVE", "ADZUNA", "THEIRSTACK", "SERPAPI", "RSS", "COMPANY_CAREERS", "MANUAL"
] as const;
export const FEED_POSTING_STATUSES = ["ACTIVE", "EXPIRED", "APPLIED", "REJECTED", "INTERVIEW", "OFFER", "ARCHIVED"] as const;
export const FEED_WORK_STYLES = ["Remote", "Hybrid", "On-site"] as const;
export const FEED_SENIORITY = ["Entry", "Mid", "Senior", "Lead", "Manager", "Director", "Executive"] as const;
export const FEED_POSTED_WITHIN = [
  [1, "Past 24 hours"], [3, "Past 3 days"], [7, "Past week"], [14, "Past 2 weeks"], [30, "Past month"]
] as const;
export const FEED_SORTS: ReadonlyArray<readonly [FeedSort, string]> = [
  ["relevant", "Most relevant"], ["newest", "Newest"], ["salary", "Highest salary"]
];

function first(params: SearchParams, key: string) {
  const value = params[key];
  return (Array.isArray(value) ? value[0] : value)?.trim() ?? "";
}

function oneOf<T extends string>(value: string, allowed: readonly T[]): T | "" {
  return (allowed as readonly string[]).includes(value) ? value as T : "";
}

export function parseFeedFilters(params: SearchParams = {}): FeedFilters {
  const posted = Number(first(params, "datePosted"));
  const minFit = Number(first(params, "minFitScore"));
  return {
    q: first(params, "q").slice(0, 200),
    location: first(params, "location").slice(0, 120),
    workStyle: oneOf(first(params, "workStyle"), FEED_WORK_STYLES),
    salary: first(params, "salary") === "listed",
    seniority: oneOf(first(params, "seniority"), FEED_SENIORITY),
    postedWithin: Number.isInteger(posted) && posted > 0 && posted <= 365 ? posted : 0,
    sort: oneOf(first(params, "sort"), ["relevant", "newest", "salary"] as const) || "relevant",
    source: oneOf(first(params, "source"), FEED_SOURCE_TYPES),
    status: oneOf(first(params, "status"), FEED_POSTING_STATUSES),
    company: first(params, "company").slice(0, 120),
    roleType: first(params, "roleType").slice(0, 120),
    minFitScore: Number.isInteger(minFit) && minFit > 0 && minFit <= 100 ? minFit : 0,
    job: first(params, "job").slice(0, 191)
  };
}

export function feedHref(filters: FeedFilters, overrides: Partial<FeedFilters> = {}, options: { keepJob?: boolean } = {}) {
  const next = { ...filters, ...overrides };
  const params = new URLSearchParams();
  if (next.q) params.set("q", next.q);
  if (next.location) params.set("location", next.location);
  if (next.workStyle) params.set("workStyle", next.workStyle);
  if (next.salary) params.set("salary", "listed");
  if (next.seniority) params.set("seniority", next.seniority);
  if (next.postedWithin) params.set("datePosted", String(next.postedWithin));
  if (next.sort !== "relevant") params.set("sort", next.sort);
  if (next.source) params.set("source", next.source);
  if (next.status) params.set("status", next.status);
  if (next.company) params.set("company", next.company);
  if (next.roleType) params.set("roleType", next.roleType);
  if (next.minFitScore) params.set("minFitScore", String(next.minFitScore));
  if (options.keepJob && next.job) params.set("job", next.job);
  const query = params.toString();
  return query ? `/jobs?${query}` : "/jobs";
}

const insensitive = (value: string) => ({ contains: value, mode: "insensitive" as const });

export function feedWhere(userId: string, filters: FeedFilters, now: Date = new Date()): Prisma.JobPostingWhereInput {
  const where: Prisma.JobPostingWhereInput = { userId };
  const and: Prisma.JobPostingWhereInput[] = [];
  if (filters.q) {
    and.push({ OR: [
      { title: insensitive(filters.q) },
      { company: insensitive(filters.q) },
      { location: insensitive(filters.q) },
      { description: insensitive(filters.q) }
    ] });
  }
  if (filters.location) and.push({ location: insensitive(filters.location) });
  if (filters.workStyle) {
    and.push({ OR: [{ remoteStatus: insensitive(filters.workStyle) }, { location: insensitive(filters.workStyle) }] });
  }
  if (filters.salary) and.push({ OR: [{ salaryMin: { not: null } }, { salaryMax: { not: null } }] });
  if (filters.seniority) {
    and.push({ OR: [{ seniorityLevel: insensitive(filters.seniority) }, { title: insensitive(filters.seniority) }] });
  }
  if (filters.postedWithin) {
    const since = new Date(now.getTime() - filters.postedWithin * 86_400_000);
    and.push({ OR: [{ datePosted: { gte: since } }, { datePosted: null, firstDiscoveredAt: { gte: since } }] });
  }
  if (filters.source) where.sourceType = filters.source as Prisma.JobPostingWhereInput["sourceType"];
  if (filters.status) where.status = filters.status as Prisma.JobPostingWhereInput["status"];
  if (filters.company) where.company = insensitive(filters.company);
  if (filters.roleType) where.title = insensitive(filters.roleType);
  if (and.length) where.AND = and;
  return where;
}

export function feedOrderBy(sort: FeedSort): Prisma.JobPostingOrderByWithRelationInput[] {
  if (sort === "newest") return [{ datePosted: { sort: "desc", nulls: "last" } }, { firstDiscoveredAt: "desc" }];
  if (sort === "salary") return [{ salaryMax: { sort: "desc", nulls: "last" } }, { salaryMin: { sort: "desc", nulls: "last" } }, { firstDiscoveredAt: "desc" }];
  return [{ overallFitScore: { sort: "desc", nulls: "last" } }, { datePosted: { sort: "desc", nulls: "last" } }, { firstDiscoveredAt: "desc" }];
}

type Sortable = { score: number | null; posted: Date; salaryTop: number | null };

export function sortFeedItems<T extends Sortable>(items: readonly T[], sort: FeedSort): T[] {
  const newer = (left: T, right: T) => right.posted.getTime() - left.posted.getTime();
  const nullsLast = (left: number | null, right: number | null) =>
    left === null && right === null ? 0 : left === null ? 1 : right === null ? -1 : right - left;
  return [...items].sort((left, right) => {
    if (sort === "newest") return newer(left, right);
    if (sort === "salary") return nullsLast(left.salaryTop, right.salaryTop) || newer(left, right);
    return nullsLast(left.score, right.score) || newer(left, right);
  });
}
