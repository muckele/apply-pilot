type ApplyPilotMarkProps = {
  className?: string;
  title?: string;
};

export function ApplyPilotMark({ className, title }: ApplyPilotMarkProps) {
  return (
    <svg
      viewBox="0 0 58 56"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      <rect x="1" y="34" width="8" height="20" rx="4" fill="#7EE0A7" />
      <rect x="13" y="27" width="8" height="27" rx="4" fill="#58CC8D" />
      <rect x="25" y="20" width="8" height="34" rx="4" fill="#35B779" />
      <rect x="37" y="11" width="8" height="43" rx="4" fill="#1E7C54" />
      <rect x="49" y="2" width="8" height="52" rx="4" fill="#0C3B2E" />
    </svg>
  );
}

type ApplyPilotLogoProps = {
  className?: string;
  markClassName?: string;
  subtitle?: string;
  tone?: "light" | "dark";
};

export function ApplyPilotLogo({
  className = "gap-3",
  markClassName = "h-9 w-9",
  subtitle,
  tone = "light"
}: ApplyPilotLogoProps) {
  const titleClass = tone === "dark" ? "text-[#f3f6f2]" : "text-slate-950";
  const subtitleClass = tone === "dark" ? "text-[#aeb9b5]" : "text-slate-500";

  return (
    <div className={`flex min-w-0 items-center ${className}`}>
      <ApplyPilotMark className={`${markClassName} shrink-0`} />
      <span className="min-w-0">
        <span className={`block whitespace-nowrap text-sm font-semibold ${titleClass}`}>Apply Pilot</span>
        {subtitle ? <span className={`block whitespace-nowrap text-xs ${subtitleClass}`}>{subtitle}</span> : null}
      </span>
    </div>
  );
}
