import Link from "next/link";
import { LogIn, LogOut, UserCircle } from "lucide-react";

import { auth, signOut } from "@/lib/auth";

export async function AuthMenu({ tone = "light" }: { tone?: "light" | "dark" } = {}) {
  const session = await auth();
  const actionClass = tone === "dark"
    ? "min-h-11 border-white/20 bg-white/[0.04] text-[#f3f6f2] transition-colors hover:border-brand-400/60 hover:bg-brand-500/10"
    : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50";

  if (!session?.user) {
    return (
      <Link
        href="/login"
        className={`inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-semibold ${actionClass}`}
      >
        <LogIn size={15} aria-hidden="true" />
        Sign in
      </Link>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <div className={`hidden min-w-0 items-center gap-2 text-sm sm:flex ${tone === "dark" ? "text-[#aeb9b5]" : "text-slate-600"}`}>
        <UserCircle size={17} className={tone === "dark" ? "text-brand-300" : "text-brand-600"} aria-hidden="true" />
        <span className="max-w-44 truncate">{session.user.email ?? session.user.name}</span>
      </div>
      <form
        action={async () => {
          "use server";
          await signOut({ redirectTo: "/login" });
        }}
      >
        <button className={`inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-semibold ${actionClass}`}>
          <LogOut size={15} aria-hidden="true" />
          Sign out
        </button>
      </form>
    </div>
  );
}
