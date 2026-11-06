import Link from "next/link";
import { ChevronDown, Search } from "lucide-react";

import {
  FEED_POSTED_WITHIN,
  FEED_POSTING_STATUSES,
  FEED_SENIORITY,
  FEED_SORTS,
  FEED_SOURCE_TYPES,
  feedHref,
  type FeedFilters
} from "@/lib/jobs/feed-query";
import { sourceLabel } from "@/lib/jobs/job-page-view";

// Search, filter chips and sort for /jobs. Everything is a GET form or a plain link, so the
// state lives in the URL and works without JavaScript.
function Hidden({ filters, omit }: { filters: FeedFilters; omit: ReadonlyArray<keyof FeedFilters> }) {
  const values: Array<[string, string]> = [
    ["q", filters.q], ["location", filters.location], ["workStyle", filters.workStyle],
    ["salary", filters.salary ? "listed" : ""], ["seniority", filters.seniority],
    ["datePosted", filters.postedWithin ? String(filters.postedWithin) : ""],
    ["sort", filters.sort === "relevant" ? "" : filters.sort], ["source", filters.source], ["status", filters.status],
    ["company", filters.company], ["roleType", filters.roleType], ["minFitScore", filters.minFitScore ? String(filters.minFitScore) : ""]
  ];
  const omitted = new Set<string>(omit.map((key) => (key === "postedWithin" ? "datePosted" : key)));
  return <>{values.filter(([name, value]) => value && !omitted.has(name)).map(([name, value]) => <input key={name} type="hidden" name={name} value={value} />)}</>;
}

function Menu({ label, active, children }: { label: string; active: boolean; children: React.ReactNode }) {
  return (
    <details className="feed-chip-menu">
      <summary className="feed-chip" data-active={active}>{label}<ChevronDown size={14} aria-hidden="true" /></summary>
      <ul className="feed-menu">{children}</ul>
    </details>
  );
}

export function FeedFilterBar({ filters, resultSummary }: { filters: FeedFilters; resultSummary: string }) {
  const remote = filters.workStyle === "Remote";
  const postedLabel = FEED_POSTED_WITHIN.find(([days]) => days === filters.postedWithin)?.[1];
  const sortLabel = FEED_SORTS.find(([value]) => value === filters.sort)?.[1] ?? "Most relevant";
  const moreActive = Boolean(filters.source || filters.status || filters.company || filters.roleType || filters.minFitScore || (filters.workStyle && !remote));
  return (
    <div className="feed-filters">
      <form method="get" action="/jobs" role="search" className="feed-search">
        <div className="feed-search-field">
          <Search size={17} aria-hidden="true" />
          <label className="sr-only" htmlFor="feed-q">Job title, company or keyword</label>
          <input id="feed-q" name="q" defaultValue={filters.q} placeholder="Job title, company or keyword" className="product-control" />
        </div>
        <div className="feed-search-field">
          <label className="sr-only" htmlFor="feed-location">Location</label>
          <input id="feed-location" name="location" defaultValue={filters.location} placeholder="City or state" className="product-control" />
        </div>
        <Hidden filters={filters} omit={["q", "location"]} />
        <button type="submit" className="job-button job-button-primary">Search</button>
      </form>
      <div className="feed-chips" role="group" aria-label="Filters and sort">
        <Link href={feedHref(filters, { workStyle: remote ? "" : "Remote" })} scroll={false} className="feed-chip" data-active={remote} aria-pressed={remote}>Remote</Link>
        <Link href={feedHref(filters, { salary: !filters.salary })} scroll={false} className="feed-chip" data-active={filters.salary} aria-pressed={filters.salary}>Salary listed</Link>
        <Menu label={filters.seniority ? `Seniority: ${filters.seniority}` : "Seniority"} active={Boolean(filters.seniority)}>
          <li><Link href={feedHref(filters, { seniority: "" })} scroll={false} aria-current={!filters.seniority ? "true" : undefined}>Any seniority</Link></li>
          {FEED_SENIORITY.map((level) => (
            <li key={level}><Link href={feedHref(filters, { seniority: level })} scroll={false} aria-current={filters.seniority === level ? "true" : undefined}>{level}</Link></li>
          ))}
        </Menu>
        <Menu label={postedLabel ? `Posted within: ${postedLabel.toLowerCase()}` : "Posted within"} active={Boolean(filters.postedWithin)}>
          <li><Link href={feedHref(filters, { postedWithin: 0 })} scroll={false} aria-current={!filters.postedWithin ? "true" : undefined}>Any time</Link></li>
          {FEED_POSTED_WITHIN.map(([days, label]) => (
            <li key={days}><Link href={feedHref(filters, { postedWithin: days })} scroll={false} aria-current={filters.postedWithin === days ? "true" : undefined}>{label}</Link></li>
          ))}
        </Menu>
        <details className="feed-chip-menu feed-more">
          <summary className="feed-chip" data-active={moreActive}>More filters<ChevronDown size={14} aria-hidden="true" /></summary>
          <form method="get" action="/jobs" className="feed-more-form">
            <Hidden filters={filters} omit={["source", "status", "company", "roleType", "minFitScore", "workStyle"]} />
            <label>Work style
              <select name="workStyle" defaultValue={filters.workStyle} className="product-control">
                <option value="">Any work style</option>
                <option value="Remote">Remote</option>
                <option value="Hybrid">Hybrid</option>
                <option value="On-site">On-site</option>
              </select>
            </label>
            <label>Source
              <select name="source" defaultValue={filters.source} className="product-control">
                <option value="">All sources</option>
                {FEED_SOURCE_TYPES.map((source) => <option key={source} value={source}>{sourceLabel(source)}</option>)}
              </select>
            </label>
            <label>Status
              <select name="status" defaultValue={filters.status} className="product-control">
                <option value="">All statuses</option>
                {FEED_POSTING_STATUSES.map((status) => <option key={status} value={status}>{status.charAt(0) + status.slice(1).toLowerCase()}</option>)}
              </select>
            </label>
            <label>Company<input name="company" defaultValue={filters.company} className="product-control" /></label>
            <label>Title contains<input name="roleType" defaultValue={filters.roleType} className="product-control" /></label>
            <label>Minimum fit estimate<input name="minFitScore" type="number" min={0} max={100} defaultValue={filters.minFitScore || ""} className="product-control" /></label>
            <button type="submit" className="job-button">Apply filters</button>
          </form>
        </details>
        <Menu label={`Sort: ${sortLabel}`} active={filters.sort !== "relevant"}>
          {FEED_SORTS.map(([value, label]) => (
            <li key={value}><Link href={feedHref(filters, { sort: value })} scroll={false} aria-current={filters.sort === value ? "true" : undefined}>{label}</Link></li>
          ))}
        </Menu>
      </div>
      <p className="feed-summary" aria-live="polite">{resultSummary}</p>
    </div>
  );
}
