import Link from "next/link";
import {
  BriefcaseBusiness,
  ClipboardList,
  DatabaseZap,
  FileText,
  Gauge,
  Inbox,
  ListChecks,
  Mic,
  Settings,
  Sparkles
} from "lucide-react";

import { AuthMenu } from "@/components/auth-menu";

const navItems = [
  { href: "/dashboard", label: "Dashboard", icon: Gauge },
  { href: "/jobs", label: "Jobs", icon: BriefcaseBusiness },
  { href: "/applications", label: "Applications", icon: ClipboardList },
  { href: "/resumes", label: "Resumes", icon: FileText },
  { href: "/interviews", label: "Interviews", icon: Mic },
  { href: "/tasks", label: "Tasks", icon: ListChecks },
  { href: "/settings/profile", label: "Profile", icon: Settings },
  { href: "/settings/job-sources", label: "Job Sources", icon: DatabaseZap },
  { href: "/settings/integrations", label: "Integrations", icon: Inbox }
];

export async function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-slate-50">
      <aside className="fixed inset-y-0 left-0 hidden w-64 border-r border-slate-200 bg-white lg:block">
        <div className="flex h-16 items-center gap-3 border-b border-slate-200 px-6">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-600 text-white">
            <Sparkles size={18} aria-hidden="true" />
          </div>
          <div>
            <p className="text-sm font-semibold text-slate-950">JobMatch CRM</p>
            <p className="text-xs text-slate-500">Human-in-the-loop</p>
          </div>
        </div>
        <nav className="space-y-1 px-3 py-5">
          {navItems.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-950"
            >
              <item.icon size={17} aria-hidden="true" />
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="absolute inset-x-4 bottom-32">
          <AuthMenu />
        </div>
        <div className="absolute inset-x-4 bottom-4 rounded-lg border border-teal-100 bg-teal-50 p-4 text-xs text-teal-900">
          <p className="font-semibold">Safety rules active</p>
          <p className="mt-1 leading-5">
            No auto-apply, no prohibited scraping, no automatic email sending, and no recording without consent.
          </p>
        </div>
      </aside>
      <div className="lg:pl-64">
        <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/90 px-4 py-3 backdrop-blur lg:hidden">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <Sparkles size={18} className="text-brand-600" aria-hidden="true" />
              JobMatch CRM
            </div>
            <AuthMenu />
          </div>
        </header>
        <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">{children}</main>
      </div>
    </div>
  );
}
