import type { MasterResumeDetailDto } from "@/lib/resumes/master-resume-detail";
import { Panel, PanelHeader, StatusBadge } from "@/components/ui";

type StoredRecord = Record<string, unknown>;

function records(value: unknown): StoredRecord[] {
  return Array.isArray(value)
    ? value.filter((item): item is StoredRecord => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    : [];
}

function text(record: StoredRecord, ...keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function list(record: StoredRecord, ...keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value)) {
      const items = value.filter((item): item is string => typeof item === "string" && Boolean(item.trim()));
      if (items.length) return items;
    }
  }
  return [];
}

function dateRange(record: StoredRecord) {
  const start = text(record, "startDate");
  const end = text(record, "endDate", "date", "year");
  if (start && end) return `${start} – ${end}`;
  return start ?? end;
}

// Saved entries keep the exact source text, including a copied list marker
// ("•Top five…"). The list already draws a bullet, so hide the copied one.
function withoutListMarker(item: string) {
  return item.replace(/^\s*(?:[•▪◦‣●○■□]\s*|[-*–—]\s+|\d+[.)]\s+)/u, "");
}

function RecordList({ items }: { items: string[] }) {
  return items.length ? (
    <ul className="mt-3 max-w-[90ch] list-disc space-y-1.5 pl-5 text-sm leading-6 text-slate-700">
      {items.map((item, index) => <li key={`${index}-${item}`}>{withoutListMarker(item)}</li>)}
    </ul>
  ) : null;
}

function EmptySection({ children }: { children: React.ReactNode }) {
  return <p className="px-5 py-6 text-sm text-slate-500">{children}</p>;
}

