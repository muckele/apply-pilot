import Link from "next/link";

import { ApplyPilotMark } from "@/components/brand/apply-pilot-logo";

export function PublicBrand({ compact = false }: { compact?: boolean }) {
  return (
    <Link className={`public-brand${compact ? " public-brand-compact" : ""}`} href="/" aria-label="Apply Pilot home">
      <ApplyPilotMark className="public-brand-mark" />
      <span>Apply Pilot</span>
    </Link>
  );
}
