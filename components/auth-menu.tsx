import Link from "next/link";
import { LogIn, LogOut, UserCircle } from "lucide-react";

import { auth, signOut } from "@/lib/auth";

export async function AuthMenu() {
  const session = await auth();

  if (!session?.user) {
    return (
      <Link
        href="/login"
        className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
      >
        <LogIn size={15} aria-hidden="true" />
        Sign in
      </Link>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <div className="hidden min-w-0 items-center gap-2 text-sm text-slate-600 sm:flex">
        <UserCircle size={17} className="text-brand-600" aria-hidden="true" />
        <span className="max-w-44 truncate">{session.user.email ?? session.user.name}</span>
      </div>
      <form
        action={async () => {
          "use server";
          await signOut({ redirectTo: "/login" });
        }}
      >
        <button className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50">
          <LogOut size={15} aria-hidden="true" />
          Sign out
        </button>
      </form>
    </div>
  );
}
