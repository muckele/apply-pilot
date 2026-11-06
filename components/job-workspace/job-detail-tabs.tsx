"use client";

import { useId, useRef, useState, type KeyboardEvent } from "react";

import { CHECK_LABEL, CheckIcon } from "@/components/job-workspace/match-card";
import { countedRoleLabel } from "@/components/requirement-gap-list";
import type { ChecklistView, EstimateView, JobDetailView, JobTab, SalaryTargetView } from "@/lib/jobs/job-view-types";

const TABS: Array<[JobTab, string]> = [["overview", "Overview"], ["match", "Match"], ["salary", "Salary"]];

export function RemoteCheck({ job }: { job: Pick<JobDetailView, "workStyle" | "listedWorkStyle" | "workStyleQuotes" | "location"> }) {
  return (
    <section className="job-remote-check" aria-label="Remote check">
      <h3 className="job-subhead">Remote check</h3>
      <p className="job-card-copy">
        Listed as <strong>{job.workStyle ?? job.listedWorkStyle ?? "no work style"}</strong>
        {job.location ? <> · {job.location}</> : null}
      </p>
      {job.workStyleQuotes.length ? (
        <>
          <p className="job-hint">What the posting itself says:</p>
          <ul className="job-quotes">
            {job.workStyleQuotes.map((quote) => <li key={quote}><blockquote>“{quote}”</blockquote></li>)}
          </ul>
        </>
      ) : (
        <p className="job-hint">The posting doesn&apos;t describe where or how the work happens beyond its listing. Check with the employer before you apply.</p>
      )}
    </section>
  );
}

function money(value: number | null) {
  return value === null ? null : `$${Math.round(value / 1_000)}k`;
}

export function JobDetailTabs({
  job,
  estimate,
  checklist,
  salaryTarget,
  tab,
  onTabChange
}: {
  job: JobDetailView;
  estimate: EstimateView | null;
  checklist: ChecklistView;
  salaryTarget: SalaryTargetView;
  tab: JobTab;
  onTabChange: (tab: JobTab) => void;
}) {
  const id = useId();
  const [fullDescription, setFullDescription] = useState(false);
  const longDescription = job.description.length > 700;
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    const index = TABS.findIndex(([value]) => value === tab);
    const delta = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (!delta) return;
    event.preventDefault();
    const next = TABS[(index + delta + TABS.length) % TABS.length]![0];
    onTabChange(next);
    tabRefs.current[next]?.focus();
  }

  const target = salaryTarget && (salaryTarget.min || salaryTarget.max)
    ? [money(salaryTarget.min), money(salaryTarget.max)].filter(Boolean).join("–")
    : null;

  return (
    <div className="job-card job-tabs">
      <div role="tablist" aria-label="Job details" className="job-tablist">
        {TABS.map(([value, label]) => (
          <button
            key={value}
            ref={(node) => { tabRefs.current[value] = node; }}
            type="button"
            role="tab"
            id={`${id}-${value}-tab`}
            aria-selected={tab === value}
            aria-controls={`${id}-${value}-panel`}
            tabIndex={tab === value ? 0 : -1}
            className="job-tab"
            onClick={() => onTabChange(value)}
            onKeyDown={onKeyDown}
          >
            {label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`${id}-${tab}-panel`} aria-labelledby={`${id}-${tab}-tab`} className="job-tabpanel" tabIndex={0}>
        {tab === "overview" ? (
          <div className="job-stack">
            <RemoteCheck job={job} />
            <section>
              <h3 className="job-subhead">About the job</h3>
              <p className="job-description" data-clamped={longDescription && !fullDescription}>{job.description}</p>
              {longDescription ? (
                <button type="button" className="job-link-button" aria-expanded={fullDescription} onClick={() => setFullDescription(!fullDescription)}>
                  {fullDescription ? "Show less" : "Show full description"}
                </button>
              ) : null}
            </section>
            {job.requirements.length ? (
              <section>
                <h3 className="job-subhead">What they ask for</h3>
                <ul className="job-plain-list">{job.requirements.map((item, index) => <li key={index}>{item}</li>)}</ul>
              </section>
            ) : null}
            {job.preferredQualifications.length ? (
              <section>
                <h3 className="job-subhead">Nice to have</h3>
                <ul className="job-plain-list">{job.preferredQualifications.map((item, index) => <li key={index}>{item}</li>)}</ul>
              </section>
            ) : null}
          </div>
        ) : null}
        {tab === "match" ? (
          <div className="job-stack">
            {estimate ? (
              <p className="job-card-copy">
                Apply Pilot compared each listed requirement with your résumé. “Not on your résumé” is about what your résumé says, not proof you lack the skill. “Not checked” means Apply Pilot couldn&apos;t judge it either way (years of experience often land here), so read those yourself.
              </p>
            ) : (
              <p className="job-card-copy">This job hasn&apos;t been scored yet. Score it to see which requirements your résumé shows.</p>
            )}
            {checklist.items.length ? (
              <ul className="job-breakdown">
                {checklist.items.map((item, index) => (
                  <li key={`${item.jobRef ?? "item"}-${index}`} data-check={estimate ? item.status : "not_assessed"} className={`job-check-${estimate ? item.status : "not_assessed"}`}>
                    <CheckIcon status={estimate ? item.status : "not_assessed"} />
                    <div>
                      <p className="job-breakdown-requirement">{item.requirement}</p>
                      {estimate ? <p className="job-hint">{CHECK_LABEL[item.status]}</p> : null}
                      {estimate && item.status === "not_shown" && item.tenure ? (
                        <div className="job-hint" data-tenure>
                          <p>{item.tenure.summary}</p>
                          <p>
                            {item.tenure.countedRoles.length
                              ? `Counted from work-history titles and dates: ${item.tenure.countedRoles.map(countedRoleLabel).join("; ")}`
                              : "Counted from work-history titles and dates; no listed role names this kind of work."}
                          </p>
                        </div>
                      ) : null}
                      {item.status === "shown" && item.resumeLines.length ? (
                        <ul className="job-quotes">
                          {item.resumeLines.map((line) => <li key={line}><blockquote>From your résumé: “{line}”</blockquote></li>)}
                        </ul>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            ) : null}
            {estimate?.resumeAngle ? (
              <section>
                <h3 className="job-subhead">Suggested angle</h3>
                <p className="job-card-copy">{estimate.resumeAngle}</p>
                <p className="job-hint">Writing advice, not a finding about you.</p>
              </section>
            ) : null}
          </div>
        ) : null}
        {tab === "salary" ? (
          <div className="job-stack">
            {job.salary ? (
              <p className="job-salary"><strong>{job.salary}</strong> <span className="job-hint">listed by the employer</span></p>
            ) : (
              <p className="job-card-copy">The employer didn&apos;t list a salary for this job.</p>
            )}
            {target ? <p className="job-card-copy">Your target: {target}</p> : null}
            {estimate?.compensation && estimate.compensation.score !== null ? (
              <p className="job-card-copy">Salary fit: {estimate.compensation.score}% — {estimate.compensation.explanation}</p>
            ) : null}
            <p className="job-hint">Apply Pilot shows only what the employer published. It doesn&apos;t guess salaries.</p>
          </div>
        ) : null}
      </div>
    </div>
  );
}
