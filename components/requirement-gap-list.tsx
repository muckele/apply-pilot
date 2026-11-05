import type { RequirementGapPresentation } from "@/lib/jobs/fit-presentation";

function countedRoleLabel(role: NonNullable<RequirementGapPresentation["tenure"]>["countedRoles"][number]) {
  const name = [role.title, role.company].filter(Boolean).join(", ");
  return role.dates ? `${name} (${role.dates})` : name;
}

export function RequirementGapList({ gaps }: { gaps: RequirementGapPresentation[] }) {
  if (!gaps.length) return null;
  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
      <p className="text-xs font-semibold uppercase text-amber-900">Requirements not evidenced in the submitted resume</p>
      <p className="mt-1 text-xs leading-5 text-amber-800">Not evidenced is not proof that the applicant lacks the capability.</p>
      <ul className="mt-2 space-y-1 text-sm leading-6 text-amber-900">
        {gaps.map((gap) => (
          <li key={`${gap.requirement}-${gap.jobRequirement?.ref ?? "legacy"}`}>
            {gap.requirement}
            {gap.jobRequirement ? <span className="ml-1 text-xs">({gap.jobRequirement.ref})</span> : null}
            {gap.tenure ? (
              <div className="mt-1 text-xs leading-5 text-amber-800">
                <p>{gap.tenure.summary}</p>
                {gap.tenure.countedRoles.length ? (
                  <p>Counted from work-history titles and dates: {gap.tenure.countedRoles.map(countedRoleLabel).join("; ")}</p>
                ) : (
                  <p>Counted from work-history titles and dates; no listed role names this kind of work.</p>
                )}
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