export function MasterResumeDetail({ resume }: { resume: MasterResumeDetailDto | null }) {
  if (!resume) {
    return (
      <Panel>
        <PanelHeader title="Master resume profile" />
        <EmptySection>No master resume uploaded yet.</EmptySection>
      </Panel>
    );
  }

  const jobs = records(resume.workHistory);
  const projects = records(resume.projects);
  const education = records(resume.education);
  const certifications = records(resume.certifications);
  const bulletCount = jobs.reduce((count, job) => count + list(job, "bullets", "highlights").length, 0);
  const sourceLines = resume.rawText?.split(/\r?\n/u).length ?? 0;

  return (
    <div className="grid min-w-0 items-start gap-6 break-words xl:grid-cols-[minmax(0,1fr)_minmax(18rem,24rem)]">
      <div data-resume-column="main" className="min-w-0 space-y-6">
        <Panel>
          <PanelHeader title="Master resume profile" description="Read-only saved data used by job matching." />
          <div className="space-y-4 p-5">
            <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between sm:gap-6">
              <p className="text-sm font-semibold text-slate-950">{resume.title}</p>
              <p className="text-xs text-slate-500">
                Parsed {resume.parsedAt ? resume.parsedAt.toISOString().slice(0, 10) : "date unavailable"}
                {" · "}
                {sourceLines ? `Source text saved · ${sourceLines} ${sourceLines === 1 ? "line" : "lines"}` : "Source text unavailable"}
              </p>
            </div>
            {resume.summary ? <p className="max-w-[90ch] text-sm leading-6 text-slate-700">{resume.summary}</p> : null}
          </div>
        </Panel>

        <Panel>
          <PanelHeader
            title="Work history"
            description={`${jobs.length} ${jobs.length === 1 ? "role" : "roles"} · ${bulletCount} ${bulletCount === 1 ? "bullet" : "bullets"}`}
          />
          {jobs.length ? (
            <ol data-work-history className="divide-y divide-slate-100">
              {jobs.map((job, index) => {
                const title = text(job, "title", "role") ?? `Role ${index + 1}`;
                const company = text(job, "company");
                const dates = dateRange(job);
                const location = text(job, "location");
                return (
                  <li key={`${index}-${title}`} className="px-5 py-5">
                    <article>
                      <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between sm:gap-6">
                        <div className="min-w-0">
                          <h3 className="text-base font-semibold text-slate-950">{title}</h3>
                          {company ? <p className="mt-0.5 text-sm font-medium text-slate-700">{company}</p> : null}
                        </div>
                        {dates || location ? (
                          <p className="shrink-0 text-xs leading-5 text-slate-500 sm:text-right">
                            {dates}
                            {dates && location ? <br className="hidden sm:block" /> : null}
                            {dates && location ? <span className="sm:hidden"> · </span> : null}
                            {location}
                          </p>
                        ) : null}
                      </div>
                      <RecordList items={list(job, "bullets", "highlights")} />
                    </article>
                  </li>
                );
              })}
            </ol>
          ) : <EmptySection>No work history saved.</EmptySection>}
        </Panel>

        <Panel>
          <PanelHeader title="Projects" description={`${projects.length} saved`} />
          {projects.length ? <div className="divide-y divide-slate-100">{projects.map((project, index) => {
            const name = text(project, "name") ?? `Project ${index + 1}`;
            const technologies = list(project, "technologies");
            return (
              <article key={`${index}-${name}`} className="px-5 py-5">
                <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between sm:gap-6">
                  <h3 className="text-base font-semibold text-slate-950">{name}</h3>
                  {dateRange(project) ? <p className="shrink-0 text-xs text-slate-500">{dateRange(project)}</p> : null}
                </div>
                {technologies.length ? <p className="mt-1 text-xs text-slate-500">{technologies.join(" · ")}</p> : null}
                {text(project, "description") ? <p className="mt-2 max-w-[90ch] text-sm leading-6 text-slate-700">{text(project, "description")}</p> : null}
                <RecordList items={list(project, "bullets", "highlights")} />
              </article>
            );
          })}</div> : <EmptySection>No projects saved.</EmptySection>}
        </Panel>
      </div>

      <aside data-resume-column="side" className="min-w-0 space-y-6">
        <Panel>
          <PanelHeader title="Skills" description={`${resume.skills.length} saved`} />
          {resume.skills.length ? (
            <div className="flex flex-wrap gap-2 p-5">
              {resume.skills.map((skill) => <StatusBadge key={skill} status={skill} />)}
            </div>
          ) : <EmptySection>No skills saved.</EmptySection>}
        </Panel>

        <Panel>
          <PanelHeader title="Education" description={`${education.length} saved`} />
          {education.length ? <div className="divide-y divide-slate-100">{education.map((item, index) => {
            const institution = text(item, "institution", "school") ?? `Education ${index + 1}`;
            const credential = [text(item, "credential", "degree", "program"), text(item, "fieldOfStudy", "field")]
              .filter(Boolean)
              .join(", ");
            return (
              <article key={`${index}-${institution}`} className="p-5">
                <h3 className="text-sm font-semibold text-slate-950">{institution}</h3>
                {credential ? <p className="mt-1 text-sm text-slate-700">{credential}</p> : null}
                {dateRange(item) ? <p className="mt-1 text-xs text-slate-500">{dateRange(item)}</p> : null}
                <RecordList items={list(item, "details", "highlights")} />
              </article>
            );
          })}</div> : <EmptySection>No education saved.</EmptySection>}
        </Panel>

        <Panel>
          <PanelHeader title="Certifications" description={`${certifications.length} saved`} />
          {certifications.length ? <div className="divide-y divide-slate-100">{certifications.map((item, index) => {
            const name = text(item, "name") ?? `Certification ${index + 1}`;
            const meta = [text(item, "issuer"), text(item, "date"), text(item, "expirationDate")].filter(Boolean).join(" · ");
            return (
              <article key={`${index}-${name}`} className="p-5">
                <h3 className="text-sm font-semibold text-slate-950">{name}</h3>
                {meta ? <p className="mt-1 text-xs text-slate-500">{meta}</p> : null}
                <RecordList items={list(item, "details")} />
              </article>
            );
          })}</div> : <EmptySection>No certifications saved.</EmptySection>}
        </Panel>

        <Panel>
          <PanelHeader title="Achievements" description={`${resume.achievements.length} saved`} />
          {resume.achievements.length ? <div className="px-5 pb-5 pt-2"><RecordList items={resume.achievements} /></div> : <EmptySection>No achievements saved.</EmptySection>}
        </Panel>
      </aside>
    </div>
  );
}
