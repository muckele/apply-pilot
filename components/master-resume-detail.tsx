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

function RecordList({ items }: { items: string[] }) {
  return items.length ? (
    <ul className="mt-3 list-disc space-y-1 pl-5 text-sm leading-6 text-slate-700">
      {items.map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}
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
    <div className="min-w-0 space-y-6 break-words">
      <Panel>
        <PanelHeader title="Master resume profile" description="Read-only saved data used by job matching." />
        <div className="space-y-4 p-5">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <p className="text-sm font-semibold text-slate-950">{resume.title}</p>
              <p className="mt-1 text-xs text-slate-500">
                Parsed {resume.parsedAt ? resume.parsedAt.toISOString().slice(0, 10) : "date unavailable"}
              </p>
            </div>
            <p className="text-xs text-slate-500">
              {sourceLines ? `Source text saved · ${sourceLines} ${sourceLines === 1 ? "line" : "lines"}` : "Source text unavailable"}
            </p>
          </div>
          {resume.summary ? <p className="text-sm leading-6 text-slate-700">{resume.summary}</p> : null}
          {resume.skills.length ? (
            <div className="flex flex-wrap gap-2">
              {resume.skills.map((skill) => <StatusBadge key={skill} status={skill} />)}
            </div>
          ) : <p className="text-sm text-slate-500">No skills saved.</p>}
        </div>
      </Panel>

      <Panel>
        <PanelHeader
          title="Work history"
          description={`${jobs.length} ${jobs.length === 1 ? "role" : "roles"} · ${bulletCount} ${bulletCount === 1 ? "bullet" : "bullets"}`}
        />
        {jobs.length ? (
          <div className="grid gap-4 p-5 md:grid-cols-2 xl:grid-cols-3">
            {jobs.map((job, index) => {
              const title = text(job, "title", "role") ?? `Role ${index + 1}`;
              const company = text(job, "company");
              const meta = [text(job, "location"), dateRange(job)].filter(Boolean).join(" · ");
              return (
                <article key={`${index}-${title}`} className="rounded-lg border border-slate-200 p-4">
                  <h3 className="text-sm font-semibold text-slate-950">{title}</h3>
                  {company ? <p className="mt-1 text-sm text-slate-700">{company}</p> : null}
                  {meta ? <p className="mt-1 text-xs text-slate-500">{meta}</p> : null}
                  <RecordList items={list(job, "bullets", "highlights")} />
                </article>
              );
            })}
          </div>
        ) : <EmptySection>No work history saved.</EmptySection>}
      </Panel>

      <div className="grid gap-6 xl:grid-cols-2">
        <Panel>
          <PanelHeader title="Projects" description={`${projects.length} saved`} />
          {projects.length ? <div className="divide-y divide-slate-100">{projects.map((project, index) => {
            const name = text(project, "name") ?? `Project ${index + 1}`;
            const technologies = list(project, "technologies");
            return (
              <article key={`${index}-${name}`} className="p-5">
                <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between">
                  <h3 className="text-sm font-semibold text-slate-950">{name}</h3>
                  {dateRange(project) ? <p className="text-xs text-slate-500">{dateRange(project)}</p> : null}
                </div>
                {text(project, "description") ? <p className="mt-2 text-sm leading-6 text-slate-700">{text(project, "description")}</p> : null}
                {technologies.length ? <p className="mt-2 text-xs text-slate-500">{technologies.join(" · ")}</p> : null}
                <RecordList items={list(project, "bullets", "highlights")} />
              </article>
            );
          })}</div> : <EmptySection>No projects saved.</EmptySection>}
        </Panel>

        <Panel>
          <PanelHeader title="Education" description={`${education.length} saved`} />
          {education.length ? <div className="divide-y divide-slate-100">{education.map((item, index) => {
            const institution = text(item, "institution", "school") ?? `Education ${index + 1}`;
            const credential = text(item, "credential", "degree", "program");
            const field = text(item, "fieldOfStudy", "field");
            return (
              <article key={`${index}-${institution}`} className="p-5">
                <h3 className="text-sm font-semibold text-slate-950">{institution}</h3>
                {credential ? <p className="mt-1 text-sm text-slate-700">{credential}</p> : null}
                {field ? <p className="mt-1 text-sm text-slate-700">{field}</p> : null}
                {dateRange(item) ? <p className="mt-1 text-xs text-slate-500">{dateRange(item)}</p> : null}
                <RecordList items={list(item, "details", "highlights")} />
              </article>
            );
          })}</div> : <EmptySection>No education saved.</EmptySection>}
        </Panel>
      </div>

      <div className="grid gap-6 xl:grid-cols-2">
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
          {resume.achievements.length ? <div className="p-5"><RecordList items={resume.achievements} /></div> : <EmptySection>No achievements saved.</EmptySection>}
        </Panel>
      </div>
    </div>
  );
}
