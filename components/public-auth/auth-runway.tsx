import { Check, FileText, Search, ShieldCheck, UserRound } from "lucide-react";

const stages = [
  [Search, "Discover"],
  [Check, "Evaluate"],
  [FileText, "Prepare"],
  [ShieldCheck, "Review"],
  [UserRound, "You submit"]
] as const;

export function AuthRunway() {
  return (
    <ol className="auth-runway" aria-label="Apply Pilot workflow">
      {stages.map(([Icon, label], index) => (
        <li key={label} className={index === stages.length - 1 ? "is-final" : undefined}>
          <span><Icon aria-hidden="true" /></span>
          <strong>{label}</strong>
        </li>
      ))}
    </ol>
  );
}
