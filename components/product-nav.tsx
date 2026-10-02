"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  BriefcaseBusiness,
  BrainCircuit,
  ClipboardList,
  DatabaseZap,
  FileText,
  Gauge,
  Inbox,
  LibraryBig,
  ListFilter,
  ListChecks,
  Mic,
  Settings
} from "lucide-react";

const navItems = [
  { href: "/dashboard", label: "Dashboard", icon: Gauge },
  { href: "/jobs", label: "Jobs", icon: BriefcaseBusiness },
  { href: "/jobs/review", label: "Review Queue", icon: ListFilter },
  { href: "/applications", label: "Applications", icon: ClipboardList },
  { href: "/resumes", label: "Resumes", icon: FileText },
  { href: "/interviews", label: "Interviews", icon: Mic },
  { href: "/interviews/library", label: "Interview Library", icon: LibraryBig },
  { href: "/tasks", label: "Tasks", icon: ListChecks },
  { href: "/settings/application-answers", label: "Answer Vault", icon: ClipboardList },
  { href: "/settings/ai", label: "AI Controls", icon: BrainCircuit },
  { href: "/settings/profile", label: "Profile", icon: Settings },
  { href: "/settings/job-sources", label: "Job Sources", icon: DatabaseZap },
  { href: "/settings/integrations", label: "Integrations", icon: Inbox }
];

export function resolveActiveProductNavHref(pathname: string) {
  return navItems
    .filter((item) => pathname === item.href || pathname.startsWith(`${item.href}/`))
    .sort((left, right) => right.href.length - left.href.length)[0]?.href;
}

export function ProductNav({
  className = "",
  label = "Product navigation"
}: {
  className?: string;
  label?: string;
}) {
  const pathname = usePathname();
  const currentHref = resolveActiveProductNavHref(pathname);

  return (
    <nav aria-label={label} className={`space-y-1 ${className}`}>
      {navItems.map((item) => {
        const active = item.href === currentHref;
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={`flex min-h-11 items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
              active
                ? "bg-brand-500/10 text-white shadow-[inset_3px_0_0_#5bd894]"
                : "text-[#aeb9b5] hover:bg-white/5 hover:text-white"
            }`}
          >
            <item.icon size={17} className={active ? "text-brand-300" : "text-[#778681]"} aria-hidden="true" />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
