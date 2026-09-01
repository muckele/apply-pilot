import type { LucideIcon } from "lucide-react";

export function PreviewIcon({ icon: Icon }: { icon: LucideIcon }) {
  return (
    <span className="preview-icon" aria-hidden="true">
      <Icon />
    </span>
  );
}

export function PreviewCheck() {
  return <span className="preview-check" aria-hidden="true">✓</span>;
}

export function PreviewStatus({ children, tone = "green" }: { children: React.ReactNode; tone?: "green" | "amber" | "blue" }) {
  return <span className={`preview-status preview-status-${tone}`}>{children}</span>;
}
